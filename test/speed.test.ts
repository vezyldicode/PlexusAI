// Speed and quota pieces: run timing, forking the coordinator's conversation, the user's Codex model, per-role effort
// defaults, scope/fork/checkpoint prompts, and the context budget (stop, checkpoint turn, partial result) with mock agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-speed-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { createRunTimer, addTiming } = await import('../src/server/adapters/timing.ts');
const { forkClaudeConversation, claudeProjectDir } = await import('../src/server/adapters/claude-fork.ts');
const { codexUserDefaults } = await import('../src/server/adapters/codex-config.ts');
const { createProject } = await import('../src/server/projects.ts');
const { createTask, getTask, updateTask, isUserFollowUp } = await import('../src/server/tasks.ts');
const { buildForkPrompt, buildCheckpointPrompt, buildResumePrompt, buildTaskParts } = await import('../src/server/prompts.ts');
const { taskModelChoice } = await import('../src/server/worker.ts');
const { getRole, seedRoles } = await import('../src/server/roles.ts');
const { addAccount, updateAccount } = await import('../src/server/accounts.ts');
const { createSession, setCliSession } = await import('../src/server/chat.ts');
const { postMessage } = await import('../src/server/projects.ts');
const { applyActions } = await import('../src/server/coordinator.ts');
seedRoles();

const project = () => createProject({ path: join(root, `p-${Math.random().toString(16).slice(2, 8)}`), goal: 'Build it' });
const j = (o: unknown) => JSON.stringify(o);

test('run timing: startup, model, tools (overlap counted once), compaction', () => {
  const t = createRunTimer('claude', 0);
  t.line(j({ type: 'system', subtype: 'init' }), 4_000);
  t.line(j({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }] } }), 10_000);
  t.line(j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }), 12_000);
  t.line(j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }), 15_000);
  // A sub-agent's own tool calls run inside the parent's call: not counted again.
  t.line(j({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 's1', content: [{ type: 'tool_use', id: 'c' }] } }), 16_000);
  t.line(j({ type: 'system', subtype: 'compact_boundary', compact_metadata: { duration_ms: 30_000 } }), 50_000);
  t.line(j({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } }), 60_000);
  const r = t.finish(70_000);
  assert.equal(t.compactions, 1);
  assert.deepEqual(r, { totalMs: 70_000, startupMs: 4_000, modelMs: 31_000, toolMs: 5_000, compactMs: 30_000, waitMs: 0, toolCalls: 2, compactions: 1, calls: 2 });
  assert.equal(addTiming(r, r)!.totalMs, 140_000);
  assert.equal(addTiming(null, r), r);
});

test('run timing: codex commands', () => {
  const t = createRunTimer('codex', 0);
  t.line(j({ type: 'thread.started', thread_id: 'x' }), 2_000);
  t.line(j({ type: 'item.started', item: { id: 'i1', type: 'command_execution' } }), 5_000);
  t.line(j({ type: 'item.completed', item: { id: 'i1', type: 'command_execution' } }), 9_000);
  t.line(j({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'ok' } }), 12_000);
  const r = t.finish(12_000);
  assert.equal(r.startupMs, 2_000);
  assert.equal(r.toolMs, 4_000);
  assert.equal(r.modelMs, 6_000);
  assert.equal(r.toolCalls, 1);
});

test('the coordinator conversation is copied to the worktree folder for a fork', () => {
  const cfg = join(root, 'claude-home');
  const from = join(root, 'proj'), to = join(root, 'worktrees', 'p', 'T9');
  const id = '0f3b6c1e-1111-4222-8333-444455556666';
  mkdirSync(join(cfg, 'projects', claudeProjectDir(from)), { recursive: true });
  writeFileSync(join(cfg, 'projects', claudeProjectDir(from), `${id}.jsonl`), '{"type":"user"}\n');
  assert.equal(claudeProjectDir('C:\\Users\\a b\\x.y'), 'C--Users-a-b-x-y');
  assert.equal(forkClaudeConversation(cfg, from, to, id), true);
  assert.ok(existsSync(join(cfg, 'projects', claudeProjectDir(to), `${id}.jsonl`)));
  assert.equal(forkClaudeConversation(cfg, from, to, 'missing-session-id'), false, 'unknown conversation: start fresh');
  assert.equal(forkClaudeConversation(cfg, from, to, '../../etc'), false, 'not a session id');
});

test("Codex runs use the person's own model when Plexus has none", () => {
  const home = join(root, 'codex-acct');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-test"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n');
  assert.deepEqual(codexUserDefaults(home).model, 'gpt-test');
  assert.equal(codexUserDefaults(home).effort, 'high');
});

test('every built-in role runs with an explicit effort; role and task settings still win', () => {
  const p = project();
  const t = createTask(p.id, { title: 'x', role: 'reviewer', kind: 'review' });
  const c = taskModelChoice(p, t, getRole('reviewer'), 'claude');
  assert.equal(c.effort, 'medium');
  assert.equal(c.effortFrom, 'plexus');
  assert.equal(taskModelChoice(p, t, getRole('architect'), 'codex').effort, 'high');
  assert.equal(taskModelChoice(p, t, { ...getRole('reviewer'), efforts: { claude: 'low' } }, 'claude').effortFrom, 'role');
  updateTask(t.id, { efforts: { claude: 'xhigh' } });
  assert.equal(taskModelChoice(p, getTask(t.id)!, getRole('reviewer'), 'claude').effort, 'xhigh');
  assert.equal(taskModelChoice(p, t, { ...getRole('reviewer'), name: 'custom-role' }, 'claude').effortFrom, 'default', 'custom roles keep the CLI default');
});

