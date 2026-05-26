/**
 * Initial smoke tests for actions/post-callback/post.mjs.
 *
 * The full retry/HMAC test matrix (per the design's "Callback
 * fixtures" — retry-200/500/400/401/503-then-200/network-error,
 * hmac-over-raw-bytes parity, three-headers-plus-content-type,
 * hmac-missing-warning-exit-0) lands in a follow-up commit. This
 * file pins the basics: HMAC is computed over the raw bytes (never
 * re-serialised), missing HMAC exits 0 with a warning, missing
 * callback_url exits 0 with a warning.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * Async spawn helper that returns { status, stdout, stderr } the same
 * shape spawnSync does. Required for tests where the parent process
 * runs an HTTP server the child connects to — spawnSync would
 * block the event loop and the server's `request` events would
 * never fire (classic spawnSync deadlock).
 */
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = opts.timeout
      ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeout)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

const POSTER = new URL('../actions/post-callback/post.mjs', import.meta.url).pathname;

function makeManifest(contents) {
  const root = mkdtempSync(join(tmpdir(), 'post-test-'));
  const path = join(root, 'manifest.json');
  writeFileSync(path, contents);
  return { root, path };
}

test('missing callback_url exits 0 with warning', () => {
  const { root, path } = makeManifest('{"hello":"world"}');
  try {
    const res = spawnSync('node', [POSTER], {
      env: { ...process.env, MANIFEST_PATH: path, CALLBACK_URL: '', CALLBACK_HMAC: 'k' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no callback_url/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing callback_hmac exits 0 with warning (bootstrap-race tolerance)', () => {
  const { root, path } = makeManifest('{"hello":"world"}');
  try {
    const res = spawnSync('node', [POSTER], {
      env: { ...process.env, MANIFEST_PATH: path, CALLBACK_URL: 'http://localhost:1', CALLBACK_HMAC: '' },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no callback_hmac/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HMAC is computed over the raw bytes; server verifies match', { timeout: 20000 }, async () => {
  // The composed manifest has DELIBERATE whitespace inside; if the
  // poster re-serialised, the server's recomputed HMAC over the
  // received bytes would not match. This test is the regression
  // pin against accidental re-serialisation.
  const rawBytes = '{\n  "x": 1,\n  "y": 2  \n}\n';
  const { root, path } = makeManifest(rawBytes);
  const secret = 'shared-secret-bytes';
  const expected = createHmac('sha256', secret).update(rawBytes).digest('hex');

  let received = null;
  let receivedAuth = null;
  const server = createServer((req, res) => {
    receivedAuth = req.headers.authorization;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = Buffer.concat(chunks);
      const body = 'ok';
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(Buffer.byteLength(body)),
        'Connection': 'close',
      });
      res.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Strip proxy env from the spawn so the child fetch dials
    // 127.0.0.1 directly. Inherited HTTP_PROXY/http_proxy from a
    // dev shell can route the request through a proxy that swallows
    // it and hangs.
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(HTTP|HTTPS|NO|ALL)_?PROXY$/i.test(key)) delete cleanEnv[key];
    }
    const res = await spawnAsync('node', [POSTER], {
      env: {
        ...cleanEnv,
        MANIFEST_PATH: path,
        CALLBACK_URL: `http://127.0.0.1:${port}`,
        CALLBACK_HMAC: secret,
        TENANT_ID: 't-1',
        KAIZEN_JOB_ID: 'k-1',
      },
      timeout: 15000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(received.toString('utf8'), rawBytes);
    assert.equal(receivedAuth, `Bearer ${expected}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('4xx response is not retried; exits 1 with classified error', { timeout: 20000 }, async () => {
  const { root, path } = makeManifest('{"x":1}');
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    req.on('data', () => {});
    req.on('end', () => {
      const body = 'bad shape';
      res.writeHead(400, {
        'Content-Type': 'text/plain',
        'Content-Length': String(Buffer.byteLength(body)),
        'Connection': 'close',
      });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(HTTP|HTTPS|NO|ALL)_?PROXY$/i.test(key)) delete cleanEnv[key];
    }
    const res = await spawnAsync('node', [POSTER], {
      env: {
        ...cleanEnv,
        MANIFEST_PATH: path,
        CALLBACK_URL: `http://127.0.0.1:${port}`,
        CALLBACK_HMAC: 'secret',
      },
      timeout: 15000,
    });
    assert.equal(res.status, 1);
    assert.equal(attempts, 1, 'must NOT retry 4xx');
    assert.match(res.stderr, /non-retryable 400/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
