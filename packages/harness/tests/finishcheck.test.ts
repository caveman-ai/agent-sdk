/**
 * The finish checks, offline (pure rules, a real git in a temp dir, the faux
 * model, and the loopback Responses server for what the provider receives):
 * - policy.test_isolation: a test file the run created that uses helpers
 *   defined only in another test file the run wrote gets one reminder naming
 *   them; never twice; under P4's 90% budget guard; after P1 in the order.
 * - policy.evidence_bounce: a draft final that names no requirement-level
 *   check (finalclass.py's rules) is bounced once.
 * - each `_placebo`: the same trigger, neutral text of equal estimated tokens.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { agentTestFiles, evidenceClass, isolationFindings, readBaseline, testLanguage, type AgentTestFile } from "../src/finishcheck.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { DEFAULT_EVIDENCE_PATTERNS, estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { isPrefix, runScripted } from "./openai-loopback.ts";

const loadoutDir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");
const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};
const PATTERNS = {
  requirement: DEFAULT_EVIDENCE_PATTERNS.requirement.map((source) => new RegExp(source, "iu")),
  proxy: DEFAULT_EVIDENCE_PATTERNS.proxy.map((source) => new RegExp(source, "iu")),
};
const created = (path: string, text: string): AgentTestFile => ({ path, created: true, text });
const modified = (path: string, text: string): AgentTestFile => ({ path, created: false, text });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();
function repo(files: Record<string, string> = {}): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-fc-")));
  git(cwd, "init", "-q");
  for (const [path, text] of Object.entries({ "go.mod": "module x\n", ...files })) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  return cwd;
}
const put = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};

const GO_DIFF = "package etree\n\nimport \"testing\"\n\nfunc diffTestDoc(t *testing.T, s string) *Doc { return nil }\n\nfunc TestDiff(t *testing.T) { _ = diffTestDoc(t, \"\") }\n";
const GO_MERGE = "package etree\n\nimport \"testing\"\n\nfunc TestMerge(t *testing.T) {\n\td := diffTestDoc(t, \"<a/>\")\n\t_ = d\n}\n";

// ---------- loadout ----------

test("the finish checks are off by default: absent or false normalizes and hashes like the built-in", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    for (const key of ["test_isolation", "test_isolation_placebo", "evidence_bounce", "evidence_bounce_placebo"] as const) assert.equal(plain.policy[key], undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, test_isolation: false, test_isolation_placebo: false, evidence_bounce: false, evidence_bounce_placebo: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns them on with the default wording and patterns; wording and patterns enter the behavior hash", () => {
  const on = withLevers((raw) => {
    raw.policy.test_isolation = true;
    raw.policy.evidence_bounce = true;
  });
  assert.deepEqual(on.policy.test_isolation, { text: LEVER_TEXTS.test_isolation });
  assert.deepEqual(on.policy.evidence_bounce, {
    requirement_patterns: [...DEFAULT_EVIDENCE_PATTERNS.requirement], proxy_patterns: [...DEFAULT_EVIDENCE_PATTERNS.proxy], text: LEVER_TEXTS.evidence_bounce,
  });
  const worded = withLevers((raw) => {
    raw.policy.test_isolation = { text: "Isolate:\n{items}" };
    raw.policy.evidence_bounce = { requirement_patterns: ["tests pass"] };
  });
  assert.equal(worded.policy.test_isolation?.text, "Isolate:\n{items}");
  assert.deepEqual(worded.policy.evidence_bounce?.requirement_patterns, ["tests pass"]);
  assert.notEqual(loadoutHash(worded), loadoutHash(on));
  const placebo = withLevers((raw) => {
    raw.policy.test_isolation = true;
    raw.policy.test_isolation_placebo = true;
    raw.policy.evidence_bounce = true;
    raw.policy.evidence_bounce_placebo = true;
  });
  assert.equal(placebo.policy.test_isolation_placebo, true);
  assert.equal(placebo.policy.evidence_bounce_placebo, true);
  assert.notEqual(loadoutHash(placebo), loadoutHash(on));
});

test("the finish checks' settings fail closed: unknown keys, empty text, bad regex, a placebo with nothing to replace", () => {
  const bad: [string, (raw: Record<string, any>) => void, RegExp][] = [
    ["unknown key", (raw) => (raw.policy.test_isolation = { max: 2 }), /max/u],
    ["empty text", (raw) => (raw.policy.evidence_bounce = { text: "" }), /evidence_bounce/u],
    ["empty patterns", (raw) => (raw.policy.evidence_bounce = { proxy_patterns: [] }), /evidence_bounce/u],
    ["bad regex", (raw) => (raw.policy.evidence_bounce = { requirement_patterns: ["(unclosed"] }), /evidence_bounce patterns/u],
    ["iso placebo alone", (raw) => (raw.policy.test_isolation_placebo = true), /test_isolation_placebo needs/u],
    ["eb placebo alone", (raw) => (raw.policy.evidence_bounce_placebo = true), /evidence_bounce_placebo needs/u],
  ];
  for (const [label, patch, message] of bad) {
    assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message), label);
  }
});

// ---------- rules ----------

test("test files by kind: Go _test.go, Python test_*.py / *_test.py (never conftest.py), JS/TS *.test.* / *.spec.*; vendored and build trees are not the run's", () => {
  const kinds = ["a_test.go", "pkg/test_a.py", "a_test.py", "conftest.py", "src/a.test.ts", "a.spec.mjs", "a.go", "testing.py", "node_modules/x/a.test.js", "dist/a.test.js", "vendor/a_test.go"]
    .map((path) => `${path}:${testLanguage(path) ?? "-"}`);
  assert.deepEqual(kinds, [
    "a_test.go:go", "pkg/test_a.py:python", "a_test.py:python", "conftest.py:-", "src/a.test.ts:js", "a.spec.mjs:js", "a.go:-", "testing.py:-",
    "node_modules/x/a.test.js:-", "dist/a.test.js:-", "vendor/a_test.go:-",
  ]);
});

test("Go: a new test file calling a helper another new test file of the package defines is a finding (the etree pattern)", () => {
  assert.deepEqual(isolationFindings([created("diff_test.go", GO_DIFF), created("merge_test.go", GO_MERGE)]), [
    { lang: "go", file: "merge_test.go", from: "diff_test.go", names: ["diffTestDoc"] },
  ]);
  // Types, grouped vars and consts count too; Test/Benchmark/Example/Fuzz funcs and methods do not.
  const helpers = "package p\n\ntype fixture struct{}\n\nvar (\n\tgolden, other = 1, 2\n)\n\nconst limit = 3\n\nfunc (f fixture) run() {}\n\nfunc TestHelpers(t *testing.T) {}\n";
  const user = "package p\n\nfunc TestUse(t *testing.T) {\n\tvar f fixture\n\tf.run()\n\t_ = golden + limit\n\tTestHelpers(t)\n}\n";
  assert.deepEqual(isolationFindings([created("h_test.go", helpers), created("u_test.go", user)])[0]?.names, ["fixture", "golden", "limit"]);
});

test("Go: no finding for a different directory or package, a selector, a local of the same name, a comment or string, or a helper the modified file already had", () => {
  const none = (files: AgentTestFile[]) => assert.deepEqual(isolationFindings(files), [], files.map((file) => file.path).join(" "));
  none([created("a/diff_test.go", GO_DIFF), created("b/merge_test.go", GO_MERGE)]);
  none([created("diff_test.go", GO_DIFF), created("merge_test.go", GO_MERGE.replace("package etree", "package etree_test"))]);
  none([created("diff_test.go", GO_DIFF), created("merge_test.go", "package etree\n\nfunc TestM(t *testing.T) {\n\tx.diffTestDoc(t, \"\")\n}\n")]);
  none([created("diff_test.go", GO_DIFF), created("merge_test.go", "package etree\n\nfunc TestM(t *testing.T) {\n\tdiffTestDoc := 1\n\t_ = diffTestDoc\n}\n")]);
  none([created("diff_test.go", GO_DIFF), created("merge_test.go", "package etree\n\n// diffTestDoc(t) would help\nfunc TestM(t *testing.T) { t.Log(\"diffTestDoc(\") }\n")]);
  // diff_test.go existed: the run added only TestMore, so diffTestDoc is the base's and a grader's copy keeps it.
  none([modified("diff_test.go", "func TestMore(t *testing.T) {}"), created("merge_test.go", GO_MERGE)]);
  // ...but a helper the run added to an existing test file is the run's.
  assert.equal(isolationFindings([modified("diff_test.go", "func diffTestDoc(t *testing.T, s string) *Doc { return nil }"), created("merge_test.go", GO_MERGE)]).length, 1);
  // A modified file is never the importer: only files the run created are checked.
  none([created("diff_test.go", GO_DIFF), modified("merge_test.go", "\td := diffTestDoc(t, \"<a/>\")")]);
});

test("Go grouped declarations: only a group's own entries are names, never the lines of a func literal, a struct or composite literal, or a wrapped expression inside it", () => {
  const none = (files: AgentTestFile[]) => assert.deepEqual(isolationFindings(files), [], files.map((file) => file.path).join(" "));
  // A self-contained table test: `if`, `t`, `name`, `in`, `want` are its own.
  const table = "package calc\n\nimport \"testing\"\n\nfunc TestSub(t *testing.T) {\n\ttests := []struct {\n\t\tname string\n\t\tin   int\n\t\twant int\n\t}{\n\t\t{\"one\", 1, 0},\n\t}\n" +
    "\tfor _, tc := range tests {\n\t\tif tc.in-1 != tc.want {\n\t\t\tt.Errorf(\"%s\", tc.name)\n\t\t}\n\t}\n}\n\nfunc check(offset int) int { return offset }\n";
  const funcLiteral = "package calc\n\nimport \"testing\"\n\nvar (\n\tmustParse = func(t *testing.T, s string) int {\n\t\tt.Helper()\n\t\tif s == \"\" {\n\t\t\tt.Fatal(\"empty\")\n\t\t}\n\t\treturn len(s)\n\t}\n)\n\n" +
    "func TestParse(t *testing.T) { _ = mustParse(t, \"1\") }\n";
  const structLiteral = "package calc\n\nvar (\n\taddCases = []struct {\n\t\tname string\n\t\tin   int\n\t\twant int\n\t}{\n\t\t{name: \"one\", in: 1, want: 2},\n\t}\n\tinline = []struct{ name string }{{name: \"x\"}}\n)\n";
  const typeAndWrapped = "package calc\n\ntype (\n\tfixture struct {\n\t\tname string\n\t\tin   int\n\t}\n\tresult = int\n)\n\nvar (\n\tlimit = base +\n\t\toffset\n)\n\nconst (\n\tfirst = iota\n\tsecond\n)\n";
  none([created("calc/parse_test.go", funcLiteral), created("calc/sub_test.go", table)]);
  none([created("calc/add_test.go", structLiteral), created("calc/sub_test.go", table)]);
  none([created("calc/types_test.go", typeAndWrapped), created("calc/sub_test.go", table)]);
  // The group's real entries still count.
  const user = "package calc\n\nfunc TestUse(t *testing.T) {\n\t_ = mustParse(t, \"2\")\n\t_ = addCases\n\t_ = inline\n\tvar f fixture\n\tvar r result = limit + second\n\t_, _ = f, r\n}\n";
  assert.deepEqual(isolationFindings([created("calc/parse_test.go", funcLiteral), created("calc/add_test.go", structLiteral), created("calc/types_test.go", typeAndWrapped), created("calc/use_test.go", user)]), [
    { lang: "go", file: "calc/use_test.go", from: "calc/parse_test.go", names: ["mustParse"] },
    { lang: "go", file: "calc/use_test.go", from: "calc/add_test.go", names: ["addCases", "inline"] },
    { lang: "go", file: "calc/use_test.go", from: "calc/types_test.go", names: ["fixture", "limit", "result", "second"] },
  ]);
  // Keywords and predeclared names are never helpers, even where an entry would sit.
  none([created("calc/odd_test.go", "package calc\n\nvar (\n\tlen = 3\n\tnil_ = 1\n)\n"), created("calc/sub_test.go", "package calc\n\nfunc TestL(t *testing.T) { _ = len(\"x\") }\n")]);
});

test("a modified test file: a declaration the run only changed (signature, flag help, gofmt) was there at the start and is not the run's; only names the start lacked count", () => {
  const none = (files: AgentTestFile[]) => assert.deepEqual(isolationFindings(files), [], files.map((file) => file.path).join(" "));
  const withBase = (path: string, text: string, base: string): AgentTestFile => ({ path, created: false, text, base });
  const dbBase = "package db\n\nimport \"flag\"\n\nvar update = flag.Bool(\"update\", false, \"update golden files\")\n\nfunc setupDB(t *testing.T) *DB { return nil }\n";
  const feature = "package db\n\nfunc TestFeature(t *testing.T) {\n\tdb := setupDB(t)\n\t_ = db\n\tif *update {\n\t}\n}\n";
  none([withBase("db_test.go", "func setupDB(t testing.TB) *DB { return nil }\nvar update = flag.Bool(\"update\", false, \"rewrite golden files\")", dbBase), created("feature_test.go", feature)]);
  assert.deepEqual(isolationFindings([withBase("db_test.go", "func setupDB(t testing.TB) *DB { return nil }\nfunc seed(db *DB) {}", dbBase), created("feature_test.go", feature.replace("_ = db", "seed(db)"))]), [
    { lang: "go", file: "feature_test.go", from: "db_test.go", names: ["seed"] },
  ]);
  // The start file names the package when the added lines do not.
  none([withBase("db_test.go", "func seed(db *DB) {}", dbBase.replace("package db", "package db_test")), created("feature_test.go", feature.replace("_ = db", "seed(db)"))]);
  const pyBase = "def make_client(app):\n    return app\n";
  none([withBase("tests/test_base.py", "def make_client(app, *, auth=None):", pyBase), created("tests/test_feature.py", "from test_base import make_client\n")]);
  assert.deepEqual(isolationFindings([withBase("tests/test_base.py", "def make_client(app, *, auth=None):\ndef make_admin(app):", pyBase), created("tests/test_feature.py", "from test_base import make_client, make_admin\n")])[0]?.names, ["make_admin"]);
  none([withBase("src/a.test.ts", "export function render(x: string, y = 1) { return x; }", "export function render(x: string) { return x; }\n"), created("src/b.test.ts", "import { render } from './a.test';\n")]);
});

test("Python: a new test module importing a sibling test module the run wrote is a finding; conftest, non-test and non-sibling modules are not", () => {
  const helpers = created("tests/test_api.py", "def call(x):\n    return x\n\ndef test_api():\n    assert call(1)\n");
  assert.deepEqual(isolationFindings([helpers, created("tests/test_ui.py", "from test_api import call\n\ndef test_ui():\n    assert call(2)\n")]), [
    { lang: "python", file: "tests/test_ui.py", from: "tests/test_api.py", names: ["call"] },
  ]);
  assert.deepEqual(isolationFindings([helpers, created("tests/test_ui.py", "from .test_api import (\n    call,\n)\n")])[0]?.names, ["call"]);
  assert.deepEqual(isolationFindings([helpers, created("tests/test_ui.py", "import tests.test_api as api\n\ndef test_ui():\n    api.call(1)\n")])[0]?.names, ["call"]);
  assert.deepEqual(isolationFindings([helpers, created("tests/test_ui.py", "from tests import test_api\n\ndef test_ui():\n    test_api.call(1)\n")])[0]?.names, ["call"]);
  const none = (files: AgentTestFile[]) => assert.deepEqual(isolationFindings(files), [], files.map((file) => file.path).join(" "));
  none([created("tests/conftest.py", "def call(x): ...\n"), created("tests/test_ui.py", "from conftest import call\n")]);
  none([created("tests/helpers.py", "def call(x): ...\n"), created("tests/test_ui.py", "from helpers import call\n")]);
  // A package module named *_test.py elsewhere (mobly's base_test.py) is a library, not a sibling test module.
  none([modified("mobly/base_test.py", "class _Sync:\n    pass\n"), created("tests/mobly/grouped_test.py", "from mobly import base_test\nbase_test._Sync()\n")]);
  // A modified sibling counts only through what the run added to it.
  none([modified("tests/test_api.py", "def test_more():\n    pass\n"), created("tests/test_ui.py", "from test_api import call\n")]);
  assert.equal(isolationFindings([modified("tests/test_api.py", "def call(x):\n    return x\n"), created("tests/test_ui.py", "from test_api import call\n")]).length, 1);
});

test("JS/TS: a new test file importing a sibling *.test.* / *.spec.* the run wrote is a finding; non-test helpers and untouched exports are not", () => {
  const helpers = created("src/a.test.ts", "export function render(x: string) { return x; }\ntest('a', () => {});\n");
  assert.deepEqual(isolationFindings([helpers, created("src/b.test.ts", "import { render } from './a.test.js';\ntest('b', () => render('b'));\n")]), [
    { lang: "js", file: "src/b.test.ts", from: "src/a.test.ts", names: ["render"] },
  ]);
  assert.equal(isolationFindings([helpers, created("src/c.spec.ts", "const { render } = require('./a.test');\n")]).length, 1);
  const none = (files: AgentTestFile[]) => assert.deepEqual(isolationFindings(files), [], files.map((file) => file.path).join(" "));
  none([created("src/helpers.ts", "export function render() {}\n"), created("src/b.test.ts", "import { render } from './helpers';\n")]);
  none([modified("src/a.test.ts", "test('more', () => {});"), created("src/b.test.ts", "import { render } from './a.test';\n")]);
  none([helpers, created("src/b.test.ts", "// import { render } from './a.test';\nimport { x } from 'pkg';\n")]);
});

test("evidence_bounce classes (finalclass.py): requirement wins; else proxy-only; else none", () => {
  const cases: [string, string][] = [
    ["All 42 tests pass, including the new regression test.", "requirement"],
    ["Implemented the parser; the output matches the expected file byte-for-byte.", "requirement"],
    ["Verified that the server returns 404 for missing keys.", "requirement"],
    ["The JSON is well-formed and the script runs without errors.", "proxy_only"],
    ["Checked syntax with py_compile; the module imports cleanly.", "proxy_only"],
    ["Wrote /app/answer.txt with the computed value.", "none"],
    ["", "none"],
  ];
  for (const [text, klass] of cases) assert.equal(evidenceClass(text, PATTERNS), klass, text);
});

// ---------- the workspace ----------

test("git workspace: created test files are read whole, modified ones as their added lines, against the start commit (an agent commit still counts); files dirty at start are not the run's", async () => {
  const cwd = repo({ "old_test.go": "package etree\n\nfunc oldHelper() {}\n", "keep_test.go": "package etree\n" });
  put(cwd, "stray_test.go", "package etree\n"); // untracked before the run: not the run's
  const env = new LocalEnv({ cwd });
  try {
    const baseline = await readBaseline(env);
    assert.equal(baseline?.git, true);
    put(cwd, "diff_test.go", GO_DIFF);
    put(cwd, "merge_test.go", GO_MERGE);
    put(cwd, "old_test.go", "package etree\n\nfunc oldHelper() {}\n\nfunc newHelper() {}\n");
    put(cwd, "stray_test.go", "package etree\n\nfunc strayHelper() {}\n");
    put(cwd, "notes.txt", "x\n");
    git(cwd, "add", "diff_test.go");
    git(cwd, "commit", "-q", "-m", "agent commit"); // the agent commits one of its files
    const files = (await agentTestFiles(env, baseline)).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(files.map((file) => `${file.path}:${file.created ? "created" : "modified"}`), ["diff_test.go:created", "merge_test.go:created", "old_test.go:modified"]);
    assert.equal(files[0]!.text, GO_DIFF);
    assert.equal(files[2]!.text, "\nfunc newHelper() {}", "only the added lines");
    assert.deepEqual(isolationFindings(files).map((finding) => `${finding.file}<-${finding.from}`), ["merge_test.go<-diff_test.go"]);
  } finally {
    await env.close();
  }
});

test("git workspace, from a subdirectory: a modified test file carries its start version, so a helper whose signature the run changed is not reported, and a new one is", async () => {
  const dbBase = "package db\n\nimport (\n\t\"flag\"\n\t\"testing\"\n)\n\nvar update = flag.Bool(\"update\", false, \"update golden files\")\n\n" +
    "func setupDB(t *testing.T) *DB {\n\tt.Helper()\n\treturn &DB{}\n}\n\nfunc TestDB(t *testing.T) { _ = setupDB(t) }\n";
  const pyBase = "def make_client(app):\n    return app\n\n\ndef test_base():\n    assert make_client(1)\n";
  const root = repo({ "svc/db_test.go": dbBase, "svc/tests/test_base.py": pyBase });
  const env = new LocalEnv({ cwd: join(root, "svc") });
  try {
    const baseline = await readBaseline(env);
    put(root, "svc/db_test.go", dbBase.replace("t *testing.T) *DB", "t testing.TB) *DB").replace("update golden files", "rewrite golden files"));
    put(root, "svc/feature_test.go", "package db\n\nimport \"testing\"\n\nfunc TestFeature(t *testing.T) {\n\tdb := setupDB(t)\n\t_ = db\n\tif *update {\n\t\tt.Log(\"x\")\n\t}\n}\n");
    put(root, "svc/tests/test_base.py", pyBase.replace("def make_client(app):", "def make_client(app, *, auth=None):"));
    put(root, "svc/tests/test_feature.py", "from test_base import make_client\n\n\ndef test_feature():\n    assert make_client(2, auth=None)\n");
    const files = (await agentTestFiles(env, baseline)).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(files.map((file) => `${file.path}:${file.created ? "created" : "modified"}`), ["db_test.go:modified", "feature_test.go:created", "tests/test_base.py:modified", "tests/test_feature.py:created"]);
    assert.equal(files[0]!.base, dbBase, "the start version, read relative to the env's directory");
    assert.equal(files[2]!.base, pyBase);
    assert.deepEqual(isolationFindings(files), [], "setupDB, update and make_client were there at the start");
    put(root, "svc/db_test.go", `${dbBase.replace("t *testing.T) *DB", "t testing.TB) *DB")}\nfunc seed(db *DB) {}\n`);
    put(root, "svc/feature_test.go", "package db\n\nimport \"testing\"\n\nfunc TestFeature(t *testing.T) {\n\tseed(setupDB(t))\n}\n");
    assert.deepEqual(isolationFindings(await agentTestFiles(env, baseline)), [{ lang: "go", file: "feature_test.go", from: "db_test.go", names: ["seed"] }]);
  } finally {
    await env.close();
  }
});

test("a workspace without git: test files created since the start listing count, files present at the start do not", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-fc-nogit-")));
  put(cwd, "tests/test_api.py", "def call(x):\n    return x\n");
  const env = new LocalEnv({ cwd });
  try {
    const baseline = await readBaseline(env);
    assert.equal(baseline?.git, false);
    put(cwd, "tests/test_ui.py", "from test_api import call\n");
    put(cwd, "tests/test_new.py", "def helper():\n    pass\n");
    put(cwd, "tests/test_more.py", "from test_new import helper\n");
    const files = await agentTestFiles(env, baseline);
    assert.deepEqual(files.map((file) => file.path).sort(), ["tests/test_more.py", "tests/test_new.py", "tests/test_ui.py"]);
    assert.deepEqual(isolationFindings(files).map((finding) => `${finding.file}<-${finding.from}`), ["tests/test_more.py<-tests/test_new.py"]);
  } finally {
    await env.close();
  }
});

// ---------- in a run ----------

async function fauxRun(loadout: Loadout, steps: FauxStep[], options: { budgets?: Budgets; cwd?: string } = {}) {
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "harness-fc-run-")));
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-fc-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: "do the task", model: "faux/fc", effort: "high", loadout, env, tracePath, fauxSteps: scripted, ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts };
  } finally {
    await env.close();
  }
}

const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const bash = (command: string): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);
const ISO_TEXT = LEVER_TEXTS.test_isolation.replace("{items}", "- merge_test.go uses diffTestDoc from diff_test.go");

test("test_isolation in a run: one reminder at the finish attempt naming the files and helpers; the second finish ends the run", async () => {
  const loadout = withLevers((raw) => (raw.policy.test_isolation = true));
  const run = await fauxRun(loadout, [write("diff_test.go", GO_DIFF), write("merge_test.go", GO_MERGE), { text: "Done." }, { text: "Moved the helpers." }, { text: "never sent" }], { cwd: repo() });
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 4, "once per run");
  assert.equal(textOf(lastUser(run.contexts[3]!)), ISO_TEXT);
  assert.deepEqual(policyEvents(run.events), ["continue:test_isolation"], "once it fired, a later finish attempt is not checked again");
  const fired = run.events.find((event) => event.action === "continue");
  assert.deepEqual({ placebo: fired?.placebo, findings: fired?.findings, langs: fired?.langs, pairs: fired?.pairs }, { placebo: false, findings: 1, langs: ["go"], pairs: ["merge_test.go <- diff_test.go"] });
  const clean = await fauxRun(loadout, [write("merge_test.go", GO_MERGE.replace("diffTestDoc(t, \"<a/>\")", "1")), { text: "Done." }, { text: "never sent" }], { cwd: repo() });
  assert.equal(clean.result.usage.requests, 2, "no finding, no reminder");
  assert.deepEqual(policyEvents(clean.events), ["check:test_isolation"]);
});

test("test_isolation placebo: the same trigger sends neutral text of the reminder's estimated token count", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.test_isolation = true;
    raw.policy.test_isolation_placebo = true;
  });
  const run = await fauxRun(loadout, [write("diff_test.go", GO_DIFF), write("merge_test.go", GO_MERGE), { text: "Done." }, { text: "Done." }], { cwd: repo() });
  const sent = textOf(lastUser(run.contexts[3]!));
  assert.equal(sent, placeboFor("test_isolation", ISO_TEXT));
  assert.equal(estimateTokens(sent), estimateTokens(ISO_TEXT));
  assert.doesNotMatch(sent, /\b(?:test|helper|grader|file|finish)\w*/iu);
  assert.equal(run.events.find((event) => event.action === "continue")?.placebo, true);
});

