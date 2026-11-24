// The project's branch follows the folder: read on load and refreshed when HEAD changes on disk (git checkout / switch).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-branch-'));
process.env.PLEXUS_HOME = join(root, 'home');
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
