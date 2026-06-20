# operatum-ci — architecture

`operatum-ci` is a **reusable GitHub Actions workflow pack**: the CI
substrate that runs inside every repository Kaizen bootstraps. It is
not an app and not a service — its deliverable is the
`.github/workflows/` + `actions/` tree, consumed by other repos via
`uses: operatum-ai/operatum-ci/...@v1`.

This document covers the workflow-pack architecture: each reusable
workflow, what each job *gates*, how the pack ties into the operatum
**deployment contract**, and the EXPOSES / CONSUMES surface. Line
citations are `file:line` against this repo unless noted.

---

## 1. Position in the operatum loop

```
 Kaizen merges code → tenant repo PR opens (or Kaizen dispatches)
        │
        ▼
 caller workflow in tenant repo
   uses: operatum-ai/operatum-ci/.github/workflows/operatum-contract-{pr,dispatch}.yml@v1
        │
        ▼
 THIS PACK runs:  resolve-context → setup → {lint,typecheck,
                  manifest-validate,secret-scan} → compose-summary → callback
        │  (composes kaizen-test-summary.json)
        ▼
 post-callback HMAC-POSTs the manifest to
   <callback_url>/api/webhooks/test-summary   (Kaizen server)
        │
        ▼
 Kaizen ingests the verdict → advances the app lifecycle
   (lifecycle-verdict.js consumes verdict.contract)
```

The pack is the **only** thing that turns "code merged into a tenant
repo" into "a structured pass/fail verdict the orchestrator can act
on." It is the enforcement edge of the deployment contract.

---

## 2. The two reusable workflows

Both reusable workflows declare identical `workflow_call` inputs and
an identical cheap fan-in job graph. They differ ONLY in their
**secret / trust surface**. This is the round-17 trust-split.

### Shared input contract

Declared identically in both files
(`operatum-contract-pr.yml:23-97`, `operatum-contract-dispatch.yml:27-99`):

| Input | Type | Default | Role |
|---|---|---|---|
| `target_type` | string | *(required)* | `app \| service \| library \| sidecar \| platform` — selects the contract profile |
| `kaizen_job_id` | string | `""` | correlation context only — **never a trust signal** |
| `pr_number` | string | `""` | PR number (from `client_payload` on dispatch) |
| `head_sha` | string | `""` | head SHA the checkout pins to |
| `tenant_id` | string | `""` | falls back to `vars.OPERATUM_TENANT_ID` |
| `callback_url` | string | `""` | falls back to `vars.OPERATUM_CALLBACK_URL` |
| `require_unit` / `require_e2e` | bool | `true` | which tenant-test slots are required |
| `require_integration` / `require_visual` / `require_tenant_isolation` | bool | `false` | optional slots |
| `require_playwright` | bool | `true` | gate the `npx playwright install` step |
| `runs_on` | string | `ubuntu-latest` | runner label |
| `contract_workflow_version` | string | `""` | forces `manifest.reporter_version` |

`secrets:` declares **only `callback_hmac`** on both
(`operatum-contract-pr.yml:88-97`,
`operatum-contract-dispatch.yml:92-99`).

Top-level `permissions:` are minimal on both — `contents: read`,
`checks: read`, `actions: read` (`operatum-contract-pr.yml:99-102`).

### 2a. `operatum-contract-pr.yml` — UNTRUSTED surface

Invoked from the tenant's `pull_request`-triggered caller. The PR
author can edit the caller, so this surface assumes **zero trust**:

- `resolve-context` resolves `head_sha`/`pr_number` from
  `github.event.pull_request.*` with input fallback, then hard-codes
  **`is_kaizen_owned=0` and `provider_secrets_available=0`**
  (`operatum-contract-pr.yml:132-137`). No job declares
  `environment: kaizen-trusted`, so any `${{ secrets.OPENAI_TEST_API_KEY }}`
  a malicious caller maps resolves to empty — the trust boundary is
  GitHub's schema layer, not caller good behaviour
  (`operatum-contract-pr.yml:6-11, 88-97`).

### 2b. `operatum-contract-dispatch.yml` — TRUSTED surface

Invoked from the tenant's `repository_dispatch`-triggered caller,
fired by the Kaizen *server* with `head_sha`/`pr_number` in the
`client_payload`:

- `resolve-context` reads `head_sha` from inputs and **`exit 1`s if
  absent** (`operatum-contract-dispatch.yml:134-137`).
- Provider test keys live in a `kaizen-trusted` GitHub *Environment*
  (not on the `workflow_call.secrets` surface) and are intended to be
  read by jobs declaring `environment: kaizen-trusted`
  (`operatum-contract-dispatch.yml:6-15`).
