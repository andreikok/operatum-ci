#!/usr/bin/env node
/**
 * compose.mjs — initial composer for KB-7 PR B scaffold.
 *
 * Walks $ARTIFACTS_DIR (default `_artifacts/`), reads what's there,
 * and emits the KB-5 § "Manifest shape (v1)" JSON at $OUT_PATH
 * (default `kaizen-test-summary.json`). The full verdict-precedence
 * ladder + JSON-Schema validation lands in a follow-up commit; this
 * version produces a parseable manifest that Kaizen's ingest will
 * accept while the marker-DAG + classifier work is in progress.
 *
 * What this version DOES handle:
 *   - setup-status.json → setup_failure short-circuit
 *   - junit.xml under unit-results/ → tests.{total,passed,failed,skipped}
 *   - lint-results/lint.json → lint conclusion
 *   - manifest-diff.json → contract_invalid signal
 *   - missing required artifacts → neutral verdict with a note
 *
 * What lands in a follow-up commit (deferred):
 *   - Marker-job projection-status.json scanning + the round-43
 *     marker-directory skip
 *   - Full verdict ladder per the design's "verdict-precedence"
 *     table
 *   - JSON-Schema validation against kaizen-test-summary.v1.json
 *   - preview-status.json + preview_unavailable_required_* paths
 *   - secret-scan + hard-fail-on-secret-in-diff
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '_artifacts';
const OUT_PATH = process.env.OUT_PATH || 'kaizen-test-summary.json';
const OUTPUT = process.env.GITHUB_OUTPUT;

function setOutput(key, value) {
  if (!OUTPUT) return;
  appendFileSync(OUTPUT, `${key}=${value}\n`);
}

function readJSONSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function listDirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

// ── Walk artifacts/ and bucket by directory name (artifact name). ──
const buckets = {};
if (existsSync(ARTIFACTS_DIR) && statSync(ARTIFACTS_DIR).isDirectory()) {
  for (const name of listDirSafe(ARTIFACTS_DIR)) {
    const path = join(ARTIFACTS_DIR, name);
    try {
      if (statSync(path).isDirectory()) buckets[name] = path;
    } catch { /* ignore */ }
  }
}

// ── 1. Setup-failure short-circuit. ──
let setupStatus = null;
if (buckets['setup-meta']) {
  setupStatus = readJSONSafe(join(buckets['setup-meta'], 'setup-status.json'));
}

let verdictContract = 'success';
let verdictReason = 'contract_pass';
const auditNotes = [];

if (setupStatus && setupStatus.status === 'failed') {
  verdictContract = 'failure';
  verdictReason = 'setup_failure';
  auditNotes.push(`setup_failure: stage=${setupStatus.stage} reason=${setupStatus.reason}`);
}

// ── 2. Manifest-validate signal (only consulted when setup is good). ──
if (verdictContract !== 'failure' && buckets['manifest-diff']) {
  const diff = readJSONSafe(join(buckets['manifest-diff'], 'manifest-diff.json'));
  if (diff && diff.app_valid === false) {
    verdictContract = 'failure';
    verdictReason = 'contract_invalid';
    auditNotes.push(`contract_invalid: ${JSON.stringify(diff.app_errors || []).slice(0, 256)}`);
  }
}

// ── 3. Playwright-suite-drift signal. The drift job writes BOTH a
//       human-readable `playwright-drift.log` (for reviewer eyes)
//       AND a machine-readable `playwright-drift.json` with shape
//       { result: 'success'|'failure'|'skipped', exit_code: <n>,
//         summary?: '<one-liner>' }. We classify a `failure` here so
//       the manifest/callback path agrees with the GH Actions job
//       outcome (per PR-2 review round-1, R-ci-pr-2-R1-1: without
//       this step a tenant drift failure failed the GH job but
//       still emitted verdict.contract.result=success and Kaizen
//       was told the contract passed).
//
//       Missing artifact (pre-C14 tenant repos or back-compat with
//       runs that pre-date the JSON emit step) is treated as "no
//       signal" — verdict unchanged. `skipped` is also a no-op.
//       Only `failure` flips the verdict, and only when no higher-
//       precedence failure (setup_failure, contract_invalid) has
//       already won. ──
if (verdictContract !== 'failure' && buckets['playwright-drift-results']) {
  const drift = readJSONSafe(
    join(buckets['playwright-drift-results'], 'playwright-drift.json'),
  );
  if (drift && drift.result === 'failure') {
    verdictContract = 'failure';
    verdictReason = 'contract_drift';
    const summary = typeof drift.summary === 'string' && drift.summary
      ? drift.summary
      : `exit_code=${drift.exit_code ?? 'unknown'}`;
    auditNotes.push(`contract_drift: ${summary.slice(0, 256)}`);
  }
}

