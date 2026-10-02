#!/usr/bin/env node
/**
 * License lint for the open Caveman Agent SDK monorepo.
 *
 * Verifies that every directory carrying shipped code has a LICENSE file whose
 * detected license type matches its classification in LICENSING.md, and that
 * no package directory escapes classification entirely. Zero dependencies;
 * plain Node built-ins only.
 *
 * Usage:
 *   node scripts/license-lint.mjs [rootDir]
 *
 * Exit codes: 0 = all existing classified directories conform; nonzero =
 * offenders listed on stderr.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** License types the linter can detect in a LICENSE file's text. */
const KNOWN_TYPES = /** @type {const} */ ([
  'Apache-2.0',
  'MIT',
  'BSL-1.1',
  'Commercial-EULA',
]);

/** Directory names never descended into while walking for package dirs. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist']);

/** Non-shipped package.json locations (test fixtures, scaffolding templates). */
const NON_PACKAGE_DIRS = new Set([
  'tests',
  'test',
  '__tests__',
  'fixtures',
  '__fixtures__',
  'testdata',
  'templates',
]);

/**
 * Parse the "Per-Directory License" markdown table into classification rows.
 * Only machine-readable rows (` | `<path>` ` | `<type>` ` | ...`) survive;
 * headers and separator rows are dropped.
 *
 * @param {string} markdown - Full text of LICENSING.md.
 * @returns {{ path: string, license: string }[]}
 */
export function parseLicensingTable(markdown) {
  /** @type {{ path: string, license: string }[]} */
  const rows = [];
  for (const rawLine of String(markdown ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    const [pathCell, licenseCell] = cells;
    if (/^:?-{3,}:?$/.test(pathCell)) continue;
    const p = pathCell.replaceAll('`', '').trim().replace(/\/+$/, '');
    const lic = licenseCell.replaceAll('`', '').trim();
    if (!p || !lic || p.toLowerCase() === 'path') continue;
    rows.push({ path: p, license: lic });
  }
  return rows;
}

/**
 * Detect the license type from the canonical text of a LICENSE file.
 * Detection order matters: Apache first (its full text mentions many words),
 * then anchored MIT, then BSL, then a commercial/EULA head scan.
 *
 * @param {string} text - Raw contents of a LICENSE file.
 * @returns {(typeof KNOWN_TYPES)[number] | null} Detected type, or null when unrecognizable.
 */
export function detectLicenseType(text) {
  const t = String(text ?? '');
  if (/Apache License/.test(t) && /Version 2\.0,\s*January 2004/.test(t)) {
    return 'Apache-2.0';
  }
  if (/^\s*MIT License\b/im.test(t.slice(0, 400))) {
    return 'MIT';
  }
  if (/Business Source License/i.test(t)) {
    return 'BSL-1.1';
  }
  if (/\bcommercial\b|\bEULA\b/i.test(t.slice(0, 600))) {
    return 'Commercial-EULA';
  }
  return null;
}

/**
 * Map a LICENSING.md license cell onto the set of acceptable detected types.
 *
 * @param {string} cell - License label from a table row.
 * @returns {(typeof KNOWN_TYPES)[number][] | null} Accepted types, or null for unrecognized labels.
 */
function acceptedTypesFor(cell) {
  const normalized = cell.replaceAll(/[\s_-]/g, '').toLowerCase();
  switch (normalized) {
    case 'apache2.0':
    case 'apache2':
      return ['Apache-2.0'];
    case 'mit':
      return ['MIT'];
    case 'bsl1.1':
      return ['BSL-1.1'];
    case 'commercialeula':
    case 'commercialclosed':
      return ['Commercial-EULA'];
    default:
      return null;
  }
}

/**
 * Find the LICENSE file inside a directory, if any.
 *
 * @param {string} dir - Absolute directory path.
 * @returns {string | null} Absolute path of the first LICENSE file found.
 */
function findLicenseFile(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * True when {@link childRel} equals or lives underneath {@link parentRel},
 * compared path-component-wise (no accidental `foo-bar` under `foo`).
 *
 * @param {string} parentRel - Repo-relative parent path (no trailing slash).
 * @param {string} childRel - Repo-relative child path.
 */
function isWithin(parentRel, childRel) {
  if (parentRel === childRel) return true;
  const parts = parentRel.split('/');
  const childParts = childRel.split(sep).length > 1 ? childRel.split(sep) : childRel.split('/');
  if (childParts.length <= parts.length) return false;
  return parts.every((part, i) => part === childParts[i]);
}

/**
 * Most specific classification row covering {@link rel}.
 *
 * @param {{ path: string, license: string }[]} rows
 * @param {string} rel - Repo-relative directory path.
 */
function matchExpectation(rows, rel) {
  let best = null;
  for (const row of rows) {
    if (isWithin(row.path, rel) && (!best || row.path.length > best.path.length)) {
      best = row;
    }
  }
  return best;
}

/**
 * Recursively collect repo-relative directories containing a package.json
 * under {@link dir}. Skips node_modules and other non-source trees.
 *
 * @param {string} dir - Absolute directory to walk (missing dirs are ignored).
 * @param {string} rootDir - Repo root, used to compute relative paths.
 * @param {Set<string>} out - Collector for repo-relative package dirs.
 */
function walkForPackageDirs(dir, rootDir, out) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    // Test fixtures and initializer templates carry private package.json files
    // that are never shipped as packages — they are not licensing subjects.
    if (NON_PACKAGE_DIRS.has(entry.name)) continue;
    if (existsSync(join(abs, 'package.json'))) {
      out.add(resolve(abs).slice(resolve(rootDir).length + 1));
    }
    walkForPackageDirs(abs, rootDir, out);
  }
}

