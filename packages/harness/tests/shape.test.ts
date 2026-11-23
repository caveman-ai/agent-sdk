/**
 * R1 result shaping as a pure function (src/tools/shape.ts): which commands
 * and outputs it recognizes, what a shaped test, build and search result
 * keeps (counts, every failure's header and assertion message, the tail, the
 * log path), when it declines, and that it runs in linear time on hostile
 * input.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, shapeOutput, type ShapeConfig } from "../src/tools/shape.ts";
// @ts-expect-error -- a plain .mjs module shared with the replay audit, no declarations
import { CANARIES, deepPytest, goBuildFailure } from "../scripts/shaping-canaries.mjs";

const TESTS: ShapeConfig = { shaping: "tests", min_bytes: 2048, max_failures: 5, tail_lines: 20 };
const ALL: ShapeConfig = { ...TESTS, shaping: "all" };
const LOG = "/tmp/scratch/out-1.log";
const many = (count: number, line: (index: number) => string) => Array.from({ length: count }, (_, index) => line(index + 1)).join("\n");

const PYTEST = [
  "============================= test session starts ==============================",
  "platform linux -- Python 3.11.4, pytest-8.1.1, pluggy-1.4.0",
  "rootdir: /app",
  "collected 122 items",
  "",
  many(60, (index) => `tests/test_mod_${index}.py ${".".repeat(40)}                     [ ${index}%]`),
  "tests/test_calc.py ..F.                                                 [100%]",
  "",
  "=================================== FAILURES ===================================",
  "___________________________________ test_add ___________________________________",
  "",
  "    def test_add():",
  "        a = 1",
  "        b = 2",
  "        c = 3",
  "        d = 4",
  "        e = 5",
  "        f = 6",
  ">       assert add(1, 2) == 4",
  "E       assert 3 == 4",
  "E        +  where 3 = add(1, 2)",
  "",
  "tests/test_calc.py:12: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_calc.py::test_add - assert 3 == 4",
  "=================== 1 failed, 119 passed, 2 skipped in 1.23s ===================",
].join("\n");

test("commands are classified by their simple commands, wrappers and assignments dropped", () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ["cd /app && python -m pytest -x tests/ 2>&1 | tail -80", "test", "pytest"],
    ["timeout 600 uv run pytest -q", "test", "pytest"],
    ["CI=1 npx jest --runInBand", "test", "jest"],
    ["pnpm test -- --run", "test", "pnpm"],
    ["npm run test:unit", "test", "npm"],
    ["go build ./... && go test ./pkg/...", "test", "go"],
    ["cargo test --workspace", "test", "cargo"],
    ["make -j4 check", "test", "make"],
    ["./run_tests.sh", "test", "run_tests.sh"],
    ["bash tests/run_tests.sh -v", "test", "run_tests.sh"],
    ["dotnet test", "test", "dotnet"],
    ["ctest --output-on-failure", "test", "ctest"],
    ["bundle exec rspec spec/models", "test", "rspec"],
    ["vendor/bin/phpunit", "test", "phpunit"],
    ["npx tsc --noEmit", "build", "tsc"],
    ["cargo build --release", "build", "cargo"],
    ["cargo check", "build", "cargo"],
    ["go vet ./...", "build", "go"],
    ["gcc -o a a.c", "build", "gcc"],
    ["mvn -q compile", "build", "mvn"],
    ["./gradlew assemble", "build", "gradlew"],
    ["rg -n 'def foo' src", "search", "rg"],
    ["grep -rn TODO .", "search", "grep"],
    ["git grep -n Foo", "search", "git grep"],
    ["find . -name '*.py'", "search", "find"],
    ["cat README.md", undefined, undefined],
    ["python script.py", undefined, undefined],
    ["git status", undefined, undefined],
    ["constructor run toString", undefined, undefined],
    ["__proto__ exec hasOwnProperty", undefined, undefined],
  ];
  for (const [command, kind, tool] of cases) {
    const got = classifyCommand(command);
    assert.deepEqual(got === undefined ? [undefined, undefined] : [got.kind, got.tool], [kind, tool], command);
  }
  const mixed: [string, boolean][] = [
    ["cd /app && export CI=1 && pytest -x 2>&1 | tail -80", false],
    ["for f in tests/*.py; do pytest $f; done", false],
    ["rg -n foo src | head -50 | sort", false],
    ["go vet ./... && go test ./...", false],
    ["PWNLIB_NOTERM=1 python -m unittest discover -v; ls docs/source; rg -n doctest docs", true],
    ["git branch -a; ls parser; rg -n Func ast | head -110", true],
    ["git status && pytest", true],
  ];
  for (const [command, want] of mixed) assert.equal(classifyCommand(command)?.mixed, want, command);
});

test("a failing pytest run keeps counts, the failure's header and every assertion line, the short summary, the tail and the log path", () => {
  const plan = shapeOutput("pytest -q", PYTEST, 1, TESTS);
  assert.ok(plan !== undefined);
  assert.equal(plan.kind, "test");
  const text = plan.render(LOG);
  assert.match(text.split("\n")[0]!, /^\[harness: test output shaped \(pytest\): 1 failed, 119 passed, 2 skipped; 1 failure with trace heads\. Raw: \d+ lines, [\d.]+ (KB|bytes); full log: \/tmp\/scratch\/out-1\.log\]$/u);
  for (const kept of ["test_add", ">       assert add(1, 2) == 4", "E       assert 3 == 4", "E        +  where 3 = add(1, 2)",
    "tests/test_calc.py:12: AssertionError", "FAILED tests/test_calc.py::test_add - assert 3 == 4", "1 failed, 119 passed, 2 skipped in 1.23s"]) {
    assert.ok(text.includes(kept), `keeps ${kept}`);
  }
  assert.ok(!text.includes("tests/test_mod_7.py"), "the progress dots are dropped");
  assert.match(text, /\[\.\.\. \d+ lines \.\.\.\]/u);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(PYTEST) / 2, `${Buffer.byteLength(text)} vs ${Buffer.byteLength(PYTEST)}`);
});

test("past max_failures each failure keeps its header and first message line; none is dropped", () => {
  const blocks = many(9, (index) => [
    `___ test_case_${index} ___`, "", "    def test():", ...Array.from({ length: 30 }, (_, line) => `        step_${line} = compute(${line})`),
    `E       AssertionError: case ${index} expected ${index} got 0`, "", `tests/test_x.py:${index * 10}: AssertionError`,
  ].join("\n")).split("\n");
  const output = ["=== FAILURES ===", ...blocks, "=== short test summary info ===", "=== 9 failed, 3 passed in 0.50s ==="].join("\n");
  const text = shapeOutput("pytest", output, 1, { ...TESTS, max_failures: 2 })!.render(LOG);
  for (let index = 1; index <= 9; index++) {
    assert.ok(text.includes(`test_case_${index}`), `header ${index}`);
    assert.ok(text.includes(`AssertionError: case ${index} expected ${index} got 0`), `message ${index}`);
  }
  assert.match(text, /9 failed, 3 passed; 9 failures, the first 2 with their trace heads, the rest by name and first message/u);
  assert.ok(text.includes("step_3 = compute(3)"), "a shown failure keeps its trace head");
  assert.equal(text.split("step_20 = compute(20)").length - 1, 1, "past the head only message lines stay (this one is the tail's)");
});

test("other runners: go -v (log before --- FAIL), cargo, jest, mocha, unittest, dotnet, ctest", () => {
  const noise = (count: number, prefix: string) => many(count, (index) => `${prefix}${index}`);
  const cases: { command: string; output: string; counts: RegExp; keeps: string[] }[] = [
    {
      command: "go test -v ./...",
      output: [noise(80, "=== RUN   TestOk"), noise(80, "--- PASS: TestOk"), "=== RUN   TestParse", "    parse_test.go:42: want 3 tokens, got 2", "--- FAIL: TestParse (0.00s)",
        "FAIL", "FAIL\texample.com/parse\t0.012s", "ok  \texample.com/lex\t0.010s"].join("\n"),
      counts: /1 failed, 80 passed; go packages: 1 ok, 1 FAIL/u, keeps: ["--- FAIL: TestParse", "parse_test.go:42: want 3 tokens, got 2"],
    },
    {
      command: "cargo test",
      output: ["running 301 tests", noise(300, "test tests::ok_"), "test tests::bad ... FAILED", "", "failures:", "", "---- tests::bad stdout ----",
        "thread 'tests::bad' panicked at src/lib.rs:20:9:", "assertion `left == right` failed", "  left: 1", " right: 2", "", "failures:", "    tests::bad", "",
        "test result: FAILED. 80 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"].join("\n"),
      counts: /1 failed, 80 passed/u, keeps: ["---- tests::bad stdout ----", "src/lib.rs:20:9", "assertion `left == right` failed", "test tests::bad ... FAILED"],
    },
    {
      command: "npx jest",
      output: [noise(300, "PASS src/ok"), "FAIL src/sum.test.js", "  ● sum › adds", "", "    expect(received).toBe(expected) // Object.is equality", "", "    Expected: 4",
        "    Received: 3", "", "      at Object.<anonymous> (src/sum.test.js:5:20)", "", "Test Suites: 1 failed, 100 passed, 101 total", "Tests:       1 failed, 300 passed, 301 total"].join("\n"),
      counts: /1 failed, 300 passed/u, keeps: ["● sum › adds", "Expected: 4", "Received: 3", "src/sum.test.js:5:20"],
    },
    {
      command: "npx mocha",
      output: [noise(120, "    ✓ works "), "", "  120 passing (40ms)", "  1 failing", "", "  1) parser", "       handles quotes:", "", "      AssertionError [ERR_ASSERTION]: 'a' == 'b'",
        "      at Context.<anonymous> (test/parser.test.js:9:12)"].join("\n"),
      counts: /1 failed, 120 passed/u, keeps: ["1) parser", "AssertionError [ERR_ASSERTION]: 'a' == 'b'", "test/parser.test.js:9:12"],
    },
    {
      command: "python -m unittest discover",
      output: [noise(150, "test_ok_"), "======================================================================", "FAIL: test_div (tests.test_math.MathTest)",
        "----------------------------------------------------------------------", "Traceback (most recent call last):", '  File "/app/tests/test_math.py", line 8, in test_div',
        "    self.assertEqual(div(4, 2), 3)", "AssertionError: 2.0 != 3", "", "----------------------------------------------------------------------",
        "Ran 151 tests in 0.020s", "", "FAILED (failures=1)"].join("\n"),
      counts: /1 failed/u, keeps: ["FAIL: test_div", "AssertionError: 2.0 != 3", "test_math.py\", line 8"],
    },
    {
      command: "dotnet test",
      output: [noise(120, "  Passed Ns.Ok"), "  Failed Ns.CalcTests.Adds [12 ms]", "  Error Message:", "   Assert.Equal() Failure: Expected 4, Actual 3", "  Stack Trace:",
        "     at Ns.CalcTests.Adds() in /app/CalcTests.cs:line 10", "", "Failed!  - Failed:     1, Passed:   120, Skipped:     0, Total:   121"].join("\n"),
      counts: /1 failed, 120 passed/u, keeps: ["Failed Ns.CalcTests.Adds", "Assert.Equal() Failure: Expected 4, Actual 3"],
    },
    {
      command: "ctest --output-on-failure",
      output: [noise(120, "      Start  1: ok_"), "  7/121 Test   #7: parser_test ......................***Failed    0.01 sec", "parser.cpp:33: expected 2 got 1",
        "", "99% tests passed, 1 tests failed out of 121", "", "The following tests FAILED:", "\t  7 - parser_test (Failed)"].join("\n"),
      counts: /1 failed, 120 passed/u, keeps: ["Test   #7: parser_test", "parser.cpp:33: expected 2 got 1", "99% tests passed"],
    },
  ];
  for (const { command, output, counts, keeps } of cases) {
    const plan = shapeOutput(command, output, 1, TESTS);
    assert.ok(plan !== undefined, `${command} is shaped`);
    const text = plan.render(LOG);
    assert.match(text.split("\n")[0]!, counts, `${command}: ${text.split("\n")[0]}`);
    for (const kept of keeps) assert.ok(text.includes(kept), `${command} keeps ${kept}\n${text}`);
  }
});

const goPackages = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `ok  \texample.com/m/pkg${from + index}\t0.0${(from + index) % 10}s`);

test("go: a package that failed to build keeps its # pkg block and its [build failed] line among 140 ok packages and another failure", () => {
  const output = goBuildFailure();
  const plan = shapeOutput("go test ./...", output, 1, TESTS);
  assert.ok(plan !== undefined);
  const text = plan.render(LOG);
  assert.match(text.split("\n")[0]!, /go packages: 140 ok, 2 FAIL; 2 failures with trace heads/u);
  for (const kept of ["# example.com/m/store [example.com/m/store.test]", "store/store_test.go:41:9: undefined: NewCache",
    "store/store_test.go:57:2: too many arguments in call to Open", "FAIL\texample.com/m/store [build failed]", "--- FAIL: TestParse", "parse_test.go:12: got 1, want 2",
    "FAIL\texample.com/m/parse\t0.01s"]) {
    assert.ok(text.includes(kept), `keeps ${kept}\n${text}`);
  }
  assert.ok(!text.includes("example.com/m/pkg30\t"), "ok packages far from the tail are dropped");
});

test("go: a [build failed] package whose build errors are not in the output is not shaped; a failed package with no header keeps its last lines", () => {
  const unbuilt = [...goPackages(0, 100), "FAIL\texample.com/m/store [build failed]", "--- FAIL: TestParse (0.00s)", "    parse_test.go:12: got 1, want 2",
    "FAIL", "FAIL\texample.com/m/parse\t0.01s", ...goPackages(100, 140), "FAIL"].join("\n");
  assert.equal(shapeOutput("go test ./...", unbuilt, 1, TESTS), undefined);
  const exited = [...goPackages(0, 60), "db_test.go:18: setup: cannot reach postgres at db:5432", "FAIL\texample.com/m/db\t0.003s",
    ...goPackages(60, 120), "--- FAIL: TestParse (0.00s)", "    parse_test.go:12: got 1, want 2", "FAIL", "FAIL\texample.com/m/parse\t0.01s",
    ...goPackages(120, 140), "FAIL"].join("\n");
  const text = shapeOutput("go test ./...", exited, 1, TESTS)!.render(LOG);
  for (const kept of ["setup: cannot reach postgres at db:5432", "FAIL\texample.com/m/db\t0.003s", "parse_test.go:12: got 1, want 2"]) assert.ok(text.includes(kept), `keeps ${kept}\n${text}`);
});

test("pytest: a 20-frame traceback keeps the raising frame, its E line and its location; frames do not spend the message budget", () => {
  const output = deepPytest(1, 20);
  const plan = shapeOutput("pytest", output, 1, { ...TESTS, tail_lines: 2 });
  assert.ok(plan !== undefined, "still shaped");
  const text = plan.render(LOG);
  for (const kept of ["test_place_order_0", ">       place_order(cart())", "E       KeyError: 'sku0'", ">       return x['sku']", "app/layer20.py:30: KeyError", "app/layer0.py:10: in step0"]) {
    assert.ok(text.includes(kept), `keeps ${kept}\n${text}`);
  }
  assert.ok(!text.includes("app/layer10.py:20: in step10"), "the middle frames are dropped");
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(output) * (2 / 3));
});

test("pytest: past max_failures a deep traceback keeps its E line as the one message, not its first frame", () => {
  const text = shapeOutput("pytest", deepPytest(4, 20), 1, { ...TESTS, max_failures: 1, tail_lines: 2 })!.render(LOG);
  for (let failure = 0; failure < 4; failure++) assert.ok(text.includes(`E       KeyError: 'sku${failure}'`), `failure ${failure}'s message\n${text}`);
});

test("every shaping canary (the replay audit runs them too) keeps its failure text in both modes", () => {
  for (const canary of CANARIES) {
    for (const config of [TESTS, ALL]) {
      const plan = shapeOutput(canary.command, canary.output, canary.exitCode, config);
      const text = plan?.render(LOG) ?? canary.output;
      for (const kept of canary.keeps) assert.ok(text.includes(kept), `${canary.name} (${config.shaping}) keeps ${kept}`);
    }
  }
});

test("a test run is known by its output whatever the command, unless the command shows a file or mixes outputs", () => {
  assert.equal(shapeOutput("./ci/check.sh", PYTEST, 1, TESTS)?.kind, "test");
  assert.equal(shapeOutput("cd /app && ./ci/check.sh 2>&1 | tail -200", PYTEST, 1, TESTS)?.kind, "test");
  assert.equal(shapeOutput("cat pytest.log", PYTEST, 0, TESTS), undefined);
  assert.equal(shapeOutput("git diff", PYTEST, 0, TESTS), undefined);
  assert.equal(shapeOutput("ls tests; ./ci/check.sh", PYTEST, 1, TESTS), undefined, "the listing would be dropped");
  assert.equal(shapeOutput("pytest -q; ls docs", PYTEST, 1, TESTS), undefined);
});

test("builds keep the first errors with their context, count errors and warnings, and hide warnings when errors exist", () => {
  const warnings = many(60, (index) => `src/w${index}.c:${index}:1: warning: unused variable 'x${index}' [-Wunused-variable]\n    int x${index};\n        ^`);
  const gcc = [warnings, "src/main.c:10:5: error: 'count' undeclared (first use in this function)", "   10 |     count++;", "      |     ^~~~~",
    "src/main.c:11:5: error: expected ';' before 'return'", "make: *** [Makefile:4: main] Error 1"].join("\n");
  const text = shapeOutput("make", gcc, 2, TESTS)!.render(LOG);
  assert.match(text.split("\n")[0]!, /build output shaped \(make\): 2 errors, 60 warnings; warnings not shown/u);
  for (const kept of ["'count' undeclared", "count++;", "expected ';' before 'return'", "make: *** [Makefile:4: main] Error 1"]) assert.ok(text.includes(kept), kept);
  assert.ok(!text.includes("src/w5.c"), "warnings are counted, not shown");

  const tsc = [many(40, (index) => [`src/f${index}.ts:${index}:3 - error TS2322: Type 'string' is not assignable to type 'number'.`, "",
    `${index}   const value: number = load("${index}");`, "          ~~~~~", "", `  src/types${index}.ts:${index}:5`, "    declared here.", ""].join("\n")), "Found 40 errors in 40 files."].join("\n");
  const shaped = shapeOutput("npx tsc --noEmit", tsc, 2, TESTS)!.render(LOG);
  assert.match(shaped, /40 errors, 0 warnings; the first 5 with context, the rest one line each/u);
  for (let index = 1; index <= 40; index++) assert.ok(shaped.includes(`src/f${index}.ts:${index}:3 - error TS2322`), `every error keeps its line (${index})`);
  assert.ok(shaped.includes('const value: number = load("2");'), "the first errors keep their code frame");

  const cargo = [many(80, (index) => `   Compiling dep${index} v0.1.0`), "error[E0425]: cannot find value `y` in this scope", " --> src/main.rs:3:13", "  |", "3 |     let x = y;",
    "  |             ^ not found in this scope", "", "error: could not compile `app` (bin \"app\") due to 1 previous error"].join("\n");
  const rust = shapeOutput("cargo build", cargo, 101, TESTS)!.render(LOG);
  for (const kept of ["error[E0425]: cannot find value `y`", "src/main.rs:3:13", "let x = y;", "could not compile"]) assert.ok(rust.includes(kept), kept);
  assert.ok(!rust.includes("Compiling dep7 "));
});

test("searches are shaped only in mode all: grouped by file with totals, or paths with directory counts", () => {
  const rg = many(600, (index) => `src/mod${index % 40}/file${index % 40}.py:${index}:    value_${index} = lookup(key)`);
  assert.equal(shapeOutput("rg -n lookup src", rg, 0, TESTS), undefined);
  const text = shapeOutput("rg -n lookup src", rg, 0, ALL)!.render(LOG);
  assert.match(text.split("\n")[0]!, /search output shaped \(rg\): 600 matches in 40 files; the first 3 per file/u);
  assert.ok(text.includes("src/mod1/file1.py (15 matches)"));
  assert.ok(text.includes("  1:     value_1 = lookup(key)".replace("  1:     ", "  1: ")));
  assert.match(text, /other files: src\/mod\d+\/file\d+\.py \(15\)/u);
  const find = many(500, (index) => `./pkg/sub${index % 7}/f${index}.go`);
  const paths = shapeOutput("find . -name '*.go'", find, 0, ALL)!.render(LOG);
  assert.match(paths, /500 paths; the first 40/u);
  assert.match(paths, /by directory: pkg\/sub\d\/ \(7\d\)/u);
  const prose = many(200, (index) => `This is a sentence number ${index} with words but no path.`);
  assert.equal(shapeOutput("grep -r foo .", prose, 0, ALL), undefined, "output that is not grep-shaped stays raw");
});

test("it declines: under min_bytes, unrecognized, a failed run with no failure it can name, or too little saved", () => {
  assert.equal(shapeOutput("pytest", PYTEST, 1, { ...TESTS, min_bytes: 1_000_000 }), undefined);
  assert.equal(shapeOutput("python build_docs.py", many(400, (index) => `writing page ${index}`), 0, TESTS), undefined);
  const crashed = many(200, (index) => `collecting module ${index}`) + "\nSegmentation fault (core dumped)";
  assert.equal(shapeOutput("pytest", crashed, 139, TESTS), undefined, "nothing to name: the raw output (head and tail) is safer");
  const allFailures = [many(200, (index) => `--- FAIL: TestCase${index} (0.00s)\n    case_test.go:${index}: boom ${index}`), "FAIL"].join("\n");
  assert.equal(shapeOutput("go test ./...", allFailures, 1, TESTS), undefined, "every line is a failure's header or message: nothing to save");
});

test("shaping is linear: 4 MB of hostile lines take well under two seconds", () => {
  const hostile = [
    many(4000, () => `___ ${"_ ".repeat(200)}x`),
    many(4000, () => `${"a.".repeat(400)}`),
    many(4000, () => `=${" 1 passed,".repeat(60)} in x`),
    many(4000, () => `${"a:1".repeat(150)}`),
    many(4000, () => `src/${"x".repeat(300)}-1-${"9".repeat(100)}`),
    "=== 1 failed, 1 passed in 0.1s ===",
  ].join("\n");
  for (const command of ["pytest", "make", "rg x"]) {
    const started = performance.now();
    shapeOutput(command, hostile, 1, ALL);
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `${command}: ${Math.round(ms)} ms for ${Math.round(hostile.length / 1e6)} MB`);
  }
});
