/**
 * `@caveman-ai/harness/testing`: the fake Caveman Cloud SandboxEnv's suites run against (tests/sandbox-fake.ts). It
 * answers the sandbox API's REST calls and the relay's exec and files streams as the API, the relay and the fleet's
 * guest agent do, running real processes and touching real files on this host: for a host's tests only.
 */
export interface FakeComputer {
  id: string;
  size: string;
  desired_state: "running" | "suspended" | "deleted";
  observed_state: string;
  sleep_after_seconds: number;
  idle: { pause_after_seconds: number };
  network?: string;
  /** On resume, this file gets a new boot id (a sleep that kept the disk alone). */
  bootFile?: string;
  /** Streams open to it now. */
  streams: number;
}
export interface FakeState {
  computers: Map<string, FakeComputer>;
  creates: { body: Record<string, unknown>; idempotencyKey: string | undefined }[];
  /** Every request: `METHOD path`, streams as `WS path`. */
  requests: string[];
  /** The next stream opens are refused with these, in order. */
  refuse: { status: number; code: string; retryAfter?: number }[];
  /** The next create is refused with this (details: the error's, as cave_code_session_computer_exists carries computer_id). */
  createRefusal?: { status: number; code: string; message: string; details?: Record<string, unknown> } | undefined;
  open: number;
  maxOpen: number;
  errors: string[];
}
/**
 * `options.workspace`: a folder on this host standing for every computer's /workspace (commands' cwd and arguments,
 * file paths). `options.host`: the origin standing for the host's local address (http://172.16.0.1:47483) in a
 * command's arguments, as `startGitLane` serves the git lane. Commands get a home of their own.
 */
export declare function startSandboxFake(key?: string, options?: { workspace?: string; host?: string }): Promise<{
  url: string;
  key: string;
  state: FakeState;
  /** The folder on this host every command gets as its home (the guest's /home/tools). */
  home: string;
  makeComputer(body?: Record<string, unknown>): FakeComputer;
  close(): Promise<void>;
}>;
/**
 * A fake of the host's git lane: git's smart HTTP at /git/v1/<owner>/<name>.git for the repositories made here, no
 * credential asked, pushes to caveman/* branches only and no deletes.
 */
export declare function startGitLane(): Promise<{
  /** The origin that stands for http://172.16.0.1:47483 (startSandboxFake's `host`). */
  url: string;
  root: string;
  /** A bare repository with `files` on main and, for another `branch`, that branch one commit past it (its BRANCH file). */
  makeRepository(owner: string, name: string, files: Record<string, string>, branch?: string): Promise<string>;
  /** The repository's branches: name -> commit subject. */
  branches(owner: string, name: string): Promise<Record<string, string>>;
  close(): Promise<void>;
}>;
