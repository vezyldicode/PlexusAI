// A project whose folder is gone says so (instead of an empty task_error), and Edit project can point it at a new folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-folder-'));
process.env.PLEXUS_HOME = join(root, 'home');
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
