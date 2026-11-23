#!/usr/bin/env node
/**
 * Bundle the harness into one file: dist/harness.mjs (node >= 22, no npm
 * install on the host) plus dist/harness.mjs.sha256. Prints one JSON line:
 * the bundle's path, bytes and sha256. `--no-minify` for a readable bundle.
 */
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outfile = join(root, "dist", "harness.mjs");

// The exec surface's codemode worker (pi-codemode's worker entry, ~60 KB), embedded as text and started from a
// data: URL, so a cell's worker does not parse the whole bundle (src/tools/exec/codemode.ts).
const requireHere = createRequire(join(root, "package.json"));
const codemodeWorker = await build({
  entryPoints: [fileURLToPath(import.meta.resolve("@earendil-works/pi-codemode/worker"))],
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true, write: false, legalComments: "none", logLevel: "warning",
});

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Minified with names kept: 2.3 MB -> ~0.9 MB and ~6 ms faster cold start; stack traces still name functions.
  minify: !process.argv.includes("--no-minify"),
  keepNames: true,
  legalComments: "eof",
  logLevel: "warning",
  define: { HARNESS_VERSION: JSON.stringify(pkg.version), HARNESS_BUNDLE: "true" },
  plugins: [
    // The exec surface's QuickJS VM and its worker embedded (src/tools/exec/codemode.ts), so the bundle stays one file.
    {
      name: "quickjs-wasm",
      setup(plugin) {
        plugin.onResolve({ filter: /^harness:quickjs-wasm$/ }, () => ({ path: requireHere.resolve("quickjs-wasi/quickjs.wasm"), namespace: "quickjs-wasm" }));
        plugin.onLoad({ filter: /.*/, namespace: "quickjs-wasm" }, (args) => ({ contents: readFileSync(args.path), loader: "binary" }));
        plugin.onResolve({ filter: /^harness:codemode-worker$/ }, () => ({ path: "codemode-worker", namespace: "codemode-worker" }));
        plugin.onLoad({ filter: /.*/, namespace: "codemode-worker" }, () => ({ contents: codemodeWorker.outputFiles[0].text, loader: "text" }));
      },
    },
  ],
  // Bundled CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __harnessCreateRequire } from \"node:module\";\nconst require = __harnessCreateRequire(import.meta.url);" },
});

// The library (src/lib.ts, the product's entry): the same VM and worker embedded, no shebang.
const libfile = join(root, "dist", "lib.mjs");
await build({
  entryPoints: [join(root, "src", "lib.ts")],
  outfile: libfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  keepNames: true,
  // pi-ai is marked side-effect free, and three of its modules import each other in a circle (models, transcript,
  // identity): from this entry esbuild wrapped them lazily and then dropped every call that initializes them, so
  // pi-ai's module constants were undefined at run time (clampThinkingLevel threw on the first reasoning model).
  // Keeping the annotations' side effects keeps those calls. tests/lib-bundle.test.ts runs a turn on the bundle.
  ignoreAnnotations: true,
  legalComments: "eof",
  logLevel: "warning",
  define: { HARNESS_VERSION: JSON.stringify(pkg.version), HARNESS_BUNDLE: "true" },
  plugins: [
    {
      name: "quickjs-wasm",
      setup(plugin) {
        plugin.onResolve({ filter: /^harness:quickjs-wasm$/ }, () => ({ path: requireHere.resolve("quickjs-wasi/quickjs.wasm"), namespace: "quickjs-wasm" }));
        plugin.onLoad({ filter: /.*/, namespace: "quickjs-wasm" }, (args) => ({ contents: readFileSync(args.path), loader: "binary" }));
        plugin.onResolve({ filter: /^harness:codemode-worker$/ }, () => ({ path: "codemode-worker", namespace: "codemode-worker" }));
        plugin.onLoad({ filter: /.*/, namespace: "codemode-worker" }, () => ({ contents: codemodeWorker.outputFiles[0].text, loader: "text" }));
      },
    },
  ],
  banner: { js: "import { createRequire as __harnessCreateRequire } from \"node:module\";\nconst require = __harnessCreateRequire(import.meta.url);" },
});
copyFileSync(join(root, "types", "lib.d.ts"), join(root, "dist", "lib.d.ts"));

// A host's tests (`@caveman-ai/harness/testing`): the fake Caveman Cloud SandboxEnv's suites run against, so a host
// checks its wiring on the same semantics, never a copy. Not part of the library.
await build({
  entryPoints: [join(root, "tests", "sandbox-fake.ts")],
  outfile: join(root, "dist", "testing.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  logLevel: "warning",
});
copyFileSync(join(root, "types", "testing.d.ts"), join(root, "dist", "testing.d.ts"));

const sha = createHash("sha256").update(readFileSync(outfile)).digest("hex");
writeFileSync(`${outfile}.sha256`, `${sha}  harness.mjs\n`);
process.stdout.write(`${JSON.stringify({ outfile, bytes: statSync(outfile).size, sha256: sha })}\n`);
