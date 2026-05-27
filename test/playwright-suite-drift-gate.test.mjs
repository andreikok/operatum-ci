/**
 * Workflow-shape tests for the playwright-suite-drift job wired into
 * operatum-contract-{pr,dispatch}.yml.
 *
 * Pins the cross-repo half of release-readiness WORK ITEM-C1
 * (plans/release-readiness-plan.md § 6.1). The kaizen side ships
 * `npm run test:playwright-drift` as a named gate (operatum-kaizen
 * PR #70 fixup fae4cc1); the operatum-ci side MUST invoke it from
 * its reusable workflows so a tenant repo's drift bytes surface as
 * a CI failure, not as a downstream test failure with no breadcrumb
 * back to the contract.
 *
 * Drift pins enforced here:
 *   1. Both reusable workflows declare a `playwright-suite-drift` job.
 *   2. The job runs `npm run test:playwright-drift --if-present`
 *      (the `--if-present` flag is load-bearing — without it, tenant
 *      repos that haven't shipped the C14 script fail the gate).
 *   3. The job is gated on setup_status == 'ready' so it skips when
 *      `npm ci` failed upstream (the script has no install of its own).
 *   4. compose-summary lists playwright-suite-drift in its `needs`,
 *      so drift outcomes block the manifest aggregation step rather
 *      than racing it.
 *
 * A regression that deletes the job, drops `--if-present`, or
 * forgets to wire compose-summary fires a named failure here.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = [
  '.github/workflows/operatum-contract-pr.yml',
  '.github/workflows/operatum-contract-dispatch.yml',
];

function loadWorkflow(relPath) {
  const text = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  return yaml.load(text);
}

for (const wf of WORKFLOWS) {
  test(`${wf}: declares a playwright-suite-drift job`, () => {
    const doc = loadWorkflow(wf);
    assert.ok(doc.jobs, `${wf} has no jobs:`);
    assert.ok(
      doc.jobs['playwright-suite-drift'],
      `${wf} is missing the playwright-suite-drift job`,
    );
  });

  test(`${wf}: playwright-suite-drift gates on setup_status == 'ready'`, () => {
    const job = loadWorkflow(wf).jobs['playwright-suite-drift'];
    assert.ok(
      Array.isArray(job.needs) && job.needs.includes('setup'),
      'job must list `setup` in needs (depends on `npm ci`)',
    );
    assert.match(
      String(job.if),
      /needs\.setup\.outputs\.setup_status\s*==\s*'ready'/,
      'job must skip when setup failed (no install means no drift script to run)',
    );
  });

  test(`${wf}: playwright-suite-drift invokes npm run --if-present`, () => {
    const job = loadWorkflow(wf).jobs['playwright-suite-drift'];
    // Concatenate every step's `run:` so we don't care which step the
    // command lives in — only that the canonical invocation is present.
    const allRun = (job.steps || [])
      .map((s) => s.run || '')
      .join('\n');
    assert.match(
      allRun,
      /npm run test:playwright-drift --if-present/,
      'must invoke `npm run test:playwright-drift --if-present` — the '
      + '`--if-present` flag is what makes tenant repos without the '
      + 'script see a no-op instead of a hard failure',
    );
  });

  test(`${wf}: compose-summary depends on playwright-suite-drift`, () => {
    const composeSummary = loadWorkflow(wf).jobs['compose-summary'];
    assert.ok(composeSummary, 'compose-summary job is missing');
    assert.ok(
      Array.isArray(composeSummary.needs)
        && composeSummary.needs.includes('playwright-suite-drift'),
      'compose-summary must list playwright-suite-drift in `needs` so '
      + 'drift outcomes are blocked-on by the manifest aggregator',
    );
  });

  test(`${wf}: playwright-suite-drift uploads its log artifact`, () => {
    const job = loadWorkflow(wf).jobs['playwright-suite-drift'];
    const uploadStep = (job.steps || []).find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'),
    );
    assert.ok(uploadStep, 'job must upload a log artifact for reviewer visibility');
    assert.equal(uploadStep.with?.name, 'playwright-drift-results');
  });
}
