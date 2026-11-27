// When the project folder and Plexus's finished work change the same lines, the orchestrator hands the folder's snapshot
// to one integrator task (branch plexus/folder-sync); once that task's merge lands, the result is in the folder, and
// later work flows into the folder again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-foldersync-'));
process.env.PLEXUS_HOME = join(root, 'home');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { absorbCheckout, baseRef, FOLDER_SYNC_BRANCH, mergeIntoBase, onFolderConflict, reconcile } = await import('../src/server/checkout.ts');
const { addWorktree, ensureRepo } = await import('../src/server/util/git.ts');
const { createProject, listMessages } = await import('../src/server/projects.ts');
const { getTask, listTasks, setStatus, updateTask } = await import('../src/server/tasks.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...args], { cwd, encoding: 'utf8' }).trim();
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');

const project = (path: string, id: string) => ({ id, path, mainBranch: 'main' }) as any;

/** A task: its own worktree and branch from the base, one commit, like an agent would make. */
async function taskCommit(p: any, name: string, files: Record<string, string>) {
  const wt = join(root, `wt-${name}`);
  await addWorktree(p.path, wt, { branch: `plexus/${name}`, newBranchFrom: baseRef(p) });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(wt, f), c);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', `${name} work`);
  return `plexus/${name}`;
}

/** A repo with one committed file per entry, on main, taken in by Plexus. */
async function freshProject(id: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(root, `${id}-`));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user commit');
  await ensureRepo(dir);
  const p = project(dir, id);
  assert.equal(await absorbCheckout(p), '');
  return { dir, p };
}

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

// Runs last: it replaces the orchestrator's conflict handler with its own.
test('a conflict with the folder never gets stuck: the integrator\'s merge lands, and later work flows again', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const { dir, p } = await freshProject('unstuck', { 'c.ts': lines.join('\n') + '\n', 'other.ts': 'x\n' });
  const seen: any[] = [];
  onFolderConflict((_p, r) => { seen.push(r); });
  try {
    // A task changes line 1; meanwhile the user changes line 1 too and commits it (committing used to change nothing).
    const b = await taskCommit(p, 'U1', { 'c.ts': ['line 1 (task)', ...lines.slice(1)].join('\n') + '\n', 'task.ts': 'task\n' });
    writeFileSync(join(dir, 'c.ts'), ['line 1 (user)', ...lines.slice(1)].join('\n') + '\n');
    git(dir, 'commit', '-q', '-am', 'user edit');
    const m = await mergeIntoBase(p, b, 'merge U1');
    assert.ok(m.ok);
    assert.equal(m.sync?.ok, false);
    assert.deepEqual(m.sync?.conflicts, ['c.ts']);
    assert.equal(seen.length, 1, 'the conflict handler (orchestrator → integrator task) is called');
    assert.ok(!existsSync(join(dir, 'task.ts')), 'nothing written while the conflict is open');

    // The user keeps working elsewhere, and commits: still nothing breaks.
    writeFileSync(join(dir, 'other.ts'), 'x\nuser more\n');
    git(dir, 'commit', '-q', '-am', 'more user work');

    // The integrator: branch at the folder's snapshot, merge the base in, resolve, commit.
    const wt = join(root, 'wt-folder-sync-unstuck');
    git(dir, 'branch', '-f', FOLDER_SYNC_BRANCH, seen[0].folder);
    await addWorktree(dir, wt, { branch: FOLDER_SYNC_BRANCH });
    try { git(wt, 'merge', '-q', baseRef(p)); } catch { /* conflict, resolved below */ }
    writeFileSync(join(wt, 'c.ts'), ['line 1 (user + task)', ...lines.slice(1)].join('\n') + '\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '--no-edit', '-m', 'resolve');
    const r = await mergeIntoBase(p, FOLDER_SYNC_BRANCH, 'merge folder sync');
    assert.ok(r.ok, r.detail);
    assert.ok(r.sync?.ok, JSON.stringify(r.sync));
    assert.match(read(dir, 'c.ts'), /^line 1 \(user \+ task\)$/m, 'the resolution reached the folder');
    assert.equal(read(dir, 'task.ts'), 'task\n', 'and the rest of the task too');
    assert.equal(read(dir, 'other.ts'), 'x\nuser more\n', 'the user\'s later work is kept');

    // From here on, a task's work reaches the folder directly again.
    const b2 = await taskCommit(p, 'U2', { 'later.ts': 'later\n' });
    const m2 = await mergeIntoBase(p, b2, 'merge U2');
    assert.ok(m2.sync?.ok, JSON.stringify(m2.sync));
    assert.equal(read(dir, 'later.ts'), 'later\n');
    assert.equal(seen.length, 1);
  } finally { onFolderConflict(null); }
});
