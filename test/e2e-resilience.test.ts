// Stop in the middle of a task, restart the daemon, resume, and still finish; an agent also crashes mid-task once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome } from './helpers.ts';

const root = testHome('plexus-res');

test('stop → daemon restart → resume completes; crashed attempt is retried', { timeout: 120_000 }, async () => {
  let d = await startTestDaemon();
  try {
    const a = await d.call('POST', '/api/accounts', { provider: 'mock', id: 'm1', maxConcurrency: 2 });
    // Each step must outlast the poll below, so the stop lands while a build is still running.
    writeFileSync(join(a.home, 'mock.json'), JSON.stringify({ delayMs: 60, steps: 2, crashMidTask: true }));
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'GOAL.md'), 'Create alpha.txt and beta.txt');
    const p = await d.call('POST', '/api/projects', { path: proj, start: true, settings: { reviewEnabled: false, maxParallel: 2 } });
    const state = () => d.call('GET', `/api/projects/${p.id}`);

    await d.waitFor(async () => (await state()).tasks.some((t: any) => t.kind === 'build' && t.status === 'running'), 30_000, 'a build task running');
    await d.call('POST', `/api/projects/${p.id}/stop`);
    let s = await d.waitFor(async () => { const s = await state(); return s.project.status === 'stopped' && !s.tasks.some((t: any) => t.status === 'running') ? s : null; },
      10_000, 'project stopped with no task running');
    assert.equal(s.project.status, 'stopped');
    assert.ok(s.tasks.some((t: any) => t.status === 'interrupted'), 'stopped task is interrupted, not lost');
    assert.ok(!s.tasks.some((t: any) => t.status === 'running'));

    // restart the daemon (same data folder)
    await d.shutdown();
    d = await startTestDaemon();
    await d.call('POST', `/api/projects/${p.id}/resume`);
    s = await d.waitFor(async () => { const s = await state(); return s.project.status === 'completed' ? s : null; }, 90_000, 'project completed after resume');
    assert.equal(s.project.phase, 'done', JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error])));
    const crashed = s.tasks.filter((t: any) => t.attempts > 0);
    assert.ok(crashed.length > 0, 'a crashed attempt was recorded and retried');
    const files = readdirSync(proj).sort().join('\n');
    assert.match(files, /alpha\.txt/);
    assert.match(files, /beta\.txt/);
  } finally { await d.shutdown(); }
});
