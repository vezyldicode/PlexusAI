// Stop in the middle of a task, restart the daemon, resume, and still finish; an agent also crashes mid-task once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'plexus-res-'));
process.env.PLEXUS_HOME = join(root, 'home');
const { startDaemon } = await import('../src/server/main.ts');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('stop → daemon restart → resume completes; crashed attempt is retried', { timeout: 300_000 }, async () => {
  let d = await startDaemon({ port: 0, quiet: true });
  const mk = (dd: typeof d) => async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${dd.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': dd.token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
  };
  let call = mk(d);
  const a = await call('POST', '/api/accounts', { provider: 'mock', id: 'm1', maxConcurrency: 2 });
  writeFileSync(join(a.home, 'mock.json'), JSON.stringify({ delayMs: 400, steps: 4, crashMidTask: true }));
  const proj = join(root, 'proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'GOAL.md'), 'Create alpha.txt and beta.txt');
  const p = await call('POST', '/api/projects', { path: proj, start: true, settings: { reviewEnabled: false, maxParallel: 2 } });

  // wait until a build task is running, then stop
  for (let i = 0; i < 200; i++) {
    const s = await call('GET', `/api/projects/${p.id}`);
    if (s.tasks.some((t: any) => t.kind === 'build' && t.status === 'running')) break;
    await sleep(200);
  }
  await call('POST', `/api/projects/${p.id}/stop`);
  await sleep(1500);
  let s = await call('GET', `/api/projects/${p.id}`);
  assert.equal(s.project.status, 'stopped');
  assert.ok(s.tasks.some((t: any) => t.status === 'interrupted'), 'stopped task is interrupted, not lost');
  assert.ok(!s.tasks.some((t: any) => t.status === 'running'));

  // restart the daemon (same data folder)
  await d.shutdown();
  d = await startDaemon({ port: 0, quiet: true });
  call = mk(d);
  await call('POST', `/api/projects/${p.id}/resume`);
  for (let i = 0; i < 600; i++) {
    s = await call('GET', `/api/projects/${p.id}`);
    if (s.project.status === 'completed') break;
    await sleep(300);
  }
  try {
    assert.equal(s.project.phase, 'done', JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error])));
    const crashed = s.tasks.filter((t: any) => t.attempts > 0);
    assert.ok(crashed.length > 0, 'a crashed attempt was recorded and retried');
    const files = readdirSync(proj).sort().join('\n');
    assert.match(files, /alpha\.txt/);
    assert.match(files, /beta\.txt/);
  } finally { await d.shutdown(); }
});
