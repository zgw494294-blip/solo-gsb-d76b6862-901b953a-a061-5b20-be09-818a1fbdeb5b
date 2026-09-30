/* typeset.js 浏览器接线冒烟测试（Node + 极简 DOM mock，无第三方依赖）。
 * node tests/test_typeset_ui_smoke.js
 *
 * 覆盖：生成建议（fetch mock 返回后端格式）→ 单条接受 → 全部接受 →
 * 接受状态标记 → 排版版 SRT 导出请求载荷（含 original_text / anchors / locks）→
 * 撤销本轮 → 重置。
 */
"use strict";

const path = require("path");
const fs = require("fs");

/* ---------------- 极简 DOM mock（精简自 audit 冒烟测试） ---------------- */
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { (on === undefined ? !this._set.has(c) : on) ? this.add(c) : this.remove(c); },
      contains(c) { return this._set.has(c); },
    },
    _attrs: {},
    _listeners: {},
    _childBySelector: {},
    _innerHTML: "",
    set innerHTML(v) {
      this._innerHTML = v;
      this.children = [];
      this._childBySelector = {};
      const classRe = /class="([^"]+)"/g;
      let m;
      while ((m = classRe.exec(v))) {
        for (const cls of m[1].split(/\s+/)) {
          if (!cls) continue;
          const sel = "." + cls;
          if (!this._childBySelector[sel]) {
            const child = makeFakeChild(sel, this);
            this._childBySelector[sel] = child;
            this.children.push(child);
          }
        }
      }
    },
    get innerHTML() { return this._innerHTML; },
    _text: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      if (!this._childBySelector[sel]) this._childBySelector[sel] = makeFakeChild(sel, this);
      return this._childBySelector[sel];
    },
    querySelectorAll() { return []; },
    insertBefore(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild(child) {
      this.children.push(child);
      this._innerHTML += child.innerHTML || "";
      return child;
    },
    remove() {},
    click() {},
    title: "",
  };
  el.value = "";
  return el;
}

function makeFakeChild(sel, parent) {
  return {
    selector: sel,
    parent,
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _listeners: {},
    _text: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) { return makeFakeChild(sel, this); },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
  };
}

/* ---------------- 全局 mock ---------------- */
const els = {};
const ids = [
  "ts-columns", "ts-maxlines", "ts-generate", "ts-accept-all", "ts-undo-round",
  "ts-export", "ts-status", "ts-list",
];
for (const id of ids) els["#" + id] = makeEl("div");
els["#ts-columns"].tagName = "input";
els["#ts-maxlines"].tagName = "input";
els["#ts-columns"].value = "18";
els["#ts-maxlines"].value = "2";

const tableRows = new Map(); // 模拟字幕表行 .text 单元格

global.document = {
  querySelector: (s) => {
    if (els[s]) return els[s];
    return makeEl("div");
  },
  createElement: (tag) => {
    const e = makeEl(tag);
    if (tag === "a") {
      e.click = () => { downloaded = e.download; };
    }
    return e;
  },
  body: makeEl("body"),
};
global.window = { addEventListener() {} };
let downloaded = null;
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.fetch = async () => { throw new Error("fetch 应被测试桩替换"); };

/* ---------------- Workspace（app.js 暴露给 typeset.js 的工作区接口） ---------------- */
const SUBTITLES = [
  { id: 1, start_ms: 1200, end_ms: 3500, text: "风从山谷里穿过，带着雨的气息，慢慢吹向远方的河岸。" },
  { id: 2, start_ms: 4000, end_ms: 6800, text: "Hello world, 这是一条中英混合的字幕测试句子哦。" },
  { id: 3, start_ms: 7500, end_ms: 10000, text: "「我们走吧。」他说。" },
];
const marks = new Set();
global.window.Workspace = {
  subtitles: SUBTITLES,
  anchors: [{ id: 1, subtitle_id: 1, original_ms: 1200, target_ms: 1200 }],
  locks: [3],
  fileNameBase: "sample.calibrated",
  markTypeset(id, on) { on ? marks.add(id) : marks.delete(id); },
};

