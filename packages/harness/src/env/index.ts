import { DockerEnv } from "./docker.ts";
import { currentUser, LocalEnv } from "./local.ts";
import { parseEnvSpec, type ExecEnv } from "./types.ts";

export type { DirEntry, ExecEnv, ExecOptions, ExecResult, FileStat, ReadRange, EnvSpec } from "./types.ts";
export { parseEnvSpec } from "./types.ts";
export { LocalEnv } from "./local.ts";
export { DockerEnv } from "./docker.ts";
export { SandboxEnv, type SandboxEnvOptions, type SandboxEvent } from "./sandbox.ts";
export { loadEnvVars, parseEnvVars } from "./vars.ts";

export interface CreateEnvOptions {
  /** Variables for every command (the image's Config.Env, from --env-file / --env-json). */
  vars?: Record<string, string>;
  /** The user commands run as (docker: default the container's user; the connect fails if they run as anyone else). */
  user?: string;
}

/**
 * The user commands run as: --user, else HARNESS_DOCKER_USER (docker envs), which the rig sets to Harbor's agent
 * user; undefined leaves the env's default (docker the container's user, local this host's user).
 */
export function commandUser(spec: string, flag: string | undefined, environ: NodeJS.ProcessEnv = process.env): string | undefined {
  if (flag !== undefined) return flag;
  const rig = spec.startsWith("docker:") ? environ.HARNESS_DOCKER_USER : undefined;
  return rig !== undefined && rig !== "" ? rig : undefined;
}

/**
 * Build the env a `--env` spec names: `local:<cwd>` or `docker:<container>:<cwd>` (a running container on this host's
 * docker). Caveman runs agents only in its own sandboxes; there is no third-party sandbox env.
 */
export async function createEnv(spec: string, options: CreateEnvOptions = {}): Promise<ExecEnv> {
  const parsed = parseEnvSpec(spec);
  const vars = options.vars ?? {};
  if (parsed.kind === "local") {
    // Local commands run as this host's user; a run that asked for another must not silently run as it.
    if (options.user !== undefined && options.user !== currentUser()) {
      throw new Error(`env: local commands run as ${JSON.stringify(currentUser())}; user ${JSON.stringify(options.user)} needs a docker env`);
    }
    const env = new LocalEnv({ cwd: parsed.cwd, env: vars });
    const info = await env.stat(".");
    if (info?.kind !== "directory") throw new Error(`env: local cwd ${parsed.cwd} is not a directory`);
    return env;
  }
  return await DockerEnv.connect({ container: parsed.container, cwd: parsed.cwd, env: vars, ...(options.user === undefined ? {} : { user: options.user }) });
}
