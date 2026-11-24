import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { agentFileText, type AgentDefinition } from "./agent.ts";

export interface AgentBuildFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AgentBuildManifest {
  readonly schema_version: 1;
  readonly name: string;
  readonly description?: string;
  readonly engine: "caveman" | "claude-agent" | "codex";
  readonly model?: string;
  readonly computer: "none" | "readonly" | "code" | "linux";
  readonly files: ReadonlyArray<AgentBuildFile>;
}

export interface AgentBuildResult {
  readonly manifest: AgentBuildManifest;
  readonly manifestJson: string;
  readonly digest: string;
  readonly totalBytes: number;
}

const sha256 = (buf: Uint8Array | string) => createHash("sha256").update(buf).digest("hex");
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Compiles an in-code AgentDefinition to a deterministic agent.json build + SHA-256 digest. */
export function compileAgentDefinition(def: AgentDefinition): AgentBuildResult {
  const md = agentFileText(def);
  const mdBytes = Buffer.from(md, "utf8");
  const computer = def.computer === "full" ? "linux" : (def.computer ?? "none");
  const manifest: AgentBuildManifest = {
    schema_version: 1,
    name: def.name ?? "agent",
    ...(def.description ? { description: def.description } : {}),
    engine: "caveman",
    ...(def.model ? { model: def.model } : {}),
    computer,
    files: [{ path: "AGENT.md", bytes: mdBytes.byteLength, sha256: sha256(mdBytes) }],
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  return {
    manifest,
    manifestJson,
    digest: sha256(manifestJson),
    totalBytes: mdBytes.byteLength,
  };
}

/** Compiles an agent directory (containing AGENT.md, skills/, agents/, evals/) deterministically. */
export function compileAgentFolder(dirPath: string): AgentBuildResult {
  const root = resolve(dirPath);
  const entry = join(root, "AGENT.md");
  if (!existsSync(entry)) throw new Error(`Missing AGENT.md in ${root}`);

  const files: Array<AgentBuildFile> = [];
  let totalBytes = 0;
  const walk = (dir: string, prefix = "") => {
    const names = readdirSync(dir).sort(bytewise);
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Symlink refused in agent build: ${rel}`);
      if (st.isDirectory()) {
        if (["skills", "agents", "evals"].includes(rel.split("/")[0])) walk(full, rel);
        continue;
      }
      if (rel === "AGENT.md" || rel.startsWith("skills/") || rel.startsWith("agents/") || rel.startsWith("evals/")) {
        const bytes = readFileSync(full);
        totalBytes += bytes.byteLength;
        files.push({ path: rel, bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  };
  walk(root);
  files.sort((a, b) => bytewise(a.path, b.path));

  const mdText = readFileSync(entry, "utf8");
  const nameMatch = mdText.match(/^name:\s*["']?([^"'\n]+)["']?/m);
  const modelMatch = mdText.match(/^model:\s*["']?([^"'\n]+)["']?/m);
  const compMatch = mdText.match(/^computer:\s*["']?([^"'\n]+)["']?/m);
  const rawComp = compMatch?.[1]?.trim();
  const computer = rawComp === "none" || rawComp === "readonly" || rawComp === "code" ? rawComp : "linux";

  const manifest: AgentBuildManifest = {
    schema_version: 1,
    name: nameMatch?.[1]?.trim() || basename(root),
    engine: "caveman",
    ...(modelMatch?.[1]?.trim() ? { model: modelMatch[1].trim() } : {}),
    computer,
    files,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  return { manifest, manifestJson, digest: sha256(manifestJson), totalBytes };
}
