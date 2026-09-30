"""双语字幕合成核心测试：python3 tests/test_bilingual.py（仅标准库）。"""
import sys
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.bilingual import (  # noqa: E402
    build_bilingual_items,
    pair_subtitles,
    pairing_is_complete,
    validate_translations,
)


def S(sid, a, b, text=None):
    return {"id": sid, "start_ms": a, "end_ms": b, "text": text or f"s{sid}"}


def T(tid, a, b, text=None):
    return {"id": tid, "start_ms": a, "end_ms": b, "text": text or f"t{tid}"}


def groups_of(pairing):
    return [(g["source_ids"], g["translation_ids"]) for g in pairing["groups"]]


def test_endpoint_touch_is_not_pairing():
    # [1000,3000] 与 [3000,5000] 端点相接，不算相交 → 两侧都未配对
    pairing = pair_subtitles([S(1, 1000, 3000)], [T(1, 3000, 5000)])
    assert groups_of(pairing) == []
    assert pairing["unpaired_source_ids"] == [1]
    assert pairing["unpaired_translation_ids"] == [1]
    assert pairing_is_complete(pairing) is False


def test_strict_positive_overlap_required():
    # 重叠 1ms 也要配对
    pairing = pair_subtitles([S(1, 1000, 3000)], [T(1, 2999, 5000)])
    assert groups_of(pairing) == [([1], [1])]
    assert pairing["unpaired_source_ids"] == []
    assert pairing["unpaired_translation_ids"] == []


def test_transitive_chain_merges_into_one_group():
    # s1[1,4] t1[3,6] s2[5,8]：s1∩t1、s2∩t1，三个条目同组
    pairing = pair_subtitles(
        [S(1, 1000, 4000), S(2, 5000, 8000)],
        [T(1, 3000, 6000)],
    )
    assert groups_of(pairing) == [([1, 2], [1])]
    assert pairing["unpaired_source_ids"] == []
    assert pairing["unpaired_translation_ids"] == []


def test_many_to_many_each_subtitle_appears_once():
    # s1[1,5] s2[4,8] 与 t1[2,6] t2[5,9] 全部相交连通 → 一大组
    pairing = pair_subtitles(
        [S(1, 1000, 5000), S(2, 4000, 8000)],
        [T(1, 2000, 6000), T(2, 5000, 9000)],
    )
    assert groups_of(pairing) == [([1, 2], [1, 2])]
    # 每条字幕恰好出现一次
    all_src = [i for g in pairing["groups"] for i in g["source_ids"]]
    all_trn = [i for g in pairing["groups"] for i in g["translation_ids"]]
    assert sorted(all_src) == [1, 2]
    assert sorted(all_trn) == [1, 2]


def test_groups_ordered_by_source_order():
    # 两组：第二组源在前（id 顺序即源顺序），第一组靠后
    pairing = pair_subtitles(
        [S(1, 10000, 12000), S(2, 1000, 3000)],
        [T(7, 10500, 11500), T(9, 1500, 2500)],
    )
    assert groups_of(pairing) == [([1], [7]), ([2], [9])]


def test_disjoint_intervals_remain_unpaired_on_both_sides():
    pairing = pair_subtitles(
        [S(1, 1000, 2000), S(2, 5000, 6000)],
        [T(1, 3000, 4000), T(2, 7000, 8000)],
    )
    assert groups_of(pairing) == []
    assert pairing["unpaired_source_ids"] == [1, 2]
    assert pairing["unpaired_translation_ids"] == [1, 2]


def test_one_to_many_group_spans_bridge():
    # t1[1,3]、t2[3,5] 端点相接不直接相连；s1[2,4] 与两者都正长度相交
    # → 传递成组 {s1,t1,t2}
    pairing = pair_subtitles([S(1, 2000, 4000)], [T(1, 1000, 3000), T(2, 3000, 5000)])
    assert groups_of(pairing) == [([1], [1, 2])]


def test_validate_translations_inverted():
    reasons = validate_translations([T(1, 5000, 5000), T(2, 4000, 3000)])
    # 等长区间（end == start）也算倒挂
    assert len(reasons) == 2
    assert all("#1" in r or "#2" in r for r in reasons)
    assert validate_translations([T(1, 1000, 3000)]) == []


def test_validate_translations_overlap():
    # 端点相接合法；正长度重叠非法
    assert validate_translations([T(1, 1000, 3000), T(2, 3000, 5000)]) == []
    reasons = validate_translations([T(1, 1000, 3000), T(2, 2000, 4000)])
    assert len(reasons) == 1 and "重叠" in reasons[0]
    # 完全包含
    reasons2 = validate_translations([T(1, 1000, 9000), T(2, 2000, 3000)])
    assert len(reasons2) == 1


def test_build_bilingual_items_text_order_and_preview_time():
    src = [
        S(1, 1000, 4000, "源一\n源一下"),
        S(2, 5000, 8000, "源二"),
        S(3, 9000, 10000, "未配对源"),
    ]
    trn = [T(1, 3000, 6000, "译一"), T(2, 7000, 8500, "译二")]
    pairing = pair_subtitles(src, trn)
    assert groups_of(pairing) == [([1, 2], [1, 2])]

    # 模拟映射后的预览时间：#1→[1500,4500]、#2→[5500,9500]（未配对源不参与任何组）
    mapped = [
        NS(id=1, new_start_ms=1500, new_end_ms=4500),
        NS(id=2, new_start_ms=5500, new_end_ms=9500),
        NS(id=3, new_start_ms=9000, new_end_ms=10000),
    ]
    items = build_bilingual_items(src, trn, pairing, mapped)
    assert len(items) == 1
    assert items[0]["start_ms"] == 1500  # 组内最早开始
    assert items[0]["end_ms"] == 9500  # 组内最晚结束
    # 源文各条按源顺序换行拼接，译文各条按译文顺序换行拼接，上下排列
    assert items[0]["text"] == "源一\n源一下\n源二\n译一\n译二"


def test_translation_time_not_used_as_export_time():
    # 译文区间比源宽很多：导出时间只取源预览，不取译文
    src = [S(1, 2000, 3000, "源")]
    trn = [T(1, 1000, 9000, "译")]
    pairing = pair_subtitles(src, trn)
    mapped = [NS(id=1, new_start_ms=2200, new_end_ms=3300)]
    items = build_bilingual_items(src, trn, pairing, mapped)
    assert (items[0]["start_ms"], items[0]["end_ms"]) == (2200, 3300)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"✔ {fn.__name__}")
    print(f"ALL {len(fns)} TESTS PASSED")
