/**
 * The JavaScript runtime behind `exec`: pi-codemode 1.4's QuickJS VM (wasm)
 * in a worker thread, with a launcher of our own so the host sees each
 * `text()`/`image()` item as the VM writes it (Codex's cell yield returns the
 * output so far while the script keeps running; pi-codemode's own launcher
 * only hands output over when the script ends).
 *
 * Why pi-codemode and not the climb branch's node:vm-in-a-Worker: the harness
 * runs on the host, outside the task sandbox, next to the provider token. node:vm is not a security boundary (one leaked host object
 * is `constructor.constructor("return process")()`); a wasm VM whose only
 * capability is calling our tools is. pi-codemode is already pinned, Pi
 * maintains it, and it gives tools/ALL_TOOLS/text/image/exit/store/load with
 * Codex-like semantics. The cost: QuickJS is not V8 (no V8-specific
 * extensions; scripts here are glue around tool calls), and timers, notify and
 * yield_control are ours (globals plus a one-line prelude in surface.ts).
 *
 * One-file bundle: the bundle embeds quickjs.wasm (esbuild binary loader on a
 * virtual module) and pi-codemode's worker entry bundled on its own (~60 KB,
 * text loader), started from a `data:` URL. A worker that loaded the whole
 * 1.9 MB bundle cost ~100 ms per cell. From TypeScript sources (tests)
 * pi-codemode's own worker file and the installed quickjs.wasm are used.
 */
import { Worker } from "node:worker_threads";
import { CodemodeSandboxBase, loadQuickJSWasm, type CodemodeOutputItem, type CodemodeSandboxBaseOptions, type CodemodeWasmModule } from "@earendil-works/pi-codemode";

declare const HARNESS_BUNDLE: boolean | undefined;

const bundled = typeof HARNESS_BUNDLE !== "undefined" && HARNESS_BUNDLE === true;

let compiled: Promise<CodemodeWasmModule> | undefined;

/** quickjs.wasm compiled once per process: embedded in the bundle, the installed file from sources. */
export function quickjsModule(): Promise<CodemodeWasmModule> {
  if (compiled !== undefined) return compiled;
  if (bundled) {
    // @ts-expect-error virtual module provided by scripts/bundle.mjs (esbuild binary loader)
    compiled = import("harness:quickjs-wasm").then((module: { default: Uint8Array }) =>
      (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } }).WebAssembly.compile(module.default));
  } else {
    compiled = loadQuickJSWasm();
  }
  compiled.catch(() => (compiled = undefined));
  return compiled;
}

let embeddedWorker: Promise<URL> | undefined;

async function workerUrl(): Promise<URL> {
  if (!bundled) return new URL(import.meta.resolve("@earendil-works/pi-codemode/worker"));
  // @ts-expect-error virtual module provided by scripts/bundle.mjs (esbuild text loader)
  embeddedWorker ??= import("harness:codemode-worker").then((module: { default: string }) =>
    new URL(`data:text/javascript;base64,${Buffer.from(module.default, "utf8").toString("base64")}`));
  return embeddedWorker;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface VmEvents { message(message: unknown): void; failure(error: { kind: "sandbox"; name?: string; message: string }): void }

/**
 * pi-codemode's worker launcher (host.js, MIT) with two changes: output items
 * are reported to `onOutput` as they arrive, and the worker may be this bundle.
 */
function launcher(onOutput: (item: CodemodeOutputItem) => void) {
  return async (data: object, events: VmEvents) => {
    let module: CodemodeWasmModule;
    try {
      module = await quickjsModule();
    } catch (error) {
      throw new Error(`Failed to load QuickJS: ${message(error)}`);
    }
    const interrupt = new SharedArrayBuffer(4);
    const worker = new Worker(await workerUrl(), { workerData: { ...data, wasm: module, interrupt } });
    worker.on("message", (item: unknown) => {
      if (typeof item === "object" && item !== null && ("watch:import" in item || "watch:require" in item)) return;
      const output = item as { type?: string; item?: CodemodeOutputItem };
      if (output.type === "output" && output.item !== undefined) onOutput(output.item);
      events.message(item);
    });
    worker.on("error", (error) => events.failure({ kind: "sandbox", ...(error instanceof Error ? { name: error.name } : {}), message: message(error) }));
    worker.on("exit", (code) => events.failure({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` }));
    const stop = async () => {
      Atomics.store(new Int32Array(interrupt), 0, 1);
      void worker.terminate().catch(() => undefined);
      worker.unref();
    };
    return { post: (payload: unknown) => worker.postMessage(payload), stop };
  };
}

/** A sandbox for one cell: its own launcher reports that cell's output as it is written. */
export class CellSandbox extends CodemodeSandboxBase {
  constructor(options: CodemodeSandboxBaseOptions, onOutput: (item: CodemodeOutputItem) => void) {
    super(options, launcher(onOutput) as unknown as ConstructorParameters<typeof CodemodeSandboxBase>[1]);
  }
}
