// Agent adapters: CLI output classification, events, models/efforts, token usage, result and coordinator output parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Plexus data folder must be set before any server module loads.
process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-adapters-'));
// No `git maintenance run --auto` after each commit in the throwaway repos.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });
const { describeClaudeEvent, describeClaudeEvents } = await import('../src/server/adapters/claude.ts');
const { chatProse } = await import('../src/server/coordinator.ts');
const { describeCodexEvent } = await import('../src/server/adapters/codex.ts');
const { parsePlan } = await import('../src/server/adapters/plan.ts');
const { addUsage, claudeUsage, codexRolloutUsage, codexUsage, resolveInvocation, usageOf } = await import('../src/server/usage.ts');

// ---- unit.test.ts (adapters)
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

test('Codex image arguments work for initial and resumed prompts', () => {
  assert.deepEqual(codexImageArgs(['/one.png', '/two.jpg']), ['-i', '/one.png', '-i', '/two.jpg']);
});

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

test('readResult falls back to the json block of the final message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexus-res-'));
  const r = readResult(dir, 'Done.\n```json\n{"status":"done","summary":"s","review":{"verdict":"approve"}}\n```');
  assert.equal(r?.review?.verdict, 'approve');
  assert.equal(readResult(dir, 'no json here'), null);
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
}

// ---- plan-events.test.ts
{
const claudeTool = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('claude: plexus_plan becomes a plan event', () => {
  const e = describeClaudeEvent(claudeTool('mcp__plexus__plexus_plan', { items: [{ step: 'Read code', status: 'completed' }, { step: 'Fix bug', status: 'in_progress' }, { step: 'Test', status: 'pending' }] }));
  assert.equal(e?.kind, 'plan');
  assert.deepEqual(parsePlan(e!.text), [
    { text: 'Read code', status: 'completed' }, { text: 'Fix bug', status: 'in_progress' }, { text: 'Test', status: 'pending' },
  ]);
});

test('claude: TodoWrite becomes a plan event, other tools stay tools', () => {
  const e = describeClaudeEvent(claudeTool('TodoWrite', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }] }));
  assert.equal(e?.kind, 'plan');
  assert.deepEqual(parsePlan(e!.text), [{ text: 'A', status: 'in_progress' }]);
  assert.deepEqual(describeClaudeEvent(claudeTool('Bash', { command: 'npm test' })), { kind: 'tool', text: 'Bash npm test' });
});

test('codex: todo_list and plexus_plan become plan events, other mcp calls are tools', () => {
  const todo = describeCodexEvent(JSON.stringify({ type: 'item.updated', item: { id: 'i1', type: 'todo_list', items: [{ text: 'A', completed: true }, { text: 'B', completed: false }] } }));
  assert.deepEqual(parsePlan(todo!.text), [{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }]);
  const plan = describeCodexEvent(JSON.stringify({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'plexus', tool: 'plexus_plan', arguments: { items: [{ step: 'X', status: 'in_progress' }] }, status: 'in_progress' } }));
  assert.equal(plan?.kind, 'plan');
  const status = describeCodexEvent(JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'mcp_tool_call', server: 'plexus', tool: 'plexus_task', arguments: { id: 'T5' }, status: 'in_progress' } }));
  assert.deepEqual(status, { kind: 'tool', text: 'plexus_task T5' });
  // The completed call repeats the start: shown once.
  assert.equal(describeCodexEvent(JSON.stringify({ type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', tool: 'plexus_task', arguments: {} } })), null);
});

test('a plan without usable steps is no plan', () => {
  assert.equal(describeClaudeEvent(claudeTool('mcp__plexus__plexus_plan', { items: [] }))?.kind, 'tool');
  assert.equal(parsePlan('nope'), null);
});

test('claude: words and every tool call of one message come through in order', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Reading the store first.' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'ui/src/store.ts' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'chat.activity' } },
    { type: 'text', text: 'Then the panel.' },
  ] } });
  assert.deepEqual(describeClaudeEvents(line).map(e => e.kind), ['text', 'tool', 'tool', 'text']);
  assert.equal(describeClaudeEvents(line)[0].text, 'Reading the store first.');
});

test('coordinator: its JSON answer is not shown as progress', () => {
  assert.equal(chatProse('{ "reply": "Done", "actions": [] }'), '');
  assert.equal(chatProse('Looked at it.\n```json\n{ "reply": "Done" }\n```'), 'Looked at it.');
  assert.equal(chatProse('Checking the **board** now'), 'Checking the **board** now');
});
}

