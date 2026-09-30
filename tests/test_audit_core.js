/* 对白覆盖审计核心逻辑测试：node tests/test_audit_core.js（无第三方依赖）。 */
"use strict";

const assert = require("assert");
const path = require("path");
const AuditCore = require(path.join(__dirname, "..", "app", "static", "audit-core.js"));

const {
  computeWindowRms,
  detectVoiceIntervals,
  runAudit,
  complementSorted,
} = AuditCore;

// 生成一段正弦波（振幅 amp），startSample/endSample 为采样区间
function sine(sampleRate, freq, startMs, endMs, amp) {
  const arr = new Float32Array(Math.round((sampleRate * endMs) / 1000));
  const s0 = Math.round((sampleRate * startMs) / 1000);
  const s1 = Math.round((sampleRate * endMs) / 1000);
  for (let i = s0; i < s1 && i < arr.length; i++) {
    arr[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return arr;
}

// 多段正弦拼接为一个声道
function sineSegments(sampleRate, segments, totalMs) {
  const arr = new Float32Array(Math.round((sampleRate * totalMs) / 1000));
  for (const [startMs, endMs, amp, freq = 440] of segments) {
    const s0 = Math.round((sampleRate * startMs) / 1000);
    const s1 = Math.round((sampleRate * endMs) / 1000);
    for (let i = s0; i < s1 && i < arr.length; i++) {
      arr[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
  }
  return arr;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("computeWindowRms: 20ms 窗、跨声道取最大", () => {
  const sr = 1000;
  // 1000 个采样 = 1s；窗长 20 采样 = 20ms，共 50 窗。
  // 50Hz 正弦周期恰为 20 采样，每窗正好一个完整周期 → RMS = amp/√2
  const ch0 = sine(sr, 50, 0, 1000, 0.2);
  const ch1 = sine(sr, 50, 0, 1000, 0.8);
  const rms = computeWindowRms([ch0, ch1], sr, 20);
  assert.strictEqual(rms.length, 50);
  // 取到 ch1 的 RMS（≈ amp/√2），且各窗恒定
  assert.ok(Math.abs(rms[0] - 0.8 / Math.SQRT2) < 1e-3, `got ${rms[0]}`);
  const ch0Only = computeWindowRms([ch0], sr, 20);
  assert.ok(Math.abs(ch0Only[0] - 0.2 / Math.SQRT2) < 1e-3);
});

test("detectVoiceIntervals: 阈值=峰值×比例判定有声", () => {
  const sr = 8000;
  // 200-800ms 有声（峰值 1.0），阈值 0.05
  const ch = sineSegments(sr, [[200, 800, 1.0]], 1000);
  const rms = computeWindowRms([ch], sr, 20);
  const iv = detectVoiceIntervals(rms, 20, 0.05);
  assert.strictEqual(iv.length, 1);
  assert.ok(Math.abs(iv[0][0] - 200) <= 20, String(iv[0][0]));
  assert.ok(Math.abs(iv[0][1] - 800) <= 20, String(iv[0][1]));
  // 阈值高于峰值 → 全静音
  assert.deepStrictEqual(detectVoiceIntervals(rms, 20, 1.5), []);
});

test("detectVoiceIntervals: 桥接短于 120ms 的静音", () => {
  const sr = 8000;
  // [0,500) 声 — 100ms 静音 — [600,1100) 声 → 桥成一段
  const ch = sineSegments(sr, [[0, 500, 1.0], [600, 1100, 1.0]], 1100);
  const rms = computeWindowRms([ch], sr, 20);
  const iv = detectVoiceIntervals(rms, 20, 0.05);
  assert.strictEqual(iv.length, 1);
  assert.ok(iv[0][0] <= 20 && iv[0][1] >= 1100 - 20, JSON.stringify(iv));
});

test("detectVoiceIntervals: 120ms 静音不桥接（严格短于）", () => {
  const sr = 8000;
  // [0,500) — 120ms 静音 — [620,1120)
  const ch = sineSegments(sr, [[0, 500, 1.0], [620, 1120, 1.0]], 1120);
  const rms = computeWindowRms([ch], sr, 20);
  const iv = detectVoiceIntervals(rms, 20, 0.05);
  assert.strictEqual(iv.length, 2, JSON.stringify(iv));
});

test("detectVoiceIntervals: 剔除短于 80ms 的有声片段", () => {
  const sr = 8000;
  // 60ms 的短促声 → 剔除
  const ch = sineSegments(sr, [[100, 160, 1.0]], 500);
  const rms = computeWindowRms([ch], sr, 20);
  assert.deepStrictEqual(detectVoiceIntervals(rms, 20, 0.05), []);
  // 100ms 的声音保留
  const ch2 = sineSegments(sr, [[100, 200, 1.0]], 500);
  const iv = detectVoiceIntervals(computeWindowRms([ch2], sr, 20), 20, 0.05);
  assert.strictEqual(iv.length, 1);
});

test("runAudit: 字幕间隙里的连续语音 → 有声无字幕", () => {
  const sr = 8000;
  // 语音 [0,500)（被字幕 0-500 覆盖）+ 200ms 静音（不触发 120ms 桥接）
  // + [700,1300)（落在字幕间隙 500-1300 内，长 600ms）
  const ch = sineSegments(sr, [[0, 500, 1.0], [700, 1300, 1.0]], 2000);
  const rms = computeWindowRms([ch], sr, 20);
  const subs = [{ id: 1, start_ms: 0, end_ms: 500 }, { id: 2, start_ms: 1300, end_ms: 1900 }];
  const res = runAudit(rms, subs, 2000, { threshold_ratio: 0.05 });
  const gaps = res.uncovered_speech;
  assert.strictEqual(gaps.length, 1, JSON.stringify(gaps));
  assert.ok(Math.abs(gaps[0].start_ms - 700) <= 20, String(gaps[0].start_ms));
  assert.ok(Math.abs(gaps[0].end_ms - 1300) <= 20, String(gaps[0].end_ms));
  assert.ok(gaps[0].duration_ms >= 300);
});

test("runAudit: 语音被字幕覆盖（首尾/中间）不报", () => {
  const sr = 8000;
  // 连续语音 0-2000，字幕 [0,600) 与 [1400,2000] 全覆盖 → 无 gap
  const ch = sineSegments(sr, [[0, 2000, 1.0]], 2000);
  const rms = computeWindowRms([ch], sr, 20);
  const subs = [{ id: 1, start_ms: 0, end_ms: 1000 }, { id: 2, start_ms: 1000, end_ms: 2000 }];
  const res = runAudit(rms, subs, 2000, { threshold_ratio: 0.05 });
  assert.strictEqual(res.uncovered_speech.length, 0);
});

test("runAudit: 短于 300ms 的间隙语音不报", () => {
  const sr = 8000;
  // 字幕 0-400、600-1000；语音 400-600（200ms，桥接/剔除后仍 <300）
  const ch = sineSegments(sr, [[400, 600, 1.0]], 1000);
  const rms = computeWindowRms([ch], sr, 20);
  const subs = [{ id: 1, start_ms: 0, end_ms: 400 }, { id: 2, start_ms: 600, end_ms: 1000 }];
  const res = runAudit(rms, subs, 1000, { threshold_ratio: 0.05 });
  assert.strictEqual(res.uncovered_speech.length, 0, JSON.stringify(res.uncovered_speech));
});

test("runAudit: 疑似空挂——静音 80% 的字幕命中，说话字幕不命中", () => {
  const sr = 8000;
  // 语音只在 0-400ms
  const ch = sineSegments(sr, [[0, 400, 1.0]], 2000);
  const rms = computeWindowRms([ch], sr, 20);
  const subs = [
    { id: 1, start_ms: 0, end_ms: 400 }, // 全程有声 → 不命中
    { id: 2, start_ms: 400, end_ms: 1400 }, // 全静音 → 命中
    { id: 3, start_ms: 1500, end_ms: 1800 }, // 全静音 → 命中
  ];
  const res = runAudit(rms, subs, 2000, { threshold_ratio: 0.05 });
  const ids = res.suspect_empty.map((e) => e.id).sort();
  assert.deepStrictEqual(ids, [2, 3]);
  assert.strictEqual(res.suspect_empty.find((e) => e.id === 2).silence_ratio, 1);
});

test("runAudit: 部分静音按占比判定（阈值 70% 边界）", () => {
  const sr = 8000;
  // 语音 0-350ms；字幕 0-1000 → 静音 65%（350/1000 有声）→ 不命中
  const ch = sineSegments(sr, [[0, 350, 1.0]], 1000);
  const rms = computeWindowRms([ch], sr, 20);
  const res = runAudit(rms, [{ id: 1, start_ms: 0, end_ms: 1000 }], 1000, {
    threshold_ratio: 0.05,
  });
  assert.strictEqual(res.suspect_empty.length, 0);
  // 语音 0-300ms → 静音 70% → 恰好命中（>=）
  const ch2 = sineSegments(sr, [[0, 300, 1.0]], 1000);
  const rms2 = computeWindowRms([ch2], sr, 20);
  const res2 = runAudit(rms2, [{ id: 1, start_ms: 0, end_ms: 1000 }], 1000, {
    threshold_ratio: 0.05,
  });
  assert.strictEqual(res2.suspect_empty.length, 1);
});

test("complementSorted 基础补集", () => {
  assert.deepStrictEqual(
    complementSorted([[200, 400], [700, 900]], 0, 1000),
    [[0, 200], [400, 700], [900, 1000]]
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(e && e.stack ? e.stack : e);
  }
}
if (failed) {
  console.error(`\n${failed}/${tests.length} 个测试失败`);
  process.exit(1);
}
console.log(`\n全部 ${tests.length} 个测试通过`);
