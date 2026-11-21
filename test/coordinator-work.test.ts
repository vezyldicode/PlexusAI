// Work the coordinator does itself (main-checkout edits, merged workspace) is recorded as a finished `coordinator` task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-coordwork-'));
process.env.PLEXUS_HOME = join(root, 'home');
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
