#!/usr/bin/env python3
"""Read one slice of the LFMC history archive.

The archive stays where it is. This script only prints. It refuses a request
that would dump the whole file. Long lines are shortened unless --full-lines
is set, because a few JSON lines are longer than 100KB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.json"


def load_jsonl(name: str) -> list[dict]:
    path = HERE / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def check_hash(archive: Path, manifest: dict) -> None:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expect = manifest["archive"]["sha256"]
    if digest != expect:
        raise SystemExit(
            f"archive sha256 {digest} does not match the index ({expect}). "
            "Line numbers in this index belong to that exact file."
        )


def extract(archive: Path, start: int, end: int, full_lines: bool, width: int) -> list[str]:
    if start < 1 or end < start:
        raise SystemExit(f"bad range {start}:{end}")
    out = []
    with archive.open(encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if n < start:
                continue
            if n > end:
                break
            line = line.rstrip("\n")
            if not full_lines and len(line) > width:
                line = line[: width - 1] + "…"
            out.append(f"{n}|{line}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--archive", type=Path, help="path to 12_天际翻译插件修正.md")
    ap.add_argument("--message", type=int, help="message number, 1..395")
    ap.add_argument("--lines", help="inclusive line range, for example 35027:35055")
    ap.add_argument("--chapter", type=int, help="chapter number, 1..195")
    ap.add_argument("--topic", help="list chapters whose human turn carries this topic")
    ap.add_argument("--errors", action="store_true", help="list tool calls flagged is_error")
    ap.add_argument("--no-hash", action="store_true")
    ap.add_argument("--full-lines", action="store_true")
    ap.add_argument("--width", type=int, default=400)
    ap.add_argument("--max-lines", type=int, default=400)
    args = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    if args.topic or args.errors or (args.chapter and not args.archive):
        if args.errors:
            rows = json.loads((HERE / "tool-errors.json").read_text(encoding="utf-8"))
            for row in rows:
                print(f"m{row['msg']} {row['tool']} L{row['lines'][0]}-{row['lines'][1]} {row['preview']}")
            return
        chapters = load_jsonl("chapters.jsonl")
        if args.topic:
            chapters = [c for c in chapters if args.topic in c.get("topics", [])]
        if args.chapter:
            chapters = [c for c in chapters if c["chapter"] == args.chapter]
        for c in chapters:
            docs = ",".join(c["documents"]) if c["documents"] else "-"
            print(
                f"c{c['chapter']:03d} m{c['human_msg']:03d} L{c['lines'][0]}-{c['lines'][1]} "
                f"{c['timestamp_taipei']} tools={c['tool_calls']} err={c['tool_errors']} "
                f"topics={','.join(c['topics']) or '-'} docs={docs}"
            )
            print(f"    {c['text_preview']}")
        return

    if args.archive is None:
        raise SystemExit("pass --archive to print transcript lines, or --topic/--errors to search the index")
    if not args.no_hash:
        check_hash(args.archive, manifest)

    if args.chapter:
        chapters = load_jsonl("chapters.jsonl")
        match = [c for c in chapters if c["chapter"] == args.chapter]
        if not match:
            raise SystemExit(f"no chapter {args.chapter}")
        start, end = match[0]["lines"]
    elif args.message:
        messages = load_jsonl("messages.jsonl")
        match = [m for m in messages if m["n"] == args.message]
        if not match:
            raise SystemExit(f"no message {args.message}")
        start, end = match[0]["lines"]
    elif args.lines:
        a, b = args.lines.split(":", 1)
        start, end = int(a), int(b)
    else:
        raise SystemExit("pass --message, --chapter, or --lines")

    span = end - start + 1
    if span > args.max_lines:
        raise SystemExit(
            f"range {start}:{end} is {span} lines, above --max-lines {args.max_lines}. "
            "Narrow it, or raise --max-lines. Do not read the whole archive into a prompt."
        )
    sys.stdout.write("\n".join(extract(args.archive, start, end, args.full_lines, args.width)) + "\n")


if __name__ == "__main__":
    main()
