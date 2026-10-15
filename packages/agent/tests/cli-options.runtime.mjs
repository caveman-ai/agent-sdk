import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseServeOptions } from "../dist/cli-options.js";

test("serve parses options before or after the directory without treating values as paths", () => {
  const expected = { directory: "agent", port: 4321, host: "127.0.0.1", locked: true };
  assert.deepEqual(parseServeOptions(["--port", "4321", "agent", "--host", "127.0.0.1", "--locked"], {}), expected);
  assert.deepEqual(parseServeOptions(["agent", "--locked", "--host=127.0.0.1", "--port=4321"], {}), expected);
  assert.deepEqual(parseServeOptions(["--port", "0"], {}), {
    directory: ".", port: 0, host: "0.0.0.0", locked: false,
  });
  assert.equal(parseServeOptions(["--", "--agent"], {}).directory, "--agent");
});

test("serve honors environment defaults and explicit overrides", () => {
  assert.equal(parseServeOptions([], { PORT: "9000", HOST: "localhost" }).port, 9000);
  assert.equal(parseServeOptions([], { PORT: "9000", HOST: "localhost" }).host, "localhost");
  assert.equal(parseServeOptions(["--port=8000"], { PORT: "invalid" }).port, 8000);
});

test("serve rejects malformed arguments instead of loading the wrong agent", () => {
  for (const [args, message] of [
    [["--port"], /requires a value/],
    [["--host", "--locked"], /requires a value/],
    [["--host="], /requires a value/],
    [["--prt", "8080"], /unknown option/],
    [["--locked=false"], /does not take a value/],
    [["--port=1", "--port=2"], /only be specified once/],
    [["one", "two"], /at most one/],
  ]) assert.throws(() => parseServeOptions(args, {}), message);
  for (const port of ["", " ", "-1", "65536", "1.5", "0x50", "1e3", "NaN"]) {
    assert.throws(() => parseServeOptions([], { PORT: port }), /integer from 0 to 65535/);
  }
});

test("subcommand help runs without credentials, project files, or side effects", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const command of ["dev", "serve", "build", "check", "doctor", "register"]) {
    const result = spawnSync(process.execPath, [cli, command, "missing-project", "--help"], {
      encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`caveman-agent ${command}`));
    assert.equal(result.stderr, "");
  }
});
