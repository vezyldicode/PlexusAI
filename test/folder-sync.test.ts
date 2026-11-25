// When the project folder and Plexus's finished work change the same lines, the orchestrator hands the folder's snapshot
// to one integrator task (branch plexus/folder-sync); once that task's merge lands, the result is in the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-foldersync-'));
process.env.PLEXUS_HOME = join(root, 'home');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { absorbCheckout, baseRef, FOLDER_SYNC_BRANCH, mergeIntoBase, reconcile } = await import('../src/server/checkout.ts');
const { addWorktree } = await import('../src/server/util/git.ts');
const { createProject, listMessages } = await import('../src/server/projects.ts');
const { getTask, listTasks, setStatus, updateTask } = await import('../src/server/tasks.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...args], { cwd, encoding: 'utf8' }).trim();
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');

test('a folder conflict becomes one integrator task, and its merge reaches the folder', { timeout: 60_000 }, async () => {
  const dir = join(root, 'proj');
  const p0 = createProject({ path: dir, name: 'fs', goal: '' });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'c.ts'), 'top\nmiddle\nbottom\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user commit');
  const p = { ...p0, mainBranch: 'main' };
  assert.equal(await absorbCheckout(p), '');

  // Plexus's work and the user's edit change the same line.
  const wt = join(root, 'wt-task');
  await addWorktree(dir, wt, { branch: 'plexus/T1', newBranchFrom: baseRef(p) });
  writeFileSync(join(wt, 'c.ts'), 'top\nmiddle (task)\nbottom\n');
  git(wt, 'commit', '-q', '-am', 'task');
  writeFileSync(join(dir, 'c.ts'), 'top\nmiddle (user)\nbottom\n');
  const m = await mergeIntoBase(p, 'plexus/T1', 'merge T1');
  assert.ok(m.ok);
  assert.equal(m.sync?.ok, false);

  const sync = listTasks(p.id).filter(t => t.branch === FOLDER_SYNC_BRANCH);
  assert.equal(sync.length, 1, 'one integrator task');
  const t = sync[0];
  assert.equal(t.role, 'integrator');
  assert.equal(t.kind, 'integrate');
  assert.equal(t.adhoc, true, 'runs even while the pipeline is idle or paused');
  assert.deepEqual(t.paths, ['c.ts']);
  assert.ok(listMessages(p.id).some((x: any) => x.text.includes('change the same lines') && x.text.includes(`T${t.seq}`)), 'the chat is told');
  assert.equal(read(dir, 'c.ts'), 'top\nmiddle (user)\nbottom\n', 'the folder is untouched');

  // Another reconcile while it is open (a task starting, the next merge) does not add a second one.
  await reconcile(p);
  assert.equal(listTasks(p.id).filter(x => x.branch === FOLDER_SYNC_BRANCH).length, 1);

  // The integrator's work: merge the base into the folder's branch, resolve, commit; then the task finishes.
  const iwt = join(root, 'wt-sync');
  await addWorktree(dir, iwt, { branch: FOLDER_SYNC_BRANCH });
  try { git(iwt, 'merge', '-q', baseRef(p)); } catch { /* conflict */ }
  writeFileSync(join(iwt, 'c.ts'), 'top\nmiddle (user, task)\nbottom\n');
  git(iwt, 'add', '-A');
  git(iwt, 'commit', '-q', '--no-edit', '-m', 'resolve');
  updateTask(t.id, { worktree: iwt }, true); // as prepareWorktree records it
  setStatus(t.id, 'done');
  await (orchestrator as any).merge(p, getTask(t.id)!);
  assert.equal(read(dir, 'c.ts'), 'top\nmiddle (user, task)\nbottom\n', 'the resolution is in the folder');
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '1', 'still no commit on the user\'s branch');
  assert.equal(git(dir, 'branch', '--list', FOLDER_SYNC_BRANCH), '', 'the internal branch is gone');
  assert.equal((await reconcile(p)).ok, true, 'folder and base agree now');
});