- Today it **fails closed**: `is_kaizen_owned=0` /
  `provider_secrets_available=0` pending the `/api/owns-pr`
  authenticated ownership check (deferred — KB-4 PR C)
  (`operatum-contract-dispatch.yml:147-151`).

---

## 3. The job graph — what each job gates

Both workflows run the same fan-in. "Gates" = the signal it
contributes to the final `verdict.contract`.

| Job | Trigger condition | Produces (artifact) | What it gates |
|---|---|---|---|
| **resolve-context** | always | (job outputs) | pins `head_sha`/`pr_number`; sets the trust outputs every downstream job keys off |
| **setup** | needs resolve-context | `setup-meta/setup-status.json` | toolchain readiness — a `failed` status **short-circuits** the whole verdict to `setup_failure` |
| **lint** | `setup_status == 'ready'` | `lint-results/lint.json`, `lint.log` | runs `npm run lint` if a `lint` script exists, else emits `skipped` (no hard-fail yet) |
| **typecheck** | `setup_status == 'ready'` | `typecheck-results/typecheck.json` | runs `tsc --noEmit` if `tsconfig.json` exists; classifies success/failure/neutral |
| **manifest-validate** | `setup_status == 'ready'` | `manifest-diff.json` | **the deploy-contract check** — requires `.operatum/app.json` to exist; absence ⇒ `app_valid:false` |
| **secret-scan** | `setup_status == 'ready'` | `secret-scan-results/secret-scan.json` | scaffold emits clean report; the secret-in-diff hard-fail is **deferred** |
| **compose-summary** | `always()` | `kaizen-test-summary/kaizen-test-summary.json` | aggregates all artifacts into one manifest + computes `verdict.contract` |
| **callback** | `always()` & manifest exists | — | HMAC-POSTs the manifest to Kaizen |

### setup (`operatum-contract-pr.yml:139-220`)

Sequenced, each stage `continue-on-error` and recorded into
`setup-status.json` with a `{status, stage, reason}` shape:
`checkout` → `setup-toolchain` → `redact-secrets` → cache-key →
`actions/cache` → install (`npm ci` / `pnpm install --frozen-lockfile`
/ `yarn install --frozen-lockfile`, chosen by detected package
manager, L191-195) → conditional `playwright install --with-deps`
(only if `has_playwright` and `require_playwright`, L199-203). Any
failed stage writes `status:"failed"` with a typed `reason`
(`checkout_failed` / `toolchain_detection_failed` /
`package_install_failed` / `playwright_browser_install_failed`); the
all-clear writes `status:"ready"` (L207-209). The fan-in jobs run
**only** when `setup_status == 'ready'` (e.g. lint at L225).

### manifest-validate — the deploy-contract gate
(`operatum-contract-pr.yml:288-320`)

This is the job that ties the pack to the **deployment contract**.
Today it is a minimal validator: it checks for the presence of
**`.operatum/app.json`** (the app manifest), and emits
`manifest-diff.json` with `{app_valid, app_errors}`
(L304-313). A missing manifest yields `app_valid:false` with
`app_errors:["missing .operatum/app.json"]`. `compose-summary`
escalates that to a **`contract_invalid` failure verdict**
(`actions/compose-summary/compose.mjs:78-85`). The dedicated
`actions/manifest-validate` composite with bundled JSON schemas (full
field-level validation of the app/service/library manifests) is
**deferred** (L299-301).

### compose-summary — the verdict engine
(`operatum-contract-pr.yml:346-374` → `actions/compose-summary/compose.mjs`)

Downloads all artifacts, then walks them and computes
`verdict.contract`. The implemented precedence (a *subset* of the
full design ladder):

1. `setup-meta/setup-status.json` with `status:"failed"` ⇒
   `failure` / `setup_failure` (compose.mjs:71-75).
2. `manifest-diff.json` with `app_valid:false` ⇒
   `failure` / `contract_invalid` (compose.mjs:78-85).
3. `unit-results/junit.xml` with failures ⇒
   `failure` / `contract_test_failure` (compose.mjs:93-116).
4. otherwise ⇒ `success` / `contract_pass` (compose.mjs:67-68).

