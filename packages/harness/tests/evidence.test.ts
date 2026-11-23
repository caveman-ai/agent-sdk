import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutcome, classifyCommand, hedgedItems, splitSegments } from "../src/evidence.ts";
import { DEFAULT_HEDGE_PATTERNS } from "../src/prompts.ts";

const kinds = (command: string) => classifyCommand(command).kinds;

test("test runners, builds, compilers and runs of the result are checks", () => {
  for (const command of [
    "pytest -q", "python -m pytest tests/test_a.py -x", "python3 -m unittest discover", "go test ./...", "cargo test --release", "cargo build",
    "npm test", "npm run build", "pnpm run test:unit", "yarn test", "yarn build", "bun test", "make", "make -j8 all", "cmake --build build",
    "gcc -O2 -o main main.c", "g++ main.cpp && ./a.out < input.txt", "tsc --noEmit", "javac Main.java", "java -jar app.jar", "coqc Proof.v",
    "python solve.py", "python3 /app/run.py --n 3", "node index.js", "./run_tests.sh", "/app/bin/tool --check", "bash run.sh", "sh check.sh",
    "ruby test.rb", "Rscript analysis.R", "diff expected.txt out.txt", "curl -s http://localhost:8000/health", "uv run pytest", "npx jest",
    "poetry run pytest -k foo", "bundle exec rspec", "timeout 120 pytest", "FOO=1 BAR=2 python main.py", "env PYTHONPATH=. pytest",
    "cd /app && pytest -q", "dotnet test", "swift build", "mix test", "deno test", "python -c 'import mod; assert mod.f(2) == 4'",
    "node -e 'require(\"./x\").run()'", "bash -lc 'cd /app && make test'", "sqlite3 db.sqlite 'select count(*) from t'",
  ]) {
    const facts = classifyCommand(command);
    assert.ok(facts.check, `${command}: ${JSON.stringify(facts.kinds)}`);
    assert.equal(facts.mutatesAfterCheck, false, command);
  }
});

test("reads, searches, installs and setup are neither checks nor changes", () => {
  for (const command of [
    "cat a.py", "ls -la", "grep -rn foo src", "rg -n bar", "find . -name '*.py'", "head -50 x.py | tail -5", "sed -n '1,40p' a.py", "wc -l *.py",
    "git status", "git diff", "git log --oneline -5", "pip install -r requirements.txt", "npm install", "npm ci", "apt-get install -y jq",
    "echo hello", "pwd", "which python", "python --version", "pytest --collect-only -q", "make -n", "mkdir -p out", "touch a.txt", "rm -f tmp.txt",
    "chmod +x run.sh", "curl -sL https://example.com", "awk '{print $1}' data.csv", "perl -ne 'print if /x/' f", "cat > /dev/null", "echo x 2>&1",
    "ls 2>/dev/null", "sleep 2", "python", "export PATH=/x:$PATH",
  ]) {
    const facts = classifyCommand(command);
    assert.ok(!facts.check && !facts.mutate, `${command}: ${JSON.stringify(facts.kinds)}`);
  }
});

test("in-place edits, redirects, copies, patches and inline writers are changes", () => {
  for (const command of [
    "sed -i 's/a/b/' x.py", "sed -i.bak -e 's/a/b/' x.py", "perl -pi -e 's/a/b/' x", "echo 'x = 1' > config.py", "printf 'a\\n' >> list.txt",
    "cat > solution.py <<'EOF'\nprint(1)\nEOF", "tee out.txt < in.txt", "cp fixed.py src/app.py", "mv a.py b.py", "git apply fix.patch",
    "git checkout -- src/a.py", "patch -p1 < fix.diff", "black .", "ruff format .", "cargo fmt", "gofmt -w main.go", "npm run format",
    "python - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF", "python3 -c \"from pathlib import Path; Path('a').write_text('b')\"",
    "node -e \"require('fs').writeFileSync('a', 'b')\"", "curl -o data.bin https://example.com/x", "tar xzf src.tgz", "find . -name '*.orig' -delete",
    "bash -c 'echo x > y.txt'",
  ]) {
    const facts = classifyCommand(command);
    assert.ok(facts.mutate && !facts.check, `${command}: ${JSON.stringify(facts.kinds)}`);
  }
});

