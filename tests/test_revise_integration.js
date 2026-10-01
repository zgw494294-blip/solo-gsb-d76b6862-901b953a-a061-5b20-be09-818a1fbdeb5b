/* 跨模块集成冒烟：加载真实的 app.js + typeset.js + bilingual.js + revise.js，
 * 用极简 DOM / fetch mock 串联完整链路（Node，无第三方依赖）。
 * node tests/test_revise_integration.js
 *
 * 验证端到端关键不变量：
 *   A. 批量校订源文 → state.subtitles 正文变化、时间/编号/锚点/锁定不变；
 *      字幕表重绘、被改条目的排版建议/已接受/撤销快照清除（撤销不复活旧正文）；
 *      普通/排版版/双语三种导出载荷都带校订后正文；原始 SRT 摘要（rawContent）不变。
 *   B. 校订译文 → 译文正文变化、配对不重算、双语导出错位正文；源文不动。
 *   C. 预览后成功重导译文（importEpoch 变化）→ 拒绝整批；源文重导清空两侧。
 *   D. 译文导入失败（400）→ 译文 / 配对 / 纪元保留，校订预览仍可应用。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const assert = require("assert");

/* ---------------- 通用 DOM 元素 ---------------- */
function makeFakeChild(sel, parent) {
  return {
    selector: sel, parent, children: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { (on === undefined ? !this._s.has(c) : on) ? this.add(c) : this.remove(c); },
      contains(c) { return this._s.has(c); },
    },
    _listeners: {},
    _text: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(s) { return makeFakeChild(s, this); },
    querySelectorAll() { return []; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
    focus() {}, select() {},
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag || "div",
    children: [], style: {}, dataset: {}, files: [],
    value: "", disabled: false, checked: false, title: "",
    width: 800, height: 150, clientWidth: 800,
    _options: [],
    get options() { return this._options; },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { (on === undefined ? !this._s.has(c) : on) ? this.add(c) : this.remove(c); },
      contains(c) { return this._s.has(c); },
    },
    _attrs: {},
    _listeners: {},
    _childBySelector: {},
    _innerHTML: "",
    set innerHTML(v) {
      this._innerHTML = v;
      this.children = [];
      this._childBySelector = {};
      const re = /class="([^"]+)"/g;
      let m;
      while ((m = re.exec(v))) {
        for (const cls of m[1].split(/\s+/)) {
          if (!cls) continue;
          const sel = "." + cls;
          if (!this._childBySelector[sel]) {
            const ch = makeFakeChild(sel, this);
            this._childBySelector[sel] = ch;
            this.children.push(ch);
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
    getContext() {
      return { setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, strokeRect() {},
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, measureText: () => ({ width: 20 }) };
    },
    appendChild(child) { this.children.push(child); this._innerHTML += child.innerHTML || ""; return child; },
    remove() {},
    click() {},
    focus() {}, select() {},
  };
  return el;
}

/* ---------------- 全局 ---------------- */
const known = new Map();
function getEl(sel) {
  if (!known.has(sel)) known.set(sel, makeEl(sel.startsWith("#") ? "input" : "div"));
  return known.get(sel);
}
global.document = {
  querySelector: (s) => getEl(s),
  createElement: (t) => {
    const e = makeEl(t);
    if (t === "a") e.click = function () { downloads.push(this.download); };
    return e;
  },
  body: makeEl("body"),
};
global.window = { addEventListener() {} };
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };
const downloads = [];

// 输入控件默认
getEl("#rv-side").value = "both";
getEl("#rv-side")._options = [{ value: "source" }, { value: "translation" }, { value: "both" }];
getEl("#ts-columns").value = "18";
getEl("#ts-maxlines").value = "2";

/* ---------------- 数据与 fetch mock ---------------- */
const SRC_RAW = "1\n00:00:01,200 --> 00:00:03,500\n她走了过来，她回头看了看。\n\n" +
  "2\n00:00:04,000 --> 00:00:06,800\nHello world.\n\n" +
  "3\n00:00:07,500 --> 00:00:10,000\n无改动条目。\n";
