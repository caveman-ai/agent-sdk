#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = resolve(root, ".cache/npm");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const fixedPackages = [
  "packages/agent",
  "packages/adapter-kit",
  "packages/adapter-conformance",
  "packages/coding-agent",
  "packages/create-caveman-agent",
  "packages/evals",
  "packages/pebble-protocol",
  "packages/react",
];
const adaptersRoot = resolve(root, "packages/adapters");
const adapterPackages = readdirSync(adaptersRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/adapters/${entry.name}`)
  .filter((packagePath) => existsSync(resolve(root, packagePath, "package.json")))
  .sort();
const packages = [...fixedPackages, ...adapterPackages];

function declaredBinPaths(manifest, packagePath) {
  if (typeof manifest.bin === "string") return [manifest.bin];
  if (manifest.bin === undefined) return [];
  if (manifest.bin === null || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
    throw new Error(`pack_check_bin_manifest_invalid:${packagePath}`);
  }
  return Object.values(manifest.bin);
}

/** Check the packed file list, not the checkout: ignored dist files can exist locally. */
export function assertPackedEntrypoints(manifest, files, packagePath) {
  if (!Array.isArray(files)) throw new Error(`pack_check_files_invalid:${packagePath}`);
  const packed = new Map(files.map((file) => [file.path, file]));
  const targets = [];
  function collect(value, field, isExport = false, pattern = false) {
    if (typeof value === "string") {
      if (isExport && !value.startsWith("./")) {
        throw new Error(`pack_check_entrypoint_invalid:${packagePath}:${field}:${value}`);
      }
      targets.push([field, value, pattern]);
    }
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        collect(child, `${field}.${key}`, isExport, isExport && key.startsWith(".") ? key.includes("*") : pattern);
      }
    } else if (value !== null && value !== undefined) {
      throw new Error(`pack_check_entrypoint_invalid:${packagePath}:${field}`);
    }
  }
  for (const field of ["main", "module", "types", "typings", "exports"]) {
    collect(manifest[field], field, field === "exports");
  }
  for (const [field, target, isPattern] of targets) {
    const path = target.replace(/^\.\//, "");
    if (path === "" || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`pack_check_entrypoint_invalid:${packagePath}:${field}:${target}`);
    }
    // Export patterns must match at least one shipped file. Literal targets must exist exactly.
    const pattern = isPattern
      ? new RegExp(`^${path.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
      : undefined;
    if (pattern === undefined ? !packed.has(path) : ![...packed.keys()].some((candidate) => pattern.test(candidate))) {
      throw new Error(`pack_check_entrypoint_missing:${packagePath}:${field}:${target}`);
    }
  }
  for (const rawBinPath of declaredBinPaths(manifest, packagePath)) {
    if (typeof rawBinPath !== "string" || rawBinPath.length === 0) {
      throw new Error(`pack_check_bin_manifest_invalid:${packagePath}`);
    }
    const binPath = rawBinPath.replace(/^\.\//, "");
    const packedBin = packed.get(binPath);
    if (packedBin === undefined) throw new Error(`pack_check_bin_missing:${packagePath}:${binPath}`);
    if (!Number.isSafeInteger(packedBin.mode) || (packedBin.mode & 0o111) === 0) {
      throw new Error(`pack_check_bin_not_executable:${packagePath}:${binPath}`);
    }
  }
}

const LOCAL_SPEC = /^(file:|link:|portal:|workspace:|\.{1,2}\/|\/)/;

function assertPublishableSpecs(packagePath) {
  const manifest = JSON.parse(readFileSync(resolve(root, packagePath, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && LOCAL_SPEC.test(spec)) {
        throw new Error(`pack_check_local_dependency:${packagePath}:${field}:${name}:${spec}`);
      }
    }
  }
}

function main() {
  mkdirSync(cache, { recursive: true });
  const packDestination = mkdtempSync(join(tmpdir(), "caveman-pack-check-"));
  try {
    for (const packagePath of packages) {
      assertPublishableSpecs(packagePath);
      const result = spawnSync(
        npm,
        ["pack", "--ignore-scripts", "--json", "--pack-destination", packDestination],
        {
          cwd: resolve(root, packagePath),
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: cache },
        },
      );
      process.stderr.write(result.stderr ?? "");
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const failure = result.signal ?? result.status ?? "unknown";
        throw new Error(`pack_check_command_failed:${packagePath}:${failure}`);
      }

      const records = JSON.parse(result.stdout);
      if (!Array.isArray(records) || records.length !== 1) {
        throw new Error(`pack_check_record_invalid:${packagePath}`);
      }
      const [{ filename, size }] = records;
      if (typeof filename !== "string" || filename !== basename(filename)) {
        throw new Error(`pack_check_filename_invalid:${packagePath}`);
      }
      const archive = resolve(packDestination, filename);
      if (!existsSync(archive) || statSync(archive).size !== size) {
        throw new Error(`pack_check_archive_invalid:${packagePath}`);
      }
      const manifest = JSON.parse(readFileSync(resolve(root, packagePath, "package.json"), "utf8"));
      assertPackedEntrypoints(manifest, records[0].files, packagePath);
      process.stdout.write(`pack-check: ${manifest.name} (${records[0].files.length} files, ${size} bytes)\n`);
    }
  } finally {
    rmSync(packDestination, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
