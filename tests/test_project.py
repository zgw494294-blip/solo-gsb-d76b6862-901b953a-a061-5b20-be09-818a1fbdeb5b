""".stc 校准工程逻辑测试：python3 tests/test_project.py（无第三方依赖）。"""
import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.project import (  # noqa: E402
    ProjectError,
    SCHEMA_VERSION,
    build_project,
    entry_fingerprint,
    fingerprints_from_content,
    restore_project,
    sha256_hex,
)

SRT_A = """1
00:00:01,000 --> 00:00:03,000
第一句。

2
00:00:04,000 --> 00:00:06,000
第二句。

3
00:00:07,000 --> 00:00:09,000
第三句。

4
00:00:10,000 --> 00:00:12,000
第四句。
"""

# parse_srt 忽略文件中的序号、按出现顺序重新编号，
# 因此“重排迁移”体现为块顺序变化后旧编号 → 新编号。
SRT_B_REORDERED = """1
00:00:10,000 --> 00:00:12,000
第四句。

2
00:00:01,000 --> 00:00:03,000
第一句。

3
00:00:04,000 --> 00:00:06,000
第二句。

4
00:00:07,000 --> 00:00:09,000
第三句。
"""

SRT_C_MISSING = """1
00:00:01,000 --> 00:00:03,000
第一句。

2
00:00:07,000 --> 00:00:09,000
第三句。
"""

SRT_D_DUP = SRT_A + """
5
00:00:04,000 --> 00:00:06,000
第二句。
"""


def anchors(*pairs, sid0=1):
    return [
        {"id": i + 1, "subtitle_id": sid0 + i, "original_ms": o, "target_ms": t}
        for i, (o, t) in enumerate(pairs)
    ]


def expect_error(fn, code):
    try:
        fn()
    except ProjectError as e:
        assert e.code == code, f"expected {code}, got {e.code}: {e.reasons}"
        return e
    raise AssertionError(f"expected ProjectError({code}), no error raised")


def test_fingerprint_invariant_under_nfc_lf():
    f1 = entry_fingerprint(1000, 3000, "é 你好\n第二行")
    nfd = unicodedata.normalize("NFD", "é 你好")
    f2 = entry_fingerprint(1000, 3000, nfd + "\r\n第二行")
    assert f1 == f2
    f3 = entry_fingerprint(1000, 3001, "é 你好\n第二行")
    assert f1 != f3  # 结束毫秒不同


def test_digest_distinguishes_raw_but_migration_matches():
    d1 = sha256_hex(SRT_A)
    d2 = sha256_hex("﻿" + SRT_A.replace("\n", "\r\n"))
    assert d1 != d2  # 原始字节不同 → 摘要不同
    _, subs1 = fingerprints_from_content(SRT_A)
    _, subs2 = fingerprints_from_content("﻿" + SRT_A.replace("\n", "\r\n"))
    assert [s["fingerprint"] for s in subs1] == [s["fingerprint"] for s in subs2]


def test_save_and_identical_restore():
    anc = anchors((1000, 1500), (7000, 9000))
    hist = [{"anchors": anchors((1000, 1500)), "locks": []}]
    p = build_project(SRT_A, anc, [3], hist, anchor_seq=3)
    assert p["schema_version"] == SCHEMA_VERSION
    assert p["source"]["sha256"] == sha256_hex(SRT_A)
    assert p["source"]["subtitle_count"] == 4
    assert p["locks"] == [3] and p["anchor_seq"] == 3

    res = restore_project(p, SRT_A)
    assert res.mode == "identical"
    assert [(m["old_id"], m["new_id"]) for m in res.mapping] == [
        (1, 1), (2, 2), (3, 3),
    ]  # #1 锚点（历史+当前）、#2 历史锚点、#3 锁定
    assert res.anchors == anc
    assert res.locks == [3]
    assert res.history[0]["anchors"][0]["subtitle_id"] == 1
    assert res.mapping[2]["text"] == "第三句。"
    assert json.dumps(p).count("fingerprint") >= 4


def test_restore_reordered_by_fingerprint():
    # 锚点在 #1(1s) 与 #3(7s)；锁定 #4
    anc = [
        {"id": 1, "subtitle_id": 1, "original_ms": 1000, "target_ms": 1500},
        {"id": 2, "subtitle_id": 3, "original_ms": 7000, "target_ms": 9000},
    ]
    p = build_project(SRT_A, anc, [4], [{"anchors": anc, "locks": [4]}])
    res = restore_project(p, SRT_B_REORDERED)
    assert res.mode == "migrated"
    # 旧编号按指纹映射到重排后的新编号（#2 未被引用，不出现在映射中）
    idmap = {m["old_id"]: m["new_id"] for m in res.mapping}
    assert idmap == {1: 2, 3: 4, 4: 1}, idmap
    assert res.anchors[0]["subtitle_id"] == 2
    assert res.anchors[1]["subtitle_id"] == 4
    assert res.locks == [1]
    assert res.history[0]["anchors"][1]["subtitle_id"] == 4
    assert res.history[0]["locks"] == [1]
    # 锚点自身 id 与原时间/目标时间不变
    assert res.anchors[0]["original_ms"] == 1000
    assert res.anchors[0]["target_ms"] == 1500
    renum = [m for m in res.mapping if m["old_id"] != m["new_id"]]
    assert len(renum) == 3


