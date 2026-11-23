import { CODEX_BASE, CODEX_PERMISSIONS } from "./codex-base.ts";

/**
 * Built-in prompt sections, referenced by id from a loadout. A loadout hash
 * covers the resolved text, so editing a section here changes the version of
 * every loadout that uses it. Keep sections short and neutral: quality comes
 * from policy, not prose. `codex.base` and `codex.permissions` are the
 * exception on purpose: Codex 0.163's own base instructions and permissions
 * text (src/codex-base.ts), the model's native prompt.
 * A loadout may name `placebo:<id>` for neutral text of a section's estimated
 * token length (placeboFor).
 */
export const PROMPT_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  "codex.base": CODEX_BASE,
  "codex.permissions": CODEX_PERMISSIONS,
  "core.identity":
    "You are a coding agent working in a software environment through tools. " +
    "Complete the task fully and autonomously: nobody will answer questions, so make reasonable assumptions and keep going.",
  // The app's identity (src/app-loadouts.ts): a person is there, so the model may ask; it still finishes what it can first.
  "app.identity":
    "You are a coding agent working in the user's workspace through tools. " +
    "Do what the user asks completely before you reply. When a detail is unclear, make a reasonable assumption, say which, and keep going; " +
    "ask first only when a wrong guess would be costly or hard to undo.",
  "compact.tools":
    "Tools:\n" +
    "- read: read a file (text or image). Use offset/limit for large files.\n" +
    "- bash: run a shell command. Use it for ls, grep, find, builds and tests. " +
    "A command still running after its timeout keeps running in the background; you get its output so far and a handle.\n" +
    "- wait: get more output from a background command by its handle, or kill it.\n" +
    "- edit: replace exact, unique text in a file; several edits per call, each matched against the original file.\n" +
    "- write: create or overwrite a whole file.\n" +
    "Read a file before you edit it. Prefer edit for changes and write for new files.",
  "exec.tools":
    "Tools: exec runs JavaScript whose only capability is the nested tools on `tools` " +
    "(exec_command for shell commands, apply_patch to edit files, view_image); return what you need to see with text(). " +
    "Use wait to resume a cell that is still running.",
  "core.verify":
    "Find out how the work will be checked (tests, a script, the task's stated requirements) and run that check before you finish. " +
    "Fix what fails.",
  "core.finish":
    "When the task is complete, reply with a brief summary and no tool calls.",
});

/**
 * Default wording of the policy levers' messages. A loadout may replace each
 * (its text then enters both hashes); the normalized loadout carries the text
 * in force, so behavior_hash changes when a default here changes.
 * Placeholders: first_green none; evidence_gate none; finish_audit none;
 * hedge_continue `{items}` (the hedged sentences, one "- " line each);
 * wall_notice `{elapsed}`, `{remaining}`, `{budget}`; discovery `{listing}`;
 * time_budget `{minutes}` (the wall budget, rounded, at least 1);
 * test_isolation `{items}` (optional: one "- <file> uses <names> from <file>"
 * line per finding); evidence_bounce none;
 * requirements `{list}` (the numbered items, then the requirements_more line
 * with `{count}` when capped); requirements_audit none (P4's wording while a
 * requirement list is shown); clean_env none (a system prompt section);
 * travel_check `{items}` (one "- " line per finding kind, travel.ts
 * formatTravel); unmet_target `{sentence}` (the final's own sentence) and
 * `{remaining}` (wall time left); travel_jit_packages `{packages}` (the
 * session-installed packages a file imports) and `{file}` (optional: that
 * file), travel_jit_scratch `{files}` (the files, relative to the cwd),
 * travel_jit_data `{file}` (the code file) and `{reads}` (the pre-existing
 * files it names); interface_gate `{added}` (the new functions, `Class.name()`)
 * and `{file}` (optional: the file, relative to the cwd); thin_margin `{measured}` (the measurement as printed) and
 * `{threshold}` (the task's threshold as written); validator `{items}` (one "- <requirement>: <reasons>" line
 * per failing requirement, src/validator.ts clusterFindings); critic
 * `{findings}` (the reviewer's numbered findings, src/critic.ts formatFindings);
 * clause_check `{clauses}` (one "- <clause>" line per clause the side call
 * named, src/clause-check.ts formatClauses).
 */
