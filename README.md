# operatum-ci — reusable GitHub Actions workflow pack

The CI substrate for the repositories Kaizen bootstraps and operates.
This repo ships **two reusable workflows** plus **four composite
actions**. Every operatum-managed tenant repo (apps, services,
libraries, sidecars) consumes them through a one-line `uses:` in a
small *caller* workflow that Kaizen seeds into the repo at bootstrap.

When a PR opens (or Kaizen dispatches a run) in a tenant repo, the
caller invokes one of these reusable workflows. The workflow checks
out the head SHA, detects the toolchain, runs **lint / typecheck /
manifest-validate / secret-scan** (the cheap fan-in), composes a
single `kaizen-test-summary.json` manifest, and POSTs that manifest —
HMAC-signed — back to the Kaizen server, which uses the verdict to
advance the app's lifecycle.

> **Status:** this is the **KB-7 PR B scaffold**. The cheap fan-in
> chain, the four composite actions, and the callback are real and
> working. The four *tenant-test* slots (unit / integration / e2e /
> visual), their trusted provider-job siblings, `preview-deploy`,
> `log-capture`, and the full verdict-precedence ladder are
> documented but **deferred to follow-up PRs** (see CHANGELOG
> "Deferred" and ARCHITECTURE.md). See the design doc below for the
> full intended shape.

The design that justifies every shape here lives in
[`operatum-kaizen/docs/workflow-pack-design.md`][design] — the source
of truth for the marker-job DAG, the verdict-precedence ladder, the
trust-boundary split between the `pull_request` and `dispatch`
reusable workflows, and the manifest schema this pack emits.

[design]: https://github.com/andreikok/operatum-kaizen/blob/main/docs/workflow-pack-design.md

## What ships here

```
.github/workflows/
  operatum-contract-pr.yml         # reusable workflow — pull_request callable (UNTRUSTED surface)
  operatum-contract-dispatch.yml   # reusable workflow — repository_dispatch callable (TRUSTED surface)
  self-test.yml                    # CI for operatum-ci itself (unit tests + actionlint)
actions/
  setup-toolchain/                 # composite — detect Node version + package manager + Playwright
  redact-secrets/                  # composite — emit ::add-mask:: for every secret in scope
  compose-summary/                 # composite — compose kaizen-test-summary.json from artifacts
  post-callback/                   # composite — HMAC-signed POST of the manifest to Kaizen
test/                              # node:test unit tests for the three .mjs scripts
VERSION                            # one line: "v1" — the major-version contract
package.json                       # not published to npm; deps = fast-xml-parser, js-yaml
```

## The two reusable workflows

Both share an identical input contract and an identical cheap fan-in
job graph (`resolve-context → setup → {lint, typecheck,
manifest-validate, secret-scan} → compose-summary → callback`). They
differ **only** in their **secret/trust surface** and (once the
deferred work lands) in which tenant-test jobs they emit.

- **`operatum-contract-pr.yml`** — invoked from the tenant's
  `pull_request`-triggered caller. Its `workflow_call.secrets`
  declares **only `callback_hmac`**. No job declares `environment:
  kaizen-trusted`, so provider-keyed references like
  `${{ secrets.OPENAI_TEST_API_KEY }}` resolve to **empty** even if a
  PR author edits the caller to map them. The trust boundary is
  enforced by GitHub's schema layer, not by caller good behaviour.
  `resolve-context` hard-codes `is_kaizen_owned=0` /
  `provider_secrets_available=0` — this surface is **untrusted by
  construction**.

- **`operatum-contract-dispatch.yml`** — invoked from the tenant's
  `repository_dispatch`-triggered caller, fired by the Kaizen server
  with `head_sha` / `pr_number` in the `client_payload`. Same single
  `callback_hmac` secret on the `workflow_call` surface; provider
  test keys live in a `kaizen-trusted` GitHub *Environment* and are
  read directly by jobs that declare `environment: kaizen-trusted`.
  Today `resolve-context` **fails closed** (`is_kaizen_owned=0`)
  pending the `/api/owns-pr` ownership check (deferred to KB-4 PR C);
  it `exit 1`s if invoked without a `head_sha`.

## Consumer pattern

At bootstrap, Kaizen writes a small caller workflow into the tenant
repo that pins this pack by tag. The pull_request caller:

```yaml
# .github/workflows/operatum-contract.yml — in the tenant repo
name: operatum-contract
on:
  pull_request:
permissions:
  contents: read
  checks: read
  actions: read
jobs:
  contract:
    uses: operatum-ai/operatum-ci/.github/workflows/operatum-contract-pr.yml@v1
    with:
      target_type: app          # app | service | library | sidecar | platform
    secrets:
      callback_hmac: ${{ secrets.KAIZEN_CALLBACK_HMAC }}
```

The dispatch caller (`.github/workflows/operatum-ci-dispatch.yml`) is
the same shape with `operatum-contract-dispatch.yml@v1` on a
`repository_dispatch` trigger. `tenant_id` and `callback_url` may be
passed as inputs or left empty — the workflow falls back to repo
**Variables** `vars.OPERATUM_TENANT_ID` and `vars.OPERATUM_CALLBACK_URL`
at runtime.

> **Owner note:** the workflow YAMLs in *this* repo currently reference
> `andreikok/operatum-ci/...@v1` for their internal composite-action
> `uses:`. The live pipeline publishes the canonical workflow bytes
> (held in `operatum-kaizen/src/lib/reusable-contract-workflows.js`)
> to **`operatum-ai/operatum-ci@v1`** so the ref owner matches the
> App identity that reads them. Treat `operatum-ai/operatum-ci@v1` as
> the consumer-facing ref.

## Versioning policy

Three-tier pin model, matching the GitHub Actions ecosystem norm:

| Pin form | Resolution | Audience |
|---|---|---|
| `@v1` | moving tag — latest `v1.x.y` release | tenants (default) |
| `@v1.2.3` | specific release | tenants who want byte-pinning |
| `@<40-hex-sha>` | exact commit | security-sensitive tenants |
| `@main` | tip of main | **not for tenants**; self-test only |

`v1` is the auto-upgrade seam: every merge to `main` is intended to
cut a new patch release, write `v1.x.y`, then force-move `v1` to it
(the release pipeline that does this is **deferred**). A breaking
change cuts `v2`; tenants on `@v1` keep their pin until they edit it.

## Self-test & changelog

`self-test.yml` runs the in-repo `node:test` unit tests for the three
`.mjs` scripts and lints all workflow YAML with `actionlint`. The full
integration self-test (invoking both reusable workflows against a
`fixtures/minimal-app` with a stubbed callback receiver) is deferred.

Every PR to this repo MUST update [`CHANGELOG.md`](./CHANGELOG.md).

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the per-job gating
contract, the deployment-contract tie-in, and the EXPOSES/CONSUMES
surface.
