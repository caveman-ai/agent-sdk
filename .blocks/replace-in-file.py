#!/usr/bin/env python3
# /// block
# name = "replace-in-file"
# summary = "Replace exact text in a file, failing unless the match count is as expected; returns a diff head."
# effects = "write-workspace"
# example = ["--path", "$FIXTURES/settings.ini", "--old", "debug = false", "--new", "debug = true", "--dry-run"]
# matches = ['\.read\(\)[\s\S]*\.replace\([\s\S]*\.write\(', 'read_text\(\)[\s\S]*write_text\(']
#
# [returns]
# keys = ["matches", "replaced", "diff_head", "dry_run"]
# doc = "matches is how often old occurs; replaced is how many were written (0 on a dry run); diff_head is the first 20 unified diff lines; a count mismatch exits 1 and writes nothing"
#
# [params]
# path = { type = "path", required = true, help = "File to edit inside the repo" }
# old = { type = "str", required = true, help = "Exact text to find" }
# new = { type = "str", required = true, help = "Replacement text" }
# count = { type = "int", default = 1, min = 0, help = "Matches expected; 0 means replace all, at least one" }
# dry-run = { type = "bool", default = false, help = "Show the diff without writing" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:replace-in-file@0.1.0"
#
# [stamp]
# verified = "7a6e17a42e94"
# ///
"""Replace exact text in a file after asserting how many times it occurs, and print a diff head."""
import argparse
import difflib
import json
import os
import shutil
import sys
import tempfile

DIFF_LINES = 20
MAX_LINE = 160


def write_atomically(path, text):
    """Write text next to path, then rename over it, so a crash never leaves half a file."""
    folder = os.path.dirname(os.path.abspath(path))
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=folder, delete=False) as fh:
        fh.write(text)
    shutil.copymode(path, fh.name)
    os.replace(fh.name, path)


def replace(path, old, new, count, dry_run):
    if not old:
        raise ValueError("--old must not be empty")
    with open(path, encoding="utf-8", newline="") as fh:
        text = fh.read()
    found = text.count(old)
    if count == 0 and found == 0:
        raise ValueError("expected at least 1 match, found 0")
    if count and found != count:
        raise ValueError(f"expected {count} match{'es' if count != 1 else ''}, found {found}")

    updated = text.replace(old, new)
    name = os.path.basename(path)
    diff = difflib.unified_diff(
        text.splitlines(), updated.splitlines(), f"a/{name}", f"b/{name}", lineterm=""
    )
    diff_head = [line[:MAX_LINE] for _, line in zip(range(DIFF_LINES), diff)]
    if not dry_run:
        write_atomically(path, updated)
    return {"matches": found, "replaced": 0 if dry_run else found, "diff_head": diff_head, "dry_run": dry_run}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, help="File to edit inside the repo")
    parser.add_argument("--old", required=True, help="Exact text to find")
    parser.add_argument("--new", required=True, help="Replacement text")
    parser.add_argument("--count", type=int, default=1, help="Matches expected; 0 means replace all, at least one")
    parser.add_argument("--dry-run", action="store_true", help="Show the diff without writing")
    args = parser.parse_args()
    if args.count < 0:
        parser.error("--count must be 0 or more")
    return replace(args.path, args.old, args.new, args.count, args.dry_run)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
