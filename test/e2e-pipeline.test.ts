// The adaptive pipeline with mock agents (no quota spent):
// - no goal and no docs → Plexus asks before starting any agent; unclear docs → the analyst asks and stops;
// - a small project is built by one agent (ingest → solo → done);
// - a chat request is done by one agent even on a project that was never started;
// - a team build skips the planner (the architect plans), and the fix after review resumes the author's conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'plexus-pipeline-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { startDaemon } = await import('../src/server/main.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('adaptive pipeline: ask first, single agent by default, chat requests done alone, cheap fixes', { timeout: 240_000 }, async () => {
  const d = await startDaemon({ port: 0, quiet: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': d.token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
    return j;
  };
  const state = (id: string) => call('GET', `/api/projects/${id}`);
  const dump = (s: any) => JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error]));
  const completed = (id: string, label: string) => waitFor(async () => { const s = await state(id); return s.project.status === 'completed' ? s : null; }, 60_000, label);
  const mkProject = (name: string, files: Record<string, string> = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };
  try {
    const acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-1', maxConcurrency: 2 });
    const cfg = (c: object) => writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1, ...c }));

    // 1. Nothing to go on: no agent starts, the user is asked. After the answer, one agent builds it.
    cfg({ mode: 'single' });
    const p1 = await call('POST', '/api/projects', { path: mkProject('empty'), start: true });
    let s1 = await state(p1.id);
    assert.equal(s1.project.phase, 'needs_input');
    assert.equal(s1.project.status, 'paused');
    assert.equal(s1.tasks.length, 0, 'no agent ran');
    assert.ok((await call('GET', `/api/projects/${p1.id}/messages`)).some((m: any) => m.meta?.level === 'attention' && /What should be built/.test(m.text)));
    await call('POST', `/api/projects/${p1.id}/actions`, { actions: [{ type: 'set_goal', goal: 'Create alpha.txt and beta.txt, one line each' }, { type: 'resume' }] });
    s1 = await completed(p1.id, 'single-agent project');
    await orchestrator.idle();
    assert.equal(s1.project.phase, 'done', dump(s1));
    assert.deepEqual(s1.tasks.map((t: any) => t.kind), ['ingest', 'solo'], 'analyst, then one agent: ' + dump(s1));
    assert.match(execFileSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: s1.project.path, encoding: 'utf8' }), /alpha\.txt[\s\S]*beta\.txt/);

    // 2. Docs exist but do not say what to build: the analyst asks and nothing else runs; the answer unblocks it.
    cfg({ mode: 'single', unclearDocs: true });
    const p2 = await call('POST', '/api/projects', { path: mkProject('vague', { 'README.md': '# Vague\nSome thoughts about a tool we might want to write one day.\n' }), goal: 'Build the thing we talked about last week', start: true });
    const s2 = await waitFor(async () => { const s = await state(p2.id); return s.project.phase === 'needs_input' ? s : null; }, 30_000, 'analyst asks');
    await orchestrator.idle();
    assert.equal(s2.project.status, 'paused');
    assert.deepEqual(s2.tasks.map((t: any) => t.kind), ['ingest']);
    assert.ok((await call('GET', `/api/projects/${p2.id}/messages`)).some((m: any) => /Which files should be created\?/.test(m.text)));
    await call('POST', `/api/projects/${p2.id}/actions`, { actions: [{ type: 'add_directive', text: 'CLARIFIED: create alpha.txt and beta.txt' }, { type: 'resume' }] });
    const s2done = await completed(p2.id, 'clarified project');
    // The same analyst continues in its conversation after the answer (no second analyst re-reading the docs).
    assert.deepEqual(s2done.tasks.map((t: any) => t.kind), ['ingest', 'solo'], dump(s2done));

    // 3. A chat request on a project that was never started: one agent does it, the pipeline stays off.
    cfg({});
    const p3 = await call('POST', '/api/projects', { path: mkProject('chat', { 'README.md': '# Chat demo\n' }), goal: 'demo project for chat requests' });
    await call('POST', `/api/projects/${p3.id}/messages`, { text: 'do: hello world' });
    const s3 = await waitFor(async () => { const s = await state(p3.id); return s.tasks[0]?.status === 'done' ? s : null; }, 30_000, 'chat solo task');
    await orchestrator.idle();
    assert.equal(s3.tasks.length, 1);
    assert.equal(s3.tasks[0].kind, 'solo');
    assert.equal(s3.tasks[0].adhoc, true);
    assert.equal(s3.project.status, 'idle', 'the project pipeline was not started');
    assert.match(execFileSync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: s3.project.path, encoding: 'utf8' }), /hello-world\.txt/);
    assert.ok((await call('GET', `/api/projects/${p3.id}/messages`)).some((m: any) => m.author === 'agent' && /finished/.test(m.text)));

    // 4. Team build: the architect plans (no planner step), no QA step by default, and the fix after review continues
    //    the author's CLI conversation (same account, same worktree) instead of starting cold.
    cfg({ mode: 'team', rejectReviewOnce: true });
    const p4 = await call('POST', '/api/projects', {
      path: mkProject('team', { 'GOAL.md': 'Create alpha.txt and beta.txt' }), start: true,
      settings: { reviewPolicy: 'always', independentReviewWaitMin: 0 },
    });
    const s4 = await completed(p4.id, 'team project');
    await orchestrator.idle();
    const kinds = s4.tasks.map((t: any) => t.kind);
    assert.equal(s4.project.phase, 'done', dump(s4));
    assert.ok(!kinds.includes('plan'), 'architect planned: ' + dump(s4));
    assert.ok(!kinds.includes('qa'), 'no QA step by default: ' + dump(s4));
    const fixes = s4.tasks.filter((t: any) => t.kind === 'fix');
    assert.ok(fixes.length >= 1, 'a review asked for changes: ' + dump(s4));
    const logs = readdirSync(join(paths.logs, p4.id));
    const fixLog = readFileSync(join(paths.logs, p4.id, logs.find(f => f.startsWith(`T${fixes[0].seq}-`))!), 'utf8');
    assert.match(fixLog, /# prompt \(resuming mock-/, 'the fix resumed the author conversation');
    assert.match(fixLog, /# NEXT STEP IN THIS CONVERSATION/);
    assert.doesNotMatch(fixLog, /# RULES/, 'the resumed prompt does not repeat rules and project context');
  } finally {
    await d.shutdown();
  }
});
