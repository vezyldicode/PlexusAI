// Context budget with mock agents: a run that compacts too often is stopped and checkpoints in a short turn.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-budget');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');
const { createTask, getTask } = await import('../src/server/tasks.ts');

let d: TestDaemon;
before(async () => { d = await startTestDaemon(); });
after(async () => { await d?.shutdown(); });

test('context budget: the run is stopped, checkpoints in a short turn and reports partial', { timeout: 60_000 }, async () => {
  const { call } = d;
  const acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-speed', maxConcurrency: 2 });
  // delayMs stays well above the kill latency, also on a loaded machine (full parallel suite): with a shorter step the mock
  // reaches its 5th compaction before the stop lands.
  writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 400, steps: 1, compactions: 5 }));
  const dir = join(root, 'budget');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Budget\n');
  const p = await call('POST', '/api/projects', { path: dir, goal: 'demo of the context budget' });
  const t = createTask(p.id, { title: 'Big work', description: 'FILE: big.txt', role: 'implementer', kind: 'build', adhoc: true });
  void orchestrator.tick();
  await d.waitFor(() => ['done', 'failed', 'in_review'].includes(getTask(t.id)!.status), 45_000, 'budget task finished or in review');
  orchestrator.pause(p.id);
  await orchestrator.idle();
  const done = getTask(t.id)!;
  // A partial result is reviewed before it is merged (reviewPolicy auto): that is the normal path.
  assert.ok(['done', 'in_review'].includes(done.status), `${done.status} ${done.error}`);
  assert.equal(done.result?.status, 'partial');
  const runs = (await call('GET', `/api/tasks/${t.id}`)).runs;
  assert.equal(runs.length, 1, 'stop and checkpoint happen in one attempt');
  const timing = runs[0].timing;
  assert.ok(timing, 'the run records where its time went');
  assert.ok(timing.compactions >= 2 && timing.compactions < 5, `stopped after the second compaction (default budget): ${timing.compactions}`);
  assert.ok(timing.totalMs >= timing.modelMs && timing.startupMs > 0);
  const log = readFileSync(join(paths.logs, p.id, readdirSync(join(paths.logs, p.id)).find(f => f.startsWith(`T${done.seq}-r1-`))!), 'utf8');
  assert.match(log, /STOP: CONTEXT BUDGET SPENT/);
  assert.match(log, /# prompt \(resuming mock-/, 'the checkpoint continues the same conversation');
});
