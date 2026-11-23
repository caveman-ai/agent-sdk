/**
 * The round R1/R2 arm loadouts in loadouts/ (`<base>-<suffix>.json` and
 * `placebo-<base>.json`): each extends its base and, normalized, differs from
 * it in exactly the lever flags its suffix names (plus its own name). A file
 * that lost a base key it replaced (`extends` replaces top-level keys whole)
 * or flipped one flag too many fails here. Offline; no model calls.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExecEnv } from "../src/env/types.ts";
import { BUILTIN_LOADOUTS, readLoadout } from "../src/loadout.ts";
import { estimateTokens, LEVER_TEXTS } from "../src/prompts.ts";
import { systemPromptOf } from "../src/run.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");
const BASES = ["exec-v0", "compact-v0-plain"] as const;

/** The yield floor: every wait the model picks on the exec surface (exec_command, write_stdin's poll, a cell's pragma, wait). */
const YIELD_FLOOR = ["tools.exec.limits.min_yield_ms", "tools.exec_command.limits.min_yield_ms", "tools.wait.limits.min_yield_ms", "tools.write_stdin.limits.min_poll_ms"];

/** The flags each suffix flips, as paths in the normalized loadout. */
const FLIPS: Record<string, (base: string) => string[]> = {
  p1: () => ["policy.evidence_gate"],
  p2: () => ["policy.first_green", "policy.hedge_continue"],
  p3: () => ["policy.discovery"],
  d2: () => ["depth.escalate"],
  d3: () => ["depth.wall_notice"],
  pall: () => ["policy.discovery", "policy.evidence_gate", "policy.first_green", "policy.hedge_continue"],
  b3: () => ["env.toolbox_path", "policy.self_kill_guard", "policy.shell_hygiene", "policy.watch_stop"],
  r1: () => ["results.max_failures", "results.min_bytes", "results.shaping", "results.tail_lines"],
  r23: (base) => (base === "exec-v0" ? ["tools.exec.limits.aliases", "tools.wait.limits.until"] : ["tools.read.limits.many", "tools.wait.limits.until"]),
  cm: () => ["trace.cache_monitor"],
  d4: () => ["depth.deescalate"],
  d4l: () => ["depth.deescalate"],
  p4: () => ["policy.finish_audit"],
  p6: () => ["prompt.time_budget"],
  p6plac: () => ["prompt.time_budget", "prompt.time_budget_placebo"],
  p46: () => ["policy.finish_audit", "prompt.time_budget"],
  ws: () => ["wire.transport", "wire.ws"],
  y10: () => YIELD_FLOOR,
  y30: () => YIELD_FLOOR,
  tok: () => ["limits.token_estimate"],
  iso: () => ["policy.test_isolation"],
  isoplac: () => ["policy.test_isolation", "policy.test_isolation_placebo"],
  eb: () => ["policy.evidence_bounce"],
  ebplac: () => ["policy.evidence_bounce", "policy.evidence_bounce_placebo"],
  ieb: () => ["policy.evidence_bounce", "policy.test_isolation"],
  req: () => ["prompt.requirements"],
  reqplac: () => ["prompt.requirements", "prompt.requirements_placebo"],
  req4: () => ["policy.finish_audit", "prompt.requirements"],
  cx: () => ["prompt.sections"],
  cxplac: () => ["prompt.sections"],
  clean: () => ["prompt.clean_env"],
  cleanplac: () => ["prompt.clean_env", "prompt.clean_env_placebo"],
  travel: () => ["policy.travel_check"],
  travelplac: () => ["policy.travel_check", "policy.travel_check_placebo"],
  unmet: () => ["policy.unmet_target"],
  ctu: () => ["policy.travel_check", "policy.unmet_target", "prompt.clean_env"],
  ctuplac: () => [
    "policy.travel_check", "policy.travel_check_placebo", "policy.unmet_target", "policy.unmet_target_placebo", "prompt.clean_env", "prompt.clean_env_placebo",
  ],
  jit: () => ["policy.travel_jit"],
  jitplac: () => ["policy.travel_jit", "policy.travel_jit_placebo"],
  batch: () => ["tools.exec.limits.batch"],
  batchplac: () => ["tools.exec.limits.batch", "tools.exec.limits.batch_placebo"],
  val: () => ["policy.validator"],
  valplac: () => ["policy.validator", "policy.validator_placebo"],
  critic: () => ["policy.critic"],
  criticplac: () => ["policy.critic", "policy.critic_placebo"],
  iface: () => ["policy.interface_gate"],
  ifaceplac: () => ["policy.interface_gate", "policy.interface_gate_placebo"],
  margin: () => ["policy.thin_margin"],
  marginplac: () => ["policy.thin_margin", "policy.thin_margin_placebo"],
  clause: () => ["policy.clause_check"],
  clauseplac: () => ["policy.clause_check", "policy.clause_check_placebo"],
};

