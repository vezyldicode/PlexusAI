import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-unit-'));

const { classifyCodexRun, codexImageArgs } = await import('../src/server/adapters/codex.ts');

test('Codex image arguments work for initial and resumed prompts', () => {
  assert.deepEqual(codexImageArgs(['/one.png', '/two.jpg']), ['-i', '/one.png', '-i', '/two.jpg']);
});

const { safeFileName, sniffImage } = await import('../src/server/attachments.ts');
const { attachmentsPrompt } = await import('../src/server/adapters/types.ts');
test('attachment names are safe on every OS and images are recognised by content', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\x\\report.pdf'), 'report.pdf');
  assert.equal(safeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(safeFileName('  ..  '), 'file');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('báo cáo.xlsx'), 'báo cáo.xlsx');
  const long = safeFileName('x'.repeat(300) + '.json');
  assert.ok(long.length === 200 && long.endsWith('.json'));
  assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns=')), null);
  assert.equal(attachmentsPrompt({}), '');
  assert.match(attachmentsPrompt({ images: ['/a.png'], files: ['/b.csv'] }), /Attached files[^\n]*\n- \/a\.png \(image\)\n- \/b\.csv$/);
});
const { classifyClaudeRun } = await import('../src/server/adapters/claude-limits.ts');
const { ensureRepo } = await import('../src/server/util/git.ts');
const { pickAccount } = await import('../src/server/orchestrator.ts');
const { readResult } = await import('../src/server/worker.ts');
const { parseCoordinatorOutput } = await import('../src/server/coordinator.ts');
const { seedRoles } = await import('../src/server/roles.ts');
const { DEFAULT_PROJECT_SETTINGS } = await import('../src/shared/types.ts');
seedRoles();

const ndjson = (...o: unknown[]) => o.map(x => JSON.stringify(x)).join('\n');

test('codex: real successful run (captured from Codex 0.157) → ok', () => {
  const out = ndjson({ type: 'thread.started', thread_id: 'x' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } },
    { type: 'turn.completed', usage: { input_tokens: 14721, cached_input_tokens: 11136, output_tokens: 5 } });
  const r = classifyCodexRun({ stdout: out });
  assert.equal(r.state, 'ok');
  assert.equal(r.finalText, 'ok');
});

test('codex: real network failure (captured: proxy refused) → transient', () => {
  const out = ndjson({ type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: No connection could be made because the target machine actively refused it. (os error 10061))' });
  assert.equal(classifyCodexRun({ stdout: out, exitCode: 1 }).state, 'transient');
});

test('codex: usage limit text → limited', () => {
  const out = ndjson({ type: 'turn.started' }, { type: 'turn.failed', error: { message: "You've reached your usage limit. Increase your limits to continue using codex." } });
  const r = classifyCodexRun({ stdout: out, exitCode: 1 });
  assert.equal(r.state, 'limited');
  assert.ok(r.cooldownUntil);
});

test('codex: auth failure → needs_login; plan without codex → blocked', () => {
  assert.equal(classifyCodexRun({ stdout: ndjson({ type: 'error', message: 'unexpected status 401 Unauthorized' }), exitCode: 1 }).state, 'needs_login');
  assert.equal(classifyCodexRun({ stdout: ndjson({ type: 'error', message: 'usage_not_included' }), exitCode: 1 }).state, 'blocked');
});

test('claude: limited run gives cooldown at reset time', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const out = ndjson({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: 'rejected' } } } });
  const r = classifyClaudeRun({ stdout: out, exitCode: 1 });
  assert.equal(r.state, 'limited');
  assert.equal(r.cooldownUntil, new Date(resetsAt * 1000).toISOString());
});

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

const acct = (id: string, provider: any, extra: any = {}) => ({
  id, provider, label: id, home: '', enabled: true, priority: 10, maxConcurrency: 1, state: 'ok', stateReason: null, cooldownUntil: null,
  quota: null, createdAt: '', running: 0, ...extra,
});
const project = (s: any = {}) => ({ id: 'p', name: 'p', path: '', goal: '', status: 'running', phase: 'build', mainBranch: 'main', settings: { ...DEFAULT_PROJECT_SETTINGS, ...s }, evalRounds: 0, createdAt: '' }) as any;
const task = (extra: any = {}) => ({ id: 't', projectId: 'p', seq: 1, title: '', description: '', role: 'implementer', kind: 'build', status: 'pending', deps: [], parentId: null, branch: null, worktree: null, priority: 50, attempts: 0, accountId: null, lastAccountId: null, authorAccountId: null, reviewCycles: 0, acceptance: [], result: null, error: null, createdAt: new Date().toISOString(), updatedAt: '', ...extra }) as any;

