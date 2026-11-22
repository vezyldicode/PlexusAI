import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const testRoot = resolve('.plexus-task', 'test-runtime');
mkdirSync(testRoot, { recursive: true });
process.env.PLEXUS_HOME = mkdtempSync(join(testRoot, 'home-'));
const { buildApi } = await import('../src/server/api.ts');

test('folder picker returns an absolute path, cancellation, and chosen path creates a project', async () => {
  const folder = mkdtempSync(join(testRoot, 'chosen-'));
  const choices = [folder, null];
  const app = await buildApi('test-token', { shutdown: async () => {}, chooseFolder: async () => choices.shift() ?? null });
  try {
    const headers = { 'x-plexus-token': 'test-token' };
    const unauthorized = await app.inject({ method: 'POST', url: '/api/folder-picker' });
    assert.equal(unauthorized.statusCode, 401);
    const chosen = await app.inject({ method: 'POST', url: '/api/folder-picker', headers });
    assert.deepEqual(chosen.json(), { path: folder });
    const cancelled = await app.inject({ method: 'POST', url: '/api/folder-picker', headers });
    assert.deepEqual(cancelled.json(), { path: null });
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { path: chosen.json().path, goal: 'Picker test' } });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().path, folder);
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
