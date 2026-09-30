/* audit.js 浏览器接线冒烟测试（Node + 极简 DOM mock，无第三方依赖）。
 * node tests/test_audit_ui_smoke.js
 */
"use strict";

const path = require("path");
const fs = require("fs");

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
      toggle(c, on) { on ? this.add(c) : this.remove(c); },
      contains(c) { return this._set.has(c); },
    },
    _attrs: {},
    _listeners: {},
    _childBySelector: {},
    set innerHTML(v) {
      this._innerHTML = v;
      // 极简解析：为 innerHTML 中出现过的选择器生成稳定的可监听子节点
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
    get innerHTML() { return this._innerHTML || ""; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text || ""; },
    getContext() { return makeCtx(); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      if (!this._childBySelector[sel]) this._childBySelector[sel] = makeFakeChild(sel, this);
      return this._childBySelector[sel];
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 150 }; },
    click() {},
    appendChild(child) {
      // 真实 DOM 中 appendChild 会并入子树；测试中把 li 的 innerHTML 追加进来即可断言
      this.children.push(child);
      this._innerHTML = (this._innerHTML || "") + (child.innerHTML || "");
      return child;
    },
    remove() {},
  };
  el.clientWidth = 800;
  el.width = 800;
  el.height = 150;
  el.value = "5";
  return el;
}

function makeFakeChild(sel, parent) {
  return {
    selector: sel,
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    set textContent(v) { this._t = v; },
    get textContent() { return this._t || ""; },
    parent,
  };
}

function makeCtx() {
  return {
    setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
    measureText: () => ({ width: 20 }),
    fillStyle: "", strokeStyle: "", font: "", lineWidth: 1,
  };
}

// ---- 全局 mock ----
const els = {};
const ids = [
  "audit-file", "audit-threshold", "audit-threshold-val", "audit-stop", "audit-export",
  "audit-status", "audit-audio-info", "audit-canvas", "audit-playing", "audit-gaps", "audit-empties",
];
for (const id of ids) els["#" + id] = makeEl("div");
els["#audit-file"].tagName = "input";
els["#audit-threshold"].tagName = "input";
els["#audit-canvas"].tagName = "canvas";

global.document = {
  querySelector: (s) => els[s] || makeEl("div"),
  createElement: () => makeEl("span"),
  body: makeEl("body"),
};
global.window = {
  addEventListener() {},
  devicePixelRatio: 1,
  AudioContext: MockAudioContext,
};
global.self = global.window; // UMD 包装以 self 为浏览器根
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };
Object.defineProperty(global, "crypto", { value: undefined, configurable: true }); // 摘要留空也应工作

let exportedReport = null;
// 拦截下载
const realCreate = global.document.createElement;
global.document.createElement = (tag) => {
  const e = makeEl(tag);
  if (tag === "a") {
    e.click = () => { exportedReport = e.href ? null : null; };
  }
  return e;
};

// ---- Web Audio mock：正弦波 AudioBuffer ----
function MockAudioContext() {
  const sr = 8000;
  return {
    state: "running",
    currentTime: 0,
    sampleRate: sr,
    destination: {},
    resume: async () => {},
    async decodeAudioData(buf) {
      const total = sr * 2; // 2 秒
      const data = new Float32Array(total);
      // 语音 0-500ms 与 700-1300ms（1.0 振幅 440Hz）
      for (let i = 0; i < total; i++) {
        const ms = (i / sr) * 1000;
        if ((ms >= 0 && ms < 500) || (ms >= 700 && ms < 1300)) {
          data[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
        }
      }
      return {
        duration: 2,
        sampleRate: sr,
        numberOfChannels: 1,
        getChannelData: () => data,
      };
    },
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, set onended(v) { this._onended = v; }, get onended() { return this._onended; } };
    },
  };
}

