"use strict";

/* 对白覆盖审计 —— 浏览器侧。
 *
 * 重要：音频只经 FileReader 读入内存，用 Web Audio API
 * （AudioContext.decodeAudioData）在本机解码，绝不上传；
 * 后端只参与字幕解析 / 映射，没有任何音频请求。
 */
(function () {
  const { DEFAULTS, computeWindowRms, runAudit } = AuditCore;

  const audioState = {
    file: null, // {name, size, type, sha256}
    ctx: null, // AudioContext（解码与试听共用）
    buffer: null, // AudioBuffer
    channels: [], // Float32Array[]（解码后的各声道）
    rms: null, // 20ms 窗口、跨声道最大 RMS
    durationMs: 0,
  };

  // 当前实时预览时间轴（映射后的新时间）：[{id, start_ms, end_ms}]
  let timeline = [];
  let timelineSha = "";
  let result = null;
  const reviewed = new Map(); // key -> {kind, reviewed_at}
  let selectedKey = null;
  let selection = null; // {start_ms, end_ms}

  // 试听
  let playSrc = null;
  let playStartCtx = 0;
  let playOffsetMs = 0;
  let playDurMs = 0;
  let rafId = null;

  // 波形缓存（按 CSS 像素宽度）
  let peaksCache = null;
  let statusOverride = null; // {text, bad}：导入/解码时临时覆盖常规状态

  const $ = (sel) => document.querySelector(sel);
  const canvas = () => $("#audit-canvas");

  /* ================= 对外接口（供 app.js 调用） ================= */
  window.AuditUI = {
    // 实时预览刷新后调用：items 为后端返回的映射结果，textById 为条目正文
    setTimeline(items, textById, sourceSha) {
      const texts = textById || {};
      timeline = (items || []).map((it) => ({
        id: it.id,
        start_ms: it.new_start_ms,
        end_ms: it.new_end_ms,
        text: texts[it.id] != null ? String(texts[it.id]) : "",
      }));
      timelineSha = sourceSha || "";
      recompute();
    },
    // 导入新 SRT 时清空（音频与旧时间轴不再匹配）
    reset() {
      stopPlayback();
      timeline = [];
      timelineSha = "";
      result = null;
      reviewed.clear();
      selectedKey = null;
      selection = null;
      statusOverride = null;
      releaseAudio();
      peaksCache = null;
      render();
    },
  };

  function releaseAudio() {
    audioState.file = null;
    audioState.buffer = null;
    audioState.channels = [];
    audioState.rms = null;
    audioState.durationMs = 0;
  }

  /* ================= 音频导入（本地解码，不上传） ================= */
  $("#audit-file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = ""; // 允许再次选择同一文件
    if (!f) return;
    statusOverride = { text: "正在浏览器本地解码音频…", bad: false };
    setAuditStatus(statusOverride.text, false);
    try {
      stopPlayback();
      const buf = await f.arrayBuffer();
      const sha256 = await sha256Hex(buf);
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("当前浏览器不支持 Web Audio API");
      if (!audioState.ctx) audioState.ctx = new Ctx();
      if (audioState.ctx.state === "suspended") await audioState.ctx.resume();
      const decoded = await audioState.ctx.decodeAudioData(buf);
      const channels = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(decoded.getChannelData(c));
      }
      audioState.file = { name: f.name, size: f.size, type: f.type || "", sha256 };
      audioState.buffer = decoded;
      audioState.channels = channels;
      audioState.durationMs = Math.round(decoded.duration * 1000);
      audioState.rms = computeWindowRms(channels, decoded.sampleRate, DEFAULTS.window_ms);
      peaksCache = null;
      reviewed.clear();
      selectedKey = null;
      selection = null;
      statusOverride = null;
      recompute();
    } catch (e) {
      releaseAudio();
      peaksCache = null;
      result = null;
      statusOverride = {
        text:
          "✖ 浏览器无法解码该音频（" +
          (e && e.message ? e.message : "格式不支持") +
          "）。请换用 WAV / MP3 / AAC(m4a) / FLAC / Ogg 等浏览器支持的格式，或先转码。",
        bad: true,
      };
      render();
    }
  });

  async function sha256Hex(buf) {
    const subtle = window.crypto && window.crypto.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", buf);
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return ""; // 非安全上下文等情况下无 SubtleCrypto：摘要留空，不影响审计
  }

  /* ================= 参数 ================= */
  const thresholdSlider = $("#audit-threshold");
  thresholdSlider.addEventListener("input", () => {
    $("#audit-threshold-val").textContent = (Number(thresholdSlider.value) / 100).toFixed(3);
    recompute(); // 参数变化后自动重算
  });

  function currentParams() {
    return {
      threshold_ratio: Number(thresholdSlider.value) / 100,
      window_ms: DEFAULTS.window_ms,
      bridge_silence_ms: DEFAULTS.bridge_silence_ms,
      min_speech_ms: DEFAULTS.min_speech_ms,
      min_uncovered_ms: DEFAULTS.min_uncovered_ms,
      empty_silence_ratio: DEFAULTS.empty_silence_ratio,
      context_ms: DEFAULTS.context_ms,
    };
  }

  /* ================= 重算 ================= */
  function recompute() {
    if (!audioState.buffer || !timeline.length) {
      result = null;
      render();
      return;
    }
    result = runAudit(audioState.rms, timeline, audioState.durationMs, currentParams());
    render();
  }

  /* ================= 渲染 ================= */
  function isReviewed(kind, item, key) {
    const rec = reviewed.get(key);
    return Boolean(rec && rec.kind === kind);
  }

  function gapKey(g) {
    return `gap:${g.start_ms}-${g.end_ms}`;
  }
  function emptyKey(e) {
    return `sub:${e.id}-${e.start_ms}-${e.end_ms}`;
  }

  function setAuditStatus(text, bad) {
    const el = $("#audit-status");
    el.textContent = text;
    el.classList.toggle("bad", Boolean(bad));
    el.classList.toggle("good", !bad && text.startsWith("✔"));
  }
  function render() {
    const hasAudio = Boolean(audioState.buffer);
    $("#audit-export").disabled = !result;
    $("#audit-stop").disabled = !playSrc;
    drawWaveform();

    const info = $("#audit-audio-info");
    if (!hasAudio) {
      info.textContent = "尚未导入音频。";
      if (statusOverride) setAuditStatus(statusOverride.text, statusOverride.bad);
      else setAuditStatus("请先导入 SRT，再选择本地音频文件（仅在浏览器内解码，不会上传）。", false);
      $("#audit-gaps").innerHTML = emptyLi("导入音频后显示");
      $("#audit-empties").innerHTML = emptyLi("导入音频后显示");
      return;
    }
    statusOverride = null;
    const f = audioState.file;
    info.innerHTML =
      `📄 <code>${escapeHtml(f.name)}</code> · ${(f.size / 1048576).toFixed(2)} MiB · ` +
      `${audioState.buffer.numberOfChannels} 声道 · ${audioState.buffer.sampleRate} Hz · ` +
      `${fmtSec(audioState.durationMs / 1000)} · SHA-256 <code>${f.sha256.slice(0, 16) || "—"}…</code>`;

    if (!timeline.length) {
      setAuditStatus("音频已就绪：当前实时预览时间轴为空，无法审计。", false);
      $("#audit-gaps").innerHTML = emptyLi("无字幕时间轴");
      $("#audit-empties").innerHTML = emptyLi("无字幕时间轴");
      return;
    }
    if (!result) return;

    const s = result.summary;
    setAuditStatus(
      `✔ 检出 ${s.voice_interval_count} 段语音（共 ${fmtSec(s.total_voice_ms / 1000)}）· ` +
        `${s.uncovered_count} 处有声无字幕 · ${s.suspect_empty_count} 条疑似空挂`,
      false
    );

    renderItemList(
      $("#audit-gaps"),
      result.uncovered_speech,
      "gap",
      (g) =>
        `<span class="tc">${fmtMs(g.start_ms)} → ${fmtMs(g.end_ms)}</span>` +
        `<span class="dur">${fmtSec(g.duration_ms / 1000)} 有声无字幕</span>`,
      gapKey,
      (g) => ({ start_ms: g.start_ms, end_ms: g.end_ms })
    );
    renderItemList(
      $("#audit-empties"),
      result.suspect_empty,
      "empty",
      (e) =>
        `<span class="sub-id">#${e.id}</span>` +
        `<span class="tc">${fmtMs(e.start_ms)} → ${fmtMs(e.end_ms)}</span>` +
        `<span class="dur">静音 ${Math.round(e.silence_ratio * 100)}%</span>` +
        `<span class="sub-text">${escapeHtml((subTextOf(e.id) || "").replace(/\n/g, " ⏎ "))}</span>`,
      emptyKey,
      (e) => ({ start_ms: e.start_ms, end_ms: e.end_ms })
    );
  }

  function renderItemList(ul, items, kind, bodyHtml, keyOf, rangeOf) {
    ul.innerHTML = "";
    if (!items.length) {
      ul.innerHTML = emptyLi(kind === "gap" ? "未发现连续 ≥300ms 的有声无字幕区间" : "未发现静音占比 ≥70% 的字幕");
      return;
    }
    for (const item of items) {
      const key = keyOf(item);
      const done = isReviewed(kind, item, key);
      const li = document.createElement("li");
      li.className = "audit-item" + (done ? " reviewed" : "") + (selectedKey === key ? " selected" : "");
      li.innerHTML =
        `<button class="audit-play" title="定位并试听前后 1 秒（区间中点 ±1s）">▶</button>` +
        `<div class="audit-item-body">${bodyHtml(item)}</div>` +
        `<button class="audit-review" title="标记 / 取消已核听">${done ? "☑ 已核听" : "☐ 核听"}</button>`;
      li.querySelector(".audit-play").addEventListener("click", (ev) => {
        ev.stopPropagation();
        const r = rangeOf(item);
        locate(r.start_ms, r.end_ms, key);
        audition(r.start_ms, r.end_ms);
      });
      li.querySelector(".audit-review").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (reviewed.has(key)) reviewed.delete(key);
        else reviewed.set(key, { kind, reviewed_at: new Date().toISOString() });
        render();
      });
      li.addEventListener("click", () => locate(rangeOf(item).start_ms, rangeOf(item).end_ms, key));
      ul.appendChild(li);
    }
  }

  function emptyLi(text) {
    return `<li class="audit-empty">${escapeHtml(text)}</li>`;
  }

  function subTextOf(id) {
    const s = timeline.find((x) => x.id === id);
    return s ? s.text : "";
  }

  /* ================= 定位 ================= */
  function locate(startMs, endMs, key) {
    selectedKey = key || null;
    selection = { start_ms: startMs, end_ms: endMs };
    render();
  }

  /* ================= 试听（中点前后 1 秒） ================= */
  function audition(startMs, endMs) {
    if (!audioState.buffer) return;
    stopPlayback();
    const center = (startMs + endMs) / 2;
    const from = Math.max(0, center - DEFAULTS.context_ms);
    const to = Math.min(audioState.durationMs, center + DEFAULTS.context_ms);
    const offset = from / 1000;
    const dur = (to - from) / 1000;
    const src = audioState.ctx.createBufferSource();
    src.buffer = audioState.buffer;
    src.connect(audioState.ctx.destination);
    src.onended = () => {
      if (playSrc === src) stopPlayback(); // 自然播完：清除播放头并复位按钮
    };
    src.start(0, offset, dur);
    playSrc = src;
    playStartCtx = audioState.ctx.currentTime;
    playOffsetMs = from;
    playDurMs = to - from;
    $("#audit-playing").textContent = `▶ 试听 ${fmtMs(from)} → ${fmtMs(to)}（中点 ±1s）`;
    const tick = () => {
      if (!playSrc) return;
      drawPlayhead();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    $("#audit-stop").disabled = false;
  }

  function stopPlayheadLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function stopPlayback(redraw = true) {
    stopPlayheadLoop();
    if (playSrc) {
      try {
        playSrc.onended = null;
        playSrc.stop();
      } catch (e) {
        /* 已结束 */
      }
      playSrc = null;
    }
    playDurMs = 0;
    $("#audit-playing").textContent = "";
    if (redraw) {
      $("#audit-stop").disabled = true;
      drawWaveform();
    }
  }

  $("#audit-stop").addEventListener("click", () => stopPlayback());

  function currentPlayMs() {
    if (!playSrc) return null;
    const elapsed = (audioState.ctx.currentTime - playStartCtx) * 1000;
    return Math.min(playOffsetMs + elapsed, playOffsetMs + playDurMs);
  }

  /* ================= 波形 / 叠加层绘制 ================= */
  const LANE_H = 22; // 顶部字幕条轨道高度
  const WAVE_PAD_TOP = LANE_H + 3;

  function cssWidth() {
    const c = canvas();
    return c.clientWidth || 800;
  }

  function buildPeaks(width) {
    const chs = audioState.channels;
    const mins = new Float32Array(width);
    const maxs = new Float32Array(width);
    if (chs.length && width > 0) {
      const total = chs[0].length;
      const per = Math.max(1, Math.floor(total / width));
      for (const data of chs) {
        for (let i = 0; i < total; i++) {
          const b = Math.min(width - 1, Math.floor(i / per));
          const v = data[i];
          if (v < mins[b]) mins[b] = v;
          if (v > maxs[b]) maxs[b] = v;
        }
      }
    }
    peaksCache = { width, mins, maxs };
  }

  function drawWaveform() {
    const c = canvas();
    const ctx2d = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = cssWidth();
    const H = 150;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, W, H);
    ctx2d.fillStyle = "#0f172a";
    ctx2d.fillRect(0, 0, W, H);

    if (!audioState.buffer) {
      ctx2d.fillStyle = "#94a3b8";
      ctx2d.font = "13px sans-serif";
      ctx2d.fillText("导入本地音频后在此显示波形（绿块=语音区间，上方色条=字幕，红边=疑似空挂）", 12, H / 2);
      drawAxisHint(ctx2d, W, H);
      return;
    }

    const dur = audioState.durationMs || 1;
    const xOf = (ms) => (ms / dur) * W;

    // 1) 语音区间（绿色半透明块）
    if (result) {
      ctx2d.fillStyle = "rgba(34,197,94,0.28)";
      for (const v of result.voice_intervals) {
        ctx2d.fillRect(xOf(v.start_ms), WAVE_PAD_TOP, Math.max(1, xOf(v.end_ms) - xOf(v.start_ms)), H - WAVE_PAD_TOP - 4);
      }
    }

    // 2) 波形（跨声道峰值）
    if (!peaksCache || peaksCache.width !== W) buildPeaks(W);
    const { mins, maxs } = peaksCache;
    const top = WAVE_PAD_TOP + 2;
    const bottom = H - 6;
    const mid = (top + bottom) / 2;
    const amp = (bottom - top) / 2;
    ctx2d.fillStyle = "#cbd5e1";
    for (let x = 0; x < W; x++) {
      const y1 = mid - maxs[x] * amp;
      const y2 = mid - mins[x] * amp;
      ctx2d.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // 3) 顶部字幕条
    const suspectIds = new Set((result ? result.suspect_empty : []).map((e) => e.id));
    ctx2d.font = "10px sans-serif";
    for (const s of timeline) {
      if (s.end_ms <= 0 || s.start_ms >= audioState.durationMs) continue;
      const x = xOf(Math.max(0, s.start_ms));
      const x2 = xOf(Math.min(audioState.durationMs, s.end_ms));
      const sus = suspectIds.has(s.id);
      ctx2d.fillStyle = sus ? "rgba(251,146,60,0.85)" : "rgba(96,165,250,0.75)";
      ctx2d.fillRect(x, 3, Math.max(2, x2 - x), LANE_H - 6);
      if (sus) {
        ctx2d.strokeStyle = "#ef4444";
        ctx2d.lineWidth = 1;
        ctx2d.strokeRect(x + 0.5, 3.5, Math.max(2, x2 - x) - 1, LANE_H - 7);
      }
      if (x2 - x > 20) {
        ctx2d.fillStyle = "#0f172a";
        ctx2d.fillText(String(s.id), x + 3, 14);
      }
    }

    // 4) 选中区间高亮
    if (selection) {
      const x = xOf(selection.start_ms);
      const w = xOf(selection.end_ms) - x;
      ctx2d.fillStyle = "rgba(250,204,21,0.18)";
      ctx2d.fillRect(x, 0, Math.max(1, w), H);
      ctx2d.strokeStyle = "#facc15";
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(x + 0.5, 0.5, Math.max(1, w), H - 1);
    }

    // 5) 播放头
    const playMs = currentPlayMs();
    if (playMs != null) {
      const px = xOf(playMs);
      ctx2d.strokeStyle = "#f87171";
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.moveTo(px, 0);
      ctx2d.lineTo(px, H);
      ctx2d.stroke();
    }
    drawAxisHint(ctx2d, W, H);
  }

  function drawPlayhead() {
    // 播放中逐帧重绘（波形峰值走缓存，开销很小）
    drawWaveform();
  }

  function drawAxisHint(ctx2d, W, H) {
    if (!audioState.durationMs) return;
    ctx2d.fillStyle = "#64748b";
    ctx2d.font = "10px sans-serif";
    ctx2d.fillText("0:00", 4, H - 1);
    const end = fmtSec(audioState.durationMs / 1000);
    const w = ctx2d.measureText(end).width;
    ctx2d.fillText(end, W - w - 4, H - 1);
  }

  // 点击波形：定位并试听点击点前后 1 秒
  canvas().addEventListener("click", (ev) => {
    if (!audioState.buffer) return;
    const rect = ev.target.getBoundingClientRect();
    const ms = ((ev.clientX - rect.left) / rect.width) * audioState.durationMs;
    locate(ms, ms, null);
    audition(ms, ms);
  });

  window.addEventListener("resize", () => {
    peaksCache = null;
    drawWaveform();
  });

  /* ================= 导出 JSON 报告 ================= */
  $("#audit-export").addEventListener("click", () => {
    if (!result) return;
    const f = audioState.file;
    const withReview = (kind, items, keyOf, extra) =>
      items.map((it) => {
        const key = keyOf(it);
        const rec = reviewed.get(key);
        return Object.assign({}, extra(it), {
          reviewed: Boolean(rec && rec.kind === kind),
          reviewed_at: rec ? rec.reviewed_at : null,
        });
      });

    const report = {
      report_type: "dialogue_coverage_audit",
      schema_version: 1,
      generated_at: new Date().toISOString(),
      privacy: "音频仅在浏览器内通过 Web Audio API 解码，未上传任何服务器；本报告不含音频数据。",
      audio: {
        file_name: f.name,
        size_bytes: f.size,
        mime_type: f.type || null,
        duration_ms: audioState.durationMs,
        sample_rate_hz: audioState.buffer.sampleRate,
        channels: audioState.buffer.numberOfChannels,
        sha256: f.sha256 || null,
        decoded_with: "AudioContext.decodeAudioData",
      },
      timeline: {
        source: "current_realtime_preview",
        subtitle_sha256: timelineSha || null,
        subtitle_count: result.summary.subtitle_count,
      },
      parameters: result.params,
      summary: result.summary,
      voice_intervals: result.voice_intervals,
      uncovered_speech: withReview("gap", result.uncovered_speech, gapKey, (g) => ({
        start_ms: g.start_ms,
        end_ms: g.end_ms,
        duration_ms: g.duration_ms,
      })),
      suspect_empty_subtitles: withReview("empty", result.suspect_empty, emptyKey, (e) => ({
        subtitle_id: e.id,
        start_ms: e.start_ms,
        end_ms: e.end_ms,
        duration_ms: e.duration_ms,
        silence_ratio: e.silence_ratio,
      })),
      reviewed_items: [...reviewed.entries()].map(([key, rec]) => ({ key, kind: rec.kind, reviewed_at: rec.reviewed_at })),
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (f.name || "audio").replace(/\.[^.]+$/, "") + ".audit.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* ================= 小工具 ================= */
  function fmtMs(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
  }
  function fmtSec(sec) {
    sec = Number(sec) || 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  drawWaveform();
})();
