// RunOptions.toolRecency (experimental, off by default): a per-folder splay
// tree of tool calls decides which tools a run declares up front.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { agent, auto, run, schema, tool } from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";
import { SplayTree, pruneStore } from "../dist/tool-recency.js";

test("access splays the key to the root and keeps the keys sorted and unique", () => {
  const tree = new SplayTree();
  for (const key of ["m", "c", "x", "a", "e", "c", "z"]) tree.access(key);
  assert.equal(tree.size, 6);
  assert.deepEqual(tree.inOrder(), ["a", "c", "e", "m", "x", "z"]);
  assert.deepEqual(tree.top(1), ["z"]);
  tree.access("e");
  assert.deepEqual(tree.top(1), ["e"]);
  assert.equal(tree.top(3).length, 3);
  assert.deepEqual(tree.top().toSorted(), tree.inOrder());
});

test("a random workload keeps the BST invariant and the last access at the root", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const tree = new SplayTree();
  const seen = new Set();
  for (let index = 0; index < 2000; index++) {
    const key = `t${next() % 40}`;
    tree.access(key);
    seen.add(key);
    assert.equal(tree.top(1)[0], key);
  }
  assert.deepEqual(tree.inOrder(), [...seen].toSorted());
  assert.equal(tree.size, seen.size);
});

test("fromTop rebuilds the exact shape, and any top() prefix is a root subtree", () => {
  const tree = new SplayTree();
  for (const key of ["g", "b", "q", "a", "k", "z", "d", "k", "b"]) tree.access(key);
  const copy = SplayTree.fromTop(tree.top());
  assert.deepEqual(copy.top(), tree.top());
  const pruned = SplayTree.fromTop(tree.top(4));
  assert.deepEqual(pruned.top(), tree.top(4));
});

test("pruneStore drops stale folders, keeps the newest 64, and trims each to 128 tools", () => {
  const now = Date.UTC(2026, 9, 18);
  const day = 24 * 60 * 60 * 1000;
  const store = { stale: { at: now - 31 * day, tools: ["a"] } };
  for (let index = 0; index < 70; index++) {
    store[`f${index}`] = { at: now - index * 1000, tools: Array.from({ length: 200 }, (_, i) => `t${i}`) };
  }
  const pruned = pruneStore(store, now);
  assert.equal(Object.keys(pruned).length, 64);
  assert.equal(pruned.stale, undefined);
  assert.equal(pruned.f69, undefined);
  assert.equal(pruned.f0.tools.length, 128);
});

function recencyAgent(log) {
  const make = (name) => tool({
    name,
    description: `Tool ${name}. Longer text the listing drops.`,
    input: schema.object({}),
    effect: "read",
    execute: async () => { log.push(name); return name; },
  });
  return agent({
    id: "tool-recency",
    instructions: "Use the tools.",
    model: auto(),
    sandbox: "host",
    tools: ["alpha", "beta", "gamma", "delta"].map(make),
  });
}

function recorded(turns, seen) {
  const inner = scriptedStream(turns);
  return (model, context, options) => {
    // Framework tools other than the loader are always declared and not under test.
    seen.push(getCurrentTools(context.messages).map((item) => item.name)
      .filter((name) => !name.startsWith("cave_") || name === "cave_load_tools"));
    return inner(model, context, options);
  };
}

test("a run declares the folder's hot tools and loads a cold one on demand", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cave-tool-recency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, "store.json");
  const toolRecency = { hot: 1, folder: dir, storePath };
  const log = [];
  const first = [];
  await run(recencyAgent(log), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    toolRecency,
    streamFn: recorded([{ toolCalls: [{ name: "gamma" }] }, { text: "done" }], first),
  });
  assert.deepEqual(first[0], ["alpha", "beta", "gamma", "delta"], "no history declares every tool");
  const stored = JSON.parse(await readFile(storePath, "utf8"));
  assert.deepEqual(stored.folders[dir].tools, ["gamma"]);

  const second = [];
  const result = await run(recencyAgent(log), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    toolRecency,
    streamFn: recorded([
      { toolCalls: [{ name: "cave_load_tools", args: { names: ["alpha"] } }] },
      { toolCalls: [{ name: "alpha" }] },
      { text: "done" },
    ], second),
  });
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(second[0], ["gamma", "cave_load_tools"]);
  assert.deepEqual(second[1], ["gamma", "cave_load_tools", "alpha"]);
  assert.deepEqual(log, ["gamma", "alpha"]);
  const after = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(after.folders[dir].tools[0], "alpha", "the last call is the new root");
  // hot: 2 now keeps alpha and gamma; the loader lists the rest by first sentence.
  assert.match(await recordedLoaderDescription(dir), /Tools you can load:\nbeta: Tool beta\.\ndelta: Tool delta\.$/);
});

async function recordedLoaderDescription(dir) {
  const storePath = join(dir, "store.json");
  let description = "";
  await run(recencyAgent([]), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    toolRecency: { hot: 2, folder: dir, storePath },
    streamFn: (model, context, options) => {
      description = getCurrentTools(context.messages).find((item) => item.name === "cave_load_tools").description;
      return scriptedStream([{ text: "done" }])(model, context, options);
    },
  });
  return description;
}

test("an unreadable store declares every tool, and a bad name is a tool error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cave-tool-recency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, "store.json");
  await writeFile(storePath, "{not json");
  const seen = [];
  await run(recencyAgent([]), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    toolRecency: { hot: 1, folder: dir, storePath },
    streamFn: recorded([{ text: "done" }], seen),
  });
  assert.deepEqual(seen[0], ["alpha", "beta", "gamma", "delta"]);

  await writeFile(storePath, JSON.stringify({ v: 1, folders: { [dir]: { at: Date.now(), tools: ["beta"] } } }));
  const results = [];
  const turns = [{ toolCalls: [{ name: "cave_load_tools", args: { names: ["nope"] } }] }, { text: "done" }];
  const inner = scriptedStream(turns);
  await run(recencyAgent([]), "go", {
    ensureRuntime: false,
    model: fauxModel(),
    toolRecency: { hot: 1, folder: dir, storePath },
    streamFn: (model, context, options) => {
      results.push(...context.messages.filter((message) => message.role === "toolResult"));
      return inner(model, context, options);
    },
  });
  assert.equal(results[0].isError, true);
  assert.match(JSON.stringify(results[0].content), /cave_load_tools_unknown:nope/);
});

test("toolRecency refuses durable runs and a non-positive hot count", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cave-tool-recency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { ensureRuntime: false, model: fauxModel(), streamFn: scriptedStream([{ text: "done" }]) };
  await assert.rejects(
    run(recencyAgent([]), "go", { ...base, toolRecency: { hot: 0, storePath: join(dir, "s.json") } }),
    /cave_tool_recency_hot_invalid/,
  );
  await assert.rejects(
    run(recencyAgent([]), "go", {
      ...base,
      toolRecency: { hot: 2, storePath: join(dir, "s.json") },
      durable: { runId: "recency-durable", store: undefined },
      rootDir: dir,
    }),
    /cave_tool_recency_durable_unsupported/,
  );
});