/** Suffixes that exist for only some bases (every other suffix exists for every base). */
const ONLY_ON: Record<string, readonly string[]> = {
  d4: ["exec-v0"], d4l: ["exec-v0"], p4: ["exec-v0"], p6: ["exec-v0"], p6plac: ["exec-v0"], p46: ["exec-v0"],
  y10: ["exec-v0"], y30: ["exec-v0"], tok: ["exec-v0"],
  iso: ["exec-v0"], isoplac: ["exec-v0"], eb: ["exec-v0"], ebplac: ["exec-v0"], ieb: ["exec-v0"],
  req: ["exec-v0"], reqplac: ["exec-v0"], req4: ["exec-v0"],
  cx: ["exec-v0"], cxplac: ["exec-v0"],
  clean: ["exec-v0"], cleanplac: ["exec-v0"], travel: ["exec-v0"], travelplac: ["exec-v0"], unmet: ["exec-v0"], ctu: ["exec-v0"], ctuplac: ["exec-v0"],
  jit: ["exec-v0"], jitplac: ["exec-v0"], batch: ["exec-v0"], batchplac: ["exec-v0"], val: ["exec-v0"], valplac: ["exec-v0"],
  critic: ["exec-v0"], criticplac: ["exec-v0"], iface: ["exec-v0"], ifaceplac: ["exec-v0"], margin: ["exec-v0"], marginplac: ["exec-v0"],
  clause: ["exec-v0"], clauseplac: ["exec-v0"],
};
const suffixesOf = (base: string) => Object.keys(FLIPS).filter((suffix) => ONLY_ON[suffix]?.includes(base) ?? true);

/** Composed surface versions (not one lever each): their base and every flag they flip. */
const COMPOSED: Record<string, { base: string; flips: string[] }> = {
  "exec-v1": {
    base: "exec-v0",
    flips: [
      "tools.apply_patch.limits.nearest", "tools.exec.limits.batch", "tools.exec.limits.cut_notice", "tools.exec.limits.describe",
      "tools.exec.limits.error_hints", "tools.exec.limits.mcp_types",
    ],
  },
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Paths where `arm` differs from `base`; a top-level object only the arm has is compared key by key against {}. */
function changed(base: unknown, arm: unknown, path = ""): string[] {
  if (!isObject(base) || !isObject(arm)) return JSON.stringify(base) === JSON.stringify(arm) ? [] : [path];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(arm)])) {
    const at = path === "" ? key : `${path}.${key}`;
    const [left, right] = [base[key], arm[key]];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (isObject(left) && isObject(right)) out.push(...changed(left, right, at));
    else if (path === "" && (left === undefined || right === undefined) && (isObject(left) || isObject(right))) out.push(...changed(left ?? {}, right ?? {}, at));
    else out.push(at);
  }
  return out.sort();
}

const allFiles = () => readdirSync(dir).filter((file) => file.endsWith(".json") && !Object.hasOwn(BUILTIN_LOADOUTS, file.slice(0, -5))).sort();
const armFiles = () => allFiles().filter((file) => !Object.hasOwn(COMPOSED, file.slice(0, -5)));

test("every arm loadout is one of the expected <base>-<suffix>, placebo-<base> or composed files, and all of them exist", () => {
  const expected = [...BASES.flatMap((base) => [...suffixesOf(base).map((suffix) => `${base}-${suffix}.json`), `placebo-${base}.json`]), ...Object.keys(COMPOSED).map((name) => `${name}.json`)].sort();
  assert.deepEqual(allFiles(), expected);
});