// ── 4. Unit-tests JUnit parse (informational; the full per-slot
//       failure ladder lands in a follow-up). ──
let tests = { total: 0, passed: 0, failed: 0, skipped: 0 };
const unitJunitPath = buckets['unit-results']
  ? join(buckets['unit-results'], 'junit.xml')
  : null;
if (unitJunitPath && existsSync(unitJunitPath)) {
  try {
    const xml = readFileSync(unitJunitPath, 'utf8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    // Accept either <testsuites> or a single top-level <testsuite>.
    const suites = parsed.testsuites?.testsuite
      ? (Array.isArray(parsed.testsuites.testsuite) ? parsed.testsuites.testsuite : [parsed.testsuites.testsuite])
      : (parsed.testsuite ? [parsed.testsuite] : []);
    for (const suite of suites) {
      tests.total += Number(suite['@_tests'] || 0);
      tests.failed += Number(suite['@_failures'] || 0) + Number(suite['@_errors'] || 0);
      tests.skipped += Number(suite['@_skipped'] || 0);
    }
    tests.passed = Math.max(0, tests.total - tests.failed - tests.skipped);
    if (tests.failed > 0 && verdictContract === 'success') {
      verdictContract = 'failure';
      verdictReason = 'contract_test_failure';
      auditNotes.push(`unit tests: ${tests.failed}/${tests.total} failed`);
    }
  } catch (err) {
    auditNotes.push(`unit-results/junit.xml parse error: ${err.message}`);
  }
}

// ── 5. Build the manifest. KB-5 § "Manifest shape (v1)" pins the
//       shape; we emit a subset and let the follow-up commits fill
//       in artifacts[] and the full verdict block. ──
const manifest = {
  schema_version: 'kaizen-test-summary.v1',
  reporter: 'operatum-ci',
  reporter_version: process.env.REPORTER_VERSION
    || extractRefFromWorkflowRef(process.env.GITHUB_WORKFLOW_REF)
    || 'unknown',
  tenant_id: process.env.TENANT_ID || undefined,
  kaizen_job_id: process.env.KAIZEN_JOB_ID || undefined,
  github: {
    repository: process.env.GITHUB_REPO || undefined,
    run_id: process.env.GITHUB_RUN_ID || undefined,
  },
  pr: {
    number: process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : undefined,
    head_sha: process.env.HEAD_SHA || undefined,
  },
  verdict: {
    contract: { result: verdictContract, reason: verdictReason },
  },
  tests,
  artifacts: [],
  audit: { notes: auditNotes },
};

// Strip undefined for a clean wire payload.
const cleaned = JSON.parse(JSON.stringify(manifest, (_k, v) => v === undefined ? undefined : v));
writeFileSync(OUT_PATH, JSON.stringify(cleaned, null, 2) + '\n');

setOutput('manifest_path', OUT_PATH);
setOutput('verdict_contract', verdictContract);

console.log(`compose-summary: wrote ${OUT_PATH}; verdict.contract=${verdictContract} reason=${verdictReason}`);

function extractRefFromWorkflowRef(workflowRef) {
  // workflow_ref is shaped 'owner/repo/.github/workflows/foo.yml@ref'.
  // Per the design, reporter_version MUST NEVER fall back to
  // github.ref_name (which is the CALLER'S branch, not this pack's
  // version). The release pipeline will inject OPERATUM_RELEASE_VERSION
  // at tag time; until then we pull the @ref suffix from workflow_ref.
  if (!workflowRef) return null;
  const at = workflowRef.lastIndexOf('@');
  return at === -1 ? null : workflowRef.slice(at + 1);
}
