// A chat request while the project is paused: the coordinator's pipeline task runs to the end (review, fix, merge)
// without the pipeline, the unfinished pipeline tasks stay untouched, and the coordinator cannot resume them on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome } from './helpers.ts';

const root = testHome('plexus-paused');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { applyActions } = await import('../src/server/coordinator.ts');
const { createTask, getTask, listTasks, updateTask } = await import('../src/server/tasks.ts');
const { mustProject, updateProject } = await import('../src/server/projects.ts');

test('a request task while paused runs to completion; the paused pipeline is not touched', { timeout: 60_000 }, async () => {
  const d = await startTestDaemon();
  const { call } = d;
  try {
    const acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-p', maxConcurrency: 2 });
    writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, rejectReviewOnce: true }));
    const dir = join(root, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Paused\n');
    const p = await call('POST', '/api/projects', { path: dir, goal: 'demo', settings: { reviewPolicy: 'always', independentReviewWaitMin: 0 } });

    // Unfinished pipeline work, then the user pauses.
    const old = createTask(p.id, { title: 'Old pipeline work', description: 'FILE: old.txt', role: 'implementer', kind: 'build' });
    updateTask(old.id, { status: 'interrupted', error: 'stopped by user' });
    const waiting = createTask(p.id, { title: 'Old follow-up', description: 'FILE: old2.txt', role: 'implementer', kind: 'build', deps: [old.id] });
    orchestrator.pause(p.id);

    // The coordinator answers a chat request with a pipeline task (it names the old task as a dependency by mistake).
    const applied = applyActions(p.id, [{ type: 'add_task', title: 'User request', description: 'FILE: asked.txt', role: 'implementer', depends_on: [`T${old.seq}`] } as any], 'coordinator');
    assert.match(applied.join(), /runs now for this request/);
    assert.match(applied.join(), new RegExp(`not waiting for T${old.seq}`));
    const req = listTasks(p.id).find(t => t.title === 'User request')!;
    assert.equal(req.adhoc, true);
    assert.deepEqual(req.deps, []);

    await d.waitFor(() => ['done', 'failed', 'cancelled'].includes(getTask(req.id)!.status), 45_000, 'request task finished');
    await orchestrator.idle();

    const done = getTask(req.id)!;
    assert.equal(done.status, 'done', `${done.status} ${done.error}`);
    const chain = listTasks(p.id).filter(t => t.seq > req.seq);
    assert.ok(chain.some(t => t.kind === 'review'), 'the request was reviewed while paused');
    assert.ok(chain.some(t => t.kind === 'fix'), 'and its review comments fixed while paused');
    assert.ok(chain.every(t => t.adhoc && t.status === 'done'), chain.map(t => `T${t.seq} ${t.kind} ${t.status} adhoc=${t.adhoc}`).join(', '));
    assert.ok(existsSync(join(dir, 'asked.txt')), 'the request was merged into the project folder');
    const msgs = await call('GET', `/api/projects/${p.id}/messages`);
    assert.ok(msgs.some((m: any) => m.text.includes(`T${req.seq} "User request" finished`)), 'the chat hears that the request is done');

    // The paused pipeline was not touched.
    assert.equal(mustProject(p.id).status, 'paused');
    assert.equal(getTask(old.id)!.status, 'interrupted');
    assert.equal(getTask(waiting.id)!.status, 'pending');
    assert.ok(!existsSync(join(dir, 'old.txt')));

    // The coordinator cannot restart that work by itself; the user can (approved proposal, Resume button).
    updateProject(p.id, { phase: 'build' }); // as if the pipeline had been paused mid-build
    const held = applyActions(p.id, [{ type: 'resume' } as any], 'coordinator');
    assert.match(held.join(), /resume held: 2 unfinished pipeline task\(s\)/);
    assert.equal(mustProject(p.id).status, 'paused');
    const viaTool = await call('POST', `/api/projects/${p.id}/actions`, { actions: [{ type: 'resume' }], by: 'coordinator' });
    assert.match(viaTool.applied.join(), /resume held/);
    assert.equal(mustProject(p.id).status, 'paused');
    applyActions(p.id, [{ type: 'resume' } as any], 'approved proposal');
    assert.equal(mustProject(p.id).status, 'running');
    orchestrator.pause(p.id);
    await orchestrator.idle();
  } finally {
    await d.shutdown();
  }
});
