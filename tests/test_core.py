"""核心逻辑测试：python3 tests/test_core.py（无第三方依赖）。"""
import sys
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.mapping import compute_timeline  # noqa: E402
from app.srt import build_srt, format_timecode, parse_srt, parse_timecode  # noqa: E402


def make_subs(spans):
    return [NS(id=i + 1, start_ms=a, end_ms=b) for i, (a, b) in enumerate(spans)]


def make_anchors(pairs):
    return [
        NS(id=i + 1, subtitle_id=i + 1, original_ms=o, target_ms=t)
        for i, (o, t) in enumerate(pairs)
    ]


def test_timecode():
    assert parse_timecode("00:00:01,200") == 1200
    assert parse_timecode("01:02:03.500") == 3723500
    assert parse_timecode("00:00:01,5") == 1500  # 毫秒右侧补零
    assert format_timecode(3723500) == "01:02:03,500"


def test_parse_srt_tolerant():
    raw = "﻿1\r\n00:00:01,000 --> 00:00:03,000 X1:100\r\n你好\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n世界\r\n第二行\r\n"
    subs = parse_srt(raw)
    assert subs == [
        {"id": 1, "start_ms": 1000, "end_ms": 3000, "text": "你好"},
        {"id": 2, "start_ms": 4000, "end_ms": 6000, "text": "世界\n第二行"},
    ]


def test_piecewise_linear_with_extrapolation():
    # 字幕: [1,3]s [4,6]s [7,9]s [10,12]s；锚点 4s->5s、7s->10s，段斜率 5/3
    subs = make_subs([(1000, 3000), (4000, 6000), (7000, 9000), (10000, 12000)])
    anchors = make_anchors([(4000, 5000), (7000, 10000)])
    items, conflicts = compute_timeline(subs, anchors, [])
    got = [(it.new_start_ms, it.new_end_ms) for it in items]
    assert got == [(0, 3333), (5000, 8333), (10000, 13333), (15000, 18333)], got
    assert conflicts == [], conflicts


def test_negative_time_conflict():
    subs = make_subs([(1000, 3000), (4000, 6000)])
    anchors = make_anchors([(4000, 1000), (7000, 61000)])  # 斜率 20，向前外推变负
    items, conflicts = compute_timeline(subs, anchors, [])
    assert items[0].new_start_ms < 0
    assert any(c["type"] == "negative" for c in conflicts)


def test_duration_conflict():
    subs = make_subs([(1000, 3000), (4000, 6000)])
    anchors = make_anchors([(1000, 10000), (4000, 1000)])  # 负斜率
    _, conflicts = compute_timeline(subs, anchors, [])
    assert any(c["type"] == "duration" for c in conflicts)


def test_overlap_conflict_with_locked_sub():
    # 锁定 #1（保持 1s-3s），映射把 #2 压到 1.0s-1.667s → 与 #1 重叠
    subs = make_subs([(1000, 3000), (4000, 6000), (7000, 9000), (10000, 12000)])
    anchors = make_anchors([(7000, 2000), (10000, 3000)])
    items, conflicts = compute_timeline(subs, anchors, locks=[1])
    assert (items[0].new_start_ms, items[0].new_end_ms) == (1000, 3000)
    assert items[0].locked is True
    assert any(c["type"] == "overlap" and 1 in c["subtitle_ids"] for c in conflicts), conflicts


def test_locked_sub_keeps_original_time():
    subs = make_subs([(1000, 3000), (4000, 6000), (7000, 9000)])
    anchors = make_anchors([(4000, 5000), (7000, 10000)])
    items, conflicts = compute_timeline(subs, anchors, locks=[2])
    assert (items[1].new_start_ms, items[1].new_end_ms, items[1].locked) == (4000, 6000, True)
    assert conflicts == [], conflicts


def test_identity_when_fewer_than_two_anchors():
    subs = make_subs([(1000, 3000), (4000, 6000)])
    anchors = make_anchors([(1000, 9999)])
    items, conflicts = compute_timeline(subs, anchors, [])
    assert [(i.new_start_ms, i.new_end_ms) for i in items] == [(1000, 3000), (4000, 6000)]
    assert conflicts == []


def test_duplicate_anchor_original():
    subs = make_subs([(1000, 3000), (4000, 6000)])
    anchors = make_anchors([(4000, 5000), (4000, 6000)])
    _, conflicts = compute_timeline(subs, anchors, [])
    assert any(c["type"] == "anchor" for c in conflicts)


def test_negative_anchor_target():
    subs = make_subs([(1000, 3000), (4000, 6000)])
    anchors = make_anchors([(1000, -500), (4000, 6000)])
    _, conflicts = compute_timeline(subs, anchors, [])
    assert any(c["type"] == "anchor" for c in conflicts)


def test_build_srt_roundtrip():
    out = build_srt(
        [
            {"start_ms": 0, "end_ms": 3333, "text": "你好"},
            {"start_ms": 5000, "end_ms": 8333, "text": "世界\n第二行"},
        ]
    )
    assert out == (
        "1\n00:00:00,000 --> 00:00:03,333\n你好\n\n"
        "2\n00:00:05,000 --> 00:00:08,333\n世界\n第二行\n"
    )
    rt = parse_srt(out)
    assert rt[1]["end_ms"] == 8333 and rt[1]["text"] == "世界\n第二行"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"✔ {fn.__name__}")
    print(f"ALL {len(fns)} TESTS PASSED")