def test_restore_rejects_missing_referenced():
    # 锚点引用 #2(第二句)，当前文件缺失
    anc = anchors((1000, 1500), (4000, 6000))
    p = build_project(SRT_A, anc, [], [])
    e = expect_error(lambda: restore_project(p, SRT_C_MISSING), "migration_failed")
    assert any("缺失项" in r and "旧 #2" in r for r in e.reasons), e.reasons
    assert len(e.reasons) == 1


def test_restore_rejects_duplicate_candidate():
    anc = anchors((1000, 1500), (4000, 6000))
    p = build_project(SRT_A, anc, [], [])
    e = expect_error(lambda: restore_project(p, SRT_D_DUP), "migration_failed")
    assert any("重复候选" in r and "旧 #2" in r and "#2" in r and "#5" in r
               for r in e.reasons), e.reasons


def test_restore_lock_missing_blocks_migration():
    p = build_project(SRT_A, anchors((1000, 1500)), [2], [])
    e = expect_error(lambda: restore_project(p, SRT_C_MISSING), "migration_failed")
    assert any("缺失项" in r and "旧 #2" in r for r in e.reasons)


def test_restore_history_reference_missing_blocks():
    # 当前无锚点、无锁定，但撤销栈快照引用了 #2（第二句，当前文件缺失）
    hist = [{"anchors": [{"id": 1, "subtitle_id": 2,
                          "original_ms": 4000, "target_ms": 6000}], "locks": []}]
    p = build_project(SRT_A, [], [], hist)
    e = expect_error(lambda: restore_project(p, SRT_C_MISSING), "migration_failed")
    assert any("缺失项" in r and "旧 #2" in r for r in e.reasons), e.reasons


def test_unknown_schema_rejected():
    p = build_project(SRT_A, anchors((1000, 1500)), [], [])
    p["schema_version"] = 99
    e = expect_error(lambda: restore_project(p, SRT_A), "unknown_schema")
    assert "99" in e.reasons[0]


def test_invalid_digest_rejected():
    p = build_project(SRT_A, anchors((1000, 1500)), [], [])
    p["source"]["sha256"] = "ZZ" + "0" * 62
    e = expect_error(lambda: restore_project(p, SRT_A), "invalid_project")
    assert any("sha256" in r for r in e.reasons), e.reasons


def test_malformed_project_reasons():
    p = build_project(SRT_A, anchors((1000, 1500), (7000, 9000)), [], [])
    # 篡改：锚点指向不存在的字幕 + 坏 fingerprint + anchor_seq 非整数
    p["anchors"][0]["subtitle_id"] = 42
    p["subtitles"][1]["fingerprint"] = "x"
    p["anchor_seq"] = -1
    e = expect_error(lambda: restore_project(p, SRT_A), "invalid_project")
    joined = " | ".join(e.reasons)
    assert "#42" in joined
    assert "fingerprint" in joined
    assert "anchor_seq" in joined


def test_not_a_json_object():
    e = expect_error(lambda: restore_project([1, 2], SRT_A), "invalid_project")
    assert e.reasons == ["顶层必须是 JSON 对象"]


def test_save_rejects_dangling_reference():
    expect_error(lambda: build_project(SRT_A, anchors((1000, 1), sid0=99), [], []),
                 "invalid_reference")
    expect_error(lambda: build_project(SRT_A, [], [99], []), "invalid_reference")


def test_anchor_seq_repaired_on_save():
    anc = anchors((1000, 1500))  # id=1
    p = build_project(SRT_A, anc, [], [], anchor_seq=None)
    assert p["anchor_seq"] == 2
    p2 = build_project(SRT_A, anc, [], [], anchor_seq=1)  # <= max id
    assert p2["anchor_seq"] == 2


def test_identical_mode_keeps_ids_even_when_reorder_data_same_digest():
    # 同摘要但有人把工程里字幕表换成重排编号 → 指纹对不上（id 引用失败）应拒绝
    anc = anchors((1000, 1500))
    p = build_project(SRT_A, anc, [], [])
    p["subtitles"][0]["id"] = 99
    p["subtitles"][0] = dict(p["subtitles"][0])
    # 锚点引用的 #1 现已不在工程 subtitles 中
    e = expect_error(lambda: restore_project(p, SRT_A), "invalid_project")
    assert any("#1" in r for r in e.reasons)


def test_undo_stack_depth_preserved():
    anc = [
        {"id": 1, "subtitle_id": 1, "original_ms": 1000, "target_ms": 1500},
        {"id": 2, "subtitle_id": 3, "original_ms": 7000, "target_ms": 9000},
    ]
    hist = [
        {"anchors": [], "locks": [1]},
        {"anchors": [dict(anc[0])], "locks": [1]},
    ]
    p = build_project(SRT_A, anc, [1], hist)
    res = restore_project(p, SRT_B_REORDERED)
    assert len(res.history) == 2
    assert res.history[0]["locks"] == [2]  # 旧 #1 → 新 #2
    assert res.history[1]["anchors"][0]["subtitle_id"] == 2
    assert res.locks == [2]


def test_project_is_json_serializable_and_utf8():
    p = build_project(SRT_A, anchors((1000, 1500)), [], [])
    raw = json.dumps(p, ensure_ascii=False).encode("utf-8")
    assert raw.decode("utf-8")  # 无异常即可
    again = json.loads(raw)
    res = restore_project(again, SRT_A)
    assert res.mode == "identical"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"✔ {fn.__name__}")
    print(f"ALL {len(fns)} TESTS PASSED")
