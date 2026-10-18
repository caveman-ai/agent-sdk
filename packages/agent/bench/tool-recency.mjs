#!/usr/bin/env node
// Replays tool-call traces against RunOptions.toolRecency's hot-set policy and
// two simpler baselines. Run `npm --prefix packages/agent run build` first.
//
//   node packages/agent/bench/tool-recency.mjs                 # synthetic, seeded
//   node packages/agent/bench/tool-recency.mjs --claude-projects ~/.claude/projects
//
// The second form reads Claude Code transcripts: one session per .jsonl file,
// one folder per project directory, tool calls in transcript order. Only tool
// names are read, and only counts are printed.
//
// Each session's hot set is fixed when it starts, as in the runtime. A session
// with no history for its folder is cold: it declares every tool, as the
// runtime does. Hit rate and loads cover warm sessions only, so a policy is not
// credited for cold starts. A call is a hit when its tool was in the hot set;
// "loads" counts the distinct cold tools a warm session had to load;
// "per-call" recomputes the set before every call, the cache-hostile upper
// bound. "declared" averages the tool-list size at session start over every
// session, cold ones included, so it is the list a provider actually sees.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SplayTree } from "../dist/tool-recency.js";

const { values: args } = parseArgs({
  options: {
    "claude-projects": { type: "string" },
    k: { type: "string", default: "4,8,12,16" },
    seed: { type: "string", default: "42" },
  },
});
const ks = args.k.split(",").map(Number);
// Claude Code's own deferred-tool loader; it plays the part of cave_load_tools.
const LOADERS = new Set(["ToolSearch"]);

const policies = {
  splay: () => {
    const tree = new SplayTree();
    return { size: () => tree.size, record: (name) => tree.access(name), top: (k) => tree.top(k) };
  },
  lru: () => {
    const order = [];
    return {
      size: () => order.length,
      record: (name) => {
        const index = order.indexOf(name);
        if (index !== -1) order.splice(index, 1);
        order.unshift(name);
      },
      top: (k) => order.slice(0, k),
    };
  },
  lfu: () => {
    const counts = new Map();
    let clock = 0;
    return {
      size: () => counts.size,
      record: (name) => counts.set(name, { n: (counts.get(name)?.n ?? 0) + 1, at: clock++ }),
      top: (k) => [...counts].sort(([, a], [, b]) => b.n - a.n || b.at - a.at).slice(0, k).map(([name]) => name),
    };
  },
};

function hotSet(state, k, catalog) {
  if (state.size() === 0) return undefined;
  const hot = new Set(state.top(k));
  for (const name of catalog) {
    if (hot.size >= k) break;
    hot.add(name);
  }
  return hot;
}

function replay(sessions, catalog, policy, k, scope) {
  const states = new Map();
  const totals = { calls: 0, hits: 0, perCallHits: 0, loads: 0, sessions: 0, coldStarts: 0, startSize: 0 };
  for (const session of sessions) {
    const key = scope === "global" ? "" : session.folder;
    if (!states.has(key)) states.set(key, policies[policy]());
    const state = states.get(key);
    const hot = hotSet(state, k, catalog);
    const loaded = new Set();
    // A deferring session declares k tools plus the loader.
    totals.startSize += hot === undefined ? catalog.length : Math.min(k, catalog.length) + 1;
    if (hot === undefined) {
      totals.coldStarts++;
      for (const name of session.calls) state.record(name);
      continue;
    }
    totals.sessions++;
    for (const name of session.calls) {
      totals.calls++;
      if (hot.has(name)) totals.hits++;
      else loaded.add(name);
      if (hotSet(state, k, catalog).has(name)) totals.perCallHits++;
      state.record(name);
    }
    totals.loads += loaded.size;
  }
  return totals;
}