// ---- models.test.ts
{
// Models, efforts and Claude usage, using answers captured from Claude Code 2.1.327 and Codex 0.157 (personal data removed).


const { claudeModelsFrom, claudeLoggedInFrom, claudeUsageQuota, classifyClaudeUsage } = await import('../src/server/adapters/claude-control.ts');
const { codexModelsFrom } = await import('../src/server/adapters/codex-appserver.ts');
const { resolveEffort, findModel, cleanEfforts, modelCatalog, rememberModels } = await import('../src/server/models.ts');

const EFF = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeInit = {
  claude_code_version: '2.1.327',
  account: { email: 'someone@example.com', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
  models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: EFF },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: EFF },
    { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', supportsThinkingOff: true },
    { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  ],
};

const usage = (five: number, week: number) => ({
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: five, resets_at: '2099-11-19T13:40:00.683151+00:00', locked_reason: null },
    seven_day: { utilization: week, resets_at: '2099-11-20T07:00:00.683171+00:00', locked_reason: null },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, utilization: null },
    limits: [
      { kind: 'session', group: 'session', percent: five, severity: 'normal', resets_at: '2099-11-19T13:40:00.683151+00:00' },
      { kind: 'weekly_all', group: 'weekly', percent: week, severity: 'normal', resets_at: '2099-11-20T07:00:00.683171+00:00' },
    ],
  },
});

test('claude initialize: models with efforts; a model without supportsEffort takes none', () => {
  const m = claudeModelsFrom(claudeInit);
  assert.equal(m.length, 4);
  assert.deepEqual(m.find(x => x.id === 'opus')!.efforts, EFF);
  assert.deepEqual(m.find(x => x.id === 'claude-haiku-4-5-20251001')!.efforts, []);
  assert.equal(m.find(x => x.isDefault)!.id, 'default');
  assert.equal(m.find(x => x.id === 'opus')!.resolved, 'claude-opus-5-5');
});

test('claude initialize: login state from the account block', () => {
  assert.equal(claudeLoggedInFrom(claudeInit), true);
  assert.equal(claudeLoggedInFrom({ account: { tokenSource: 'none', apiProvider: 'firstParty' } }), false);
  assert.equal(claudeLoggedInFrom({}), null);
});

test('claude get_usage: utilization is already percent (not 0-1)', () => {
  const q = claudeUsageQuota(usage(11, 37))!;
  assert.equal(q.primary!.usedPercent, 11);
  assert.equal(q.secondary!.usedPercent, 37);
  assert.equal(q.primary!.resetsAt, '2099-11-19T13:40:00.683Z');
  assert.equal(q.source, 'usage-api');
  assert.equal(q.plan, 'pro');
  const loggedOut = { subscription_type: null, rate_limits_available: false, rate_limits: null };
  assert.equal(claudeUsageQuota(loggedOut), null);
  assert.equal(classifyClaudeUsage(loggedOut), null);
});

test('claude get_usage: ok / warning / limited with the reset of the used-up window', () => {
  assert.equal(classifyClaudeUsage(usage(11, 37))!.state, 'ok');
  assert.equal(classifyClaudeUsage(usage(92, 37))!.state, 'warning');
  const l = classifyClaudeUsage(usage(40, 100))!;
  assert.equal(l.state, 'limited');
  assert.equal(l.cooldownUntil, '2099-11-20T07:00:00.683Z');
  // A per-model weekly window counts too.
  const u = usage(10, 10);
  (u.rate_limits as any).seven_day_opus = { utilization: 100, resets_at: '2099-11-21T00:00:00Z' };
  assert.equal(classifyClaudeUsage(u)!.state, 'limited');
});

