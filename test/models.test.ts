// Models, efforts and Claude usage, using answers captured from Claude Code 2.1.327 and Codex 0.157 (personal data removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEXUS_HOME = mkdtempSync(join(tmpdir(), 'plexus-models-'));

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
