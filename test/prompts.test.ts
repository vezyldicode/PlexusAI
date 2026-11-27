// Prompts and project memory: per-task context, the coordinator prompt, memory hygiene and resume thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Plexus data folder must be set before any server module loads.
process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-prompts-'));
// No `git maintenance run --auto` after each commit in the throwaway repos.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });

// ---- prompt-context.test.ts
{
// Prompt size control: each task gets only the project memory it needs, the rest is in .plexus-task/context/.

const root = mkdtempSync(join(tmpdir(), 'plexus-ctx-'));

const { createProject, recordDecision, readDecisions, parseDecisions, replaceDecisions, writeAcceptance, writeMemory, appendMemory, readMemory } = await import('../src/server/projects.ts');
const { createTask, getTask } = await import('../src/server/tasks.ts');
const { buildTaskPrompt } = await import('../src/server/prompts.ts');
const { taskAcIds, writeContextFiles, projectSummary } = await import('../src/server/context.ts');
const { getRole, seedRoles } = await import('../src/server/roles.ts');
seedRoles();

const account = { id: 'acc', provider: 'mock' } as any;

function setup() {
  const p = createProject({ path: join(root, `proj-${Math.random().toString(16).slice(2, 8)}`), goal: 'Build the thing' });
  writeMemory(p, 'brief.md', '# Brief\n\n' + 'Long brief paragraph. '.repeat(400));
  writeMemory(p, 'summary.md', 'Short summary of the project.');
  writeAcceptance(p, Array.from({ length: 30 }, (_, i) => ({ id: `AC${i + 1}`, criterion: `criterion number ${i + 1} `.repeat(8), verify: 'npm test', pass: null })));
  recordDecision(p, { title: 'Use vitest', decision: 'Tests run with vitest', rationale: 'fast' }, 'T2 (architect, acc)');
  recordDecision(p, { title: 'Auth tokens in cookies', decision: 'Store the session in an httpOnly cookie', paths: ['src/auth/'] }, 'T4 (implementer, acc)');
  recordDecision(p, { title: 'Report format', decision: 'Reports are CSV', ac_ids: ['AC7'] }, 'T6 (implementer, acc)');
  for (let i = 0; i < 20; i++) recordDecision(p, { title: `Unrelated decision ${i}`, decision: 'x'.repeat(300), rationale: 'y'.repeat(200) }, 'T9 (implementer, acc)');
  appendMemory(p, 'known-issues.md', '- [T3] flaky test in reports\n- [T8] slow build');
  return p;
}

test('decisions.md round-trips through parseDecisions, including scope', () => {
  const p = setup();
  const all = readDecisions(p);
  assert.equal(all.length, 23);
  const auth = all.find(d => d.title === 'Auth tokens in cookies')!;
  assert.deepEqual(auth.paths, ['src/auth/']);
  assert.equal(auth.by, 'T4 (implementer, acc)');
  assert.deepEqual(all.find(d => d.title === 'Report format')!.ac_ids, ['AC7']);
  // Older entries (no Scope line) still parse.
  assert.equal(parseDecisions('\n## Old\n- Decision: kept\n- By: T1 · 2026-01-01\n')[0].decision, 'kept');
});

test('a build task gets only its criteria and the decisions that concern it', () => {
  const p = setup();
  const t = createTask(p.id, { title: 'Reports page', description: 'Build src/auth/login.ts and the report (AC3)', role: 'implementer', kind: 'build', acIds: ['ac7'], paths: ['src/auth/login.ts'] });
  assert.deepEqual(taskAcIds(t), ['AC7', 'AC3']);
  const prompt = buildTaskPrompt(p, t, getRole('implementer'), account, '', []);
  assert.match(prompt, /\*\*AC7\*\*/);
  assert.match(prompt, /\*\*AC3\*\*/);
  assert.doesNotMatch(prompt, /\*\*AC12\*\*/);
  assert.match(prompt, /Store the session in an httpOnly cookie/); // paths overlap
  assert.match(prompt, /Reports are CSV/); // same AC
  assert.doesNotMatch(prompt, /x{300}/); // unrelated decisions: titles only
  assert.match(prompt, /- Unrelated decision 3\n/);
  assert.match(prompt, /Short summary of the project/);
  assert.doesNotMatch(prompt, /Long brief paragraph/);
  assert.match(prompt, /^# RULES/);
  assert.match(prompt, /<!-- plexus-meta[\s\S]*-->$/); // task-specific meta last, shared parts first
  // Rules and role are the fixed part of a role's prompts (the CLI's cached system prompt), project context follows.
  assert.ok(prompt.indexOf('# YOUR ROLE') < prompt.indexOf('# PROJECT:'));
  assert.ok(prompt.indexOf('# PROJECT:') < prompt.indexOf('# TASK '));

  const planner = createTask(p.id, { title: 'Plan', role: 'planner', kind: 'plan' });
  const planPrompt = buildTaskPrompt(p, planner, getRole('planner'), account, '', []);
  assert.match(planPrompt, /Long brief paragraph/);
  assert.match(planPrompt, /\*\*AC12\*\*/);
  assert.ok(prompt.length < planPrompt.length / 2, `build ${prompt.length} vs plan ${planPrompt.length}`);
});

test('fix tasks inherit criteria and see their own chain\'s decisions and issues', () => {
  const p = setup();
  const build = createTask(p.id, { title: 'Reports', role: 'implementer', kind: 'build', acIds: ['AC5'] });
  const review = createTask(p.id, { title: 'Review', role: 'reviewer', kind: 'review', parentId: build.id });
  const fix = createTask(p.id, { title: 'Fix', role: 'implementer', kind: 'fix', parentId: review.id });
  assert.deepEqual(getTask(fix.id)!.acIds, ['AC5']);
  recordDecision(p, { title: 'Chain decision', decision: 'made by the build task' }, `T${build.seq} (implementer, acc)`);
  appendMemory(p, 'known-issues.md', `- [T${build.seq}] issue of the chain`);
  const prompt = buildTaskPrompt(p, getTask(fix.id)!, getRole('implementer'), account, '', []);
  assert.match(prompt, /made by the build task/);
  assert.match(prompt, /issue of the chain/);
  assert.doesNotMatch(prompt, /slow build/);
  assert.match(prompt, /\*\*AC5\*\*/);
});

test('full memory is written to .plexus-task/context in the worktree', () => {
  const p = setup();
  const wt = mkdtempSync(join(root, 'wt-'));
  writeContextFiles(p, wt);
  for (const f of ['brief.md', 'acceptance.md', 'decisions.md', 'known-issues.md', 'directives.md']) assert.ok(existsSync(join(wt, '.plexus-task', 'context', f)), f);
  assert.match(readFileSync(join(wt, '.plexus-task', 'context', 'decisions.md'), 'utf8'), /x{300}/);
});

test('summary falls back to the start of the brief', () => {
  const p = setup();
  writeMemory(p, 'summary.md', '');
  const s = projectSummary(p);
  assert.ok(s.length < 2_200);
  assert.match(s, /full brief in/);
});

test('replaceDecisions keeps decisions recorded after the librarian snapshot', () => {
  const p = setup();
  const covered = readDecisions(p).length;
  recordDecision(p, { title: 'Late decision', decision: 'after the snapshot' }, 'T20 (implementer, acc)');
  replaceDecisions(p, [{ title: 'Digest', decision: 'everything so far', rationale: '', paths: [], ac_ids: [] }], covered, 'T21 (acc)');
  const after = readDecisions(p);
  assert.deepEqual(after.map(d => d.title), ['Digest', 'Late decision']);
  assert.match(readMemory(p, 'decisions-archive.md'), /Unrelated decision 19/);
});
}

// ---- coordinator-prompt.test.ts
{
// The coordinator's prompt: static instructions in the system prompt, the rule to read the project only when needed,
// each instruction in one place, and a short status digest.

const root = mkdtempSync(join(tmpdir(), 'plexus-coordprompt-'));

const { createProject } = await import('../src/server/projects.ts');
const { buildCoordinatorPrompt, buildCoordinatorSystem, buildCoordinatorTurnPrompt } = await import('../src/server/prompts.ts');
const { eventLine, statusDigest } = await import('../src/server/coordinator.ts');
const { getRole, seedRoles } = await import('../src/server/roles.ts');
const { systemArgs } = await import('../src/server/adapters/claude.ts');
const { withSystem } = await import('../src/server/adapters/mcp-config.ts');
seedRoles();

const p = createProject({ path: join(root, 'proj'), goal: 'Build the thing' });
const role = getRole('coordinator');
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, 'g')) ?? []).length;

