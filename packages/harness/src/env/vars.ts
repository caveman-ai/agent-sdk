/**
 * Environment variables for an env's commands, from the command line: the
 * task image's Config.Env (the rig's image_env.py prints it as a JSON object)
 * or a dotenv-style file. A sandbox built from an image's filesystem loses the
 * image's ENV (PATH to a venv or toolchain, GOWORK, ...); this puts it back.
 * Per-task rig data, so it is a CLI input, not part of the loadout (and its hash).
 */
import { readFileSync } from "node:fs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function checked(entries: [string, unknown][], label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!NAME.test(key)) throw new Error(`${label}: bad variable name ${JSON.stringify(key)}`);
    if (typeof value !== "string") throw new Error(`${label}: ${key} must be a string`);
    out[key] = value;
  }
  return out;
}

/** A JSON object of strings, or KEY=VALUE lines (`#` comments, optional `export `, one level of quotes). */
export function parseEnvVars(text: string, label = "env vars"): Record<string, string> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}: want a JSON object`);
    return checked(Object.entries(parsed), label);
  }
  const entries: [string, string][] = [];
  for (const raw of trimmed.split(/\r?\n/u)) {
    const line = raw.trim().replace(/^export\s+/u, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`${label}: want KEY=VALUE, got ${JSON.stringify(raw)}`);
    let value = line.slice(eq + 1);
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    entries.push([line.slice(0, eq), value]);
  }
  return checked(entries, label);
}

/** `--env-file` then `--env-json` (later wins). */
export function loadEnvVars(file: string | undefined, json: string | undefined): Record<string, string> {
  const fromFile = file === undefined ? {} : parseEnvVars(readFileSync(file, "utf8"), `--env-file ${file}`);
  if (json !== undefined && !json.trim().startsWith("{")) throw new Error("--env-json: want a JSON object");
  const fromJson = json === undefined ? {} : parseEnvVars(json, "--env-json");
  return { ...fromFile, ...fromJson };
}
