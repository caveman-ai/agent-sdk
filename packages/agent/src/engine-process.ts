/**
 * One `caveman-engine` subprocess: allow-listed environment, a wall-clock
 * ceiling, the caller's signal, and the whole process group killed on abort.
 */
import { spawn } from "node:child_process";
import { portableInvocation } from "./portable-process.js";
import { killSandboxProcess } from "./sandbox/worker-transport.js";

/** Default wall-clock ceiling for one engine subprocess. */
const ENGINE_TIMEOUT_MS = 30_000;

/**
 * The allow-listed environment the engine subprocess starts from.
 *
 * A compression engine never needs provider or account credentials, so the
 * parent's full environment — ANTHROPIC_API_KEY, CAVE_API_KEY, AWS_*, … — is
 * withheld. Namespace prefixes are not safe allowlists: Caveman also uses
 * `CAVEMAN_API_KEY`, `CAVEMAN_MCP_TOKEN`, and session-key variables. Pass only
 * exact configuration names read by Engine (plus test fixture store var).
 */
export function buildEngineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const key of [
    // Portable process-launch baseline; none carries account/provider secrets.
    "ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE",
    "CAVEMAN_CCR_DB",
    "CAVEMAN_HOME",
    "CAVE_ENGINE_TOON",
    "CAVE_PIXEL_DENSITY",
    "CAVE_PIXEL_GPT_PROFILES",
    "CAVE_PIXEL_MODELS",
    "CAVE_FAKE_ENGINE_STORE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runEngine(
  engineBin: string | undefined,
  args: string[],
  input?: Uint8Array,
  signal?: AbortSignal,
): Promise<{ stdout: Uint8Array; stderr: string }> {
  const command = engineBin ?? process.env.CAVEMAN_ENGINE_BIN ?? "caveman-engine";
  // A hung engine must not run forever: a default timeout plus the caller's own
  // run/tool signal both terminate it, and the child is spawned detached so the
  // whole process group is killed, not just the direct child.
  const timeout = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((accept, reject) => {
    const env = buildEngineEnv();
    const invocation = portableInvocation(command, args, { env });
    const child = spawn(invocation.command, [...invocation.args], {
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let terminalError: Error | undefined;
    const cleanup = (): void => {
      combined.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const terminate = (error: Error, immediate = false): void => {
      terminalError ??= error;
      killSandboxProcess(child, immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate && killTimer === undefined) {
        killTimer = setTimeout(() => killSandboxProcess(child, "SIGKILL"), 250);
        killTimer.unref();
      }
    };
    function onAbort(): void {
      const reason = combined.reason;
      const isTimeout = reason instanceof DOMException && reason.name === "TimeoutError";
      terminate(isTimeout
        ? new Error("cave_engine_timeout")
        : (reason instanceof Error ? reason : new Error("cave_engine_aborted")));
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1024 * 1024) {
        terminate(new Error("engine_output_limit"), true);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`engine_exit_${code}:${Buffer.concat(stderr).toString("utf8").slice(0, 256)}`));
        return;
      }
      accept({
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
    // A child that died before draining stdin makes end() emit EPIPE; swallow it
    // so the real terminal error (timeout/exit) is what surfaces.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
