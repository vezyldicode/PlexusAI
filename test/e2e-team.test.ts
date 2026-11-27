// A team build with mock agents: the team build skips the planner (the architect plans), and the fix after review resumes the author's conversation.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-team');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');

let d: TestDaemon;
let acct: any;
const call = (method: string, path: string, body?: unknown) => d.call(method, path, body);
const state = (id: string) => call('GET', `/api/projects/${id}`);
const dump = (s: any) => JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error]));
const completed = (id: string, label: string) => d.waitFor(async () => { const s = await state(id); return s.project.status === 'completed' ? s : null; }, 100_000, label);
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

test('team build: architect plans, no QA step, the fix after review resumes the author conversation', { timeout: 120_000 }, async () => {
  // 4. Team build: the architect plans (no planner step), no QA step by default, and the fix after review continues
  //    the author's CLI conversation (same account, same worktree) instead of starting cold.
  cfg({ mode: 'team', rejectReviewOnce: true });
  const p4 = await call('POST', '/api/projects', {
    path: mkProject('team', { 'GOAL.md': 'Create alpha.txt and beta.txt' }), start: true,
    settings: { reviewPolicy: 'always', independentReviewWaitMin: 0 },
  });
  const s4 = await completed(p4.id, 'team project');
  await orchestrator.idle();
  const kinds = s4.tasks.map((t: any) => t.kind);
  assert.equal(s4.project.phase, 'done', dump(s4));
  assert.ok(!kinds.includes('plan'), 'architect planned: ' + dump(s4));
  assert.ok(!kinds.includes('qa'), 'no QA step by default: ' + dump(s4));
  const fixes = s4.tasks.filter((t: any) => t.kind === 'fix');
  assert.ok(fixes.length >= 1, 'a review asked for changes: ' + dump(s4));
  const logs = readdirSync(join(paths.logs, p4.id));
  const fixLog = readFileSync(join(paths.logs, p4.id, logs.find(f => f.startsWith(`T${fixes[0].seq}-`))!), 'utf8');
  assert.match(fixLog, /# prompt \(resuming mock-/, 'the fix resumed the author conversation');
  assert.match(fixLog, /# NEXT STEP IN THIS CONVERSATION/);
  assert.doesNotMatch(fixLog, /# RULES/, 'the resumed prompt does not repeat rules and project context');
});
