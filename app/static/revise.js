"use strict";

/* 批量校订正文（第 8 步）—— 浏览器侧，纯内存，不发起任何网络请求。
 *
 * 规则：
 *   - 输入非空查找词、替换文本（可为空 = 删除命中），选择源文 / 译文 / 两者；
 *   - 在当前正文中按**区分大小写的字面量**、从左至右替换**不重叠命中**；
 *     查找词与替换文本均不得含换行（不跨行校订）；
 *   - 先逐条列出修改前后文本，确认后「整批应用」一次性落地；
 *   - 预览后若任一侧成功重新导入、或待改正文发生变化，拒绝整批应用且不改工作区；
 *     仅锚点 / 锁定变化不影响待改正文，仍可应用；
 *   - 只改正文：不改时间、编号、锚点、锁定，不改原始 SRT 摘要与 .stc 指纹；
 *   - 校订仅存内存：.stc 不保存校订，恢复工程不回退当前正文；
 *     成功重导源文由 app.js 清空两侧校订（reset），译文重导仅令译文侧 epoch 变化。
 */
(function () {
  const W = window.Workspace;

  const els = {
    find: document.querySelector("#rv-find"),
    replace: document.querySelector("#rv-replace"),
    side: document.querySelector("#rv-side"),
    preview: document.querySelector("#rv-preview"),
    apply: document.querySelector("#rv-apply"),
    cancel: document.querySelector("#rv-cancel"),
    status: document.querySelector("#rv-status"),
    list: document.querySelector("#rv-list"),
  };

  // pending：一次已预览、待确认的整批校订
  // {find, replacement, side, sourceEpoch, importEpoch,
  //  source: [{id, before, after, count}], translation: [...],
  //  sourceTexts: Map(id->before), trnTexts: Map(id->before)}
  const rv = { pending: null };

  const EMPTY_HTML =
    '<div class="rv-empty">输入查找词（与替换文本）、选择校订侧后点「预览修改」，' +
    "在此逐条确认修改前后文本，确认后整批应用。</div>";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // 正文中的换行可视化
  function displayText(t) {
    return escapeHtml(String(t == null ? "" : t).replace(/\n/g, " ⏎ "));
  }

  function setStatus(html, kind) {
    const el = els.status;
    el.innerHTML = html || "";
    el.classList.toggle("bad", kind === "bad");
    el.classList.toggle("good", kind === "good");
  }

  /* ================= 字面量替换 =================
   * 区分大小写；String.prototype.split(字符串) 恰好给出从左至右、互不重叠的
   * 字面量切分（不是正则，$ 等字符也无特殊含义），再以替换文本 join。
   */
  function literalReplaceAll(text, find, replacement) {
    if (!find) return { text, count: 0 };
    const parts = text.split(find);
    return { text: parts.join(replacement), count: parts.length - 1 };
  }

  function buildEntries(subs, find, replacement) {
    const entries = [];
    for (const s of subs) {
      const before = String(s.text == null ? "" : s.text);
      const r = literalReplaceAll(before, find, replacement);
      if (r.count > 0 && r.text !== before) {
        entries.push({ id: s.id, before, after: r.text, count: r.count });
      }
    }
    return entries;
  }

  function snapshotTexts(subs) {
    const m = new Map();
    for (const s of subs) m.set(s.id, String(s.text == null ? "" : s.text));
    return m;
  }

  /* ================= 预览 ================= */
  els.preview.addEventListener("click", () => {
    const find = els.find.value;
    const replacement = els.replace.value;
    const side = els.side.value;

    if (find.length === 0) {
      rv.pending = null;
      render();
      setStatus("✖ 查找词不能为空。", "bad");
      return;
    }
    if (find.includes("\n") || find.includes("\r")) {
      rv.pending = null;
      render();
      setStatus("✖ 查找词不得含换行（批量校订不跨行）。", "bad");
      return;
    }
    if (replacement.includes("\n") || replacement.includes("\r")) {
      rv.pending = null;
      render();
      setStatus("✖ 替换文本不得含换行（批量校订不跨行）。", "bad");
      return;
    }

    const useSource = side === "source" || side === "both";
    const useTranslation = side === "translation" || side === "both";
    const srcSubs = W.subtitles || [];
    // 译文由第 7 步 bilingual.js 自管，经其只读接口读取
    const trnSubs = useTranslation
      ? (window.BilingualUI && window.BilingualUI.getTranslations
          ? window.BilingualUI.getTranslations()
          : null)
      : null;

    if (!srcSubs.length) {
      rv.pending = null;
      render();
      setStatus("✖ 请先在第 1 步导入源 SRT，再批量校订。", "bad");
      return;
    }
    if (useTranslation && (!trnSubs || !trnSubs.length)) {
      rv.pending = null;
      render();
      setStatus(
        "✖ 尚未导入译文：请先在第 7 步导入译文 SRT，或把校订侧改为「仅源文」。",
        "bad"
      );
      return;
    }

    const sourceEntries = useSource ? buildEntries(srcSubs, find, replacement) : [];
    const trnEntries = useTranslation ? buildEntries(trnSubs, find, replacement) : [];

    if (!sourceEntries.length && !trnEntries.length) {
      rv.pending = null;
      render();
      setStatus(
        `当前${useSource && useTranslation ? "源文 / 译文" : useTranslation ? "译文" : "源文"}` +
          `正文中没有命中「${escapeHtml(find)}」，没有可校订的条目。`,
        null
      );
      return;
    }

    rv.pending = {
      find,
      replacement,
      side,
      // 捕获两侧「重导纪元」：预览后任一侧成功重导都会使纪元变化
      sourceEpoch: W.sourceEpoch || 0,
      importEpoch: W.importEpoch || 0,
      source: sourceEntries,
      translation: trnEntries,
      sourceTexts: snapshotTexts(srcSubs),
      trnTexts: snapshotTexts(trnSubs || []),
    };
    render();

    const sums = [];
    if (sourceEntries.length) {
      const hits = sourceEntries.reduce((n, e) => n + e.count, 0);
      sums.push(`源文 ${sourceEntries.length} 条 / ${hits} 处命中`);
    }
    if (trnEntries.length) {
      const hits = trnEntries.reduce((n, e) => n + e.count, 0);
      sums.push(`译文 ${trnEntries.length} 条 / ${hits} 处命中`);
    }
    setStatus(
      "✔ 预览：" + sums.join("、") + "。请逐条核对修改前后文本，确认后点「整批应用」；" +
        "预览后若任一侧成功重导或待改正文变化，整批应用将被拒绝。",
      "good"
    );
  });

  /* ================= 整批应用 ================= */
  function rejectPending(reasons) {
    rv.pending = null;
    render();
    setStatus(
      "✖ 已拒绝整批应用，工作区未做任何改动：" + reasons.join("；") +
        "。请重新预览后再应用。",
      "bad"
    );
  }

  function checkTexts(entries, currentSubs, label, snapshot, reasons) {
    if (!entries.length) return;
    const byId = new Map((currentSubs || []).map((s) => [s.id, s]));
    for (const e of entries) {
      const cur = byId.get(e.id);
      if (!cur) {
        reasons.push(`${label} #${e.id} 在预览后已不存在`);
      } else if (String(cur.text == null ? "" : cur.text) !== snapshot.get(e.id)) {
        reasons.push(`${label} #${e.id} 的待改正文在预览后已变化`);
      }
    }
  }

  els.apply.addEventListener("click", () => {
    const p = rv.pending;
    if (!p) return;

    // —— 落地前全部校验：任一不满足都不得改动工作区 ——
    const reasons = [];
    if ((W.sourceEpoch || 0) !== p.sourceEpoch) {
      reasons.push("预览后源文侧已成功重新导入");
    }
    if ((W.importEpoch || 0) !== p.importEpoch) {
      reasons.push("预览后译文侧已成功重新导入");
    }
    checkTexts(p.source, W.subtitles || [], "源文", p.sourceTexts, reasons);
    const currentTrn =
      window.BilingualUI && window.BilingualUI.getTranslations
        ? window.BilingualUI.getTranslations()
        : null;
    checkTexts(p.translation, currentTrn || [], "译文", p.trnTexts, reasons);
    if (reasons.length) {
      rejectPending(reasons);
      return;
    }

    // —— 校验通过，整批落地（源文侧落地会刷新字幕表 / 排版状态 / 实时预览）——
    const srcEdits = new Map();
    for (const e of p.source) srcEdits.set(e.id, e.after);
    const trnEdits = new Map();
    for (const e of p.translation) trnEdits.set(e.id, e.after);

    let changedSrc = [];
    let changedTrn = [];
    if (p.source.length) changedSrc = W.applySourceEdits(srcEdits) || [];
    if (p.translation.length && window.BilingualUI && window.BilingualUI.applyTranslationEdits) {
      changedTrn = window.BilingualUI.applyTranslationEdits(trnEdits) || [];
    }

    rv.pending = null;
    render();
    const sums = [];
    if (changedSrc.length) sums.push(`源文 ${changedSrc.length} 条`);
    if (changedTrn.length) sums.push(`译文 ${changedTrn.length} 条`);
    setStatus(
      "✔ 已整批应用校订（" + (sums.join("、") || "无改动") +
        "）。校订仅保存在内存中：页面与普通 / 排版版 / 双语下载均使用校订后正文，" +
        "不写入 .stc 工程，恢复工程也不会回退当前正文。",
      "good"
    );
  });

  els.cancel.addEventListener("click", () => {
    if (!rv.pending) return;
    rv.pending = null;
    render();
    setStatus("已取消本次预览，正文未做任何改动。", null);
  });

  /* ================= 重置（重新导入源 SRT 时由 app.js 调用） ================= */
  function reset(note) {
    rv.pending = null;
    els.list.innerHTML = EMPTY_HTML;
    els.apply.disabled = true;
    els.cancel.disabled = true;
    if (note) setStatus("ℹ " + note, null);
    else setStatus("", null);
  }

  /* ================= 渲染 ================= */
  function render() {
    els.apply.disabled = !rv.pending;
    els.cancel.disabled = !rv.pending;
    if (!rv.pending) {
      els.list.innerHTML = EMPTY_HTML;
      return;
    }
    const p = rv.pending;
    const blocks = [];
    if (p.source.length) blocks.push(sideBlockHtml("源文", "src", p.source));
    if (p.translation.length) blocks.push(sideBlockHtml("译文", "trn", p.translation));
    els.list.innerHTML =
      blocks.join("") +
      '<div class="rv-foot">以上为本次整批校订的全部改动；点击「整批应用」一次性落地，' +
        "或「取消」放弃。时间、编号、锚点、锁定、原始 SRT 摘要与指纹均不改动。</div>";
  }

  function sideBlockHtml(title, cls, entries) {
    const rows = entries
      .map(
        (e) =>
          `<tr>
            <td class="num">#${e.id}</td>
            <td class="rv-before"><pre class="rv-text">${displayText(e.before)}</pre></td>
            <td class="rv-arrow">→</td>
            <td class="rv-after"><pre class="rv-text">${displayText(e.after)}</pre></td>
            <td class="tc rv-count">${e.count}</td>
          </tr>`
      )
      .join("");
    return (
      `<div class="rv-side-block rv-${cls}">` +
      `<h3>${title}（${entries.length} 条）</h3>` +
      `<div class="rv-table-wrap"><table>
        <thead><tr><th>#</th><th>修改前</th><th></th><th>修改后</th><th>命中处数</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`
    );
  }

  /* ================= 对外接口 ================= */
  window.ReviseUI = { reset };

  reset();
})();
