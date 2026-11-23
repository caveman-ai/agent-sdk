/**
 * policy.interface_gate (src/interface-gate.ts, src/levers.ts, nested.ts):
 * off by default and hashed as before, fail-closed settings; the per-language
 * function scan (Python, JS/TS, Go, Rust, Java) and what one write did to a
 * file's functions; the gate's rules (scope any/untouched, the task gate,
 * created files, test files, hooks, private helpers the changed code calls,
 * unknown first writes, a shell rewrite against known hashes, max); the
 * ledger's `defs` only while the lever is on; and in a faux run on the exec
 * surface (LocalEnv): the note on the apply_patch result, the trace, the
 * placebo. Offline; no model calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { defDelta, functionSpans, InterfaceGate, isPrivate, type GateWrite } from "../src/interface-gate.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import { DEFAULT_FIX_PATTERNS, estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { nestedTools, newLedger, type NestedShared } from "../src/tools/exec/nested.ts";

const base = (name = "exec-v0") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  raw.policy ??= {};
  patch(raw);
  return normalizeLoadout(raw);
};

// ---------- loadout ----------

test("interface_gate is off by default: absent or false hashes like the built-in; true is scope any, max 1, the default words and text", () => {
  for (const name of ["exec-v0", "compact-v0-plain"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(loadoutHash(withLevers((raw) => (raw.policy.interface_gate = false), name)), loadoutHash(plain), name);
    assert.equal(plain.policy.interface_gate, undefined);
  }
  const on = withLevers((raw) => (raw.policy.interface_gate = true));
  assert.deepEqual(on.policy.interface_gate, { max: 1, scope: "any", task_patterns: [...DEFAULT_FIX_PATTERNS], text: LEVER_TEXTS.interface_gate });
  const some = withLevers((raw) => (raw.policy.interface_gate = { max: 2, scope: "untouched", task_patterns: ["\\bfix\\b"] }));
  assert.deepEqual([some.policy.interface_gate?.max, some.policy.interface_gate?.scope, some.policy.interface_gate?.task_patterns], [2, "untouched", ["\\bfix\\b"]]);
  assert.notEqual(loadoutHash(withLevers((raw) => (raw.policy.interface_gate = { text: "Other {added}." }))), loadoutHash(on));
  assert.equal(withLevers((raw) => {
    raw.policy.interface_gate = true;
    raw.policy.interface_gate_placebo = true;
  }).policy.interface_gate_placebo, true);
});

test("interface_gate settings fail closed: unknown keys, max 0, an unknown scope, empty or invalid patterns, no {added}, a placebo with nothing to replace", () => {
  const bad: [(raw: Record<string, any>) => void, RegExp][] = [
    [(raw) => (raw.policy.interface_gate = { kinds: ["x"] }), /invalid/u],
    [(raw) => (raw.policy.interface_gate = { max: 0 }), /invalid/u],
    [(raw) => (raw.policy.interface_gate = { scope: "all" }), /invalid/u],
    [(raw) => (raw.policy.interface_gate = { task_patterns: [] }), /invalid/u],
    [(raw) => (raw.policy.interface_gate = { task_patterns: ["(unclosed"] }), /task_patterns/u],
    [(raw) => (raw.policy.interface_gate = { text: "{file} only" }), /needs an \{added\}/u],
    [(raw) => (raw.policy.interface_gate_placebo = true), /interface_gate_placebo needs/u],
  ];
  for (const [patch, message] of bad) assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message));
});

test("the default task words: session-window-debug's symptoms and the classic fix words, never a feature spec's should/expected/issues/fixed", () => {
  const fix = (task: string) => DEFAULT_FIX_PATTERNS.some((pattern) => new RegExp(pattern, "iu").test(task));
  for (const task of ["A session window processor at `/app/app/` is not working correctly. Observed symptoms: ...", "Fix the bug in the parser.",
    "The emitted results are inconsistent with the event history.", "It crashes on empty input.", "This is a regression since 2.1.", "The test fails on CI."]) {
    assert.ok(fix(task), task);
  }
  for (const task of ["Implement a CLI. It should write the audit to audit.json; the expected output is in examples/.", "Use a fixed seed.",
    "Report bandit issues incrementally.", "Count test failures per group."]) {
    assert.ok(!fix(task), task);
  }
});

// ---------- the scan ----------

const keys = (path: string, text: string) => functionSpans(path, text)!.filter((span) => span.kind === "function").map((span) => `${span.key}${span.nested ? "*" : ""}@${span.start + 1}-${span.end + 1}`);

test("functions in Python: decorators, multi-line signatures, a def inside a docstring or string is not one, closures are nested", () => {
  const py = [
    "import x", "", "@dataclass", "class C:", "    \"\"\"Doc with def fake():", "", "still doc\"\"\"", "    def m(", "        self,", "        a,", "    ) -> int:",
    "        s = \"\"\"", "not a def x():", "\"\"\"", "        # comment", "# col0 comment", "        return 1", "", "    @property", "    def p(self): return 2", "",
    "def top():", "    def inner():", "        pass", "    return inner", "",
  ].join("\n");
  assert.deepEqual(keys("a.py", py), ["C.m@8-17", "C.p@19-20", "top@22-25", "top.inner*@23-24"]);
});

test("functions in JS/TS: methods, a constructor, a getter, arrow consts, a nested arrow; calls and control blocks are not functions", () => {
  const ts = "export class A {\n  constructor(x) { this.x = x; }\n  async run(a, b) {\n    if (a) {\n      foo(a)\n    }\n    return b;\n  }\n" +
    "  get size(): number { return 1; }\n}\nfunction top(a) {\n  const inner = (y) => y + 1;\n  return inner(a);\n}\n" +
    "const arrow = async (q: string): Promise<void> => {\n  await q;\n};\nfoo(bar)\nif (x) {\n  y();\n}\nconst s = `function fake() {`;\n";
  assert.deepEqual(keys("a.ts", ts), ["A.constructor@2-2", "A.run@3-8", "A.size@9-9", "top@11-14", "top.inner*@12-12", "arrow@15-17"]);
});

test("functions in Go, Rust and Java: receivers, generics, char literals and lifetimes, constructors; declarations without a body are not", () => {
  const go = "package p\n\ntype S struct {\n  a int\n}\n\nfunc (s *S) Run(x int) (int, error) {\n  if x > 0 {\n    return 1, nil\n  }\n  return 0, nil\n}\n\n" +
    "func helper[T any](t T) T {\n  f := func() { }\n  _ = f\n  return t\n}\n\nfunc decl()\n";
  assert.deepEqual(keys("a.go", go), ["S.Run@7-12", "helper@14-18"]);
  const rs = "struct S;\nimpl S {\n    pub fn new() -> Self { S }\n    fn run<'a>(&'a self, c: char) -> Option<&'a str> where Self: Sized {\n        let q = '{';\n" +
    "        None\n    }\n}\ntrait T { fn t(&self); }\nfn main() {}\n";
  assert.deepEqual(keys("a.rs", rs), ["S.new@3-3", "S.run@4-7", "main@10-10"]);
  const java = "package p;\npublic class Foo extends Bar {\n  private int x;\n  public Foo(int x) { this.x = x; }\n  @Override\n  public String toString() {\n" +
    "    return \"x{\" + x;\n  }\n  static <T> List<T> wrap(T t) throws IOException {\n    if (t == null) { return null; }\n    return List.of(t);\n  }\n  abstract void decl();\n" +
    "  public void run()\n  {\n    throw new IllegalStateException(\"x\");\n  }\n}\n";
  assert.deepEqual(keys("Foo.java", java), ["Foo.Foo@4-4", "Foo.toString@6-8", "Foo.wrap@9-12", "Foo.run@14-17"]);
  assert.equal(functionSpans("notes.md", "def x():"), undefined, "not code the gate reads");
});

const EVENTS = [
  "from app.types import Clock, Event", "", "", "class EventSource:", "    def __init__(self, clock):", "        self._clock = clock", "        self._w = {}", "",
  "    def ingest(self, event):", "        if event.time > self._w.get(event.source, 0):", "            self._w[event.source] = event.time", "        self._recompute()", "",
  "    def advance_time(self, ticks=1):", "        for _ in range(ticks):", "            self._clock.now()", "        self._recompute()", "",
  "    def _recompute(self):", "        self.watermark = min(self._w.values(), default=0)", "",
].join("\n");
const addMethod = (text: string, method: string) => text.replace("    def _recompute(self):", `${method}\n\n    def _recompute(self):`);
const OPT_IN = "    def advance_watermark(self, source, t):\n        self._w[source] = max(self._w.get(source, 0), t)\n        self._recompute()";
const put = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
const OPT_IN_PATCH = `*** Begin Patch\n*** Update File: app/events.py\n@@\n         self._recompute()\n \n+${OPT_IN.split("\n").join("\n+")}\n+\n     def _recompute(self):\n*** End Patch\n`;

test("what a write did: the failing session-window shape adds a method and changes none; the passing one changes advance_time; a new file is created", () => {
  assert.deepEqual(defDelta("events.py", EVENTS, addMethod(EVENTS, OPT_IN)), {
    added: ["EventSource.advance_watermark"], changed: [], calls: [], spans: defDelta("events.py", undefined, addMethod(EVENTS, OPT_IN))!.spans,
  });
  const fixed = EVENTS.replace("            self._clock.now()\n", "            self._clock.now()\n        now = self._clock.peek()\n        self._w = {s: max(w, now) for s, w in self._w.items()}\n");
  const delta = defDelta("events.py", EVENTS, fixed)!;
  assert.deepEqual([delta.added, delta.changed], [[], ["EventSource.advance_time"]]);
  assert.ok(delta.calls.includes("peek") && !delta.calls.includes("range"), "identifiers on the added lines only");
  assert.deepEqual([defDelta("new.py", undefined, EVENTS)?.created, defDelta("new.py", undefined, EVENTS)?.added], [true, []]);
  assert.equal(defDelta("data.json", "{}", "{\"a\": 1}"), undefined);
  assert.deepEqual(defDelta("events.py", EVENTS, EVENTS.replace("\n\n\nclass", "\n\n\n\nclass"))?.changed, [], "moved, not changed");
});

// ---------- the gate ----------

const FIX_TASK = "A session window processor at /app/app/ is not working correctly. Observed symptoms: output stalls.";

function gate(options: { task?: string; scope?: "any" | "untouched"; max?: number; placebo?: boolean } = {}) {
  const events: [string, Record<string, unknown>][] = [];
  const recorder = { usage: { requests: 7 } as never, policy: (action: string, _reason: string, fields: Record<string, unknown> = {}) => void events.push([action, fields]) };
  const lever = { max: options.max ?? 1, scope: options.scope ?? "any", task_patterns: [...DEFAULT_FIX_PATTERNS], text: LEVER_TEXTS.interface_gate };
  const g = new InterfaceGate({ lever, placebo: options.placebo ?? false, recorder, task: options.task ?? FIX_TASK, cwd: "/app" });
  const patch = (path: string, before: string | undefined, after: string): GateWrite => ({ path: `/app/${path}`, defs: defDelta(path, before, after)! });
  return { g, events, patch };
}
const noteFor = (file: string, added: string) => LEVER_TEXTS.interface_gate.replace("{file}", file).replace("{added}", added);

test("scope any: a new public method in a start file fires, even beside changed start functions; once (max), the rest recorded as skipped", () => {
  const { g, events, patch } = gate();
  const ingestChanged = addMethod(EVENTS, OPT_IN).replace("        if event.time > self._w.get(event.source, 0):\n            self._w[event.source] = event.time\n",
    "        self.advance_watermark(event.source, event.time)\n");
  assert.equal(g.observe([patch("app/events.py", EVENTS, ingestChanged)], "exec", 5), noteFor("app/events.py", "EventSource.advance_watermark()"));
  const merger = "class Merger:\n    def merge(self, a, b):\n        return a\n";
  assert.equal(g.observe([patch("app/merger.py", merger, `${merger}\n    def merge_all(self, xs):\n        return xs\n`)], "exec", 6), undefined);
  assert.deepEqual(events, [
    ["remind", { n: 1, file: "app/events.py", added: ["EventSource.advance_watermark()"], tool: "exec", request: 5, placebo: false }],
    ["skip", { file: "app/merger.py", added: ["Merger.merge_all()"], tool: "exec", request: 6, cause: "max" }],
  ]);
});

test("scope untouched: only while no start function of the file changed, in this write or earlier; private helpers count there", () => {
  const { g, patch } = gate({ scope: "untouched" });
  const ingestChanged = EVENTS.replace("        self._recompute()\n\n    def advance_time", "        self._recompute()  # note\n\n    def advance_time");
  assert.equal(g.observe([patch("app/events.py", EVENTS, ingestChanged)], "exec", 3), undefined);
  assert.equal(g.observe([patch("app/events.py", ingestChanged, addMethod(ingestChanged, OPT_IN))], "exec", 4), undefined, "ingest changed earlier");
  const other = gate({ scope: "untouched" });
  const helper = "    def _idle(self):\n        return True";
  assert.equal(other.g.observe([other.patch("app/events.py", EVENTS, addMethod(EVENTS, helper))], "exec", 3), noteFor("app/events.py", "EventSource._idle()"));
});

test("never: a file the run created, a test file or test directory, a hook, a private function, a task that does not read as a fix (recorded)", () => {
  const { g, events, patch } = gate();
  assert.equal(g.observe([patch("app/new_mod.py", undefined, EVENTS)], "exec", 1), undefined, "created");
  assert.equal(g.observe([patch("app/new_mod.py", EVENTS, addMethod(EVENTS, OPT_IN))], "exec", 2), undefined, "created by the run, edited later");
  const testText = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n";
  for (const path of ["tests/test_events.py", "app/test_events.py", "app/conftest.py"]) {
    assert.equal(g.observe([patch(path, testText, `${testText}\n    def test_b(self):\n        pass\n`)], "exec", 3), undefined, path);
  }
  const java = "class FooTest {\n  void a() {}\n}\n";
  assert.equal(g.observe([patch("src/FooTest.java", java, java.replace("void a() {}", "void a() {}\n  void b() {}"))], "exec", 3), undefined, "FooTest.java");
  assert.equal(g.observe([patch("app/events.py", EVENTS, addMethod(EVENTS, "    def __eq__(self, other):\n        return True\n\n    def _helper(self):\n        return 1"))], "exec", 4),
    undefined, "a dunder and a private helper");
  assert.deepEqual(events, []);
  const feature = gate({ task: "Implement a replay CLI; it should write the audit file." });
  assert.equal(feature.g.observe([feature.patch("app/events.py", EVENTS, addMethod(EVENTS, OPT_IN))], "exec", 2), undefined);
  assert.deepEqual(feature.events.map(([action, fields]) => [action, fields.cause, fields.added]), [["skip", "task", ["EventSource.advance_watermark()"]]]);
  assert.equal(feature.g.fixTask, false);
});

test("private helpers: untouched skips one the changed start code calls; Go's lowercase and JS's # are private", () => {
  const { g, patch } = gate({ scope: "untouched" });
  const withHelper = addMethod(EVENTS, "    def _bump(self, source, t):\n        self._w[source] = t")
    .replace("        if event.time > self._w.get(event.source, 0):\n            self._w[event.source] = event.time\n", "        self._bump(event.source, event.time)\n");
  assert.equal(g.observe([patch("app/events.py", EVENTS, withHelper)], "exec", 2), undefined);
  assert.deepEqual([isPrivate("helper", "a.go"), isPrivate("Helper", "a.go"), isPrivate("#x", "a.ts"), isPrivate("_x", "a.py"), isPrivate("x", "a.py")], [true, false, true, true, false]);
  const go = gate();
  const src = "package p\n\ntype S struct{}\n\nfunc (s *S) Run() {}\n";
  assert.equal(go.g.observe([go.patch("p/s.go", src, `${src}\nfunc (s *S) idle() {}\n`)], "exec", 1), undefined, "unexported");
  assert.equal(go.g.observe([go.patch("p/s.go", `${src}\nfunc (s *S) idle() {}\n`, `${src}\nfunc (s *S) idle() {}\n\nfunc (s *S) Advance() {}\n`)], "exec", 2),
    noteFor("p/s.go", "S.Advance()"));
});

test("shell writes: a first write the gate cannot read leaves the file unknown (never fires); a here-doc rewrite of a known file is judged by its hashes", () => {
  const { g, patch } = gate();
  assert.equal(g.observe([{ path: "/app/app/gc.py", text: EVENTS }], "exec", 1), undefined, "first seen by a shell write");
  assert.equal(g.observe([{ path: "/app/app/gc.py", text: addMethod(EVENTS, OPT_IN) }], "exec", 2), undefined, "unknown origin");
  assert.equal(g.observe([patch("app/events.py", EVENTS, EVENTS.replace("ticks=1", "ticks=2"))], "exec", 3), undefined);
  assert.equal(g.observe([{ path: "/app/app/events.py", text: addMethod(EVENTS.replace("ticks=1", "ticks=2"), OPT_IN) }], "exec", 4),
    noteFor("app/events.py", "EventSource.advance_watermark()"));
  const unread = gate();
  unread.g.observe([unread.patch("app/events.py", EVENTS, EVENTS.replace("ticks=1", "ticks=2"))], "exec", 1);
  assert.equal(unread.g.observe([{ path: "/app/app/events.py" }, { path: "/app/app/events.py", text: addMethod(EVENTS, OPT_IN) }], "exec", 2), undefined, "sed -i, then a rewrite");
});

test("the ledger carries defs only while the lever is on (shared.defs), so a run without it records patches as before", async () => {
  for (const on of [false, true]) {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-iface-")));
    put(cwd, "app/events.py", EVENTS);
    const env = new LocalEnv({ cwd });
    try {
      const shared: NestedShared = { env, sessions: new Map(), nextSession: 1, chunks: 0, inflight: new Map(), ...(on ? { defs: defDelta } : {}) };
      const ledger = newLedger();
      const [applyPatch] = nestedTools(shared, { apply_patch: { exposure: "eager", limits: {} } }, ledger);
      await applyPatch!.execute(OPT_IN_PATCH, { signal: new AbortController().signal });
      const file = (ledger.log[0] as { files: { path: string; added: string; defs?: unknown }[] }).files[0]!;
      assert.equal(file.path, join(cwd, "app/events.py"));
      if (on) assert.deepEqual((file.defs as { added: string[] }).added, ["EventSource.advance_watermark"]);
      else assert.equal("defs" in file, false);
    } finally {
      await env.close();
    }
  }
});

// ---------- in a run ----------


async function fauxRun(loadout: Loadout, steps: FauxStep[], prompt = FIX_TASK) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-iface-")));
  put(cwd, "app/events.py", EVENTS);
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-iface-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({ prompt, model: "faux/iface", effort: "high", loadout, env, tracePath, fauxSteps: scripted });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, cwd };
  } finally {
    await env.close();
  }
}

const cell = (script: string): FauxStep => ({ toolCalls: [{ name: "exec", arguments: { input: script } }] });
const patchCell = (patch: string) => cell(`text(await tools.apply_patch(${JSON.stringify(patch)}));`);
const textOf = (message: { content: unknown }) => typeof message.content === "string" ? message.content
  : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastResult = (context: TranscriptContext) => textOf([...context.messages].reverse().find((message) => message.role === "toolResult")!);
const gateEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy" && event.reason === "interface_gate");
const NOTE = noteFor("app/events.py", "EventSource.advance_watermark()");

test("in a run: the note rides on the apply_patch result that added the method; a second one is skipped (max); off, nothing changes", async () => {
  const second = "*** Begin Patch\n*** Update File: app/events.py\n@@\n     def _recompute(self):\n+        pass\n+\n+    def mark_idle(self, source):\n+        pass\n+\n+    def _recompute2(self):\n*** End Patch\n";
  const loadout = withLevers((raw) => (raw.policy.interface_gate = true));
  const run = await fauxRun(loadout, [patchCell(OPT_IN_PATCH), patchCell(second), { text: "Done." }]);
  assert.ok(lastResult(run.contexts[1]!).endsWith(`\n[harness] ${NOTE}`), lastResult(run.contexts[1]!));
  assert.ok(!lastResult(run.contexts[2]!).includes("[harness]"));
  assert.deepEqual(gateEvents(run.events).map((event) => [event.action, event.file, event.added, event.tool, event.request, event.cause]), [
    ["remind", "app/events.py", ["EventSource.advance_watermark()"], "exec", 1, undefined],
    ["skip", "app/events.py", ["EventSource.mark_idle()"], "exec", 2, "max"],
  ]);
  const off = await fauxRun(normalizeLoadout(base()), [patchCell(OPT_IN_PATCH), { text: "Done." }]);
  assert.ok(!lastResult(off.contexts[1]!).includes("[harness]"));
  assert.deepEqual(gateEvents(off.events), []);
});

test("in a run: a fix of the existing method, a new file and a new test file carry no note", async () => {
  const loadout = withLevers((raw) => (raw.policy.interface_gate = true));
  const fix = "*** Begin Patch\n*** Update File: app/events.py\n@@\n         for _ in range(ticks):\n             self._clock.now()\n+        self._w = {s: max(w, self._clock.peek()) for s, w in self._w.items()}\n*** End Patch\n";
  const add = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+def helper():\n+    return 1\n*** End Patch\n`;
  const run = await fauxRun(loadout, [patchCell(fix), patchCell(add("app/idle.py")), patchCell(add("tests/test_idle.py")), { text: "Done." }]);
  for (const at of [1, 2, 3]) assert.ok(!lastResult(run.contexts[at]!).includes("[harness]"), `step ${at}`);
  assert.deepEqual(gateEvents(run.events), []);
});

test("interface_gate placebo: the same trigger appends neutral text of the note's estimated token count", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.interface_gate = true;
    raw.policy.interface_gate_placebo = true;
  });
  const run = await fauxRun(loadout, [patchCell(OPT_IN_PATCH), { text: "Done." }]);
  const sent = lastResult(run.contexts[1]!).split("\n[harness] ")[1]!;
  assert.equal(sent, placeboFor("interface_gate", NOTE));
  assert.equal(estimateTokens(sent), estimateTokens(NOTE));
  assert.doesNotMatch(sent, /\b(?:method|function|interface|test|fix|call)\w*/iu);
  assert.equal(gateEvents(run.events)[0]?.placebo, true);
});
