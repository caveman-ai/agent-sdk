/**
 * Saved scripts (ARCHITECTURE.md 3.5): a program the model saved under a name, with a description and named
 * parameters, so a task that recurs runs it again instead of working it out again. Scripts live on the host in one
 * directory (`--scripts-dir`: in the product, the person's or the repo's store), one JSON file each; the program tool
 * lists them in its description (read once at run start, so the prefix is fixed for the run) and runs them inside any
 * program with `run_script(name, params)`, in the same isolate and with the same functions as the program.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SavedScript {
  name: string;
  description: string;
  /** Parameter name -> what it means. */
  params: Record<string, string>;
  /** The body of `async (params) => { ... }`. */
  code: string;
  saved_at: string;
}

export const SCRIPT_NAME = /^[a-z][a-z0-9_]{0,47}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a value is not a script to save, or undefined when it is one. */
export function scriptProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "want {name, description, params, code}";
  if (typeof value.name !== "string" || !SCRIPT_NAME.test(value.name)) return "`name` must match [a-z][a-z0-9_]{0,47}";
  if (typeof value.description !== "string" || value.description.trim() === "") return "`description` must say what the script does";
  if (value.params !== undefined && (!isRecord(value.params) || !Object.values(value.params).every((item) => typeof item === "string"))) {
    return "`params` must map each parameter name to what it means";
  }
  if (typeof value.code !== "string" || value.code.trim() === "") return "`code` must be the body of an async function of `params`";
  return undefined;
}

export class ScriptStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  /** Every saved script in name order; a file that isn't a valid script is skipped. */
  list(): SavedScript[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const scripts: SavedScript[] = [];
    for (const file of names) {
      try {
        const value: unknown = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
        if (scriptProblem(value) === undefined && `${(value as SavedScript).name}.json` === file) scripts.push(value as SavedScript);
      } catch {
        /* skipped */
      }
    }
    return scripts;
  }

  /** Saves (or replaces) a script; written whole, then renamed into place. */
  save(script: Omit<SavedScript, "saved_at">): SavedScript {
    const saved: SavedScript = { name: script.name, description: script.description.trim(), params: script.params ?? {}, code: script.code, saved_at: new Date().toISOString() };
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${saved.name}.json`);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(saved, null, 1)}\n`);
    renameSync(`${path}.tmp`, path);
    return saved;
  }
}
