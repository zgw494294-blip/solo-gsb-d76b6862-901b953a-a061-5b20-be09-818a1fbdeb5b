/* revise.js 浏览器接线冒烟测试（Node + 极简 DOM mock，无第三方依赖）。
 * node tests/test_revise_ui_smoke.js
 *
 * 覆盖：
 *   输入校验（空查找词 / 换行 / 译文未导入）→
 *   区分大小写、从左至右、不重叠字面量命中（含 $ 字面量与空替换）→
 *   预览逐条列出 → 整批应用载荷（源文 / 译文分别落地、两侧纪元）→
 *   失效拦截（源文重导纪元 / 译文重导纪元 / 待改正文变化；锚点锁定变化仍可应用）→
 *   取消不改工作区 → 译文侧落地只调译文接口 → 重置清空待确认预览。
 */
"use strict";

const path = require("path");
const fs = require("fs");

/* ---------------- 极简 DOM mock（与 typeset / bilingual 冒烟测试同型） ---------------- */
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
    querySelectorAll() { return []; },
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
    _options: [],
    get options() { return this._options; },
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
const ids = ["rv-find", "rv-replace", "rv-side", "rv-preview", "rv-apply", "rv-cancel", "rv-status", "rv-list"];
for (const id of ids) els["#" + id] = makeEl("div");
els["#rv-find"].tagName = "input";
els["#rv-replace"].tagName = "input";
els["#rv-side"].tagName = "select";
els["#rv-side"].value = "both";
els["#rv-side"]._options = [{ value: "source" }, { value: "translation" }, { value: "both" }];

global.document = {
  querySelector: (s) => (els[s] ? els[s] : makeEl("div")),
  createElement: (tag) => makeEl(tag),
  body: makeEl("body"),
};
global.window = { addEventListener() {} };

/* ---------------- 工作区 / 双语 UI / 排版 UI mock ---------------- */
let SOURCE = [
  { id: 1, start_ms: 1200, end_ms: 3500, text: "她走了过来，她回头看了看。" },
  { id: 2, start_ms: 4000, end_ms: 6800, text: "Hello hello, WORLD." },
  { id: 3, start_ms: 7500, end_ms: 10000, text: "定价 $5，含 $1 税。" },
  { id: 4, start_ms: 11000, end_ms: 13000, text: "无命中的一条。" },
];
let TRANSLATION = [
  { id: 1, start_ms: 3000, end_ms: 6000, text: "She came over, and she looked back." },
  { id: 2, start_ms: 7000, end_ms: 7500, text: "hello hello, world." },
  { id: 3, start_ms: 8000, end_ms: 9000, text: "no hit here" },
];
let sourceEpoch = 3;
let importEpoch = 2;

const srcApplyCalls = [];
const trnApplyCalls = [];
const purgeCalls = [];
const previewRefreshes = [];

global.window.Workspace = {
  get subtitles() { return SOURCE; },
  anchors: [],
  locks: [],
  fileNameBase: "sample.calibrated",
  get sourceEpoch() { return sourceEpoch; },
  get importEpoch() { return importEpoch; },
  applySourceEdits(editsById) {
    const changed = [];
    for (const s of SOURCE) {
      if (editsById.has(s.id) && s.text !== editsById.get(s.id)) {
        s.text = editsById.get(s.id);
        changed.push(s.id);
      }
    }
    srcApplyCalls.push(new Map(editsById));
    previewRefreshes.push(changed.length);
    if (window.TypesetUI && changed.length) window.TypesetUI.purgeSourceEdits(changed);
    return changed;
  },
};

global.window.BilingualUI = {
  getTranslations: () => TRANSLATION,
  importEpoch: () => importEpoch,
  applyTranslationEdits(editsById) {
    const changed = [];
    for (const t of TRANSLATION) {
      if (editsById.has(t.id) && t.text !== editsById.get(t.id)) {
        t.text = editsById.get(t.id);
        changed.push(t.id);
      }
    }
    trnApplyCalls.push(new Map(editsById));
    return changed;
  },
};
global.window.TypesetUI = {
  purgeSourceEdits(ids) { purgeCalls.push([...ids]); },
};

/* ---------------- 加载 revise.js（IIFE） ---------------- */
const reviseSrc = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "revise.js"), "utf8"
);
new Function(reviseSrc)();
const ReviseUI = global.window.ReviseUI;
const assert = require("assert");

const click = (el) => el.dispatch("click");
const statusHtml = () => els["#rv-status"].innerHTML;
const listHtml = () => els["#rv-list"].innerHTML;

