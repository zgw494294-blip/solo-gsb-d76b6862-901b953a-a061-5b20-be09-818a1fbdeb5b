"""字幕断行排版核心测试：python3 tests/test_typesetting.py

依赖 regex（\X 切字素簇）与 wcwidth（列宽）：
    pip install regex wcwidth
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.typesetting import (  # noqa: E402
    KIND_HAN_BOUNDARY,
    KIND_OTHER_PUNCT,
    KIND_SENTENCE_END,
    KIND_WHITESPACE,
    MAX_COLUMNS,
    MAX_LINES,
    MIN_COLUMNS,
    MIN_LINES,
    layout_subtitles,
    layout_text,
    validate_params,
    validate_relayout,
)


def test_param_bounds():
    assert (MIN_COLUMNS, MAX_COLUMNS) == (12, 30)
    assert (MIN_LINES, MAX_LINES) == (1, 3)
    validate_params(12, 1)
    validate_params(30, 3)
    for bad in [(11, 2), (31, 2), (18, 0), (18, 4), ("18", 2), (True, 2)]:
        try:
            validate_params(*bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"参数应被拒绝：{bad}")


def test_han_width_and_sentence_punctuation_break():
    # 24 个汉字 + 句号 = 50 列；18 列最多 3 行，句末标点罚分 0 优先
    r = layout_text("风从山谷里穿过，带着雨的气息，慢慢吹向远方的河岸。", 18, 3)
    assert r.feasible, r.reasons
    assert len(r.lines) <= 3
    assert all(w <= 18 for w in r.widths)
    kinds = [b.kind for b in r.breaks]
    assert KIND_SENTENCE_END in kinds or KIND_OTHER_PUNCT in kinds
    assert validate_relayout(r.original, r.text) is None


def test_penalty_order_prefers_sentence_end():
    # 在「？」处断（罚分 0）优于汉字之间（3）
    t = "你好吗？我很好啊谢谢关心真的哦。"
    r = layout_text(t, 12, 3)
    assert r.feasible
    first = r.breaks[0]
    assert first.kind == KIND_SENTENCE_END
    assert r.lines[0].endswith("？")


def test_whitespace_is_consumed_on_break():
    # 空白断点：空白被替换为换行，建议文本中不再保留该空格
    r = layout_text("你好世界 这是一个测试用例", 12, 3)
    assert r.feasible, r.reasons
    ws = [b for b in r.breaks if b.kind == KIND_WHITESPACE]
    assert ws, "应在空格处断行"
    assert r.lines[0] == "你好世界"
    assert r.lines[1].startswith("这是一个")
    assert " " not in r.text
    assert r.text.replace("\n", "") == "你好世界这是一个测试用例"
    assert all(w <= 12 for w in r.widths)
    # 两行就能放下时：恰好只在空白处断一次
    r2 = layout_text("你好世界 这是一个测试用例", 16, 2)
    assert r2.feasible
    assert r2.text == "你好世界\n这是一个测试用例"


def test_existing_newline_can_be_kept_or_deleted():
    # 既有换行合法（每行都不超宽）时原样保留，不产生改动
    r = layout_text("远方的鼓声渐渐响起。\n她回头望了一眼来时的路。", 24, 3)
    assert r.feasible
    assert r.text == r.original
    assert r.changed is False
    assert any(b.existing for b in r.breaks)
    # 20 列下重排为更均衡的方案；无论删除/保留既有换行都必须是合法编辑
    r0 = layout_text("远方的鼓声渐渐响起。\n她回头望了一眼来时的路。", 20, 3)
    assert r0.feasible
    assert validate_relayout(r0.original, r0.text) is None
    # 参数放宽到一行放得下时，允许删除全部既有换行
    r2 = layout_text("第一行短\n第二行短\n第三行短", 30, 1)
    assert r2.feasible
    assert "\n" not in r2.text


def test_grapheme_cluster_not_split():
    t = "你好👨‍👩‍👧‍👦世界abc这是一个测试用例。"
    r = layout_text(t, 14, 3)
    assert r.feasible, r.reasons
    assert r.text.count("👨‍👩‍👧‍👦") == 1
    # 拆开换行后再拼回（删掉换行）应与原文完全一致：除换行外不改任何字符
    assert r.text.replace("\n", "") == t
    # 组合音标字素簇（e + combining acute）也不拆
    import regex
    t2 = "café文字内容继续延长测试"
    r2 = layout_text(t2, 12, 3)
    assert r2.feasible, r2.reasons
    assert r2.text.replace("\n", "") == t2
    for ln in r2.lines:
        assert len(regex.findall(r"\X", ln)) >= 1
    # 构造一个必须在组合字符附近断行的短样本，反复断行也不拆散它
    t3 = "é" + "字" * 18  # 1 + 36 = 37 列，14 列 × 3 行可容纳
    r3 = layout_text(t3, 14, 3)
    assert r3.feasible, r3.reasons
    assert r3.text.replace("\n", "") == t3


def test_no_line_start_and_no_line_end_rules():
    # 句中逗号永远不会出现在行首（17 字 = 34 列，12 列 3 行可排）
    t = "这里有逗号，后面还有很多内容。"
    r = layout_text(t, 12, 3)
    assert r.feasible, r.reasons
    for ln in r.lines:
        assert ln[0] not in "，。！？；：、）》】」』"
        assert ln[-1] not in "（《【「『"
    # 以开括号结尾：固有违规
    r = layout_text("他喊道（", 12, 2)
    assert not r.feasible
    assert any("禁止留在行尾" in x for x in r.reasons)
    # 以闭括号开头：固有违规（后续文本保证不是行数导致的无解）
    r = layout_text("）后面还有很多很多内容写下来", 12, 3)
    assert not r.feasible
    assert any("禁止出现在行首" in x for x in r.reasons)


def test_infeasible_reasons():
    # 无任何候选断点的超长连续片段
    r = layout_text("abcdefghijklmnopqrstuvwxyz0123456789", 18, 3)
    assert not r.feasible
    assert any("宽 36 列" in x for x in r.reasons), r.reasons
    # 行数不足
    r = layout_text("一二三四五六七八九十" * 6, 12, 2)
    assert not r.feasible
    assert any("最少需要" in x and "行" in x for x in r.reasons)
    # 单字素簇超宽
    long_emoji = "👨‍👩‍👧‍👦"
    r = layout_text(long_emoji, 12, 1)  # emoji 宽 2 列，实际放得下 → 可行
    assert r.feasible


def test_objective_ordering():
    # 两个方案罚分相同时（都为汉字间 3），选断点位置字典序靠前且剩余平方和更小者
    t = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未"
    r = layout_text(t, 20, 2)
    assert r.feasible
    assert [b.boundary for b in r.breaks] == [9]  # 18/18 均衡；字典序唯一
    assert r.widths == [18, 18]


def test_max_lines_one():
    # 一行放得下 → 原样；放不下 → 无解（不能增删出第二行方案）
    ok = layout_text("一二三四五六", 12, 1)
    assert ok.feasible and len(ok.lines) == 1
    bad = layout_text("一二三四五六七八", 12, 1)
    assert not bad.feasible
    assert any("最少需要 2 行" in x for x in bad.reasons)


def test_empty_and_blank_text():
    r = layout_text("", 12, 2)
    assert r.feasible and r.text == ""
    r2 = layout_text("\n\n", 12, 2)
    assert r2.feasible and r2.text == ""


def test_batch_layout():
    subs = [
        {"id": 1, "text": "风从山谷里穿过，带着雨的气息，慢慢吹向远方的河岸。"},
        {"id": 2, "text": "Hello world"},
    ]
    results = layout_subtitles(subs, 18, 2)
    assert [x.id for x in results] == [1, 2]
    assert results[1].feasible


def test_relayout_validator_allows_three_edit_kinds():
    assert validate_relayout("abc def", "abc\ndef") is None        # 空白 → 换行
    assert validate_relayout("abc\ndef", "abcdef") is None         # 删除既有换行
    assert validate_relayout("abc\ndef", "abc\ndef") is None       # 保留既有换行
    assert validate_relayout("你好，世界", "你好，\n世界") is None  # 标点后新增
    assert validate_relayout("你好世界", "你好\n世界") is None      # 汉字间新增


def test_relayout_validator_rejects_other_changes():
    bad_msgs = [
        validate_relayout("abcdef", "abc\ndef"),     # 英文中间断
        validate_relayout("abc", "abd"),             # 改字符
        validate_relayout("abc", "abc\ndef"),        # 加字符
        validate_relayout("abc", "ab"),              # 删字符
        validate_relayout("abc", "abc\n"),           # 文末凭空换行
        validate_relayout("a b", "a \nb"),           # 空白保留又在其后插换行
        validate_relayout("你好，世界", "你好\n，世界"),  # 标点落到行首
        validate_relayout("他（\n说", "他（\n说"),  # 开括号留行尾
    ]
    for msg in bad_msgs:
        assert isinstance(msg, str) and msg, f"应被拒绝：{msg!r}"


def test_dp_solutions_always_valid():
    """各种参数下 DP 产出的方案必须全部通过服务端导出校验。"""
    texts = [
        "风从山谷里穿过，带着雨的气息，慢慢吹向远方的河岸。",
        "Hello world, 这是一条中英混合的字幕测试句子哦。",
        "远方的鼓声渐渐响起。\n她回头望了一眼来时的路。",
        "「我们走吧。」他说。",
        "你好👨‍👩‍👧‍👦世界abc这是一个测试用例。",
        "   leading spaces and 很多很多的中文内容继续写下去。",
        "他喊道（",
        "abcdefghijklmnopqrstuvwxyz0123456789",
    ]
    for t in texts:
        for cols in (12, 14, 18, 24, 30):
            for lines in (1, 2, 3):
                r = layout_text(t, cols, lines)
                if not r.feasible:
                    continue
                assert len(r.lines) <= lines
                assert all(w <= cols for w in r.widths), (t, cols, lines, r.widths)
                for ln in r.lines:
                    assert ln[0] not in "，。！？；：、）》】」』"
                    assert ln[-1] not in "（《【「『"
                assert validate_relayout(t, r.text) is None


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"✔ {fn.__name__}")
    print(f"ALL {len(fns)} TESTS PASSED")