/**
 * Collect every licensing violation in the repository rooted at {@link rootDir}.
 * Offenders are human-readable strings; an empty array means the tree conforms.
 * Only directories that actually exist are checked — reserved rows for closed
 * directories that do not exist yet are skipped silently.
 *
 * Checks performed per classified directory:
 *  1. The row's license label must be recognized.
 *  2. Directories containing a package.json MUST carry a LICENSE file whose
 *     detected type matches the classification.
 *  3. Classified vendored corpora carrying NOTICE files MUST carry their own
 *     matching LICENSE text.
 *  4. Proprietary and source-available classifications are rejected.
 *  5. A package directory discovered on disk but absent (or only generically
 *     covered) in LICENSING.md fails as unclassified.
 *
 * @param {string} rootDir - Repository root containing LICENSING.md.
 * @returns {string[]} Offender descriptions.
 */
export function collectOffenders(rootDir) {
  const offenders = [];
  const root = resolve(rootDir);

  let tableRaw;
  try {
    tableRaw = readFileSync(join(root, 'LICENSING.md'), 'utf8');
  } catch {
    return [`FATAL: LICENSING.md not found at ${join(root, 'LICENSING.md')}`];
  }
  if (!existsSync(join(root, 'LICENSE'))) {
    offenders.push('LICENSE missing at repository root');
  } else if (detectLicenseType(readFileSync(join(root, 'LICENSE'), 'utf8')) !== 'Apache-2.0') {
    offenders.push('repository root LICENSE must remain canonical Apache-2.0');
  }

  // Runtime dependencies that ship third-party notices must be attributed.
  const agentManifest = join(root, 'packages', 'agent', 'package.json');
  if (existsSync(agentManifest) &&
      JSON.parse(readFileSync(agentManifest, 'utf8')).dependencies?.['@earendil-works/pi-mcp'] !== undefined) {
    for (const required of ['@earendil-works/pi-mcp', 'Copyright (c) 2024 Anthropic, PBC', '`cross-spawn` 7.0.6']) {
      if (!tableRaw.includes(required)) offenders.push(`LICENSING.md third-party notices missing: ${required}`);
    }
  }

  const rows = parseLicensingTable(tableRaw);
  if (rows.length === 0) {
    offenders.push('LICENSING.md contains no per-directory classification rows');
  }

  /** @type {Set<string>} */
  const candidates = new Set();
  for (const row of rows) {
    const abs = join(root, row.path);
    if (existsSync(abs) && statSync(abs).isDirectory()) candidates.add(row.path);
  }
  walkForPackageDirs(join(root, 'packages'), root, candidates);
  walkForPackageDirs(join(root, 'apps'), root, candidates);

  for (const rel of [...candidates].sort()) {
    const abs = join(root, rel);
    const row = matchExpectation(rows, rel);
    const hasPkgJson = existsSync(join(abs, 'package.json'));

    if (!row) {
      if (hasPkgJson) {
        offenders.push(`${rel}: package.json present but not classified in LICENSING.md`);
      }
      continue;
    }

    const accepted = acceptedTypesFor(row.license);
    if (accepted === null) {
      offenders.push(`${rel}: unrecognized license label "${row.license}" in LICENSING.md`);
      continue;
    }

    if (accepted.includes('Commercial-EULA') || accepted.includes('BSL-1.1')) {
      offenders.push(`${rel}: proprietary or source-available classifications are forbidden in this repository`);
      continue;
    }

    const requiresLicenseFile = hasPkgJson || existsSync(join(abs, 'NOTICE'));
    if (!requiresLicenseFile) continue;

    const licensePath = findLicenseFile(abs);
    if (!licensePath) {
      offenders.push(
        `${rel}: classified ${row.license} but no LICENSE file found in directory`,
      );
      continue;
    }
    const actual = detectLicenseType(readFileSync(licensePath, 'utf8'));
    if (actual === null) {
      offenders.push(
        `${rel}: ${basename(licensePath)} does not contain recognizable license text`,
      );
    } else if (!accepted.includes(actual)) {
      offenders.push(
        `${rel}: LICENSE is ${actual} but LICENSING.md classifies it as ${row.license}`,
      );
    }
  }

  return offenders;
}

// --- CLI entry point -------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const rootDir = process.argv[2]
    ? resolve(process.argv[2])
    : dirname(dirname(fileURLToPath(import.meta.url)));
  const offenders = collectOffenders(rootDir);
  if (offenders.length > 0) {
    console.error(`license-lint: FAILED — ${offenders.length} offender(s):`);
    for (const o of offenders) console.error(`  - ${o}`);
    process.exitCode = 1;
  } else {
    console.log('license-lint: OK — every classified directory matches LICENSING.md');
  }
}
