/**
 * Smoke tests for actions/setup-toolchain/detect.mjs.
 *
 * Verifies the detection precedence rules from the design:
 * pnpm-lock > yarn.lock > package-lock.json for package manager,
 * .nvmrc > package.json#engines.node > '20' for node_version,
 * @playwright/test or playwright in deps/devDeps → has_playwright.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DETECT = new URL('../actions/setup-toolchain/detect.mjs', import.meta.url).pathname;

function runDetect(files = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'detect-test-'));
  const ghOut = join(cwd, 'gh-output.txt');
  writeFileSync(ghOut, '');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(cwd, name), contents);
  }
  const res = spawnSync('node', [DETECT], {
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: ghOut },
    encoding: 'utf8',
  });
  const output = Object.fromEntries(
    readFileSync(ghOut, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2)),
  );
  rmSync(cwd, { recursive: true, force: true });
  return { ...res, parsed: output };
}

test('defaults to node 20 + npm + no playwright when nothing is declared', () => {
  const { parsed } = runDetect({});
  assert.equal(parsed.node_version, '20');
  assert.equal(parsed.package_manager, 'npm');
  assert.equal(parsed.has_playwright, 'false');
});

test('pnpm-lock.yaml → pnpm package_manager', () => {
  const { parsed } = runDetect({ 'pnpm-lock.yaml': '' });
  assert.equal(parsed.package_manager, 'pnpm');
});

test('yarn.lock → yarn package_manager (when no pnpm-lock)', () => {
  const { parsed } = runDetect({ 'yarn.lock': '' });
  assert.equal(parsed.package_manager, 'yarn');
});

test('.nvmrc overrides default node_version', () => {
  const { parsed } = runDetect({ '.nvmrc': 'v22.5.0\n' });
  assert.equal(parsed.node_version, '22');
});

test('package.json engines.node overrides default node_version', () => {
  const { parsed } = runDetect({
    'package.json': JSON.stringify({ engines: { node: '>=22.0.0' } }),
  });
  assert.equal(parsed.node_version, '22');
});

test('@playwright/test in devDependencies sets has_playwright=true', () => {
  const { parsed } = runDetect({
    'package.json': JSON.stringify({
      devDependencies: { '@playwright/test': '^1.40.0' },
    }),
  });
  assert.equal(parsed.has_playwright, 'true');
});