test('pickAccount skips limited / busy / logged-out accounts', () => {
  const a = pickAccount(project(), task(), [
    acct('c1', 'claude', { state: 'limited', cooldownUntil: new Date(Date.now() + 3600e3).toISOString() }),
    acct('c2', 'claude', { running: 1 }),
    acct('x1', 'codex', { state: 'needs_login' }),
    acct('x2', 'codex'),
  ] as any);
  assert.equal(a?.id, 'x2');
});

test('pickAccount spreads load by quota usage and follows role preference', () => {
  const accs = [acct('x1', 'codex', { quota: { primary: { usedPercent: 80 } } }), acct('x2', 'codex', { quota: { primary: { usedPercent: 20 } } }), acct('c1', 'claude')] as any;
  assert.equal(pickAccount(project(), task({ role: 'implementer' }), accs)?.id, 'x2'); // implementer prefers codex
  assert.equal(pickAccount(project(), task({ role: 'architect' }), accs)?.id, 'c1');  // architect prefers claude
  assert.equal(pickAccount(project({ quotaStrategy: 'drain' }), task(), accs)?.id, 'x1');
});

test('reviews prefer another account and another provider than the author', () => {
  const accs = [acct('x1', 'codex'), acct('x2', 'codex'), acct('c1', 'claude')] as any;
  assert.equal(pickAccount(project(), task({ kind: 'review', role: 'reviewer', authorAccountId: 'c1' }), accs)?.id, 'x1');
  assert.equal(pickAccount(project(), task({ kind: 'review', role: 'reviewer', authorAccountId: 'x1' }), accs)?.id, 'c1');
  // only the author is free, another account exists but is busy → wait (within the wait window)
  const busy = [acct('x1', 'codex'), acct('c1', 'claude', { running: 1 })] as any;
  assert.equal(pickAccount(project(), task({ kind: 'review', role: 'reviewer', authorAccountId: 'x1' }), busy), null);
  assert.equal(pickAccount(project({ independentReviewWaitMin: 0 }), task({ kind: 'review', role: 'reviewer', authorAccountId: 'x1' }), busy)?.id, 'x1');
});

test('readResult falls back to the json block of the final message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexus-res-'));
  const r = readResult(dir, 'Done.\n```json\n{"status":"done","summary":"s","review":{"verdict":"approve"}}\n```');
  assert.equal(r?.review?.verdict, 'approve');
  assert.equal(readResult(dir, 'no json here'), null);
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

test('readResult accepts the near-miss shapes an agent writes after compaction (no extra run to fix the JSON)', () => {
  // Shape of a real solo result that was rejected and cost a whole extra run on a 105k context.
  const dir = mkdtempSync(join(tmpdir(), 'plexus-res-'));
  mkdirSync(join(dir, '.plexus-task'));
  writeFileSync(join(dir, '.plexus-task', 'result.json'), JSON.stringify({
    status: 'done', summary: 's',
    decisions: ['Chat tasks get a tag', 'Coordinator edits become records'],
    follow_up_tasks: ['Test workspace-merge records'],
    issues: [{ screen: 'board', sign: 'cramped' }],
    escalate: false,
    codemap: { 'src/a.ts': 'does A', 'ui/b.tsx': 'shows B' },
    evaluation: { criteria: [{ criterion: 'build passes', pass: true, evidence: 'vite ok' }, { criterion: 'tests', pass: 'true' }] },
  }));
  const r = readResult(dir, '');
  assert.ok(r);
  assert.equal(r.decisions[0].title, 'Chat tasks get a tag');
  assert.equal(r.decisions[1].decision, 'Coordinator edits become records');
  assert.equal(r.follow_up_tasks[0].title, 'Test workspace-merge records');
  assert.equal(typeof r.issues[0], 'string');
  assert.equal(r.escalate, null);
  assert.match(r.codemap!, /- src\/a\.ts: does A/);
  assert.equal(r.evaluation?.complete, true);
  assert.equal(r.evaluation?.criteria[0].id, 'build passes');
  assert.equal(r.evaluation?.criteria[1].pass, true);
});

test('coordinator output parsing tolerates prose around the JSON', () => {
  const o = parseCoordinatorOutput('Sure!\n{"reply":"ok","actions":[{"type":"pause"}],"proposal":null}\nthanks');
  assert.equal(o?.reply, 'ok');
  assert.equal(o?.actions[0].type, 'pause');
});

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

// ---------------- Phase B: issues #2, #4, #5

