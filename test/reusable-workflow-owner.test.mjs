/**
 * Regression guard for the reusable-workflow owner ref.
 *
 * The CANONICAL publisher (operatum-kaizen
 * src/lib/reusable-contract-workflows.js, REUSABLE_WORKFLOW_OWNER='operatum-ai')
 * emits these workflow files with `uses:` refs under operatum-ai/operatum-ci@v1.
 * When the repo copy drifts back to a different owner (e.g. andreikok/), the
 * operatum-ai App identity cannot read the referenced repo and GitHub fails the
 * run with 424 reusable_workflow_unverified.
 *
 * This test pins every operatum-ci `uses:` ref in the shipped workflows to the
 * operatum-ai owner so the drift cannot silently reappear.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKFLOWS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
);

const EXPECTED_OWNER = 'operatum-ai';

// Matches any GitHub `uses:` ref pointing at an operatum-ci repo, capturing the
// owner — covers both reusable-workflow refs (owner/operatum-ci/.github/...) and
// composite-action refs (owner/operatum-ci/actions/...), in code and comments.
const OPERATUM_CI_REF = /([A-Za-z0-9_.-]+)\/operatum-ci\//g;

function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, body: readFileSync(join(WORKFLOWS_DIR, name), 'utf8') }));
}

test('every operatum-ci uses: ref is owned by operatum-ai', () => {
  const files = workflowFiles();
  assert.ok(files.length > 0, 'expected at least one workflow file');

  for (const { name, body } of files) {
    for (const match of body.matchAll(OPERATUM_CI_REF)) {
      const owner = match[1];
      assert.equal(
        owner,
        EXPECTED_OWNER,
        `${name}: operatum-ci ref must use owner '${EXPECTED_OWNER}', found '${owner}' in: ${match[0]}`,
      );
    }
  }
});

test('no workflow references the legacy andreikok/operatum-ci owner', () => {
  for (const { name, body } of workflowFiles()) {
    assert.ok(
      !body.includes('andreikok/operatum-ci'),
      `${name}: still references legacy andreikok/operatum-ci`,
    );
  }
});
