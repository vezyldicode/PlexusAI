// End-to-end run of the full team pipeline with mock agents (no quota spent; every optional step switched on):
// ingest → architect → plan → build (parallel, with review + fix cycle) → merge → QA → evaluate → complete,
// while one account hits its quota limit mid-run and its task is handed off to another account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'plexus-e2e-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { startDaemon } = await import('../src/server/main.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('mock Plexus completes a project with handoff, review and evaluation', { timeout: 240_000 }, async () => {
  const d = await startDaemon({ port: 0, quiet: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': d.token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
    return j;
  };
  try {
    // unauthorized without token
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/api/accounts`)).status, 401);

    const a1 = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a' });
    const a2 = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-b' });
    writeFileSync(join(a1.home, 'mock.json'), JSON.stringify({ limitAfterRuns: 5, delayMs: 30, architectNoPlan: true }));
    writeFileSync(join(a2.home, 'mock.json'), JSON.stringify({ delayMs: 30, rejectReviewOnce: true, architectNoPlan: true }));

    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'docs'), { recursive: true });
    writeFileSync(join(proj, 'docs', 'README.md'), '# Demo\nCreate alpha.txt and beta.txt.\n');
    const p = await call('POST', '/api/projects', { path: proj, goal: 'Create alpha.txt and beta.txt', settings: { maxParallel: 2, independentReviewWaitMin: 0, pipeline: 'team', reviewPolicy: 'always', qaPhase: true } });
    await call('POST', `/api/projects/${p.id}/start`);

    const final = await waitFor(async () => {
      const s = await call('GET', `/api/projects/${p.id}`);
      return s.project.status === 'completed' ? s : null;
    }, Number(process.env.E2E_TIMEOUT ?? 200_000), 'project completion').catch(async e => {
      const s = await call('GET', `/api/projects/${p.id}`);
      console.log('PROJECT', s.project.status, s.project.phase);
      for (const t of s.tasks) console.log(`T${t.seq} ${t.kind} ${t.status} acct=${t.accountId} last=${t.lastAccountId} att=${t.attempts} err=${t.error}`);
      for (const m of await call('GET', `/api/projects/${p.id}/messages`)) console.log('MSG', m.author, m.text.slice(0, 300));
      for (const ev of (await call('GET', `/api/projects/${p.id}/events`)).filter((e: any) => /error/.test(e.type))) console.log('EV', JSON.stringify(ev.data).slice(0, 800));
      console.log('ACCTS', JSON.stringify(await call('GET', '/api/accounts')).slice(0, 1500));
      throw e;
    });

    await orchestrator.idle();
    assert.equal(final.project.phase, 'done', 'project should complete fully');
    const kinds = final.tasks.map((t: any) => t.kind);
    for (const k of ['ingest', 'architect', 'plan', 'build', 'review', 'fix', 'qa', 'evaluate']) assert.ok(kinds.includes(k), `has ${k} task`);
    assert.ok(final.tasks.every((t: any) => ['done', 'cancelled'].includes(t.status)), 'all tasks done: ' + JSON.stringify(final.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error])));

    // the product is in the folder, uncommitted: Plexus made no commit on any branch of the user's
    const files = readdirSync(proj).sort().join('\n');
    const userBranches = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: proj, encoding: 'utf8' })
      .split('\n').filter(r => r && !r.startsWith('refs/heads/plexus/'));
    assert.deepEqual(userBranches, [], 'no commit on the user\'s branches');
    assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: proj, encoding: 'utf8' }), /\?\? alpha\.txt/);
    assert.match(files, /alpha\.txt/);
    assert.match(files, /beta\.txt/);
    assert.match(files, /ARCHITECTURE\.md/);
    assert.ok(existsSync(join(proj, '.plexus', 'REPORT.md')));
    assert.match(readFileSync(join(proj, '.plexus', 'memory', 'acceptance.md'), 'utf8'), /\[x\] \*\*AC1\*\*/);

    // quota exhaustion on mock-a was detected and work continued on mock-b
    const accts = await call('GET', '/api/accounts');
    const ma = accts.find((a: any) => a.id === 'mock-a');
    assert.equal(ma.state, 'limited');
    assert.ok(ma.cooldownUntil);
    const msgs = await call('GET', `/api/projects/${p.id}/messages`);
    assert.ok(msgs.some((m: any) => m.meta?.level === 'handoff'), 'a handoff message was posted');
    assert.equal(msgs.filter((m: any) => m.meta?.level === 'done').length, 1, 'project finished exactly once');
    assert.match(msgs.find((m: any) => m.meta?.level === 'done').text, /complete/);

    // reviewer independence: reviews run on another account while one is available
    let independent = 0;
    for (const t of final.tasks.filter((t: any) => t.kind === 'review')) {
      const runs = (await call('GET', `/api/tasks/${t.id}`)).runs.filter((r: any) => r.outcome === 'success');
      if (runs.length && runs.at(-1).accountId !== t.authorAccountId) independent++;
    }
    assert.ok(independent >= 1, 'at least one review ran on an account other than the author');

    // token usage: every successful run reports the mock's 10 + 5 tokens, summed per task and per project
    const done = final.tasks.filter((t: any) => t.status === 'done');
    for (const t of done) assert.ok(final.usage.tasks[t.id]?.total >= 15, `T${t.seq} has its tokens`);
    const taskSum = Object.values<any>(final.usage.tasks).reduce((a, u) => a + u.total, 0);
    assert.equal(final.usage.total.total, taskSum + (final.usage.coordinator?.total ?? 0));
    const roleSum = Object.values<any>(final.usage.byRole).reduce((a, u) => a + u.total, 0);
    assert.equal(roleSum, taskSum);

    // chat → coordinator applies an action
    await call('POST', `/api/projects/${p.id}/messages`, { text: 'add task: gamma' });
    await waitFor(async () => (await call('GET', `/api/projects/${p.id}/messages`)).find((m: any) => m.author === 'coordinator'), 30_000, 'coordinator reply');
    const after = await call('GET', `/api/projects/${p.id}`);
    assert.ok(after.tasks.some((t: any) => t.title === 'gamma'), 'coordinator created the task');
  } finally {
    await d.shutdown();
  }
});