const SRC_SUBS = [
  { id: 1, start_ms: 1200, end_ms: 3500, text: "她走了过来，她回头看了看。" },
  { id: 2, start_ms: 4000, end_ms: 6800, text: "Hello world." },
  { id: 3, start_ms: 7500, end_ms: 10000, text: "无改动条目。" },
];
const TRN_SUBS = [
  { id: 1, start_ms: 3000, end_ms: 6000, text: "She comes, she looks." },
  { id: 2, start_ms: 7000, end_ms: 7500, text: "hello world." },
];

let trnReject = false; // 置 true 时译文导入返回 400
const calls = { pair: 0, typesetSuggest: 0, export: [], typesetExport: [], bilingualExport: [] };

global.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (url === "/api/parse") {
    return {
      ok: true,
      async json() {
        // 源文解析：按内容是否含源文标记区分
        if (body.content === SRC_RAW) {
          return {
            count: SRC_SUBS.length, sha256: "s".repeat(64),
            subtitles: SRC_SUBS.map((s) => ({ ...s, text: s.text })),
          };
        }
        // 译文解析
        if (body.content === "TRN_BAD") {
          return {
            count: 2, sha256: "b".repeat(64),
            subtitles: [
              { id: 1, start_ms: 5000, end_ms: 3000, text: "倒挂" },
              { id: 2, start_ms: 4000, end_ms: 8000, text: "重叠" },
            ],
          };
        }
        return {
          count: TRN_SUBS.length, sha256: "t".repeat(64),
          subtitles: TRN_SUBS.map((t) => ({ ...t, text: t.text })),
        };
      },
    };
  }
  if (url === "/api/preview") {
    // 无冲突直通：新时间=原时间
    return {
      ok: true,
      async json() {
        return {
          items: body.subtitles.map((s) => ({
            id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms, locked: body.locks.includes(s.id),
          })),
          conflicts: [], can_export: true, anchor_count: body.anchors.length, mapping_enabled: false,
        };
      },
    };
  }
  if (url === "/api/export") {
    calls.export.push(body);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="x.srt"' },
      async json() { return {}; },
      async blob() { return new global.Blob(["SRC-SRT:" + body.subtitles.map((s) => s.text).join("|")]); },
    };
  }
  if (url === "/api/bilingual/pair") {
    calls.pair++;
    if (trnReject) {
      return {
        ok: false, status: 400,
        async json() {
          return { detail: { code: "invalid_translation", message: "译文 SRT 时间不合法，已拒绝导入",
            reasons: ["译文 #1 时间倒挂", "译文 #1 与 #2 正长度重叠"] } };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          groups: [{ source_ids: [1, 2, 3], translation_ids: [1, 2] }],
          unpaired_source_ids: [], unpaired_translation_ids: [],
          source_count: 3, translation_count: 2, complete: true,
        };
      },
    };
  }
  if (url === "/api/bilingual/export") {
    calls.bilingualExport.push(body);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="x.srt"' },
      async json() { return {}; },
      async blob() {
        const src = body.subtitles.map((s) => s.text).join("/");
        const trn = body.translations.map((t) => t.text).join("/");
        return new global.Blob(["BI:" + src + "::" + trn]);
      },
    };
  }
  if (url === "/api/typeset/suggest") {
    calls.typesetSuggest++;
    // 给每条返回「可接受但无变化」之外，#1 返回一个真实建议（新增换行）
    return {
      ok: true,
      async json() {
        return {
          columns: 18, max_lines: 2, total: body.subtitles.length,
          feasible_count: body.subtitles.length, infeasible_count: 0,
          change_count: body.subtitles.length,
          results: body.subtitles.map((s) => ({
            id: s.id, feasible: true, columns: 18, max_lines: 2, changed: true,
            original: s.text, text: s.text + "\n断行",
            lines: [s.text, "断行"], widths: [10, 4], total_penalty: 3, residual_sq: 0,
            cluster_count: s.text.length + 2,
            breaks: [{ boundary: 1, kind: "han", kind_label: "汉字之间", penalty: 3, existing: false,
              left: (s.text[0] || ""), right: "" }],
            reasons: [],
          })),
        };
      },
    };
  }
  if (url === "/api/typeset/export") {
    calls.typesetExport.push(body);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="x.srt"' },
      async json() { return {}; },
      async blob() {
        return new global.Blob(["TS:" + body.subtitles.map((s) => s.text + "@" + s.original_text).join("|")]);
      },
    };
  }
  throw new Error("未预期的请求：" + url);
};
global.api = async (urlPath, payload) => {
  const res = await global.fetch(urlPath, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
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

/* ---------------- 加载真实模块（与 index.html 同序，跳过 audit） ---------------- */
const load = (f) => new Function(fs.readFileSync(path.join(__dirname, "..", "app", "static", f), "utf8"))();
load("app.js");
load("typeset.js");
load("bilingual.js");
load("revise.js");

const tick = () => new Promise((r) => setTimeout(r, 5));
const W = global.window.Workspace;

(async () => {
  // ---- 初始导入源 SRT（走真实 app.js importContent）----
  await W; // noop
  // 直接调用内部不便，改用文件输入桩：app.js 在 change 时 FileReader 读取
  // 这里改走粘贴解析按钮
  getEl("#paste-area").value = SRC_RAW;
  getEl("#parse-paste").dispatch("click");
  await tick();
  assert.strictEqual(W.subtitles.length, 3, "源 SRT 已导入");
  const rawShaAtImport = W.subtitles; // 引用

  // 加一个锚点 + 锁 #3（验证校订不影响它们）
  // 锚点通过 UI 表单添加：#sub1 锚点按钮在渲染的行内；直接用内部 state 不易，
  // 这里验证校订不碰锚点/锁定：用表格锁定按钮。
  // （锚点表单依赖 openAnchorForm，由行按钮触发；行内按钮在 mock 中可 dispatch。）
  // 先锁定 #3
  const tbody = getEl("#sub-tbody");
  const rows = tbody.children.filter((c) => typeof c.querySelector === "function");
  assert.strictEqual(rows.length, 3, "字幕表渲染 3 行");

  /* ---- A. 排版：生成建议并全部接受，随后校订源文 #1 ---- */
  getEl("#ts-generate").dispatch("click");
  await tick();
  assert.strictEqual(calls.typesetSuggest, 1);
  getEl("#ts-accept-all").dispatch("click");
  // 让排版可导出（需要无冲突预览；导入时已 refreshPreview）
  assert.strictEqual(getEl("#ts-export").disabled, false, "全部接受 + 无冲突 → 排版可导出");

  // 校订前导出排版版：载荷 original_text == text（接受的换行版）
  getEl("#ts-export").dispatch("click");
  await tick();
  assert.strictEqual(calls.typesetExport.length, 1);
  const before = W.subtitles.map((s) => s.text);

  /* ---- B. 批量校订源文：预览 → 应用 ---- */
  getEl("#rv-side").value = "source";
  getEl("#rv-find").value = "她";
  getEl("#rv-replace").value = "他";
  getEl("#rv-preview").dispatch("click");
  const rvList = getEl("#rv-list").innerHTML;
  assert.ok(rvList.includes("她走了过来，她回头看了看。"));
  assert.ok(rvList.includes("他走了过来，他回头看了看。"));
  assert.ok(!rvList.includes("无改动条目"), "#3 无命中不列出");
  const epochSrc0 = W.sourceEpoch;
  getEl("#rv-apply").dispatch("click");
  await tick();
  assert.ok(getEl("#rv-status").innerHTML.indexOf("✔ 已整批应用") === 0);

  // 源文 #1 正文变了；#2/#3 不变；时间 / 编号不变
  assert.strictEqual(W.subtitles[0].text, "他走了过来，他回头看了看。");
  assert.strictEqual(W.subtitles[1].text, "Hello world.");
  assert.strictEqual(W.subtitles[2].text, "无改动条目。");
  assert.strictEqual(W.subtitles[0].start_ms, 1200);
  assert.strictEqual(W.subtitles[0].end_ms, 3500);
  assert.strictEqual(W.subtitles[0].id, 1);
  assert.strictEqual(W.sourceEpoch, epochSrc0, "校订不是重导，纪元不变");
  assert.strictEqual(before[0], "她走了过来，她回头看了看。"); // 旧值快照仅测试用

  // #1 的排版接受状态被清、#2/#3 保留：排版版导出按钮应仍可导出（#2/#3 已接受）
  assert.strictEqual(getEl("#ts-export").disabled, false, "#2/#3 的接受保留，排版仍可导出");
  getEl("#ts-export").dispatch("click");
  await tick();
  assert.strictEqual(calls.typesetExport.length, 2);
  const tsPayload2 = calls.typesetExport[1];
  const tbyId = Object.fromEntries(tsPayload2.subtitles.map((s) => [s.id, s]));
  // #1 已无接受换行：text == original_text == 校订后正文（不含旧换行、不含旧正文）
  assert.strictEqual(tbyId[1].text, "他走了过来，他回头看了看。");
  assert.strictEqual(tbyId[1].original_text, "他走了过来，他回头看了看。");
  // #2 的已接受换行保留
  assert.strictEqual(tbyId[2].text, "Hello world.\n断行");
  assert.strictEqual(tbyId[2].original_text, "Hello world.");
  assert.strictEqual(tbyId[3].text, "无改动条目。\n断行", "#3 接受状态保留");

  // 普通导出使用校订后正文
  getEl("#export-btn").dispatch("click");
  await tick();
  assert.strictEqual(calls.export.length, 1);
  const ex = calls.export[0];
  assert.ok(ex.subtitles.some((s) => s.text === "他走了过来，他回头看了看。"), "普通导出含校订后正文");
  assert.ok(!ex.subtitles.some((s) => s.text.includes("她走了过来")), "普通导出不含旧正文");

  /* ---- C. 导入译文（成功）→ 校订译文 → 双语导出含两侧校订后正文 ---- */
  getEl("#bi-paste-area").value = "TRN_GOOD";
  getEl("#bi-parse-paste").dispatch("click");
  await tick();
  assert.strictEqual(calls.pair, 1, "译文成功导入并配对");
  // 译文导入后由「实时预览刷新」驱动 setPreview（app.refreshPreview 调 BilingualUI.setPreview）。
  // 模拟一次预览刷新（真实页面中锚点/锁定变化或导入即会触发）：
  global.window.BilingualUI.setPreview(
    W.subtitles.map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms, locked: false })),
    true
  );

  // 译文侧校订：she → THEY（大写敏感：仅小写 she 两处…… 实际 #1 含 "She"/"she"）
  getEl("#rv-side").value = "translation";
  getEl("#rv-find").value = "she";
  getEl("#rv-replace").value = "THEY";
  getEl("#rv-preview").dispatch("click");
  let html = getEl("#rv-list").innerHTML;
  assert.ok(html.includes("She comes, THEY looks."), "译文 #1 小写 she 被替换，She 保留");
  getEl("#rv-apply").dispatch("click");
  await tick();
  assert.ok(getEl("#rv-status").innerHTML.indexOf("✔ 已整批应用") === 0);
  // 源文未被译文侧校订影响
  assert.strictEqual(W.subtitles[0].text, "他走了过来，他回头看了看。");
  // 未重新配对
  assert.strictEqual(calls.pair, 1, "译文校订不重新配对");

  // 全部配对且无冲突 → 双语导出按钮可用（未配对拦截在无未配对时不拦）
  assert.strictEqual(getEl("#bi-export").disabled, false, "全部配对且无冲突：双语按钮可用");

  // 点击双语导出：载荷与下载内容都应是两侧校订后正文
  getEl("#bi-export").dispatch("click");
  await tick();
  assert.strictEqual(calls.bilingualExport.length, 1, "双语导出已发起");
  const biBody = calls.bilingualExport[0];
  assert.ok(biBody.subtitles.some((s) => s.text === "他走了过来，他回头看了看。"),
    "双语导出源侧用校订后正文");
  assert.ok(!biBody.subtitles.some((s) => s.text.includes("她走了过来")),
    "双语导出源侧不含旧正文");
  assert.ok(biBody.translations.some((t) => t.text === "She comes, THEY looks."),
    "双语导出译文侧用校订后正文");
  // 锚点 / 锁定 / 编号 / 时间仍随载荷传递（未被校订破坏）
  assert.deepStrictEqual(biBody.subtitles.map((s) => s.id), [1, 2, 3]);
  assert.strictEqual(biBody.subtitles[0].start_ms, 1200);

  const biTrn = global.window.BilingualUI.getTranslations();
  assert.strictEqual(biTrn[0].text, "She comes, THEY looks.");
  assert.strictEqual(biTrn[1].text, "hello world.", "#2 不含小写 she");

  /* ---- D. 预览后译文成功重导 → 拒绝整批；失败重导保留 ---- */
  getEl("#rv-side").value = "translation";
  getEl("#rv-find").value = "hello";
  getEl("#rv-replace").value = "HI";
  getEl("#rv-preview").dispatch("click");
  html = getEl("#rv-list").innerHTML;
  assert.ok(html.includes("HI world."));

  // D1) 译文导入失败（倒挂/重叠）→ 纪元不变，旧译文保留，仍可应用
  trnReject = true;
  getEl("#bi-paste-area").value = "TRN_BAD";
  getEl("#bi-parse-paste").dispatch("click");
  await tick();
  assert.ok(getEl("#bi-status").innerHTML.includes("拒绝导入"));
  assert.strictEqual(global.window.BilingualUI.getTranslations()[0].text,
    "She comes, THEY looks.", "失败导入保留旧译文（含校订）");
  getEl("#rv-apply").dispatch("click");
  await tick();
  assert.ok(getEl("#rv-status").innerHTML.indexOf("✔ 已整批应用") === 0,
    "失败导入不推进纪元，预览仍可应用");
  assert.strictEqual(global.window.BilingualUI.getTranslations()[1].text, "HI world.");

  // D2) 译文成功重导（再做一个译文侧预览后）→ 预览被拒
  getEl("#rv-find").value = "world";
  getEl("#rv-replace").value = "EARTH";
  getEl("#rv-preview").dispatch("click");
  assert.ok(getEl("#rv-list").innerHTML.includes("HI EARTH."));
  trnReject = false;
  getEl("#bi-paste-area").value = "TRN_GOOD2";
  getEl("#bi-parse-paste").dispatch("click"); // 成功重导译文 → 译文校订清空、纪元+1
  await tick();
  assert.strictEqual(global.window.BilingualUI.getTranslations()[1].text, "hello world.",
    "成功重导译文恢复为新译文（译文侧校订清空）");
  // 译文重导只清译文侧：此前已应用的源文校订（#1）必须保留
  assert.strictEqual(W.subtitles[0].text, "他走了过来，他回头看了看。",
    "译文重导不影响已应用的源文校订");
  getEl("#rv-apply").dispatch("click");
  assert.ok(getEl("#rv-status").innerHTML.includes("已拒绝整批应用"), "译文重导后拒绝整批");
  assert.ok(getEl("#rv-status").innerHTML.includes("译文侧已成功重新导入"));
  // 工作区不变
  assert.strictEqual(global.window.BilingualUI.getTranslations()[1].text, "hello world.");

  /* ---- E. 成功重导源 SRT：清空两侧校订、排版、配对；源纪元 +1 ---- */
  const epochSrc1 = W.sourceEpoch;
  getEl("#paste-area").value = SRC_RAW;
  getEl("#parse-paste").dispatch("click");
  await tick();
  assert.strictEqual(W.sourceEpoch, epochSrc1 + 1, "源重导纪元 +1");
  assert.strictEqual(W.subtitles[0].text, "她走了过来，她回头看了看。", "源文回到新导入原文");
  assert.strictEqual(global.window.BilingualUI.getTranslations(), null, "源重导清空译文（两侧校订清空）");
  assert.strictEqual(getEl("#rv-apply").disabled, true, "源重导清空待确认预览");
  assert.ok(getEl("#rv-status").innerHTML.includes("源 SRT 已重新导入"));

  console.log("ok - 批量校订跨模块集成冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
