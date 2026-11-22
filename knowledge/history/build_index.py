#!/usr/bin/env python3
"""Build a structural index of the LFMC Claude history archive.

Reads the archive and writes index files. Never writes to the archive path.
Does not copy tool payloads or embedded third-party source into the index.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=8))
SRC = Path("/agent/repos/BUG-Test-addon-world/The History(Important)/12_天际翻译插件修正.md")
OUT = Path("/workspace/knowledge/history")
ARCHIVE_COMMIT = "0261ab9b0228c0a6b3849ec02d0e9b2af9424be3"
ARCHIVE_REPO = "zanesu154-rgb/BUG-Test-addon-world"
ARCHIVE_PATH = "The History(Important)/12_天际翻译插件修正.md"

MSG_RE = re.compile(r"^## (\d+)\. (human|assistant) — ([0-9T:\.\-]+Z)$")
UUID_RE = re.compile(r"^消息 UUID：`([^`]+)`$")
BLK_RE = re.compile(r"^### 内容块 (\d+)：([A-Za-z0-9_]+)$")
ATT_RE = re.compile(r"^### 附件 (\d+)：\s*(.*)$")
SECRET_RE = re.compile(
    r"(ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|gho_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|"
    r"x-access-token[^\s]*|Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9]+|AKIA[0-9A-Z]{16})",
    re.I,
)

TOPIC_RULES = [
    ("site_chrome", ("访问次数", "LED", "荧幕", "赞助", "页面布局", "工具名", "Localizator", "底部版本", "注意事项", "访客计数", "电子钟", "视频", "服务挂了", "Chinese only", "更新日志")),
    ("repo_workflow", ("github", "推送", "合并", "Release", "release", "更新日志", "README", "开源协议", "Issue", "BUG Report", "仓库", "changelog", "样包")),
    ("world_nbt", ("世界文件", "世界存档", "地图", "命令方块", "告示牌", "nbt", "mcstructure", "盔甲架", "成书", "mcworld", "/say", "/me", "tellraw", "titleraw", "展示框", "悬挂", "loot", "计分板", "nameTag", "name=", "血条", "bossbar", "Lore", "lore")),
    ("lang_files", ("lang", "多语言", "多语种", "语言文件", "同一份", "混在一起", "分离", "zh_CN", "en_US", "映射", "语言的判定", "葡萄牙语", "pack.name")),
    ("log_output", ("日志",)),
    ("false_positive", ("误提取", "误翻", "错误地把", "错误提取", "不该被提取", "误提", "debug", "正则", "判断式")),
    ("missed_text", ("漏", "没映射", "未映射", "没有被提取", "没被提取", "遗漏", "没被选中", "没有转译", "不全", "没找到", "没有被选", "还剩了一些", "又找到了一处", "错位", "截断", "全是英文")),
    ("ui_json", ("jsonui", "自定义UI", "自定义ui", "hud", "HUD", "panel", "UI文本", "动作栏", "沉浸式工作台")),
    ("glossary", ("翻译表", "csv", "黑名单", "人工翻译", "人工转化")),
    ("reconvert", ("二次", "再转化", "覆盖", "重导入", "重提取", "转换过", "原包", "原始附加包")),
    ("pack_hygiene", ("重复包", "无效", "World Edit", "Resource_packs", "多个包", "混在一起", "自带包")),
    ("version", ("版本", "min_engine", "MiniVersion", "api")),
    ("keys_and_placeholders", ("百分号", "%%", "@翻译键", "翻译键", "split", "translate", "toast", "%1", "%3")),
    ("hidden_items", ("创造物品栏", "隐藏物品", "刷怪蛋", "menu_category")),
    ("runtime_error", ("报错", "失败", "is not defined", "not a function", "TypeError", "Cannot read", "卡死", "导不进去", "怎么回事")),
    ("user_check", ("可以的", "正常", "修好", "没问题", "实测", "测试了", "显示正常", "使用正常", "我自己测试", "可以被转译", "可以显示", "好了一部分")),
]


def redact(s: str, limit: int) -> str:
    if not s:
        return ""
    s = SECRET_RE.sub("[redacted]", s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > limit:
        return s[: limit - 1] + "…"
    return s


def prose_preview(text: str, limit: int = 220) -> tuple[str, bool]:
    """First-person prose only. Collapse fenced or JSON-looking lines."""
    kept = []
    embedded = False
    for line in text.split("\n"):
        raw = line.strip()
        if not raw:
            continue
        if raw == "This block is not supported on your current device yet.":
            embedded = True
            continue
        if raw.startswith("```") or raw.startswith("{") or raw.startswith("[") or raw.startswith("const ") or raw.startswith("function ") or raw.startswith('"') or raw.startswith("script.") or raw.startswith("ui.") or raw.startswith("item.") or raw.startswith("tile.") or raw.startswith("world.") or "format_version" in raw:
            embedded = True
            continue
        if raw.count("{") + raw.count("}") >= 2 or len(raw) > 280:
            embedded = True
            continue
        kept.append(raw)
        if sum(len(x) for x in kept) > limit:
            break
    preview = redact(" ".join(kept), limit)
    return preview, embedded or (len(text) > 400 and not preview)


def parse_json_fence(lines: list[str], fence_idx: int) -> tuple[dict | None, int, str | None]:
    """Parse one JSON value starting the line after a ```json fence.

    fence_idx is 0-based. Returns (obj, fence_end_line_1based, error).
    Brace depth is string-aware so braces inside strings do not end the value.
    """
    i = fence_idx + 1
    buf: list[str] = []
    depth = 0
    started = False
    in_str = False
    esc = False
    done = None
    while i < len(lines):
        buf.append(lines[i])
        for ch in lines[i]:
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch in "{[":
                depth += 1
                started = True
            elif ch in "}]":
                depth -= 1
                if started and depth == 0:
                    done = i
                    break
        if done is not None:
            break
        i += 1
    if done is None:
        return None, fence_idx + 1, "unclosed-json"
    raw = "\n".join(buf[: done - fence_idx])
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, done + 1, f"json:{e.msg}"
    k = done + 1
    while k < len(lines) and lines[k].strip() == "":
        k += 1
    if k >= len(lines) or lines[k] != "```":
        return obj if isinstance(obj, dict) else None, done + 1, "missing-close-fence"
    return obj if isinstance(obj, dict) else None, k, None


