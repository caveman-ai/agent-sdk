#!/usr/bin/env python3
# /// block
# name = "first-error"
# summary = "First error line in a log file: its line number, the match and the lines around it."
# effects = "read"
# example = ["--path", "$FIXTURES/build.log", "--context", "3"]
# matches = ['(error|Error|FAIL|Traceback).*re\.(search|findall)', 're\.(search|findall)\(.*(error|Error|ERROR|FAIL|Traceback)']
#
# [returns]
# keys = ["line", "match", "context", "total_matches", "truncated"]
# doc = "line is the 1-based number of the first matching line or null; context is that line with its neighbours as 'N: text'; total_matches counts every matching line in the file"
#
# [params]
# path = { type = "path", required = true, help = "Log file inside the repo" }
# context = { type = "int", default = 5, min = 0, max = 20, help = "Lines to show before and after the match" }
# patterns = { type = "str", default = "Traceback,\\berror\\b,Error\\b,ERROR,FAIL,panic:,fatal:,Exception", help = "Comma-separated regexes; a line matching any of them is an error" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:first-error@0.1.0"
#
# [stamp]
# verified = "31dea9e8a785"
# ///
"""Find the first line of a log that matches an error pattern and print it with its context."""
import argparse
import collections
import json
import re
import sys

DEFAULT_PATTERNS = r"Traceback,\berror\b,Error\b,ERROR,FAIL,panic:,fatal:,Exception"
MAX_LINE = 160


def scan(path, context, patterns):
    try:
        regex = re.compile("|".join(f"(?:{p})" for p in patterns.split(",") if p))
    except re.error as exc:
        raise ValueError(f"bad pattern: {exc}") from None
    before = collections.deque(maxlen=context)
    first, after, total = None, [], 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for number, text in enumerate(fh, 1):
            text = text.rstrip("\r\n")
            hit = regex.search(text)
            total += bool(hit)
            if first is None:
                if hit:
                    first = (number, text)
                else:
                    before.append((number, text))
            elif len(after) < context:
                after.append((number, text))

    if first is None:
        return {"line": None, "match": None, "context": [], "total_matches": 0, "truncated": False}
    truncated = False
    lines = []
    for number, text in [*before, first, *after]:
        truncated = truncated or len(text) > MAX_LINE
        lines.append(f"{number}: {text[:MAX_LINE]}")
    return {
        "line": first[0],
        "match": first[1][:MAX_LINE],
        "context": lines,
        "total_matches": total,
        "truncated": truncated,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, help="Log file inside the repo")
    parser.add_argument("--context", type=int, default=5, help="Lines to show before and after the match (0-20)")
    parser.add_argument("--patterns", default=DEFAULT_PATTERNS, help="Comma-separated regexes; a line matching any is an error")
    args = parser.parse_args()
    if not 0 <= args.context <= 20:
        parser.error("--context must be between 0 and 20")
    return scan(args.path, args.context, args.patterns)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