test("evidence_bounce in a run: a final naming no requirement-level check is bounced once; one that does is not; the placebo keeps the trigger", async () => {
  const loadout = withLevers((raw) => (raw.policy.evidence_bounce = true));
  const run = await fauxRun(loadout, [{ text: "The script runs without errors." }, { text: "Still only ran it." }, { text: "never sent" }]);
  assert.equal(run.result.usage.requests, 2);
  assert.equal(textOf(lastUser(run.contexts[1]!)), LEVER_TEXTS.evidence_bounce);
  assert.deepEqual(run.events.filter((event) => event.type === "policy").map((event) => [event.reason, event.class, event.placebo]), [["evidence_bounce", "proxy_only", false]]);
  const proven = await fauxRun(loadout, [{ text: "All tests pass." }, { text: "never sent" }]);
  assert.equal(proven.result.usage.requests, 1);
  assert.deepEqual(policyEvents(proven.events), []);
  const placebo = await fauxRun(withLevers((raw) => {
    raw.policy.evidence_bounce = true;
    raw.policy.evidence_bounce_placebo = true;
  }), [{ text: "Done." }, { text: "Done." }, { text: "never sent" }]);
  assert.equal(placebo.result.usage.requests, 2);
  assert.equal(textOf(lastUser(placebo.contexts[1]!)), placeboFor("evidence_bounce", LEVER_TEXTS.evidence_bounce));
  assert.equal(estimateTokens(placeboFor("evidence_bounce", LEVER_TEXTS.evidence_bounce)), estimateTokens(LEVER_TEXTS.evidence_bounce));
});

