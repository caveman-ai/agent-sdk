#!/usr/bin/env python3
# /// block
# name = "wait-for"
# summary = "Wait until a file exists, optionally containing a regex; return whether it happened and when."
# effects = "read"
# example = ["--path", "$FIXTURES/server.log", "--pattern", "listening on", "--timeout", "5"]
# matches = ['\b(while|for)\b[^\n]*:([^\n]*\n[ \t]+)*?[^\n]*time\.sleep\(']
#
# [returns]
# keys = ["met", "elapsed_s", "last_line", "timed_out"]
# doc = "met is true once the file exists (and matches the pattern if given); last_line is the file's last non-empty line or null; a timeout is an answer, not an error"
#
# [params]
# path = { type = "path", required = true, help = "File to wait for" }
# pattern = { type = "str", default = "", help = "Regex the file content must match; empty means existing is enough" }
# timeout = { type = "float", default = 60.0, min = 0, max = 3600, help = "Seconds to wait before giving up" }
# interval = { type = "float", default = 2.0, min = 0.1, max = 60, help = "Seconds between checks" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:wait-for@0.1.0"
#
# [stamp]
# verified = "2eb9db9d4a66"
# ///
"""Poll until a file exists and optionally matches a regex, then report whether and when."""
import argparse
import json
import os
import re
import sys
import time

MAX_LINE = 200


def check(path, regex):
    """Return (condition met, last non-empty line or None)."""
    if not os.path.isfile(path):
        return False, None
    # ponytail: rereads the whole file each poll; track an offset if multi-GB logs show up
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    lines = [line for line in text.splitlines() if line.strip()]
    last = lines[-1][:MAX_LINE] if lines else None
    return (regex is None or regex.search(text) is not None), last


def wait(path, pattern, timeout, interval):
    try:
        regex = re.compile(pattern) if pattern else None
    except re.error as exc:
        raise ValueError(f"bad pattern: {exc}") from None
    started = time.monotonic()
    while True:
        met, last = check(path, regex)
        elapsed = time.monotonic() - started
        if met or elapsed >= timeout:
            break
        time.sleep(min(interval, timeout - elapsed))
    return {"met": met, "elapsed_s": round(elapsed, 2), "last_line": last, "timed_out": not met}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, help="File to wait for")
    parser.add_argument("--pattern", default="", help="Regex the file content must match; empty means existing is enough")
    parser.add_argument("--timeout", type=float, default=60, help="Seconds to wait before giving up (0-3600)")
    parser.add_argument("--interval", type=float, default=2, help="Seconds between checks (0.1-60)")
    args = parser.parse_args()
    if not 0 <= args.timeout <= 3600:
        parser.error("--timeout must be between 0 and 3600")
    if not 0.1 <= args.interval <= 60:
        parser.error("--interval must be between 0.1 and 60")
    return wait(args.path, args.pattern, args.timeout, args.interval)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
