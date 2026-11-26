// The coordinator's prompt: static instructions in the system prompt, the rule to read the project only when needed,
// each instruction in one place, and a short status digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-coordprompt-'));
process.env.PLEXUS_HOME = join(root, 'home');

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
