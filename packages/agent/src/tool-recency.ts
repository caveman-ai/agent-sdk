// Experimental, off unless `RunOptions.toolRecency` is set: each folder keeps
// its tool calls in a splay tree, and a run declares only the tools nearest the
// root. The rest stay one `cave_load_tools` call away, so no tool is lost.
//
// The hot set is read once, at run start, and stays fixed for the run: a tool
// list that changed every request would rebuild the provider's prompt cache on
// every request. Loading a cold tool changes the list once (Pi declares the
// addition), and the tree only moves on disk when the run saves.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";

export interface ToolRecencyOptions {
  /** How many tools stay declared on every request. The rest wait behind `cave_load_tools`. */
  hot: number;
  /** The folder whose history is read and updated. Default: the run's `rootDir`. */
  folder?: string;
  /** The file holding every folder's tree. Default: `~/.caveman/tool-recency.json`. */
  storePath?: string;
}

type NextTurnHook = NonNullable<Agent["prepareNextTurnWithContext"]>;

export const TOOL_RECENCY_LOADER = "cave_load_tools";
const STORE_VERSION = 1;
const MAX_FOLDERS = 64;
const MAX_TOOLS_PER_FOLDER = 128;
const STALE_FOLDER_MS = 30 * 24 * 60 * 60 * 1000;

interface SplayNode {
  key: string;
  left: SplayNode | undefined;
  right: SplayNode | undefined;
}

/**
 * A splay tree of string keys. `access` moves a key to the root, so the keys
 * touched most recently sit nearest it; `top` reads them breadth-first.
 */
export class SplayTree {
  #root: SplayNode | undefined;
  #size = 0;

  /** Rebuilds a tree from `top()` output. Breadth-first order puts every parent before its children. */
  static fromTop(keys: readonly string[]): SplayTree {
    const tree = new SplayTree();
    for (const key of keys) tree.#insertLeaf(key);
    return tree;
  }

  get size(): number {
    return this.#size;
  }

  /** Inserts `key` if it is absent, then splays it to the root. */
  access(key: string): void {
    if (this.#root === undefined) {
      this.#root = { key, left: undefined, right: undefined };
      this.#size = 1;
      return;
    }
    const root = splay(this.#root, key);
    if (root.key === key) {
      this.#root = root;
      return;
    }
    this.#root = key < root.key
      ? { key, left: root.left, right: { ...root, left: undefined } }
      : { key, left: { ...root, right: undefined }, right: root.right };
    this.#size++;
  }

  /** Keys in sorted order. */
  inOrder(): string[] {
    const keys: string[] = [];
    const walk = (node: SplayNode | undefined): void => {
      if (node === undefined) return;
      walk(node.left);
      keys.push(node.key);
      walk(node.right);
    };
    walk(this.#root);
    return keys;
  }

  /** Up to `k` keys, nearest the root first. Any prefix is a subtree that contains the root. */
  top(k = this.#size): string[] {
    const keys: string[] = [];
    const queue = this.#root === undefined ? [] : [this.#root];
    for (let index = 0; index < queue.length && keys.length < k; index++) {
      const node = queue[index]!;
      keys.push(node.key);
      if (node.left !== undefined) queue.push(node.left);
      if (node.right !== undefined) queue.push(node.right);
    }
    return keys;
  }

  // A plain BST insert with no splay, which keeps the shape `fromTop` restores.
  #insertLeaf(key: string): void {
    const leaf: SplayNode = { key, left: undefined, right: undefined };
    if (this.#root === undefined) {
      this.#root = leaf;
      this.#size = 1;
      return;
    }
    let node = this.#root;
    for (;;) {
      if (key === node.key) return;
      const side = key < node.key ? "left" : "right";
      const next = node[side];
      if (next === undefined) {
        node[side] = leaf;
        this.#size++;
        return;
      }
      node = next;
    }
  }
}

// Sleator and Tarjan's top-down splay. It returns the new root: `key` when it
// is present, otherwise the last node on its search path.
function splay(root: SplayNode, key: string): SplayNode {
  const header: SplayNode = { key: "", left: undefined, right: undefined };
  let left = header;
  let right = header;
  let node = root;
  for (;;) {
    if (key < node.key) {
      let child = node.left;
      if (child === undefined) break;
      if (key < child.key) {
        node.left = child.right;
        child.right = node;
        node = child;
        child = node.left;
        if (child === undefined) break;
      }
      right.left = node;
      right = node;
      node = child;
    } else if (key > node.key) {
      let child = node.right;
      if (child === undefined) break;
      if (key > child.key) {
        node.right = child.left;
        child.left = node;
        node = child;
        child = node.right;
        if (child === undefined) break;
      }
      left.right = node;
      left = node;
      node = child;
    } else {
      break;
    }
  }
  left.right = node.left;
  right.left = node.right;
  node.left = header.right;
  node.right = header.left;
  return node;
}

interface StoredFolder {
  at: number;
  tools: string[];
}

type Store = Record<string, StoredFolder>;

// The store is a hint. A missing, unreadable, or foreign file reads as empty,
// and an empty folder declares every tool, which is the behaviour with the
// flag off.
async function readStore(path: string): Promise<Store> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { v, folders } = parsed as { v?: unknown; folders?: unknown };
  if (v !== STORE_VERSION || typeof folders !== "object" || folders === null) return {};
  const store: Store = {};
  for (const [folder, value] of Object.entries(folders)) {
    const { at, tools } = (value ?? {}) as { at?: unknown; tools?: unknown };
    if (typeof at === "number" && Array.isArray(tools) && tools.every((tool) => typeof tool === "string")) {
      store[folder] = { at, tools };
    }
  }
  return store;
}

