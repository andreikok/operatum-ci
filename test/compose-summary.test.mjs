/**
 * Initial smoke tests for actions/compose-summary/compose.mjs.
 *
 * The full verdict-precedence-ladder coverage (per the design's
 * "Composer fixtures" list — ~16 scenarios) lands in a follow-up
 * commit alongside the verdict-ladder implementation. This file
 * pins the basics: setup_failure shortcut, unit-test JUnit parsing,
 * manifest-diff contract_invalid signal.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const COMPOSER = new URL('../actions/compose-summary/compose.mjs', import.meta.url).pathname;

function runComposer({ artifactsDir, outPath, env = {} }) {
  const ghOut = join(artifactsDir, '..', 'gh-output.txt');
  writeFileSync(ghOut, '');
  const res = spawnSync('node', [COMPOSER], {
    env: {
      ...process.env,
      ARTIFACTS_DIR: artifactsDir,
      OUT_PATH: outPath,
      GITHUB_OUTPUT: ghOut,
      ...env,
    },
    encoding: 'utf8',
  });
  return { ...res, ghOutput: readFileSync(ghOut, 'utf8') };
}

function makeArtifactsTree() {
  const root = mkdtempSync(join(tmpdir(), 'compose-test-'));
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  return root;
}

test('setup_failure short-circuits the composer with classified reason', () => {
  const root = makeArtifactsTree();
  try {
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(join(artifactsDir, 'setup-meta'));
    writeFileSync(
      join(artifactsDir, 'setup-meta', 'setup-status.json'),
      JSON.stringify({ status: 'failed', stage: 'install', reason: 'package_install_failed' }),
    );
    const outPath = join(root, 'manifest.json');
    const result = runComposer({ artifactsDir, outPath });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.verdict.contract.result, 'failure');
    assert.equal(manifest.verdict.contract.reason, 'setup_failure');
    assert.match(result.ghOutput, /verdict_contract=failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit-tests JUnit failures classify as contract_test_failure', () => {
  const root = makeArtifactsTree();
  try {
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(join(artifactsDir, 'setup-meta'));
    writeFileSync(
      join(artifactsDir, 'setup-meta', 'setup-status.json'),
      JSON.stringify({ status: 'ready', stage: null, reason: null }),
    );
    mkdirSync(join(artifactsDir, 'unit-results'));
    writeFileSync(
      join(artifactsDir, 'unit-results', 'junit.xml'),
      '<?xml version="1.0"?>'
      + '<testsuites><testsuite name="s" tests="3" failures="1" errors="0" skipped="0">'
      + '<testcase name="a"/><testcase name="b"><failure/></testcase><testcase name="c"/>'
      + '</testsuite></testsuites>',
    );
    const outPath = join(root, 'manifest.json');
    const result = runComposer({ artifactsDir, outPath });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.tests.total, 3);
    assert.equal(manifest.tests.failed, 1);
    assert.equal(manifest.tests.passed, 2);
    assert.equal(manifest.verdict.contract.result, 'failure');
    assert.equal(manifest.verdict.contract.reason, 'contract_test_failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest-diff app_valid: false classifies as contract_invalid', () => {
  const root = makeArtifactsTree();
  try {
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(join(artifactsDir, 'setup-meta'));
    writeFileSync(
      join(artifactsDir, 'setup-meta', 'setup-status.json'),
      JSON.stringify({ status: 'ready' }),
    );
    mkdirSync(join(artifactsDir, 'manifest-diff'));
    writeFileSync(
      join(artifactsDir, 'manifest-diff', 'manifest-diff.json'),
      JSON.stringify({ app_valid: false, app_errors: ['missing .operatum/app.json'] }),
    );
    const outPath = join(root, 'manifest.json');
    const result = runComposer({ artifactsDir, outPath });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.verdict.contract.result, 'failure');
    assert.equal(manifest.verdict.contract.reason, 'contract_invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean setup with no test artifacts produces contract_pass', () => {
  const root = makeArtifactsTree();
  try {
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(join(artifactsDir, 'setup-meta'));
    writeFileSync(
      join(artifactsDir, 'setup-meta', 'setup-status.json'),
      JSON.stringify({ status: 'ready' }),
    );
    const outPath = join(root, 'manifest.json');
    const result = runComposer({ artifactsDir, outPath });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.verdict.contract.result, 'success');
    assert.equal(manifest.verdict.contract.reason, 'contract_pass');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reporter_version falls back to workflow_ref @suffix, never github.ref_name', () => {
  const root = makeArtifactsTree();
  try {
    const artifactsDir = join(root, 'artifacts');
    mkdirSync(join(artifactsDir, 'setup-meta'));
    writeFileSync(
      join(artifactsDir, 'setup-meta', 'setup-status.json'),
      JSON.stringify({ status: 'ready' }),
    );
    const outPath = join(root, 'manifest.json');
    const result = runComposer({
      artifactsDir,
      outPath,
      env: {
        GITHUB_WORKFLOW_REF: 'andreikok/operatum-ci/.github/workflows/operatum-contract-pr.yml@v1.2.3',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.reporter_version, 'v1.2.3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