// 加载核心 + 接线
global.AuditCore = require(path.join(__dirname, "..", "app", "static", "audit-core.js"));
const auditSrc = fs.readFileSync(path.join(__dirname, "..", "app", "static", "audit.js"), "utf8");
// audit.js 是 IIFE，直接在全局上下文执行（UMD 内把 AuditUI 挂到 self/window）
new Function(auditSrc)();

const assert = require("assert");
const AuditUI = global.window.AuditUI || global.AuditUI;

(async () => {
  // 1) 先给时间轴：字幕覆盖 0-500 与 1300-2000，间隙 500-1300 含 600ms 语音
  AuditUI.setTimeline(
    [
      { id: 1, new_start_ms: 0, new_end_ms: 500 },
      { id: 2, new_start_ms: 1300, new_end_ms: 2000 },
    ],
    { 1: "第一句", 2: "第二句" },
    "a".repeat(64)
  );
  assert.strictEqual(els["#audit-status"].textContent.includes("请先导入"), true, "无音频时应提示导入");

  // 2) 导入「音频文件」
  const fileBuf = new Uint8Array(10).buffer;
  els["#audit-file"]._listeners.change[0]({
    target: {
      files: [{ name: "ep01.wav", size: 10, type: "audio/wav", arrayBuffer: async () => fileBuf }],
      value: "",
    },
  });
  await new Promise((r) => setTimeout(r, 10));

  const status = els["#audit-status"].textContent;
  assert.ok(status.includes("有声无字幕"), "状态应汇总结果：" + status);
  const gapHtml = els["#audit-gaps"].innerHTML;
  assert.ok(gapHtml.includes("有声无字幕"), gapHtml);
  assert.ok(els["#audit-audio-info"].innerHTML.includes("ep01.wav"));

  // 3) 标记已核听（点 gap 行的核听按钮）——找到 appendChild 进来的真实 li 节点
  const gapLi = els["#audit-gaps"].children.find((c) => typeof c.querySelector === "function");
  assert.ok(gapLi, "应渲染 gap 行");
  gapLi.querySelector(".audit-review").dispatch("click", { stopPropagation() {} });
  assert.ok(els["#audit-gaps"].innerHTML.includes("已核听"), "重渲染后列表应含已核听标记");

  // 4) 阈值拉满 → 语音基本消失（峰值×0.30 仍 < 1？0.707*0.3=0.212，仍检出）；
  //    改为不可检出的高阈值通过内部参数验证：直接用核心验证阈值行为即可，
  //    这里验证滑块变化会触发重算（状态不报错）
  els["#audit-threshold"].value = "1";
  els["#audit-threshold"].dispatch("input");
  assert.ok(els["#audit-status"].textContent.includes("有声无字幕"));

  // 5) 导出报告：拦截 Blob 内容
  let blobParts = null;
  global.Blob = class { constructor(parts) { blobParts = parts; } };
  els["#audit-export"].disabled = false;
  els["#audit-export"].dispatch("click");
  assert.ok(blobParts, "应生成 Blob");
  const report = JSON.parse(blobParts[0]);
  assert.strictEqual(report.report_type, "dialogue_coverage_audit");
  assert.strictEqual(report.audio.file_name, "ep01.wav");
  assert.strictEqual(report.parameters.window_ms, 20);
  assert.strictEqual(report.parameters.threshold_ratio, 0.01);  assert.strictEqual(report.timeline.subtitle_count, 2);
  assert.ok(report.uncovered_speech.length >= 1);
  assert.ok(report.uncovered_speech.some((g) => g.reviewed), "报告应带核听状态");
  assert.ok(report.voice_intervals.length >= 1);
  assert.ok(report.privacy.includes("不上传") || report.privacy.includes("未上传"));

  // 6) reset 后清空
  AuditUI.reset();
  assert.ok(els["#audit-audio-info"].textContent.includes("尚未导入"));
  assert.strictEqual(els["#audit-export"].disabled, true);

  console.log("ok - audit.js 接线冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
