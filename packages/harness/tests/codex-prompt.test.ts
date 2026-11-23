/**
 * `codex.base`, `codex.permissions` and their arms (exec-v0-cx,
 * exec-v0-cxplac): each section is Codex 0.163's text with exactly the edits in
 * fixtures/codex-<base|permissions>-edits.json (the source is pinned by its
 * sha256 and rebuilt from the section by undoing the edits), they name only
 * tools and parameters exec-v0 has, both arms load and hash, the request's
 * system prompt carries the sections, and two runs send byte-identical
 * prefixes. Offline: a loopback Responses server, no model calls.
 * `CODEX_ROLLOUT=<rollout.jsonl>` also compares the rebuilt sources with a
 * Codex 0.163 rollout (session_meta and the first developer message).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecEnv } from "../src/env/types.ts";
import { CODEX_BASE, CODEX_PERMISSIONS } from "../src/codex-base.ts";
import { BUILTIN_LOADOUTS, LoadoutError, normalizeLoadout, readLoadout } from "../src/loadout.ts";
import { estimateTokens, placeboFor, PROMPT_SECTIONS } from "../src/prompts.ts";
import { systemPromptOf } from "../src/run.ts";
import { NESTED_SPECS } from "../src/tools/exec/nested.ts";
import { EXEC_SCENARIO, isPrefix, runScripted, stableBody, type Body } from "./openai-loopback.ts";

interface Edit { at: number; from: string; to: string; why: string }
interface Fixture { source: { cli_version: string; model: string; field: string; chars: number; sha256: string }; edits: Edit[] }
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `codex-${name}-edits.json`), "utf8")) as Fixture;
const FIXTURE = fixture("base");
const PERMISSIONS_FIXTURE = fixture("permissions");
const dir = join(import.meta.dirname, "..", "loadouts");
const arm = (name: "exec-v0-cx" | "exec-v0-cxplac") => readLoadout(join(dir, `${name}.json`));
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const env = { cwd: "/w", os: "linux" } as ExecEnv;
/** The system prompt as pi-ai sends it: the developer message after the additional_tools item (Codex sends `instructions`). */
const systemOf = (body: Body): string | undefined => (body.input as Body[]).find((item) => item.role === "developer" && typeof item.content === "string")?.content as string | undefined;
const toolsOf = (body: Body): unknown => (body.input as Body[]).find((item) => item.type === "additional_tools")?.tools;

/** The source back from the section: each edit undone in place (`at` is its offset in the source). */
function undo(section: string, edits: readonly Edit[]): string {
  let out = "";
  let pos = 0;
  let shift = 0;
  for (const edit of edits) {
    const at = edit.at + shift;
    assert.equal(section.slice(at, at + edit.to.length), edit.to, `the edit at ${edit.at} is not in place`);
    out += section.slice(pos, at) + edit.from;
    pos = at + edit.to.length;
    shift += edit.to.length - edit.from.length;
  }
  return out + section.slice(pos);
}

/** The section from the source: each edit applied at its offset. */
function apply(source: string, edits: readonly Edit[]): string {
  let out = "";
  let pos = 0;
  for (const edit of edits) {
    assert.equal(source.slice(edit.at, edit.at + edit.from.length), edit.from, `the source has no "${edit.from.slice(0, 40)}" at ${edit.at}`);
    out += source.slice(pos, edit.at) + edit.to;
    pos = edit.at + edit.from.length;
  }
  return out + source.slice(pos);
}

test("codex.base is Codex 0.163's base instructions minus exactly the documented edits", () => {
  assert.equal(PROMPT_SECTIONS["codex.base"], CODEX_BASE);
  assert.equal(FIXTURE.source.cli_version, "0.163.0");
  const { edits } = FIXTURE;
  assert.equal(edits.length, 12);
  for (const [index, edit] of edits.entries()) {
    assert.ok(edit.why.length > 0 && edit.from !== edit.to, `edit ${index}`);
    if (index > 0) assert.ok(edits[index - 1]!.at + edits[index - 1]!.from.length <= edit.at, `edit ${index} overlaps or is out of order`);
  }
  const source = undo(CODEX_BASE, edits);
  assert.equal(source.length, FIXTURE.source.chars);
  assert.equal(sha256(source), FIXTURE.source.sha256, "the rebuilt source is not Codex 0.163's text");
  assert.equal(apply(source, edits), CODEX_BASE);
});

