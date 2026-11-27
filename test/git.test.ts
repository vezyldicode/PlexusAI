// Git and worktrees: nested repos, worktree removal, branch pruning, the project's branch, coordinator main-checkout edits.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Plexus data folder must be set before any server module loads.
process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-git-'));
// No `git maintenance run --auto` after each commit in the throwaway repos.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });

// ---- unit.test.ts (git)
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

test('ensureRepo gives a nested folder its own repository (never commits to the parent)', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'plexus-parent-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: parent });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'parent'], { cwd: parent });
  const child = join(parent, 'sub', 'proj');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, 'README.md'), 'hi');
  const main = await ensureRepo(child);
  assert.equal(main, 'main');
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: child, encoding: 'utf8' }).trim();
  assert.equal(top.toLowerCase().replace(/\\/g, '/'), child.toLowerCase().replace(/\\/g, '/'));
  const parentLog = execFileSync('git', ['log', '--oneline'], { cwd: parent, encoding: 'utf8' }).trim().split('\n');
  assert.equal(parentLog.length, 1);
});

test('removing a worktree never deletes what a link inside it points to (node_modules junction)', async () => {
  const { removeWorktree } = await import('../src/server/util/git.ts');
  const repo = mkdtempSync(join(tmpdir(), 'plexus-wt-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a'], { cwd: repo });
  const deps = join(repo, 'node_modules', 'zod');
  mkdirSync(deps, { recursive: true });
  writeFileSync(join(deps, 'index.js'), 'x');
  const wt = join(mkdtempSync(join(tmpdir(), 'plexus-wt2-')), 'T1');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: repo });
  mkdirSync(join(wt, 'ui'));
  symlinkSync(join(repo, 'node_modules'), join(wt, 'node_modules'), 'junction');
  symlinkSync(join(repo, 'node_modules'), join(wt, 'ui', 'node_modules'), 'junction');
  await removeWorktree(repo, wt);
  assert.equal(existsSync(wt), false);
  assert.equal(existsSync(join(deps, 'index.js')), true);
});