export const LEVER_TEXTS = Object.freeze({
  evidence_gate:
    "Before you finish: nothing has run since your last change to the files (no test, build or run of the result). " +
    "Run the check that proves the task's stated requirement is met, the requirement itself rather than a proxy such as " +
    "\"it compiles\" or \"the script runs\". Fix what fails, then finish.",
  first_green:
    "This is the first passing check after a failing one. A passing check is not proof the task is done: " +
    "before you finish, confirm every stated requirement of the task, not only what this check covers.",
  hedge_continue:
    "Your summary says:\n{items}\n" +
    "If any of this can still be done or checked here, do it now, then report again. " +
    "If something truly cannot be done in this environment, say what blocks it in one line.",
  wall_notice: "{elapsed} of the {budget} wall-clock budget is used; about {remaining} is left. Leave time to check your result before it runs out.",
  discovery:
    "<orientation>\nFiles in the workdir that may show how this task is checked (tests, validators, examples, expected outputs, docs, task scripts), " +
    "listed by the harness before your first turn:\n{listing}\n</orientation>",
  finish_audit:
    "Before you finish: list each requirement stated in the task, and for each the exact command and output that proves it " +
    "in the current workspace (the files as they are now, not an earlier state). If any requirement is unproven, or only proven " +
    "by a proxy (it compiles, the script runs, an easier case passes), prove it or fix it now. Then finish.",
  time_budget:
    "You have about {minutes} minutes of wall time for this task. Long builds, test suites and training runs are fine; " +
    "do not stop before every requirement is verified.",
  test_isolation:
    "Before you finish: graders often replace or add their own copies of test files, so each test file you added must compile " +
    "and run on its own. These test files you added use helpers defined only in another test file you wrote:\n{items}\n" +
    "Move the shared helpers into the new file or into a non-test helper file, run the tests again, then finish.",
  evidence_bounce:
    "Before you finish: your summary names no check that exercises the task's stated requirement (only format, syntax, compile " +
    "or lint-level checks, or none). Run the check that proves the stated requirement in the current workspace, on the behavior " +
    "the task asks for, fix what fails, then finish.",
  requirements:
    "<requirements>\nRequirement sentences copied word for word from the task above and numbered by the harness " +
    "(the task text remains the full statement):\n{list}\n</requirements>",
  requirements_more: "[{count} more requirement sentences in the task are not listed here]",
  clean_env:
    "Your work may be checked in a fresh copy of the starting environment that receives only the files the task asks for. " +
    "So the deliverables must not depend on packages you install during the session (declare them where the task says dependencies go, or avoid them) " +
    "or read files outside the deliverables at run time (embed the data they need or keep a built-in fallback). " +
    "Remove helper, test and scratch files you create in the project tree, or keep them outside it (for example in /tmp), unless the task asks for them.",
  travel_check:
    "Before you finish: your work may be checked in a fresh copy of the starting environment that receives only the files the task asks for. " +
    "In the workspace now:\n{items}\n" +
    "Unless the task asks for these: remove scratch and test files from the project tree or move them outside it (for example to /tmp); " +
    "avoid packages installed during this session or declare or vendor them; embed the data a deliverable reads or give it a built-in fallback. Then finish.",
  unmet_target:
    "Your summary says: \"{sentence}\"\n" +
    "About {remaining} of the wall-clock budget is left. Keep working toward the target the task sets; " +
    "if something concrete blocks it, name the blocker in one line.",
  travel_jit_packages:
    "Note: {file} imports {packages}, installed during this session and present only here. Your result is checked in a fresh copy of the starting " +
    "environment that receives only your deliverable files, so this import fails there unless the task itself says to install the package. " +
    "Build the deliverable on what was installed at the start, and keep session-installed packages for your own checks.",
  travel_jit_scratch:
    "Note: you created {files} in the project tree, and the project tree is what gets checked; stray test or scratch files there can fail the check. " +
    "Keep scratch and test scripts outside it (for example in /tmp/work/), or delete them before you finish, unless the task asks for them.",
  travel_jit_data:
    "Note: {file} reads {reads} at run time. Your result is checked in a fresh copy of the starting environment that receives only your deliverable files, " +
    "so what it reads may not be there. Embed what the deliverable needs or give it a built-in fallback, unless the task says the file is provided at check time.",
  interface_gate:
    "Note: {file} gains {added}. Hidden tests exercise the behavior through the interfaces that existed before your change, so a fix that lives only " +
    "in a new method or opt-in path is not seen by them. If the task is to fix existing behavior, make the existing calls behave correctly.",
  thin_margin:
    "Note: your check passes by a thin margin ({measured} against the task's {threshold}). Graders re-measure on their own inputs, in a fresh process, " +
    "with the strictest reading of the requirement, so a result at the edge often fails there. Widen the margin, and measure the way a grader would " +
    "(fresh process and inputs, no warm caches), before you move on.",
  requirements_audit:
    "Before you finish: for each numbered item in the <requirements> list, and any other requirement the task states, give its number " +
    "and the exact command and output that prove it in the current workspace (the files as they are now, not an earlier state). " +
    "If any requirement is unproven, or only proven by a proxy (it compiles, the script runs, an easier case passes), prove it or fix it now. Then finish.",
  validator:
    "An independent check of the task's stated requirements, run on the workspace as it is now, found these problems:\n{items}\n" +
    "Fix them, re-verify yourself, then finish. The task text is the authority: where a finding contradicts it, keep what the task states.",
  critic:
    "An independent reviewer checked your work against the task and found:\n{findings}\n" +
    "Fix what is real, re-verify, then finish. The task text is the authority.",
  clause_check:
    "Note: an independent reading of the task found clauses your change and checks may not cover yet:\n{clauses}\n" +
    "Check each against the task text; fix what is real before you finish.",
});

