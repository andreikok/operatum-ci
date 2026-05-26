#!/usr/bin/env node
/**
 * detect.mjs — read the tenant repo's lockfile + .nvmrc + package.json
 * to produce three GitHub-Actions outputs:
 *   - node_version      ('20' | '22' | …; defaults to '20' when nothing
 *                       declares one — the lowest active LTS line)
 *   - package_manager   ('npm' | 'pnpm' | 'yarn'; defaults to 'npm')
 *   - has_playwright    ('true' | 'false' — controls whether setup
 *                       runs `npx playwright install --with-deps`)
 *
 * The detection is INTENTIONALLY simple: a repo with both
 * `pnpm-lock.yaml` AND `package-lock.json` is a misconfiguration
 * the tenant should fix, not something this action tries to
 * arbitrate.  Order is: pnpm-lock → yarn.lock → package-lock.json.
 *
 * No npm deps. The script runs at the start of every workflow run
 * across thousands of tenants per day; we keep it dependency-free
 * so a future supply-chain compromise of a transitive dep cannot
 * sit at the very first step of every CI run.
 */

import { readFileSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const out = process.env.GITHUB_OUTPUT;
if (!out) {
  console.error('detect: GITHUB_OUTPUT not set; refusing to run outside GHA');
  process.exit(1);
}

function setOutput(key, value) {
  appendFileSync(out, `${key}=${value}\n`);
}

function readJSONSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ── Package manager — lockfile presence is the signal. ──
let packageManager = 'npm';
if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
  packageManager = 'pnpm';
} else if (existsSync(join(cwd, 'yarn.lock'))) {
  packageManager = 'yarn';
}
// package-lock.json → npm (the default).

// ── Node version — prefer .nvmrc, then package.json#engines.node. ──
let nodeVersion = '';
if (existsSync(join(cwd, '.nvmrc'))) {
  const raw = readFileSync(join(cwd, '.nvmrc'), 'utf8').trim();
  // Accept '20', 'v20', '20.11.1', 'lts/iron'. We extract the major.
  const match = raw.match(/(\d+)/);
  if (match) nodeVersion = match[1];
}
const pkg = readJSONSafe(join(cwd, 'package.json'));
if (!nodeVersion && pkg?.engines?.node) {
  // engines.node like '>=20', '20.x', '^20.11.0'. Extract first integer.
  const match = String(pkg.engines.node).match(/(\d+)/);
  if (match) nodeVersion = match[1];
}
if (!nodeVersion) nodeVersion = '20';

// ── Playwright presence — controls the conditional install step. ──
const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
const hasPlaywright = Boolean(deps['@playwright/test'] || deps['playwright'])
  ? 'true'
  : 'false';

setOutput('node_version', nodeVersion);
setOutput('package_manager', packageManager);
setOutput('has_playwright', hasPlaywright);

console.log(
  `detect: node_version=${nodeVersion} package_manager=${packageManager} `
  + `has_playwright=${hasPlaywright}`,
);