test('finished task branches are pruned only when the base has all their work and no worktree uses them', async () => {
  const { deleteBranchIfMerged, pruneTaskBranches } = await import('../src/server/util/git.ts');
  const repo = mkdtempSync(join(tmpdir(), 'plexus-br-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  g('add', '-A'); g('commit', '-q', '-m', 'a');
  g('branch', 'plexus/T1-read-only');                          // no commits of its own (read-only task)
  g('branch', 'plexus/T2-active');                             // same, but a task still uses it
  g('branch', 'swarm/T3-old-name');                            // from before the rename
  g('checkout', '-q', '-b', 'plexus/T4-has-work');
  writeFileSync(join(repo, 'b.txt'), 'b');
  g('add', '-A'); g('commit', '-q', '-m', 'b');
  g('checkout', '-q', 'main');
  const wt = join(mkdtempSync(join(tmpdir(), 'plexus-br2-')), 'T5');
  g('worktree', 'add', '-q', '-b', 'plexus/T5-checked-out', wt, 'main');
  g('branch', 'feature/mine');                                 // the user's own branch: never Plexus's to delete

  const gone = await pruneTaskBranches(repo, 'main', new Set(['plexus/T2-active']));
  assert.deepEqual(gone.sort(), ['plexus/T1-read-only', 'swarm/T3-old-name']);
  const left = g('branch', '--format=%(refname:short)').split('\n').sort();
  assert.deepEqual(left, ['feature/mine', 'main', 'plexus/T2-active', 'plexus/T4-has-work', 'plexus/T5-checked-out']);
  // A missing base never reads as "nothing ahead".
  assert.equal(await deleteBranchIfMerged(repo, 'plexus/T2-active', 'refs/plexus/missing/base'), false);
  assert.equal(await deleteBranchIfMerged(repo, 'plexus/T2-active', 'main'), true);
});
}

// ---- branch-sync.test.ts
{
// The project's branch follows the folder: read on load and refreshed when HEAD changes on disk (git checkout / switch).

const root = mkdtempSync(join(tmpdir(), 'plexus-branch-'));
const { headBranch, startBranchWatch, stopBranchWatch, syncBranch } = await import('../src/server/branch.ts');
const { createProject, getProject } = await import('../src/server/projects.ts');
after(() => stopBranchWatch());

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...args], { cwd, encoding: 'utf8' }).trim();
function repo(): string {
  const dir = mkdtempSync(join(root, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const until = async (ok: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); return ok(); };

test('headBranch reads the checked-out branch, null when detached or not a repository', () => {
  const dir = repo();
  assert.equal(headBranch(dir), 'main');
  git(dir, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(headBranch(dir), 'feature/x');
  git(dir, 'checkout', '-q', '--detach');
  assert.equal(headBranch(dir), null);
  assert.equal(headBranch(mkdtempSync(join(root, 'plain-'))), null);
});

test('syncBranch stores the folder branch and keeps the last one on a detached HEAD', () => {
  const dir = repo();
  const p = createProject({ path: dir, name: 'sync', goal: '' });
  git(dir, 'checkout', '-q', '-b', 'UI');
  syncBranch(p.id);
  assert.equal(getProject(p.id)!.mainBranch, 'UI');
  git(dir, 'checkout', '-q', '--detach');
  syncBranch(p.id);
  assert.equal(getProject(p.id)!.mainBranch, 'UI');
});

test('a branch switch on disk updates the project without a reload', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'optimize');
  const p = createProject({ path: dir, name: 'watch', goal: '' });
  startBranchWatch();
  assert.equal(getProject(p.id)!.mainBranch, 'optimize', 'read when the watch starts');
  git(dir, 'checkout', '-q', 'main');
  assert.ok(await until(() => getProject(p.id)!.mainBranch === 'main'), 'follows git checkout');
  git(dir, 'switch', '-q', '-c', 'next');
  assert.ok(await until(() => getProject(p.id)!.mainBranch === 'next'), 'follows git switch -c');
});
}