test("codex.permissions is Codex 0.163's <permissions instructions> verbatim (no edits)", () => {
  assert.equal(PROMPT_SECTIONS["codex.permissions"], CODEX_PERMISSIONS);
  assert.equal(PERMISSIONS_FIXTURE.source.cli_version, "0.163.0");
  assert.deepEqual(PERMISSIONS_FIXTURE.edits, []);
  const source = undo(CODEX_PERMISSIONS, PERMISSIONS_FIXTURE.edits);
  assert.equal(source.length, PERMISSIONS_FIXTURE.source.chars);
  assert.equal(sha256(source), PERMISSIONS_FIXTURE.source.sha256, "the rebuilt source is not Codex 0.163's text");
  for (const phrase of ["`danger-full-access`", "Network access is enabled.", "Approval policy is currently never.", "Do not provide the `sandbox_permissions`"]) {
    assert.ok(CODEX_PERMISSIONS.includes(phrase), phrase);
  }
});

test("codex.base and codex.permissions match a Codex 0.163 rollout (CODEX_ROLLOUT)", { skip: process.env.CODEX_ROLLOUT === undefined }, () => {
  const lines = readFileSync(process.env.CODEX_ROLLOUT!, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { type: string; payload: Record<string, any> });
  const meta = lines[0]!.payload as { cli_version: string; base_instructions: { text: string } };
  assert.equal(meta.cli_version, FIXTURE.source.cli_version);
  assert.equal(apply(meta.base_instructions.text, FIXTURE.edits), CODEX_BASE);
  const developer = lines.find((line) => line.type === "response_item" && line.payload.role === "developer")!.payload as { content: { text: string }[] };
  const permissions = developer.content.filter((item) => item.text.startsWith("<permissions instructions>"));
  assert.equal(permissions.length, 1);
  assert.equal(apply(permissions[0]!.text, PERMISSIONS_FIXTURE.edits), CODEX_PERMISSIONS);
});

test("codex.base and codex.permissions name only tools and parameters exec-v0 has, and no mechanic it lacks", () => {
  const tools = Object.keys(readLoadout("exec-v0").loadout.tools);
  for (const [, name] of CODEX_BASE.matchAll(/functions\.([A-Za-z_]+)/gu)) assert.ok(["exec", "wait"].includes(name!) && tools.includes(name!), `functions.${name}`);
  for (const [, name] of CODEX_BASE.matchAll(/\btools\.([A-Za-z_]+)/gu)) assert.ok(tools.includes(name!), `tools.${name}`);
  assert.ok(CODEX_BASE.includes("exec_command") && tools.includes("exec_command"));
  for (const absent of ["request_user_input", "SKILL.md", "skill", "plugin", "tool_search", "codex_apps", "list_mcp_resources", "auto-review", "memory", "compact", "Compaction"]) {
    assert.ok(!CODEX_BASE.includes(absent), `codex.base still names "${absent}"`);
  }
  assert.ok(CODEX_BASE.startsWith("You are Codex, an agent based on GPT-6."), "the identity line is Codex's own");
  assert.ok(!/\d{4}-\d{2}-\d{2}/u.test(CODEX_BASE + CODEX_PERMISSIONS), "no dates or other per-run text");
  const execCommand = Object.keys((NESTED_SPECS.exec_command.input as { properties: Record<string, unknown> }).properties);
  for (const [, name] of CODEX_PERMISSIONS.matchAll(/`([a-z_]+)`/gu)) {
    if (name === "sandbox_mode") continue; // Codex's config value, stated as fact: commands run unsandboxed here too
    assert.ok(execCommand.includes(name!), `codex.permissions names \`${name}\`, which our exec_command does not take`);
  }
});

