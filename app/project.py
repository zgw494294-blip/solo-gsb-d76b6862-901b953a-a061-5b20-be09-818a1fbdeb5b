""".stc 校准工程：构建、恢复、指纹与重排迁移。

工程 JSON（UTF-8，建议扩展名 .stc）：

{
  "schema_version": 1,
  "source": {
    "sha256": "<原始 SRT 文本的 UTF-8 SHA-256，hex>",
    "subtitle_count": 12
  },
  "subtitles": [
    {"id": 1, "start_ms": 1000, "end_ms": 3000, "fingerprint": "<条目指纹 hex>"}
  ],
  "anchors": [{"id": 1, "subtitle_id": 1, "original_ms": 1000, "target_ms": 1200}],
  "locks": [3],
  "history": [
    {"anchors": [...], "locks": [2]}          // 撤销栈快照（与前端快照同构）
  ],
  "anchor_seq": 2,
  "saved_at": "2026-09-18T00:00:00+00:00"
}

恢复规则：
- 当前 SRT 原文的 sha256 与工程一致 → 原文件恢复，直接沿用旧 id；
- 不一致 → 禁止沿用旧 id，须按条目指纹唯一匹配；所有被锚点、锁定、
  撤销栈引用的条目都一一对应后才可迁移，并给出旧→新编号映射；
- 重复候选 / 缺失 / 未知 schema / 非法摘要等错误一律列明原因，
  由调用方拒绝恢复、不得改变当前工作区。
"""
from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass
from typing import Any

from .srt import format_timecode, parse_srt

SCHEMA_VERSION = 1
HEX64 = set("0123456789abcdef")


