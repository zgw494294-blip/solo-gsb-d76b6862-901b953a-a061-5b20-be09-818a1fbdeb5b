"""分段线性时间映射与冲突检测。

规则：
- 锚点按原时间升序排列，相邻锚点之间做线性插值；
- 首个锚点之前、末个锚点之后，分别沿最近一段的斜率外推；
- 锚点少于 2 个（或原时间重复）时不构成有效映射，按原样输出；
- 锁定的字幕保留原时间，不参与映射。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

from .srt import format_timecode, format_timecode_signed


@dataclass
class MappedItem:
    id: int
    new_start_ms: int
    new_end_ms: int
    locked: bool


def build_mapper(points: list[tuple[float, float]]) -> Callable[[float], float]:
    """由锚点 (原时间, 目标时间) 构造分段线性映射函数。

    points 需按原时间升序、原时间互不相同且长度 >= 2。
    """

    def mapper(t: float) -> float:
        if t <= points[0][0]:
            (o1, t1), (o2, t2) = points[0], points[1]
        elif t >= points[-1][0]:
            (o1, t1), (o2, t2) = points[-2], points[-1]
        else:
            for i in range(len(points) - 1):
                if points[i][0] <= t <= points[i + 1][0]:
                    (o1, t1), (o2, t2) = points[i], points[i + 1]
                    break
        return t1 + (t - o1) * (t2 - t1) / (o2 - o1)

    return mapper


def compute_timeline(subtitles, anchors, locks) -> tuple[list[MappedItem], list[dict]]:
    """计算映射后的时间轴并检测冲突，返回 (items, conflicts)。

    subtitles / anchors 为 app.main 中的 Pydantic 模型
    （字幕含 id、start_ms、end_ms；锚点含 id、subtitle_id、original_ms、target_ms）。
    """
    conflicts: list[dict] = []
    lock_set = set(locks)

    # ---- 锚点校验 ----
    by_original: dict[int, object] = {}
    for a in anchors:
        if a.target_ms < 0:
            conflicts.append(
                {
                    "type": "anchor",
                    "message": f"字幕 #{a.subtitle_id} 的锚点目标时间为负：{format_timecode_signed(a.target_ms)}",
                    "subtitle_ids": [a.subtitle_id],
                }
            )
        if a.original_ms in by_original:
            first = by_original[a.original_ms]
            conflicts.append(
                {
                    "type": "anchor",
                    "message": f"锚点原时间重复：{format_timecode(a.original_ms)}（字幕 #{first.subtitle_id} 与 #{a.subtitle_id}），无法构成有效分段",
                    "subtitle_ids": [first.subtitle_id, a.subtitle_id],
                }
            )
        else:
            by_original[a.original_ms] = a

    # ---- 构造映射函数（锚点 >= 2 且原时间互不重复才启用）----
    mapper = None
    if len(by_original) >= 2:
        pts = sorted((o, a.target_ms) for o, a in by_original.items())
        mapper = build_mapper(pts)

    # ---- 逐条映射 ----
    items: list[MappedItem] = []
    for s in subtitles:
        locked = s.id in lock_set
        if locked or mapper is None:
            ns, ne = s.start_ms, s.end_ms
        else:
            ns = round(mapper(s.start_ms))
            ne = round(mapper(s.end_ms))
        items.append(MappedItem(id=s.id, new_start_ms=ns, new_end_ms=ne, locked=locked))

    # ---- 冲突检测 ----
    for it in items:
        if it.new_start_ms < 0 or it.new_end_ms < 0:
            conflicts.append(
                {
                    "type": "negative",
                    "message": f"字幕 #{it.id}：映射后出现负时间（{format_timecode_signed(it.new_start_ms)} --> {format_timecode_signed(it.new_end_ms)}）",
                    "subtitle_ids": [it.id],
                }
            )
        if it.new_end_ms <= it.new_start_ms:
            conflicts.append(
                {
                    "type": "duration",
                    "message": f"字幕 #{it.id}：结束时间不晚于开始时间（{format_timecode_signed(it.new_start_ms)} --> {format_timecode_signed(it.new_end_ms)}）",
                    "subtitle_ids": [it.id],
                }
            )
    for prev, cur in zip(items, items[1:]):
        if cur.new_start_ms < prev.new_end_ms:
            conflicts.append(
                {
                    "type": "overlap",
                    "message": f"字幕 #{prev.id} 与 #{cur.id} 重叠（#{cur.id} 开始 {format_timecode_signed(cur.new_start_ms)} 早于 #{prev.id} 结束 {format_timecode_signed(prev.new_end_ms)}）",
                    "subtitle_ids": [prev.id, cur.id],
                }
            )

    return items, conflicts


def items_as_dicts(items: list[MappedItem]) -> list[dict]:
    return [asdict(it) for it in items]
