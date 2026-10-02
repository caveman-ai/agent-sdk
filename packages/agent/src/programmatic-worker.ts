/**
 * Eval Worker source for one programmatic code cell. The cell runs in a fresh
 * `node:vm` context with no timers, I/O, or Worker globals. Only frozen
 * null-prototype bridges cross realms; they type-check primitive arguments and
 * return strings or undefined. `__cave_call` returns a Worker-realm promise,
 * reachable only inside the bootstrap closure. Every user-visible wrapper is
 * built inside the context, and the Worker never calls guest functions.
 *
 * Messages to the host: `tool.call` and `discover` (answered by `tool.result`),
 * `output` (streamed so failures keep partial output), then exactly one of
 * `done` or `error`.
 */
export const PROGRAMMATIC_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const { isProxy } = require("node:util").types;

let nextCallId = 1;
const pending = new Map();
let finished = false;
let outputBytes = 0;
let droppedBytes = 0;
let printed = 0;
let maxOutputBytes = 0;

function finish(message) {
  if (finished) return;
  finished = true;
  parentPort.postMessage({ ...message, droppedBytes });
}

function failure(message, stack) {
  return { ok: false, error: message, ...(stack ? { stack } : {}) };
}

function emit(text) {
  if (finished) return;
  printed++;
  const size = Buffer.byteLength(text, "utf8") + 1;
  if (outputBytes + size > maxOutputBytes) {
    droppedBytes += size;
    return;
  }
  outputBytes += size;
  parentPort.postMessage({ type: "output", text });
}

// A cell has no timers or I/O. Once its microtasks drain with no host call
// pending, nothing can ever resume it.
function checkStall() {
  setImmediate(() => {
    if (!finished && pending.size === 0) finish({ type: "error", kind: "stalled" });
  });
}

function hostCall(type, name, argsJSON) {
  return new Promise((resolve) => {
    let args;
    try {
      args = JSON.parse(argsJSON);
    } catch {
      resolve(JSON.stringify(failure("cave_program_arguments_not_json")));
      return;
    }
    const id = nextCallId++;
    pending.set(id, resolve);
    try {
      parentPort.postMessage({ type, id, name, args });
    } catch (error) {
      pending.delete(id);
      resolve(JSON.stringify(failure(error instanceof Error ? error.message : String(error))));
    }
  });
}

// Cell frames only, without the wrapper's closing line. A syntax error keeps
// its source line and caret instead.
function errorFrames(stack, code) {
  if (/^cell\.js:\d+\n/.test(stack)) return stack.split("\n").slice(0, 3).join("\n").trimEnd();
  const wrapper = "cell.js:" + (code.split("\n").length + 1) + ":";
  return stack.split("\n").filter((line) => line.includes("cell.js:") && !line.includes(wrapper))
    .slice(0, 4).map((line) => line.trim()).join("\n");
}

parentPort.on("message", (message) => {
  if (message.type === "tool.result") {
    const resolve = pending.get(message.id);
    if (resolve === undefined) return;
    pending.delete(message.id);
    resolve(JSON.stringify(message.ok
      ? { ok: true, value: message.value }
      : failure(message.error)));
    checkStall();
    return;
  }
  if (message.type === "run") void run(message);
});

