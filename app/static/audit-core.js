"use strict";

/* 对白覆盖审计 —— 纯逻辑核心（不依赖 DOM，便于 Node 测试）。
 *
 * 流程：
 * 1. computeWindowRms：按 windowMs（默认 20ms）分窗，各声道分别计算 RMS，
 *    每个窗口取所有声道 RMS 的最大值；
 * 2. detectVoiceIntervals：以「整段峰值 × 可调阈值」判定有声窗口，
 *    先桥接短于 bridgeSilenceMs（120ms）的静音，
 *    再剔除短于 minSpeechMs（80ms）的有声片段；
 * 3. runAudit：把语音区间与（映射后的）字幕时间轴做区间扫描：
 *    - 字幕未覆盖、且连续语音不少于 minUncoveredMs（300ms）→ 有声无字幕；
 *    - 单条字幕区间内静音占比 ≥ emptySilenceRatio（70%）→ 疑似空挂。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AuditCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULTS = {
    window_ms: 20,
    threshold_ratio: 0.05, // 整段 RMS 峰值 × 5%
    bridge_silence_ms: 120,
    min_speech_ms: 80,
    min_uncovered_ms: 300,
    empty_silence_ratio: 0.7,
    context_ms: 1000, // 定位试听时前后各取 1 秒
  };

  /**
   * 分窗 RMS，窗口内各声道 RMS 取最大值。
   * @param {Float32Array[]} channels 各声道采样
   * @param {number} sampleRate 采样率（Hz）
   * @param {number} windowMs 窗长（毫秒）
   * @returns {Float64Array} 每窗一个「跨声道最大 RMS」
   */
  function computeWindowRms(channels, sampleRate, windowMs) {
    if (!channels || !channels.length) return new Float64Array(0);
    const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    const winCount = Math.floor(channels[0].length / win);
    const out = new Float64Array(winCount);
    for (let w = 0; w < winCount; w++) {
      const start = w * win;
      let maxRms = 0;
      for (let c = 0; c < channels.length; c++) {
        const data = channels[c];
        let sum = 0;
        for (let i = start; i < start + win; i++) {
          const v = data[i];
          sum += v * v;
        }
        const rms = Math.sqrt(sum / win);
        if (rms > maxRms) maxRms = rms;
      }
      out[w] = maxRms;
    }
    return out;
  }

  /**
   * 由窗口 RMS 序列提取语音区间（毫秒，半开区间 [start, end)）。
   * @param rms computeWindowRms 的输出
   * @param windowMs 窗长
   * @param thresholdRatio 阈值比例（乘整段峰值），可由前端调节
   * @param opts 覆盖 DEFAULTS 中的桥接 / 最短片段等参数
   */
  function detectVoiceIntervals(rms, windowMs, thresholdRatio, opts) {
    const p = Object.assign({}, DEFAULTS, opts || {});
    let peak = 0;
    for (let i = 0; i < rms.length; i++) {
      if (rms[i] > peak) peak = rms[i];
    }
    if (!(peak > 0) || !(thresholdRatio > 0)) return []; // 整段静音 / 非法阈值

    const threshold = peak * thresholdRatio;

    // 连续有声窗口 → 初始语音段
    const raw = [];
    let i = 0;
    while (i < rms.length) {
      if (rms[i] >= threshold) {
        let j = i;
        while (j + 1 < rms.length && rms[j + 1] >= threshold) j++;
        raw.push([i * windowMs, (j + 1) * windowMs]);
        i = j + 1;
      } else {
        i++;
      }
    }

    // 桥接短于 bridge_silence_ms 的静音（严格短于；恰好 120ms 不桥接）
    const bridged = [];
    for (const seg of raw) {
      const last = bridged[bridged.length - 1];
      if (last && seg[0] - last[1] < p.bridge_silence_ms) {
        last[1] = seg[1];
      } else {
        bridged.push([seg[0], seg[1]]);
      }
    }

    // 剔除短于 min_speech_ms 的有声片段（严格短于；恰好 80ms 保留）
    return bridged.filter((s) => s[1] - s[0] >= p.min_speech_ms);
  }

  /** 合并已按起点升序排列的区间。 */
  function mergeSorted(intervals) {
    const out = [];
    for (const iv of intervals) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) {
        if (iv[1] > last[1]) last[1] = iv[1];
      } else {
        out.push([iv[0], iv[1]]);
      }
    }
    return out;
  }

  /** 两组已升序区间的交集。 */
  function intersectSorted(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i][0], b[j][0]);
      const hi = Math.min(a[i][1], b[j][1]);
      if (lo < hi) out.push([lo, hi]);
      if (a[i][1] < b[j][1]) i++;
      else j++;
    }
    return out;
  }

  /** intervals 在 [start, end) 内的补集（intervals 需升序、可重叠）。 */
  function complementSorted(intervals, start, end) {
    const out = [];
    let cursor = start;
    for (const iv of intervals) {
      if (iv[1] <= cursor) continue;
      if (iv[0] >= end) break;
      if (iv[0] > cursor) out.push([cursor, Math.min(iv[0], end)]);
      cursor = iv[1];
      if (cursor >= end) break;
    }
    if (cursor < end) out.push([cursor, end]);
    return out;
  }

  /** interval 被 intervals 覆盖的总时长。 */
  function coveredDuration(interval, intervals) {
    let total = 0;
    for (const iv of intersectSorted([interval], intervals)) total += iv[1] - iv[0];
    return total;
  }

  /** 字幕裁剪到 [0, durationMs]，丢弃零时长 / 倒挂项，按起点升序。 */
  function normalizeSubs(subs, durationMs) {
    const out = [];
    for (const s of subs || []) {
      const start = Math.max(0, Math.min(Number(s.start_ms), durationMs));
      const end = Math.max(0, Math.min(Number(s.end_ms), durationMs));
      if (end > start) out.push({ id: s.id, start_ms: start, end_ms: end });
    }
    out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id - b.id);
    return out;
  }

  /**
   * 执行审计。
   * @param rms 窗口 RMS（computeWindowRms）
   * @param subs 当前实时预览时间轴 [{id, start_ms, end_ms}]（映射后的新时间）
   * @param durationMs 音频总时长（毫秒）
   * @param params 阈值等参数（见 DEFAULTS）
   */
  function runAudit(rms, subs, durationMs, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    durationMs = Math.max(0, Number(durationMs) || 0);

    const voice = detectVoiceIntervals(rms, p.window_ms, p.threshold_ratio, p);
    const normSubs = normalizeSubs(subs, durationMs);
    const subUnion = mergeSorted(normSubs.map((s) => [s.start_ms, s.end_ms]));

    // —— 有声无字幕：字幕补集 ∩ 语音区间，连续 ≥ min_uncovered_ms ——
    const uncovered = [];
    for (const gap of complementSorted(subUnion, 0, durationMs)) {
      for (const iv of intersectSorted([gap], voice)) {
        if (iv[1] - iv[0] >= p.min_uncovered_ms) {
          uncovered.push({ start_ms: iv[0], end_ms: iv[1], duration_ms: iv[1] - iv[0] });
        }
      }
    }

    // —— 疑似空挂：字幕区间内静音占比 ≥ emptySilenceRatio ——
    const empty = [];
    for (const s of normSubs) {
      const dur = s.end_ms - s.start_ms;
      const voicedMs = coveredDuration([s.start_ms, s.end_ms], voice);
      const silenceRatio = (dur - voicedMs) / dur;
      if (silenceRatio >= p.empty_silence_ratio) {
        empty.push({
          id: s.id,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          duration_ms: dur,
          silence_ratio: Math.round(silenceRatio * 1000) / 1000,
        });
      }
    }

    const totalVoiceMs = voice.reduce((acc, v) => acc + (v[1] - v[0]), 0);
    return {
      params: p,
      duration_ms: Math.round(durationMs),
      voice_intervals: voice.map(([start_ms, end_ms]) => ({
        start_ms,
        end_ms,
        duration_ms: end_ms - start_ms,
      })),
      uncovered_speech: uncovered,
      suspect_empty: empty,
      summary: {
        voice_interval_count: voice.length,
        total_voice_ms: totalVoiceMs,
        uncovered_count: uncovered.length,
        uncovered_ms: uncovered.reduce((a, g) => a + g.duration_ms, 0),
        suspect_empty_count: empty.length,
        subtitle_count: normSubs.length,
      },
    };
  }

  return {
    DEFAULTS,
    computeWindowRms,
    detectVoiceIntervals,
    mergeSorted,
    intersectSorted,
    complementSorted,
    coveredDuration,
    normalizeSubs,
    runAudit,
  };
});
