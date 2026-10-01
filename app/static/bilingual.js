"use strict";

/* 双语字幕合成（第 7 步）—— 浏览器侧。
 *
 * 在当前源 SRT 上导入译文 SRT：
 *   - 配对只看两侧的**原始时间区间**正长度交集（端点相接不算），
 *     相交关系传递成组（并查集在后端完成），多对一 / 一对多时每条字幕只出现一次；
 *   - 译文时间倒挂 / 正长度重叠 → 后端拒绝导入，前端保持旧配对不变；
 *   - 双语 SRT 每组一条：源文、译文各按原顺序换行拼接后上下排列，
 *     时间取组内源字幕**当前校准预览**的最早开始与最晚结束（译文时间只参与配对）；
 *   - 任一侧存在未配对条目、或实时预览有冲突时禁止双语导出；
 *   - 重新导入源 SRT 时由 app.js 调 reset() 清空配对；
 *   - 不修改 state.subtitles，不影响普通导出 / 排版版导出 / .stc 工程。
 */
(function () {
  const W = window.Workspace;

  // 控件在模块加载时常驻缓存，避免反复查询
  const els = {
    file: document.querySelector("#bi-file"),
    export: document.querySelector("#bi-export"),
    status: document.querySelector("#bi-status"),
    pasteArea: document.querySelector("#bi-paste-area"),
    parsePaste: document.querySelector("#bi-parse-paste"),
    list: document.querySelector("#bi-list"),
  };

  const bi = {
    translations: null, // 已导入译文 [{id, start_ms, end_ms, text}]
    pairing: null, // 后端 /api/bilingual/pair 返回的分组结果
    previewItems: [], // 当前实时预览 [{id, new_start_ms, new_end_ms, ...}]
    canExportTimeline: false, // 实时预览是否无冲突
    importSeq: 0, // 每次成功导入译文自增：此前发出的预览视为过期
    previewSeq: 0, // 当前分组所依据的预览批次（与 importSeq 对齐才允许导出）
  };
  // 译文「重导纪元」：单调递增，每次**成功**导入译文（含覆盖重导）自增；
  // 仅供第 8 步批量校订判定「预览后译文侧是否成功重导」。
  // 译文导入失败（时间倒挂 / 重叠被拒）不动此纪元，旧译文与校订保留。
  let importEpoch = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function displayText(t) {
    return escapeHtml(String(t == null ? "" : t).replace(/\n/g, " ⏎ "));
  }

  function fmtMs(ms) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
  }

  function setStatus(html, kind) {
    const el = els.status;
    el.innerHTML = html || "";
    el.classList.toggle("bad", kind === "bad");
    el.classList.toggle("good", kind === "good");
  }

  /* ================= 重置（导入新源 SRT 时由 app.js 调用） ================= */
  function reset() {
    bi.translations = null;
    bi.pairing = null;
    bi.previewItems = [];
    bi.canExportTimeline = false;
    bi.importSeq = 0;
    bi.previewSeq = 0;
    importEpoch += 1; // 译文侧整体被清空，同样视为译文重导，失效所有译文侧校订预览
    els.file.value = "";
    els.pasteArea.value = "";
    els.list.innerHTML =
      '<div class="bi-empty">导入源 SRT 后，在此选择（或粘贴）对应的译文 SRT，自动按时间区间配对分组。</div>';
    els.export.disabled = true;
    els.export.title = "";
    setStatus("", null);
  }

  function hasTranslation() {
    return Boolean(bi.translations && bi.pairing);
  }

  function fullyPaired() {
    return Boolean(
      bi.pairing &&
        !bi.pairing.unpaired_source_ids.length &&
        !bi.pairing.unpaired_translation_ids.length
    );
  }

  /* ================= 实时预览刷新（由 app.js 调用） ================= */
  function setPreview(items, canExport) {
    bi.previewItems = items || [];
    bi.canExportTimeline = Boolean(canExport);
    bi.previewSeq = bi.importSeq; // 本次预览已反映当前工作区（含最新译文导入后状态）
    render();
  }

  /* ================= 导入译文 ================= */
  async function importTranslation(content) {
    const subs = W.subtitles;
    if (!subs || !subs.length) {
      setStatus("✖ 请先在第 1 步导入源 SRT，再导入译文。", "bad");
      return;
    }
    if (!content || !content.trim()) {
      setStatus("✖ 译文内容为空。", "bad");
      return;
    }
    setStatus("正在解析并配对译文…", null);
    let parsed;
    try {
      parsed = await api("/api/parse", { content });
    } catch (e) {
      setStatus("✖ 译文 SRT 解析失败：" + escapeHtml(e.message), "bad");
      return;
    }
    let pairing;
    try {
      pairing = await api("/api/bilingual/pair", {
        subtitles: subs,
        translations: parsed.subtitles,
      });
    } catch (e) {
      // 时间倒挂 / 重叠等：拒绝导入，保留此前的配对（若有）。
      // 不重渲染列表与汇总状态，以免覆盖此处的拒绝原因。
      setStatus("✖ 译文已拒绝导入：" + escapeHtml(e.message), "bad");
      return;
    }
    bi.translations = parsed.subtitles;
    bi.pairing = pairing;
    bi.importSeq += 1; // 新配对需等下一次实时预览刷新后才允许导出
    importEpoch += 1; // 成功重导译文：译文侧批量校订纪元变化（失败路径不递增）
    render();
  }

  els.file.addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importTranslation(reader.result);
    reader.onerror = () => setStatus("✖ 译文文件读取失败", "bad");
    reader.readAsText(f, "utf-8");
  });

  els.parsePaste.addEventListener("click", () => {
    importTranslation(els.pasteArea.value);
  });

  /* ================= 渲染 ================= */
  function render() {
    updateExportButton();
    const list = els.list;

    if (!hasTranslation()) {
      if (list.innerHTML.indexOf("bi-empty") === -1) {
        list.innerHTML =
          '<div class="bi-empty">导入源 SRT 后，在此选择（或粘贴）对应的译文 SRT，自动按时间区间配对分组。</div>';
      }
      return;
    }

    const srcById = new Map(W.subtitles.map((s) => [s.id, s]));
    const trnById = new Map(bi.translations.map((t) => [t.id, t]));
    const mappedById = new Map(bi.previewItems.map((it) => [it.id, it]));

    // 按源字幕顺序遍历：组在其首个源条目处展示一次，未配对源条目穿插展示
    const groupByFirstSource = new Map();
    for (const g of bi.pairing.groups) groupByFirstSource.set(g.source_ids[0], g);
    const unpairedSrc = new Set(bi.pairing.unpaired_source_ids);

    list.innerHTML = "";
    for (const s of W.subtitles) {
      const g = groupByFirstSource.get(s.id);
      if (g) {
        list.appendChild(renderGroup(g, srcById, trnById, mappedById));
      } else if (unpairedSrc.has(s.id)) {
        list.appendChild(renderUnpairedSource(s));
      }
    }

    // 译文侧未配对条目（按译文自身顺序，单列一区）
    if (bi.pairing.unpaired_translation_ids.length) {
      const sec = document.createElement("div");
      sec.className = "bi-unpaired-trn";
      sec.innerHTML =
        '<h3>译文侧未配对条目（' +
        bi.pairing.unpaired_translation_ids.length +
        "）</h3>";
      for (const id of bi.pairing.unpaired_translation_ids) {
        const t = trnById.get(id);
        if (t) sec.appendChild(renderUnpairedTranslation(t));
      }
      list.appendChild(sec);
    }

    renderSummary();
  }

  function renderSummary() {
    const g = bi.pairing.groups.length;
    const us = bi.pairing.unpaired_source_ids.length;
    const ut = bi.pairing.unpaired_translation_ids.length;
    if (us === 0 && ut === 0) {
      setStatus(
        `✔ 已导入 ${bi.translations.length} 条译文，配对为 ${g} 组，两侧全部配对，可以导出双语 SRT。`,
        "good"
      );
    } else {
      setStatus(
        `✖ 已配对 ${g} 组；源侧 ${us} 条、译文侧 ${ut} 条未配对，禁止双语导出。`,
        "bad"
      );
    }
  }

  function entryHtml(side, id, tcText, bodyText) {
    return (
      `<div class="bi-entry bi-${side}">` +
      `<span class="bi-entry-id">#${id}</span>` +
      `<span class="bi-entry-tc tc">${tcText}</span>` +
      `<pre class="bi-entry-text">${displayText(bodyText)}</pre>` +
      `</div>`
    );
  }

  function renderGroup(group, srcById, trnById, mappedById) {
    const card = document.createElement("div");
    card.className = "bi-card bi-group";

    let gStart = null;
    let gEnd = null;
    for (const sid of group.source_ids) {
      const it = mappedById.get(sid);
      if (!it) continue;
      gStart = gStart == null ? it.new_start_ms : Math.min(gStart, it.new_start_ms);
      gEnd = gEnd == null ? it.new_end_ms : Math.max(gEnd, it.new_end_ms);
    }
    const range =
      gStart == null
        ? "预览时间待刷新"
        : `${fmtMs(gStart)} → ${fmtMs(gEnd)}`;

    const srcEntries = group.source_ids
      .map((id) => {
        const s = srcById.get(id);
        if (!s) return "";
        return entryHtml("src", id, `${fmtMs(s.start_ms)} → ${fmtMs(s.end_ms)}`, s.text);
      })
      .join("");
    const trnEntries = group.translation_ids
      .map((id) => {
        const t = trnById.get(id);
        if (!t) return "";
        return entryHtml("trn", id, `${fmtMs(t.start_ms)} → ${fmtMs(t.end_ms)}`, t.text);
      })
      .join("");

    card.innerHTML =
      `<div class="bi-group-head"><span class="bi-badge">配对组</span>` +
      `<span class="bi-group-range tc" title="组内源字幕当前校准预览的最早开始 / 最晚结束（双语导出时间）">导出时间：${range}</span></div>` +
      `<div class="bi-sides">` +
      `<div class="bi-side bi-side-src"><h4>源文（${group.source_ids.length} 条）</h4>${srcEntries}</div>` +
      `<div class="bi-side bi-side-trn"><h4>译文（${group.translation_ids.length} 条）</h4>${trnEntries}</div>` +
      `</div>`;
    return card;
  }

  function renderUnpairedSource(s) {
    const card = document.createElement("div");
    card.className = "bi-card bi-unpaired";
    card.innerHTML =
      `<div class="bi-group-head"><span class="bi-badge bi-badge-unpaired">源侧未配对</span>` +
      `<span class="bi-group-range tc">${fmtMs(s.start_ms)} → ${fmtMs(s.end_ms)}</span></div>` +
      `<pre class="bi-solo-text">${displayText(s.text)}</pre>`;
    return card;
  }

  function renderUnpairedTranslation(t) {
    const card = document.createElement("div");
    card.className = "bi-card bi-unpaired bi-unpaired-trn-card";
    card.innerHTML =
      `<div class="bi-group-head"><span class="bi-badge bi-badge-unpaired">译文未配对</span>` +
      `<span class="bi-group-range tc">${fmtMs(t.start_ms)} → ${fmtMs(t.end_ms)}</span></div>` +
      `<pre class="bi-solo-text">${displayText(t.text)}</pre>`;
    return card;
  }

  function updateExportButton() {
    const btn = els.export;
    if (!hasTranslation()) {
      btn.disabled = true;
      btn.title = "先在上方导入译文 SRT";
      return;
    }
    if (!fullyPaired()) {
      btn.disabled = true;
      btn.title = "存在未配对条目（源侧或译文侧），禁止双语导出";
      return;
    }
    if (bi.previewSeq !== bi.importSeq) {
      btn.disabled = true;
      btn.title = "导入译文后实时预览尚未刷新，请稍候";
      return;
    }
    if (!bi.canExportTimeline) {
      btn.disabled = true;
      btn.title = "实时预览存在冲突（或尚未完成预览），请先在第 4 步消除冲突";
      return;
    }
    btn.disabled = false;
    btn.title = "每组导出一条：源文 / 译文换行拼接、上下排列；时间取当前校准预览";
  }

  /* ================= 导出双语 SRT ================= */
  els.export.addEventListener("click", async () => {
    if (!hasTranslation() || !fullyPaired() || !bi.canExportTimeline) return;
    if (bi.previewSeq !== bi.importSeq) return;
    try {
      const res = await fetch("/api/bilingual/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitles: W.subtitles,
          translations: bi.translations,
          anchors: W.anchors,
          locks: W.locks,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const d = err.detail;
        let msg = "存在未配对条目或冲突";
        if (typeof d === "string") msg = d;
        else if (d && typeof d === "object") {
          if (Array.isArray(d.reasons) && d.reasons.length) msg = d.reasons.join("；");
          else if (typeof d.message === "string") msg = d.message;
        }
        alert("双语导出被拒绝：" + msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = W.fileNameBase.replace(/\.calibrated$/, "") + ".bilingual.srt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("双语导出失败：" + e.message);
    }
  });

  /* ================= 批量校订整批落地（译文侧，由 revise.js 经接口调用） ================= */
  // 只改 bi.translations 中被改条目的 text（译文编号 / 时间不动，
  // 配对只依据原始时间区间，故无需重新配对）；页面立即显示校订后正文，
  // 普通导出不受影响，双语导出使用校订后译文正文与原有配对 / 拦截。
  function applyTranslationEdits(editsById) {
    const changedIds = [];
    if (!bi.translations) return changedIds;
    for (const t of bi.translations) {
      if (editsById.has(t.id) && t.text !== editsById.get(t.id)) {
        t.text = editsById.get(t.id);
        changedIds.push(t.id);
      }
    }
    if (changedIds.length) render();
    return changedIds;
  }

  /* ================= 对外接口 ================= */
  window.BilingualUI = {
    reset,
    setPreview,
    applyTranslationEdits,
    // 译文正文读取（第 8 步预览译文侧时使用）
    getTranslations() {
      return bi.translations;
    },
    // 单调递增的译文重导纪元（仅成功导入译文时变化）
    importEpoch() {
      return importEpoch;
    },
  };

  reset();
})();