/**
 * policy.clause_check's system prompt (src/clause-check.ts): one side call with
 * no tools, whose only message is the task, the workspace's changes since the
 * start and the check that just passed. A loadout may replace it
 * (policy.clause_check.prompt; it enters both hashes).
 */
export const CLAUSE_PROMPT =
  "You compare a software task with the work done on it so far. You get the task text, the changes made to the workspace since the start " +
  "(a diff, possibly cut), and the command and output of a check that just passed.\n\n" +
  "List each explicit requirement clause of the task that the changes plus the passing check do NOT show as handled.\n" +
  "- Only clauses the task text itself states: a behavior, an input or edge case, an output, a format, a name, a path, a limit. " +
  "Ignore style, structure and best practices; never add requirements the task does not state.\n" +
  "- A clause is handled when the changes implement it or the check's output shows it working.\n" +
  "- Quote each clause word for word from the task, one per line, starting with \"- \".\n" +
  "- If every clause is handled, answer exactly NONE.\n\n" +
  "Reply with the list or NONE and nothing else.";

/**
 * policy.critic's system prompt (src/critic.ts): a reviewer agent with a fresh
 * context and read-only use of the workspace. Its first message is the task,
 * the env, what changed since the start and the implementer's final message.
 * Placeholders: `{max_turns}` and `{max_findings}` (the lever's settings).
 * A loadout may replace it (policy.critic.prompt; it enters both hashes).
 */
export const CRITIC_PROMPT =
  "You are an independent reviewer. Another engineer worked on the software task below in this environment and says it is done. " +
  "Before the work goes to a hidden grader, find out whether it meets what the task states. You did not do the work: do not trust " +
  "the engineer's summary, numbers or tests; check for yourself.\n\n" +
  "How to review:\n" +
  "- Read the task first and note what it requires: every deliverable (file, path, name, function, class, command, endpoint, output, " +
  "its format and its location) and every stated behavior, limit, threshold and edge case.\n" +
  "- Check that the complete deliverable exists in the stated form, at the stated path, under the stated names.\n" +
  "- Exercise the work the way a grader would: through the interfaces, commands and paths the task names, on fresh inputs you choose, " +
  "including the edge cases, limits and error cases its wording names. A fix reachable only through a helper or a code path the grader " +
  "never calls does not count.\n" +
  "- Re-measure every number the task sets (accuracy, speed, size, counts, thresholds) yourself, fresh, against the exact bound the task states.\n" +
  "- Run the tests or checks that ship with the task, if any.\n" +
  "- Judge only against what the task states or necessarily implies. No remarks on style, naming or structure; never invent requirements. " +
  "The task text is the authority.\n\n" +
  "Rules:\n" +
  "- You cannot change the work. Do not create, edit, move or delete files in the project directory, do not install or upgrade packages, " +
  "and do not stop, start or restart services or processes the task needs (check the running ones). Write any scratch file or script " +
  "under your scratch directory (named below) and run it from there. Anything you change in the project directory is reverted when you finish.\n" +
  "- You have at most {max_turns} rounds of tool calls and a few minutes: batch your commands and give each a timeout.\n" +
  "- When you cannot tell whether something fails, or cannot check it here, count it as passing. Report only failures you observed " +
  "with your own commands.\n\n" +
  "When you are done, reply with no tool call and end with your verdict in exactly this form:\n" +
  "VERDICT: PASS\n" +
  "or\n" +
  "VERDICT: FAIL\n" +
  "1. Requirement: \"<the requirement, quoted word for word from the task>\"\n" +
  "   Fails: <what is wrong, in one or two sentences>\n" +
  "   Evidence: <the command you ran> -> <the output you observed>\n" +
  "Give at most {max_findings} findings, the most important first.";

