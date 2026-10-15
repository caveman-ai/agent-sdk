#!/usr/bin/env python3
# /// block
# name = "check-local-scaffold"
# summary = "Install a generated starter against the built checkout and verify types and CLI entrypoints."
# effects = "exec"
# example = ["--repo-root", ".", "--template", "all"]
#
# [returns]
# keys = ["ok", "templates", "checks", "sdk_version", "provider_calls"]
# doc = "Runs real npm installs in disposable directories with an explicit environment allowlist; removes all temporary files."
#
# [params]
# repo-root = { type = "path", required = true, help = "Built SDK repository root" }
# template = { type = "str", default = "support-bot", help = "support-bot, background-agent, or all" }
# timeout = { type = "int", default = 180, min = 1, max = 600, help = "Maximum seconds per command" }
# ///
"""Verify local-checkout onboarding without provider credentials or calls."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


class CheckFailure(Exception):
    def __init__(self, step, details):
        self.step = step
        self.details = details


def run_command(step, command, cwd, env, timeout):
    try:
        result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckFailure(step, str(error)[:1200]) from None
    if result.returncode:
        raise CheckFailure(step, result.stdout[-1800:].strip())
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--template", choices=["support-bot", "background-agent", "all"], default="support-bot")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600:
        raise ValueError("timeout must be between 1 and 600 seconds")
    repo = args.repo_root.resolve(strict=True)
    sdk = repo / "packages/agent"
    initializer = repo / "packages/create-caveman-agent/dist/index.js"
    for path in [initializer, sdk / "dist/index.d.ts", sdk / "dist/cli.js"]:
        if not path.is_file():
            raise ValueError(f"build the repository first; missing {path.relative_to(repo)}")
    node, npm = shutil.which("node"), shutil.which("npm")
    if node is None or npm is None:
        raise ValueError("node and npm must be on PATH")
    templates = ["support-bot", "background-agent"] if args.template == "all" else [args.template]
    version = json.loads((sdk / "package.json").read_text())["version"]
    with tempfile.TemporaryDirectory(prefix="caveman-local-scaffold-") as temporary:
        scratch = Path(temporary)
        for config in ["npm-user.conf", "npm-global.conf"]:
            (scratch / config).write_text("")
        env = {key: os.environ[key] for key in [
            "PATH", "SystemRoot", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        ] if key in os.environ}
        env.update(TMPDIR=temporary, TMP=temporary,
                   TEMP=temporary, NPM_CONFIG_CACHE=str(scratch / "npm-cache"),
                   NPM_CONFIG_USERCONFIG=str(scratch / "npm-user.conf"),
                   NPM_CONFIG_GLOBALCONFIG=str(scratch / "npm-global.conf"),
                   NPM_CONFIG_FETCH_RETRIES="0", NPM_CONFIG_FETCH_TIMEOUT="30000", CI="1")
        for template in templates:
            target = scratch / template
            run_command(f"{template}:scaffold", [node, str(initializer), str(target),
                        "--template", template, "--provider", "anthropic", "--no-install"],
                        scratch, env, args.timeout)
            run_command(f"{template}:install", [npm, "install", str(sdk), "--ignore-scripts",
                        "--no-audit", "--no-fund"], target, env, args.timeout)
            installed = target / "node_modules/@caveman-ai/agent"
            if json.loads((installed / "package.json").read_text())["version"] != version:
                raise CheckFailure(f"{template}:install", "installed SDK version differs from checkout")
            run_command(f"{template}:typecheck", [npm, "run", "typecheck"], target, env, args.timeout)
            cli = str(installed / "dist/cli.js")
            reported = run_command(f"{template}:version", [node, cli, "--version"], target, env, args.timeout)
            if version not in reported:
                raise CheckFailure(f"{template}:version", f"CLI did not report SDK version {version}")
            help_text = run_command(f"{template}:help", [node, cli, "--help"], target, env, args.timeout)
            if "caveman-agent" not in help_text:
                raise CheckFailure(f"{template}:help", "CLI help did not identify caveman-agent")
    return {"ok": True, "templates": templates, "checks": ["npm install local SDK", "typecheck", "CLI --version", "CLI --help"],
            "sdk_version": version, "provider_calls": 0}


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except CheckFailure as error:
        print(json.dumps({"error": error.step, "details": error.details, "provider_calls": 0}))
        sys.exit(1)
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)[:1200], "provider_calls": 0}))
        sys.exit(1)
