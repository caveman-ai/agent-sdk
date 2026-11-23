import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, canonicalJson, loadLoadout, loadoutHash, normalizeLoadout, readLoadout, rigUnsafeNumbers, sha256 } from "../src/loadout.ts";
import { compactTools } from "../src/tools/compact.ts";

const base = () => structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Record<string, any>;
const COMPACT_V0_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts", "compact-v0.json");

/** The rig's loadout_hash (rig/conformance/bench/tb4/v3/v3arm.py), run by Python itself; undefined without python3. */
function rigHash(path: string): string | undefined {
  const script = 'import hashlib, json, sys; from pathlib import Path\n' +
    'print(hashlib.sha256(json.dumps(json.loads(Path(sys.argv[1]).read_text()), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())';
  const out = spawnSync("python3", ["-I", "-c", script, path], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : undefined;
}

test("canonical JSON sorts keys at every depth and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/u);
});

test("compact-v0 normalizes, resolves its sections, and hashes stably", () => {
  const loadout = loadLoadout("compact-v0");
  assert.equal(loadout.name, "compact-v0");
  assert.equal(loadout.surface, "compact");
  assert.deepEqual(loadout.prompt.sections.map((section) => section.id), ["core.identity", "compact.tools", "core.verify", "core.finish"]);
  assert.ok(loadout.prompt.sections.every((section) => section.text.length > 20));
  assert.match(loadoutHash(loadout), /^[0-9a-f]{64}$/u);
  assert.equal(loadoutHash(loadout), loadoutHash(loadLoadout("compact-v0")));
});

test("spelling out defaults does not change the hash; changing a value does", () => {
  const sparse = base();
  delete sparse.limits;
  delete sparse.policy;
  delete sparse.wire;
  delete sparse.context;
  const full = base();
  assert.equal(loadoutHash(normalizeLoadout(sparse)), loadoutHash(normalizeLoadout(full)));
  const reordered = Object.fromEntries(Object.entries(full).reverse());
  assert.equal(loadoutHash(normalizeLoadout(reordered)), loadoutHash(normalizeLoadout(full)));
  const changed = base();
  changed.limits.output_cap_bytes = 20_000;
  assert.notEqual(loadoutHash(normalizeLoadout(changed)), loadoutHash(normalizeLoadout(full)));
});

test("unknown keys fail closed at every level", () => {
  const top = { ...base(), extra: true };
  assert.throws(() => normalizeLoadout(top), /loadout.*invalid.*additional/su);
  const nested = base();
  nested.policy.loop.nudge_after = 2;
  assert.throws(() => normalizeLoadout(nested), /invalid/u);
  const tool = base();
  tool.tools.read.speculative = true;
  assert.throws(() => normalizeLoadout(tool), /invalid/u);
  const section = base();
  section.prompt.sections.push("core.nonexistent");
  assert.throws(() => normalizeLoadout(section), /unknown prompt section "core.nonexistent"/u);
  const loop = base();
  loop.policy.loop = { nudge_at: 4, stop_at: 4 };
  assert.throws(() => normalizeLoadout(loop), /stop_at must exceed nudge_at/u);
});

test("tool limits reject unknown keys and wrong types when the tools are built", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-loadout-"));
  const env = new LocalEnv({ cwd: dir });
  try {
    const unknown = base();
    unknown.tools.bash.limits.yield_forever = 1;
    assert.throws(() => compactTools({ env, loadout: normalizeLoadout(unknown), images: false }), /tools.bash.limits: unknown key "yield_forever"/u);
    const wrong = base();
    wrong.tools.read.limits.line_numbers = "yes";
    assert.throws(() => compactTools({ env, loadout: normalizeLoadout(wrong), images: false }), /tools.read.limits.line_numbers: want boolean/u);
    const absent = base();
    absent.tools.grep = { exposure: "eager" };
    assert.throws(() => compactTools({ env, loadout: normalizeLoadout(absent), images: false }), /no tool "grep"/u);
    const off = base();
    off.tools.wait.exposure = "off";
    assert.deepEqual(compactTools({ env, loadout: normalizeLoadout(off), images: false }).map((tool) => tool.name), ["bash", "edit", "read", "write"]);
  } finally {
    await env.close();
  }
});

