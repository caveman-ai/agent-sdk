#!/usr/bin/env python3
# /// block
# name = "jsonl-stats"
# summary = "Row count plus counts and sums grouped by one key of a JSONL file or JSON array."
# effects = "read"
# example = ["--path", "$FIXTURES/requests.jsonl", "--group-by", "model", "--sum", "usage.cost", "--top", "5"]
# matches = ['Counter\(', 'defaultdict\(', 'statistics\.']
#
# [returns]
# keys = ["rows", "groups", "truncated", "missing"]
# doc = "groups is a list of {value, count, sum?} sorted by count, top N; keys may be dotted paths; missing counts rows without the group-by key; sum adds numeric values only"
#
# [params]
# path = { type = "path", required = true, help = "JSONL file or JSON array inside the repo" }
# group-by = { type = "str", required = true, help = "Key to group rows by; dotted path for nested keys" }
# sum = { type = "str", default = "", help = "Numeric key to sum per group; dotted path allowed" }
# top = { type = "int", default = 10, min = 1, max = 50, help = "How many groups to return" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:jsonl-stats@0.1.0"
#
# [stamp]
# verified = "66f5cfb5eb2a"
# ///
"""Count rows of a JSONL file or JSON array grouped by one key, optionally summing another key."""
import argparse
import json
import sys

MAX_VALUE = 60
MISSING = object()


def load_rows(path):
    # ponytail: reads the whole file; stream line by line if multi-GB files show up
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    except json.JSONDecodeError:
        pass  # not one document; try JSONL
    rows = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"not JSON or JSONL: line {n}: {exc.msg}") from None
    return rows


def lookup(row, dotted):
    """Value at a dotted key path, or MISSING."""
    for part in dotted.split("."):
        if not isinstance(row, dict) or part not in row:
            return MISSING
        row = row[part]
    return row


def label(value):
    """A short, hashable label for a group value."""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, sort_keys=True)
    if isinstance(value, str) and len(value) > MAX_VALUE:
        return value[:MAX_VALUE] + "..."
    return value


def stats(path, group_by, sum_key, top):
    rows = load_rows(path)
    counts, sums, missing = {}, {}, 0
    for row in rows:
        value = lookup(row, group_by)
        if value is MISSING:
            missing += 1
            continue
        key = label(value)
        counts[key] = counts.get(key, 0) + 1
        if sum_key:
            amount = lookup(row, sum_key)
            if isinstance(amount, (int, float)) and not isinstance(amount, bool):
                sums[key] = sums.get(key, 0) + amount

    ranked = sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))
    groups = []
    for value, count in ranked[:top]:
        group = {"value": value, "count": count}
        if sum_key:
            group["sum"] = round(sums.get(value, 0), 6)
        groups.append(group)
    return {"rows": len(rows), "groups": groups, "truncated": len(ranked) > top, "missing": missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, help="JSONL file or JSON array inside the repo")
    parser.add_argument("--group-by", required=True, help="Key to group rows by; dotted path for nested keys")
    parser.add_argument("--sum", default="", help="Numeric key to sum per group; dotted path allowed")
    parser.add_argument("--top", type=int, default=10, help="How many groups to return (1-50)")
    args = parser.parse_args()
    if not 1 <= args.top <= 50:
        parser.error("--top must be between 1 and 50")
    return stats(args.path, args.group_by, args.sum, args.top)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
