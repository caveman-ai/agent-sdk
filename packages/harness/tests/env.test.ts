import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keptPrefix, LocalEnv } from "../src/env/local.ts";
import { loadEnvVars, parseEnvVars } from "../src/env/vars.ts";
import { execEnvConformance } from "./env-conformance.ts";
import { toolSuite } from "./tool-suite.ts";

const makeLocal = async () => new LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-env-"))) });
execEnvConformance("LocalEnv", makeLocal);
toolSuite("LocalEnv", makeLocal);

test("capture keeps the head of a chunk that crosses the ceiling, on a whole character", () => {
  const ascii = Buffer.from("abcdefgh");
  assert.equal(keptPrefix(ascii, 100), 8);
  assert.equal(keptPrefix(ascii, 8), 8);
  // Any chunk size the host's pipes pick must fill the capture exactly.
  assert.equal(keptPrefix(ascii, 5), 5);
  assert.equal(keptPrefix(ascii, 0), 0);
  assert.equal(keptPrefix(ascii, -3), 0);
  const euro = Buffer.from("a\u20acb"); // a, three-byte euro sign, b
  assert.equal(keptPrefix(euro, 2), 1);
  assert.equal(keptPrefix(euro, 3), 1);
  assert.equal(keptPrefix(euro, 4), 4);
});

test("env vars: image_env.py JSON or KEY=VALUE lines; --env-json wins; bad input fails", () => {
  assert.deepEqual(parseEnvVars('{"PATH":"/opt/venv/bin:/usr/bin","GOWORK":"off"}'), { PATH: "/opt/venv/bin:/usr/bin", GOWORK: "off" });
  assert.deepEqual(parseEnvVars("# image\nexport A=1\nB=\"two words\"\nC='x=y'\n\n"), { A: "1", B: "two words", C: "x=y" });
  assert.throws(() => parseEnvVars('{"A":1}'), /A must be a string/u);
  assert.throws(() => parseEnvVars('{"1A":"x"}'), /bad variable name/u);
  assert.throws(() => parseEnvVars("NOEQUALS"), /want KEY=VALUE/u);
  const dir = mkdtempSync(join(tmpdir(), "harness-vars-"));
  writeFileSync(join(dir, "env.json"), '{"A":"file","B":"file"}');
  assert.deepEqual(loadEnvVars(join(dir, "env.json"), '{"B":"json"}'), { A: "file", B: "json" });
  assert.throws(() => loadEnvVars(undefined, "A=1"), /want a JSON object/u);
});

test("LocalEnv: --env-file variables reach commands and win over the allowlist", async () => {
  const env = new LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-env-"))), env: { PATH: `/opt/image/bin:${process.env.PATH}`, VIRTUAL_ENV: "/opt/image" } });
  try {
    assert.equal((await env.exec("echo ${PATH%%:*} $VIRTUAL_ENV")).output, "/opt/image/bin /opt/image\n");
  } finally {
    await env.close();
  }
});
