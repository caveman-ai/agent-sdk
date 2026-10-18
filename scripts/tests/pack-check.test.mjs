import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackedEntrypoints } from "../pack-check.mjs";

const files = [
  { path: "dist/index.js", mode: 0o644 },
  { path: "dist/index.d.ts", mode: 0o644 },
  { path: "dist/cli.js", mode: 0o755 },
];
const manifest = {
  main: "dist/index.js", types: "dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  bin: { agent: "./dist/cli.js" },
};

test("published entry points and executable bins must all be packed", () => {
  assert.doesNotThrow(() => assertPackedEntrypoints(manifest, files, "agent"));
  assert.throws(() => assertPackedEntrypoints(manifest, files.slice(1), "agent"), /entrypoint_missing:agent:main/);
  assert.throws(() => assertPackedEntrypoints(manifest, files.filter((f) => !f.path.endsWith(".d.ts")), "agent"), /entrypoint_missing:agent:types/);
  assert.throws(() => assertPackedEntrypoints(manifest, files.slice(0, 2), "agent"), /bin_missing/);
  assert.throws(() => assertPackedEntrypoints(manifest, files.map((f) => ({ ...f, mode: 0o644 })), "agent"), /bin_not_executable/);
});

test("nested conditions, export patterns and blocked exports are checked", () => {
  assert.doesNotThrow(() => assertPackedEntrypoints({ exports: {
    "./*": "./dist/*.js", "./private": null,
  } }, files, "agent"));
  assert.throws(() => assertPackedEntrypoints({ exports: {
    ".": { node: { import: "./dist/missing.js" } },
  } }, files, "agent"), /entrypoint_missing:agent:exports/);
  assert.throws(() => assertPackedEntrypoints({ exports: { "./*": "./missing/*.js" } }, files, "agent"), /entrypoint_missing/);
  assert.throws(() => assertPackedEntrypoints({ exports: { ".": 42 } }, files, "agent"), /entrypoint_invalid/);
  assert.throws(() => assertPackedEntrypoints({ exports: { ".": "dist/index.js" } }, files, "agent"), /entrypoint_invalid/);
  assert.throws(() => assertPackedEntrypoints({ exports: { ".": "./dist/*.js" } }, files, "agent"), /entrypoint_missing/);
  assert.throws(() => assertPackedEntrypoints({ main: "dist/*.js" }, files, "agent"), /entrypoint_missing/);
});

test("entry points cannot escape the package or pass through regexp metacharacters", () => {
  for (const target of ["../dist/index.js", "/dist/index.js", "dist\\index.js", ""]) {
    assert.throws(() => assertPackedEntrypoints({ main: target }, files, "agent"), /entrypoint_invalid/);
  }
  assert.throws(() => assertPackedEntrypoints({ main: "dist/indexXjs" }, files, "agent"), /entrypoint_missing/);
  assert.throws(() => assertPackedEntrypoints({ main: "dist/index.js" }, [{ path: "dist/indexXjs" }], "agent"), /entrypoint_missing/);
});