class ProjectError(Exception):
    """工程恢复被拒绝。code 为机器可读错误码，reasons 列明全部原因。"""

    def __init__(self, code: str, message: str, reasons: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.reasons = reasons or []


# ============================ 摘要与指纹 ============================

def sha256_hex(text: str) -> str:
    """原始 SRT 文本（含 BOM/CRLF 原样）的 UTF-8 SHA-256。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def entry_fingerprint(start_ms: int, end_ms: int, body: str) -> str:
    """单条指纹：正文 NFC/LF 归一化 + 原始起止毫秒。

    指纹只取决于条目自身的时间与文本，与它在文件中的序号无关，
    因此重排、重新编号后仍可匹配。
    """
    body = unicodedata.normalize("NFC", body).replace("\r\n", "\n").replace("\r", "\n")
    payload = f"{int(start_ms)}|{int(end_ms)}|{body.strip(chr(10))}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def fingerprints_from_content(content: str) -> tuple[str, list[dict]]:
    """解析当前 SRT 文本，返回 (sha256, [{id,start_ms,end_ms,text,fingerprint}])。"""
    subs = parse_srt(content)  # ValueError: 内容不是有效 SRT
    for s in subs:
        s["fingerprint"] = entry_fingerprint(s["start_ms"], s["end_ms"], s["text"])
    return sha256_hex(content), subs


def _is_hex64(v: Any) -> bool:
    return isinstance(v, str) and len(v) == 64 and all(c in HEX64 for c in v)


def _is_int(v: Any) -> bool:
    # bool 是 int 的子类，显式排除
    return isinstance(v, int) and not isinstance(v, bool)


# ============================ 构建工程 ============================

def build_project(raw_content: str, anchors: list[dict], locks: list[int],
                  history: list[dict], anchor_seq: int | None = None,
                  saved_at: str | None = None) -> dict:
    """由当前工作区构建可序列化的 .stc 工程 dict。

    anchors 为 [{id, subtitle_id, original_ms, target_ms}]；
    history 为 [{anchors: [...], locks: [...]}] 快照列表。
    """
    digest, subs = fingerprints_from_content(raw_content)

    sub_ids = {s["id"] for s in subs}
    anchors = [dict(a) for a in anchors]
    locks = list(dict.fromkeys(int(x) for x in locks))  # 去重保序

    bad_anchor_ids: list[int] = []
    max_anchor_id = 0
    for a in anchors:
        max_anchor_id = max(max_anchor_id, int(a.get("id", 0)) or 0)
        if not _is_int(a.get("subtitle_id")) or a["subtitle_id"] not in sub_ids:
            bad_anchor_ids.append(a.get("subtitle_id"))
    if bad_anchor_ids:
        raise ProjectError(
            "invalid_reference",
            "锚点引用了不存在的字幕，无法保存工程",
            [f"锚点引用的字幕 #{x} 不存在（当前共 {len(subs)} 条）" for x in bad_anchor_ids],
        )
    missing_locks = [i for i in locks if i not in sub_ids]
    if missing_locks:
        raise ProjectError(
            "invalid_reference",
            "锁定项引用了不存在的字幕，无法保存工程",
            [f"锁定的字幕 #{i} 不存在（当前共 {len(subs)} 条）" for i in missing_locks],
        )

    # 撤销栈中的引用也要有效，保证日后恢复可校验
    for hi, snap in enumerate(history):
        for a in snap.get("anchors", []):
            if not _is_int(a.get("subtitle_id")) or a["subtitle_id"] not in sub_ids:
                raise ProjectError(
                    "invalid_reference",
                    f"撤销栈第 {hi + 1} 层快照引用了不存在的字幕，无法保存工程",
                    [f"历史快照 #{hi + 1} 引用字幕 #{a.get('subtitle_id')}，不存在"],
                )
        for i in snap.get("locks", []):
            if i not in sub_ids:
                raise ProjectError(
                    "invalid_reference",
                    f"撤销栈第 {hi + 1} 层快照引用了不存在的锁定项，无法保存工程",
                    [f"历史快照 #{hi + 1} 引用锁定字幕 #{i}，不存在"],
                )
        max_anchor_id = max(
            [max_anchor_id] + [int(a.get("id", 0)) or 0 for a in snap.get("anchors", [])]
        )

    if not _is_int(anchor_seq) or anchor_seq <= max_anchor_id:
        anchor_seq = max_anchor_id + 1

    return {
        "schema_version": SCHEMA_VERSION,
        "source": {"sha256": digest, "subtitle_count": len(subs)},
        "subtitles": [
            {
                "id": s["id"],
                "start_ms": s["start_ms"],
                "end_ms": s["end_ms"],
                "fingerprint": s["fingerprint"],
            }
            for s in subs
        ],
        "anchors": [
            {
                "id": int(a["id"]),
                "subtitle_id": int(a["subtitle_id"]),
                "original_ms": int(a["original_ms"]),
                "target_ms": int(a["target_ms"]),
            }
            for a in anchors
        ],
        "locks": locks,
        "history": [
            {
                "anchors": [
                    {
                        "id": int(a["id"]),
                        "subtitle_id": int(a["subtitle_id"]),
                        "original_ms": int(a["original_ms"]),
                        "target_ms": int(a["target_ms"]),
                    }
                    for a in snap.get("anchors", [])
                ],
                "locks": [int(x) for x in snap.get("locks", [])],
            }
            for snap in history
        ],
        "anchor_seq": int(anchor_seq),
        "saved_at": saved_at or "",
    }


# ============================ 工程结构校验 ============================

def _validate_structure(project: Any) -> dict:
    """校验 .stc 工程结构，返回规范化后的工程；非法时抛 ProjectError（列明原因）。"""
    reasons: list[str] = []
    if not isinstance(project, dict):
        raise ProjectError("invalid_project", "工程文件不是 JSON 对象", ["顶层必须是 JSON 对象"])

    if "schema_version" not in project:
        reasons.append("缺少 schema_version 字段")
    elif project["schema_version"] != SCHEMA_VERSION:
        v = project["schema_version"]
        raise ProjectError(
            "unknown_schema",
            f"未知的 schema 版本：{v!r}（本工具支持版本 {SCHEMA_VERSION}）",
            [f"schema_version={v!r}，仅支持 {SCHEMA_VERSION}"],
        )

    src = project.get("source")
    if not isinstance(src, dict):
        reasons.append("缺少 source 对象")
    else:
        if not _is_hex64(src.get("sha256")):
            reasons.append("source.sha256 非法：须为 64 位小写十六进制字符串")
        if not _is_int(src.get("subtitle_count")) or src["subtitle_count"] < 0:
            reasons.append("source.subtitle_count 非法：须为非负整数")

    psubs = project.get("subtitles")
    sub_records: dict[int, dict] = {}
    if not isinstance(psubs, list):
        reasons.append("subtitles 必须是数组")
    else:
        seen_ids: set[int] = set()
        for i, s in enumerate(psubs):
            where = f"subtitles[{i}]"
            if not isinstance(s, dict):
                reasons.append(f"{where} 不是对象")
                continue
            sid = s.get("id")
            if not _is_int(sid) or sid < 1:
                reasons.append(f"{where}.id 非法：{sid!r}")
            elif sid in seen_ids:
                reasons.append(f"subtitles 中编号 #{sid} 重复")
            else:
                seen_ids.add(sid)
            if not _is_int(s.get("start_ms")):
                reasons.append(f"{where}.start_ms 非法（字幕 #{sid}）")
            if not _is_int(s.get("end_ms")):
                reasons.append(f"{where}.end_ms 非法（字幕 #{sid}）")
            if _is_int(s.get("start_ms")) and _is_int(s.get("end_ms")) \
                    and s["end_ms"] <= s["start_ms"]:
                reasons.append(
                    f"字幕 #{sid} 结束时间不晚于开始时间："
                    f"{format_timecode(s['start_ms'])} → {format_timecode(s['end_ms'])}"
                )
            if not _is_hex64(s.get("fingerprint")):
                reasons.append(f"字幕 #{sid} 的 fingerprint 非法：须为 64 位小写十六进制字符串")
            elif _is_int(sid):
                sub_records[sid] = s

    def check_anchor_list(lst: Any, where: str) -> list[dict]:
        out: list[dict] = []
        if not isinstance(lst, list):
            reasons.append(f"{where} 必须是数组")
            return out
        for i, a in enumerate(lst):
            aw = f"{where}[{i}]"
            if not isinstance(a, dict):
                reasons.append(f"{aw} 不是对象")
                continue
            ok = True
            for f in ("id", "subtitle_id", "original_ms", "target_ms"):
                if not _is_int(a.get(f)):
                    reasons.append(f"{aw}.{f} 非法：{a.get(f)!r}（字幕 #{a.get('subtitle_id')}）")
                    ok = False
            if ok:
                out.append(
                    {
                        "id": a["id"],
                        "subtitle_id": a["subtitle_id"],
                        "original_ms": a["original_ms"],
                        "target_ms": a["target_ms"],
                    }
                )
        return out

    anchors = check_anchor_list(project.get("anchors"), "anchors")

    locks: list[int] = []
    plocks = project.get("locks", [])
    if not isinstance(plocks, list) or not all(_is_int(x) for x in plocks):
        reasons.append("locks 必须是整数数组")
    else:
        locks = list(dict.fromkeys(plocks))

    history: list[dict] = []
    phist = project.get("history", [])
    if not isinstance(phist, list):
        reasons.append("history 必须是数组")
    else:
        for hi, snap in enumerate(phist):
            where = f"history[{hi}]"
            if not isinstance(snap, dict):
                reasons.append(f"{where} 不是对象")
                continue
            sa = check_anchor_list(snap.get("anchors", []), f"{where}.anchors")
            sl = snap.get("locks", [])
            if not isinstance(sl, list) or not all(_is_int(x) for x in sl):
                reasons.append(f"{where}.locks 必须是整数数组")
                sl = []
            history.append({"anchors": sa, "locks": list(dict.fromkeys(sl))})

    if not _is_int(project.get("anchor_seq")) or project["anchor_seq"] < 1:
        reasons.append("anchor_seq 非法：须为正整数")

    # 引用完整性（工程内部自洽性，两种恢复路径都检查）
    for a in anchors:
        if a["subtitle_id"] not in sub_records:
            reasons.append(f"锚点 #{a['id']} 引用的字幕 #{a['subtitle_id']} 不在工程中")
    for i in locks:
        if i not in sub_records:
            reasons.append(f"锁定项 #{i} 不在工程 subtitles 中")
    for hi, snap in enumerate(history):
        for a in snap["anchors"]:
            if a["subtitle_id"] not in sub_records:
                reasons.append(
                    f"撤销栈第 {hi + 1} 层锚点 #{a['id']} 引用的字幕 "
                    f"#{a['subtitle_id']} 不在工程中"
                )
        for i in snap["locks"]:
            if i not in sub_records:
                reasons.append(f"撤销栈第 {hi + 1} 层锁定项 #{i} 不在工程 subtitles 中")

    if reasons:
        raise ProjectError("invalid_project", "工程文件结构非法，已拒绝恢复", reasons)
    return project


# ============================ 恢复 ============================

@dataclass
class RestoreResult:
    mode: str                  # "identical" | "migrated"
    anchors: list[dict]
    locks: list[int]
    history: list[dict]
    anchor_seq: int
    mapping: list[dict]        # [{old_id, new_id, start_ms, end_ms, text, referenced_by}]
    missing: list[dict]
    reasons: list[str]


def _snapshot_referenced_ids(snap: dict) -> set[int]:
    ids = {a["subtitle_id"] for a in snap["anchors"]}
    ids.update(snap["locks"])
    return ids


def restore_project(project: dict, current_content: str) -> RestoreResult:
    """把工程恢复到当前 SRT 文本上。

    任何不满足条件的情况都抛 ProjectError（reasons 列明原因），
    调用方据此保持工作区不变。
    """
    project = _validate_structure(project)

    try:
        digest, cur_subs = fingerprints_from_content(current_content)
    except ValueError as exc:
        raise ProjectError(
            "current_invalid",
            "当前工作区 SRT 无法解析",
            [f"当前 SRT 解析失败：{exc}"],
        ) from exc

    saved_digest = project["source"]["sha256"]
    if not _is_hex64(saved_digest):  # 结构校验已拦截，防御性兜底
        raise ProjectError(
            "invalid_digest",
            "工程摘要非法",
            ["source.sha256 须为 64 位小写十六进制字符串"],
        )

    old_subs: dict[int, dict] = {s["id"]: s for s in project["subtitles"]}
    anchors = project["anchors"]
    locks = list(dict.fromkeys(project["locks"]))
    history = project["history"]

    referenced: set[int] = {a["subtitle_id"] for a in anchors}
    referenced.update(locks)
    for snap in history:
        referenced.update(_snapshot_referenced_ids(snap))

    # ---------- 路径一：原文件恢复 ----------
    if digest == saved_digest:
        cur_by_id = {s["id"]: s for s in cur_subs}
        cur_by_fp: dict[str, list[dict]] = {}
        for s in cur_subs:
            cur_by_fp.setdefault(s["fingerprint"], []).append(s)
        reasons: list[str] = []
        for oid in sorted(referenced):
            old = old_subs.get(oid)
            cur = cur_by_id.get(oid)
            if old is None:
                reasons.append(f"工程引用的字幕 #{oid} 不在工程中")
            elif cur is None:
                reasons.append(f"摘要一致但当前文件缺少编号 #{oid} 的字幕")
            elif cur["fingerprint"] != old["fingerprint"]:
                reasons.append(
                    f"摘要一致但字幕 #{oid} 的指纹不一致"
                    f"（{format_timecode(cur['start_ms'])} → {format_timecode(cur['end_ms'])}）"
                )
            elif len(cur_by_fp.get(old["fingerprint"], [])) != 1:
                reasons.append(f"摘要一致但字幕 #{oid} 的指纹在当前文件中不唯一")
        if reasons:
            raise ProjectError("content_mismatch", "摘要一致但内容无法对应，已拒绝恢复", reasons)

        mapping = [
            {
                "old_id": oid,
                "new_id": oid,
                "start_ms": cur_by_id[oid]["start_ms"],
                "end_ms": cur_by_id[oid]["end_ms"],
                "text": cur_by_id[oid]["text"],
            }
            for oid in sorted(referenced)
        ]
        return RestoreResult(
            mode="identical",
            anchors=anchors,
            locks=locks,
            history=history,
            anchor_seq=project["anchor_seq"],
            mapping=mapping,
            missing=[],
            reasons=[],
        )

    # ---------- 路径二：重排迁移（禁止沿用旧 id）----------
    cur_by_fp: dict[str, list[dict]] = {}
    for s in cur_subs:
        cur_by_fp.setdefault(s["fingerprint"], []).append(s)

    id_map: dict[int, int] = {}
    missing: list[dict] = []
    reasons: list[str] = []
    dup_targets: set[int] = set()

    for oid in sorted(referenced):
        old = old_subs.get(oid)
        if old is None:
            reasons.append(f"工程引用的字幕 #{oid} 不在工程中")
            continue
        cands = cur_by_fp.get(old["fingerprint"], [])
        label = (
            f"旧 #{oid}（{format_timecode(old['start_ms'])} → "
            f"{format_timecode(old['end_ms'])}）"
        )
        if not cands:
            missing.append(
                {"old_id": oid, "start_ms": old["start_ms"], "end_ms": old["end_ms"]}
            )
            reasons.append(f"缺失项：当前 SRT 中找不到 {label} 对应的条目")
        elif len(cands) > 1:
            cand_ids = "、".join(f"#{c['id']}" for c in cands)
            reasons.append(f"重复候选：{label} 在当前 SRT 中同时匹配 {cand_ids}，无法唯一确定")
        else:
            new_id = cands[0]["id"]
            if new_id in id_map.values():
                dup_targets.add(new_id)
            id_map[oid] = new_id

    if dup_targets:
        for nid in sorted(dup_targets):
            olds = sorted(o for o, n in id_map.items() if n == nid)
            reasons.append(
                f"旧编号 {'、'.join('#' + str(o) for o in olds)} 指纹相同，"
                f"都映射到当前 #{nid}，无法一一对应"
            )

    if reasons:
        raise ProjectError(
            "migration_failed",
            f"当前 SRT 与工程来源不一致（SHA-256 不同），迁移失败：{len(reasons)} 处问题",
            reasons,
        )

    def remap_anchors(lst: list[dict]) -> list[dict]:
        return [
            {
                "id": a["id"],
                "subtitle_id": id_map[a["subtitle_id"]],
                "original_ms": a["original_ms"],
                "target_ms": a["target_ms"],
            }
            for a in lst
        ]

    new_anchors = remap_anchors(anchors)
    new_locks = [id_map[i] for i in locks]
    new_history = [
        {"anchors": remap_anchors(snap["anchors"]), "locks": [id_map[i] for i in snap["locks"]]}
        for snap in history
    ]

    mapping = []
    for oid in sorted(referenced):
        nid = id_map[oid]
        cur = next(s for s in cur_subs if s["id"] == nid)
        via: list[str] = []
        if any(a["subtitle_id"] == oid for a in anchors):
            via.append("锚点")
        if oid in locks:
            via.append("锁定")
        if any(oid in _snapshot_referenced_ids(snap) for snap in history):
            via.append("撤销栈")
        mapping.append(
            {
                "old_id": oid,
                "new_id": nid,
                "start_ms": cur["start_ms"],
                "end_ms": cur["end_ms"],
                "text": cur["text"],
                "referenced_by": via,
            }
        )

    return RestoreResult(
        mode="migrated",
        anchors=new_anchors,
        locks=new_locks,
        history=new_history,
        anchor_seq=project["anchor_seq"],
        mapping=mapping,
        missing=missing,
        reasons=[],
    )


def result_as_dict(res: RestoreResult) -> dict:
    return {
        "mode": res.mode,
        "anchors": res.anchors,
        "locks": res.locks,
        "history": res.history,
        "anchor_seq": res.anchor_seq,
        "mapping": res.mapping,
        "missing": res.missing,
        "reasons": res.reasons,
    }