test('codex model/list: efforts from objects (ultra included), default effort kept', () => {
  const m = codexModelsFrom({ data: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [...EFF, 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
    { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'gpt-reserve', hidden: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
  ], nextCursor: null });
  assert.deepEqual(m[0].efforts, [...EFF, 'ultra']);
  assert.equal(m[0].defaultEffort, 'low');
  assert.equal(m[0].isDefault, true);
  assert.equal(m[1].hidden, true);
});

test('resolveEffort: keeps supported, drops unsupported, passes through without model information', () => {
  const m = claudeModelsFrom(claudeInit);
  assert.deepEqual(resolveEffort(m, 'opus', 'high'), { effort: 'high', warning: null });
  assert.equal(resolveEffort(m, 'claude-opus-5-5', 'XHIGH').effort, 'xhigh', 'full id and case-insensitive');
  assert.equal(resolveEffort(m, undefined, 'max').effort, 'max', 'no model → the CLI default model');
  const s = resolveEffort(m, 'claude-sonnet-4-6', 'xhigh');
  assert.equal(s.effort, undefined);
  assert.match(s.warning!, /supports low, medium, high, max/);
  assert.equal(resolveEffort(m, 'claude-haiku-4-5-20251001', 'low').effort, undefined);
  assert.equal(resolveEffort(m, 'some-new-model', 'high').effort, 'high', 'unknown model: pass through');
  assert.equal(resolveEffort(null, 'opus', 'high').effort, 'high');
  assert.equal(resolveEffort(m, 'opus', 'rm -rf').effort, undefined);
  assert.deepEqual(resolveEffort(m, 'opus', ''), { effort: undefined, warning: null });
  assert.equal(findModel(m, 'OPUS')!.id, 'opus');
});

test('cleanEfforts: only known providers and well-formed names', () => {
  assert.deepEqual(cleanEfforts({ claude: ' High ', codex: 'bad value', other: 'low', mock: 3 }), { claude: 'high' });
});

test('model catalog merges accounts of the same provider', async () => {
  const acc = (id: string) => ({ id, provider: 'claude', label: id, home: '', enabled: true, priority: 1, maxConcurrency: 1, state: 'ok', stateReason: null, cooldownUntil: null, quota: null, createdAt: '' }) as any;
  rememberModels('c1', [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }]);
  rememberModels('c2', [{ id: 'opus', label: 'Opus', efforts: ['high', 'max'] }, { id: 'sonnet', label: 'Sonnet', efforts: [] }]);
  const { catalog } = await modelCatalog([acc('c1'), acc('c2'), { ...acc('c3'), enabled: false }]);
  const opus = catalog.claude!.find(m => m.id === 'opus')!;
  assert.deepEqual(opus.accounts, ['c1', 'c2']);
  assert.deepEqual(opus.efforts, ['low', 'high', 'max']);
  assert.deepEqual(catalog.claude!.find(m => m.id === 'sonnet')!.accounts, ['c2']);
});
}

// ---- usage.test.ts
{
// Token usage parsing, using stream shapes captured from Claude Code 2.1.327 and Codex 0.157 (ids replaced).

const ndjson = (...xs: unknown[]) => xs.map(x => JSON.stringify(x)).join('\n');
const call = (id: string, model: string, u: Record<string, number>) => ({ type: 'assistant', message: { id, model, usage: u, content: [] } });

const claudeRun = ndjson(
  call('m1', 'claude-opus-5-5', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 3 }),
  call('m1', 'claude-opus-5-5', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 3 }), // same call, second block
  call('m2', 'claude-opus-5-5', { input_tokens: 1, cache_read_input_tokens: 150, cache_creation_input_tokens: 10, output_tokens: 1 }),
  {
    type: 'result', subtype: 'success', total_cost_usd: 0.5,
    usage: { input_tokens: 3, cache_read_input_tokens: 250, cache_creation_input_tokens: 60, output_tokens: 900 },
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 3, outputTokens: 900, cacheReadInputTokens: 250, cacheCreationInputTokens: 60, thinkingTokens: 40, costUSD: 0.49 },
      'claude-haiku-5-5': { inputTokens: 200, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 0.01 },
    },
  },
);

test('claude: modelUsage is the report (helper models included), stream calls are deduplicated', () => {
  const { reported, stream } = claudeUsage(claudeRun);
  assert.equal(reported!.total, 3 + 250 + 60 + 900 + 200 + 10);
  assert.equal(reported!.reasoning, 40);
  assert.equal(reported!.costUsd!.toFixed(2), '0.50');
  assert.deepEqual(Object.keys(reported!.byModel).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(stream!.cacheRead, 250);
  assert.equal(stream!.partial, true);
});

test('claude: a killed run (no result) falls back to the stream, marked partial', () => {
  const killed = claudeRun.split('\n').slice(0, 3).join('\n');
  const u = resolveInvocation('claude', claudeUsage(killed), null, false)!;
  assert.equal(u.input + u.cacheRead + u.cacheWrite, 2 + 100 + 50 + 1 + 150 + 10);
  assert.equal(u.partial, true);
});

test('codex: input excludes the cached part; resumed thread totals are reduced to the turn', () => {
  const turn = (i: number, c: number, o: number) => ndjson({ type: 'thread.started', thread_id: 't1' }, { type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } });
  const first = codexUsage(turn(22534, 12288, 54), 'gpt-5').reported!;
  assert.equal(first.input, 22534 - 12288);
  assert.equal(first.total, 22534 + 54);
  const second = resolveInvocation('codex', codexUsage(turn(47433, 34688, 310), 'gpt-5'), first, true)!;
  assert.equal(second.output, 310 - 54);
  assert.equal(second.total, (47433 + 310) - (22534 + 54));
});

