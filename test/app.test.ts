// App surface: first-run setup, folder picker, project folder problems, board drag-and-drop, skills, login script, desktop env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, renameSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// The Plexus data folder must be set before any server module loads.
process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-app-'));
// No `git maintenance run --auto` after each commit in the throwaway repos.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });
const { dropAction } = await import('../ui/src/board.ts');

// ---- setup.test.ts
{
const testRoot = resolve('.plexus-task', 'test-runtime');
mkdirSync(testRoot, { recursive: true });
const { buildApi } = await import('../src/server/api.ts');

test('first-run setup: an empty home stays in setup until completed, even after an account is added', async () => {
  const app = await buildApi('test-token');
  const headers = { 'x-plexus-token': 'test-token' };
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/setup', headers })).json(), { onboarded: false, skipped: false });

    // An account created during setup does not count as an existing install.
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { provider: 'claude' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/setup', headers })).json().onboarded, false);

    const checks = (await app.inject({ method: 'POST', url: '/api/setup/check', headers })).json();
    for (const k of ['git', 'claude', 'codex']) assert.equal(typeof checks[k].found, 'boolean');

    assert.equal((await app.inject({ method: 'POST', url: '/api/setup/install', headers, payload: { tool: 'nope' } })).statusCode, 400);

    const done = (await app.inject({ method: 'POST', url: '/api/setup/complete', headers, payload: { skipped: true } })).json();
    assert.deepEqual(done, { onboarded: true, skipped: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/setup', headers })).json().onboarded, true);
  } finally {
    await app.close();
  }
});
}

// ---- folder-picker.test.ts
{
const testRoot = resolve('.plexus-task', 'test-runtime');
mkdirSync(testRoot, { recursive: true });
const { buildApi } = await import('../src/server/api.ts');

test('folder picker returns an absolute path, cancellation, and chosen path creates a project', async () => {
  const folder = mkdtempSync(join(testRoot, 'chosen-'));
  const choices = [folder, null];
  const app = await buildApi('test-token', { shutdown: async () => {}, chooseFolder: async () => choices.shift() ?? null });
  try {
    const headers = { 'x-plexus-token': 'test-token' };
    const unauthorized = await app.inject({ method: 'POST', url: '/api/folder-picker' });
    assert.equal(unauthorized.statusCode, 401);
    const chosen = await app.inject({ method: 'POST', url: '/api/folder-picker', headers });
    assert.deepEqual(chosen.json(), { path: folder });
    const cancelled = await app.inject({ method: 'POST', url: '/api/folder-picker', headers });
    assert.deepEqual(cancelled.json(), { path: null });
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { path: chosen.json().path, goal: 'Picker test' } });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().path, folder);
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
}

// ---- project-folder.test.ts
{
// A project whose folder is gone says so (instead of an empty task_error), and Edit project can point it at a new folder.

const root = mkdtempSync(join(tmpdir(), 'plexus-folder-'));
const { createProject, folderProblem, getProject, listMessages, moveProject, readMemory, setProjectStatus, writeMemory } = await import('../src/server/projects.ts');
const { createSession, getSession, setCliSession } = await import('../src/server/chat.ts');
const { runStreaming } = await import('../src/server/util/proc.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');

const folder = (name: string) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };

test('folderProblem: null while the folder is there, a clear reason once it is gone', () => {
  const dir = folder('present');
  assert.equal(folderProblem({ path: dir }), null);
  const why = folderProblem({ path: join(root, 'never-existed') });
  assert.match(why!, /no longer exists/);
  assert.match(why!, /Edit project/);
});

test('moving to a folder without memory copies the old memory, keeps chats and forgets the CLI conversation', () => {
  const p = createProject({ path: folder('old-a'), name: 'a', goal: 'build a' });
  writeMemory(p, 'decisions.md', '## keep me\n');
  const s = createSession(p.id, 'chat');
  setCliSession(s.id, { sessionId: 'cli-1', accountId: 'acc', syncedMessageId: 3 });
  const to = folder('new-a');
  const r = moveProject(p.id, to);
  assert.equal(r.memory, 'copied');
  assert.equal(r.project.path, to);
  assert.equal(readMemory(getProject(p.id)!, 'decisions.md'), '## keep me\n');
  assert.equal(readMemory(getProject(p.id)!, 'goal.md'), 'build a\n');
  assert.equal(getSession(s.id)!.cliSessionId, null);
  assert.ok(existsSync(join(root, 'old-a', '.plexus', 'memory', 'decisions.md')), 'the old folder is left as it was');
});

test('a folder that already has memory keeps its own', () => {
  const p = createProject({ path: folder('old-b'), name: 'b', goal: 'old goal' });
  const to = folder('new-b');
  mkdirSync(join(to, '.plexus', 'memory'), { recursive: true });
  writeFileSync(join(to, '.plexus', 'memory', 'goal.md'), 'moved goal\n');
  assert.equal(moveProject(p.id, to).memory, 'kept');
  assert.equal(readFileSync(join(to, '.plexus', 'memory', 'goal.md'), 'utf8'), 'moved goal\n');
});

test('a renamed folder: the old one is gone, the new one carries the memory', () => {
  const p = createProject({ path: folder('before-rename'), name: 'c', goal: 'goal c' });
  const to = join(root, 'after-rename');
  renameSync(p.path, to);
  assert.ok(folderProblem(getProject(p.id)!));
  assert.equal(moveProject(p.id, to).memory, 'kept');
  assert.equal(folderProblem(getProject(p.id)!), null);
  assert.equal(readMemory(getProject(p.id)!, 'goal.md'), 'goal c\n');
});

test('old folder gone and new folder empty: the move works, memory is reported as not found', () => {
  const p = createProject({ path: folder('lost'), name: 'd', goal: 'goal d' });
  rmSync(p.path, { recursive: true, force: true });
  assert.equal(moveProject(p.id, folder('fresh')).memory, 'not_found');
  assert.equal(readMemory(getProject(p.id)!, 'goal.md'), 'goal d\n', 'the goal is restored from the database');
});

test('refuses a missing folder and a folder another project uses', () => {
  const p = createProject({ path: folder('e1'), name: 'e1', goal: '' });
  const q = createProject({ path: folder('e2'), name: 'e2', goal: '' });
  assert.throws(() => moveProject(p.id, join(root, 'nope')), /Folder not found/);
  assert.throws(() => moveProject(p.id, q.path), /already uses/);
  assert.equal(getProject(p.id)!.path, join(root, 'e1'));
});

test('a process that cannot start in a missing folder says so in its log', async () => {
  const logPath = join(root, 'spawn.log');
  writeFileSync(logPath, '# output\n');
  const r = await runStreaming({ cmd: process.execPath, args: ['-e', '1'], cwd: join(root, 'gone-cwd'), env: process.env, logPath });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /working folder not found/);
  await new Promise(res => setTimeout(res, 50));
  assert.match(readFileSync(logPath, 'utf8'), /\[spawn error\] working folder not found/);
});

test('a running project whose folder disappears pauses with the reason', async () => {
  const p = createProject({ path: folder('vanishing'), name: 'f', goal: '' });
  setProjectStatus(p.id, 'running');
  rmSync(p.path, { recursive: true, force: true });
  await orchestrator.tick();
  assert.equal(getProject(p.id)!.status, 'paused');
  assert.ok(listMessages(p.id).some(m => m.meta?.level === 'attention' && /no longer exists/.test(m.text)));
  assert.throws(() => orchestrator.resume(p.id), /no longer exists/);
});
}