(async () => {
  // 初始：无待应用批次
  assert.strictEqual(els["#rv-apply"].disabled, true);
  assert.strictEqual(els["#rv-cancel"].disabled, true);

  // 1) 空查找词
  els["#rv-find"].value = "";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("查找词不能为空"));
  assert.strictEqual(els["#rv-apply"].disabled, true);

  // 2) 查找词含换行（\r 也拦）
  els["#rv-find"].value = "ab\n";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("不得含换行"), "查找词换行被拒");
  els["#rv-find"].value = "ab\rc";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("不得含换行"), "查找词 CR 被拒");
  els["#rv-find"].value = "ab";
  els["#rv-replace"].value = "x\ny";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("替换文本不得含换行"), "替换文本换行被拒");
  els["#rv-replace"].value = "";

  // 3) 仅译文侧但尚未导入译文
  const savedTrn = TRANSLATION;
  TRANSLATION = null;
  els["#rv-find"].value = "she";
  els["#rv-side"].value = "translation";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("尚未导入译文"));
  TRANSLATION = savedTrn;

  // 4) 区分大小写 + 从左至右不重叠：源文「她」命中 #1 两次；#2 的小写 hello 不匹配 Hello
  els["#rv-side"].value = "source";
  els["#rv-find"].value = "她";
  els["#rv-replace"].value = "他";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("她走了过来，她回头看了看。"), "列出修改前文本");
  assert.ok(listHtml().includes("他走了过来，他回头看了看。"), "列出修改后文本");
  assert.ok(listHtml().includes(">2<"), "命中处数显示");
  assert.ok(!listHtml().includes("Hello hello"), "#2 不含「她」，不应列出");
  assert.ok(!listHtml().includes("无命中的一条"), "未命中条目不列出");
  assert.strictEqual(els["#rv-apply"].disabled, false);
  // 工作区尚未改变
  assert.strictEqual(SOURCE[0].text, "她走了过来，她回头看了看。");

  // 大小写敏感：查 "hello" 不应命中 #2 的 "Hello"，但命中小写那个（不重叠、从左至右 1 处，因为第二个小写是 hello 也在 "Hello hello" → 实际小写 hello 仅 1 个）
  els["#rv-apply"].disabled && assert.fail("应可应用");
  click(els["#rv-cancel"]); // 先取消，验证取消不改工作区
  assert.strictEqual(els["#rv-apply"].disabled, true);
  assert.strictEqual(SOURCE[0].text, "她走了过来，她回头看了看。", "取消不改工作区");

  els["#rv-find"].value = "hello";
  els["#rv-replace"].value = "hi";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("Hello hi, WORLD."), "仅小写 hello 命中，Hello 不命中");
  assert.ok(!listHtml().includes("Hello hi, hi"), "不重叠/大小写正确");
  click(els["#rv-cancel"]);

  // 5) $ 按字面量处理 + 空替换：#3「$」两处
  els["#rv-find"].value = "$";
  els["#rv-replace"].value = "";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("定价 5，含 1 税。"), "$ 为字面量且可删除；$1/$5 不引发特殊替换");
  assert.ok(listHtml().includes(">2<"), "#3 命中 2 处");
  click(els["#rv-cancel"]);

  // 6) 两侧预览 + 整批应用
  els["#rv-side"].value = "both";
  els["#rv-find"].value = "hello";
  els["#rv-replace"].value = "HELLO";
  click(els["#rv-preview"]);
  // 源文 #2：小写 hello 1 处；译文 #2：两个小写 hello 都命中；译文 #1 无小写
  assert.ok(listHtml().includes("Hello HELLO, WORLD."), "源文 #2 修改后");
  assert.ok(listHtml().includes("HELLO HELLO, world."), "译文 #2 两处小写都替换");
  assert.ok(!listHtml().includes("She came"), "译文 #1 无小写 hello，不列出");
  const beforeSrcEpoch = sourceEpoch;
  const beforeTrnEpoch = importEpoch;

  // 7) 预览后仅锚点 / 锁定变化（纪元与正文都不变）→ 仍可应用
  //    （Workspace mock 无锚点状态，这里直接应用，验证不会因无关因素被拒）
  click(els["#rv-apply"]);
  assert.ok(statusHtml().indexOf("✔ 已整批应用") === 0, "成功应用：" + statusHtml());
  assert.strictEqual(sourceEpoch, beforeSrcEpoch);
  assert.strictEqual(SOURCE[1].text, "Hello HELLO, WORLD.");
  assert.strictEqual(TRANSLATION[1].text, "HELLO HELLO, world.");
  assert.strictEqual(srcApplyCalls.length, 1);
  assert.strictEqual(trnApplyCalls.length, 1);
  assert.deepStrictEqual(srcApplyCalls[0].get(2), "Hello HELLO, WORLD.");
  assert.deepStrictEqual(trnApplyCalls[0].get(2), "HELLO HELLO, world.");
  assert.deepStrictEqual(purgeCalls, [[2]], "源文侧落地后只清理被改条目的排版状态");
  assert.strictEqual(els["#rv-apply"].disabled, true, "应用后待确认批次清空");

  // 8) 失效拦截 A：预览后源文重导（sourceEpoch 变化）
  els["#rv-side"].value = "source";
  els["#rv-find"].value = "WORLD";
  els["#rv-replace"].value = "earth";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("Hello HELLO, earth."));
  sourceEpoch += 1;
  click(els["#rv-apply"]);
  assert.ok(statusHtml().includes("已拒绝整批应用"), "源文重导后拒绝：" + statusHtml());
  assert.ok(statusHtml().includes("源文侧已成功重新导入"));
  assert.ok(statusHtml().includes("工作区未做任何改动"));
  assert.strictEqual(SOURCE[1].text, "Hello HELLO, WORLD.", "拒绝后工作区不变");
  assert.strictEqual(srcApplyCalls.length, 1, "拒绝不落地");

  // 9) 失效拦截 B：预览后译文重导（importEpoch 变化）
  els["#rv-side"].value = "translation";
  els["#rv-find"].value = "world";
  els["#rv-replace"].value = "EARTH";
  click(els["#rv-preview"]);
  importEpoch += 1;
  click(els["#rv-apply"]);
  assert.ok(statusHtml().includes("已拒绝整批应用"), "译文重导后拒绝");
  assert.ok(statusHtml().includes("译文侧已成功重新导入"));
  assert.strictEqual(TRANSLATION[1].text, "HELLO HELLO, world.");
  assert.strictEqual(trnApplyCalls.length, 1);

  // 10) 失效拦截 C：待改正文在预览后被外部改了（纪元不变）
  els["#rv-side"].value = "both";
  els["#rv-find"].value = "5";
  els["#rv-replace"].value = "五";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("定价 $五"), "源文 #3 可预览");
  SOURCE[2].text = "定价 $50，含 $1 税。"; // 外部把待改正文改掉
  click(els["#rv-apply"]);
  assert.ok(statusHtml().includes("已拒绝整批应用"));
  assert.ok(statusHtml().includes("源文 #3 的待改正文在预览后已变化"));
  assert.strictEqual(SOURCE[2].text, "定价 $50，含 $1 税。");
  // 译文侧也必须未落地（整批语义：拒绝时工作区不变）
  assert.ok(!TRANSLATION.some((t) => t.text.includes("EARTH")));

  // 11) 锚点 / 锁定变化但正文与纪元不变 → 仍可应用
  els["#rv-find"].value = "50";
  els["#rv-replace"].value = "五十";
  click(els["#rv-preview"]);
  // 模拟锚点 / 锁定操作（不改正文、不动纪元）
  global.window.Workspace.anchors = [{ id: 1 }];
  global.window.Workspace.locks = [9];
  click(els["#rv-apply"]);
  assert.ok(statusHtml().indexOf("✔ 已整批应用") === 0, "仅锚点/锁定变化仍可应用：" + statusHtml());
  assert.strictEqual(SOURCE[2].text, "定价 $五十，含 $1 税。");

  // 12) 仅译文侧应用：不触发源文落地 / 排版清理 / 预览刷新（译文侧只重渲染配对卡）
  const purgesBefore = purgeCalls.length;
  const srcAppliesBefore = srcApplyCalls.length;
  els["#rv-side"].value = "translation";
  els["#rv-find"].value = "She";
  els["#rv-replace"].value = "They";
  click(els["#rv-preview"]);
  assert.ok(listHtml().includes("They came over"));
  click(els["#rv-apply"]);
  assert.ok(statusHtml().indexOf("✔ 已整批应用") === 0);
  assert.strictEqual(trnApplyCalls.length, 2);
  assert.strictEqual(srcApplyCalls.length, srcAppliesBefore, "译文侧应用不调源文落地");
  assert.strictEqual(purgeCalls.length, purgesBefore, "译文侧应用不清排版");
  assert.strictEqual(TRANSLATION[0].text, "They came over, and she looked back.");

  // 13) 无命中
  els["#rv-find"].value = "不存在的串 XYZ";
  click(els["#rv-preview"]);
  assert.ok(statusHtml().includes("没有命中"));
  assert.strictEqual(els["#rv-apply"].disabled, true);

  // 14) reset（成功重导源 SRT 时由 app.js 调用）：清空待确认预览并带提示
  els["#rv-find"].value = "They";
  els["#rv-replace"].value = "X";
  click(els["#rv-preview"]);
  assert.strictEqual(els["#rv-apply"].disabled, false);
  ReviseUI.reset("源 SRT 已重新导入：两侧（源文 / 译文）的批量校订与待确认预览已清空。");
  assert.strictEqual(els["#rv-apply"].disabled, true);
  assert.strictEqual(els["#rv-cancel"].disabled, true);
  assert.ok(listHtml().includes("预览修改"));
  assert.ok(statusHtml().includes("源 SRT 已重新导入"));

  console.log("ok - revise.js 接线冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