/**
 * policy.validator's system prompt (src/validator.ts): the validator sees only
 * this, the task text, the workdir, the interpreters, the time limit and a
 * listing of the starting workspace, and replies with the check program. A
 * loadout may replace it (policy.validator.prompt; it enters both hashes).
 */
export const VALIDATOR_PROMPT =
  "You write acceptance checks for a software task. Another engineer is implementing the task right now in the environment described below. " +
  "You will not see their work and they will never see your program. When they say they are done, your program runs in that environment, " +
  "and every check it reports as failing is sent back to them as a problem to fix. A wrong failure sends them to break correct work, " +
  "so check only what the task states or necessarily implies.\n\n" +
  "Write ONE self-contained program in a single fenced code block: ```python if python3 is available, else ```bash. It must:\n" +
  "1. Check each requirement the task states, one check each, plus the edge cases its wording implies: several items where it says items, " +
  "the boundaries and limits it names, other encodings or spellings of an input it says must be handled, the error cases it names, " +
  "and numeric thresholds exactly as stated (never looser or stricter).\n" +
  "2. Test behavior the way a grader would: through the commands, file paths, function and class names, arguments and output formats the task names, " +
  "on fresh inputs you write. Call the interface the task names, never a helper it does not mention. Do not guess names, paths or formats " +
  "the task does not give: leave out any check that would need a guess.\n" +
  "3. Print exactly one line per check:\n" +
  "PASS <id> <requirement>\n" +
  "FAIL <id> <requirement>: <reason>\n" +
  "<id> is short (R1, R2a). <requirement> is a few words from the task, without a colon. <reason> says what was expected and what happened, " +
  "in under 150 characters. After the last check print: END <passed> <failed>\n" +
  "4. Run every check even after a failure: catch every error inside a check (a missing file, an import error, a crash, a timeout) " +
  "and report it as that check's FAIL line. Exit 0.\n" +
  "5. Never change the workspace. Copy what a check needs into a new temporary directory (tempfile.mkdtemp or mktemp -d) and build, run and write there. " +
  "If a deliverable can only write to a fixed path in the workspace, check the file it already produced instead of running it again. " +
  "Do not edit, delete or rename files in the workspace, install packages, use the internet, or stop, start or restart running services and processes; " +
  "if the task requires a service, check the running one.\n" +
  "6. Give every subprocess and every request to a local service a timeout, so the whole program finishes within the time limit below.\n" +
  "7. Use only the standard library and the tools present in the environment.\n\n" +
  "Reply with the code block only.";

/**
 * evidence_bounce (ported from mine2/finalclass.py): a final message that
 * claims requirement-level evidence matches one of `requirement`; one that
 * claims only proxies matches one of `proxy` and none of `requirement`.
 * JS regex sources, matched case-insensitively. Only `requirement` decides
 * whether the bounce fires; `proxy` labels the trace event.
 */