test("each composed loadout extends its base, names itself after its file, and flips exactly its listed flags", () => {
  for (const [name, { base, flips }] of Object.entries(COMPOSED)) {
    const loaded = readLoadout(join(dir, `${name}.json`));
    assert.equal(loaded.name, name);
    assert.deepEqual(changed({ ...readLoadout(base).loadout, name: "" }, { ...loaded.loadout, name: "" }), flips, name);
  }
});

test("each arm extends its base, names itself after its file, and flips exactly the flags its suffix names", () => {
  for (const file of armFiles()) {
    const name = file.slice(0, -5);
    const base = BASES.find((candidate) => name === `placebo-${candidate}`) ?? BASES.find((candidate) => name.startsWith(`${candidate}-`) && suffixesOf(candidate).includes(name.slice(candidate.length + 1)));
    assert.ok(base !== undefined, `${file}: no base`);
    const loaded = readLoadout(join(dir, file));
    const baseline = readLoadout(base);
    assert.equal(loaded.name, name, file);
    assert.notEqual(loaded.behaviorHash, baseline.behaviorHash, `${file}: behaves like ${base}`);
    const expected = name.startsWith("placebo-") ? ["prompt.addenda", "prompt.placebo"] : FLIPS[name.slice(base.length + 1)]!(base);
    assert.deepEqual(changed({ ...baseline.loadout, name: "" }, { ...loaded.loadout, name: "" }), expected, file);
  }
});

test("the arms' lever settings: D2 is xhigh at the first write and after a red check, B3's toolbox is /opt/tb4/bin, R1 is shaping all, D4 lowers to medium (d4l: low)", () => {
  for (const base of BASES) {
    assert.deepEqual(readLoadout(join(dir, `${base}-d2.json`)).loadout.depth?.escalate, { effort: "xhigh", on: ["after_red", "first_write"], first_write_max: 8 });
    assert.equal(readLoadout(join(dir, `${base}-b3.json`)).loadout.env?.toolbox_path, "/opt/tb4/bin");
    assert.equal(readLoadout(join(dir, `${base}-r1.json`)).loadout.results?.shaping, "all");
    assert.equal(readLoadout(join(dir, `${base}-p1.json`)).loadout.prompt.addenda, undefined, "P1 is a policy, not a prompt line");
  }
  const d4 = (suffix: string) => readLoadout(join(dir, `exec-v0-${suffix}.json`)).loadout.depth?.deescalate;
  assert.deepEqual({ ...d4("d4"), finish_patterns: [] }, { to: "medium", on: ["poll", "read_only"], finish_patterns: [] });
  assert.deepEqual({ ...d4("d4l"), finish_patterns: [] }, { to: "low", on: ["poll", "read_only"], finish_patterns: [] });
  assert.ok((d4("d4")?.finish_patterns.length ?? 0) > 0, "D4 keeps the run's effort after a finish announcement by default");
  for (const [suffix, floor] of [["y10", 10_000], ["y30", 30_000]] as const) {
    const tools = readLoadout(join(dir, `exec-v0-${suffix}.json`)).loadout.tools;
    assert.deepEqual([tools.exec!.limits.min_yield_ms, tools.exec_command!.limits.min_yield_ms, tools.wait!.limits.min_yield_ms, tools.write_stdin!.limits.min_poll_ms], [floor, floor, floor, floor], suffix);
  }
  assert.equal(readLoadout(join(dir, "exec-v0-tok.json")).loadout.limits.token_estimate, "dense");
});

test("placebo-<base>: the system prompt gains neutral text as long as P1's wording, and none of that wording", () => {
  const env = { cwd: "/w", os: "linux" } as ExecEnv;
  for (const base of BASES) {
    const loaded = readLoadout(join(dir, `placebo-${base}.json`)).loadout;
    assert.deepEqual(loaded.prompt.addenda, [{ id: "evidence_gate", text: LEVER_TEXTS.evidence_gate }], "the addendum is P1's default wording");
    const plain = systemPromptOf(readLoadout(base).loadout, env);
    const prompt = systemPromptOf(loaded, env);
    assert.ok(prompt.startsWith(`${plain}\n\n`), "appended after the base sections");
    const added = prompt.slice(plain.length + 2);
    assert.equal(estimateTokens(added), estimateTokens(LEVER_TEXTS.evidence_gate));
    for (const phrase of ["Before you finish", "requirement", "check", "proxy"]) assert.ok(!added.includes(phrase), `${base}: placebo says "${phrase}"`);
  }
});