function run(message) {
  maxOutputBytes = message.maxOutputBytes;
  const fail = (text, stack) => finish({
    type: "error",
    error: typeof text === "string" ? text : "cave_program_error_unreadable",
    stack: errorFrames(typeof stack === "string" ? stack : "", message.code),
  });
  // Completion arrives as primitives through a bridge. The Worker realm never
  // awaits a guest promise, so guest-patched then() never sees Worker functions.
  const doneBridge = (ok, text, stack) => {
    if (ok !== true) {
      fail(text, stack);
      return;
    }
    if (printed === 0 && typeof text === "string") emit(text);
    finish({ type: "done" });
  };
  const callBridge = (type, name, argsJSON) => typeof name === "string" && typeof argsJSON === "string"
    ? hostCall(type === "discover" ? "discover" : "tool.call", name, argsJSON)
    : Promise.resolve(JSON.stringify(failure("cave_program_bridge_protocol_invalid")));
  const printBridge = (value) => emit(typeof value === "string" ? value : "[unprintable]");
  for (const bridge of [callBridge, printBridge, doneBridge]) {
    Object.setPrototypeOf(bridge, null);
    Object.freeze(bridge);
  }
  const sandbox = Object.assign(Object.create(null), {
    __cave_call: callBridge,
    __cave_print: printBridge,
    __cave_done: doneBridge,
  });
  const context = vm.createContext(sandbox, {
    name: "caveman-programmatic-tools",
    codeGeneration: { strings: false, wasm: false },
  });
  let lifecycle;

  try {
    const bootstrapSource =
      '(() => {' +
      '  "use strict";' +
      '  const bridge = globalThis.__cave_call;' +
      '  const emit = globalThis.__cave_print;' +
      '  const done = globalThis.__cave_done;' +
      '  for (const name of ["__cave_call", "__cave_print", "__cave_done"]) Reflect.deleteProperty(globalThis, name);' +
      '  const promiseThen = Promise.prototype.then;' +
      '  Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: false, configurable: false });' +
      '  Reflect.deleteProperty(Atomics, "waitAsync");' +
      '  Reflect.deleteProperty(globalThis, "FinalizationRegistry");' +
      '  const TOOLS = ' + JSON.stringify(message.tools) + ';' +
      '  const GLOBALS = ' + JSON.stringify(message.globals) + ';' +
      '  const HINT = "ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.";' +
      '  const names = TOOLS.map((entry) => entry.name);' +
      '  const calls = [];' +
      '  const format = (value) => {' +
      '    if (typeof value === "string") return value;' +
      '    const encoded = JSON.stringify(value);' +
      '    return encoded === undefined ? String(value) : encoded;' +
      '  };' +
      '  const print = (...values) => emit(values.map(format).join(" "));' +
      '  const comparable = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");' +
      '  const closeMatches = (wanted, loose) => {' +
      '    const key = comparable(wanted);' +
      '    if (key === "") return [];' +
      '    const exact = names.filter((name) => comparable(name) === key);' +
      '    return (exact.length > 0 || !loose ? exact : names.filter((name) =>' +
      '      comparable(name).includes(key) || key.includes(comparable(name)))).slice(0, 5);' +
      '  };' +
      '  const toolFunction = (name) => (args) => {' +
      '    const promise = (async () => {' +
      '      const envelope = JSON.parse(await bridge("tool", name, JSON.stringify(args === undefined ? null : args)));' +
      '      if (envelope === null || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {' +
      '        throw new Error("cave_program_bridge_protocol_invalid");' +
      '      }' +
      '      if (!envelope.ok) {' +
      '        throw new Error(typeof envelope.error === "string" ? envelope.error : "cave_program_tool_failed");' +
      '      }' +
      '      return envelope.value;' +
      '    })();' +
      '    const record = { promise, observed: false };' +
      '    calls.push(record);' +
      '    void promise.catch(() => undefined);' +
      '    const thenable = Object.create(null);' +
      '    Object.defineProperty(thenable, "then", { value: (yes, no) => {' +
      '      if (typeof no === "function") record.observed = true;' +
      '      return promise.then(yes, no);' +
      '    } });' +
      '    Object.defineProperty(thenable, "catch", { value: (no) => {' +
      '      if (typeof no === "function") record.observed = true;' +
      '      return promise.catch(no);' +
      '    } });' +
      '    Object.defineProperty(thenable, "finally", { value: (done) => promise.finally(done) });' +
      '    Object.defineProperty(thenable, Symbol.toStringTag, { value: "Promise" });' +
      '    return Object.freeze(thenable);' +
      '  };' +
      '  const discover = (name) => async (...args) => {' +
      '    const envelope = JSON.parse(await bridge("discover", name, JSON.stringify(args)));' +
      '    if (envelope === null || typeof envelope !== "object" || envelope.ok !== true) {' +
      '      throw new Error(envelope !== null && typeof envelope === "object" && typeof envelope.error === "string"' +
      '        ? envelope.error : "cave_program_bridge_protocol_invalid");' +
      '    }' +
      '    return envelope.value === null ? undefined : envelope.value;' +
      '  };' +
      '  const exposed = Object.create(null);' +
      '  for (const name of names) {' +
      '    Object.defineProperty(exposed, name, { value: toolFunction(name), enumerable: true });' +
      '  }' +
      '  Object.freeze(exposed);' +
      '  const tools = new Proxy(exposed, { get(target, property, receiver) {' +
      '    if (typeof property !== "string" || property in target || property in Object.prototype ||' +
      '        property === "then" || property === "toJSON") {' +
      '      return Reflect.get(target, property, receiver);' +
      '    }' +
      '    const close = closeMatches(property, true);' +
      '    let text = "tools." + property + " does not exist.";' +
      '    if (close.length > 0) text += " Did you mean " + close.map((name) => "tools." + name).join(", ") + "?";' +
      '    else if (names.length <= 20) text += " Available: " + names.join(", ") + ".";' +
      '    throw new TypeError(text + " " + HINT);' +
      '  } });' +
      '  const consoleValue = Object.create(null);' +
      '  for (const level of ["log", "info", "warn", "error", "debug"]) {' +
      '    Object.defineProperty(consoleValue, level, { value: print, enumerable: true });' +
      '  }' +
      '  const builtins = {' +
      '    tools, print, console: Object.freeze(consoleValue),' +
      '    ALL_TOOLS: Object.freeze(TOOLS.map((entry) => Object.freeze(entry))),' +
      '    searchTools: discover("searchTools"),' +
      '    describeTool: discover("describeTool"),' +
      '    describeNamespace: discover("describeNamespace"),' +
      '  };' +
      '  for (const [name, value] of Object.entries(builtins)) {' +
      '    Object.defineProperty(globalThis, name, { value, enumerable: true });' +
      '  }' +
      '  for (const name of GLOBALS) {' +
      '    if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value: exposed[name], enumerable: true });' +
      '  }' +
      '  const hint = (message) => {' +
      '    const unknown = /^([A-Za-z_$][\\w$]*) is not defined$/.exec(message);' +
      '    const close = unknown === null ? [] : closeMatches(unknown[1], false)' +
      '      .map((match) => GLOBALS.includes(match) ? match : "tools." + match);' +
      '    return close.length === 0 ? message : message + ". Did you mean " + close.join(", ") + "? " + HINT;' +
      '  };' +
      '  const drain = async () => {' +
      '    let cursor = 0;' +
      '    let firstUnobservedFailure;' +
      '    while (cursor < calls.length) {' +
      '      const batch = calls.slice(cursor);' +
      '      cursor = calls.length;' +
      '      const outcomes = await Promise.allSettled(batch.map((record) => record.promise));' +
      '      for (let index = 0; index < outcomes.length; index++) {' +
      '        const outcome = outcomes[index];' +
      '        if (outcome.status === "rejected" && !batch[index].observed && firstUnobservedFailure === undefined) {' +
      '          firstUnobservedFailure = outcome.reason;' +
      '        }' +
      '      }' +
      '    }' +
      '    if (firstUnobservedFailure !== undefined) throw firstUnobservedFailure;' +
      '  };' +
      '  const fail = (error) => {' +
      '    let message = "cave_program_error_unreadable";' +
      '    let stack = "";' +
      '    try {' +
      '      const object = error !== null && typeof error === "object";' +
      '      message = hint(object && typeof error.message === "string" ? error.message : String(error));' +
      '      stack = object && typeof error.stack === "string" ? error.stack : "";' +
      '    } catch {}' +
      '    done(false, typeof message === "string" ? message : "cave_program_error_unreadable",' +
      '      typeof stack === "string" ? stack : "");' +
      '  };' +
      '  const settle = (promise) => {' +
      '    try {' +
      '      promiseThen.call(promise, (value) => promiseThen.call(drain(), () => {' +
      '        let text;' +
      '        try {' +
      '          text = value === undefined ? undefined : format(value);' +
      '        } catch (error) {' +
      '          fail(error);' +
      '          return;' +
      '        }' +
      '        done(true, typeof text === "string" ? text : undefined);' +
      '      }, fail), fail);' +
      '    } catch (error) {' +
      '      fail(error);' +
      '    }' +
      '  };' +
      '  return Object.freeze({ settle });' +
      '})()';
    // The bootstrap is one line: no // comments inside it. Unknown globals
    // match tool names exactly (bash_result is a variable, not a typo);
    // unknown tools.X members also match by substring, as in Pi.
    lifecycle = new vm.Script(bootstrapSource, { filename: "caveman-code-bootstrap.js" })
      .runInContext(context, { timeout: message.syncTimeoutMs });
  } catch {
    fail("cave_program_bootstrap_failed", "");
    return;
  }
  let script;
  try {
    // The prefix shares the first line, so reported line numbers match the cell.
    script = new vm.Script(
      '(async () => { "use strict"; ' + message.code + '\n})()',
      { filename: "cell.js", displayErrors: false },
    );
  } catch (error) {
    fail(...describeWorkerError(error, message.syncTimeoutMs));
    return;
  }
  let returned;
  try {
    returned = script.runInContext(context, {
      timeout: message.syncTimeoutMs,
      displayErrors: false,
    });
  } catch (error) {
    fail(...describeWorkerError(error, message.syncTimeoutMs));
    return;
  }
  checkStall();
  lifecycle.settle(returned);
}

// Compile errors are Worker-realm. The vm builds its timeout error inside the
// guest context, so only one own data property is read there, never a getter;
// any other guest value thrown past the wrapper is not inspected at all.
function describeWorkerError(error, syncTimeoutMs) {
  if (error instanceof Error) return [String(error.message), typeof error.stack === "string" ? error.stack : ""];
  const code = error !== null && typeof error === "object" && !isProxy(error)
    ? Reflect.getOwnPropertyDescriptor(error, "code")
    : undefined;
  return code !== undefined && code.value === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    ? ["Script execution timed out after " + syncTimeoutMs + "ms", ""]
    : ["cave_program_cell_threw_non_error", ""];
}
`;