// ---- board-drop.test.ts
{
test('board: failed, cancelled and blocked cards dropped on Queued are retried', () => {
  for (const s of ['failed', 'cancelled', 'blocked', 'interrupted', 'done'] as const) assert.equal(dropAction(s, 'Queued'), 'retry');
  assert.equal(dropAction('pending', 'Queued'), null);
  assert.equal(dropAction('running', 'Queued'), null);
});

test('board: pending, running and blocked cards dropped on Failed or cancelled are cancelled', () => {
  for (const s of ['pending', 'interrupted', 'blocked', 'running'] as const) assert.equal(dropAction(s, 'Failed or cancelled'), 'cancel');
  assert.equal(dropAction('done', 'Failed or cancelled'), null);
  assert.equal(dropAction('failed', 'Failed or cancelled'), null);
});

test('board: columns Plexus sets itself accept no drops', () => {
  for (const col of ['Waiting for you', 'Running', 'In review', 'Done'])
    for (const s of ['pending', 'running', 'failed', 'cancelled', 'blocked', 'done'] as const) assert.equal(dropAction(s, col), null);
});
}

// ---- unit.test.ts (plat)
{

const { classifyCodexRun, codexImageArgs } = await import('../src/server/adapters/codex.ts');

const { safeFileName, sniffImage } = await import('../src/server/attachments.ts');
const { attachmentsPrompt } = await import('../src/server/adapters/types.ts');
const { classifyClaudeRun } = await import('../src/server/adapters/claude-limits.ts');
const { ensureRepo } = await import('../src/server/util/git.ts');
const { pickAccount } = await import('../src/server/orchestrator.ts');
const { readResult } = await import('../src/server/worker.ts');
const { parseCoordinatorOutput } = await import('../src/server/coordinator.ts');
const { seedRoles } = await import('../src/server/roles.ts');
const { DEFAULT_PROJECT_SETTINGS } = await import('../src/shared/types.ts');
seedRoles();

const ndjson = (...o: unknown[]) => o.map(x => JSON.stringify(x)).join('\n');

const acct = (id: string, provider: any, extra: any = {}) => ({
  id, provider, label: id, home: '', enabled: true, priority: 10, maxConcurrency: 1, state: 'ok', stateReason: null, cooldownUntil: null,
  quota: null, createdAt: '', running: 0, ...extra,
});
const project = (s: any = {}) => ({ id: 'p', name: 'p', path: '', goal: '', status: 'running', phase: 'build', mainBranch: 'main', settings: { ...DEFAULT_PROJECT_SETTINGS, ...s }, evalRounds: 0, createdAt: '' }) as any;
const task = (extra: any = {}) => ({ id: 't', projectId: 'p', seq: 1, title: '', description: '', role: 'implementer', kind: 'build', status: 'pending', deps: [], parentId: null, branch: null, worktree: null, priority: 50, attempts: 0, accountId: null, lastAccountId: null, authorAccountId: null, reviewCycles: 0, acceptance: [], result: null, error: null, createdAt: new Date().toISOString(), updatedAt: '', ...extra }) as any;

// ---------------- Phase B: issues #2, #4, #5

test('skills: created skill is enabled and copied into a worktree for both CLIs; installed skills start disabled', async () => {
  const { createSkill, installSkill, materializeSkills, listSkills } = await import('../src/server/skills.ts');
  const { existsSync } = await import('node:fs');
  createSkill('react-style', 'React conventions', 'Use function components.');
  const src = mkdtempSync(join(tmpdir(), 'skill-src-'));
  mkdirSync(join(src, 'pack', 'lint-rules'), { recursive: true });
  writeFileSync(join(src, 'pack', 'lint-rules', 'SKILL.md'), '---\nname: lint-rules\ndescription: Lint rules\n---\nRun the linter.');
  const installed = installSkill(src);
  assert.equal(installed[0].name, 'lint-rules');
  assert.equal(listSkills().find(s => s.name === 'lint-rules')?.enabled, false);
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  const used = materializeSkills(wt, ['react-style', 'lint-rules']);
  assert.deepEqual(used, ['react-style']); // disabled skill is not copied
  assert.ok(existsSync(join(wt, '.claude', 'skills', 'react-style', 'SKILL.md')));
  assert.ok(existsSync(join(wt, '.agents', 'skills', 'react-style', 'SKILL.md')));
});

test('login script quotes paths with spaces (regression: cmd /k stripped quotes)', async () => {
  const { writeLoginScript } = await import('../src/server/accounts.ts');
  const { readFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'login home '));
  const file = writeLoginScript({ id: 'codex-09', provider: 'codex', home } as any,
    { cmd: 'C:/Program Files/nodejs/node.exe', args: ['C:/npm/codex.js', 'login'], env: { CODEX_HOME: home } });
  const s = readFileSync(file, 'utf8');
  assert.ok(s.includes('"C:/Program Files/nodejs/node.exe" "C:/npm/codex.js" "login"\r\n'), s);
  assert.ok(s.includes(`set "CODEX_HOME=${home}"`));
});

test('desktop: ELECTRON_RUN_AS_NODE reaches only children run with our own binary', async () => {
  const { childEnv } = await import('../src/server/util/proc.ts');
  const env = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' };
  assert.equal(childEnv('git', env).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(childEnv('git', env).PATH, 'x');
  assert.equal(childEnv(process.execPath, env).ELECTRON_RUN_AS_NODE, '1');
  const plain = { PATH: 'x' };
  assert.equal(childEnv('git', plain), plain);
});
}
