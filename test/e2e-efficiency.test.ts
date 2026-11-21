// Token-efficiency and coordinator behaviour with mock agents (docs/06-efficiency-and-coordinator-research.md):
// - a blocked result is not retried: the task waits for a message, and runs again only with it;
// - gap rounds continue the previous round's conversation (a lane), and a round without progress stops to ask instead of looping;
// - a pinned account is used when it can run, another one takes over when it cannot;
// - the coordinator reaches Plexus through its MCP tools, and can remove directives and continue an agent's work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'plexus-eff-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { startDaemon } = await import('../src/server/main.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');
const { paths } = await import('../src/server/paths.ts');
const { createTask } = await import('../src/server/tasks.ts');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('blocked waits, gap rounds resume and converge, pins fall back, coordinator tools', { timeout: 240_000 }, async () => {
  const d = await startDaemon({ port: 0, quiet: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': d.token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
    return j;
  };
  const state = (id: string) => call('GET', `/api/projects/${id}`);
  const dump = (s: any) => JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.laneFrom?.split('-').pop() ?? null, t.error]));
  const mkProject = (name: string, files: Record<string, string> = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };
  const logOf = (pid: string, seq: number, run = 1) => {
    const f = readdirSync(join(paths.logs, pid)).find(x => x.startsWith(`T${seq}-r${run}-`));
    return f ? readFileSync(join(paths.logs, pid, f), 'utf8') : '';
  };
  const messages = (pid: string) => call('GET', `/api/projects/${pid}/messages`);
  try {
    const acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a', maxConcurrency: 3 });
    const cfg = (c: object) => writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1, ...c }));

    // 1. A blocked agent is not retried with the same input: one run, the task waits; a message wakes it up.
    cfg({ blockKinds: ['build'] });
    const p1 = await call('POST', '/api/projects', { path: mkProject('blocked', { 'README.md': '# Blocked\n' }), goal: 'demo of a blocked task' });
    const t1 = createTask(p1.id, { title: 'Write the file', description: 'FILE: out.txt', role: 'implementer', kind: 'build', adhoc: true });
    void orchestrator.tick();
    await waitFor(async () => (await state(p1.id)).tasks[0]?.status === 'blocked', 30_000, 'blocked task');
    await orchestrator.idle();
    assert.equal((await call('GET', `/api/tasks/${t1.id}`)).runs.length, 1, 'no automatic retry of a blocked result');
    assert.ok((await messages(p1.id)).some((m: any) => m.meta?.level === 'attention' && /blocked and waits for you/.test(m.text)));
    await call('POST', `/api/tasks/${t1.id}/message`, { text: 'Write out.txt' });
    await waitFor(async () => (await state(p1.id)).tasks[0]?.status === 'done', 30_000, 'unblocked task done');
    await orchestrator.idle();
    assert.match(logOf(p1.id, 1, 2), /## Messages for you[\s\S]*Write out\.txt/, 'the message is in the next run');
    assert.ok(logOf(p1.id, 1, 1), 'each run has its own log (r1, r2)');
    assert.equal((await state(p1.id)).tasks[0].inbox.length, 0, 'delivered messages leave the inbox');

    // 2. Single-agent build: round 2 continues round 1's conversation; a round without progress stops and asks.
    cfg({ mode: 'single', soloFirstFiles: ['alpha.txt'], soloNoProgress: true });
    const p2 = await call('POST', '/api/projects', { path: mkProject('gaps', { 'GOAL.md': 'Create alpha.txt and beta.txt' }), start: true });
    const waiting = await waitFor(async () => { const s = await state(p2.id); return s.project.phase === 'waiting' ? s : null; }, 60_000, 'stalled rounds stop');
    await orchestrator.idle();
    assert.equal(waiting.project.status, 'paused');
    assert.deepEqual(waiting.tasks.map((t: any) => t.kind), ['ingest', 'solo', 'solo'], 'no third round without progress: ' + dump(waiting));
    const round2 = waiting.tasks[2];
    assert.equal(round2.laneFrom, waiting.tasks[1].id, 'round 2 continues round 1');
    const r2log = logOf(p2.id, round2.seq);
    assert.match(r2log, /# prompt \(resuming mock-/, 'round 2 resumed the conversation');
    assert.doesNotMatch(r2log, /# RULES/, 'no rules, brief or full criteria again');
    assert.ok(existsSync(join(waiting.project.path, '.plexus', 'memory', 'open-gaps.md')));
    assert.ok(existsSync(join(waiting.project.path, '.plexus', 'memory', 'handoff', `T${waiting.tasks[1].seq}.md`)), 'round notes outlive the worktree');
    assert.ok((await messages(p2.id)).some((m: any) => m.meta?.level === 'attention' && /stopped instead of starting another round/.test(m.text)));
    // The user fixed the cause: resume continues with the open gaps, in the same lane, and finishes.
    cfg({ mode: 'single' });
    await call('POST', `/api/projects/${p2.id}/resume`, {});
    const done2 = await waitFor(async () => { const s = await state(p2.id); return s.project.status === 'completed' ? s : null; }, 60_000, 'resumed build completes');
    await orchestrator.idle();
    assert.equal(done2.project.phase, 'done', dump(done2));
    assert.equal(done2.tasks.at(-1).laneFrom, round2.id);
    assert.match(readdirSync(done2.project.path).sort().join('\n'), /beta\.txt/);

    // 3. A pinned account runs the task when it can; while it cannot, another one takes over (with a notice).
    cfg({});
    const b = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-b' });
    writeFileSync(join(b.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1 }));
    await call('PATCH', '/api/accounts/mock-b', { enabled: false });
    const p3 = await call('POST', '/api/projects', { path: mkProject('pin', { 'README.md': '# Pin\n' }), goal: 'pin demo' });
    await call('POST', `/api/projects/${p3.id}/actions`, { actions: [{ type: 'solo_task', title: 'pinned work', description: 'FILE: pinned.txt', account: 'mock-b' }] });
    const s3 = await waitFor(async () => { const s = await state(p3.id); return s.tasks[0]?.status === 'done' ? s : null; }, 30_000, 'pinned task done elsewhere');
    await orchestrator.idle();
    assert.equal(s3.tasks[0].pinnedAccountId, 'mock-b');
    assert.equal(s3.tasks[0].lastAccountId, 'mock-a');
    assert.ok((await messages(p3.id)).some((m: any) => /pinned to mock-b, which cannot run now/.test(m.text)));

    // 4. The coordinator uses its plexus tools (MCP server → daemon API), and can undo a directive.
    const say = async (text: string, n: number) => {
      await call('POST', `/api/projects/${p3.id}/messages`, { text });
      return waitFor(async () => { const ms = (await messages(p3.id)).filter((m: any) => m.author === 'coordinator'); return ms.length >= n ? ms.at(-1) : null; }, 30_000, `reply ${n}`);
    };
    const r1 = await say('mcp: plexus_status', 1);
    assert.match(r1.text, /TOOL: \[plexus tools: 9\] Project pin/, r1.text);
    assert.equal(r1.meta.tools, true);
    const r2 = await say('mcp: plexus_action {"action":{"type":"add_directive","text":"Give the refactor to account mock-b"}}', 2);
    assert.match(r2.text, /directive added/);
    assert.match((await call('GET', `/api/projects/${p3.id}/memory`))['directives.md'], /mock-b/);
    await say('action: {"type":"remove_directive","match":"refactor to account"}', 3);
    assert.doesNotMatch((await call('GET', `/api/projects/${p3.id}/memory`))['directives.md'], /mock-b/);
    const r4 = await say(`mcp: plexus_task_log {"id":"T${s3.tasks[0].seq}"}`, 4);
    assert.match(r4.text, /run \d+ on mock-a \(success\)/, r4.text);

    // 5. continue_task: more work for the same agent, in its conversation (no fresh context).
    await say(`action: {"type":"continue_task","task_id":"T${s3.tasks[0].seq}","instructions":"Also FILE: more.txt"}`, 5);
    const s5 = await waitFor(async () => { const s = await state(p3.id); return s.tasks.length === 2 && s.tasks[1].status === 'done' ? s : null; }, 30_000, 'continued task');
    await orchestrator.idle();
    assert.equal(s5.tasks[1].laneFrom, s5.tasks[0].id);
    assert.match(logOf(p3.id, s5.tasks[1].seq), /# prompt \(resuming mock-[\s\S]*# NEXT STEP IN THIS CONVERSATION/);
  } finally {
    await d.shutdown();
  }
});
