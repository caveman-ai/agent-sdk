/** CLI-only parsing. Validate arguments before loading user code or opening a server. */
export function parseServeOptions(args: string[], env: NodeJS.ProcessEnv) {
  let directory: string | undefined;
  let portValue: string | undefined;
  let hostValue: string | undefined;
  let locked = false;
  let positionalOnly = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("-")) {
      const [name, ...parts] = argument.split("=");
      if (name !== "--port" && name !== "--host" && name !== "--locked") {
        throw new Error(`serve: unknown option ${argument}; run caveman-agent serve --help`);
      }
      if (seen.has(name)) throw new Error(`serve: ${name} may only be specified once`);
      seen.add(name);
      if (name === "--locked") {
        if (parts.length > 0) throw new Error("serve: --locked does not take a value");
        locked = true;
        continue;
      }
      const value = parts.length > 0 ? parts.join("=") : args[++index];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new Error(`serve: ${name} requires a value`);
      }
      if (name === "--port") portValue = value;
      else hostValue = value;
    } else {
      if (directory !== undefined) throw new Error("serve: expected at most one agent directory");
      directory = argument;
    }
  }
  const rawPort = portValue ?? env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("serve: --port must be an integer from 0 to 65535 (0 chooses an available port)");
  }
  const host = hostValue ?? env.HOST ?? "0.0.0.0";
  if (host.trim() === "") throw new Error("serve: --host must not be empty");
  return { directory: directory ?? ".", port, host, locked };
}

const COMMAND_HELP: Record<string, string[]> = {
  dev: [
    "caveman-agent dev [entry] [prompt]",
    "",
    "Run an agent file or an agent directory. Defaults to the current agent",
    "directory (instructions.md), otherwise src/agent.ts. With no prompt,",
    "opens an interactive session when attached to a terminal.",
    "",
    "Example: caveman-agent dev src/agent.ts \"Summarize this project\"",
  ],
  serve: [
    "caveman-agent serve [dir] [--port N] [--host H] [--locked]",
    "",
    "Serve authenticated sessions from an agent directory or its src/agent.ts.",
    "Set CAVE_SERVE_TOKEN to a bearer token of at least 16 characters.",
    "--port N    Listen on port N (default: PORT or 8080; 0 chooses a free port).",
    "--host H    Bind to host H (default: HOST or 0.0.0.0).",
    "--locked    Require the directory's validated build lock.",
    "",
    "Example: caveman-agent serve . --host 127.0.0.1 --port 8080",
  ],
  build: [
    "caveman-agent build [config] [--verbose] [--accept-prefix-shrink]",
    "",
    "Compile and evaluate candidates using caveman.config.ts by default.",
    "--verbose                 Include diagnostic codes in build output.",
    "--accept-prefix-shrink    Reset the frozen-prefix baseline after a",
    "                          successful build; no baseline is written if",
    "                          the build stops before producing a lock.",
  ],
  check: ["caveman-agent check [config]", "", "Validate the build lock against current inputs (default: caveman.config.ts)."],
  doctor: ["caveman-agent doctor [--json]", "", "Check local setup and show the next action. --json emits a machine-readable report."],
  register: ["caveman-agent register", "", "Choose a provider and model interactively; save project provider configuration."],
};

export function commandHasHelp(command: string): boolean {
  return Object.hasOwn(COMMAND_HELP, command);
}

export function printHelp(command?: string): void {
  const lines = command === undefined ? [
    "Caveman Agent — TypeScript agents with budgets, receipts, and durable sessions",
    "",
    "Usage:",
    ...Object.values(COMMAND_HELP).map((help) => `  ${help[0]}`),
    "  caveman-agent connect [provider|providers|connections|status|doctor|...]",
    "  caveman-agent --version",
    "",
    "Run caveman-agent <command> --help for options and examples.",
  ] : COMMAND_HELP[command]!;
  process.stdout.write(`${lines.join("\n")}\n`);
}