export const DEFAULT_EVIDENCE_PATTERNS = Object.freeze({
  requirement: Object.freeze([
    "tests? (?:pass|passed|passing)", "\\bpass(?:es|ed)?\\b", "match(?:es|ed)? (?:all|the|every|each)", "reproduc", "accura",
    "exact(?:ly)? (?:match|recover)", "identical", "byte-for-byte", "against (?:the )?(?:reference|expected|sample|training|oracle)",
    "end-to-end", "recovered", "regression", "randomi[sz]ed", "differential", "consistent with all", "verified (?:that|the)",
    "confirmed (?:that|the)", "benchmark", "speedup", "matches",
  ]),
  proxy: Object.freeze([
    "valid(?:ated)? (?:the )?JSON", "JSON (?:format|formatting|structure|validity|syntax)", "\\bformat(?:ting)?\\b", "\\bschema\\b",
    "\\bsyntax\\b", "compil", "py_compile", "\\blint", "type-?check", "\\bparses\\b", "\\bexists?\\b", "\\bimports?\\b",
    "(?:query )?coverage", "bounds", "indexing", "indices", "well-formed", "exit (?:code|status)s?", "runs? (?:without|successfully|cleanly)",
    "read-only files? (?:remain|were) unchanged", "unchanged",
  ]),
});

/**
 * Hedges in a final message ("not verified", "could not", "partially", "TODO"):
 * across harnesses a hedged final marks a likely failure (gold/winners-diff
 * §4, -14.9 pp). Case-sensitive JS regex sources; matched per sentence.
 */
export const DEFAULT_HEDGE_PATTERNS: readonly string[] = Object.freeze([
  "\\b[Nn]ot (?:been |yet )?(?:verified|tested|checked|run|confirmed|validated)\\b",
  "\\b(?:[Uu]nverified|[Uu]ntested)\\b",
  "\\b(?:[Cc]ould(?:n['\u2019]t| not)|[Cc]annot|[Cc]an['\u2019]t)\\b",
  "\\b[Uu]nable to\\b",
  "\\b(?:was|were)(?:n['\u2019]t| not) able to\\b",
  "\\b[Pp]artial(?:ly)?\\b",
  "\\bTODO\\b",
  "\\b(?:did|have|has)(?:n['\u2019]t| not) (?:run|test|verify|check|confirm)",
]);

/**
 * policy.interface_gate: task text (matched case-insensitively) that reads as
 * a bug fix or a change of existing behavior. Replay (scripts/replay-iface.ts):
 * "should", "expected", "issue(s)", "failure(s)" and "fixed" also fill feature
 * and build specs (risk-scorer, biped, mobly, bandit, expr: "a fixed seed",
 * "test failures", "bandit issues"), where a new function is the deliverable;
 * session-window-debug says "not working", "symptoms" and "inconsistent".
 */
export const DEFAULT_FIX_PATTERNS: readonly string[] = Object.freeze([
  "\\bfix(?:es|ing)?\\b",
  "\\bbug(?:s|gy)?\\b",
  "\\bincorrect(?:ly)?\\b",
  "\\bregress(?:ion|ions|ed)\\b",
  "\\bbroken\\b",
  "\\bfail(?:s|ing)\\b",
  "\\bnot (?:working|behaving)\\b",
  "\\bmisbehav(?:es|ing|ior|iour)\\b",
  "\\bsymptoms?\\b",
  "\\bwrong(?:ly)?\\b",
  "\\binconsistent\\b",
  "\\bcrash(?:es|ed|ing)?\\b",
]);

/**
 * D4: assistant text (matched case-insensitively) that announces the run is
 * finishing; the request after it decides "done or not", so it keeps the
 * run's effort. Broad on purpose: a false match only costs the lower effort.
 */
export const DEFAULT_FINISH_PATTERNS: readonly string[] = Object.freeze([
  "\\b(?:done|finished|complete|completed)\\b",
  "\\b(?:final|last|one more) (?:check|verification|review|look|pass|step|test|run|sanity)",
  "\\b(?:wrap(?:ping)? up|finish(?:ing)? up|before (?:i |we )?(?:finish|conclude|wrap))",
  "\\b(?:all|every) (?:tests?|checks?|requirements?) (?:now )?(?:pass|passed|passing|green|met|satisfied)\\b",
  "\\bsummar(?:y|ize|ise)\\b",
]);

/**
 * The pinned turn-1 discovery command (P3): read-only, POSIX find/awk/sort
 * (GNU and BSD), depth <= 3, vendored and cache trees pruned, shallow paths
 * first, directories with a trailing slash. Its output is the same on every
 * trial of a task (no sizes or times), so the first message stays one cache
 * prefix across trials.
 */
