#!/usr/bin/env node
// Fails CI if any public source, test, or doc leaks private Caveman repositories,
// private backend paths, local developer home paths, internal founder notes, or
// stray competitor chatter. Preserves LICENSE, NOTICE, and THIRD_PARTY_NOTICES.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.turbo', 'coverage', '__pycache__', '.pytest_cache']);
const KEEP_FILES = new Set(['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'pnpm-lock.yaml', 'package-lock.json', 'go.sum']);
const SKIP_REL = new Set(['scripts/check-public-hygiene.mjs']);

const FORBIDDEN = [
  ['private-repo', /\b(Caveman-Cloud|caveman-code-app|agent-sdk-private|caveman-site|caveman-model-research|caveman-v5-staging|caveman-org)\b/],
  ['private-path', /\b(cloud\/(?:control-api|gateway-managed|worker|computers|relay|harness|platform|agent-surface|internal)|deploy\/(?:firecracker|terraform|helm)|vendor\/caveman-ai-|docs\/(?:design|decisions|implementation)\/)\b/],
  ['local-home-path', /\/Users\/(?:julb|julius)\b/],
  ['internal-founder-note', /\((?:the\s+)?founder\b|\bfounder\s+(?:ruling|call|20\d\d)\b/i],
  ['competitor-chatter', /\b(Capy|MonoCode|Braintrust|LangSmith|Helicone|Portkey|PromptLayer|Humanloop|Daytona|E2B|Martian|Promptfoo|DeepEval|Ragas|langevals|Runloop|Blaxel|boat\.dev|pingdotgg\/t3code|t3code-ref)\b/i],
];

const failures = [];
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    const rel = relative(ROOT, full);
    if (ent.isDirectory()) { walk(full); continue; }
    if (KEEP_FILES.has(ent.name) || SKIP_REL.has(rel)) continue;
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|wasm|pdf|zip|gz|tgz|icns|svg|bin|lock)$/i.test(ent.name)) continue;
    let text;
    try {
      if (statSync(full).size > 1_200_000) continue;
      text = readFileSync(full, 'utf8');
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [label, re] of FORBIDDEN) {
        const m = re.exec(lines[i]);
        if (m) failures.push(`${rel}:${i + 1} [${label}] ${m[0]}`);
      }
    }
  }
}
walk(ROOT);

if (failures.length > 0) {
  console.error('PUBLIC HYGIENE CHECK FAILED:\n' + failures.slice(0, 40).map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: 'zero private repos/paths, zero local paths, zero founder notes, zero competitor chatter' }));
