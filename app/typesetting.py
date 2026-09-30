"""字幕断行排版：Unicode 字素簇切分 + wcwidth 列宽 + 动态规划。

只允许以下三类编辑（由调用方与 ``validate_relayout`` 共同保证）：

1. 在候选断点处**新增**换行（不删改任何字符）；
2. **删除**正文里既有的换行；
3. 把断点处的**一个空白字素簇替换**为换行（该空白不再保留）。

其他字符的内容与顺序一律不动，因此时间轴、锚点、锁定与 ``.stc`` 条目指纹
（指纹只取决于时间与正文）均不受影响。

规则要点：

- 用 ``regex`` 的 ``\\X`` 切分 Unicode 字素簇（emoji 组合、注音/声调组合、
  CRLF 等都不会被拆开），列宽用 ``wcwidth.wcswidth`` 计算（控制字符按 0 列）；
- 候选断点限于：空白处（替换该空白）、标点之后、相邻汉字之间；
  既有换行始终是候选断点（保留它），落在非允许位置时仅作兜底（罚分 4）；
- 断点罚分：句末标点 ``。！？；`` 0、空白 1、其他标点 2、汉字之间 3；
- 禁止 ``，。！？；：、）》】」』`` 出现在行首，
  禁止 ``（《【「『`` 留在行尾；
- 动态规划只接受所有行均不超过列宽的方案，依次最小化：
  总罚分 → 各行剩余列数平方和 → 断点位置字典序；
- 任何列宽 / 行数设置下都无解时，``feasible=False`` 并在 ``reasons`` 列明原因。
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import regex
from wcwidth import wcswidth

MIN_COLUMNS = 12
MAX_COLUMNS = 30
MIN_LINES = 1
MAX_LINES = 3

# 句末标点（断点罚分 0）
SENTENCE_END = frozenset("。！？；")
# 禁止出现在行首的标点
NO_LINE_START = frozenset("，。！？；：、）》】」』")
# 禁止留在行尾的标点
NO_LINE_END = frozenset("（《【「『")

PENALTY_SENTENCE_END = 0
PENALTY_WHITESPACE = 1
PENALTY_OTHER_PUNCT = 2
PENALTY_HAN_BOUNDARY = 3
PENALTY_EXISTING_FALLBACK = 4  # 既有换行但不属于任何允许的断点类型（兜底）

# 断点类型（与罚分一一对应，existing 表示该处本就有换行）
KIND_SENTENCE_END = "sentence_end"
KIND_WHITESPACE = "whitespace"
KIND_OTHER_PUNCT = "punct"
KIND_HAN_BOUNDARY = "han"
KIND_FALLBACK = "fallback"

KIND_LABELS = {
    KIND_SENTENCE_END: "句末标点",
    KIND_WHITESPACE: "空白",
    KIND_OTHER_PUNCT: "其他标点",
    KIND_HAN_BOUNDARY: "汉字之间",
    KIND_FALLBACK: "既有换行（兜底）",
}


def validate_params(columns: int, max_lines: int) -> None:
    """校验排版参数，非法时抛 ValueError（由路由转 400）。"""
    if not isinstance(columns, int) or isinstance(columns, bool):
        raise ValueError("每行列数必须是整数")
    if not isinstance(max_lines, int) or isinstance(max_lines, bool):
        raise ValueError("最多行数必须是整数")
    if not (MIN_COLUMNS <= columns <= MAX_COLUMNS):
        raise ValueError(f"每行列数须在 {MIN_COLUMNS}～{MAX_COLUMNS} 之间（当前 {columns}）")
    if not (MIN_LINES <= max_lines <= MAX_LINES):
        raise ValueError(f"最多行数须在 {MIN_LINES}～{MAX_LINES} 之间（当前 {max_lines}）")


@dataclass
class _Cluster:
    ch: str
    width: int
    is_newline: bool


@dataclass
class BreakInfo:
    """一个断点（建议结果与无解诊断共用）。"""

    boundary: int          # 断点位置：第 boundary 个字素簇之前（0..n）
    kind: str
    penalty: int
    existing: bool         # 该处是否本就有换行
    left: str              # 断点前一个内容字素簇（展示用）
    right: str             # 断点后一个字素簇（空白断点即该空白）

    def as_dict(self) -> dict:
        return {
            "boundary": self.boundary,
            "kind": self.kind,
            "kind_label": KIND_LABELS[self.kind],
            "penalty": self.penalty,
            "existing": self.existing,
            "left": self.left,
            "right": self.right,
        }


@dataclass
class LayoutResult:
    id: int | None
    feasible: bool
    columns: int
    max_lines: int
    text: str = ""                 # 建议排版后的正文
    original: str = ""
    lines: list[str] = field(default_factory=list)
    widths: list[int] = field(default_factory=list)
    breaks: list[BreakInfo] = field(default_factory=list)
    total_penalty: int = 0
    residual_sq: int = 0
    cluster_count: int = 0
    changed: bool = False
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "feasible": self.feasible,
            "columns": self.columns,
            "max_lines": self.max_lines,
            "text": self.text,
            "original": self.original,
            "lines": self.lines,
            "widths": self.widths,
            "breaks": [b.as_dict() for b in self.breaks],
            "total_penalty": self.total_penalty,
            "residual_sq": self.residual_sq,
            "cluster_count": self.cluster_count,
            "changed": self.changed,
            "reasons": self.reasons,
        }


# ============================ 字素簇与分类 ============================

def _normalize(text: str) -> str:
    """SRT 解析已做过 CRLF 归一化；这里对直接调用再兜底一次。

    注意：regex 的 ``\\X`` 会把 CRLF 整体当成一个字素簇，归一化后
    换行一律是独立的单个 ``\\n`` 簇，便于「保留 / 删除既有换行」建模。
    """
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _cluster_width(ch: str) -> int:
    w = wcswidth(ch)
    return max(0, w)  # 换行/制表等控制字符 wcswidth 返回 -1，按 0 列计


def _tokenize(text: str) -> list[_Cluster]:
    return [
        _Cluster(ch=ch, width=_cluster_width(ch), is_newline=(ch == "\n"))
        for ch in regex.findall(r"\X", text)
    ]


def _is_han(ch: str) -> bool:
    return regex.match(r"\p{Han}", ch) is not None


def _is_punct(ch: str) -> bool:
    return regex.match(r"\p{P}", ch) is not None


def _is_whitespace(ch: str) -> bool:
    return regex.match(r"\s", ch) is not None


# ============================ 断点与线段 ============================

def _first_content(toks: list[_Cluster], start: int) -> int | None:
    """从 start 起第一个非换行字素簇下标（删除行内未选中的既有换行）。"""
    for i in range(start, len(toks)):
        if not toks[i].is_newline:
            return i
    return None


def _last_content(toks: list[_Cluster], before: int) -> int | None:
    """before 之前最后一个非换行字素簇下标。"""
    for i in range(before - 1, -1, -1):
        if not toks[i].is_newline:
            return i
    return None


def _classify_boundary(toks: list[_Cluster], b: int) -> tuple[str, int, bool] | None:
    """返回边界 b（toks[b] 之前）的 (kind, penalty, existing)；非候选返回 None。"""
    n = len(toks)
    if not (1 <= b < n):
        return None
    nxt = toks[b]
    if nxt.is_newline:
        # 规范的「保留既有换行」断点在换行簇之后；换行簇之前的边界不开放，
        # 否则会与下一个边界产生空行 / 重复方案。
        return None
    if toks[b - 1].is_newline:
        # 既有换行：按两侧内容归入对应罚分；都不满足时仅作兜底断点
        existing = True
        prev_idx = _last_content(toks, b - 1)
        prev_ch = toks[prev_idx].ch if prev_idx is not None else ""
        if prev_ch and prev_ch in SENTENCE_END:
            return KIND_SENTENCE_END, PENALTY_SENTENCE_END, existing
        if _is_whitespace(nxt.ch):
            return KIND_WHITESPACE, PENALTY_WHITESPACE, existing
        if prev_ch and _is_punct(prev_ch):
            return KIND_OTHER_PUNCT, PENALTY_OTHER_PUNCT, existing
        if prev_ch and _is_han(prev_ch) and _is_han(nxt.ch):
            return KIND_HAN_BOUNDARY, PENALTY_HAN_BOUNDARY, existing
        return KIND_FALLBACK, PENALTY_EXISTING_FALLBACK, existing
    # 新增换行（或替换空白）
    prev = toks[b - 1]
    if _is_whitespace(nxt.ch):
        return KIND_WHITESPACE, PENALTY_WHITESPACE, False
    if prev.ch in SENTENCE_END:
        return KIND_SENTENCE_END, PENALTY_SENTENCE_END, False
    if _is_punct(prev.ch):
        return KIND_OTHER_PUNCT, PENALTY_OTHER_PUNCT, False
    if _is_han(prev.ch) and _is_han(nxt.ch):
        return KIND_HAN_BOUNDARY, PENALTY_HAN_BOUNDARY, False
    return None


@dataclass
class _Move:
    """从某行起点出发的一个合法断点选择。"""

    b: int
    kind: str
    penalty: int
    existing: bool
    start: int          # 本行首个内容簇
    end: int            # 本行末个内容簇
    width: int
    next_start: int     # 下一行起点簇下标


class _Model:
    def __init__(self, toks: list[_Cluster], columns: int, max_lines: int):
        self.toks = toks
        self.n = len(toks)
        self.columns = columns
        self.max_lines = max_lines
        # 前缀宽度（换行簇宽 0，可直接对任意区间求和）
        self.pref = [0]
        for t in toks:
            self.pref.append(self.pref[-1] + (0 if t.is_newline else t.width))
        self.boundary: dict[int, tuple[str, int, bool]] = {}
        for b in range(1, self.n):
            info = _classify_boundary(toks, b)
            if info is not None:
                self.boundary[b] = info

    def width_between(self, lo: int, hi: int) -> int:
        """内容簇 [lo, hi] 的宽度（端点均含，换行簇不计）。"""
        return self.pref[hi + 1] - self.pref[lo]

    def finish_move(self, s: int) -> tuple[int, int, int] | None:
        """从起点 s 直接收尾（最后一行），返回 (start, end, width) 或 None。"""
        start = _first_content(self.toks, s)
        if start is None:
            return None  # 空行不允许
        end = _last_content(self.toks, self.n)
        if end is None or end < start:
            return None
        width = self.width_between(start, end)
        if width > self.columns:
            return None
        if self.toks[start].ch in NO_LINE_START:
            return None
        if self.toks[end].ch in NO_LINE_END:
            return None
        return start, end, width

    def moves(self, s: int):
        """枚举从行起点 s 出发的所有合法断行。"""
        start = _first_content(self.toks, s)
        if start is None:
            return
        for b, (kind, penalty, existing) in self.boundary.items():
            if b <= start:
                continue
            end = _last_content(self.toks, b)
            if end is None or end < start:
                continue
            if kind == KIND_WHITESPACE and not existing:
                # 空白替换：被替换的空白簇是 toks[b]，本行内容只到 b-1
                # （boundary 定义保证 toks[b-1] 非换行、toks[b] 为空白）
                if self.toks[b - 1].is_newline:
                    continue
                end = b - 1
                if end < start:
                    continue
                next_start = b + 1
            else:
                next_start = b
            width = self.width_between(start, end)
            if width > self.columns:
                continue
            if self.toks[start].ch in NO_LINE_START:
                continue
            if self.toks[end].ch in NO_LINE_END:
                continue
            yield _Move(b, kind, penalty, existing, start, end, width, next_start)


# ============================ 无解诊断 ============================

def _inherent_reasons(m: _Model) -> list[str]:
    """与断点选择无关、任何方案都无法消除的违规。"""
    reasons: list[str] = []
    toks = m.toks
    first = _first_content(toks, 0)
    last = _last_content(toks, m.n)
    if first is not None and toks[first].ch in NO_LINE_START:
        reasons.append(
            f"正文以禁止出现在行首的标点「{toks[first].ch}」开头，任何断行方案都无法规避"
        )
    if last is not None and toks[last].ch in NO_LINE_END:
        reasons.append(
            f"正文以禁止留在行尾的标点「{toks[last].ch}」结尾，任何断行方案都无法规避"
        )
    for i, t in enumerate(toks):
        if not t.is_newline and t.width > m.columns:
            reasons.append(
                f"第 {i + 1} 个字素簇「{t.ch}」宽 {t.width} 列，"
                f"超过每行 {m.columns} 列上限（字素簇不可拆开）"
            )
    return reasons


def _min_lines(m: _Model) -> tuple[int | None, str | None]:
    """不限行数时，用 BFS 求「能收尾」的最少行数（状态图是边权为 1 的 DAG）。

    返回 (最少行数, None)；不可达时返回 (None, 原因)。相比贪心，
    BFS 能正确处理「最晚断点的下一行以行首禁则标点开头」等边角。
    """
    dist: dict[int, int] = {0: 0}
    q = deque([0])
    deepest = 0  # 可达的最远行起点，用于无解时定位切不开的片段
    while q:
        s = q.popleft()
        deepest = max(deepest, s)
        if m.finish_move(s) is not None:
            return dist[s] + 1, None
        for mv in m.moves(s):
            if mv.next_start not in dist:
                dist[mv.next_start] = dist[s] + 1
                q.append(mv.next_start)

    # 不可达：从最远的可达起点描述无合法断点的连续片段。
    # 该起点既不能收尾、也没有任何合法断行（BFS 已穷举），
    # 因此连续片段一直延伸到文末。
    start = _first_content(m.toks, deepest)
    run_end = _last_content(m.toks, m.n)
    w = m.width_between(start, run_end) if start is not None and run_end is not None else 0
    snippet = "".join(
        t.ch for t in m.toks[start:run_end + 1] if not t.is_newline
    )
    if len(snippet) > 12:
        snippet = snippet[:12] + "…"
    return None, (
        f"自第 {(start or 0) + 1} 个字素簇起没有任何可合法结束本行的断点，"
        f"连续片段「{snippet}」宽 {w} 列，超过每行 {m.columns} 列上限"
    )


# ============================ 动态规划 ============================

@dataclass
class _State:
    penalty: int
    residual_sq: int
    breaks: tuple[int, ...]


def _better(a: _State | None, b: _State) -> _State:
    if a is None:
        return b
    ka = (a.penalty, a.residual_sq, a.breaks)
    kb = (b.penalty, b.residual_sq, b.breaks)
    return a if ka <= kb else b


def _solve(m: _Model) -> tuple[list[int], int, int] | None:
    """动态规划求最优断点列表，返回 (boundaries, total_penalty, residual_sq)。"""
    best: _State | None = None
    # dp：起点簇下标 -> 取了若干断点后的最优状态（恰 k 个断点 = 第 k+1 行起点）
    dp: dict[int, _State] = {0: _State(0, 0, ())}
    for k in range(m.max_lines):
        # 在本层收尾：共 k+1 行
        for s, st in dp.items():
            fin = m.finish_move(s)
            if fin is None:
                continue
            _, _, width = fin
            cand = _State(
                st.penalty,
                st.residual_sq + (m.columns - width) ** 2,
                st.breaks,
            )
            best = _better(best, cand)
        if k + 1 >= m.max_lines:
            break
        ndp: dict[int, _State] = {}
        for s, st in dp.items():
            for mv in m.moves(s):
                cand = _State(
                    st.penalty + mv.penalty,
                    st.residual_sq + (m.columns - mv.width) ** 2,
                    st.breaks + (mv.b,),
                )
                prev = ndp.get(mv.next_start)
                ndp[mv.next_start] = _better(prev, cand)
        dp = ndp
        if not dp:
            break
    if best is None:
        return None
    return list(best.breaks), best.penalty, best.residual_sq


def _rebuild(m: _Model, boundaries: list[int]) -> tuple[list[str], list[int], str]:
    """按断点重建各行文本、列宽与完整正文。"""
    lines: list[str] = []
    widths: list[int] = []
    s = 0
    for b in boundaries:
        kind, _, existing = m.boundary[b]
        start = _first_content(m.toks, s)
        end = _last_content(m.toks, b)
        if kind == KIND_WHITESPACE and not existing:
            end = b - 1  # 被替换的空白簇不计入行
        line = "".join(t.ch for t in m.toks[start:end + 1] if not t.is_newline)
        lines.append(line)
        widths.append(m.width_between(start, end))
        s = b + 1 if (kind == KIND_WHITESPACE and not existing) else b
    fin = m.finish_move(s)
    if fin is not None:
        start, end, width = fin
        line = "".join(t.ch for t in m.toks[start:end + 1] if not t.is_newline)
        lines.append(line)
        widths.append(width)
    return lines, widths, "\n".join(lines)


def _break_infos(m: _Model, boundaries: list[int]) -> list[BreakInfo]:
    out: list[BreakInfo] = []
    for b in boundaries:
        kind, penalty, existing = m.boundary[b]
        if kind == KIND_WHITESPACE and not existing:
            left_idx = b - 1
            right = m.toks[b].ch
        else:
            left_idx = _last_content(m.toks, b)
            nxt = _first_content(m.toks, b)
            right = m.toks[nxt].ch if nxt is not None else ""
        left = m.toks[left_idx].ch if left_idx is not None and not m.toks[left_idx].is_newline else ""
        out.append(
            BreakInfo(boundary=b, kind=kind, penalty=penalty, existing=existing,
                      left=left, right=right)
        )
    return out


# ============================ 对外入口 ============================

def layout_text(text: str, columns: int, max_lines: int,
                subtitle_id: int | None = None) -> LayoutResult:
    """对单条字幕正文求断行排版建议。"""
    validate_params(columns, max_lines)
    original = _normalize(text)
    toks = _tokenize(original)
    m = _Model(toks, columns, max_lines)

    base = LayoutResult(
        id=subtitle_id, feasible=False, columns=columns, max_lines=max_lines,
        original=original, cluster_count=sum(1 for t in toks if not t.is_newline),
    )
    if not toks or _first_content(toks, 0) is None:
        # 空正文：原样返回（不产生任何编辑）
        base.feasible = True
        base.text = ""
        base.lines = [""]
        base.widths = [0]
        return base

    reasons = _inherent_reasons(m)
    if reasons:
        base.reasons = reasons
        return base

    min_lines, why = _min_lines(m)
    if why is not None:
        base.reasons = [why]
        return base
    if min_lines is not None and min_lines > max_lines:
        base.reasons = [
            f"最少需要 {min_lines} 行才能不超过每行 {columns} 列，"
            f"超过最多 {max_lines} 行的限制"
        ]
        return base

    solved = _solve(m)
    if solved is None:  # 理论上与上面的诊断互斥，防御性兜底
        base.reasons = [f"在每行 {columns} 列、最多 {max_lines} 行条件下无合法方案"]
        return base

    boundaries, penalty, residual = solved
    lines, widths, new_text = _rebuild(m, boundaries)
    base.feasible = True
    base.text = new_text
    base.lines = lines
    base.widths = widths
    base.breaks = _break_infos(m, boundaries)
    base.total_penalty = penalty
    base.residual_sq = residual
    base.changed = new_text != original
    return base


def layout_subtitles(subtitles, columns: int, max_lines: int) -> list[LayoutResult]:
    """批量排版。subtitles 为 [{id, text}, ...]（Pydantic 模型或 dict 均可）。"""
    validate_params(columns, max_lines)
    results: list[LayoutResult] = []
    for s in subtitles:
        sid = s["id"] if isinstance(s, dict) else s.id
        text = s["text"] if isinstance(s, dict) else s.text
        results.append(layout_text(text, columns, max_lines, subtitle_id=sid))
    return results


# ============================ 已接受方案的合法性校验（导出用） ============================

def validate_relayout(original: str, proposed: str) -> str | None:
    """校验 proposed 是否只通过允许的三类编辑从 original 得到。

    合法返回 None；非法返回一句中文原因。允许的编辑：

    - 在候选断点处**新增**换行（标点之后或相邻汉字之间，不消耗原文字符）；
    - **保留 / 删除**原文既有换行；
    - 把一个**空白**字素簇**替换**为换行。

    其余字素簇必须与新文本一一对应、顺序一致；此外每行不得以
    ``，。！？；：、）》】」』`` 开头、以 ``（《【「『`` 结尾。
    """
    o = _tokenize(_normalize(original))
    p = _tokenize(_normalize(proposed))
    i = j = 0
    while j < len(p):
        pc = p[j]
        if pc.is_newline:
            if i >= len(o):
                return "新增的换行在原文之后，没有对应的空白或既有换行"
            oc = o[i]
            if oc.is_newline:
                i += 1
                j += 1  # 保留既有换行
            elif _is_whitespace(oc.ch):
                i += 1
                j += 1  # 一个空白替换为换行
            else:
                # 新增换行：只能在标点之后或相邻汉字之间
                if i == 0:
                    return "不能在正文开头新增换行"
                prev = o[i - 1]
                if prev.is_newline:
                    return "不能在既有换行旁再新增换行"
                if prev.ch in SENTENCE_END or _is_punct(prev.ch):
                    j += 1
                elif _is_han(prev.ch) and _is_han(oc.ch):
                    j += 1
                else:
                    return f"断点不合法：「{prev.ch}」与「{oc.ch}」之间不是空白、标点之后或相邻汉字之间"
            continue
        if i >= len(o):
            return f"建议文本多出字素簇「{pc.ch}」"
        oc = o[i]
        if oc.is_newline:
            i += 1  # 删除既有换行，继续匹配
            continue
        if oc.ch != pc.ch:
            return f"字符顺序被改动：原文「{oc.ch}」与建议「{pc.ch}」不一致"
        i += 1
        j += 1
    while i < len(o):
        if not o[i].is_newline:
            return f"建议文本缺少原文字素簇「{o[i].ch}」"
        i += 1

    # 结构合法后再检查行首尾禁则（防御性校验，正常由 DP 保证）
    for ln in proposed.split("\n"):
        cl = _tokenize(ln)
        if not cl:
            continue
        if cl[0].ch in NO_LINE_START:
            return f"行首不能出现标点「{cl[0].ch}」"
        if cl[-1].ch in NO_LINE_END:
            return f"行尾不能留下标点「{cl[-1].ch}」"
    return None