export const DISCOVERY_COMMAND = [
  "{ find . -maxdepth 3 \\( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name __pycache__ -o -name .tox -o -name .mypy_cache",
  "-o -name .pytest_cache -o -name site-packages -o -name target -o -name .cache \\) -prune -o -type d \\( -iname 'test' -o -iname 'tests'",
  "-o -iname 'testing' -o -iname 'spec' -o -iname 'specs' -o -iname '__tests__' -o -iname 'example*' -o -iname 'sample*' -o -iname 'expected*'",
  "-o -iname 'fixtures' -o -iname 'valid*' -o -iname 'verif*' -o -iname 'grade*' -o -iname 'grading' -o -iname 'check*' -o -iname 'eval*' -o -iname 'scripts' \\)",
  "-exec printf '%s/\\n' {} + ;",
  "find . -maxdepth 3 \\( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name __pycache__ -o -name .tox -o -name .mypy_cache",
  "-o -name .pytest_cache -o -name site-packages -o -name target -o -name .cache \\) -prune -o -type f \\( -iname 'test_*' -o -iname '*_test.*'",
  "-o -iname '*.test.*' -o -iname '*_spec.*' -o -iname '*.spec.*' -o -iname 'verif*' -o -iname 'valid*' -o -iname 'grade*' -o -iname 'check*'",
  "-o -iname 'example*' -o -iname 'sample*' -o -iname 'expected*' -o -iname 'README*' -o -iname 'AGENTS.md' -o -iname 'CLAUDE.md' -o -iname 'CONTRIBUTING*'",
  "-o -name 'Makefile' -o -name 'justfile' -o -name 'tox.ini' -o -name 'pytest.ini' -o -name 'noxfile.py' -o -name 'pyproject.toml' -o -name 'package.json'",
  "-o -name 'Cargo.toml' -o -name 'go.mod' -o -name '*.sh' -o -ipath '*/test/*' -o -ipath '*/tests/*' -o -ipath '*/example*/*' -o -ipath '*/sample*/*'",
  "-o -ipath '*/expected*/*' -o -ipath '*/spec/*' -o -ipath '*/__tests__/*' -o -ipath '*/scripts/*' \\) -print ; } 2>/dev/null",
  "| sed 's|^\\./||' | awk -F/ '{ d = NF; if ($0 ~ /\\/$/) d--; print d \"\\t\" $0 }' | LC_ALL=C sort -t \"$(printf '\\t')\" -k1,1n -k2,2 -u | cut -f2- | head -n 1000",
].join(" ");

/**
 * Placebo text (prompt.placebo): neutral sentences that ask for nothing,
 * cycled from an offset fixed by the addendum id, cut to the addendum's
 * estimated token count. Every word is short and common, so one word is one
 * token on the OpenAI and Anthropic tokenizers.
 */
const PLACEBO_SENTENCES = [
  "The river runs past the old mill and on to the sea.",
  "A small boat rests on the bank near the bridge.",
  "Birds sing in the trees at the edge of the field.",
  "The town has a market on the first day of each week.",
  "Snow falls on the hills in the cold part of the year.",
  "The road turns west at the farm and goes up the hill.",
  "A clock on the wall shows the time in the hall.",
  "The wind moves the grass in long slow waves.",
] as const;

/** Pre-tokens (the GPT-4o split pattern, simplified), with long words counted as two: a deterministic token estimate without a tokenizer. */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const [piece] of text.matchAll(/[^\r\n\p{L}\p{N}]?\p{L}+(?:'[a-z]+)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu)) {
    const letters = piece.replace(/[^\p{L}]/gu, "").length;
    count += letters > 10 ? 2 : 1;
  }
  return count;
}

/** Neutral text whose estimated token count equals the addendum's; the same id and text always give the same placebo. */
export function placeboFor(id: string, text: string): string {
  const target = estimateTokens(text);
  let offset = 0;
  for (const char of id) offset = (offset * 31 + char.codePointAt(0)!) % PLACEBO_SENTENCES.length;
  const words: string[] = [];
  // Every sentence starts with a one-token word, so trimming back never undershoots twice in a row.
  for (let i = 0; estimateTokens(words.join(" ")) < target; i++) {
    words.push(...PLACEBO_SENTENCES[(offset + i) % PLACEBO_SENTENCES.length]!.split(" "));
    while (estimateTokens(words.join(" ")) > target) words.pop();
  }
  return words.join(" ");
}