test('fork, checkpoint and follow-up prompts', () => {
  const p = project();
  const t = createTask(p.id, { title: 'Remove the size cap', description: 'Drop MAX_BYTES in src/a.js', role: 'solo', kind: 'solo', adhoc: true });
  const parts = buildTaskParts(p, t, getRole('solo'), { id: 'acc', provider: 'claude' } as any, '', []);
  const fork = buildForkPrompt(p, t, getRole('solo'), parts.system);
  assert.match(fork, /no longer\s+the coordinator/);
  assert.match(fork, /# RULES/);
  assert.match(fork, /Drop MAX_BYTES/);
  assert.match(fork, /OUTPUT CONTRACT/);
  assert.doesNotMatch(fork, /# PROJECT:/, 'the project context is already in the conversation');
  assert.match(buildCheckpointPrompt(t, getRole('solo'), 2), /compacted 2 times[\s\S]*"partial"[\s\S]*escalate/);

  const prev = createTask(p.id, { title: 'Earlier', role: 'solo', kind: 'solo', adhoc: true, worktree: join(root, 'wt') } as any);
  updateTask(prev.id, { status: 'done', worktree: join(root, 'wt') });
  const user = createTask(p.id, { title: 'From user to T1: why so slow?', description: 'why so slow?', role: 'solo', kind: 'solo', adhoc: true, laneFrom: getTask(prev.id) });
  const coord = createTask(p.id, { title: 'Continue T1: add tests', description: 'add tests', role: 'solo', kind: 'solo', adhoc: true, laneFrom: getTask(prev.id) });
  assert.ok(isUserFollowUp(user));
  assert.match(buildResumePrompt(p, user, getRole('solo'), ''), /question or a remark/);
  assert.doesNotMatch(buildResumePrompt(p, coord, getRole('solo'), ''), /question or a remark/);
});

test("a solo task from the coordinator's Claude chat forks that conversation", () => {
  const p = project();
  const acct = addAccount({ provider: 'claude', id: 'claude-x' });
  updateAccount(acct.id, { enabled: false }); // nothing may actually run in this unit test
  const s = createSession(p.id);
  const m = postMessage(p.id, 'user', 'remove the cap', null, s.id);
  setCliSession(s.id, { sessionId: 'sess-coord-1', accountId: acct.id, syncedMessageId: m.id });
  const applied = applyActions(p.id, [{ type: 'solo_task', title: 'Remove the cap', description: 'Drop MAX_BYTES' } as any], 'coordinator', s.id, { ctx: 40_000, at: new Date().toISOString() });
  assert.match(applied.join(), /continuing from this conversation/);
  const t = getTask(`${p.id}-T1`)!;
  assert.equal(t.cliSessionId, 'sess-coord-1');
  assert.equal(t.cliForkCwd, p.path);
  // Too large to continue: a fresh agent instead.
  const big = applyActions(p.id, [{ type: 'solo_task', title: 'Other', description: 'x' } as any], 'coordinator', s.id, { ctx: 500_000, at: new Date().toISOString() });
  assert.doesNotMatch(big.join(), /continuing from this conversation/);
  assert.equal(getTask(`${p.id}-T2`)!.cliForkCwd, null);
});

test('context budget: the run is stopped, checkpoints in a short turn and reports partial', { timeout: 120_000 }, async () => {
  const { startDaemon } = await import('../src/server/main.ts');
  const { orchestrator } = await import('../src/server/orchestrator.ts');
  const { paths } = await import('../src/server/paths.ts');
  const d = await startDaemon({ port: 0, quiet: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': d.token }, body: body ? JSON.stringify(body) : undefined });
    const out = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(out)}`);
    return out;
  };
  try {
    const acct = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-speed', maxConcurrency: 2 });
    writeFileSync(join(acct.home, 'mock.json'), JSON.stringify({ delayMs: 400, steps: 1, compactions: 5 }));
    const dir = join(root, 'budget');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Budget\n');
    const p = await call('POST', '/api/projects', { path: dir, goal: 'demo of the context budget' });
    const t = createTask(p.id, { title: 'Big work', description: 'FILE: big.txt', role: 'implementer', kind: 'build', adhoc: true });
    void orchestrator.tick();
    const end = Date.now() + 60_000;
    while (Date.now() < end && !['done', 'failed', 'in_review'].includes(getTask(t.id)!.status)) await new Promise(r => setTimeout(r, 150));
    orchestrator.pause(p.id);
    await orchestrator.idle();
    const done = getTask(t.id)!;
    // A partial result is reviewed before it is merged (reviewPolicy auto): that is the normal path.
    assert.ok(['done', 'in_review'].includes(done.status), `${done.status} ${done.error}`);
    assert.equal(done.result?.status, 'partial');
    const runs = (await call('GET', `/api/tasks/${t.id}`)).runs;
    assert.equal(runs.length, 1, 'stop and checkpoint happen in one attempt');
    const timing = runs[0].timing;
    assert.ok(timing, 'the run records where its time went');
    assert.ok(timing.compactions >= 2 && timing.compactions < 5, `stopped after the second compaction (default budget): ${timing.compactions}`);
    assert.ok(timing.totalMs >= timing.modelMs && timing.startupMs > 0);
    const log = readFileSync(join(paths.logs, p.id, readdirSync(join(paths.logs, p.id)).find(f => f.startsWith(`T${done.seq}-r1-`))!), 'utf8');
    assert.match(log, /STOP: CONTEXT BUDGET SPENT/);
    assert.match(log, /# prompt \(resuming mock-/, 'the checkpoint continues the same conversation');
  } finally {
    await d.shutdown();
  }
});
