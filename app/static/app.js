"use strict";

/* ================= 状态 ================= */
const state = {
  subtitles: [], // {id, start_ms, end_ms, text}
  anchors: [], // {id, subtitle_id, original_ms, target_ms}
  locks: new Set(), // 锁定的字幕 id
  history: [], // 锚点/锁定操作快照，用于撤销
  anchorSeq: 1,
  anchorFormSubId: null,
  fileName: "calibrated.srt",
  rawContent: "", // 当前导入的原始 SRT 文本（含 BOM/CRLF 原样），用于工程摘要
  sourceSha: "", // 当前 SRT 的 SHA-256（由后端返回，展示用）
};

const rowEls = new Map(); // 字幕 id -> 行元素
let previewSeq = 0; // 防止预览响应乱序覆盖

const $ = (sel) => document.querySelector(sel);

/* ================= 工具 ================= */
function fmtMs(ms) {
  const sign = ms < 0 ? "-" : "";
  ms = Math.abs(Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

// 支持 HH:MM:SS,mmm / HH:MM:SS.mmm / MM:SS.mmm / 纯秒数
function parseTimeInput(str) {
  str = (str || "").trim();
  if (!str) return null;
  let m = str.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (m) {
    const [, h, mm, ss, ms] = m;
    if (+mm >= 60 || +ss >= 60) return null;
    return ((+h) * 3600 + (+mm) * 60 + +ss) * 1000 + (ms ? +ms.padEnd(3, "0") : 0);
  }
  m = str.match(/^(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (m) {
    const [, mm, ss, ms] = m;
    if (+mm >= 60 || +ss >= 60) return null;
    return ((+mm) * 60 + +ss) * 1000 + (ms ? +ms.padEnd(3, "0") : 0);
  }
  m = str.match(/^\d+(?:[,.]\d+)?$/);
  if (m) return Math.round(parseFloat(str.replace(",", ".")) * 1000);
  return null;
}

async function api(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(extractError(data));
  }
  return data;
}

// FastAPI 错误 detail 可能是字符串，也可能是 {code, message, reasons[]}
function extractError(data) {
  const d = data.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object") {
    if (Array.isArray(d.reasons) && d.reasons.length) return d.reasons.join("；");
    if (typeof d.message === "string") return d.message;
  }
  return "请求失败";
}

/* ================= 导入 ================= */
function snapshotState() {
  return {
    anchors: state.anchors.map((a) => ({ ...a })),
    locks: [...state.locks],
  };
}

function resetWorkspace(content, name) {
  state.anchors = [];
  state.locks = new Set();
  state.history = [];
  state.anchorSeq = 1;
  state.anchorFormSubId = null;
  state.rawContent = content;
  state.sourceSha = "";
  state.fileName = name
    ? name.replace(/\.[^.]+$/, "") + ".calibrated.srt"
    : "calibrated.srt";
  hideProjectPanel();
  // 新 SRT 与旧音频不再匹配：重置对白覆盖审计（含已导入的本地音频）
  if (window.AuditUI) window.AuditUI.reset();
  // 排版建议/已接受换行同样只对旧 SRT 有意义：一并重置
  if (window.TypesetUI) window.TypesetUI.reset();
  // 双语配对基于当前源 SRT 的原始时间区间：重新导入源 SRT 清空旧配对
  if (window.BilingualUI) window.BilingualUI.reset();
}

async function importContent(content, name) {
  try {
    const data = await api("/api/parse", { content });
    state.subtitles = data.subtitles;
    resetWorkspace(content, name);
    state.sourceSha = data.sha256 || "";
    $("#workspace").classList.remove("hidden");
    $("#anchor-form").classList.add("hidden");
    $("#import-status").textContent = `✔ 已导入 ${data.count} 条字幕`;
    renderTable();
    renderAnchors();
    updateUndoBtn();
    await refreshPreview();
  } catch (e) {
    $("#import-status").textContent = "✖ 导入失败：" + e.message;
  }
}

$("#file-input").addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => importContent(reader.result, f.name);
  reader.onerror = () => ($("#import-status").textContent = "✖ 文件读取失败");
  reader.readAsText(f, "utf-8");
});