It emits the **`kaizen-test-summary.v1`** manifest
(`schema_version`, `reporter:"operatum-ci"`, `reporter_version`,
`tenant_id`, `kaizen_job_id`, `github.{repository,run_id}`,
`pr.{number,head_sha}`, `verdict.contract.{result,reason}`, `tests`,
`artifacts`, `audit.notes`) — compose.mjs:121-143. `reporter_version`
is resolved from the `contract_workflow_version` input or the
`@ref` suffix of `github.workflow_ref`, and is pinned to **never**
fall back to `github.ref_name` (the caller's branch) — compose.mjs:154-163.

The **full verdict-precedence ladder** (secret-in-diff, untrusted-PR
markers, preview-unavailable, missing-required-* slots, per-slot
failures) and JSON-Schema validation against
`kaizen-test-summary.v1.json` are **deferred** (compose.mjs:18-27).

### callback — the report-out (`operatum-contract-pr.yml:376-411`)

Resolves `tenant_id`/`callback_url` from inputs with fallback to
`vars.OPERATUM_TENANT_ID` / `vars.OPERATUM_CALLBACK_URL`
(L388-403); warns + skips if either is empty. When `callback_url` is
present it runs `post-callback` (L404-411).

---

## 4. The four composite actions

| Action | Entry | Role |
|---|---|---|
| **setup-toolchain** | `detect.mjs` | detect Node version + package manager + Playwright presence |
| **redact-secrets** | inline node | emit `::add-mask::` per secret so later log output is masked |
| **compose-summary** | `compose.mjs` | compose the verdict manifest (see §3) |
| **post-callback** | `post.mjs` | HMAC-signed POST of the manifest to Kaizen |

### setup-toolchain (`actions/setup-toolchain/`)
`detect.mjs` reads lockfile + `.nvmrc` + `package.json#engines` to
emit `node_version` / `package_manager` / `has_playwright`
(detect.mjs:45-78). Package manager precedence is
`pnpm-lock.yaml → yarn.lock → package-lock.json` (detect.mjs:46-52);
Node version prefers `.nvmrc` then `engines.node`, defaulting to `20`
(detect.mjs:54-68). **Dependency-free by design** — it runs at the
very first step of every CI run across thousands of tenants/day, so
no npm deps sit in the supply-chain path (detect.mjs:11-19). The
composite then runs `actions/setup-node@v4` with the detected version
(action.yml:25-28).

### redact-secrets (`actions/redact-secrets/action.yml`)
Reads `$KAIZEN_REDACT` (typically `${{ toJSON(secrets) }}`) and emits
one `::add-mask::<value>::` per non-empty string value
(action.yml:35-58). **Job-local** — every job that handles a secret
declares it as its first step; an empty/`null` payload is a no-op
(action.yml:27-30). Uses `node -e`, not `jq`, to avoid a dependency on
a security-critical step (action.yml:33-35).

### compose-summary (`actions/compose-summary/`)
See §3. Inputs echo straight into the manifest; outputs are
`manifest_path` + `verdict_contract` (action.yml:45-51). Uses
`fast-xml-parser` to parse JUnit XML (compose.mjs:31,96).

### post-callback (`actions/post-callback/`)
Reads the manifest's **raw bytes** (never re-serialised),
HMAC-SHA256s them with `callback_hmac`, and POSTs to
`<callback_url>/api/webhooks/test-summary` with `Authorization:
Bearer <hmac-hex>` + `X-Operatum-Tenant-Id` + `X-Operatum-Kaizen-Job-Id`
headers (post.mjs:43-61). Signing the raw bytes is load-bearing:
Kaizen verifies the HMAC against the exact bytes it receives, so any
re-serialisation here would break verification (post.mjs:3-9).
**Retry posture**: 3 attempts, exponential backoff 1s/2s/4s, on
network errors + 5xx; 4xx is **not** retried (post.mjs:63-127).
**HMAC-missing posture**: empty `callback_hmac` ⇒ warn + `exit 0`
(bootstrap-race tolerance — Kaizen tolerates losing one manifest
while the tenant's secret-sync is racing) (post.mjs:38-41).

---

## 5. Tie to the deployment contract

The "contract" the pack enforces is the operatum **app/service
deployment contract**, surfaced through two seams:

1. **`.operatum/app.json` presence** — gated by `manifest-validate`
   (§3). This is the on-disk declaration that a repo *is* a
   deployable operatum app and that its shape is valid. A missing or
   invalid manifest fails the contract before any deploy is
   considered.

2. **`verdict.contract` in `kaizen-test-summary.json`** — the wire
   verdict Kaizen consumes. `compose-summary` reduces all job signals
   into `verdict.contract.{result,reason}`; `post-callback` ships it;
   Kaizen's `lifecycle-verdict.js` reads it to decide whether the app
   advances toward `prod_gated`.

The intended-but-deferred **`preview-deploy`** job (a deploy-test that
spins up a live preview of the app and gates on its availability) is
the third seam — it would emit a `preview-status.json` artifact that
the full verdict ladder folds in via the
`preview_unavailable_required_*` reasons (compose.mjs:23-26). Not yet
built.

---

## 6. EXPOSES / CONSUMES

### EXPOSES (the pack's public contract)

- **Reusable workflow refs** (the seed target):
  - `operatum-ai/operatum-ci/.github/workflows/operatum-contract-pr.yml@v1`
  - `operatum-ai/operatum-ci/.github/workflows/operatum-contract-dispatch.yml@v1`
- **`workflow_call` input contract** — the table in §2 (stable across
  both workflows).
- **`workflow_call.secrets` surface** — exactly `callback_hmac`. The
  deliberate *absence* of provider-key secrets on the PR surface IS
  part of the exposed trust contract.
- **`kaizen-test-summary.v1` manifest shape** — `schema_version`,
  `reporter`, `reporter_version`, `verdict.contract.{result,reason}`,
  `tests`, `pr`, `github`, `audit` — the wire payload Kaizen ingests
  (compose.mjs:121-143).
- **Callback wire contract** — `POST <callback_url>/api/webhooks/test-summary`,
  `Authorization: Bearer <hmac-sha256-hex over raw manifest bytes>`,
  `X-Operatum-Tenant-Id` / `X-Operatum-Kaizen-Job-Id` headers
  (post.mjs:55-61).
- **Version pins** — `@v1` (moving) / `@v1.2.3` / `@<sha>`; `VERSION`
  file = `v1`.

### CONSUMES (what the pack depends on)

- **From the tenant repo at runtime:** `.operatum/app.json` (deploy
  manifest); `package.json` (`scripts.lint`, `engines.node`,
  Playwright dep); `.nvmrc`; lockfile (`pnpm-lock.yaml` / `yarn.lock`
  / `package-lock.json`); optional `tsconfig.json`; `junit.xml` test
  output; repo Variables `vars.OPERATUM_TENANT_ID` /
  `vars.OPERATUM_CALLBACK_URL`; repo Secret `KAIZEN_CALLBACK_HMAC`
  (mapped into `callback_hmac`); the `kaizen-trusted` GitHub
  Environment (dispatch provider-jobs, deferred).
- **From the caller:** the `with:` inputs and the `callback_hmac`
  secret mapping (§2).
- **From the Kaizen server:** the `repository_dispatch` event with
  `client_payload.{head_sha,pr_number}` (dispatch path); the
  `/api/webhooks/test-summary` ingest endpoint; the future
  `/api/owns-pr` ownership check (dispatch trust gate, deferred).
- **External actions:** `actions/checkout@v4`, `actions/setup-node@v4`,
  `actions/cache@v4`, `actions/upload-artifact@v4`,
  `actions/download-artifact@v4`; `actionlint` (self-test).
- **npm deps (build/test of the .mjs scripts only):**
  `fast-xml-parser` (JUnit parse), `js-yaml` (tests). Not shipped to
  tenants — the composite scripts run with these vendored in this
  repo's `node_modules` via `github.action_path`.

### Who consumes the pack (in operatum-kaizen)

- `src/lib/reusable-contract-workflows.js` holds the **canonical
  bytes** of the two workflows and the `operatum-ai/operatum-ci@v1`
  owner/tag (`REUSABLE_WORKFLOW_OWNER = 'operatum-ai'`).
- `src/scripts/publish-reusable-workflows.js` publishes those bytes to
  `operatum-ai/operatum-ci@v1` with the App installation token.
- `src/lib/github-repo-bootstrap.js` seeds the tenant caller workflows
  (`.github/workflows/operatum-contract.yml` +
  `operatum-ci-dispatch.yml`) referencing the published refs.
- `src/api/callback-webhooks.js` (`POST /api/webhooks/test-summary`)
  ingests the manifest; `src/lib/lifecycle-verdict.js` consumes
  `verdict.contract` to advance the app lifecycle.

---

## 7. Deferred (built-but-not-yet / documented-but-inert)

Tracked in CHANGELOG "Deferred" and the design doc; flagged here
because they change the gating contract when they land:

- The four **tenant-test slots** (unit / integration / e2e / visual)
  + their trusted provider-job siblings + marker jobs.
- **`preview-deploy`** (the live deploy-test) + **`log-capture`**.
- **Full verdict-precedence ladder** + JSON-Schema validation in
  `compose-summary`.
- **secret-scan** hard-fail-on-secret-in-diff (currently a clean stub).
- **`manifest-validate`** dedicated composite with bundled schemas
  (currently presence-only).
- **`/api/owns-pr`** dispatch trust gate (dispatch currently fails
  closed — no provider secrets ever flow).
- **`release.yml`** with composite-ref stamping (the `@v1` auto-move
  seam) + **`scripts/validate-workflows.js`** generator/validator.
- Owner divergence: this repo's internal composite `uses:` still
  reference `andreikok/operatum-ci`; the published canonical content
  targets `operatum-ai/operatum-ci`.