test('claude resume: the report is reduced only when it looks cumulative', () => {
  const prev = claudeUsage(claudeRun).reported!;
  const own = { reported: null, stream: usageOf({ m: { input: 5, cacheRead: 300, cacheWrite: 20, output: 2, reasoning: 0, costUsd: null } }, true) };
  // Per-invocation report: about what the stream shows, kept as it is.
  const perTurn = usageOf({ m: { input: 5, cacheRead: 300, cacheWrite: 20, output: 400, reasoning: 0, costUsd: null } });
  assert.equal(resolveInvocation('claude', { ...own, reported: perTurn }, prev, true)!.total, perTurn.total);
  // Cumulative report: the previous totals plus this turn, reduced to this turn.
  const cumulative = addUsage(prev, perTurn)!;
  assert.equal(resolveInvocation('claude', { ...own, reported: cumulative }, prev, true)!.total, perTurn.total);
});

// Numbers from a real three-turn Haiku conversation (Claude Code 2.1.327): on --resume `usage` is the turn's,
// `modelUsage` and `total_cost_usd` are the session's running totals.
const realClaude = (turn: number[], session: number[], cost: number) => ndjson(
  call('m', 'claude-haiku-5-5', { input_tokens: turn[0], cache_read_input_tokens: turn[1], cache_creation_input_tokens: turn[2], output_tokens: 1 }),
  {
    type: 'result', subtype: 'success', total_cost_usd: cost,
    usage: { input_tokens: turn[0], cache_read_input_tokens: turn[1], cache_creation_input_tokens: turn[2], output_tokens: turn[3] },
    modelUsage: { 'claude-haiku-5-5': { inputTokens: session[0], cacheReadInputTokens: session[1], cacheCreationInputTokens: session[2], outputTokens: session[3], costUSD: cost } },
  },
);

test('claude real resume: running totals are reduced to the turn, with or without the previous report', () => {
  const t1 = claudeUsage(realClaude([4, 7016, 7325, 192], [4, 7016, 7325, 192], 0.00163156));
  const t2 = claudeUsage(realClaude([2, 8995, 97, 5], [6, 16011, 7422, 197], 0.00174361));
  const withPrev = resolveInvocation('claude', t2, t1.reported, true)!;
  assert.deepEqual([withPrev.input, withPrev.cacheRead, withPrev.cacheWrite, withPrev.output], [2, 8995, 97, 5]);
  assert.equal(withPrev.costUsd!.toFixed(6), '0.000112');
  const noPrev = resolveInvocation('claude', t2, null, true)!;
  assert.deepEqual([noPrev.input, noPrev.cacheRead, noPrev.cacheWrite, noPrev.output], [2, 8995, 97, 5]);
  assert.equal(noPrev.costUsd, null);
});

test('codex rollout: one invocation is the records inside its time window, with the model of their turn', () => {
  const rec = (at: string, turn: string, i: number, c: number, o: number) => ({ timestamp: at, type: 'token_usage_record', payload: { turn_id: turn, usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } });
  const ctx = (at: string, turn: string, model: string) => ({ timestamp: at, type: 'turn_context', payload: { turn_id: turn, model } });
  const roll = ndjson(
    ctx('2026-11-20T03:23:26Z', 'a', 'gpt-6-luna'), rec('2026-11-20T03:23:28Z', 'a', 14739, 0, 43), rec('2026-11-20T03:23:30Z', 'a', 14877, 14592, 21),
    ctx('2026-11-20T03:23:33Z', 'b', 'gpt-6-luna'), rec('2026-11-20T03:23:34Z', 'b', 15663, 0, 19),
  );
  const first = codexRolloutUsage(roll, Date.parse('2026-11-20T03:23:24Z'), Date.parse('2026-11-20T03:23:31Z'))!;
  assert.deepEqual([first.input, first.cacheRead, first.output, first.total], [15024, 14592, 64, 29680]);
  const second = codexRolloutUsage(roll, Date.parse('2026-11-20T03:23:31Z'), Date.parse('2026-11-20T03:23:35Z'))!;
  assert.deepEqual(Object.keys(second.byModel), ['gpt-6-luna']);
  assert.equal(second.total, 15682);
  assert.equal(codexRolloutUsage(roll, Date.parse('2026-11-20T04:00:00Z'), Date.parse('2026-11-20T04:01:00Z')), null);
});
}
