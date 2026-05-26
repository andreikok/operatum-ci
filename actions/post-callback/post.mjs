#!/usr/bin/env node
/**
 * post.mjs — HMAC-signed POST of the composed manifest to Kaizen.
 *
 * The HMAC is computed over the RAW bytes read from disk; we
 * never re-serialise the JSON before signing. Kaizen's
 * /api/webhooks/test-summary verifies the HMAC against the same
 * raw bytes it receives, so any re-serialisation here would
 * cause valid manifests to fail HMAC verification on the server.
 *
 * Retry posture (round-7 PR-56 review):
 *   - Network errors → retry up to 3 attempts (1s/2s/4s backoff)
 *   - 5xx responses → retry up to 3 attempts (same backoff)
 *   - 4xx responses → do NOT retry; surface the body and exit 1
 *   - 2xx → log + exit 0
 *
 * HMAC-missing posture: empty CALLBACK_HMAC → emit a warning and
 * exit 0 (bootstrap-race tolerance; the design pins this as
 * deliberate — Kaizen is happy to lose one manifest while the
 * tenant's secret-sync is racing).
 */

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const {
  MANIFEST_PATH = 'kaizen-test-summary.json',
  CALLBACK_URL,
  CALLBACK_HMAC,
  TENANT_ID,
  KAIZEN_JOB_ID,
} = process.env;

if (!CALLBACK_URL) {
  console.log('::warning::post-callback: no callback_url; skipping POST');
  process.exit(0);
}
if (!CALLBACK_HMAC) {
  console.log('::warning::post-callback: no callback_hmac secret; skipping POST (bootstrap race tolerance)');
  process.exit(0);
}

let body;
try {
  body = readFileSync(MANIFEST_PATH);
} catch (err) {
  console.error(`::error::post-callback: cannot read ${MANIFEST_PATH}: ${err.message}`);
  process.exit(1);
}

const hmac = createHmac('sha256', CALLBACK_HMAC).update(body).digest('hex');

// KB-5 § "Webhook callback shape" pins the URL suffix + the bearer
// scheme. The bearer is the HMAC hex; Kaizen recomputes and compares.
const url = CALLBACK_URL.replace(/\/+$/, '') + '/api/webhooks/test-summary';
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${hmac}`,
  'X-Operatum-Tenant-Id': TENANT_ID || '',
  'X-Operatum-Kaizen-Job-Id': KAIZEN_JOB_ID || '',
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

class NonRetryableCallbackError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'NonRetryableCallbackError';
  }
}

async function postOnce() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  if (res.status >= 200 && res.status < 300) {
    return { status: res.status, body: text };
  }
  if (res.status >= 400 && res.status < 500) {
    throw new NonRetryableCallbackError(
      `callback ${res.status}: ${text.slice(0, 512)}`,
      res.status,
    );
  }
  // 5xx → throw retryable
  const err = new Error(`callback ${res.status}: ${text.slice(0, 512)}`);
  err.status = res.status;
  throw err;
}

async function postWithRetry() {
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await postOnce();
    } catch (err) {
      if (err instanceof NonRetryableCallbackError) throw err;
      lastErr = err;
      if (i < MAX_ATTEMPTS - 1) {
        const wait = BACKOFF_MS[i];
        console.log(`post-callback: attempt ${i + 1}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastErr;
}

try {
  const { status, body: respBody } = await postWithRetry();
  console.log(`post-callback: POST ${url} → ${status} (${respBody.length} bytes)`);
} catch (err) {
  if (err instanceof NonRetryableCallbackError) {
    console.error(`::error::post-callback: non-retryable ${err.status}: ${err.message}`);
  } else {
    console.error(`::error::post-callback: retries exhausted: ${err.message}`);
  }
  process.exit(1);
}
