#!/usr/bin/env python3
# /// block
# name = "grep-defs"
# summary = "Function, class, type and constant definitions in a file or directory, with line numbers."
# effects = "read"
# example = ["--path", "$FIXTURES"]
# matches = ['re\.(compile|findall|finditer|search|match)\(.*\b(def|class|func|type)\b']
#
# [returns]
# keys = ["defs", "total", "truncated"]
# doc = "defs is a list of {file, kind, name, line, signature} (at most 60, signature cut to 100 chars); total counts every definition found; Python, Go and TS/JS by regex"
#
# [params]
# path = { type = "path", required = true, help = "Source file or directory inside the repo" }
# kinds = { type = "str", default = "def,class,func,type,const,var", help = "Comma-separated kinds to keep" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:grep-defs@0.1.0"
#
# [stamp]
# verified = "9cf71b324094"
# ///
"""List definitions in Python, Go and TypeScript/JavaScript sources with their line numbers."""
import argparse
import json
import os
import re
import sys

MAX_DEFS = 60
MAX_BYTES = 1600
MAX_SIGNATURE = 100
SKIP_DIRS = {"node_modules", "vendor", "__pycache__", "dist", "build"}

PY = [
    ("def", r"^\s*(?:async\s+)?def\s+(?P<name>\w+)"),
    ("class", r"^\s*class\s+(?P<name>\w+)"),
    ("const", r"^(?P<name>[A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)"),
]
GO = [
    ("func", r"^func\s+(?:\([^)]*\)\s*)?(?P<name>\w+)"),
    ("type", r"^type\s+(?P<name>\w+)"),
    ("const", r"^const\s+(?P<name>\w+)"),  # ponytail: grouped `const (` blocks are skipped
    ("var", r"^var\s+(?P<name>\w+)"),
]
JS = [
    ("func", r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?P<name>\w+)"),
    ("class", r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?P<name>\w+)"),
    ("type", r"^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface|enum)\s+(?P<name>\w+)"),
    ("const", r"^(?:export\s+)?const\s+(?P<name>\w+)"),
    ("var", r"^(?:export\s+)?(?:let|var)\s+(?P<name>\w+)"),
]
LANGS = {".py": PY, ".go": GO, ".ts": JS, ".tsx": JS, ".js": JS, ".jsx": JS, ".mjs": JS, ".cjs": JS}


def sources(path):
    """Yield (file path, display name) for every supported source under path."""
    if os.path.isfile(path):
        yield path, os.path.basename(path)
        return
    if not os.path.isdir(path):
        raise FileNotFoundError(f"no such file or directory: {path}")
    for root, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for name in sorted(files):
            if os.path.splitext(name)[1] in LANGS:
                full = os.path.join(root, name)
                yield full, os.path.relpath(full, path)


def find_defs(path, kinds):
    defs, total, size = [], 0, 0
    for full, shown in sources(path):
        rules = [(kind, re.compile(rx)) for kind, rx in LANGS.get(os.path.splitext(full)[1], []) if kind in kinds]
        with open(full, encoding="utf-8", errors="replace") as fh:
            for number, line in enumerate(fh, 1):
                for kind, regex in rules:
                    match = regex.match(line)
                    if not match:
                        continue
                    total += 1
                    entry = {
                        "file": shown,
                        "kind": kind,
                        "name": match["name"],
                        "line": number,
                        "signature": line.strip()[:MAX_SIGNATURE],
                    }
                    size += len(json.dumps(entry))
                    if len(defs) < MAX_DEFS and size <= MAX_BYTES:
                        defs.append(entry)
                    break
    return {"defs": defs, "total": total, "truncated": len(defs) < total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, help="Source file or directory inside the repo")
    parser.add_argument("--kinds", default="def,class,func,type,const,var", help="Comma-separated kinds to keep")
    args = parser.parse_args()
    kinds = {kind.strip() for kind in args.kinds.split(",") if kind.strip()}
    return find_defs(args.path, kinds)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
