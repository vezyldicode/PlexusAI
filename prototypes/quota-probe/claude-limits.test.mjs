// Run: node --test prototypes/quota-probe/
// real-*.ndjson fixtures are captured from Claude Code 2.1.327; the rest are SYNTHETIC, built from
// the status/error enums found in the CLI binary, and must be replaced by real captures once an
// account actually hits its limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyClaudeRun, parseEvents, UNKNOWN_RESET_BACKOFF_MS } from './claude-limits.mjs';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-18T13:00:00Z');
const RESET_5H = 1795021200;   // 2026-11-18T17:00:00Z
const RESET_7D = 1795158000;

const rle = (status, extra = {}, windows = {}) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status, rateLimitType: 'five_hour', resetsAt: RESET_5H, ...extra,
    unifiedWindows: {
      five_hour: { utilization: 0.4, resetsAt: RESET_5H, status: 'allowed' },
      seven_day: { utilization: 0.2, resetsAt: RESET_7D, status: 'allowed' }, ...windows,
    },
  },
});
const assistant = (text, error) => JSON.stringify({ type: 'assistant', ...(error && { error }), message: { content: [{ type: 'text', text }] } });
const result = (text, is_error) => JSON.stringify({ type: 'result', subtype: 'success', is_error, result: text });
const run = (lines, exitCode = 0) => classifyClaudeRun({ stdout: lines.join('\n'), exitCode, now: NOW });

test('real: normal run → ok with both windows', () => {
  const r = classifyClaudeRun({ stdout: fx('real-ok.ndjson'), now: NOW });
  assert.equal(r.state, 'ok');
  assert.equal(r.windows.five_hour.usedPercent, 10);
  assert.equal(r.windows.seven_day.usedPercent, 19);
});

test('real: account without login → needs_login', () => {
  const r = classifyClaudeRun({ stdout: fx('real-not-logged-in.ndjson'), exitCode: 1, now: NOW });
  assert.equal(r.state, 'needs_login');
  assert.equal(r.reason, 'authentication_failed');
});

test('synthetic: allowed_warning → warning', () => {
  const r = run([rle('allowed_warning', { surpassedThreshold: 0.8 }), result('ok', false)]);
  assert.equal(r.state, 'warning');
});

test('synthetic: allowed but utilization ≥ 90% → warning', () => {
  const r = run([rle('allowed', {}, { five_hour: { utilization: 0.93, resetsAt: RESET_5H, status: 'allowed' } }), result('ok', false)]);
  assert.equal(r.state, 'warning');
});

test('synthetic: rejected 5h window → limited until reset', () => {
  const r = run([rle('rejected'), assistant("You've hit your session limit · resets 5pm", 'rate_limit'), result("You've hit your session limit · resets 5pm", true)], 1);
  assert.equal(r.state, 'limited');
  assert.equal(r.limitedWindow, 'five_hour');
  assert.equal(r.cooldownUntil, '2026-11-18T17:00:00.000Z');
});

test('synthetic: rejected weekly window via per-window status', () => {
  const r = run([rle('allowed', {}, { seven_day: { utilization: 1, resetsAt: RESET_7D, status: 'rejected' } })], 1);
  assert.equal(r.state, 'limited');
  assert.equal(r.limitedWindow, 'seven_day');
  assert.equal(r.cooldownUntil, new Date(RESET_7D * 1000).toISOString());
});

test('synthetic: only limit text, no event → limited with backoff', () => {
  const r = run([assistant("You've hit your limit", 'rate_limit'), result("You've hit your limit", true)], 1);
  assert.equal(r.state, 'limited');
  assert.equal(r.cooldownUntil, new Date(NOW + UNKNOWN_RESET_BACKOFF_MS).toISOString());
});

test('synthetic: weekly limit text → seven_day window', () => {
  const r = run([rle('allowed'), result("You've hit your weekly limit · resets Fri 7am", true)], 1);
  assert.equal(r.state, 'limited');
  assert.equal(r.limitedWindow, 'seven_day');
  assert.equal(r.cooldownUntil, new Date(RESET_7D * 1000).toISOString());
});

test('synthetic: legacy "usage limit reached|epoch" text', () => {
  const r = run([result(`Claude AI usage limit reached|${RESET_5H}`, true)], 1);
  assert.equal(r.state, 'limited');
  assert.equal(r.cooldownUntil, '2026-11-18T17:00:00.000Z');
});

test('synthetic: overloaded → transient, not limited', () => {
  const r = run([assistant('API Error: overloaded', 'overloaded'), result('API Error: overloaded', true)], 1);
  assert.equal(r.state, 'transient');
});

test('synthetic: plain API rate_limit without "hit your limit" → transient', () => {
  const r = run([assistant('API Error: 429 rate_limit_error', 'rate_limit'), result('API Error: 429', true)], 1);
  assert.equal(r.state, 'transient');
});

test('synthetic: billing problem → blocked', () => {
  const r = run([assistant('Billing issue', 'billing_error'), result('Billing issue', true)], 1);
  assert.equal(r.state, 'blocked');
});

test('synthetic: task failure unrelated to account → task_error', () => {
  const r = run([rle('allowed'), result('Error: max turns reached', true)], 1);
  assert.equal(r.state, 'task_error');
});

test('rate_limit_event injected mid-line is still parsed', () => {
  const ev = rle('rejected');
  const broken = '{"type":"assistant","message":{"content":[{"type":"te' + ev + 'xt","text":"hi"}]}}';
  const events = parseEvents(broken);
  assert.equal(events.length, 1);
  assert.equal(run([broken]).state, 'limited');
});
