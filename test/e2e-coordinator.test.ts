// The coordinator with mock agents (docs/06-efficiency-and-coordinator-research.md):
// - a pinned account is used when it can run, another one takes over when it cannot;
// - the coordinator reaches Plexus through its MCP tools, and can remove directives and continue an agent's work.
// The tests run in order on one project: the first one's task is the one the coordinator inspects and continues.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-coord');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');

let d: TestDaemon;
let acct: any;
const call = (method: string, path: string, body?: unknown) => d.call(method, path, body);
const state = (id: string) => call('GET', `/api/projects/${id}`);
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
let p3: any;
let s3: any;
const say = async (text: string, n: number) => {
  await call('POST', `/api/projects/${p3.id}/messages`, { text });
  return d.waitFor(async () => { const ms = (await messages(p3.id)).filter((m: any) => m.author === 'coordinator'); return ms.length >= n ? ms.at(-1) : null; }, 30_000, `reply ${n}`);
};
const cfg = (c: object) => writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1, ...c }));

before(async () => {
  d = await startTestDaemon();
  acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a', maxConcurrency: 3 });
});
after(async () => { await d?.shutdown(); });

test('pinned account: used when it can run; while it cannot, another one takes over with a notice', { timeout: 60_000 }, async () => {
  // 3. A pinned account runs the task when it can; while it cannot, another one takes over (with a notice).
  cfg({});
  const b = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-b' });
  writeFileSync(join(b.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1 }));
  await call('PATCH', '/api/accounts/mock-b', { enabled: false });
  p3 = await call('POST', '/api/projects', { path: mkProject('pin', { 'README.md': '# Pin\n' }), goal: 'pin demo' });
  await call('POST', `/api/projects/${p3.id}/actions`, { actions: [{ type: 'solo_task', title: 'pinned work', description: 'FILE: pinned.txt', account: 'mock-b' }] });
  s3 = await d.waitFor(async () => { const s = await state(p3.id); return s.tasks[0]?.status === 'done' ? s : null; }, 30_000, 'pinned task done elsewhere');
  await orchestrator.idle();
  assert.equal(s3.tasks[0].pinnedAccountId, 'mock-b');
  assert.equal(s3.tasks[0].lastAccountId, 'mock-a');
  assert.ok((await messages(p3.id)).some((m: any) => /pinned to mock-b, which cannot run now/.test(m.text)));
});

test('coordinator tools: status, add and remove a directive, read a task log through MCP', { timeout: 60_000 }, async () => {
  // 4. The coordinator uses its plexus tools (MCP server → daemon API), and can undo a directive.
  const r1 = await say('mcp: plexus_status', 1);
  assert.match(r1.text, /TOOL: \[plexus tools: 9\] Project pin/, r1.text);
  assert.equal(r1.meta.tools, true);
  const r2 = await say('mcp: plexus_action {"action":{"type":"add_directive","text":"Give the refactor to account mock-b"}}', 2);
  assert.match(r2.text, /directive added/);
  assert.match((await call('GET', `/api/projects/${p3.id}/memory`))['directives.md'], /mock-b/);
  await say('action: {"type":"remove_directive","match":"refactor to account"}', 3);
  assert.doesNotMatch((await call('GET', `/api/projects/${p3.id}/memory`))['directives.md'], /mock-b/);
  const r4 = await say(`mcp: plexus_task_log {"id":"T${s3.tasks[0].seq}"}`, 4);
  assert.match(r4.text, /run \d+ on mock-a \(success\)/, r4.text);
});

test('continue_task: more work for the same agent, in its conversation', { timeout: 60_000 }, async () => {
  // 5. continue_task: more work for the same agent, in its conversation (no fresh context).
  await say(`action: {"type":"continue_task","task_id":"T${s3.tasks[0].seq}","instructions":"Also FILE: more.txt"}`, 5);
  const s5 = await d.waitFor(async () => { const s = await state(p3.id); return s.tasks.length === 2 && s.tasks[1].status === 'done' ? s : null; }, 30_000, 'continued task');
  await orchestrator.idle();
  assert.equal(s5.tasks[1].laneFrom, s5.tasks[0].id);
  assert.match(logOf(p3.id, s5.tasks[1].seq), /# prompt \(resuming mock-[\s\S]*# NEXT STEP IN THIS CONVERSATION/);
});