def topics_for(text: str) -> list[str]:
    low = text.lower()
    hits = []
    for name, keys in TOPIC_RULES:
        for k in keys:
            if k.lower() in low or k in text:
                hits.append(name)
                break
    return hits


def taipei(ts: str) -> str:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(TZ)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def main() -> None:
    raw = SRC.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8")
    if "\r" in text[:1000] or raw.startswith(b"\xef\xbb\xbf") or b"\x00" in raw:
        raise SystemExit("unexpected encoding markers")
    parts = text.split("\n")
    assert parts[-1] == ""
    lines = parts[:-1]
    assert len(lines) == 224122

    # unusual scalars
    fffd_lines = [i for i, l in enumerate(lines, 1) if "\ufffd" in l]
    u2028_line = None
    for i, l in enumerate(lines, 1):
        if "\u2028" in l or "\u2029" in l:
            u2028_line = i
            break

    messages: list[dict] = []
    cur: dict | None = None

    def close(end_line: int) -> None:
        nonlocal cur
        if cur is None:
            return
        cur["line_end"] = end_line
        messages.append(cur)
        cur = None

    i = 0
    while i < len(lines):
        line = lines[i]
        m = MSG_RE.match(line)
        if m:
            if cur is not None:
                close(i)
            cur = {
                "n": int(m.group(1)),
                "role": m.group(2),
                "timestamp": m.group(3),
                "line_start": i + 1,
                "uuid": None,
                "text_lines": [],
                "in_text": False,
                "blocks": [],
                "attachments": [],
            }
            i += 1
            continue
        if cur is None:
            i += 1
            continue
        um = UUID_RE.match(line)
        if um and cur["uuid"] is None:
            cur["uuid"] = um.group(1)
            i += 1
            continue
        if line == "### 消息文本":
            cur["in_text"] = True
            cur["text_line_start"] = i + 1
            i += 1
            continue
        bm = BLK_RE.match(line)
        am = ATT_RE.match(line)
        if bm or am:
            cur["in_text"] = False
            if bm:
                label = bm.group(2)
                rec = {
                    "kind": "block",
                    "n": int(bm.group(1)),
                    "label": label,
                    "line_start": i + 1,
                }
                cur["blocks"].append(rec)
            else:
                rec = {
                    "kind": "attachment",
                    "n": int(am.group(1)),
                    "title_hint": am.group(2).strip(),
                    "line_start": i + 1,
                    "label": "attachment",
                }
                cur["attachments"].append(rec)
            # payload: next non-empty line may be ```json
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            if j < len(lines) and lines[j] == "```json":
                obj, end_idx, err = parse_json_fence(lines, j)
                rec["json"] = obj
                rec["json_error"] = err
                rec["json_line_start"] = j + 1
                rec["line_end"] = end_idx + 1  # closing fence, 1-based index = end_idx+1
                # text blocks are not json; if a text block somehow starts with json, keep it
                i = end_idx + 1
                continue
            # non-json body until next heading
            k = i + 1
            body = []
            while k < len(lines) and not lines[k].startswith("## ") and not lines[k].startswith("### "):
                body.append(lines[k])
                k += 1
            rec["body"] = "\n".join(body).strip()
            rec["line_end"] = k  # line before next heading; k is 0-based next heading so line number k
            i = k
            continue
        if cur["in_text"]:
            cur["text_lines"].append(line)
        i += 1
    if cur is not None:
        close(len(lines))

    for m in messages:
        while m["text_lines"] and m["text_lines"][-1] == "":
            m["text_lines"].pop()
        m["text"] = "\n".join(m["text_lines"]).strip()

    anomalies: list[str] = []
    if [m["n"] for m in messages] != list(range(1, 396)):
        anomalies.append("message numbers are not 1..395")
    if len({m["uuid"] for m in messages}) != len(messages):
        anomalies.append("duplicate message uuid")
    if any(not m["uuid"] for m in messages):
        anomalies.append("missing message uuid")

    prev = None
    backwards = 0
    for m in messages:
        dt = datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
        if prev and dt < prev:
            backwards += 1
        prev = dt
    if backwards:
        anomalies.append(f"timestamp regressions: {backwards}")

    uses = []
    results = []
    docs = []
    images = []
    thinking_empty = 0
    thinking_summaries = 0
    thinking_n = 0
    type_mismatch = []
    json_errors = []
    integrations = Counter()
    tool_names = Counter()
    text_dup = 0
    text_unique = 0
    placeholder_mismatch = 0

    for m in messages:
        ph = sum(1 for t in m["text"].split("\n") if t.strip() == "This block is not supported on your current device yet.")
        tu = sum(1 for b in m["blocks"] if b["label"] == "tool_use")
        if ph != tu:
            placeholder_mismatch += 1
        nums = [b["n"] for b in m["blocks"]]
        if nums != list(range(1, len(nums) + 1)):
            anomalies.append(f"block numbers not contiguous in message {m['n']}")
        for b in m["blocks"]:
            if b["label"] == "text":
                body = b.get("body", "").strip()
                if body.endswith("---"):
                    body = body[:-3].strip()
                if body == "（与消息文本相同）":
                    text_dup += 1
                else:
                    text_unique += 1
                b["text_class"] = "same_as_message_text" if body == "（与消息文本相同）" else "continuation"
                b["body_preview"], b["body_embedded"] = prose_preview(body, 180)
                b["body_chars"] = len(body)
                continue
            obj = b.get("json")
            err = b.get("json_error")
            if err:
                json_errors.append(f"m{m['n']} {b['label']} {err}")
            if not isinstance(obj, dict):
                json_errors.append(f"m{m['n']} block {b['n']} {b['label']} missing-json")
                continue
            if obj.get("type") != b["label"]:
                type_mismatch.append(f"m{m['n']} block {b['n']} header {b['label']} json {obj.get('type')}")
            if b["label"] == "thinking":
                thinking_n += 1
                if not (obj.get("thinking") or ""):
                    thinking_empty += 1
                sums = [s.get("summary", "") for s in (obj.get("summaries") or []) if isinstance(s, dict)]
                b["summaries"] = [redact(s, 180) for s in sums if s]
                if b["summaries"]:
                    thinking_summaries += 1
            elif b["label"] == "tool_use":
                integrations[obj.get("integration_name") or ""] += 1
                tool_names[obj.get("name") or ""] += 1
                inp = obj.get("input") if isinstance(obj.get("input"), dict) else {}
                uses.append({
                    "msg": m["n"],
                    "block": b["n"],
                    "lines": [b["line_start"], b["line_end"]],
                    "id": obj.get("id"),
                    "name": obj.get("name"),
                    "input": inp,
                })
            elif b["label"] == "tool_result":
                results.append({
                    "msg": m["n"],
                    "block": b["n"],
                    "lines": [b["line_start"], b["line_end"]],
                    "tool_use_id": obj.get("tool_use_id"),
                    "is_error": bool(obj.get("is_error")),
                    "content": obj.get("content"),
                })
            elif b["label"] == "document":
                docs.append({
                    "msg": m["n"],
                    "block": b["n"],
                    "lines": [b["line_start"], b["line_end"]],
                    "title": obj.get("title"),
                    "file_uuid": obj.get("file_uuid"),
                    "sandbox_upload_name": obj.get("sandbox_upload_name"),
                    "sandbox_upload_size": obj.get("sandbox_upload_size"),
                    "timestamp": m["timestamp"],
                })
            elif b["label"] == "image":
                images.append({
                    "msg": m["n"],
                    "block": b["n"],
                    "lines": [b["line_start"], b["line_end"]],
                    "file_uuid": obj.get("file_uuid"),
                    "source_is_null": obj.get("source") is None,
                    "timestamp": m["timestamp"],
                })
        for a in m["attachments"]:
            obj = a.get("json") or {}
            content = obj.get("extracted_content")
            a["file_name"] = obj.get("file_name") or a.get("title_hint") or ""
            a["file_size"] = obj.get("file_size")
            a["file_type"] = obj.get("file_type")
            a["extracted_chars"] = len(content) if isinstance(content, str) else 0

    use_by = {}
    dup_use = []
    for u in uses:
        if u["id"] in use_by:
            dup_use.append(u["id"])
        use_by[u["id"]] = u
    res_by = {}
    dup_res = []
    orphan_res = []
    for r in results:
        if r["tool_use_id"] in res_by:
            dup_res.append(r["tool_use_id"])
        res_by[r["tool_use_id"]] = r
        if r["tool_use_id"] not in use_by:
            orphan_res.append(r["tool_use_id"])
    missing_res = [i for i in use_by if i not in res_by]
    order_bad = 0
    cross_msg = 0
    for i, u in use_by.items():
        r = res_by.get(i)
        if not r:
            continue
        if r["lines"][0] <= u["lines"][1]:
            order_bad += 1
        if r["msg"] != u["msg"]:
            cross_msg += 1

    def result_head(content, limit=160) -> str:
        if isinstance(content, list):
            bits = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    bits.append(c.get("text") or "")
                elif isinstance(c, str):
                    bits.append(c)
            return redact(" ".join(bits), limit)
        if isinstance(content, str):
            return redact(content, limit)
        return ""

    errors = []
    for r in results:
        if not r["is_error"]:
            continue
        u = use_by.get(r["tool_use_id"])
        errors.append({
            "msg": r["msg"],
            "tool": u["name"] if u else "",
            "lines": r["lines"],
            "preview": result_head(r["content"], 160),
        })

    # safe input fields only
    SAFE_KEYS = ("description", "query", "url", "subject", "status", "method", "caption", "display", "repo", "owner")

    def safe_input(inp: dict) -> dict:
        out = {}
        for k in SAFE_KEYS:
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                out[k] = redact(v, 160)
        for k in ("file_path", "path", "directory"):
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                out[k + "_base"] = redact(Path(v).name, 80)
        return out

    OUT.mkdir(parents=True, exist_ok=True)

    # messages jsonl
    msg_path = OUT / "messages.jsonl"
    chapter_path = OUT / "chapters.jsonl"
    block_path = OUT / "blocks.jsonl"
    pair_path = OUT / "tool-pairs.jsonl"
    att_path = OUT / "attachments.jsonl"

    role_counts = Counter(m["role"] for m in messages)
    aa = []
    empty_assistant = []
    for a, b in zip(messages, messages[1:]):
        if a["role"] == "assistant" and b["role"] == "assistant":
            aa.append(b["n"])
    for m in messages:
        if m["role"] == "assistant" and not m["text"] and not m["blocks"]:
            empty_assistant.append(m["n"])

    by_topic = {name: [] for name, _ in TOPIC_RULES}
    unmatched = []

    with msg_path.open("w", encoding="utf-8") as mf, block_path.open("w", encoding="utf-8") as bf:
        for m in messages:
            preview, embedded = prose_preview(m["text"], 240)
            tags = topics_for(m["text"]) if m["role"] == "human" else []
            if m["role"] == "human":
                if tags:
                    for t in tags:
                        by_topic[t].append(m["n"])
                else:
                    unmatched.append(m["n"])
            channel = "user_utterance" if m["role"] == "human" else "assistant_utterance"
            rec = {
                "n": m["n"],
                "role": m["role"],
                "uuid": m["uuid"],
                "timestamp": m["timestamp"],
                "timestamp_taipei": taipei(m["timestamp"]),
                "lines": [m["line_start"], m["line_end"]],
                "channel": channel,
                "epistemic": "historical_utterance_not_current_rule",
                "text_chars": len(m["text"]),
                "text_preview": preview,
                "embedded_code_omitted": embedded,
                "topics": tags,
                "block_counts": dict(Counter(b["label"] for b in m["blocks"])),
                "attachment_count": len(m["attachments"]),
            }
            mf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            for b in m["blocks"]:
                brow = {
                    "msg": m["n"],
                    "block": b["n"],
                    "type": b["label"],
                    "lines": [b["line_start"], b.get("line_end")],
                    "channel": {
                        "thinking": "model_thinking",
                        "tool_use": "tool_invocation",
                        "tool_result": "tool_output",
                        "text": "assistant_utterance",
                        "document": "attachment_ref",
                        "image": "attachment_ref",
                    }.get(b["label"], b["label"]),
                    "epistemic": "not_a_current_rule",
                }
                if b["label"] == "text":
                    brow["text_class"] = b.get("text_class")
                    brow["text_chars"] = b.get("body_chars")
                    if b.get("text_class") != "same_as_message_text":
                        brow["text_preview"] = b.get("body_preview")
                        brow["embedded_code_omitted"] = b.get("body_embedded")
                if b["label"] == "thinking":
                    brow["thinking_body_exported"] = False
                    brow["summaries"] = b.get("summaries") or []
                bf.write(json.dumps(brow, ensure_ascii=False) + "\n")

    with pair_path.open("w", encoding="utf-8") as pf:
        for u in uses:
            r = res_by.get(u["id"])
            row = {
                "tool_use_id": u["id"],
                "name": u["name"],
                "msg": u["msg"],
                "use_block": u["block"],
                "use_lines": u["lines"],
                "result_block": r["block"] if r else None,
                "result_lines": r["lines"] if r else None,
                "same_message": bool(r and r["msg"] == u["msg"]),
                "is_error": r["is_error"] if r else None,
                "input": safe_input(u["input"]),
                "channel_use": "tool_invocation",
                "channel_result": "tool_output",
                "epistemic": "historical_tool_exchange_not_current_rule",
            }
            if r and r["is_error"]:
                row["error_preview"] = result_head(r["content"], 180)
            pf.write(json.dumps(row, ensure_ascii=False) + "\n")

    with att_path.open("w", encoding="utf-8") as af:
        for d in docs:
            af.write(json.dumps({
                "kind": "document",
                "msg": d["msg"],
                "block": d["block"],
                "lines": d["lines"],
                "timestamp_taipei": taipei(d["timestamp"]),
                "title": d["title"],
                "file_uuid": d["file_uuid"],
                "sandbox_upload_name": d["sandbox_upload_name"],
                "sandbox_upload_size": d["sandbox_upload_size"],
                "bytes_in_archive": False,
                "channel": "attachment_ref",
            }, ensure_ascii=False) + "\n")
        for im in images:
            af.write(json.dumps({
                "kind": "image",
                "msg": im["msg"],
                "block": im["block"],
                "lines": im["lines"],
                "timestamp_taipei": taipei(im["timestamp"]),
                "file_uuid": im["file_uuid"],
                "pixels_in_archive": False,
                "channel": "attachment_ref",
            }, ensure_ascii=False) + "\n")
        for m in messages:
            for a in m["attachments"]:
                af.write(json.dumps({
                    "kind": "extracted_attachment",
                    "msg": m["n"],
                    "attachment": a["n"],
                    "lines": [a["line_start"], a.get("line_end")],
                    "file_name": a.get("file_name") or "",
                    "file_size": a.get("file_size"),
                    "file_type": a.get("file_type"),
                    "extracted_chars": a.get("extracted_chars"),
                    "bytes_copied_to_index": False,
                    "channel": "attachment_extract",
                }, ensure_ascii=False) + "\n")

    # chapters: human turn + following assistant turns
    chapters = []
    idx = 0
    while idx < len(messages):
        if messages[idx]["role"] != "human":
            # leading assistant should not happen; attach to nowhere
            idx += 1
            continue
        h = messages[idx]
        group = [h]
        k = idx + 1
        while k < len(messages) and messages[k]["role"] == "assistant":
            group.append(messages[k])
            k += 1
        docs_here = [d["title"] or "(untitled)" for d in docs if d["msg"] == h["n"]]
        tool_n = sum(1 for u in uses if any(u["msg"] == g["n"] for g in group))
        err_n = sum(1 for e in errors if any(e["msg"] == g["n"] for g in group))
        preview, embedded = prose_preview(h["text"], 240)
        ch = {
            "chapter": len(chapters) + 1,
            "human_msg": h["n"],
            "assistant_msgs": [g["n"] for g in group[1:]],
            "lines": [h["line_start"], group[-1]["line_end"]],
            "timestamp_taipei": taipei(h["timestamp"]),
            "topics": topics_for(h["text"]),
            "text_preview": preview,
            "embedded_code_omitted": embedded,
            "documents": docs_here,
            "tool_calls": tool_n,
            "tool_errors": err_n,
            "epistemic": "retrieval_unit_not_a_spec",
        }
        chapters.append(ch)
        idx = k
    with chapter_path.open("w", encoding="utf-8") as cf:
        for ch in chapters:
            cf.write(json.dumps(ch, ensure_ascii=False) + "\n")

    # gaps
    def dt_of(ts):
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))

    gaps = []
    for a, b in zip(messages, messages[1:]):
        delta = (dt_of(b["timestamp"]) - dt_of(a["timestamp"])).total_seconds()
        if delta >= 6 * 3600 and b["role"] == "human":
            gaps.append({
                "after_msg": a["n"],
                "next_msg": b["n"],
                "hours": round(delta / 3600, 2),
                "resume_taipei": taipei(b["timestamp"]),
            })

    topic_defs = {
        "site_chrome": "网页外壳：布局、访问计数、赞助、工具自身的界面文案。",
        "repo_workflow": "仓库、推送、合并、Release、README、许可证、Issue 模板、更新日志、样包仓库。",
        "world_nbt": "世界存档、模板、结构、命令方块、告示牌、成书、盔甲架、展示框、战利品表。",
        "lang_files": "语言文件拆分、已有 lang、多语言混写、键映射。",
        "log_output": "转换日志本身：给日志加多语言、拿日志当样本、或让用户看日志。",
        "false_positive": "用户指出的误提取。这是当时的判断，需回查对应该轮工具输出。",
        "missed_text": "用户指出的漏提取或未映射。",
        "ui_json": "JSON UI、HUD、自定义界面。",
        "glossary": "人工翻译表、CSV、黑名单、不可自动本地化的文本。",
        "reconvert": "重复转换、覆盖已有语言文件、对已转换包再跑。",
        "pack_hygiene": "多包、重复包、无效包、资源包目录名。",
        "version": "引擎版本、存档版本、最低可运行版本。",
        "keys_and_placeholders": "翻译键、百分号、占位符、由键名拆出来的英文。",
        "hidden_items": "创造栏隐藏物品、刷怪蛋等是否提取。",
        "runtime_error": "转换失败、脚本报错、页面报错。",
        "user_check": "用户说自己测过、显示正常或已修好。只说明当时那一次，不是现行规格。",
    }

    topics = {
        "primary_project": {
            "id": "LFMC",
            "names_seen": [
                "天际翻译插件",
                "tianji-turn-addon",
                "栈主的附加包汉化工具",
                "Localizator for MCBE",
            ],
            "repo": "zanesu154-rgb/tianji-turn-addon",
            "note": "整份档案是这一个产品的开发会话。下面的附加包和地图是当时拿来试刀的材料，不是并列开发的项目。",
        },
        "related_repos_named_by_user": [
            {"repo": "zanesu154-rgb/tianji-turn-addon", "first_human_msg": 5, "role": "产品仓库"},
            {"repo": "zanesu154-rgb/My-sponsor-picture", "first_human_msg": 212, "role": "赞助图片"},
            {"repo": "zanesu154-rgb/web-pictures", "first_human_msg": 348, "role": "用户提到的地图发布地址"},
            {"repo": "zanesu154-rgb/BUG-Test-addon-world", "first_human_msg": 390, "role": "私有样包仓库，本档案也放在这里"},
        ],
        "sample_materials_are_not_separate_projects": True,
        "user_sample_map_message": 392,
        "user_sample_map_note": "第 392 条用户消息把若干样包和当时要记的问题对上了号。那是用户当时的归类，回查时以该条原文为准，不要把助手之前的猜测写进样包说明。",
        "topic_defs": topic_defs,
        "by_topic": by_topic,
        "human_messages_without_topic": unmatched,
        "long_pauses_hours": gaps,
    }
    (OUT / "topics.json").write_text(json.dumps(topics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "archive": {
            "repo": ARCHIVE_REPO,
            "path": ARCHIVE_PATH,
            "commit": ARCHIVE_COMMIT,
            "commit_time_taipei": "2026-11-22 13:15:22",
            "sha256": sha,
            "bytes": len(raw),
            "utf8_chars": len(text),
            "lf_lines": len(lines),
            "encoding": "utf-8",
            "bom": False,
            "nul": 0,
            "cr": 0,
        },
        "session": {
            "title": "天际翻译插件修正",
            "uuid": "82408dcb-76d6-48ec-99dd-b833ade13377",
            "created": "2026-11-07T03:14:29.396242Z",
            "created_taipei": "2026-11-07 11:14:29",
            "updated": "2026-11-21T13:16:01.094665Z",
            "updated_taipei": "2026-11-21 21:16:01",
            "first_message": messages[0]["timestamp"],
            "last_message": messages[-1]["timestamp"],
            "message_count": len(messages),
            "human": role_counts["human"],
            "assistant": role_counts["assistant"],
            "chapters": len(chapters),
        },
        "counts": {
            "content_blocks": sum(len(m["blocks"]) for m in messages),
            "tool_use": len(uses),
            "tool_result": len(results),
            "tool_errors": len(errors),
            "thinking": thinking_n,
            "thinking_body_empty": thinking_empty,
            "thinking_with_summary": thinking_summaries,
            "text_blocks_same_as_message": text_dup,
            "text_blocks_continuation": text_unique,
            "documents": len(docs),
            "images": len(images),
            "extracted_attachments": sum(len(m["attachments"]) for m in messages),
            "placeholder_mismatches": placeholder_mismatch,
            "duplicate_tool_use_ids": len(dup_use),
            "duplicate_tool_result_ids": len(dup_res),
            "results_without_use": len(orphan_res),
            "uses_without_result": len(missing_res),
            "result_before_use": order_bad,
            "pairs_across_messages": cross_msg,
            "json_errors": json_errors,
            "type_mismatch": type_mismatch,
            "anomalies": anomalies,
            "empty_assistant_messages": empty_assistant,
            "consecutive_assistant_messages": aa,
            "fffd_lines": fffd_lines,
            "unicode_line_separator_line": u2028_line,
            "integrations": dict(integrations),
            "tool_names": dict(tool_names),
        },
        "epistemic_channels": {
            "user_utterance": "用户当时写下的话。可以是要求、观察或确认，不是自动生效的现行规格。",
            "assistant_utterance": "模型当时的回复，包含后来可能被用户否定的说法。",
            "model_thinking": "思考正文没有导出。summaries 是模型自己的摘要，仍然是推测。",
            "tool_invocation": "当时发出的工具调用。索引只留安全字段，不留命令和写入内容。",
            "tool_output": "当时的工具输出，包括失败。索引只给行号；失败时另留一句短摘。",
            "attachment_ref": "上传文件只有 uuid 或标题，二进制不在档案里。",
            "attachment_extract": "有两处把文本附件摘进了档案。索引只记位置和长度。",
        },
        "index_omits": [
            "tool command bodies",
            "tool stdout and file contents",
            "Write/Edit payloads",
            "third-party addon source pasted in the transcript",
            "image pixels and document bytes",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT / "tool-errors.json").write_text(json.dumps(errors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "messages": len(messages),
        "chapters": len(chapters),
        "uses": len(uses),
        "results": len(results),
        "errors": len(errors),
        "docs": len(docs),
        "images": len(images),
        "thinking": thinking_n,
        "thinking_empty": thinking_empty,
        "thinking_summaries": thinking_summaries,
        "text_dup": text_dup,
        "text_unique": text_unique,
        "json_errors": json_errors,
        "type_mismatch": type_mismatch,
        "anomalies": anomalies,
        "orphan_res": orphan_res,
        "missing_res": missing_res,
        "order_bad": order_bad,
        "cross_msg": cross_msg,
        "dup_use": len(dup_use),
        "dup_res": len(dup_res),
        "placeholder_mismatch": placeholder_mismatch,
        "unmatched": unmatched,
        "integrations": dict(integrations),
        "tool_names": dict(tool_names),
        "fffd": len(fffd_lines),
        "u2028": u2028_line,
        "sha": sha,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--archive", type=Path, default=SRC)
    ap.add_argument("--out", type=Path, default=OUT)
    ns = ap.parse_args()
    SRC = ns.archive
    OUT = ns.out
    main()
