// Plexus never commits on the user's branches (default, Settings → Advanced → "Commit to my branches" off): it works on
// a hidden base ref and delivers finished work into the project folder as uncommitted changes, never over the user's edits.
import { describe, test as base } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-nocommit-'));
process.env.PLEXUS_HOME = join(root, 'home');
const { absorbCheckout, baseRef, ensureBase, FOLDER_SYNC_BRANCH, mergeIntoBase, onFolderConflict, syncCheckout } = await import('../src/server/checkout.ts');
const { ensureRepo, addWorktree } = await import('../src/server/util/git.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@u', ...args], { cwd, encoding: 'utf8' }).trim();
/** File content with the line endings git would write here normalized (core.autocrlf may be on). */
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
// Every test works in its own repository: they run at the same time (git is most of the wait).
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => { tests.push([name, fn]); };
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

test('a new folder gets a repository but no commit', async () => {
  const dir = mkdtempSync(join(root, 'fresh-'));
  writeFileSync(join(dir, 'README.md'), 'hi');
  assert.equal(await ensureRepo(dir), 'main');
  assert.throws(() => git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD'));
  const p = project(dir, 'fresh');
  assert.equal(await absorbCheckout(p), '');
  assert.match(git(dir, 'ls-tree', '--name-only', baseRef(p)), /README\.md/, 'the base holds the folder as it is');
  assert.throws(() => git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD'), 'still no commit on any branch');
});

test('work is merged on the hidden base and lands uncommitted; the user\'s edits are never overwritten', async () => {
  const dir = mkdtempSync(join(root, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'u.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user commit');
  const head = git(dir, 'rev-parse', 'HEAD');
  // Uncommitted work of the user: a modified tracked file and a new file.
  writeFileSync(join(dir, 'u.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'mine.txt'), 'draft\n');

  await ensureRepo(dir);
  const p = project(dir, 'repo');
  assert.equal(await absorbCheckout(p), '');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no snapshot commit');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'the index is untouched');
  assert.equal(git(dir, 'show', `${baseRef(p)}:mine.txt`), 'draft', 'tasks see the user\'s uncommitted work');

  // A task adds a file and changes u.txt; the merge happens off the user's branch.
  const b1 = await taskCommit(p, 'T1', { 'a.txt': 'from T1\n', 'u.txt': 'one\ntwo\nthree\n' });
  const m1 = await mergeIntoBase(p, b1, 'merge T1');
  assert.ok(m1.ok, m1.detail);
  assert.ok(m1.sync?.ok);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
  assert.equal(git(dir, 'rev-parse', 'refs/heads/main'), head, 'main did not move');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'still on the user\'s branch');
  assert.equal(read(dir, 'a.txt'), 'from T1\n');
  assert.equal(read(dir, 'u.txt'), 'one\ntwo\nthree\n');
  assert.equal(read(dir, 'mine.txt'), 'draft\n', 'the user\'s draft is kept');
  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /\?\? a\.txt/);
  assert.match(status, /^ ?M u\.txt$/m, 'modified, not staged');

  // The user edits u.txt while the next task also changes it: nothing is written, the edit stays.
  const b2 = await taskCommit(p, 'T2', { 'u.txt': 'one\ntwo\nthree\nfour\n', 'b.txt': 'from T2\n' });
  writeFileSync(join(dir, 'u.txt'), 'user edit\n');
  const m2 = await mergeIntoBase(p, b2, 'merge T2');
  assert.ok(m2.ok, 'the merge itself succeeds on the base');
  assert.equal(m2.sync?.ok, false);
  assert.deepEqual(m2.sync?.conflicts, ['u.txt']);
  assert.ok(m2.sync?.folder, 'the folder\'s snapshot is handed out for an integrator');
  assert.equal(read(dir, 'u.txt'), 'user edit\n', 'the user\'s edit is not overwritten');
  assert.ok(!existsSync(join(dir, 'b.txt')), 'all or nothing: no half-applied change');

  // Once the user puts the file back, the change is delivered.
  writeFileSync(join(dir, 'u.txt'), 'one\ntwo\nthree\n');
  const s = await syncCheckout(p);
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(read(dir, 'u.txt'), 'one\ntwo\nthree\nfour\n');
  assert.equal(read(dir, 'b.txt'), 'from T2\n');

  // The whole run left the user's history alone.
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '1');
});

test('a file the user changed in another place than the task is merged, not reported as a conflict', async () => {
  const dir = mkdtempSync(join(root, 'merge3-'));
  git(dir, 'init', '-q', '-b', 'main');
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(dir, 'c.ts'), lines.join('\n') + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user commit');
  await ensureRepo(dir);
  const p = project(dir, 'merge3');
  await absorbCheckout(p);
  // The task changes the end of the file; meanwhile the user commits a change at the top (like f12535f did).
  const b = await taskCommit(p, 'M1', { 'c.ts': [...lines.slice(0, 19), 'line 20 (task)'].join('\n') + '\n' });
  writeFileSync(join(dir, 'c.ts'), ['line 1 (user)', ...lines.slice(1)].join('\n') + '\n');
  git(dir, 'commit', '-q', '-am', 'user edit');
  const m = await mergeIntoBase(p, b, 'merge M1');
  assert.ok(m.ok, m.detail);
  assert.ok(m.sync?.ok, JSON.stringify(m.sync));
  const out = read(dir, 'c.ts');
  assert.match(out, /^line 1 \(user\)$/m);
  assert.match(out, /^line 20 \(task\)$/m);
});

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

test('tasks start from the folder as it is now, also after the user committed', async () => {
  const { dir, p } = await freshProject('fresh-base', { 'a.txt': 'a\n' });
  writeFileSync(join(dir, 'new.txt'), 'committed later\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user adds new.txt');
  writeFileSync(join(dir, 'draft.txt'), 'not committed\n');
  await ensureBase(p); // what every task does before its worktree is made
  assert.equal(git(dir, 'show', `${baseRef(p)}:new.txt`), 'committed later');
  assert.equal(git(dir, 'show', `${baseRef(p)}:draft.txt`), 'not committed');
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '2', 'no commit on the user\'s branch');
});

test('a folder far ahead of what Plexus last synced (the old stuck state) is merged, not reported', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const { dir, p } = await freshProject('behind', { 'c.ts': lines.join('\n') + '\n' });
  // Plexus merged work the folder never received (bottom of c.ts, new file) ...
  const b = await taskCommit(p, 'B1', { 'c.ts': [...lines.slice(0, 29), 'line 30 (task)'].join('\n') + '\n', 'feature.ts': 'f\n' });
  const synced = git(dir, 'rev-parse', `refs/plexus/${p.id}/synced`);
  const m = await mergeIntoBase(p, b, 'merge B1');
  assert.ok(m.ok);
  git(dir, 'update-ref', `refs/plexus/${p.id}/synced`, synced); // as if that delivery had failed back then
  git(dir, 'checkout', '-q', '--', '.'); git(dir, 'clean', '-fdq');
  // ... while the user moved on: committed work at the top, the same new file (applied by hand), more files.
  writeFileSync(join(dir, 'c.ts'), ['line 1 (user)', ...lines.slice(1)].join('\n') + '\n');
  writeFileSync(join(dir, 'feature.ts'), 'f\n');
  writeFileSync(join(dir, 'mine.ts'), 'mine\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'user work');
  const r = await syncCheckout(p);
  assert.ok(r.ok, JSON.stringify(r));
  const out = read(dir, 'c.ts');
  assert.match(out, /^line 1 \(user\)$/m);
  assert.match(out, /^line 30 \(task\)$/m);
  assert.equal(read(dir, 'mine.ts'), 'mine\n');
  assert.equal(git(dir, 'show', `${baseRef(p)}:mine.ts`), 'mine', 'the base has the user\'s work too');
});

describe("no commit on the user's branches", { concurrency: true }, () => { for (const [name, fn] of tests) base(name, fn); });