$("#parse-paste").addEventListener("click", () => {
  const text = $("#paste-area").value;
  if (!text.trim()) {
    $("#import-status").textContent = "✖ 请先粘贴 SRT 内容";
    return;
  }
  importContent(text, null);
});

$("#load-sample").addEventListener("click", () => {
  importContent(SAMPLE_SRT, "sample.srt");
});

const SAMPLE_SRT = `1
00:00:01,200 --> 00:00:03,500
远方的鼓声渐渐响起。

2
00:00:04,000 --> 00:00:06,800
她回头望了一眼来时的路。

3
00:00:07,500 --> 00:00:10,000
风从山谷里穿过，带着雨的气息。

4
00:00:11,000 --> 00:00:13,500
「我们走吧。」他说。

5
00:00:14,200 --> 00:00:17,000
灯火在河的彼岸次第亮起。
`;

/* ================= 字幕表格 ================= */
function renderTable() {
  const tbody = $("#sub-tbody");
  tbody.innerHTML = "";
  rowEls.clear();
  for (const s of state.subtitles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${s.id}</td>
      <td class="tc">${fmtMs(s.start_ms)}</td>
      <td class="tc">${fmtMs(s.end_ms)}</td>
      <td class="tc new-start">—</td>
      <td class="tc new-end">—</td>
      <td class="text"></td>
      <td class="ops">
        <button class="anchor-btn" title="在此字幕上设置校准锚点">⚑ 锚点</button>
        <button class="lock-btn" title="锁定后保留原时间，不参与映射">🔒 锁定</button>
      </td>`;
    tr.querySelector(".text").textContent = s.text.replace(/\n/g, " ⏎ ");
    tr.querySelector(".anchor-btn").addEventListener("click", () => openAnchorForm(s.id));
    tr.querySelector(".lock-btn").addEventListener("click", () => toggleLock(s.id));
    tbody.appendChild(tr);
    rowEls.set(s.id, tr);
  }
}

/* ================= 预览 ================= */
async function refreshPreview() {
  if (!state.subtitles.length) return;
  const seq = ++previewSeq;
  let data;
  try {
    data = await api("/api/preview", {
      subtitles: state.subtitles,
      anchors: state.anchors,
      locks: [...state.locks],
    });
  } catch (e) {
    setConflictStatus("预览请求失败：" + e.message, false);
    return;
  }
  if (seq !== previewSeq) return; // 已有更新的请求发出，丢弃本次结果

  const conflictSubs = new Set(data.conflicts.flatMap((c) => c.subtitle_ids));
  const anchorSubs = new Set(state.anchors.map((a) => a.subtitle_id));
  const byId = new Map(data.items.map((it) => [it.id, it]));

  for (const s of state.subtitles) {
    const tr = rowEls.get(s.id);
    const it = byId.get(s.id);
    tr.querySelector(".new-start").textContent = fmtMs(it.new_start_ms);
    tr.querySelector(".new-end").textContent = fmtMs(it.new_end_ms);
    tr.classList.toggle("locked", it.locked);
    tr.classList.toggle("conflict", conflictSubs.has(s.id));
    tr.classList.toggle("has-anchor", anchorSubs.has(s.id));
    tr.querySelector(".lock-btn").textContent = it.locked ? "🔓 解锁" : "🔒 锁定";
  }

  renderConflicts(data.conflicts);
  $("#export-btn").disabled = !data.can_export;
  if (window.TypesetUI) window.TypesetUI.setCanExport(data.can_export);
  // 双语导出同样受实时预览冲突拦截，且导出区间取当前预览时间
  if (window.BilingualUI) window.BilingualUI.setPreview(data.items, data.can_export);

  // 把当前实时预览时间轴同步给「对白覆盖审计」（锚点/锁定变化后自动重算）
  const textById = {};
  for (const s of state.subtitles) textById[s.id] = s.text;
  if (window.AuditUI) window.AuditUI.setTimeline(data.items, textById, state.sourceSha);
  const n = data.anchor_count;
  if (data.mapping_enabled) {
    $("#mapping-status").textContent = `分段线性映射已启用（${n} 个锚点）`;
  } else if (n >= 2) {
    $("#mapping-status").textContent = "锚点原时间重复，映射未启用（当前显示原始时间）";
  } else {
    $("#mapping-status").textContent = `已设 ${n} 个锚点，再设 ${2 - n} 个启用映射（当前显示原始时间）`;
  }
}

function renderConflicts(conflicts) {
  const ul = $("#conflict-list");
  ul.innerHTML = "";
  if (!conflicts.length) {
    const li = document.createElement("li");
    li.className = "ok";
    li.textContent = "✔ 无冲突，可以导出。";
    ul.appendChild(li);
    setConflictStatus("✔ 无冲突", true);
    return;
  }
  for (const c of conflicts) {
    const li = document.createElement("li");
    li.className = "conflict-item";
    li.textContent = "⚠ " + c.message;
    ul.appendChild(li);
  }
  setConflictStatus(`⚠ ${conflicts.length} 处冲突，已禁止导出`, false);
}

function setConflictStatus(text, ok) {
  const el = $("#conflict-status");
  el.textContent = text;
  el.classList.toggle("good", ok);
  el.classList.toggle("bad", !ok);
}

/* ================= 锚点 ================= */
function openAnchorForm(subId) {
  const s = state.subtitles.find((x) => x.id === subId);
  if (!s) return;
  state.anchorFormSubId = subId;
  $("#af-sub").textContent = `#${subId}`;
  $("#af-original").value = fmtMs(s.start_ms);
  $("#af-target").value = fmtMs(s.start_ms);
  $("#anchor-form").classList.remove("hidden");
  const target = $("#af-target");
  target.focus();
  target.select();
}

function closeAnchorForm() {
  state.anchorFormSubId = null;
  $("#anchor-form").classList.add("hidden");
}

$("#anchor-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const subId = state.anchorFormSubId;
  if (subId == null) return;
  const orig = parseTimeInput($("#af-original").value);
  const tgt = parseTimeInput($("#af-target").value);
  if (orig == null || tgt == null) {
    alert("时间格式无效，请使用 HH:MM:SS,mmm（也支持 MM:SS.mmm 或纯秒数）");
    return;
  }
  pushHistory();
  state.anchors.push({
    id: state.anchorSeq++,
    subtitle_id: subId,
    original_ms: orig,
    target_ms: tgt,
  });
  closeAnchorForm();
  renderAnchors();
  refreshPreview();
});

