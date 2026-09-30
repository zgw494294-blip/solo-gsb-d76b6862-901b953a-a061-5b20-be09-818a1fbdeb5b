/* bilingual.js 浏览器接线冒烟测试（Node + 极简 DOM mock，无第三方依赖）。
 * node tests/test_bilingual_ui_smoke.js
 *
 * 覆盖：导入译文（/api/parse → /api/bilingual/pair）→ 渲染分组与未配对条目 →
 * 未配对/预览冲突时禁用导出 → 全部配对且预览无冲突时导出载荷
 * （subtitles/translations/anchors/locks，走 /api/bilingual/export）→
 * 译文倒挂 / 重叠被拒绝（保留旧配对）→ reset 清空。
 */
"use strict";

const path = require("path");
const fs = require("fs");

/* ---------------- 极简 DOM mock（与 typeset 冒烟测试同型） ---------------- */
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

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    files: [],
    value: "",
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
  return el;
}

/* ---------------- 全局 mock ---------------- */
const els = {};
const ids = ["bi-file", "bi-export", "bi-status", "bi-paste-area", "bi-parse-paste", "bi-list"];
for (const id of ids) els["#" + id] = makeEl("div");
els["#bi-file"].tagName = "input";
els["#bi-paste-area"].tagName = "textarea";

let downloaded = null;
global.document = {
  querySelector: (s) => (els[s] ? els[s] : makeEl("div")),
  createElement: (tag) => {
    const e = makeEl(tag);
    if (tag === "a") e.click = () => { downloaded = e.download; };
    return e;
  },
  body: makeEl("body"),
};
global.window = { addEventListener() {} };
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.FileReader = class {
  readAsText() { this.onload({ target: { result: "TRANSLATION-RAW" } }); }
};

/* ---------------- Workspace（app.js 暴露的只读工作区接口） ---------------- */
const SOURCE = [
  { id: 1, start_ms: 1000, end_ms: 4000, text: "源一" },
  { id: 2, start_ms: 5000, end_ms: 8000, text: "源二" },
  { id: 3, start_ms: 9000, end_ms: 10000, text: "源三（无译文）" },
];
global.window.Workspace = {
  subtitles: SOURCE,
  anchors: [{ id: 1, subtitle_id: 1, original_ms: 1000, target_ms: 1200 }],
  locks: [2],
  fileNameBase: "sample.calibrated",
};

/* ---------------- fetch 桩 ---------------- */
let pairMode = "complete"; // "complete" | "unpaired" | "invalid"
const pairCalls = [];
let exportCalls = [];

function pairingComplete(src, trn) {
  // 场景 A：3 源 2 译，{#1,#2}+{#1,#2} 成一组，源 #3 未配对
  return {
    groups: [{ source_ids: [1, 2], translation_ids: [1, 2] }],
    unpaired_source_ids: [3],
    unpaired_translation_ids: [],
    source_count: src.length,
    translation_count: trn.length,
    complete: false,
  };
}
function pairingAllPaired(src, trn) {
  // 场景 B：2 源 2 译，全部经传递成一组
  return {
    groups: [{ source_ids: [1, 2], translation_ids: [1, 2] }],
    unpaired_source_ids: [],
    unpaired_translation_ids: [],
    source_count: src.length,
    translation_count: trn.length,
    complete: true,
  };
}

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (url === "/api/parse") {
    return {
      ok: true,
      async json() {
        return {
          count: body.content === "BAD" ? 2 : pairMode === "complete" ? 2 : 2,
          sha256: "x".repeat(64),
          subtitles:
            body.content === "BAD"
              ? [
                  { id: 1, start_ms: 1000, end_ms: 5000, text: "坏译文1" },
                  { id: 2, start_ms: 2000, end_ms: 3000, text: "坏译文2（重叠且倒挂）" },
                ]
              : [
                  { id: 1, start_ms: 3000, end_ms: 6000, text: "tr1" },
                  { id: 2, start_ms: 7000, end_ms: 7500, text: "tr2" },
                ],
        };
      },
    };
  }
  if (url === "/api/bilingual/pair") {
    pairCalls.push(body);
    if (pairMode === "invalid") {
      return {
        ok: false,
        status: 400,
        async json() {
          return {
            detail: {
              code: "invalid_translation",
              message: "译文 SRT 时间不合法，已拒绝导入",
              reasons: ["译文 #2 时间倒挂", "译文 #1 与 #2 时间区间正长度重叠"],
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return pairMode === "complete"
          ? pairingComplete(body.subtitles, body.translations)
          : pairingAllPaired(body.subtitles, body.translations);
      },
    };
  }
  if (url === "/api/bilingual/export") {
    exportCalls.push(body);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="bilingual.srt"' },
      async json() { return {}; },
      async blob() { return new global.Blob(["SRT-BYTES"]); },
    };
  }
  throw new Error("未预期的请求：" + url);
};

/* app.js 提供给各模块的全局 api() 小封装（与 app.js 行为一致） */
global.api = async (urlPath, payload) => {
  const res = await global.fetch(urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    if (d && typeof d === "object") {
      if (Array.isArray(d.reasons) && d.reasons.length) throw new Error(d.reasons.join("；"));
      if (typeof d.message === "string") throw new Error(d.message);
    }
    throw new Error(typeof d === "string" ? d : "请求失败");
  }
  return data;
};

/* ---------------- 加载 bilingual.js（IIFE） ---------------- */
const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "bilingual.js"), "utf8"
);
new Function(src)();
const BilingualUI = global.window.BilingualUI;
const assert = require("assert");

