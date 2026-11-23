#!/usr/bin/env node
/**
 * Packs the library (dist/lib.mjs, dist/lib.d.ts from scripts/bundle.mjs) as `@caveman-ai/harness`, for a host that
 * vendors it (the Caveman Code app's `vendor/`), with `./testing` (dist/testing.mjs: the fake Caveman Cloud SandboxEnv
 * is tested against, for the host's tests). The bundle carries its Pi packages and the sandbox SDK, so the packed
 * package.json has no dependencies; the CLI's bin is not in it. Prints the tarball's path and sha256.
 *
 *   node scripts/pack-lib.mjs <destination dir> [<label for the file name, e.g. the commit>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [destArg, label] = process.argv.slice(2);
if (destArg === undefined) throw new Error("usage: pack-lib.mjs <destination dir> [label]");
const dest = resolve(destArg);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = mkdtempSync(join(tmpdir(), "harness-pack-"));
try {
  mkdirSync(join(stage, "dist"));
  copyFileSync(join(root, "dist", "lib.mjs"), join(stage, "dist", "lib.mjs"));
  copyFileSync(join(root, "dist", "lib.d.ts"), join(stage, "dist", "lib.d.ts"));
  copyFileSync(join(root, "dist", "testing.mjs"), join(stage, "dist", "testing.mjs"));
  copyFileSync(join(root, "dist", "testing.d.ts"), join(stage, "dist", "testing.d.ts"));
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "package.json"), `${JSON.stringify({
    name: "@caveman-ai/harness",
    version: pkg.libVersion ?? pkg.version,
    description: "The Caveman harness as a library: the loadout-driven agent loop the Caveman Code app runs.",
    license: pkg.license,
    type: "module",
    engines: { node: ">=22" },
    exports: {
      ".": { types: "./dist/lib.d.ts", import: "./dist/lib.mjs" },
      // A host's tests: the fake Caveman Cloud SandboxEnv is tested against (tests/sandbox-fake.ts).
      "./testing": { types: "./dist/testing.d.ts", import: "./dist/testing.mjs" },
    },
    types: "./dist/lib.d.ts",
    files: ["dist/lib.mjs", "dist/lib.d.ts", "dist/testing.mjs", "dist/testing.d.ts", "LICENSE"],
  }, null, 2)}\n`);
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", stage], { cwd: stage, encoding: "utf8" });
  const [{ filename }] = JSON.parse(out);
  mkdirSync(dest, { recursive: true });
  const target = join(dest, label === undefined ? filename : `caveman-ai-harness-${label}.tgz`);
  renameSync(join(stage, filename), target);
  const sha = createHash("sha256").update(readFileSync(target)).digest("hex");
  process.stdout.write(`${JSON.stringify({ tarball: target, sha256: sha })}\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
