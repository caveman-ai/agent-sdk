/**
 * Synthetic outputs where R1 shaping once hid a failure it had found (review
 * 2026-10-31): a go package that failed to build among many ok packages, and
 * a pytest failure under a deep traceback. Each canary names the text the
 * shaped view must keep. tests/shape.test.ts asserts them; the replay audit
 * (scripts/shaping-audit.mjs) runs them first and fails when one regresses.
 */

const goPackages = (from, to) => Array.from({ length: to - from }, (_, index) => `ok  \texample.com/m/pkg${from + index}\t0.0${(from + index) % 10}s`);

/** `go test ./...` over 140 ok packages, one package that fails to compile, one failing test. */
export function goBuildFailure() {
  return [
    ...goPackages(0, 60),
    "# example.com/m/store [example.com/m/store.test]", "store/store_test.go:41:9: undefined: NewCache", "store/store_test.go:57:2: too many arguments in call to Open",
    "FAIL\texample.com/m/store [build failed]",
    ...goPackages(60, 120),
    "--- FAIL: TestParse (0.00s)", "    parse_test.go:12: got 1, want 2", "FAIL", "FAIL\texample.com/m/parse\t0.01s",
    ...goPackages(120, 140), "FAIL",
  ].join("\n");
}

/** A pytest run with `failures` failures, each under a traceback `depth` frames deep (Django, SQLAlchemy, pandas) before the raising frame. */
export function deepPytest(failures, depth) {
  return [
    "============================= test session starts ==============================", "collected 140 items", "",
    ...Array.from({ length: 40 }, (_, index) => `tests/test_m${index}.py ...................................                      [ ${index}%]`),
    "", "=================================== FAILURES ===================================",
    ...Array.from({ length: failures }, (_, failure) => [
      `_______________________________ test_place_order_${failure} _______________________________`, "",
      "    def test_place_order():", ">       place_order(cart())", "", "tests/test_orders.py:14: ",
      "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ ",
      ...Array.from({ length: depth }, (_, frame) => [`app/layer${frame}.py:${10 + frame}: in step${frame}`, `    return step${frame + 1}(x)`]).flat(),
      "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ ", "",
      `    def step${depth}(x):`, ">       return x['sku']", `E       KeyError: 'sku${failure}'`, "", `app/layer${depth}.py:${10 + depth}: KeyError`,
    ]).flat(),
    "=========================== short test summary info ============================",
    ...Array.from({ length: failures }, (_, failure) => `FAILED tests/test_orders.py::test_place_order_${failure} - KeyError: 'sku${failure}'`),
    `======================== ${failures} failed, ${140 - failures} passed in 2.31s =========================`,
  ].join("\n");
}

/** Each canary: the command and output, and what the shaped view keeps (a canary that the shaper declines passes: raw keeps all). */
export const CANARIES = [
  {
    name: "go build failure among 140 ok packages",
    command: "go test ./...", exitCode: 1, output: goBuildFailure(),
    keeps: ["# example.com/m/store [example.com/m/store.test]", "store/store_test.go:41:9: undefined: NewCache", "store/store_test.go:57:2: too many arguments in call to Open",
      "FAIL\texample.com/m/store [build failed]", "--- FAIL: TestParse", "parse_test.go:12: got 1, want 2"],
  },
  {
    name: "pytest failure under a 20-frame traceback",
    command: "pytest", exitCode: 1, output: deepPytest(1, 20),
    keeps: ["test_place_order_0", "E       KeyError: 'sku0'", ">       return x['sku']", "app/layer20.py:30: KeyError"],
  },
  {
    name: "eight pytest failures under deep tracebacks, three past max_failures 5",
    command: "pytest", exitCode: 1, output: deepPytest(8, 20),
    keeps: Array.from({ length: 8 }, (_, failure) => `E       KeyError: 'sku${failure}'`),
  },
];