test("order: the evidence gate, then test_isolation, then evidence_bounce, one continuation per finish attempt", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.evidence_gate = { probe: "tools" };
    raw.policy.test_isolation = true;
    raw.policy.evidence_bounce = true;
  });
  const run = await fauxRun(loadout, [
    write("diff_test.go", GO_DIFF), write("merge_test.go", GO_MERGE), { text: "Done." }, { text: "Done." }, { text: "Done." }, { text: "Done." }, { text: "never sent" },
  ], { cwd: repo() });
  assert.deepEqual(policyEvents(run.events), ["continue:evidence_gate", "continue:test_isolation", "continue:evidence_bounce"]);
  assert.equal(run.result.usage.requests, 6);
  assert.equal(textOf(lastUser(run.contexts[3]!)), LEVER_TEXTS.evidence_gate);
  assert.equal(textOf(lastUser(run.contexts[4]!)), ISO_TEXT);
  assert.equal(textOf(lastUser(run.contexts[5]!)), LEVER_TEXTS.evidence_bounce);
});

test("near a hard budget (90%) neither check fires; the skip is recorded once per check", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.test_isolation = true;
    raw.policy.evidence_bounce = true;
  });
  const steps = [write("diff_test.go", GO_DIFF), write("merge_test.go", GO_MERGE), ...Array.from({ length: 7 }, (_, i) => bash(`echo ${i}`)), { text: "Done." }, { text: "Done." }, { text: "never sent" }];
  const near = await fauxRun(loadout, steps, { budgets: { requests: 11 }, cwd: repo() });
  assert.equal(near.result.status, "finished");
  assert.equal(near.result.usage.requests, 10, "10 of 11 requests used: no continuation");
  assert.deepEqual(policyEvents(near.events), ["skip:test_isolation", "skip:evidence_bounce"]);
  const roomy = await fauxRun(loadout, steps, { budgets: { requests: 12 }, cwd: repo() });
  assert.deepEqual(policyEvents(roomy.events), ["continue:test_isolation", "skip:evidence_bounce"], "10 of 12 is under 90%; the next finish, at 11 of 12, is not");
  assert.equal(roomy.result.usage.requests, 11);
});