/** Drops folders untouched for 30 days, then the oldest past 64 folders, and trims each tree to 128 tools. */
export function pruneStore(store: Store, now: number): Store {
  const kept = Object.entries(store)
    .filter(([, entry]) => now - entry.at < STALE_FOLDER_MS)
    .sort(([, first], [, second]) => second.at - first.at)
    .slice(0, MAX_FOLDERS)
    .map(([folder, entry]) => [folder, { at: entry.at, tools: entry.tools.slice(0, MAX_TOOLS_PER_FOLDER) }]);
  return Object.fromEntries(kept);
}

export interface ToolRecencySession {
  /** The tools to declare at run start: framework tools, the hot set, and the loader when anything is deferred. */
  declare(tools: AgentTool<TSchema>[]): AgentTool<TSchema>[];
  /** Splays a tool the model called. */
  access(name: string): void;
  /**
   * Wraps Pi's `prepareNextTurnWithContext` so a tool loaded during a turn
   * joins the next turn's context. Pi then declares it to the model before
   * the request, which a `prepareRequest` change would be too late for.
   */
  nextTurn(inner: NextTurnHook | undefined): NextTurnHook;
  /** Writes this folder's tree back. Best-effort: a lost write costs the next run some history. */
  save(): Promise<void>;
}

/** Undefined when the run did not set `toolRecency`. */
export async function openToolRecency(
  run: { toolRecency?: ToolRecencyOptions; rootDir?: string; durable?: unknown },
  lockedPlan: boolean,
): Promise<ToolRecencySession | undefined> {
  const options = run.toolRecency;
  if (options === undefined) return undefined;
  // A durable resume or a locked plan must see the tool list it started with,
  // and this list depends on a file other runs rewrite.
  if (run.durable !== undefined) throw new Error("cave_tool_recency_durable_unsupported");
  if (lockedPlan) throw new Error("cave_tool_recency_locked_plan_unsupported");
  if (!Number.isSafeInteger(options.hot) || options.hot < 1) throw new Error("cave_tool_recency_hot_invalid");
  const storePath = options.storePath ?? join(homedir(), ".caveman", "tool-recency.json");
  const folder = resolve(options.folder ?? run.rootDir ?? process.cwd());
  const tree = SplayTree.fromTop((await readStore(storePath))[folder]?.tools ?? []);
  const cold = new Map<string, AgentTool<TSchema>>();
  const loaded = new Map<string, AgentTool<TSchema>>();
  return {
    declare(tools) {
      const deferrable = tools.filter((tool) => !tool.name.startsWith("cave_"));
      if (tree.size === 0 || deferrable.length <= options.hot) return tools;
      const names = new Set(deferrable.map((tool) => tool.name));
      const hot = new Set(tree.top().filter((name) => names.has(name)).slice(0, options.hot));
      // Too little history fills the hot set in declaration order.
      for (const tool of deferrable) {
        if (hot.size >= options.hot) break;
        hot.add(tool.name);
      }
      for (const tool of deferrable) if (!hot.has(tool.name)) cold.set(tool.name, tool);
      return [...tools.filter((tool) => !cold.has(tool.name)), loaderTool(cold, loaded)];
    },
    access(name) {
      if (!name.startsWith("cave_")) tree.access(name);
    },
    nextTurn(inner) {
      return async (turn, signal) => {
        const update = await inner?.(turn, signal);
        const context = update?.context ?? turn.context;
        const present = new Set((context.tools ?? []).map((tool) => tool.name));
        const missing = [...loaded.values()].filter((tool) => !present.has(tool.name));
        return missing.length === 0
          ? update
          : { ...update, context: { ...context, tools: [...(context.tools ?? []), ...missing] } };
      };
    },
    async save() {
      try {
        const now = Date.now();
        const store = pruneStore({ ...(await readStore(storePath)), [folder]: { at: now, tools: tree.top() } }, now);
        await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
        const temporary = `${storePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ v: STORE_VERSION, folders: store }), { mode: 0o600 });
        await rename(temporary, storePath);
      } catch {
        // The store is a hint; a failed write must not fail the run that used it.
      }
    },
  };
}

function loaderTool(
  cold: ReadonlyMap<string, AgentTool<TSchema>>,
  loaded: Map<string, AgentTool<TSchema>>,
): AgentTool<TSchema> {
  const listing = [...cold.values()].map((tool) => `${tool.name}: ${summary(tool.description)}`).join("\n");
  return {
    name: TOOL_RECENCY_LOADER,
    label: TOOL_RECENCY_LOADER,
    description: "Declare tools this conversation does not carry yet. A loaded tool is callable from your next " +
      `response. Tools you can load:\n${listing}`,
    parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1 }) }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const names = (params as { names: string[] }).names;
      const unknown = names.filter((name) => !cold.has(name));
      if (unknown.length > 0) throw new Error(`cave_load_tools_unknown:${unknown.join(",")}`);
      for (const name of names) loaded.set(name, cold.get(name)!);
      return {
        content: [{ type: "text", text: `Loaded ${names.join(", ")}. Call them from your next response.` }],
        details: { loaded: names },
      };
    },
  };
}

// First sentence, capped, so the listing stays small next to the declarations it replaces.
function summary(description: string): string {
  const sentence = description.split(/(?<=\.)\s/, 1)[0]!.replace(/\s+/g, " ").trim();
  return sentence.length <= 120 ? sentence : `${sentence.slice(0, 117)}...`;
}
