// Unit checks for the token-efficiency pieces: memory hygiene, resume thresholds, per-call context metrics, gap prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-effu-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { createProject, appendIssues, appendMemory, readMemory, removeDirectives, writeAcceptance, writeMemory, readAcceptance } = await import('../src/server/projects.ts');
const { createTask, getTask, updateTask } = await import('../src/server/tasks.ts');
const { buildTaskParts, buildTaskPrompt, buildResumePrompt } = await import('../src/server/prompts.ts');
const { resumeWorthIt, LANE_CTX_MAX, readResult } = await import('../src/server/worker.ts');
const { claudeUsage, invocationUsage, addUsage, usageOf } = await import('../src/server/usage.ts');
const { getRole, seedRoles } = await import('../src/server/roles.ts');
const { pickAccount } = await import('../src/server/orchestrator.ts');
const { DEFAULT_PROJECT_SETTINGS } = await import('../src/shared/types.ts');
seedRoles();

const account = { id: 'acc', provider: 'mock' } as any;
const project = () => createProject({ path: join(root, `p-${Math.random().toString(16).slice(2, 8)}`), goal: 'Build it' });

test('known issues are not recorded twice', () => {
  const p = project();
  assert.equal(appendIssues(p, 'T3', ['git diff --check reports trailing whitespace', 'missing pycryptodome']), 2);
  assert.equal(appendIssues(p, 'T4', ['Git diff --check reports  trailing whitespace', 'new one']), 1);
  const md = readMemory(p, 'known-issues.md');
  assert.equal(md.match(/trailing whitespace/g)!.length, 1);
  assert.match(md, /- \[T4\] new one/);
});

test('a directive can be removed by its text', () => {
  const p = project();
  appendMemory(p, 'directives.md', '- Reply in Vietnamese. _(t)_\n- Give the refactor to account claude-01. _(t)_');
  assert.equal(removeDirectives(p, 'account claude-01').length, 1);
  assert.equal(removeDirectives(p, 'nothing like this').length, 0);
  assert.match(readMemory(p, 'directives.md'), /Vietnamese/);
  assert.doesNotMatch(readMemory(p, 'directives.md'), /claude-01/);
});

test('resume only while it is cheaper than a fresh start', () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  assert.equal(resumeWorthIt(35_000, now), true);
  assert.equal(resumeWorthIt(LANE_CTX_MAX + 1, now), false, 'too large: every call would re-read it');
  assert.equal(resumeWorthIt(90_000, old), false, 'cache expired and not small');
  assert.equal(resumeWorthIt(20_000, old), true, 'small conversations are worth it even cold');
});

test('per-call context sizes are measured from the Claude stream', () => {
  const ev = (id: string, ctx: [number, number, number]) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-x', usage: { input_tokens: ctx[0], cache_read_input_tokens: ctx[1], cache_creation_input_tokens: ctx[2], output_tokens: 5 } } });
  const out = [ev('a', [10, 16_000, 14_000]), ev('b', [5, 30_000, 2_000]), ev('c', [5, 32_000, 8_000]),
    JSON.stringify({ type: 'result', usage: { input_tokens: 20, cache_read_input_tokens: 78_000, cache_creation_input_tokens: 24_000, output_tokens: 15 } })].join('\n');
  assert.deepEqual(claudeUsage(out).ctxs, [30_010, 32_005, 40_005]);
  const u = invocationUsage('claude', out, {})!;
  assert.equal(u.calls, 3);
  assert.equal(u.firstCtx, 30_010);
  assert.equal(u.maxCtx, 40_005);
  assert.equal(u.lastCtx, 40_005);
  const both = addUsage(u, { ...usageOf({}), calls: 1, firstCtx: 9_000, maxCtx: 9_000, lastCtx: 9_000 })!;
  assert.equal(both.calls, 4);
  assert.equal(both.lastCtx, 9_000);
});