test('paths: normalised, and overlap means equal or nested (globs cut at the wildcard)', async () => {
  const { normPaths, pathsOverlap } = await import('../src/server/tasks.ts');
  assert.deepEqual(normPaths(['./src\\auth/', 'src/auth', '', '/etc/passwd', 'C:\\x', '../up', 'test/a.test.ts']), ['src/auth', 'test/a.test.ts']);
  assert.ok(pathsOverlap(['src/auth'], ['src/auth/login.ts']));
  assert.ok(pathsOverlap(['src/**/*.ts'], ['src/a.ts']));
  assert.ok(!pathsOverlap(['src/auth'], ['src/author.ts']));
  assert.ok(!pathsOverlap(['src/a'], ['test/a']));
});

test('a limited account without a reset time takes the reset of its used-up quota window', async () => {
  const { resetFromQuota } = await import('../src/server/accounts.ts');
  const soon = new Date(Date.now() + 3600e3).toISOString(), later = new Date(Date.now() + 7200e3).toISOString();
  assert.equal(resetFromQuota({ primary: { usedPercent: 100, resetsAt: soon }, secondary: { usedPercent: 40, resetsAt: later } } as any), soon);
  assert.equal(resetFromQuota({ primary: { usedPercent: 100, resetsAt: soon }, secondary: { usedPercent: 100, resetsAt: later } } as any), later);
  assert.equal(resetFromQuota({ primary: { usedPercent: 80, resetsAt: soon } } as any), null);
});

test('a role marked onlyListed never falls back to other providers', async () => {
  const { saveRole, readRole } = await import('../src/server/roles.ts');
  const base = readRole('implementer')!;
  saveRole({ ...base, name: 'codex-only', providers: ['codex'], onlyListed: true });
  const accs = [acct('c1', 'claude'), acct('x1', 'codex', { running: 1 })] as any;
  assert.equal(pickAccount(project(), task({ role: 'codex-only', kind: 'custom' }), accs), null);
  saveRole({ ...base, name: 'codex-soft', providers: ['codex'], onlyListed: false });
  assert.equal(pickAccount(project(), task({ role: 'codex-soft', kind: 'custom' }), accs)?.id, 'c1');
});

test('scheduler: per-role parallel limit and no two writers on overlapping paths', async () => {
  const { createProject, setProjectStatus } = await import('../src/server/projects.ts');
  const { createTask, getTask } = await import('../src/server/tasks.ts');
  const { addAccount } = await import('../src/server/accounts.ts');
  const { saveRole, readRole } = await import('../src/server/roles.ts');
  const { Orchestrator } = await import('../src/server/orchestrator.ts');
  addAccount({ provider: 'mock', id: 'sched-m1', maxConcurrency: 5 });
  const p = createProject({ path: mkdtempSync(join(tmpdir(), 'plexus-sched-')), settings: { maxParallel: 5 } });
  setProjectStatus(p.id, 'running');
  const t1 = createTask(p.id, { title: 'a', role: 'implementer', kind: 'build', paths: ['src/a'] });
  const t2 = createTask(p.id, { title: 'a2', role: 'implementer', kind: 'build', paths: ['src/a/x.ts'] });
  const t3 = createTask(p.id, { title: 'b', role: 'implementer', kind: 'build', paths: ['src/b'] });
  const t4 = createTask(p.id, { title: 'c', role: 'implementer', kind: 'build', paths: ['src/c'] });
  const run = (o: any) => { const ids: string[] = []; o.launch = async (_p: any, t: any) => { ids.push(t.id); }; o.schedule(getProjectFresh(p.id)); return ids; };
  const { mustProject } = await import('../src/server/projects.ts');
  const getProjectFresh = (id: string) => mustProject(id);

  // No role limit: t2 waits because it overlaps t1; t3 and t4 run.
  assert.deepEqual(run(new Orchestrator()), [t1.id, t3.id, t4.id]);

  // Limit implementers to 2.
  const impl = readRole('implementer')!;
  saveRole({ ...impl, maxParallel: 2 });
  try { assert.deepEqual(run(new Orchestrator()), [t1.id, t3.id]); }
  finally { saveRole({ ...impl, maxParallel: 0 }); }
  assert.equal(getTask(t2.id)!.status, 'pending');
});

test('an account released from its cooldown announces it is available again', async () => {
  const { addAccount, applyClassification, releaseCooldowns } = await import('../src/server/accounts.ts');
  const { bus } = await import('../src/server/events.ts');
  addAccount({ provider: 'mock', id: 'avail-m1' });
  applyClassification('avail-m1', { state: 'limited', reason: 'test', evidence: [], cooldownUntil: new Date(Date.now() - 1000).toISOString() } as any, null);
  const seen: string[] = [];
  const on = (e: any) => { if (e.type === 'account.available') seen.push(e.data.id); };
  bus.on('event', on);
  try { releaseCooldowns(); } finally { bus.off('event', on); }
  assert.deepEqual(seen, ['avail-m1']);
});
