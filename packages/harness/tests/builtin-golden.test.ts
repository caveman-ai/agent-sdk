/**
 * The three built-in loadouts send exactly the requests they sent before the
 * policy levers existed: every lever is off by default. Each built-in runs the
 * check scenario (write a failing check, see it fail, fix, see it pass, finish
 * with a hedged summary, which no lever answers when off) through pi-ai's real
 * Responses provider against a loopback server, and its captured request
 * bodies (per-run noise replaced) must equal the fixture recorded on
 * v3 a0ebd78, before any lever was added. The loadout and behavior
 * hashes are pinned too. `UPDATE_GOLDEN=1` rewrites the fixture.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readLoadout } from "../src/loadout.ts";
import { COMPACT_SCENARIO, EXEC_SCENARIO, runScripted, stableBody, type Body } from "./openai-loopback.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "builtin-bodies.json");
const NAMES = ["compact-v0", "compact-v0-plain", "exec-v0"] as const;

async function capture(): Promise<Record<string, { loadout_hash: string; behavior_hash: string; bodies: Body[] }>> {
  const out: Record<string, { loadout_hash: string; behavior_hash: string; bodies: Body[] }> = {};
  for (const name of NAMES) {
    const loaded = readLoadout(name);
    const steps = loaded.loadout.surface === "exec" ? EXEC_SCENARIO : COMPACT_SCENARIO;
    const run = await runScripted(loaded.loadout, steps, { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n") });
    assert.equal(run.result.status, "finished", JSON.stringify(run.result));
    out[name] = { loadout_hash: loaded.loadoutHash, behavior_hash: loaded.behaviorHash, bodies: run.bodies.map((body) => stableBody(body, run.cwd)) };
  }
  return out;
}

test("the built-in loadouts' requests and hashes are unchanged by the (off) policy levers", async () => {
  const now = await capture();
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
    if (process.env.UPDATE_GOLDEN !== "1") assert.fail(`wrote a missing fixture ${FIXTURE}; rerun`);
    return;
  }
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof now;
  for (const name of NAMES) {
    assert.equal(now[name]!.loadout_hash, golden[name]!.loadout_hash, `${name} loadout_hash`);
    assert.equal(now[name]!.behavior_hash, golden[name]!.behavior_hash, `${name} behavior_hash`);
    assert.equal(now[name]!.bodies.length, 5, `${name}: five requests, no continuation`);
    assert.deepEqual(now[name]!.bodies, golden[name]!.bodies, `${name} request bodies`);
  }
});
