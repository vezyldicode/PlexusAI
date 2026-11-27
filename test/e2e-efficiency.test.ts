// Token efficiency with mock agents (docs/06-efficiency-and-coordinator-research.md):
// - a blocked result is not retried: the task waits for a message, and runs again only with it;
// - gap rounds continue the previous round's conversation (a lane), and a round without progress stops to ask instead of looping.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-eff');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');
const { createTask } = await import('../src/server/tasks.ts');

let d: TestDaemon;
let acct: any;
const call = (method: string, path: string, body?: unknown) => d.call(method, path, body);
const state = (id: string) => call('GET', `/api/projects/${id}`);
const dump = (s: any) => JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.laneFrom?.split('-').pop() ?? null, t.error]));
const mkProject = (name: string, files: Record<string, string> = {}) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
};
const logOf = (pid: string, seq: number, run = 1) => {
  const f = readdirSync(join(paths.logs, pid)).find(x => x.startsWith(`T${seq}-r${run}-`));
  return f ? readFileSync(join(paths.logs, pid, f), 'utf8') : '';
};
const messages = (pid: string) => call('GET', `/api/projects/${pid}/messages`);
const cfg = (c: object) => writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1, ...c }));

before(async () => {
  d = await startTestDaemon();
  acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a', maxConcurrency: 3 });
});
after(async () => { await d?.shutdown(); });

test('blocked result: no automatic retry; the task waits and a message wakes it up', { timeout: 60_000 }, async () => {
  // 1. A blocked agent is not retried with the same input: one run, the task waits; a message wakes it up.
  cfg({ blockKinds: ['build'] });
  const p1 = await call('POST', '/api/projects', { path: mkProject('blocked', { 'README.md': '# Blocked\n' }), goal: 'demo of a blocked task' });
  const t1 = createTask(p1.id, { title: 'Write the file', description: 'FILE: out.txt', role: 'implementer', kind: 'build', adhoc: true });
  void orchestrator.tick();
  await d.waitFor(async () => (await state(p1.id)).tasks[0]?.status === 'blocked', 30_000, 'blocked task');
  await orchestrator.idle();
  assert.equal((await call('GET', `/api/tasks/${t1.id}`)).runs.length, 1, 'no automatic retry of a blocked result');
  assert.ok((await messages(p1.id)).some((m: any) => m.meta?.level === 'attention' && /blocked and waits for you/.test(m.text)));
  await call('POST', `/api/tasks/${t1.id}/message`, { text: 'Write out.txt' });
  await d.waitFor(async () => (await state(p1.id)).tasks[0]?.status === 'done', 30_000, 'unblocked task done');
  await orchestrator.idle();
  assert.match(logOf(p1.id, 1, 2), /## Messages for you[\s\S]*Write out\.txt/, 'the message is in the next run');
  assert.ok(logOf(p1.id, 1, 1), 'each run has its own log (r1, r2)');
  assert.equal((await state(p1.id)).tasks[0].inbox.length, 0, 'delivered messages leave the inbox');
});

test('gap rounds: round 2 continues round 1, a round without progress stops and asks, resume finishes', { timeout: 120_000 }, async () => {
  // 2. Single-agent build: round 2 continues round 1's conversation; a round without progress stops and asks.
  cfg({ mode: 'single', soloFirstFiles: ['alpha.txt'], soloNoProgress: true });
  const p2 = await call('POST', '/api/projects', { path: mkProject('gaps', { 'GOAL.md': 'Create alpha.txt and beta.txt' }), start: true });
  const waiting = await d.waitFor(async () => { const s = await state(p2.id); return s.project.phase === 'waiting' ? s : null; }, 60_000, 'stalled rounds stop');
  await orchestrator.idle();
  assert.equal(waiting.project.status, 'paused');
  assert.deepEqual(waiting.tasks.map((t: any) => t.kind), ['ingest', 'solo', 'solo'], 'no third round without progress: ' + dump(waiting));
  const round2 = waiting.tasks[2];
  assert.equal(round2.laneFrom, waiting.tasks[1].id, 'round 2 continues round 1');
  const r2log = logOf(p2.id, round2.seq);
  assert.match(r2log, /# prompt \(resuming mock-/, 'round 2 resumed the conversation');
  assert.doesNotMatch(r2log, /# RULES/, 'no rules, brief or full criteria again');
  assert.ok(existsSync(join(waiting.project.path, '.plexus', 'memory', 'open-gaps.md')));
  assert.ok(existsSync(join(waiting.project.path, '.plexus', 'memory', 'handoff', `T${waiting.tasks[1].seq}.md`)), 'round notes outlive the worktree');
  assert.ok((await messages(p2.id)).some((m: any) => m.meta?.level === 'attention' && /stopped instead of starting another round/.test(m.text)));
  // The user fixed the cause: resume continues with the open gaps, in the same lane, and finishes.
  cfg({ mode: 'single' });
  await call('POST', `/api/projects/${p2.id}/resume`, {});
  const done2 = await d.waitFor(async () => { const s = await state(p2.id); return s.project.status === 'completed' ? s : null; }, 60_000, 'resumed build completes');
  await orchestrator.idle();
  assert.equal(done2.project.phase, 'done', dump(done2));
  assert.equal(done2.tasks.at(-1).laneFrom, round2.id);
  assert.match(readdirSync(done2.project.path).sort().join('\n'), /beta\.txt/);
});