test("segment order: a change after the last check is not covered by it", () => {
  assert.deepEqual(kinds("sed -i 's/a/b/' x.py && pytest -q"), ["mutate", "check"]);
  assert.equal(classifyCommand("sed -i 's/a/b/' x.py && pytest -q").mutatesAfterCheck, false);
  assert.deepEqual(kinds("pytest -q; sed -i 's/a/b/' x.py"), ["check", "mutate"]);
  assert.equal(classifyCommand("pytest -q; sed -i 's/a/b/' x.py").mutatesAfterCheck, true);
  assert.deepEqual(kinds("pytest -q 2>&1 | tail -20"), ["check", "inspect"]);
  assert.deepEqual(kinds("pytest > log.txt 2>&1; cat log.txt"), ["check", "inspect"], "a check that logs to a file is still a check");
  assert.deepEqual(kinds("(cd sub && make) || echo failed"), ["inspect", "check", "inspect"]);
  assert.deepEqual(kinds("cat > t.py <<EOF\nimport x; x > 3 && y\nEOF\npython t.py"), ["mutate", "check"], "a here-doc body is not split into commands");
  assert.deepEqual(kinds("echo 'a && b; c' # pytest here is a comment"), ["inspect"]);
  assert.deepEqual(kinds("python - <<'EOF' | tail -3\nprint(sum(range(4)))\nEOF"), ["check", "inspect"]);
  assert.deepEqual(kinds("if pytest -q; then echo ok; else echo bad; fi"), ["check", "inspect", "inspect", "inspect"]);
  assert.deepEqual(kinds("for f in tests/*.py; do python $f; done"), ["inspect", "check", "inspect"]);
  assert.deepEqual(kinds("ls tests/*.py | xargs -n 1 python"), ["inspect", "check"]);
  assert.deepEqual(kinds("grep -l foo -r src | xargs sed -i 's/foo/bar/'"), ["inspect", "mutate"]);
  assert.deepEqual(splitSegments("a $(b; c) d && e").map((segment) => segment.text.trim()), ["a $(b; c) d", "e"]);
});

test("check outcome: a non-zero exit or a failure summary is red, else green; no exit, no outcome", () => {
  assert.equal(checkOutcome(0, "5 passed in 0.1s"), "green");
  assert.equal(checkOutcome(1, "anything"), "red");
  assert.equal(checkOutcome(0, "=== 2 failed, 3 passed in 0.2s ==="), "red", "pytest | tail exits 0");
  assert.equal(checkOutcome(0, "FAILED tests/test_a.py::test_x - assert 1 == 2"), "red");
  assert.equal(checkOutcome(0, "--- FAIL: TestX (0.00s)\nFAIL"), "red");
  assert.equal(checkOutcome(0, "test result: FAILED. 1 passed; 1 failed"), "red");
  assert.equal(checkOutcome(0, "main.c:3:5: error: expected ';'"), "red");
  assert.equal(checkOutcome(0, "Traceback (most recent call last):\n  File x"), "red");
  assert.equal(checkOutcome(0, "0 failed, 12 passed"), "green");
  assert.equal(checkOutcome(0, "test_raises_ValueError PASSED"), "green");
  assert.equal(checkOutcome(null, ""), undefined);
  assert.equal(checkOutcome(undefined, ""), undefined);
});

test("hedged items: the sentences of a final message that hedge, cut and capped", () => {
  const patterns = DEFAULT_HEDGE_PATTERNS.map((pattern) => new RegExp(pattern, "u"));
  const text = "Implemented the parser. I could not run the full suite because it needs a GPU.\n" +
    "- The CLI flag is partially wired.\n- TODO: handle empty input.\nAll unit tests pass. A todo app example was added.";
  assert.deepEqual(hedgedItems(text, patterns), [
    "I could not run the full suite because it needs a GPU.", "The CLI flag is partially wired.", "TODO: handle empty input.",
  ]);
  assert.deepEqual(hedgedItems("Done. All 12 tests pass and the output matches expected.txt.", patterns), []);
  assert.deepEqual(hedgedItems("The fix is not verified on Windows.", patterns), ["The fix is not verified on Windows."]);
  const long = `I could not ${"x".repeat(400)}.`;
  assert.equal(hedgedItems(long, patterns)[0]!.length, 240);
  assert.equal(hedgedItems(Array.from({ length: 10 }, (_, i) => `Item ${i} is untested.`).join(" "), patterns).length, 6);
});