function row(label, k, totals) {
  const pct = (value) => `${((100 * value) / totals.calls).toFixed(1)}%`;
  const declared = (totals.startSize / (totals.sessions + totals.coldStarts)).toFixed(1);
  return `| ${label} | ${k} | ${pct(totals.hits)} | ${pct(totals.perCallHits)} | ` +
    `${(totals.loads / totals.sessions).toFixed(2)} | ${declared} | ${totals.coldStarts} |`;
}

// ---- traces ----

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 40 tools: 6 core tools every folder leans on, 34 specialists. Each folder
// prefers its own Zipf-ranked slice of specialists, and that slice drifts every
// few sessions, so pure recency and pure frequency are both imperfect.
function syntheticSessions(seed) {
  const random = rng(seed);
  const core = ["read_file", "grep", "bash", "edit_file", "list_dir", "write_file"];
  const specialists = Array.from({ length: 34 }, (_, index) => `tool_${String(index).padStart(2, "0")}`);
  const catalog = [...core, ...specialists];
  const pick = (weights) => {
    let roll = random() * weights.reduce((sum, [, w]) => sum + w, 0);
    for (const [name, weight] of weights) if ((roll -= weight) <= 0) return name;
    return weights.at(-1)[0];
  };
  const shuffled = () => specialists.map((name) => [name, random()]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const sessions = [];
  for (let folder = 0; folder < 12; folder++) {
    let ranked = shuffled();
    for (let index = 0; index < 30; index++) {
      if (index % 8 === 7) ranked = [...ranked.slice(3), ...ranked.slice(0, 3)];
      const weights = [
        ...core.map((name, rank) => [name, 3 / (rank + 1)]),
        ...ranked.map((name, rank) => [name, 1.5 / (rank + 1) ** 1.2]),
      ];
      const length = 5 + Math.floor(random() * 30);
      sessions.push({ folder: `f${folder}`, at: index * 12 + folder, calls: Array.from({ length }, () => pick(weights)) });
    }
  }
  return { sessions: sessions.sort((a, b) => a.at - b.at), catalog };
}

async function claudeSessions(root) {
  const sessions = [];
  for (const folder of await readdir(root)) {
    let files;
    try {
      files = (await readdir(join(root, folder))).filter((file) => file.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const calls = [];
      let at;
      for (const line of (await readFile(join(root, folder, file), "utf8")).split("\n")) {
        if (!line.includes('"tool_use"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        at ??= Date.parse(entry.timestamp);
        for (const part of entry.message?.content ?? []) {
          if (part?.type === "tool_use" && typeof part.name === "string" && !LOADERS.has(part.name)) calls.push(part.name);
        }
      }
      if (calls.length > 0) sessions.push({ folder, at: at ?? 0, calls });
    }
  }
  sessions.sort((a, b) => a.at - b.at);
  // The declared set is unknown; the union of tools ever called stands in for
  // it, sorted by name so padding a short history leaks no future information.
  const catalog = [...new Set(sessions.flatMap((session) => session.calls))].sort();
  return { sessions, catalog };
}

const { sessions, catalog } = args["claude-projects"]
  ? await claudeSessions(args["claude-projects"])
  : syntheticSessions(Number(args.seed));
const calls = sessions.reduce((sum, session) => sum + session.calls.length, 0);
const folders = new Set(sessions.map((session) => session.folder)).size;
console.log(`${args["claude-projects"] ? "Claude Code transcripts" : `synthetic (seed ${args.seed})`}: ` +
  `${folders} folders, ${sessions.length} sessions, ${calls} calls, ${catalog.length} tools\n`);
console.log("| policy | k | hit rate | per-call | loads/session | declared | cold starts |");
console.log("|---|---|---|---|---|---|---|");
console.log(`| current (all declared) | - | 100.0% | 100.0% | 0 | ${catalog.length} | - |`);
for (const k of ks) {
  for (const policy of ["splay", "lru", "lfu"]) {
    console.log(row(`${policy} / folder`, k, replay(sessions, catalog, policy, k, "folder")));
  }
  console.log(row("splay / global", k, replay(sessions, catalog, "splay", k, "global")));
}