test("a loadout file may extend a built-in, replacing top-level keys; it must name itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-loadout-"));
  const path = join(dir, "arm.json");
  writeFileSync(path, JSON.stringify({ extends: "compact-v0", name: "arm-a", limits: { output_cap_bytes: 16384 } }));
  const loaded = readLoadout(path);
  assert.equal(loaded.name, "arm-a");
  assert.equal(loaded.loadout.limits.output_cap_bytes, 16384);
  assert.equal(loaded.loadout.limits.output_cap_lines, 2000);
  assert.equal(loaded.loadout.tools.bash?.exposure, "eager");
  writeFileSync(path, JSON.stringify({ extends: "compact-v0", wire: { payload: { text: { verbosity: "low" } } } }));
  assert.throws(() => loadLoadout(path), /extends compact-v0 needs its own "name"/u, "an arm never reports its base's name");
  writeFileSync(path, JSON.stringify({ extends: "nope", name: "x" }));
  assert.throws(() => loadLoadout(path), /unknown base loadout/u);
  assert.throws(() => loadLoadout(join(dir, "missing.json")), /cannot read/u);
});

test("loadout_hash is the loadout as given, byte-for-byte the rig's hash; behavior_hash is the normalized loadout", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-loadout-"));
  const builtin = readLoadout("compact-v0");
  const file = readLoadout(COMPACT_V0_FILE);
  assert.equal(builtin.loadoutHash, file.loadoutHash, "the built-in name and its file pin the same version");
  assert.equal(builtin.loadoutHash, sha256(canonicalJson(JSON.parse(readFileSync(COMPACT_V0_FILE, "utf8")))));
  assert.equal(builtin.behaviorHash, loadoutHash(loadLoadout("compact-v0")));
  assert.notEqual(builtin.loadoutHash, builtin.behaviorHash);
  assert.deepEqual(rigUnsafeNumbers(readFileSync(COMPACT_V0_FILE, "utf8")), [], "the built-in file hashes the same in Python");

  // An arm that only extends: the hash covers the 2-key file the rig pins, not the merged loadout.
  const arm = join(dir, "arm.json");
  const armRaw = { name: "arm-verbosity", extends: "compact-v0", wire: { cache_retention: "short", max_retries: 3, payload: { text: { verbosity: "low" } } } };
  writeFileSync(arm, JSON.stringify(armRaw, null, 2));
  const loaded = readLoadout(arm);
  assert.equal(loaded.loadoutHash, sha256(canonicalJson(armRaw)));
  // Same behavior spelled out in full, without extends: a different file (loadout_hash), the same behavior.
  const full = join(dir, "full.json");
  writeFileSync(full, JSON.stringify({ ...base(), name: "arm-verbosity", wire: armRaw.wire }));
  assert.notEqual(readLoadout(full).loadoutHash, loaded.loadoutHash);
  assert.equal(readLoadout(full).behaviorHash, loaded.behaviorHash);

  // Key order by code point (Python's sort_keys), decimals, escapes and non-ASCII text all match the rig.
  const tricky = join(dir, "tricky.json");
  writeFileSync(tricky, JSON.stringify({ ...base(), name: "tricky", prices: { "openai/gpt-6.1-sol": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.0001 } },
    wire: { payload: { "\u{1F600}": 1, "\uFF01": 2, "é": "naïve \"quoted\" \\ \u0001\n", z: [1, -2, 0.5] } } }), "utf8");
  for (const path of [COMPACT_V0_FILE, arm, full, tricky]) {
    const rig = rigHash(path);
    if (rig === undefined) {
      process.stderr.write("python3 missing: the cross-check against the rig's Python hash was skipped\n");
      break;
    }
    assert.equal(readLoadout(path).loadoutHash, rig, path);
  }
});

test("numbers Python would print differently fail closed instead of hashing apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-loadout-"));
  const path = join(dir, "arm.json");
  for (const literal of ["1.0", "1e3", "0.00001", "1152921504606846976", "-0.0"]) {
    writeFileSync(path, `{"name": "n", "extends": "compact-v0", "policy": {"budgets": {"usd": ${literal}}}}`);
    assert.throws(() => readLoadout(path), /would hash differently in the rig/u, literal);
  }
  assert.deepEqual(rigUnsafeNumbers('{"a": "1.0 inside a string", "b": [1, 0.5, 0.0001, -3, 2.75]}'), []);
  writeFileSync(path, '{"name": "n", "extends": "compact-v0", "policy": {"budgets": {"usd": 2.5, "requests": 40}}}');
  assert.equal(readLoadout(path).loadout.policy.budgets.usd, 2.5);
});
