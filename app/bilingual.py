"""双语字幕合成：时间区间配对、译文时间校验与双语 SRT 构建。

配对规则（两侧都使用**原始时间区间**，译文时间不参与导出时间轴）：
- 正长度交集才算相交：``max(a_start, b_start) < min(a_end, b_end)``；
  端点相接（一条结束恰好等于另一条开始）不算；
- 相交关系按连通分量（并查集）传递：s1∩t1、s2∩t1 ⇒ {s1,s2,t1} 同组；
- 每条字幕在结果中至多出现一次：多对一 / 一对多经传递合并为同一组。

译文 SRT 导入前必须通过时间合法性校验，否则拒绝导入：
- 单条时间倒挂（end_ms <= start_ms）；
- 任意两条译文区间存在正长度重叠（端点相接允许）。
"""
from __future__ import annotations

from .srt import format_timecode


# ============================ 译文时间校验 ============================

def validate_translations(translation_subs: list[dict]) -> list[str]:
    """校验译文时间：倒挂 / 正长度重叠。返回原因列表，空列表表示通过。

    translation_subs 为 [{id, start_ms, end_ms, text}]（id 仅用于报错定位）。
    """
    reasons: list[str] = []
    for t in translation_subs:
        if t["end_ms"] <= t["start_ms"]:
            reasons.append(
                f"译文 #{t['id']} 时间倒挂：结束时间不晚于开始时间"
                f"（{format_timecode(t['start_ms'])} → {format_timecode(t['end_ms'])}）"
            )
    for i in range(len(translation_subs)):
        a = translation_subs[i]
        for j in range(i + 1, len(translation_subs)):
            b = translation_subs[j]
            if max(a["start_ms"], b["start_ms"]) < min(a["end_ms"], b["end_ms"]):
                reasons.append(
                    f"译文 #{a['id']} 与 #{b['id']} 时间区间正长度重叠："
                    f"{format_timecode(a['start_ms'])} → {format_timecode(a['end_ms'])}"
                    f" 与 {format_timecode(b['start_ms'])} → {format_timecode(b['end_ms'])}"
                )
    return reasons


# ============================ 区间配对 ============================

def _intersects(a: dict, b: dict) -> bool:
    """两个区间是否存在正长度交集（端点相接不算）。"""
    return max(a["start_ms"], b["start_ms"]) < min(a["end_ms"], b["end_ms"])


def pair_subtitles(source_subs: list[dict], translation_subs: list[dict]) -> dict:
    """按原始时间区间正长度交集配对，相交关系传递成组。

    返回：
    {
      "groups": [{"source_ids": [...], "translation_ids": [...]}, ...],  # 按源字幕顺序
      "unpaired_source_ids": [...],      # 源侧未配对条目（源顺序）
      "unpaired_translation_ids": [...], # 译侧未配对条目（译文顺序）
      "source_count": n, "translation_count": m,
    }

    每条源 / 译文字幕在 groups 与两个 unpaired 列表中恰好出现一次。
    """
    n, m = len(source_subs), len(translation_subs)
    parent = list(range(n + m))  # [0, n) 为源；[n, n+m) 为译文

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:  # 路径压缩
            parent[x], x = root, parent[x]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, s in enumerate(source_subs):
        for j, t in enumerate(translation_subs):
            if _intersects(s, t):
                union(i, n + j)

    comps: dict[int, dict] = {}
    order: list[int] = []
    for idx in range(n + m):
        root = find(idx)
        if root not in comps:
            comps[root] = {"src": [], "trn": []}
            order.append(root)
        if idx < n:
            comps[root]["src"].append(idx)
        else:
            comps[root]["trn"].append(idx - n)

    grouped: list[tuple[int, dict]] = []
    unpaired_sources: list[int] = []
    unpaired_translations: list[int] = []
    for root in order:
        comp = comps[root]
        if comp["src"] and comp["trn"]:
            si = sorted(comp["src"])
            tj = sorted(comp["trn"])
            grouped.append(
                (
                    si[0],
                    {
                        "source_ids": [source_subs[i]["id"] for i in si],
                        "translation_ids": [translation_subs[j]["id"] for j in tj],
                    },
                )
            )
        elif comp["src"]:
            unpaired_sources.extend(comp["src"])
        else:
            unpaired_translations.extend(comp["trn"])

    grouped.sort(key=lambda x: x[0])
    unpaired_sources.sort()
    unpaired_translations.sort()
    return {
        "groups": [g for _, g in grouped],
        "unpaired_source_ids": [source_subs[i]["id"] for i in unpaired_sources],
        "unpaired_translation_ids": [translation_subs[j]["id"] for j in unpaired_translations],
        "source_count": n,
        "translation_count": m,
    }


def pairing_is_complete(pairing: dict) -> bool:
    """两侧是否全部配对（无任何未配对条目）。"""
    return not pairing["unpaired_source_ids"] and not pairing["unpaired_translation_ids"]


# ============================ 双语 SRT 构建 ============================

def build_bilingual_items(source_subs, translation_subs, pairing: dict, mapped_items) -> list[dict]:
    """每组生成一条双语字幕。

    - 正文：组内源文各条按源顺序换行拼接、译文各条按译文顺序换行拼接，
      源文块在上、译文块在下（仅以换行分隔，不插空行）；
    - 时间：组内源字幕**当前校准预览**（mapped_items）的最早开始与最晚结束；
      译文时间只参与配对，不进入导出时间。
    """
    src_by_id = {s["id"]: s for s in source_subs}
    trn_by_id = {t["id"]: t for t in translation_subs}
    mapped = {it.id: it for it in mapped_items}

    items: list[dict] = []
    for g in pairing["groups"]:
        src_lines = [src_by_id[sid]["text"] for sid in g["source_ids"]]
        trn_lines = [trn_by_id[tid]["text"] for tid in g["translation_ids"]]
        starts = [mapped[sid].new_start_ms for sid in g["source_ids"]]
        ends = [mapped[sid].new_end_ms for sid in g["source_ids"]]
        items.append(
            {
                "start_ms": min(starts),
                "end_ms": max(ends),
                "text": "\n".join(src_lines + trn_lines),
            }
        )
    return items