test('a gap round gets only its open criteria, no evidence, the code map and the previous notes', () => {
  const p = project();
  writeMemory(p, 'brief.md', '# Brief\n' + 'Long brief paragraph. '.repeat(300));
  writeMemory(p, 'summary.md', 'Short summary.');
  writeMemory(p, 'codemap.md', '- src/app.py: entry point');
  writeAcceptance(p, [
    { id: 'AC1', criterion: 'compiles', verify: 'python -m compileall', pass: true, evidence: 'EVIDENCE-ONE' },
    { id: 'AC2', criterion: 'popup works', verify: 'manual: copy text', pass: 'blocked', evidence: 'needs GUI' },
    { id: 'AC3', criterion: 'storage round-trips', verify: 'pytest tests/storage', pass: false, evidence: 'EVIDENCE-THREE' },
  ]);
  assert.equal(readAcceptance(p)[1].pass, 'blocked');
  assert.match(readMemory(p, 'acceptance.md'), /- \[~\] \*\*AC2\*\*/);
  const r1 = createTask(p.id, { title: 'Build the project (single agent)', role: 'solo', kind: 'solo' });
  const full = buildTaskPrompt(p, r1, getRole('solo'), account, '', []);
  assert.match(full, /Long brief paragraph/);
  assert.doesNotMatch(full, /EVIDENCE-ONE/, 'evidence stays in acceptance.md');
  const gap = createTask(p.id, { title: 'Close the remaining gaps (round 2)', description: '- AC3 fails: EVIDENCE-THREE', role: 'solo', kind: 'solo', acIds: ['AC3'] });
  const { system, prompt } = buildTaskParts(p, gap, getRole('solo'), account, '', []);
  assert.match(system, /^# RULES[\s\S]*# YOUR ROLE: solo/);
  assert.doesNotMatch(prompt, /# RULES/, 'rules go to the system prompt');
  assert.doesNotMatch(prompt, /Long brief paragraph/, 'summary only');
  assert.match(prompt, /\*\*AC3\*\*/);
  assert.doesNotMatch(prompt, /\*\*AC1\*\*/);
  assert.match(prompt, /src\/app\.py: entry point/);
  assert.ok(full.length > prompt.length + system.length);
  // Messages are delivered in the prompt; a resumed step sees decisions recorded after its last call.
  updateTask(gap.id, { inbox: ['Use the venv in .venv'], cliUsedAt: '2000-01-01T00:00:00.000Z' });
  const resumed = buildResumePrompt(p, getTask(gap.id)!, getRole('solo'), '');
  assert.match(resumed, /## Messages for you[\s\S]*Use the venv/);
});

test('the pinned account wins while it can run; otherwise another one', () => {
  const p = { settings: DEFAULT_PROJECT_SETTINGS } as any;
  const acc = (id: string, extra = {}) => ({ id, provider: 'claude', enabled: true, state: 'ok', running: 0, maxConcurrency: 1, priority: 10, quota: null, cooldownUntil: null, ...extra }) as any;
  const t = { role: 'solo', kind: 'solo', status: 'pending', pinnedAccountId: 'b', cliAccountId: null, lastAccountId: null, createdAt: new Date().toISOString() } as any;
  assert.equal(pickAccount(p, t, [acc('a'), acc('b')])!.id, 'b');
  assert.equal(pickAccount(p, t, [acc('a'), acc('b', { state: 'limited' })])!.id, 'a');
});

test('a result file mangled by a code page loses to the copy in the reply', () => {
  const wt = mkdtempSync(join(tmpdir(), 'plexus-res-'));
  mkdirSync(join(wt, '.plexus-task'), { recursive: true });
  writeFileSync(join(wt, '.plexus-task', 'result.json'), JSON.stringify({ status: 'partial', summary: '?? ki?m ch?ng l?i' }));
  const r = readResult(wt, 'done\n```json\n{"status":"partial","summary":"Đã kiểm chứng lại"}\n```');
  assert.equal(r!.summary, 'Đã kiểm chứng lại');
});