$("#af-cancel").addEventListener("click", closeAnchorForm);

function removeAnchor(id) {
  pushHistory();
  state.anchors = state.anchors.filter((a) => a.id !== id);
  renderAnchors();
  refreshPreview();
}

function renderAnchors() {
  const ul = $("#anchor-list");
  ul.innerHTML = "";
  if (!state.anchors.length) {
    ul.innerHTML = `<li class="empty">尚未设置锚点。在字幕行点击「⚑ 锚点」添加。</li>`;
    return;
  }
  const sorted = [...state.anchors].sort((a, b) => a.original_ms - b.original_ms);
  for (const a of sorted) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="anchor-label">字幕 #${a.subtitle_id}</span>
      <span class="tc">${fmtMs(a.original_ms)}</span>
      <span>→</span>
      <span class="tc">${fmtMs(a.target_ms)}</span>
      <button class="del" title="删除此锚点">✕</button>`;
    li.querySelector(".del").addEventListener("click", () => removeAnchor(a.id));
    ul.appendChild(li);
  }
}

/* ================= 锁定 ================= */
function toggleLock(subId) {
  pushHistory();
  if (state.locks.has(subId)) state.locks.delete(subId);
  else state.locks.add(subId);
  refreshPreview();
}

/* ================= 撤销 ================= */
function pushHistory() {
  state.history.push(snapshotState());
  updateUndoBtn();
}

function updateUndoBtn() {
  $("#undo-btn").disabled = state.history.length === 0;
}

$("#undo-btn").addEventListener("click", () => {
  const snap = state.history.pop();
  if (!snap) return;
  state.anchors = snap.anchors;
  state.locks = new Set(snap.locks);
  state.anchorSeq = Math.max(0, ...state.anchors.map((a) => a.id)) + 1;
  renderAnchors();
  updateUndoBtn();
  refreshPreview();
});

/* ================= 导出 ================= */
$("#export-btn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subtitles: state.subtitles,
        anchors: state.anchors,
        locks: [...state.locks],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("导出被拒绝：" + (typeof err.detail === "string" ? err.detail : "存在冲突"));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("导出失败：" + e.message);
  }
});

/* ================= .stc 校准工程（跨会话） ================= */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function hideProjectPanel() {
  $("#project-panel").classList.add("hidden");
}

function showProjectPanel(kind, title, bodyHtml) {
  const panel = $("#project-panel");
  panel.classList.remove("hidden", "ok", "err");
  panel.classList.add(kind);
  $("#project-panel-title").textContent = title;
  $("#project-panel-body").innerHTML = bodyHtml;
}

function saveHistoryPayload() {
  return state.history.map((snap) => ({
    anchors: snap.anchors.map((a) => ({ ...a })),
    locks: [...snap.locks],
  }));
}

$("#project-save").addEventListener("click", async () => {
  if (!state.subtitles.length) return;
  let project;
  try {
    project = await api("/api/project/save", {
      content: state.rawContent,
      anchors: state.anchors,
      locks: [...state.locks],
      history: saveHistoryPayload(),
      anchor_seq: state.anchorSeq,
      saved_at: new Date().toISOString(),
    });
  } catch (e) {
    showProjectPanel(
      "err",
      "✖ 工程保存失败",
      `<ul class="project-reasons"><li>${escapeHtml(e.message)}</li></ul>`
    );
    return;
  }
  const blob = new Blob([JSON.stringify(project, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.fileName.replace(/\.srt$/i, "") + ".stc";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showProjectPanel(
    "ok",
    "💾 工程已保存（.stc）",
    `<div class="project-modes">SHA-256：<code>${project.source.sha256.slice(0, 16)}…</code> ·
       ${project.source.subtitle_count} 条字幕 · ${project.anchors.length} 个锚点 ·
       ${project.locks.length} 项锁定 · 撤销栈 ${project.history.length} 层。
       下次打开时先导入同一 SRT，再打开本工程即可恢复。</div>`
  );
});

function mappingTableHtml(mapping) {
  const rows = mapping
    .map((m) => {
      const renum = m.old_id !== m.new_id;
      const tags = (m.referenced_by || [])
        .map((t) => `<span>${escapeHtml(t)}</span>`)
        .join("");
      return `<tr class="${renum ? "renum" : ""}">
        <td class="num old">${m.old_id}</td>
        <td class="arrow">→</td>
        <td class="num">${m.new_id}</td>
        <td class="tc">${fmtMs(m.start_ms)} → ${fmtMs(m.end_ms)}</td>
        <td class="text">${escapeHtml((m.text || "").replace(/\n/g, " ⏎ "))}</td>
        <td class="tags">${tags}</td>
      </tr>`;
    })
    .join("");
  return `<div class="mapping-wrap"><table class="mapping-table">
    <thead><tr><th>旧编号</th><th></th><th>新编号</th><th>时间（毫秒映射）</th><th>正文</th><th>引用</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

$("#project-input").addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  ev.target.value = ""; // 允许再次选择同一文件
  if (!f) return;
  if (!state.subtitles.length) {
    showProjectPanel(
      "err",
      "✖ 工程恢复被拒绝（当前工作区未改变）",
      `<ul class="project-reasons"><li>请先在第 1 步导入（或粘贴）当前 SRT，再打开 .stc 工程。</li></ul>`
    );
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    let project;
    try {
      project = JSON.parse(reader.result);
    } catch (e) {
      showProjectPanel(
        "err",
        "✖ 工程恢复被拒绝（当前工作区未改变）",
        `<ul class="project-reasons"><li>工程文件不是合法 JSON：${escapeHtml(e.message)}</li></ul>`
      );
      return;
    }
    let res;
    try {
      const r = await fetch("/api/project/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: state.rawContent, project }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const d = data.detail || {};
        const msg = typeof d === "string" ? d : d.message || "请求失败";
        const reasons = typeof d === "object" && Array.isArray(d.reasons) ? d.reasons : [msg];
        showProjectPanel(
          "err",
          "✖ 工程恢复被拒绝（当前工作区未改变）",
          `<div class="project-modes">${escapeHtml(msg)}</div>
           <ul class="project-reasons">${reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
        );
        return;
      }
      res = data;
    } catch (e) {
      showProjectPanel(
        "err",
        "✖ 工程恢复请求失败（当前工作区未改变）",
        `<ul class="project-reasons"><li>${escapeHtml(e.message)}</li></ul>`
      );
      return;
    }

    // —— 校验通过后才落地到工作区 ——
    state.anchors = res.anchors;
    state.locks = new Set(res.locks);
    state.history = res.history.map((snap) => ({
      anchors: snap.anchors.map((a) => ({ ...a })),
      locks: [...snap.locks],
    }));
    state.anchorSeq = res.anchor_seq || 1;
    state.anchorFormSubId = null;
    $("#anchor-form").classList.add("hidden");
    renderTable();
    renderAnchors();
    updateUndoBtn();
    // 工程恢复/迁移只改变锚点/锁定/撤销栈；排版接受状态与旧条目绑定，予以清空
    if (window.TypesetUI) window.TypesetUI.reset();
    await refreshPreview();

    const renumCount = res.mapping.filter((m) => m.old_id !== m.new_id).length;
    if (res.mode === "identical") {
      showProjectPanel(
        "ok",
        "✔ 原文件恢复完成",
        `<div class="project-summary">SHA-256 与工程一致，编号未改动：` +
          `${res.anchors.length} 个锚点、${res.locks.length} 项锁定、撤销栈 ${res.history.length} 层已恢复。</div>` +
          mappingTableHtml(res.mapping)
      );
    } else {
      showProjectPanel(
        "ok",
        "✔ 工程已按条目指纹迁移到当前 SRT",
        `<div class="project-summary warn">当前 SRT 与工程来源的 SHA-256 不同，` +
          `未沿用任何旧编号；${res.mapping.length} 条被引用字幕全部唯一匹配` +
          `（其中 ${renumCount} 条编号变化），锚点 / 锁定 / 撤销栈已按映射迁移。</div>` +
          mappingTableHtml(res.mapping)
      );
    }
  };
  reader.onerror = () =>
    showProjectPanel(
      "err",
      "✖ 工程文件读取失败",
      `<ul class="project-reasons"><li>浏览器读取该文件失败。</li></ul>`
    );
  reader.readAsText(f, "utf-8");
});

/* ================= 供「字幕断行排版」模块调用的工作区接口 =================
 * 排版状态（建议、已接受换行、本轮撤销栈）完全由 typeset.js 自管；
 * 这里只暴露只读工作区数据，避免它直接改动 state。
 */
window.Workspace = {
  get subtitles() {
    return state.subtitles;
  },
  get anchors() {
    return state.anchors;
  },
  get locks() {
    return [...state.locks];
  },
  get fileNameBase() {
    return state.fileName.replace(/\.srt$/i, "");
  },
  // 在字幕表正文格打 / 去排版标记
  markTypeset(subId, on) {
    const tr = rowEls.get(subId);
    if (!tr) return;
    const td = tr.querySelector(".text");
    if (!td) return;
    td.classList.toggle("typeset", Boolean(on));
    const mark = td.querySelector(".ts-badge");
    if (on && !mark) {
      const b = document.createElement("span");
      b.className = "ts-badge";
      b.title = "已接受断行排版（普通导出不包含，需在第 6 步下载排版版 SRT）";
      b.textContent = "📐";
      td.insertBefore(b, td.firstChild);
    } else if (!on && mark) {
      mark.remove();
    }
  },
};
