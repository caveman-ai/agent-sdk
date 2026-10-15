// Cave gateway discovery, identity verification, and local-runtime startup.
// Split out of runtime.ts: this is the network/process boundary in front of
// the run, and it shares no state with the agent loop.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { portableInvocation } from "./portable-process.js";

export type ResolvedCaveRoute = {
  readonly useGateway: boolean;
  /** Credential payer advertised by the identified gateway readiness response. */
  readonly providerBilling?: "managed" | "byok" | "unknown";
};

/** Environment for zero-payload runtime startup and ownership probes.
 * These subprocesses never need provider, account, deployment, or session
 * credentials. Their binaries may resolve from a package-script PATH, so a
 * spread of process.env would turn PATH shadowing into secret exfiltration. */
export function buildRuntimeControlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const key of [
    // Portable process-launch baseline.
    "ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE",
    // Exact local-runtime configuration. No credentials or session keys.
    "CAVEMAN_CCR_DB", "CAVEMAN_CONFIG", "CAVEMAN_HOME", "CAVEMAN_MCP",
    "CAVEMAN_MODE", "CAVEMAN_OFFLINE", "CAVEMAN_PLAIN", "CAVEMAN_PROXY_BIN",
    "CAVEMAN_RECOVERY", "CAVEMAN_SHRINK", "CAVEMAN_TELEMETRY", "CAVEMAN_TOON",
    "CAVEMAN_WRAP_MODE", "CAVE_ENGINE_TOON", "CAVE_GATEWAY_URL",
    "CAVE_PIXEL_DENSITY", "CAVE_PIXEL_GPT_PROFILES", "CAVE_PIXEL_MODELS",
    "CI", "DO_NOT_TRACK", "NO_COLOR", "TERM",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function resolveGatewayURL(explicit: string | undefined): string {
  return (explicit ?? process.env.CAVE_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

/** Health + ownership probe for diagnostics. Never starts anything. */
export async function caveGatewayReady(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  return (await runtimeReady(gatewayURL, fetchImpl)) !== undefined;
}

const observeOnlyAnnounced = new Set<string>();

// One line, on a terminal only. Library consumers read RunResult.mode instead of
// parsing stderr, and non-interactive pipelines stay clean.
function announceObserveOnly(gatewayURL: string): void {
  if (!process.stderr.isTTY) return;
  if (observeOnlyAnnounced.has(gatewayURL)) return;
  observeOnlyAnnounced.add(gatewayURL);
  process.stderr.write(
    "cave: observe-only — engine/gateway unavailable; transforms and gateway telemetry off; " +
    "provider usage and local context estimates remain available " +
    "(npm i -g @caveman-ai/cli && caveman start)\n",
  );
}

/**
 * Decide whether this run uses the gateway. Cold machines degrade to
 * observe-only instead of failing, but a run whose evidence depends on the
 * gateway (locked build or candidate plan) refuses to degrade silently.
 * `ensureRuntime: false` means the caller manages a loopback runtime, so startup
 * and ownership probing are skipped there. It never bypasses remote TLS and
 * identity checks: provider credentials must not be sent to an unverified host.
 */
export async function resolveCaveRoute(
  gatewayURL: string,
  options: {
    cave?: "auto" | "off" | "local";
    /** A locked Cave Build's evidence is the gateway's, so it never runs locally. */
    lockedBuild?: unknown;
    ensureRuntime?: boolean;
    fetch?: typeof globalThis.fetch;
    caveRoute?: ResolvedCaveRoute;
    /** Internal: resolve credential payer before authorizing a USD budget. */
    billingProofRequired?: boolean;
  },
  planPresent: boolean,
): Promise<ResolvedCaveRoute> {
  if (options.caveRoute !== undefined) {
    if (!options.billingProofRequired || !options.caveRoute.useGateway ||
        options.caveRoute.providerBilling === "managed" ||
        options.caveRoute.providerBilling === "byok") {
      return options.caveRoute;
    }
    const identity = await gatewayIdentity(gatewayURL, options.fetch ?? globalThis.fetch);
    return {
      ...options.caveRoute,
      providerBilling: identity?.providerBilling ?? "unknown",
    };
  }
  // `local` applies the plan in process with the local engine; nothing to route.
  if (options.cave === "local") {
    if (options.lockedBuild !== undefined) {
      throw new Error("cave_gateway_required_for_locked_plan: a locked Cave Build routes through the Caveman gateway");
    }
    return { useGateway: false, providerBilling: "unknown" };
  }
  if (options.cave === "off") {
    if (planPresent) {
      throw new Error(
        "cave_gateway_required_for_locked_plan: Cave Build execution routes through the Caveman gateway; run unlocked for observe-only",
      );
    }
    return { useGateway: false, providerBilling: "unknown" };
  }
  if (options.ensureRuntime === false) {
    try {
      const url = new URL(gatewayURL);
      if (isLoopbackHostname(url.hostname)) {
        // `ensureRuntime: false` means the caller owns the loopback runtime's
        // lifecycle, not that a runtime is there. Claiming `useGateway: true`
        // without asking would let a run report `optimized` against a port
        // nothing is listening on, so the reachability is probed — cheaply,
        // and bounded, because this sits in front of every run. Same memo as the
        // ensureRuntime path: N concurrent runs cost one probe, and a gateway
        // that is down costs one 250ms timeout per TTL window rather than one
        // per run. Its own cache key, because liveness must never be mistaken
        // for the stricter Caveman-identity result cached under the URL alone.
        await probeHealthz(gatewayURL, options.fetch);
        const providerBilling = options.billingProofRequired
          ? (await gatewayIdentity(gatewayURL, options.fetch ?? globalThis.fetch))?.providerBilling ??
            "unknown"
          : "unknown";
        return { useGateway: true, providerBilling };
      }
      // Remote gateways still have to prove Caveman identity. `ensureCaveRuntime`
      // never starts a process for non-loopback URLs; it only enforces HTTPS and
      // performs the content-blind ownership handshake.
      const providerBilling = await ensureCaveRuntime(
        gatewayURL,
        options.fetch ?? globalThis.fetch,
      );
      return { useGateway: true, providerBilling };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (planPresent) {
        throw new Error(`cave_gateway_required_for_locked_plan: ${reason}`);
      }
      announceObserveOnly(gatewayURL);
      return { useGateway: false, providerBilling: "unknown" };
    }
  }
  // Memoize the probe per gateway: a server embedding calls run()
  // per request, and re-probing — which can spawn `caveman start`/`status`
  // subprocesses — on every one is unusable at load. A short TTL with a negative
  // cache bounds it to one probe per window. The cache is keyed by URL and only
  // used with the DEFAULT transport; a caller-supplied `fetch` (a test seam or a
  // special transport) always probes fresh so it is never cross-contaminated.
  const useCache = options.fetch === undefined;
  const now = Date.now();
  if (useCache) {
    const cached = gatewayProbeCache.get(gatewayURL);
    if (cached !== undefined && now - cached.at < GATEWAY_PROBE_TTL_MS) {
      if (cached.ready) return { useGateway: true, providerBilling: cached.providerBilling };
      if (planPresent) {
        throw new Error(`cave_gateway_required_for_locked_plan: ${cached.reason}`);
      }
      return { useGateway: false, providerBilling: "unknown" };
    }
  }
  const probe = useCache
    ? await sharedGatewayProbe(gatewayURL)
    : await probeGateway(gatewayURL, options.fetch ?? globalThis.fetch);
  if (!probe.ready) {
    if (planPresent) {
      throw new Error(`cave_gateway_required_for_locked_plan: ${probe.reason}`);
    }
    announceObserveOnly(gatewayURL);
    return { useGateway: false, providerBilling: "unknown" };
  }
  return { useGateway: true, providerBilling: probe.providerBilling };
}

/**
 * Per-gateway completed-result memo plus in-flight coalescing. Bounds
 * `resolveCaveRoute` to one probe/start attempt per gateway under a cold
 * concurrent burst, then one refresh per {@link GATEWAY_PROBE_TTL_MS} window.
 * Caller-supplied transports bypass both maps.
 */
const GATEWAY_PROBE_TTL_MS = 5_000;
type GatewayProviderBilling = "managed" | "byok" | "unknown";
type GatewayProbe = {
  ready: boolean;
  reason: string;
  providerBilling: GatewayProviderBilling;
};
const gatewayProbeCache = new Map<string, GatewayProbe & { at: number }>();
const gatewayProbeInflight = new Map<string, Promise<GatewayProbe>>();

/**
 * Liveness only: is something answering at the gateway's `/healthz`? Identity
 * — that the something is a Caveman proxy — is a separate, stricter check
 * (`gatewayIdentity`) and is what a non-loopback gateway must pass. Throws so
 * the caller's existing degrade path reports it as observe-only.
 */
async function probeHealthz(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch | undefined,
): Promise<void> {
  const run = async (): Promise<GatewayProbe> => {
    let ok = false;
    try {
      const response = await (fetchImpl ?? globalThis.fetch)(`${gatewayURL}/healthz`, {
        signal: AbortSignal.timeout(250),
        redirect: "error",
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    return {
      ready: ok,
      reason: ok
        ? ""
        : `cave_gateway_unreachable: nothing answered ${gatewayURL}/healthz within 250ms`,
      providerBilling: "unknown",
    };
  };
  // A caller-supplied transport always probes fresh, exactly as the
  // `ensureRuntime` path does, so a test seam is never cross-contaminated.
  let probe: GatewayProbe;
  if (fetchImpl !== undefined) {
    probe = await run();
  } else {
    const key = `healthz ${gatewayURL}`;
    const cached = gatewayProbeCache.get(key);
    probe = cached !== undefined && Date.now() - cached.at < GATEWAY_PROBE_TTL_MS
      ? cached
      : await sharedProbe(key, run);
  }
  if (!probe.ready) throw new Error(probe.reason);
}

async function probeGateway(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<GatewayProbe> {
  try {
    const providerBilling = await ensureCaveRuntime(gatewayURL, fetchImpl);
    return { ready: true, reason: "", providerBilling };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      providerBilling: "unknown",
    };
  }
}

function sharedGatewayProbe(gatewayURL: string): Promise<GatewayProbe> {
  return sharedProbe(gatewayURL, () => probeGateway(gatewayURL, globalThis.fetch));
}

/** Memoize a completed probe under `key` and coalesce concurrent ones. */
function sharedProbe(key: string, run: () => Promise<GatewayProbe>): Promise<GatewayProbe> {
  const active = gatewayProbeInflight.get(key);
  if (active !== undefined) return active;

  const probe = run().then((result) => {
    gatewayProbeCache.set(key, { ...result, at: Date.now() });
    return result;
  });
  gatewayProbeInflight.set(key, probe);
  void probe.finally(() => {
    if (gatewayProbeInflight.get(key) === probe) {
      gatewayProbeInflight.delete(key);
    }
  });
  return probe;
}

export async function ensureCaveRuntime(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<GatewayProviderBilling> {
  const url = new URL(gatewayURL);
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback) {
    // A non-loopback gateway is never taken on faith: routing there sends the
    // provider credential plus every x-cave-* header to that host, so it must
    // prove Caveman identity before it gets any traffic. Plain http cannot
    // authenticate the peer at all, and an https host that fails the
    // /health/ready identity handshake is equally unverified — both fail
    // closed here so resolveCaveRoute degrades to observe-only passthrough.
    if (url.protocol !== "https:") {
      throw new Error(
        `cave_gateway_identity_unverified: non-loopback gateway ${gatewayURL} requires https`,
      );
    }
    const identity = await gatewayIdentity(gatewayURL, fetchImpl);
    if (identity !== undefined) return identity.providerBilling;
    throw new Error(
      `cave_gateway_identity_unverified: ${gatewayURL}/health/ready did not identify as caveman-proxy`,
    );
  }
  const readyBilling = await runtimeReady(gatewayURL, fetchImpl);
  if (readyBilling !== undefined) return readyBilling;

  const command = process.env.CAVEMAN_CLI_BIN ?? "caveman";
  let startupFailure: Error | undefined;
  const env = buildRuntimeControlEnv();
  let invocation;
  try {
    invocation = portableInvocation(command, ["start"], { env });
  } catch (error) {
    throw new Error(`caveman agent: Cave Runtime failed to start (${error instanceof Error ? error.message : String(error)})`);
  }
  const child = spawn(invocation.command, [...invocation.args], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.once("error", (error) => {
    startupFailure = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? new Error(
        "caveman agent: Caveman CLI not found; run npm install, then caveman setup --install",
      )
      : new Error(`caveman agent: Cave Runtime failed to start (${error.message})`);
  });
  child.once("exit", (code, signal) => {
    if (startupFailure !== undefined || code === 0) return;
    startupFailure = new Error(
      `caveman agent: Cave Runtime failed to start (caveman start exited ${signal ?? code}); run caveman setup --install`,
    );
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (startupFailure !== undefined) throw startupFailure;
    const startedBilling = await runtimeReady(gatewayURL, fetchImpl);
    if (startedBilling !== undefined) return startedBilling;
  }
  throw new Error(
    `caveman agent: Cave Runtime did not become ready at ${gatewayURL}; run caveman setup --install`,
  );
}

async function runtimeReady(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<GatewayProviderBilling | undefined> {
  const identity = await gatewayIdentity(gatewayURL, fetchImpl);
  if (identity === undefined) return undefined;
  return await localProxyOwned(new URL(gatewayURL)) ? identity.providerBilling : undefined;
}

// A gateway hostname is loopback only if the traffic can never leave the host.
// WHATWG URL returns IPv6 literals bracketed ("[::1]"), so both forms are
// checked; 127.0.0.0/8 and 0.0.0.0 all route to localhost and must not be
// treated as remote (nor as needing https).
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  if (hostname === "0.0.0.0") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

async function gatewayIdentity(
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ providerBilling: GatewayProviderBilling } | undefined> {
  try {
    // redirect: "error" — a verified identity must come from the host that was
    // asked, not one it forwards to; following a 3xx would let an attacker's
    // host bounce the probe to the real proxy and pass the handshake.
    const response = await fetchImpl(`${gatewayURL}/health/ready`, {
      signal: AbortSignal.timeout(500),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.ok !== true || record.service !== "caveman-proxy" ||
        record.schema !== "caveman.proxy.health.v1" ||
        !Number.isSafeInteger(record.adapters) || Number(record.adapters) <= 0) {
      return undefined;
    }
    const providerBilling = record.billing === "managed" || record.billing === "byok"
      ? record.billing
      : "unknown";
    return { providerBilling };
  } catch {
    return undefined;
  }
}

async function localProxyOwned(url: URL): Promise<boolean> {
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
  for (const binary of proxyBinaryCandidates()) {
    const state = await validatedProxyState(binary, port);
    if (state) return true;
  }
  return false;
}

export function proxyBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  home = process.env.CAVEMAN_HOME ?? resolve(homedir(), ".caveman"),
): string[] {
  if (process.env.CAVEMAN_PROXY_BIN) return [process.env.CAVEMAN_PROXY_BIN];
  const binary = platform === "win32" ? "caveman-proxy.exe" : "caveman-proxy";
  return [...new Set([resolve(home, "bin", binary), binary])];
}

async function validatedProxyState(binary: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const env = buildRuntimeControlEnv();
    const invocation = portableInvocation(binary, ["status", "--json", "--port", String(port)], { env });
    const child = spawn(invocation.command, [...invocation.args], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 2_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (stdout.reduce((total, value) => total + value.length, 0) > 8_192) {
        child.kill("SIGKILL");
        finish(false);
      }
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => {
      if (code !== 0) return finish(false);
      try {
        const state = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
        finish(
          (state.owner === "start" || state.owner === "wrap") &&
          state.port === port &&
          Number.isSafeInteger(state.pid) && Number(state.pid) > 0 &&
          typeof state.instance_token === "string" &&
          /^[0-9a-f]{32}$/.test(state.instance_token),
        );
      } catch {
        finish(false);
      }
    });
  });
}
