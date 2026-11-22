import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

const testRoot = resolve('.plexus-task', 'test-runtime');
mkdirSync(testRoot, { recursive: true });
process.env.PLEXUS_HOME = mkdtempSync(join(testRoot, 'home-'));
const { buildApi } = await import('../src/server/api.ts');

test('first-run setup: an empty home stays in setup until completed, even after an account is added', async () => {
  const app = await buildApi('test-token');
  const headers = { 'x-plexus-token': 'test-token' };
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/setup', headers })).json(), { onboarded: false, skipped: false });

    // An account created during setup does not count as an existing install.
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { provider: 'claude' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/setup', headers })).json().onboarded, false);

    const checks = (await app.inject({ method: 'POST', url: '/api/setup/check', headers })).json();
    for (const k of ['git', 'claude', 'codex']) assert.equal(typeof checks[k].found, 'boolean');

    assert.equal((await app.inject({ method: 'POST', url: '/api/setup/install', headers, payload: { tool: 'nope' } })).statusCode, 400);

    const done = (await app.inject({ method: 'POST', url: '/api/setup/complete', headers, payload: { skipped: true } })).json();
    assert.deepEqual(done, { onboarded: true, skipped: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/setup', headers })).json().onboarded, true);
  } finally {
    await app.close();
  }
});
