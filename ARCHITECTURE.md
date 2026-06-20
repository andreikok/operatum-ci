# operatum-ci — architecture

This document describes the shape of the operatum-ci workflow pack and
records the resolution of the canonical-source question for the
reusable contract workflows. The full design rationale lives in
[`operatum-kaizen/docs/workflow-pack-design.md`][design]; this file is
the repo-local architecture summary.

[design]: https://github.com/andreikok/operatum-kaizen/blob/main/docs/workflow-pack-design.md

## Canonical source & divergence — resolution

operatum-kaizen `src/lib/reusable-contract-workflows.js` is the
**single source of truth** for the reusable contract workflows. That JS
module GENERATES the workflow bodies and publishes them to
`operatum-ai/operatum-ci@v1` — those published bytes are what tenant
apps actually run.

The `.github/workflows/*.yml` files in THIS repo are a **reference
pipeline**. They have diverged from the published bytes: this repo
carries a richer composite-action chain — `setup-toolchain`,
`redact-secrets`, `compose-summary`, and `post-callback` invoked via
`uses:` — whereas the published bodies inline that logic and contain no
internal composite-action `uses:` at all.

Resolution:

- The kaizen JS module is **canonical**.
- These repo workflows are a **reference copy that currently differs**
  (a richer composite-action chain vs the inlined published version)
  and are NOT necessarily what apps run.
- Reconciling app-CI to this richer composite-action pipeline, if ever
  wanted, is a **separate operatum-kaizen item** — out of scope here.
  This repo's cleanup must not change the published artifact's
  behaviour.

The platform-wide intended end-state is described in
operatum-ui/PLATFORM-ARCHITECTURE.md §6.6.

## Components

- **`.github/workflows/operatum-contract-pr.yml`** — reusable workflow,
  `pull_request`-callable. Declares only `callback_hmac` in
  `workflow_call.secrets`; no job declares an `environment:`, so
  provider-keyed secret references resolve to empty.
- **`.github/workflows/operatum-contract-dispatch.yml`** — reusable
  workflow, `repository_dispatch`-callable. Tenant-test jobs declare
  `environment: kaizen-trusted`; provider keys live in that
  environment's secret store and are gated by the App's custom
  protection rule (`/api/owns-pr`).
- **`actions/`** — four composite actions consumed by the reference
  workflows: `setup-toolchain` (detects Node + package manager),
  `redact-secrets` (emits `::add-mask::` for every secret),
  `compose-summary` (composes `kaizen-test-summary.json`), and
  `post-callback` (HMAC-signed POST to Kaizen).
- **`self-test.yml`** — CI for operatum-ci itself: runs the in-repo
  unit tests and lints the workflow YAML with actionlint.

## Trust split

The two reusable workflows differ ONLY in their secret surface and in
which jobs they emit. The pull_request surface is untrusted — the trust
boundary is enforced at GitHub's schema layer (no `environment:`, so a
PR-edit attack mapping provider keys fails workflow resolution). The
dispatch surface is invoked by the Kaizen server and reads provider
keys from the `kaizen-trusted` environment, gated by the ownership
check. See the design doc for the full trust-boundary and marker-job
DAG.

## Owner identity

Every `operatum-ci` self-reference (composite-action `uses:`, consumer
examples, the publish target) uses the `operatum-ai/` owner — the App
identity that publishes the pack and can read it. The
`andreikok/operatum-kaizen` design link above points at a different
repo and is intentionally left under that owner.