const tick = () => new Promise((r) => setTimeout(r, 5));
const groupCards = () =>
  els["#bi-list"].children.filter((c) => typeof c.querySelector === "function");

(async () => {
  // 初始：未导入译文，导出禁用
  assert.strictEqual(els["#bi-export"].disabled, true);

  // 1) 场景 A：粘贴导入，存在未配对源 #3
  pairMode = "complete";
  els["#bi-paste-area"].value = "GOOD";
  els["#bi-parse-paste"].dispatch("click");
  await tick();
  assert.strictEqual(pairCalls.length, 1);
  assert.strictEqual(pairCalls[0].subtitles.length, 3);
  assert.strictEqual(pairCalls[0].translations.length, 2);
  // 渲染：1 张配对组卡片 + 1 张源侧未配对卡片 + 1 个译文未配对区（空则不渲染该标题区）
  const cardsA = groupCards();
  assert.ok(cardsA.length >= 2, "应渲染组卡片与未配对源卡片");
  assert.ok(els["#bi-status"].innerHTML.includes("禁止双语导出"));
  assert.strictEqual(els["#bi-export"].disabled, true, "有未配对条目时禁用导出");

  // 预览无冲突也不能导出（仍有未配对）
  BilingualUI.setPreview(
    SOURCE.map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    true
  );
  assert.strictEqual(els["#bi-export"].disabled, true);

  // 2) 场景 B：全部配对
  pairMode = "paired";
  els["#bi-parse-paste"].dispatch("click");
  await tick();
  assert.strictEqual(pairCalls.length, 2);
  assert.ok(els["#bi-status"].innerHTML.includes("全部配对"));
  // 尚未推送「无冲突」预览：默认 canExport=false → 仍禁用
  assert.strictEqual(els["#bi-export"].disabled, true);
  // 预览有冲突
  BilingualUI.setPreview(
    SOURCE.slice(0, 2).map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    false
  );
  assert.strictEqual(els["#bi-export"].disabled, true, "预览有冲突时禁止双语导出");
  // 冲突消除
  BilingualUI.setPreview(
    SOURCE.slice(0, 2).map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    true
  );
  assert.strictEqual(els["#bi-export"].disabled, false);

  // 3) 导出：校验载荷
  els["#bi-export"].dispatch("click");
  await tick();
  assert.strictEqual(exportCalls.length, 1);
  const payload = exportCalls[0];
  assert.strictEqual(payload.subtitles.length, 3);
  assert.strictEqual(payload.translations.length, 2);
  assert.strictEqual(payload.anchors.length, 1);
  assert.deepStrictEqual(payload.locks, [2]);
  assert.strictEqual(downloaded, "sample.bilingual.srt");

  // 4) 译文倒挂 / 重叠 → 拒绝导入：保留场景 B 的配对，仍可导出
  pairMode = "invalid";
  els["#bi-paste-area"].value = "BAD";
  els["#bi-parse-paste"].dispatch("click");
  await tick();
  assert.ok(els["#bi-status"].innerHTML.includes("拒绝导入"));
  // 旧配对未被清空（仍全部配对 + 预览可导出）
  assert.strictEqual(els["#bi-export"].disabled, false);
  assert.strictEqual(exportCalls.length, 1, "拒绝导入不应触发导出");

  // 5) reset（重新导入源 SRT）：清空配对与禁用导出
  BilingualUI.reset();
  assert.strictEqual(els["#bi-export"].disabled, true);
  assert.ok(els["#bi-list"].innerHTML.includes("译文 SRT"));
  assert.strictEqual(els["#bi-paste-area"].value, "");

  console.log("ok - bilingual.js 接线冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
