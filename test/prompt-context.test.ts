// Prompt size control: each task gets only the project memory it needs, the rest is in .plexus-task/context/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-ctx-'));
process.env.PLEXUS_HOME = join(root, 'home');

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
