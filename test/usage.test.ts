// Token usage parsing, using stream shapes captured from Claude Code 2.1.327 and Codex 0.157 (ids replaced).
import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, claudeUsage, codexRolloutUsage, codexUsage, resolveInvocation, usageOf } from '../src/server/usage.ts';

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
