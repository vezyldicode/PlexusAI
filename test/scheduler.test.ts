// Accounts and scheduling: account choice, cooldowns, roles, per-role limits and overlapping paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Plexus data folder must be set before any server module loads.
process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-scheduler-'));
// No `git maintenance run --auto` after each commit in the throwaway repos.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });

// ---- unit.test.ts (sched)
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
}