test("exec-v0-iso over the wire: files the agent's cells create trigger the reminder as the last input item, and every request extends the last", async () => {
  const loadout = readLoadout(join(loadoutDir, "exec-v0-iso.json")).loadout;
  const add = (path: string, text: string) => `*** Begin Patch\n*** Add File: ${path}\n${text.split("\n").slice(0, -1).map((line) => `+${line}`).join("\n")}\n*** End Patch\n`;
  const cwd = repo();
  const run = await runScripted(loadout, [
    { exec: `await tools.apply_patch(${JSON.stringify(add("diff_test.go", GO_DIFF))}); text("ok");` },
    { exec: `await tools.apply_patch(${JSON.stringify(add("merge_test.go", GO_MERGE))}); text("ok");` },
    { text: "Done." }, { text: "Done, moved." }, { text: "never sent" },
  ], { cwd });
  assert.equal(run.result.status, "finished");
  assert.equal(run.bodies.length, 4);
  assert.deepEqual(run.bodies[3]!.input.at(-1), { role: "user", content: [{ type: "input_text", text: ISO_TEXT }] });
  for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
});

test("the finish-check arms: exec-v0-iso, -isoplac, -eb, -ebplac, -ieb turn on exactly their checks", () => {
  const policy = (suffix: string) => readLoadout(join(loadoutDir, `exec-v0-${suffix}.json`)).loadout.policy;
  assert.deepEqual(policy("iso").test_isolation, { text: LEVER_TEXTS.test_isolation });
  assert.equal(policy("isoplac").test_isolation_placebo, true);
  assert.equal(policy("eb").evidence_bounce?.text, LEVER_TEXTS.evidence_bounce);
  assert.equal(policy("ebplac").evidence_bounce_placebo, true);
  assert.ok(policy("ieb").test_isolation !== undefined && policy("ieb").evidence_bounce !== undefined && policy("ieb").test_isolation_placebo === undefined);
});
