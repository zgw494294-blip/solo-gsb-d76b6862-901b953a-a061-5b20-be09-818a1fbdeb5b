"use strict";

/* 字幕断行排版（第 6 步）—— 浏览器侧。
 *
 * 严格只做三类编辑：新增换行、删除既有换行、把一个空白替换为换行；
 * 其他字符顺序、时间轴、锚点、锁定、.stc 指纹一概不动：
 *   - 不修改 state.subtitles 中任何条目的 text；
 *   - 普通「⬇ 导出 SRT」走 app.js 原接口，保持原样；
 *   - 排版版 SRT 单独走 /api/typeset/export，且后端再做字素簇级校验；
 *   - .stc 工程保存只序列化 anchors/locks/history，与排版状态完全无关。
 */
(function () {
  const W = window.Workspace;
  const $ = (sel) => document.querySelector(sel);

  const ts = {
    columns: 18,
    maxLines: 2,
    results: null, // 后端返回的 results 数组
    accepted: new Map(), // subtitle id -> 已接受的建议正文
    snapshot: null, // 本轮生成时 accepted 的深拷贝（用于「撤销本轮」）
    canExport: false, // 当前时间轴是否无冲突
  };
  // 排版建议请求纪元：每次发起新建议请求、重置工作区或源正文被批量校订时自增；
  // 序号对不上的迟到响应一律丢弃，不得用旧正文的建议覆盖当前列表。
  let suggestSeq = 0;

  const KIND_STYLE = {
    sentence_end: { tag: "句末 0", cls: "k-sent" },
    whitespace: { tag: "空白 1", cls: "k-ws" },
    punct: { tag: "标点 2", cls: "k-punct" },
    han: { tag: "汉字间 3", cls: "k-han" },
    fallback: { tag: "既有 4", cls: "k-fb" },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // 原文里的换行 / 空格可视化
  function displayText(t) {
    return escapeHtml(String(t).replace(/\n/g, " ⏎ "));
  }

  function setStatus(html, bad) {
    const el = $("#ts-status");
    el.innerHTML = html || "";
    el.classList.toggle("bad", Boolean(bad));
    el.classList.toggle("good", Boolean(html && !bad && html.indexOf("✔") === 0));
  }

  /* ================= 重置（导入新 SRT 时由 app.js 调用） ================= */
  function reset() {
    suggestSeq += 1; // 作废此前发出、尚未返回的排版建议请求
    ts.results = null;
    ts.accepted = new Map();
    ts.snapshot = null;
    ts.canExport = false;
    $("#ts-list").innerHTML =
      '<div class="ts-empty">设置每行列数与最多行数后，点击「生成排版建议」，在此逐条对照原文与建议。</div>';
    $("#ts-accept-all").disabled = true;
    $("#ts-undo-round").disabled = true;
    $("#ts-export").disabled = true;
    setStatus("", false);
  }

  /* ================= 生成建议 ================= */
  $("#ts-generate").addEventListener("click", async () => {
    const subs = W.subtitles;
    if (!subs || !subs.length) {
      setStatus("✖ 请先在第 1 步导入 SRT。", true);
      return;
    }
    const columns = Number($("#ts-columns").value);
    const maxLines = Number($("#ts-maxlines").value);
    if (!(columns >= 12 && columns <= 30 && Number.isInteger(columns))) {
      setStatus("✖ 每行列数须为 12～30 的整数。", true);
      return;
    }
    if (!(maxLines >= 1 && maxLines <= 3 && Number.isInteger(maxLines))) {
      setStatus("✖ 最多行数须为 1～3 的整数。", true);
      return;
    }
    ts.columns = columns;
    ts.maxLines = maxLines;

    const seq = ++suggestSeq; // 新一轮建议：此前在途响应一律视为过期
    setStatus("正在计算排版建议…", false);
    let data;
    try {
      const res = await fetch("/api/typeset/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitles: subs, columns, maxLines }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (seq !== suggestSeq) return; // 迟到的失败响应：静默丢弃
        const msg = typeof data.detail === "string" ? data.detail : "请求失败";
        setStatus("✖ " + escapeHtml(msg), true);
        return;
      }
    } catch (e) {
      if (seq !== suggestSeq) return; // 迟到的网络错误：静默丢弃
      setStatus("✖ 排版请求失败：" + escapeHtml(e.message), true);
      return;
    }

    // 应用前发出的排版请求迟到（工作区已重置或源正文已被批量校订）：
    // 只丢弃响应，绝不用旧正文的建议恢复旧列表 / 旧建议。
    if (seq !== suggestSeq) return;

    ts.results = data.results;
    // 新一轮：拍快照（已接受的换行若新建议与其不一致会在列表中标出，可重新接受）
    ts.snapshot = new Map(ts.accepted);
    setStatus(
      `✔ 共 ${data.total} 条：${data.change_count} 条建议换行、` +
        `${data.infeasible_count} 条无解；可逐条接受或「全部接受」。`,
      false
    );
    render();
  });

  /* ================= 接受 / 撤销 ================= */
  function acceptOne(id) {
    const r = resultById(id);
    if (!r || !r.feasible) return;
    ts.accepted.set(id, r.text);
    render();
  }

  function revertOne(id) {
    ts.accepted.delete(id);
    render();
  }

  $("#ts-accept-all").addEventListener("click", () => {
    if (!ts.results) return;
    let n = 0;
    for (const r of ts.results) {
      if (r.feasible && r.changed) {
        ts.accepted.set(r.id, r.text);
        n++;
      }
    }
    setStatus(`✔ 已全部接受（本轮 ${n} 条换行建议生效）。`, false);
    render();
  });

  $("#ts-undo-round").addEventListener("click", () => {
    if (!ts.snapshot) return;
    const n = ts.accepted.size;
    ts.accepted = new Map(ts.snapshot);
    setStatus(`↩ 已撤销本轮全部接受结果（恢复 ${n - ts.accepted.size} 条）。`, false);
    render();
  });

  /* ================= 渲染 ================= */
  function resultById(id) {
    return ts.results ? ts.results.find((r) => r.id === id) : null;
  }

  function render() {
    const list = $("#ts-list");
    const hasResults = Boolean(ts.results);
    const subs = W.subtitles || [];

    // 主表格上的 📐 标记与当前接受状态保持一致
    for (const s of subs) W.markTypeset(s.id, ts.accepted.has(s.id));

    if (!hasResults && !ts.accepted.size) {
      list.innerHTML =
        '<div class="ts-empty">设置每行列数与最多行数后，点击「生成排版建议」，在此逐条对照原文与建议。</div>';
    } else if (!hasResults) {
      list.innerHTML =
        '<div class="ts-empty">已接受的换行仍在（字幕表带 📐 标记）；重新「生成排版建议」后可继续调整。</div>';
    } else {
      const byId = new Map(ts.results.map((r) => [r.id, r]));
      list.innerHTML = "";
      for (const s of subs) {
        list.appendChild(renderCard(s, byId.get(s.id)));
      }
    }

    const pendingChange = ts.results
      ? ts.results.filter((r) => r.feasible && r.changed && ts.accepted.get(r.id) !== r.text)
      : [];
    $("#ts-accept-all").disabled = !pendingChange.length;
    $("#ts-undo-round").disabled = !ts.snapshot;
    $("#ts-export").disabled = !ts.accepted.size || !ts.canExport;
    $("#ts-export").title = ts.canExport
      ? "导出时间轴映射后、仅写入已接受换行的 SRT"
      : "当前时间轴存在冲突（或未导入 SRT），请先在第 4 步消除冲突";
  }

  function breaksHtml(r) {
    if (!r.breaks.length) return '<span class="ts-no-break">（无断点）</span>';
    return r.breaks
      .map((b) => {
        const st = KIND_STYLE[b.kind] || { tag: b.kind, cls: "" };
        const ctx = `${b.left ? escapeHtml(b.left) : "␂"}↓${b.right ? escapeHtml(b.right) : "␃"}`;
        return `<span class="ts-brk ${st.cls}" title="字素簇边界 #${b.boundary} · 罚分 ${b.penalty}${b.existing ? " · 既有换行" : ""}">${ctx} <em>${escapeHtml(st.tag)}</em>${b.existing ? " ·既有" : ""}</span>`;
      })
      .join("");
  }

  function renderCard(s, r) {
    const card = document.createElement("div");
    const acceptedText = ts.accepted.get(s.id);
    let headCls = "ts-card";
    let status;
    if (r && !r.feasible) {
      headCls += " ts-infeasible";
      status = '<span class="ts-state bad">✖ 无解</span>';
    } else if (acceptedText != null) {
      headCls += " ts-accepted";
      const stale = r && r.feasible && acceptedText !== r.text;
      status = stale
        ? '<span class="ts-state warn">📐 已接受（与当前建议不一致）</span>'
        : '<span class="ts-state ok">📐 已接受</span>';
    } else if (r && r.feasible && r.changed) {
      headCls += " ts-suggested";
      status = '<span class="ts-state">建议中</span>';
    } else {
      status = '<span class="ts-state muted">无需改动</span>';
    }
    card.className = headCls;

    let body;
    if (!r) {
      body = `<div class="ts-pair"><div class="ts-orig"><h4>原文</h4><pre>${displayText(s.text)}</pre></div></div>`;
    } else if (!r.feasible) {
      body =
        `<div class="ts-pair"><div class="ts-orig"><h4>原文</h4><pre>${displayText(s.text)}</pre></div>` +
        `<div class="ts-prop"><h4>无解原因</h4><ul class="ts-reasons">${r.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div></div>`;
    } else {
      const lines = r.lines
        .map((ln, i) => `<div class="ts-line"><span class="ts-w">${r.widths[i]}</span><pre>${escapeHtml(ln)}</pre></div>`)
        .join("");
      body =
        `<div class="ts-pair">` +
        `<div class="ts-orig"><h4>原文</h4><pre>${displayText(s.text)}</pre></div>` +
        `<div class="ts-prop"><h4>建议（罚分 ${r.total_penalty} · 剩余² ${r.residual_sq} · ${r.lines.length} 行）</h4>` +
        `<div class="ts-lines">${lines}</div>` +
        `<div class="ts-breaks">${breaksHtml(r)}</div></div></div>`;
    }

    const actions =
      `<div class="ts-actions">` +
      (r && r.feasible && r.changed
        ? `<button class="btn ts-accept">✔ 接受此条</button>`
        : "") +
      (acceptedText != null
        ? `<button class="btn secondary ts-revert">↩ 恢复原文</button>`
        : "") +
      `</div>`;

    card.innerHTML =
      `<div class="ts-head"><span class="ts-id">#${s.id}</span>${status}</div>` +
      body +
      actions;
    const acceptBtn = card.querySelector(".ts-accept");
    if (acceptBtn) acceptBtn.addEventListener("click", () => acceptOne(s.id));
    const revertBtn = card.querySelector(".ts-revert");
    if (revertBtn) revertBtn.addEventListener("click", () => revertOne(s.id));
    return card;
  }

  /* ================= 下载排版版 SRT ================= */
  $("#ts-export").addEventListener("click", async () => {
    if (!ts.accepted.size) return;
    const subs = W.subtitles;
    const payload = {
      subtitles: subs.map((s) => {
        const acc = ts.accepted.get(s.id);
        return {
          id: s.id,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text: acc != null ? acc : s.text,
          original_text: s.text,
        };
      }),
      anchors: W.anchors,
      locks: W.locks,
    };
    try {
      const res = await fetch("/api/typeset/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert("排版版导出被拒绝：" + (typeof err.detail === "string" ? err.detail : "存在冲突或排版不合法"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = W.fileNameBase.replace(/\.calibrated$/, "") + ".typeset.srt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(
        `✔ 已下载排版版 SRT（写入 ${ts.accepted.size} 条已接受换行；其余条目原样）。普通导出不受影响。`,
        false
      );
    } catch (e) {
      alert("排版版导出失败：" + e.message);
    }
  });

  /* ================= 源正文被批量校订后的清理（由 app.js 调用） ================= */
  // 只清除「被改源字幕」的排版建议、已接受换行及本轮排版撤销快照；
  // 其他条目一律保留。撤销快照同步清除，保证「撤销本轮」绝不能复活旧正文。
  function purgeSourceEdits(changedIds) {
    const changed = new Set(changedIds || []);
    if (!changed.size) return [];
    suggestSeq += 1; // 在途的迟到建议请求按旧正文算出，必须作废
    for (const id of changed) {
      ts.accepted.delete(id);
      if (ts.snapshot) ts.snapshot.delete(id);
      W.markTypeset(id, false);
    }
    if (ts.results) {
      ts.results = ts.results.filter((r) => !changed.has(r.id));
      if (!ts.results.length) ts.results = null;
    }
    if (ts.snapshot && !ts.snapshot.size) ts.snapshot = null;
    render();
    return [...changed];
  }

  /* ================= 对外接口 ================= */
  window.TypesetUI = {
    reset,
    purgeSourceEdits,
    setCanExport(ok) {
      ts.canExport = Boolean(ok);
      render();
    },
  };

  reset();
})();
