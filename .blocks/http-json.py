#!/usr/bin/env python3
# /// block
# name = "http-json"
# summary = "Fetch a JSON URL; return status, top-level keys, selected values, size and the saved body path."
# effects = "network"
# example = ["--url", "file://$FIXTURES/sample.json", "--keys", "name,owner.login,count"]
# matches = ['urllib\.request', 'requests\.(get|post)']
#
# [returns]
# keys = ["status", "keys", "selected", "size", "full", "truncated"]
# doc = "keys are the body's top-level keys (at most 20, empty unless the body is a JSON object); selected maps each requested dotted key to its value cut to 200 chars, null when absent; full is the saved body"
#
# [params]
# url = { type = "str", required = true, help = "http, https or file URL" }
# keys = { type = "str", default = "", help = "Comma-separated keys to return; dotted paths for nested keys" }
# timeout = { type = "float", default = 20.0, min = 1, max = 300, help = "Seconds before the request is abandoned" }
# method = { type = "enum", default = "GET", values = ["GET", "HEAD"], help = "HTTP method; read-only methods only" }
#
# [provenance]
# created = "2026-10-03"
# source = "registry:http-json@0.1.0"
# ///
"""Fetch a URL, save the body to a file and print the status, keys and a few selected values."""
import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

MAX_KEYS = 20
MAX_SELECTED = 10
MAX_VALUE = 200


def lookup(data, dotted):
    for part in dotted.split("."):
        if not isinstance(data, dict) or part not in data:
            return None
        data = data[part]
    return data


def cut(value):
    """Return value, or its JSON text cut to MAX_VALUE chars, and whether it was cut."""
    if value is None or isinstance(value, (bool, int, float)):
        return value, False
    text = value if isinstance(value, str) else json.dumps(value)
    if len(text) <= MAX_VALUE:
        return value, False
    return text[:MAX_VALUE] + "...", True


def fetch(url, timeout, method):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https", "file"):
        raise ValueError("url must be http, https or file")
    if parsed.scheme == "file":  # the runner starts blocks from the repo root
        root = os.path.realpath(os.getcwd())
        if os.path.commonpath([root, os.path.realpath(urllib.request.url2pathname(parsed.path))]) != root:
            raise ValueError("file URL must resolve inside the repo root")
    request = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status or 200, response.read()  # file:// responses carry no status
    except urllib.error.HTTPError as exc:  # 4xx/5xx is still an answer
        with exc:
            return exc.code, exc.read()


def http_json(url, keys, timeout, method):
    status, body = fetch(url, timeout, method)
    fd, full = tempfile.mkstemp(prefix="http-json-", suffix=".body", dir=os.environ.get("BLOCKS_OUT") or None)
    with os.fdopen(fd, "wb") as fh:
        fh.write(body)
    try:
        data = json.loads(body)
    except ValueError:
        data = None  # not JSON; keys and selected stay empty
    top = list(data) if isinstance(data, dict) else []
    wanted = [key.strip() for key in keys.split(",") if key.strip()]
    truncated = len(top) > MAX_KEYS or len(wanted) > MAX_SELECTED
    selected = {}
    for key in wanted[:MAX_SELECTED]:
        selected[key], was_cut = cut(lookup(data, key))
        truncated = truncated or was_cut
    return {
        "status": status,
        "keys": top[:MAX_KEYS],
        "selected": selected,
        "size": len(body),
        "full": full,
        "truncated": truncated,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="http, https or file URL")
    parser.add_argument("--keys", default="", help="Comma-separated keys to return; dotted paths for nested keys")
    parser.add_argument("--timeout", type=float, default=20.0, help="Seconds before the request is abandoned (1-300)")
    parser.add_argument("--method", default="GET", choices=["GET", "HEAD"], help="HTTP method; read-only methods only")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300:
        parser.error("--timeout must be between 1 and 300")
    return http_json(args.url, args.keys, args.timeout, args.method)


if __name__ == "__main__":
    try:
        answer, code = main(), 0
    except (OSError, ValueError) as exc:
        answer, code = {"error": str(exc)}, 1
    print(json.dumps(answer))
    sys.exit(code)
