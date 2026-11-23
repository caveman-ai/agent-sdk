import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { loadEnvVars, parseEnvVars } from "../src/env/vars.ts";
import { execEnvConformance } from "./env-conformance.ts";
import { toolSuite } from "./tool-suite.ts";

const makeLocal = async () => new LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-env-"))) });
execEnvConformance("LocalEnv", makeLocal);
toolSuite("LocalEnv", makeLocal);

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
