"""SRT 解析、生成与时间码工具。"""
from __future__ import annotations

import re

# 兼容 00:00:01,000 与 00:00:01.000 两种写法
TIMECODE_RE = re.compile(r"(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})")


def parse_timecode(text: str) -> int:
    """把时间码字符串解析为毫秒。允许字符串中包含其他内容（取首个时间码）。"""
    m = TIMECODE_RE.search(text)
    if not m:
        raise ValueError(f"无法解析时间码：{text.strip()!r}")
    h, minute, s, ms = m.groups()
    minute_i, s_i = int(minute), int(s)
    if minute_i >= 60 or s_i >= 60:
        raise ValueError(f"时间码分/秒超出范围：{text.strip()!r}")
    # 毫秒不足 3 位时按右侧补零（",5" 视为 500ms）
    return ((int(h) * 60 + minute_i) * 60 + s_i) * 1000 + int(ms.ljust(3, "0"))


def format_timecode(ms: int) -> str:
    """毫秒 -> HH:MM:SS,mmm。负值会抛错（导出前必须先消除负时间冲突）。"""
    if ms < 0:
        raise ValueError("时间码不能为负")
    h, rem = divmod(int(ms), 3_600_000)
    minute, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{minute:02d}:{s:02d},{milli:03d}"


def format_timecode_signed(ms: int) -> str:
    """带符号的时间码，用于冲突信息中展示负时间。"""
    return ("-" if ms < 0 else "") + format_timecode(abs(int(ms)))


def parse_srt(content: str) -> list[dict]:
    """解析 SRT 文本，返回 [{id, start_ms, end_ms, text}, ...]。

    容错点：BOM、\\r\\n、序号缺失、时间行后的定位属性。
    """
    text = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n[ \t]*\n", text.strip())
    subtitles: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        time_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if time_idx is None:
            continue  # 跳过无法识别的块
        parts = lines[time_idx].split("-->")
        if len(parts) < 2:
            continue
        try:
            start_ms = parse_timecode(parts[0])
            end_ms = parse_timecode(parts[1])
        except ValueError as exc:
            raise ValueError(f"第 {len(subtitles) + 1} 个字幕块时间码错误：{exc}") from exc
        subtitles.append(
            {
                "id": len(subtitles) + 1,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": "\n".join(lines[time_idx + 1 :]),
            }
        )
    if not subtitles:
        raise ValueError("未解析到任何字幕块，请确认内容是有效的 SRT")
    return subtitles


def build_srt(items: list[dict]) -> str:
    """把 [{start_ms, end_ms, text}, ...] 生成 SRT 文本（重新从 1 编号）。"""
    out: list[str] = []
    for i, it in enumerate(items, 1):
        out.append(str(i))
        out.append(f"{format_timecode(it['start_ms'])} --> {format_timecode(it['end_ms'])}")
        if it["text"]:
            out.extend(it["text"].split("\n"))
        out.append("")
    return "\n".join(out)
