"""字幕时轴校准台 —— FastAPI 入口。

路由：
- GET  /                  前端页面
- POST /api/parse         解析 SRT 文本
- POST /api/preview       按锚点分段线性映射，返回新时间与冲突
- POST /api/export        无冲突时导出 UTF-8 SRT（原样正文）
- POST /api/bilingual/pair   在当前源 SRT 上导入译文 SRT：校验译文时间并按区间交集配对
- POST /api/bilingual/export 无冲突且全部配对时导出双语 SRT（每组一条）
- POST /api/typeset/suggest  对字幕正文生成断行排版建议（只算换行，不改其他字符）
- POST /api/typeset/export   无冲突时导出「排版版」SRT（只写入已接受的换行）
- POST /api/project/save  由当前工作区构建 .stc 校准工程
- POST /api/project/load  按指纹把 .stc 工程恢复/迁移到当前 SRT
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .bilingual import (
    build_bilingual_items,
    pair_subtitles,
    pairing_is_complete,
    validate_translations,
)
from .mapping import compute_timeline, items_as_dicts
from .project import (
    ProjectError,
    build_project,
    result_as_dict,
    restore_project,
    sha256_hex,
)
from .srt import build_srt, parse_srt
from .typesetting import layout_subtitles, validate_params, validate_relayout

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="字幕时轴校准台")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


class Subtitle(BaseModel):
    id: int
    start_ms: int
    end_ms: int
    text: str = ""


class Anchor(BaseModel):
    id: int
    subtitle_id: int
    original_ms: int
    target_ms: int


class ParseRequest(BaseModel):
    content: str


class TimelineRequest(BaseModel):
    subtitles: list[Subtitle]
    anchors: list[Anchor] = Field(default_factory=list)
    locks: list[int] = Field(default_factory=list)


class HistorySnapshot(BaseModel):
    anchors: list[Anchor] = Field(default_factory=list)
    locks: list[int] = Field(default_factory=list)


class ProjectSaveRequest(BaseModel):
    content: str
    anchors: list[Anchor] = Field(default_factory=list)
    locks: list[int] = Field(default_factory=list)
    history: list[HistorySnapshot] = Field(default_factory=list)
    anchor_seq: int | None = None
    saved_at: str | None = None


class ProjectLoadRequest(BaseModel):
    content: str
    project: dict


class TypesetRequest(BaseModel):
    subtitles: list[Subtitle]
    columns: int = Field(default=18)
    max_lines: int = Field(default=2, alias="maxLines")

    model_config = {"populate_by_name": True}


class TypesetSubtitle(BaseModel):
    """排版版导出：一条字幕的映射时间与（可能已被换行替换的）正文。"""

    id: int
    start_ms: int
    end_ms: int
    text: str = ""
    original_text: str = ""


class TypesetExportRequest(BaseModel):
    subtitles: list[TypesetSubtitle]
    anchors: list[Anchor] = Field(default_factory=list)
    locks: list[int] = Field(default_factory=list)


class BilingualPairRequest(BaseModel):
    """在当前源 SRT 上导入译文 SRT：两侧原始时间区间按正长度交集配对。"""

    subtitles: list[Subtitle]
    translations: list[Subtitle]


class BilingualExportRequest(BaseModel):
    """双语导出：源字幕 + 译文（原始时间只参与配对）+ 锚点 / 锁定。"""

    subtitles: list[Subtitle]
    translations: list[Subtitle]
    anchors: list[Anchor] = Field(default_factory=list)
    locks: list[int] = Field(default_factory=list)


def _project_error(exc: ProjectError) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={"code": exc.code, "message": exc.message, "reasons": exc.reasons},
    )


def _timeline_payload(req: TimelineRequest) -> dict:
    items, conflicts = compute_timeline(req.subtitles, req.anchors, req.locks)
    return {
        "items": items_as_dicts(items),
        "conflicts": conflicts,
        "can_export": not conflicts and bool(req.subtitles),
        "anchor_count": len(req.anchors),
        "mapping_enabled": len({a.original_ms for a in req.anchors}) >= 2,
    }


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")


@app.post("/api/parse")
def parse(req: ParseRequest):
    try:
        subs = parse_srt(req.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "count": len(subs),
        "subtitles": subs,
        "sha256": sha256_hex(req.content),
    }


@app.post("/api/preview")
def preview(req: TimelineRequest):
    return _timeline_payload(req)


@app.post("/api/export")
def export(req: TimelineRequest):
    if not req.subtitles:
        raise HTTPException(status_code=400, detail="没有可导出的字幕")
    items, conflicts = compute_timeline(req.subtitles, req.anchors, req.locks)
    if conflicts:
        raise HTTPException(
            status_code=400,
            detail="存在冲突，禁止导出：" + "；".join(c["message"] for c in conflicts),
        )
    text_by_id = {s.id: s.text for s in req.subtitles}
    srt_text = build_srt(
        [
            {"start_ms": it.new_start_ms, "end_ms": it.new_end_ms, "text": text_by_id.get(it.id, "")}
            for it in items
        ]
    )
    return PlainTextResponse(
        srt_text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="calibrated.srt"'},
    )


def _bilingual_error(message: str, reasons: list[str]) -> HTTPException:
    return HTTPException(
        status_code=400, detail={"code": "invalid_translation", "message": message, "reasons": reasons}
    )


@app.post("/api/bilingual/pair")
def bilingual_pair(req: BilingualPairRequest):
    """在当前源 SRT 上导入译文 SRT：

    - 译文时间倒挂 / 正长度重叠（端点相接不算）→ 400，拒绝导入；
    - 否则按两侧**原始时间区间**的正长度交集配对，相交关系传递成组，
      每条字幕只出现一次；返回分组与两侧未配对条目（分组按源字幕顺序）。
    """
    if not req.subtitles:
        raise HTTPException(status_code=400, detail="请先导入源 SRT，再导入译文")
    if not req.translations:
        raise _bilingual_error("译文 SRT 为空，无法导入", ["译文未解析到任何字幕块"])
    src_dicts = [s.model_dump() for s in req.subtitles]
    trn_dicts = [t.model_dump() for t in req.translations]
    reasons = validate_translations(trn_dicts)
    if reasons:
        raise _bilingual_error("译文 SRT 时间不合法，已拒绝导入", reasons)
    pairing = pair_subtitles(src_dicts, trn_dicts)
    pairing["complete"] = pairing_is_complete(pairing)
    return pairing


@app.post("/api/bilingual/export")
def bilingual_export(req: BilingualExportRequest):
    """导出双语 SRT：每组一条，源文 / 译文换行拼接、上下排列。

    拦截：译文时间不合法、时间轴预览存在冲突、任一侧存在未配对条目。
    译文时间只参与配对；每组时间取组内源字幕当前校准预览的最早开始 / 最晚结束。
    """
    if not req.subtitles:
        raise HTTPException(status_code=400, detail="没有可导出的字幕")
    if not req.translations:
        raise HTTPException(status_code=400, detail="尚未导入译文 SRT，无法导出双语字幕")
    src_dicts = [s.model_dump() for s in req.subtitles]
    trn_dicts = [t.model_dump() for t in req.translations]
    reasons = validate_translations(trn_dicts)
    if reasons:
        raise _bilingual_error("译文 SRT 时间不合法，已拒绝导出", reasons)
    items, conflicts = compute_timeline(req.subtitles, req.anchors, req.locks)
    if conflicts:
        raise HTTPException(
            status_code=400,
            detail="存在冲突，禁止导出：" + "；".join(c["message"] for c in conflicts),
        )
    pairing = pair_subtitles(src_dicts, trn_dicts)
    if not pairing_is_complete(pairing):
        details = []
        if pairing["unpaired_source_ids"]:
            details.append("源侧未配对：" + "、".join(f"#{i}" for i in pairing["unpaired_source_ids"]))
        if pairing["unpaired_translation_ids"]:
            details.append("译文侧未配对：" + "、".join(f"#{i}" for i in pairing["unpaired_translation_ids"]))
        raise HTTPException(
            status_code=400,
            detail="存在未配对字幕，禁止双语导出：" + "；".join(details),
        )
    bilingual_items = build_bilingual_items(src_dicts, trn_dicts, pairing, items)
    srt_text = build_srt(bilingual_items)
    return PlainTextResponse(
        srt_text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="bilingual.srt"'},
    )


@app.post("/api/typeset/suggest")
def typeset_suggest(req: TypesetRequest):
    """对每条字幕生成断行排版建议。只决定换行，不动其他字符、时间轴。"""
    try:
        validate_params(req.columns, req.max_lines)
        results = layout_subtitles(
            [{"id": s.id, "text": s.text} for s in req.subtitles],
            req.columns,
            req.max_lines,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    feasible = sum(1 for r in results if r.feasible)
    changed = sum(1 for r in results if r.feasible and r.changed)
    return {
        "columns": req.columns,
        "max_lines": req.max_lines,
        "total": len(results),
        "feasible_count": feasible,
        "infeasible_count": len(results) - feasible,
        "change_count": changed,
        "results": [r.as_dict() for r in results],
    }


@app.post("/api/typeset/export")
def typeset_export(req: TypesetExportRequest):
    """导出「排版版」SRT：只写入已接受的换行；未排版条目原样保留。

    服务端对每条建议做字素簇级校验：除允许的换行增删 / 空白替换外，
    其他字符顺序必须与原文一致；与普通导出一样，有冲突时拒绝导出。
    """
    if not req.subtitles:
        raise HTTPException(status_code=400, detail="没有可导出的字幕")
    # 用映射时间做冲突检查（TypesetSubtitle 同样具备 id/start_ms/end_ms）
    items, conflicts = compute_timeline(req.subtitles, req.anchors, req.locks)
    if conflicts:
        raise HTTPException(
            status_code=400,
            detail="存在冲突，禁止导出：" + "；".join(c["message"] for c in conflicts),
        )
    violations: list[str] = []
    text_by_id: dict[int, str] = {}
    for s in req.subtitles:
        if s.text == s.original_text:
            text_by_id[s.id] = s.text
            continue
        reason = validate_relayout(s.original_text, s.text)
        if reason is not None:
            violations.append(f"字幕 #{s.id} 的排版不合法：{reason}")
        else:
            text_by_id[s.id] = s.text
    if violations:
        raise HTTPException(
            status_code=400,
            detail="排版方案含有换行以外的改动，已拒绝导出：" + "；".join(violations),
        )
    srt_text = build_srt(
        [
            {"start_ms": it.new_start_ms, "end_ms": it.new_end_ms,
             "text": text_by_id.get(it.id, "")}
            for it in items
        ]
    )
    return PlainTextResponse(
        srt_text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="typeset.srt"'},
    )


@app.post("/api/project/save")
def project_save(req: ProjectSaveRequest):
    """构建 .stc 校准工程 JSON。时间均为毫秒整数。"""
    try:
        project = build_project(
            req.content,
            [a.model_dump() for a in req.anchors],
            req.locks,
            [
                {"anchors": [a.model_dump() for a in snap.anchors], "locks": snap.locks}
                for snap in req.history
            ],
            anchor_seq=req.anchor_seq,
            saved_at=req.saved_at,
        )
    except ProjectError as exc:
        raise _project_error(exc) from exc
    except ValueError as exc:  # 当前内容无法解析为 SRT
        raise HTTPException(status_code=400, detail={"code": "current_invalid",
                                                     "message": "当前 SRT 无法解析",
                                                     "reasons": [str(exc)]}) from exc
    return JSONResponse(
        project,
        headers={"Content-Disposition": 'attachment; filename="calibration.stc"'},
    )


@app.post("/api/project/load")
def project_load(req: ProjectLoadRequest):
    """把 .stc 工程恢复到当前 SRT：摘要相同直接恢复，否则按指纹迁移。

    任何无法一一对应的情况返回 400 且 detail.reasons 列明原因，
    由前端保持当前工作区不变。
    """
    try:
        res = restore_project(req.project, req.content)
    except ProjectError as exc:
        raise _project_error(exc) from exc
    return result_as_dict(res)