/* ---------------- fetch 桩：按路径返回不同响应 ---------------- */
let suggestCalls = 0;
let exportCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (url === "/api/typeset/suggest") {
    suggestCalls++;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          columns: body.columns, max_lines: body.maxLines, total: 3,
          feasible_count: 3, infeasible_count: 0, change_count: 3,
          results: [
            { id: 1, feasible: true, columns: 18, max_lines: 2, changed: true,
              original: SUBTITLES[0].text, text: "风从山谷里穿过，带着雨的\n气息，慢慢吹向远方的河岸。",
              lines: ["风从山谷里穿过，带着雨的", "气息，慢慢吹向远方的河岸。"], widths: [18, 18],
              total_penalty: 3, residual_sq: 0, cluster_count: 25,
              breaks: [{ boundary: 10, kind: "han", kind_label: "汉字之间", penalty: 3, existing: false, left: "的", right: "气" }],
              reasons: [] },
            { id: 2, feasible: true, columns: 18, max_lines: 2, changed: true,
              original: SUBTITLES[1].text, text: "Hello\nworld, 这是一条中英混合的字幕测试句子哦。",
              lines: ["Hello", "world, 这是一条中英混合的字幕测试句子哦。"], widths: [5, 34],
              total_penalty: 1, residual_sq: 433, cluster_count: 29,
              breaks: [{ boundary: 5, kind: "whitespace", kind_label: "空白", penalty: 1, existing: false, left: "o", right: " " }],
              reasons: [] },
            { id: 3, feasible: true, columns: 18, max_lines: 2, changed: true,
              original: SUBTITLES[2].text, text: "「我们走吧。」\n他说。",
              lines: ["「我们走吧。」", "他说。"], widths: [14, 6],
              total_penalty: 2, residual_sq: 160, cluster_count: 10,
              breaks: [{ boundary: 7, kind: "punct", kind_label: "其他标点", penalty: 2, existing: false, left: "」", right: "他" }],
              reasons: [] },
          ],
        };
      },
    };
  }
  if (url === "/api/typeset/export") {
    exportCalls.push(body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'attachment; filename="typeset.srt"' },
      async json() { return {}; },
      async blob() { return new global.Blob(["SRT-BYTES"]); },
    };
  }
  throw new Error("未预期的请求：" + url);
};

/* ---------------- 加载 typeset.js（IIFE） ---------------- */
const typesetSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "typeset.js"), "utf8"
);
new Function(typesetSrc)();
const TypesetUI = global.window.TypesetUI;
const assert = require("assert");

(async () => {
  // 初始状态
  assert.strictEqual(els["#ts-accept-all"].disabled, true);
  assert.strictEqual(els["#ts-undo-round"].disabled, true);
  assert.strictEqual(els["#ts-export"].disabled, true);

  // 1) 生成建议
  els["#ts-generate"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(suggestCalls, 1);
  assert.ok(els["#ts-status"].innerHTML.includes("无解"), "状态应汇总计数");
  assert.strictEqual(els["#ts-undo-round"].disabled, false, "生成后本轮可撤销");
  assert.strictEqual(els["#ts-accept-all"].disabled, false, "有可接受建议");

  // 2) 单条接受 #1：找到渲染出的卡片并点击「接受此条」
  const cards = els["#ts-list"].children.filter((c) => typeof c.querySelector === "function");
  assert.ok(cards.length >= 3, "应渲染 3 张卡片");
  // mock 的 querySelector 对任意选择器返回同一可点击子节点；直接触发 accept 按钮
  cards[0].querySelector(".ts-accept").dispatch("click");
  assert.ok(marks.has(1), "#1 接受后主表格应有排版标记");
  assert.ok(!marks.has(2));

  // 3) 全部接受
  els["#ts-accept-all"].dispatch("click");
  assert.ok(marks.has(2) && marks.has(3), "全部接受后 #2 #3 也应标记");

  // can_export=false 时导出按钮禁用
  TypesetUI.setCanExport(false);
  assert.strictEqual(els["#ts-export"].disabled, true);
  TypesetUI.setCanExport(true);
  assert.strictEqual(els["#ts-export"].disabled, false);

  // 4) 导出排版版 SRT：校验载荷
  els["#ts-export"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(exportCalls.length, 1);
  const payload = exportCalls[0];
  assert.strictEqual(payload.subtitles.length, 3);
  const byId = Object.fromEntries(payload.subtitles.map((s) => [s.id, s]));
  assert.strictEqual(byId[1].text, "风从山谷里穿过，带着雨的\n气息，慢慢吹向远方的河岸。");
  assert.strictEqual(byId[1].original_text, SUBTITLES[0].text);
  assert.strictEqual(byId[3].text, "「我们走吧。」\n他说。");
  assert.strictEqual(payload.anchors.length, 1);
  assert.deepStrictEqual(payload.locks, [3]);
  // 时间字段必须保留
  assert.strictEqual(byId[2].start_ms, 4000);
  assert.strictEqual(downloaded, "sample.typeset.srt", "文件名应走 typeset 后缀");

  // 5) 撤销本轮：恢复到生成前（无接受）
  els["#ts-undo-round"].dispatch("click");
  assert.strictEqual(marks.size, 0, "撤销本轮后标记应清空");
  assert.strictEqual(els["#ts-export"].disabled, true);

  // 6) reset（导入新 SRT）
  TypesetUI.reset();
  assert.strictEqual(els["#ts-accept-all"].disabled, true);
  assert.strictEqual(els["#ts-undo-round"].disabled, true);
  assert.ok(els["#ts-list"].innerHTML.includes("生成排版建议"));

  console.log("ok - typeset.js 接线冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
