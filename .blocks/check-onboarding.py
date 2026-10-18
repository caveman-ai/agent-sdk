#!/usr/bin/env python3
# /// block
# name = "check-onboarding"
# summary = "Typecheck onboarding snippets against the built SDK and verify local documentation links."
# effects = "exec"
# example = ["--root", ".", "--readme", "README.md", "--package-readme", "packages/agent/README.md", "--guide", "caveman-docs/guides/01-getting-started.md"]
#
# [returns]
# keys = ["snippetsChecked", "linksChecked"]
# doc = "Counts of checked examples and local links; failures return error with bounded diagnostic details. No provider calls or file writes."
#
# [params]
# root = { type = "path", required = true, help = "Built repository root containing TypeScript and workspace packages" }
# readme = { type = "path", required = true, help = "Repository README relative to root" }
# package-readme = { type = "path", required = true, help = "Agent package README relative to root" }
# guide = { type = "path", required = true, help = "Getting-started guide relative to root" }
# link-doc = { type = "str", default = "", help = "Comma-separated additional documentation paths to check" }
# ///
"""Check documentation without executing user examples or contacting a provider."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


CHECK = r'''
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const input = JSON.parse(readFileSync(0, "utf8"));
const ts = createRequire(resolve(input.root, "package.json"))("typescript");
const text = (path) => readFileSync(resolve(input.root, path), "utf8");
const blocks = (path, count) => {
  const found = [...text(path).matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
  if (found.length !== count) throw new Error(`${path}: expected ${count} JavaScript examples, found ${found.length}; review the example selection`);
  return found;
};
const beforeRun = (source) => {
  const marker = "const result = await run(";
  if (!source.includes(marker)) throw new Error("Example definition must precede a const result = await run(...) statement");
  return source.slice(0, source.indexOf(marker));
};

const root = blocks(input.readme, 3);
const pkg = blocks(input.packageReadme, 4);
const guide = blocks(input.guide, 5);
const definition = beforeRun(guide[1]);
const additions = 'import { stream, createConversation, CavemanRunError } from "@caveman-ai/agent";\n';
const samples = [
  root[0], root[1], beforeRun(root[0]) + root[2],
  pkg[0], pkg[1], definition + pkg[2], definition + pkg[3],
  guide[0], guide[1], ...guide.slice(2).map((source) => additions + definition + source),
];
const sources = new Map(samples.map((source, index) => [resolve(input.root, `.onboarding-check-${index}.mjs`), source]));
const options = {
  allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"],
};
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (file, version, ...rest) => sources.has(file)
  ? ts.createSourceFile(file, sources.get(file), version, true, ts.ScriptKind.JS)
  : getSourceFile(file, version, ...rest);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...sources.keys()], options, host));
const errors = diagnostics.map((item) => ({
  file: item.file?.fileName,
  message: ts.flattenDiagnosticMessageText(item.messageText, " ").slice(0, 500),
}));
let linksChecked = 0;
for (const file of new Set([input.readme, input.packageReadme, input.guide, ...input.linkDocs])) {
  for (const match of text(file).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    linksChecked++;
    if (!existsSync(resolve(input.root, dirname(file), target))) errors.push({ file, message: `Missing link target: ${target}` });
  }
}
const result = { snippetsChecked: samples.length, linksChecked };
if (errors.length) Object.assign(result, { error: "onboarding validation failed", failures: errors.slice(0, 10), failureCount: errors.length });
console.log(JSON.stringify(result));
process.exitCode = errors.length ? 1 : 0;
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--readme", required=True)
    parser.add_argument("--package-readme", required=True)
    parser.add_argument("--guide", required=True)
    parser.add_argument("--link-doc", default="")
    args = parser.parse_args()
    payload = {
        "root": str(Path(args.root).resolve()),
        "readme": args.readme,
        "packageReadme": args.package_readme,
        "guide": args.guide,
        "linkDocs": [path for path in args.link_doc.split(",") if path],
    }
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", CHECK],
            cwd=payload["root"], input=json.dumps(payload), text=True,
            capture_output=True, timeout=60,
            env={key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ},
        )
        if result.stdout.strip():
            print(json.dumps(json.loads(result.stdout)))
            return result.returncode
        raise RuntimeError(result.stderr.strip()[:1000] or "Node check produced no result")
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
