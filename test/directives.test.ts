// Scoped directives: each reader gets only the directives meant for it (coordinator, agents, roles, paths), in every
// prompt that carries them, and a resumed conversation gets them again only when they changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-dir-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { createProject, memoryDir, readMemory, writeMemory } = await import('../src/server/projects.ts');
const { createTask, getTask, updateTask } = await import('../src/server/tasks.ts');
const { applyActions } = await import('../src/server/coordinator.ts');
const { directivesFor, parseScope, scopeApplies } = await import('../src/server/directives.ts');
const { buildCoordinatorPrompt, buildForkPrompt, buildResumePrompt, buildTaskParts } = await import('../src/server/prompts.ts');
const { writeContextFiles } = await import('../src/server/context.ts');
const { getRole, seedRoles } = await import('../src/server/roles.ts');
seedRoles();

const project = () => createProject({ path: join(root, `p-${Math.random().toString(16).slice(2, 8)}`), goal: 'Build it' });
const status = { tasks: '', accounts: '', events: '', counts: '{}' };
const account = { id: 'acc', provider: 'claude' } as any;

test('scope tags are parsed and matched exactly', () => {
  assert.equal(parseScope('- Reply in Vietnamese.'), null);
  assert.deepEqual(parseScope('- [for: implementer, QA; paths: ui/**,src/ui] Use Tailwind.'), { for: ['implementer', 'qa'], paths: ['ui/**', 'src/ui'] });
  const coord = parseScope('- [for: coordinator] Propose first.');
  assert.ok(scopeApplies(coord, { role: 'coordinator' }));
  assert.ok(!scopeApplies(coord, { role: 'implementer', paths: [] }));
  const agents = parseScope('- [for: agents] Run the tests.');
  assert.ok(!scopeApplies(agents, { role: 'coordinator' }));
  assert.ok(scopeApplies(agents, { role: 'qa', paths: [] }));
  const ui = parseScope('- [for: implementer; paths: ui/**] Use Tailwind.');
  assert.ok(scopeApplies(ui, { role: 'implementer', paths: ['ui/src/App.tsx'] }));
  assert.ok(!scopeApplies(ui, { role: 'implementer', paths: ['src/server/api.ts'] }));
  assert.ok(scopeApplies(ui, { role: 'implementer', paths: [] }), 'a task without paths gets it: never drop a rule on a guess');
  assert.ok(!scopeApplies(ui, { role: 'reviewer', paths: ['ui/x.ts'] }));
});

test('add_directive writes the scope; the same text again replaces the line', () => {
  const p = project();
  const r1 = applyActions(p.id, [{ type: 'add_directive', text: 'Propose a plan before editing code', for: ['coordinator'] } as any]);
  assert.match(r1[0], /added \[for: coordinator\]/);
  applyActions(p.id, [{ type: 'add_directive', text: 'Reply in Vietnamese' } as any]);
  const r2 = applyActions(p.id, [{ type: 'add_directive', text: 'Propose a plan before editing code', for: ['coordinator', 'planner'] } as any]);
  assert.match(r2[0], /updated/);
  const md = readMemory(p, 'directives.md');
  assert.equal(md.match(/Propose a plan/g)!.length, 1);
  assert.match(md, /- \[for: coordinator,planner\] Propose a plan before editing code/);
  assert.match(md, /- Reply in Vietnamese/);
});

test('every prompt carries only the reader\'s directives', () => {
  const p = project();
  writeMemory(p, 'directives.md', [
    '- Reply in Vietnamese. _(t)_',
    '- [for: coordinator] Propose a plan before editing code. _(t)_',
    '- [for: agents] Run the tests before finishing. _(t)_',
    '- [for: implementer; paths: ui/**] Use Tailwind. _(t)_',
  ].join('\n'));

  const coord = buildCoordinatorPrompt(p, status, [], 'hi');
  assert.match(coord, /Propose a plan/);
  assert.match(coord, /Vietnamese/);
  assert.doesNotMatch(coord, /Run the tests|Tailwind/);

  const back = createTask(p.id, { title: 'API', role: 'implementer', kind: 'build', paths: ['src/server/api.ts'] });
  const { prompt } = buildTaskParts(p, back, getRole('implementer'), account, '', []);
  assert.match(prompt, /Run the tests/);
  assert.match(prompt, /Vietnamese/);
  assert.doesNotMatch(prompt, /Propose a plan|Tailwind/);

  const front = createTask(p.id, { title: 'UI', role: 'implementer', kind: 'build', paths: ['ui/src/App.tsx'] });
  assert.match(buildTaskParts(p, front, getRole('implementer'), account, '', []).prompt, /Tailwind/);

  const wt = join(root, `wt-${back.seq}`);
  writeContextFiles(p, wt, back);
  const copy = readFileSync(join(wt, '.plexus-task', 'context', 'directives.md'), 'utf8');
  assert.match(copy, /Run the tests/);
  assert.doesNotMatch(copy, /Propose a plan/, 'the full copy is filtered too');

  const solo = createTask(p.id, { title: 'Fix', role: 'solo', kind: 'solo', adhoc: true });
  const fork = buildForkPrompt(p, solo, getRole('solo'), 'SYSTEM');
  assert.match(fork, /replace any directives in the conversation above[\s\S]*Run the tests/);
  assert.doesNotMatch(fork, /Propose a plan/);
});

test('a resumed conversation gets directives again only when they changed', () => {
  const p = project();
  writeMemory(p, 'directives.md', '- [for: agents] Run the tests. _(t)_\n- [for: coordinator] Propose first. _(t)_');
  const t = createTask(p.id, { title: 'Fix', role: 'solo', kind: 'solo', adhoc: true });
  const f = join(memoryDir(p), 'directives.md');
  const old = new Date('2001-01-01T00:00:00Z');
  utimesSync(f, old, old);
  updateTask(t.id, { cliUsedAt: '2002-01-01T00:00:00.000Z' });
  assert.doesNotMatch(buildResumePrompt(p, getTask(t.id)!, getRole('solo'), ''), /Directives from the user/, 'unchanged: already in the conversation');

  writeMemory(p, 'directives.md', '- [for: coordinator] Propose first. _(t)_');
  const changed = buildResumePrompt(p, getTask(t.id)!, getRole('solo'), '');
  assert.match(changed, /replaces any earlier one\)\n\(none for you now/, 'a removed directive is withdrawn');
  assert.doesNotMatch(changed, /Propose first/);
  assert.equal(directivesFor(p, { role: 'coordinator' }), '- [for: coordinator] Propose first. _(t)_');
});