// ---- coordinator-work.test.ts
{
// Work the coordinator does itself (main-checkout edits, merged workspace) is recorded as a finished `coordinator` task.

const root = mkdtempSync(join(tmpdir(), 'plexus-coordwork-'));
const { createProject, updateProject } = await import('../src/server/projects.ts');
const { prepareProjectRepo } = await import('../src/server/checkout.ts');
const { beginMainEdit, commitMainEdit } = await import('../src/server/coordinator.ts');
const { listTasks } = await import('../src/server/tasks.ts');
const { createSession } = await import('../src/server/chat.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...args], { cwd, encoding: 'utf8' }).trim();

test('a main-checkout edit becomes a done coordinator task with its message, files and chat session', async () => {
  const p = createProject({ path: join(root, 'proj'), goal: 'x' });
  writeFileSync(join(p.path, 'a.txt'), 'a\n');
  writeFileSync(join(p.path, 'user.txt'), 'user work\n');
  git(p.path, 'init', '-q', '-b', 'main');
  git(p.path, 'add', '-A');
  git(p.path, 'commit', '-qm', 'init');
  const { mainBranch } = await prepareProjectRepo(p);
  updateProject(p.id, { mainBranch });
  writeFileSync(join(p.path, 'user.txt'), 'user work, uncommitted\n'); // the user's own edit before the coordinator starts
  const s = createSession(p.id, 'chat');

  await beginMainEdit(p.id);
  writeFileSync(join(p.path, 'a.txt'), 'changed\n');
  writeFileSync(join(p.path, 'new.txt'), 'new\n');
  await commitMainEdit(p.id, 'fix: change a\nmore detail', s.id);

  const rec = listTasks(p.id).filter(t => t.kind === 'coordinator');
  assert.equal(rec.length, 1);
  const t = rec[0];
  assert.equal(t.status, 'done');
  assert.equal(t.adhoc, true);
  assert.equal(t.title, 'fix: change a');
  assert.equal(t.originSessionId, s.id);
  assert.deepEqual([...t.paths].sort(), ['a.txt', 'new.txt']); // not user.txt: it was already changed before begin
  assert.match(t.result?.summary ?? '', /2 files changed/);

  // Nothing changed: no record.
  await beginMainEdit(p.id);
  await commitMainEdit(p.id, 'noop', s.id);
  assert.equal(listTasks(p.id).filter(t => t.kind === 'coordinator').length, 1);
});

const { coordinatorWorkspace, mergeCoordinatorWorkspace, closeSessionWorkspace } = await import('../src/server/coordinator.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');

async function freshProject(name: string) {
  const p = createProject({ path: join(root, name), goal: 'x' });
  writeFileSync(join(p.path, 'a.txt'), 'a\n');
  git(p.path, 'init', '-q', '-b', 'main');
  git(p.path, 'add', '-A');
  git(p.path, 'commit', '-qm', 'init');
  const { mainBranch } = await prepareProjectRepo(p);
  updateProject(p.id, { mainBranch });
  return p;
}
const wtPath = (text: string) => text.match(/Your worktree: (.+?) \(branch/)![1];

test('two chat sessions get their own coordinator worktrees: merging one keeps the other one\'s work', async () => {
  const p = await freshProject('two-ws');
  const a = createSession(p.id, 'light theme'), b = createSession(p.id, 'vietnamese');
  const wa = wtPath(await coordinatorWorkspace(p.id, a.id));
  const wb = wtPath(await coordinatorWorkspace(p.id, b.id));
  assert.notEqual(wa, wb);
  writeFileSync(join(wa, 'theme.css'), 'light\n');
  writeFileSync(join(wb, 'vi.json'), '{}\n');

  assert.match(await mergeCoordinatorWorkspace(p.id, 'feat: light theme', a.id), /Merged/);
  assert.ok(existsSync(join(wb, 'vi.json')), "b's unfinished edit survives a's merge");
  assert.ok(!existsSync(join(wb, 'theme.css')), "a's work is not in b's worktree");
  const rec = listTasks(p.id).filter(t => t.kind === 'coordinator');
  assert.deepEqual(rec.map(t => [t.originSessionId, t.paths]), [[a.id, ['theme.css']]]);

  // Deleting b keeps its unmerged edit on its branch and removes the worktree.
  await closeSessionWorkspace(p.id, b.id);
  assert.ok(!existsSync(wb));
  const branch = git(p.path, 'branch', '--list', 'plexus/coord-*', '--format=%(refname:short)').split('\n').filter(x => x.includes(b.id.split('-').pop()!));
  assert.equal(branch.length, 1, "b's branch with its work stays");
  assert.match(git(p.path, 'show', '--stat', '--format=', branch[0]), /vi\.json/);
});

test('only one chat session edits the main checkout at a time', async () => {
  const p = await freshProject('one-main');
  const a = createSession(p.id, 'a'), b = createSession(p.id, 'b');
  assert.match(await beginMainEdit(p.id, a.id), /You may edit/);
  assert.match(await beginMainEdit(p.id, b.id), /Not started: another chat session/);
  assert.match(await commitMainEdit(p.id, 'x', b.id), /Nothing done/);
  assert.equal(orchestrator.mainHolder(p.id), a.id, "b's commit does not release a's hold");
  writeFileSync(join(p.path, 'a.txt'), 'by a\n');
  await commitMainEdit(p.id, 'edit a', a.id);
  assert.equal(orchestrator.mainHolder(p.id), undefined);
  assert.match(await beginMainEdit(p.id, b.id), /You may edit/);
  await closeSessionWorkspace(p.id, b.id);
  assert.equal(orchestrator.mainHolder(p.id), undefined, 'deleting the holding session releases the folder');
});
}
