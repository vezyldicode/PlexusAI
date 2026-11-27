// The adaptive pipeline without a team (mock agents, no quota spent):
// - no goal and no docs → Plexus asks before starting any agent, then one agent builds it (ingest → solo → done);
// - unclear docs → the analyst asks and stops; the answer lets the same analyst continue;
// - a chat request is done by one agent even on a project that was never started.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-solo');
const { orchestrator } = await import('../src/server/orchestrator.ts');

let d: TestDaemon;
let acct: any;
const call = (method: string, path: string, body?: unknown) => d.call(method, path, body);
const state = (id: string) => call('GET', `/api/projects/${id}`);
const dump = (s: any) => JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error]));
const completed = (id: string, label: string) => d.waitFor(async () => { const s = await state(id); return s.project.status === 'completed' ? s : null; }, 45_000, label);
const mkProject = (name: string, files: Record<string, string> = {}) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
};
const cfg = (c: object) => writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1, ...c }));

before(async () => {
  d = await startTestDaemon();
  acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-1', maxConcurrency: 2 });
});
after(async () => { await d?.shutdown(); });

test('no goal: the user is asked before any agent runs; after the answer one agent builds it', { timeout: 60_000 }, async () => {
  // 1. Nothing to go on: no agent starts, the user is asked. After the answer, one agent builds it.
  cfg({ mode: 'single' });
  const p1 = await call('POST', '/api/projects', { path: mkProject('empty'), start: true });
  let s1 = await state(p1.id);
  assert.equal(s1.project.phase, 'needs_input');
  assert.equal(s1.project.status, 'paused');
  assert.equal(s1.tasks.length, 0, 'no agent ran');
  assert.ok((await call('GET', `/api/projects/${p1.id}/messages`)).some((m: any) => m.meta?.level === 'attention' && /What should be built/.test(m.text)));
  await call('POST', `/api/projects/${p1.id}/actions`, { actions: [{ type: 'set_goal', goal: 'Create alpha.txt and beta.txt, one line each' }, { type: 'resume' }] });
  s1 = await completed(p1.id, 'single-agent project');
  await orchestrator.idle();
  assert.equal(s1.project.phase, 'done', dump(s1));
  assert.deepEqual(s1.tasks.map((t: any) => t.kind), ['ingest', 'solo'], 'analyst, then one agent: ' + dump(s1));
  assert.match(readdirSync(s1.project.path).sort().join('\n'), /alpha\.txt[\s\S]*beta\.txt/);
});

test('unclear docs: the analyst asks and stops; the answer unblocks it', { timeout: 60_000 }, async () => {
  // 2. Docs exist but do not say what to build: the analyst asks and nothing else runs; the answer unblocks it.
  cfg({ mode: 'single', unclearDocs: true });
  const p2 = await call('POST', '/api/projects', { path: mkProject('vague', { 'README.md': '# Vague\nSome thoughts about a tool we might want to write one day.\n' }), goal: 'Build the thing we talked about last week', start: true });
  const s2 = await d.waitFor(async () => { const s = await state(p2.id); return s.project.phase === 'needs_input' ? s : null; }, 30_000, 'analyst asks');
  await orchestrator.idle();
  assert.equal(s2.project.status, 'paused');
  assert.deepEqual(s2.tasks.map((t: any) => t.kind), ['ingest']);
  assert.ok((await call('GET', `/api/projects/${p2.id}/messages`)).some((m: any) => /Which files should be created\?/.test(m.text)));
  await call('POST', `/api/projects/${p2.id}/actions`, { actions: [{ type: 'add_directive', text: 'CLARIFIED: create alpha.txt and beta.txt' }, { type: 'resume' }] });
  const s2done = await completed(p2.id, 'clarified project');
  // The same analyst continues in its conversation after the answer (no second analyst re-reading the docs).
  assert.deepEqual(s2done.tasks.map((t: any) => t.kind), ['ingest', 'solo'], dump(s2done));
});

test('chat request on a never-started project: one solo agent does it, the pipeline stays off', { timeout: 60_000 }, async () => {
  // 3. A chat request on a project that was never started: one agent does it, the pipeline stays off.
  cfg({});
  const p3 = await call('POST', '/api/projects', { path: mkProject('chat', { 'README.md': '# Chat demo\n' }), goal: 'demo project for chat requests' });
  await call('POST', `/api/projects/${p3.id}/messages`, { text: 'do: hello world' });
  const s3 = await d.waitFor(async () => { const s = await state(p3.id); return s.tasks[0]?.status === 'done' ? s : null; }, 30_000, 'chat solo task');
  await orchestrator.idle();
  assert.equal(s3.tasks.length, 1);
  assert.equal(s3.tasks[0].kind, 'solo');
  assert.equal(s3.tasks[0].adhoc, true);
  assert.equal(s3.project.status, 'idle', 'the project pipeline was not started');
  assert.match(readdirSync(s3.project.path).sort().join('\n'), /hello-world\.txt/);
  assert.ok((await call('GET', `/api/projects/${p3.id}/messages`)).some((m: any) => m.author === 'agent' && /finished/.test(m.text)));
});