test("exec-v0-cx is codex.base, codex.permissions, exec.tools; exec-v0-cxplac is exec-v0's sections after placebos of both Codex sections' estimated lengths", () => {
  const base = readLoadout("exec-v0");
  const cx = arm("exec-v0-cx");
  const plac = arm("exec-v0-cxplac");
  assert.deepEqual(cx.loadout.prompt.sections.map((section) => section.id), ["codex.base", "codex.permissions", "exec.tools"]);
  assert.equal(systemPromptOf(cx.loadout, env), `${CODEX_BASE}\n\n${CODEX_PERMISSIONS}\n\n${PROMPT_SECTIONS["exec.tools"]}`);
  const placebos = [placeboFor("codex.base", CODEX_BASE), placeboFor("codex.permissions", CODEX_PERMISSIONS)];
  assert.deepEqual(plac.loadout.prompt.sections.map((section) => section.id), ["placebo:codex.base", "placebo:codex.permissions", ...base.loadout.prompt.sections.map((section) => section.id)]);
  assert.equal(systemPromptOf(plac.loadout, env), `${placebos.join("\n\n")}\n\n${systemPromptOf(base.loadout, env)}`);
  assert.deepEqual(placebos.map(estimateTokens), [estimateTokens(CODEX_BASE), estimateTokens(CODEX_PERMISSIONS)]);
  for (const phrase of ["Codex", "commentary", "permission", "sandbox", "never", "user", "tool"]) assert.ok(!placebos.join(" ").includes(phrase), `the placebo says "${phrase}"`);
  const withSection = (id: string) => normalizeLoadout({ ...(structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as object), prompt: { sections: [id] } });
  assert.throws(() => withSection("placebo:core.nonexistent"), (error: Error) => error instanceof LoadoutError && /unknown prompt section "placebo:core.nonexistent"/u.test(error.message));
  assert.equal(withSection("placebo:core.verify").prompt.sections[0]!.text, placeboFor("core.verify", PROMPT_SECTIONS["core.verify"]!));
  const hashes = [base, cx, plac].flatMap((loaded) => [loaded.loadoutHash, loaded.behaviorHash]);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/u.test(hash)));
  assert.equal(new Set(hashes).size, hashes.length, "every arm hashes apart from exec-v0 and from each other");
  assert.deepEqual([arm("exec-v0-cx"), arm("exec-v0-cxplac")].map((loaded) => [loaded.loadoutHash, loaded.behaviorHash]), [[cx.loadoutHash, cx.behaviorHash], [plac.loadoutHash, plac.behaviorHash]]);
  const report = Object.fromEntries([base, cx, plac].map((loaded) => [loaded.name, estimateTokens(systemPromptOf(loaded.loadout, env))]));
  assert.ok(report["exec-v0-cx"]! > 20 * report["exec-v0"]! && Math.abs(report["exec-v0-cxplac"]! - report["exec-v0-cx"]!) < 150, JSON.stringify(report));
});

test("over the wire: the system prompt is the arm's, and two runs send byte-identical prefixes", async () => {
  for (const name of ["exec-v0-cx", "exec-v0-cxplac"] as const) {
    const { loadout } = arm(name);
    const runs = [];
    for (let trial = 0; trial < 2; trial++) {
      const run = await runScripted(loadout, EXEC_SCENARIO, { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n") });
      assert.equal(run.result.status, "finished", `${name}: ${JSON.stringify(run.result)}`);
      assert.equal(run.bodies.length, EXEC_SCENARIO.length, name);
      for (const body of run.bodies) assert.equal(systemOf(body), systemPromptOf(loadout, env), `${name}: system prompt`);
      for (let index = 1; index < run.bodies.length; index++) assert.ok(isPrefix(run.bodies[index - 1]!, run.bodies[index]!), `${name}: request ${index + 1} rewrote the prefix`);
      runs.push(run);
    }
    const [first, second] = runs as [(typeof runs)[0], (typeof runs)[0]];
    assert.equal(systemOf(first.bodies[0]!)!.includes(CODEX_BASE), name === "exec-v0-cx", `${name}: codex.base in the system prompt`);
    assert.equal(systemOf(first.bodies[0]!)!.includes(`${CODEX_BASE}\n\n${CODEX_PERMISSIONS}\n\n`), name === "exec-v0-cx", `${name}: codex.permissions right after codex.base`);
    assert.ok(toolsOf(first.bodies[0]!) !== undefined && JSON.stringify(toolsOf(first.bodies[0]!)) === JSON.stringify(toolsOf(second.bodies[0]!)), `${name}: tools differ across runs`);
    assert.equal(systemOf(first.bodies[0]!), systemOf(second.bodies[0]!), `${name}: system prompt differs across runs`);
    assert.deepEqual(first.bodies.map((body) => stableBody(body, first.cwd)), second.bodies.map((body) => stableBody(body, second.cwd)), `${name}: bodies differ across runs`);
  }
});
