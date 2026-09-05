import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localExecutionBackend, type ExecRequest, type ExecutionBackend } from "@caveman-ai/agent";

const DOCKER = process.env.MINI_SWE_DOCKER ?? "docker";
/** What the docker CLI itself needs to find the daemon. Explicit, never the whole environment. */
const CLI_ENV: Record<string, string> = Object.fromEntries(
  ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]
    .flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);
const docker = (args: string[], timeout: number) =>
  promisify(execFile)(DOCKER, args, { env: CLI_ENV, timeout });

/** `docker exec` argv for one request. Pure, so the test can check it without Docker. */
export function dockerExecArgs(container: string, request: ExecRequest): string[] {
  return [
    "exec", "-w", request.cwd,
    ...Object.entries(request.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    container, request.command, ...request.args,
  ];
}

/**
 * The one-line sandbox swap: every `bash` call becomes `docker exec` in a
 * container started from `image`. The container is removed on `close()`.
 */
export async function dockerBackend(image: string): Promise<ExecutionBackend> {
  const { stdout } = await docker(["run", "-d", "--rm", image, "sleep", "2h"], 600_000); // pull can be slow
  const container = stdout.trim();
  const local = localExecutionBackend();
  return {
    id: `docker:${container.slice(0, 12)}`,
    exec: (request) => local.exec({
      ...request,
      command: DOCKER,
      args: dockerExecArgs(container, request),
      cwd: process.cwd(),
      env: CLI_ENV,
    }),
    readFile: () => Promise.reject(new Error("mini-swe: use bash")),
    writeFile: () => Promise.reject(new Error("mini-swe: use bash")),
    close: async () => { await docker(["rm", "-f", container], 60_000).catch(() => undefined); },
  };
}