test('the coordinator reads the project only when the answer depends on it', () => {
  const sys = buildCoordinatorSystem(p, role, true);
  assert.match(sys, /Read the project only when the answer depends on it/);
  assert.match(sys, /General questions \(a git command, syntax, a concept\) are answered\s+directly, without tools/);
  assert.match(sys, /answered from STATUS when it is enough, otherwise look it up yourself/);
  assert.match(sys, /never ask the user to paste a file or a log/);
  assert.doesNotMatch(sys, /Look before you answer|Look things up yourself/);
});

test('static instructions go in the system prompt, the variable part in the user message', () => {
  const sys = buildCoordinatorSystem(p, role, true);
  for (const h of ['# YOUR ROLE: coordinator', '# HOW YOU WORK', '# OUTPUT']) assert.ok(sys.includes(h), h);
  const prompt = buildCoordinatorPrompt(p, statusDigest(p.id), [], 'which branch is the project on?');
  for (const h of ['# YOUR ROLE', '# HOW YOU WORK', '# OUTPUT\n', 'Action types']) assert.ok(!prompt.includes(h), h);
  assert.match(prompt, /# STATUS/);
  assert.match(prompt, /# CHAT HISTORY/);
  assert.match(prompt, /USER MESSAGE:\nwhich branch is the project on\?/);
  const turn = buildCoordinatorTurnPrompt(p, statusDigest(p.id), [], 'git command to switch branch?', true);
  assert.ok(!turn.includes('Action types') && !turn.includes('# YOUR ROLE'));
  assert.match(turn, /only where the answer needs them/);
});

test('the Claude CLI gets the system prompt on every coordinator turn, other CLIs at the head of the first prompt', () => {
  const system = 'SYS';
  assert.deepEqual(systemArgs({ system }).slice(0, 2), ['--append-system-prompt', 'SYS']);
  assert.deepEqual(systemArgs({ system, resumeId: 'r1' }), []);
  assert.deepEqual(systemArgs({ system, resumeId: 'r1', systemOnResume: true }).slice(0, 2), ['--append-system-prompt', 'SYS']);
  // Without a system-prompt option the text is in the conversation from its first turn on: not sent again.
  assert.equal(withSystem({ system, prompt: 'P' } as any), 'SYS\n\nP');
  assert.equal(withSystem({ system, prompt: 'P', resumeId: 'r1', systemOnResume: true } as any), 'P');
});

test('each coordinator instruction is said once', () => {
  for (const tools of [true, false]) {
    const all = buildCoordinatorSystem(p, role, tools) + buildCoordinatorPrompt(p, statusDigest(p.id), [], 'hi');
    assert.equal(count(all, /plexus_main_begin first/), tools ? 1 : 0);
    assert.equal(count(all, /cheapest first/i), 1);
    assert.equal(count(all, /re-reads the context/), 1);
    assert.equal(count(all, /assign_account \(or `account` on solo_task\)/), 1);
    assert.equal(count(all, /did not ask for/), 1);
    assert.equal(count(all, /needs_input/), 1);
  }
  // OUTPUT lists the actions, one per line.
  const out = buildCoordinatorSystem(p, role, true).split('# OUTPUT')[1].split('Action types:\n')[1];
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 17);
  for (const l of lines) assert.equal(count(l, /\{"type":/), 1, l);
});

test('status events are one short line each', () => {
  const line = eventLine({ type: 'task.result', createdAt: '2026-11-23T05:25:41.000Z', data: { id: 'x-5', seq: 5, title: 'Kéo thả thẻ trong tab Tasks để đổi trạng thái của một task rất dài', status: 'done', summary: 'x'.repeat(900) } });
  assert.equal(line, '05:25 T5 result done Kéo thả thẻ trong tab Tasks để đổi trạng thái của một task …');
  assert.equal(eventLine({ type: 'project.status', createdAt: '2026-11-23T05:26:00.000Z', data: { status: 'paused' } }), '05:26 project.status paused');
  assert.ok(eventLine({ type: 'orchestrator.error', createdAt: '2026-11-23T05:27:00.000Z', data: { task: 'abc-7', message: 'merge: conflict\nstack...' } }).endsWith('7 orchestrator.error merge: conflict'));
});
}

// ---- efficiency-unit.test.ts
{
// Unit checks for the token-efficiency pieces: memory hygiene, resume thresholds, per-call context metrics, gap prompts.

const root = mkdtempSync(join(tmpdir(), 'plexus-effu-'));

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
}
