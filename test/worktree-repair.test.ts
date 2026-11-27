import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-wtrepair-'));
const { mergeDetached } = await import('../src/server/util/git.ts');

/** A repo with one commit on main and a branch `feat` one commit ahead; returns main's commit. */
function makeRepo(dir: string): string {
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'a');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'b.txt'), 'b\n'); g('add', '-A'); g('commit', '-q', '-m', 'b');
  g('checkout', '-q', 'main');
  return base;
}

test('integration worktree keeps merging after the project folder is renamed or its metadata is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plexus-rename-'));
  const oldRepo = join(root, 'old-name'), newRepo = join(root, 'new-name');
  mkdirSync(oldRepo);
  const base = makeRepo(oldRepo);
  const wt = join(mkdtempSync(join(tmpdir(), 'plexus-int-')), 'integration');

  const first = await mergeDetached(oldRepo, wt, base, 'feat', 'merge 1');
  assert.ok(first.ok, first.detail);

  // The user renames the project folder: the worktree's .git file still names the old path.
  renameSync(oldRepo, newRepo);
  const afterRename = await mergeDetached(newRepo, wt, base, 'feat', 'merge 2');
  assert.ok(afterRename.ok, afterRename.detail);

  // The repo's record of the worktree is gone too, so it cannot be repaired: it is rebuilt.
  rmSync(join(newRepo, '.git', 'worktrees'), { recursive: true, force: true });
  const rebuilt = await mergeDetached(newRepo, wt, base, 'feat', 'merge 3');
  assert.ok(rebuilt.ok, rebuilt.detail);
});
