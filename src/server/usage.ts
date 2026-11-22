// Token usage: parsed from the provider CLI output, normalized to one shape, stored per run and summed per task/project.
//
// Verified with real runs on Claude Code 2.1.327 and Codex 0.157 (three-turn conversations resumed with --resume / exec resume):
// - Claude `result.usage` counts this invocation only (main model). `result.modelUsage` and `total_cost_usd` add helper models
//   and cost, but on --resume they are the session's running totals. Assistant events carry per-call usage whose
//   input/cache figures are exact and whose output is the count at stream start.
// - Codex `turn.completed.usage` counts the whole thread, and `input_tokens` includes `cached_input_tokens`. The rollout file
//   (CODEX_HOME/sessions/.../rollout-*-<thread>.jsonl) has one `token_usage_record` per model response with its turn,
//   and each turn's model in `turn_context`: the exact share of one invocation, even a killed one.
import type { ModelTokens, ProjectUsage, Provider, TokenUsage } from '../shared/types.ts';
import { parseEvents } from './adapters/claude-limits.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, json, now } from './db.ts';

const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const zeroModel = (): ModelTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: null });

function addModel(a: ModelTokens, b: ModelTokens): ModelTokens {
  const out = zeroModel();
  for (const f of FIELDS) out[f] = a[f] + b[f];
  out.costUsd = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return out;
}

function subModel(a: ModelTokens, b: ModelTokens): ModelTokens {
  const out = zeroModel();
  for (const f of FIELDS) out[f] = Math.max(0, a[f] - b[f]);
  out.costUsd = a.costUsd === null ? null : Math.max(0, a.costUsd - (b.costUsd ?? 0));
  return out;
}

/** Build a usage from its models; the top-level figures are their sum. */
export function usageOf(byModel: Record<string, ModelTokens>, partial = false): TokenUsage {
  const sum = Object.values(byModel).reduce(addModel, zeroModel());
  const u: TokenUsage = { ...sum, total: sum.input + sum.cacheRead + sum.cacheWrite + sum.output, byModel };
  if (partial) u.partial = true;
  return u;
}

export function addUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const byModel: Record<string, ModelTokens> = { ...a.byModel };
  for (const [m, t] of Object.entries(b.byModel)) byModel[m] = byModel[m] ? addModel(byModel[m], t) : t;
  const out = usageOf(byModel, !!(a.partial || b.partial));
  // Call metrics of b following a (a failed resume, then a fresh start): calls add up, the last context is b's.
  if (a.calls || b.calls) withCtx(out, [...ctxList(a), ...ctxList(b)]);
  return out;
}

/** Context sizes to metrics: number of calls, first, largest and last context. */
export function withCtx(u: TokenUsage, ctxs: number[]): TokenUsage {
  const c = ctxs.filter(x => x > 0);
  if (!c.length) return u;
  u.calls = c.length; u.firstCtx = c[0]; u.maxCtx = Math.max(...c); u.lastCtx = c[c.length - 1];
  return u;
}
/** Approximate list back from metrics (first, …, max, last), enough to combine two invocations. */
const ctxList = (u: TokenUsage): number[] => !u.calls ? [] : u.calls === 1 ? [u.lastCtx ?? 0]
  : [u.firstCtx ?? 0, ...Array(Math.max(0, u.calls - 2)).fill(u.maxCtx ?? 0), u.lastCtx ?? 0];

export function sumUsage(list: (TokenUsage | null | undefined)[]): TokenUsage | null {
  return list.reduce<TokenUsage | null>((acc, u) => addUsage(acc, u), null);
}

function subUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const byModel: Record<string, ModelTokens> = {};
  for (const [m, t] of Object.entries(a.byModel)) {
    const d = b.byModel[m] ? subModel(t, b.byModel[m]) : t;
    if (FIELDS.some(f => d[f] > 0)) byModel[m] = d; // a model this turn did not use drops out
  }
  return usageOf(byModel, !!a.partial);
}

const inputSide = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite;

// ---------------- provider parsers ----------------

export interface ParsedUsage {
  /** What the CLI reported at the end of the invocation (may be cumulative over a resumed conversation). */
  reported: TokenUsage | null;
  /** Claude: `result.usage`, this invocation's main model only, always per invocation. */
  turn?: TokenUsage | null;
  /** Claude: summed from per-call stream events (exact input/cache, output undercounted), for runs with no result. */
  stream: TokenUsage | null;
  /** Context size of each model call, in order (Claude stream events). */
  ctxs?: number[];
}

const claudeTokens = (u: any, cost: number | null): ModelTokens => ({
  input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens),
  output: n(u.output_tokens), reasoning: n(u.output_tokens_details?.thinking_tokens), costUsd: cost,
});

/** Claude `stream-json` output. */
export function claudeUsage(stdout: string): ParsedUsage {
  const calls = new Map<string, { model: string; u: any }>();
  let result: any = null;
  for (const e of parseEvents(stdout)) {
    if (e.type === 'assistant' && e.message?.usage) calls.set(e.message.id ?? `#${calls.size}`, { model: e.message.model ?? 'claude', u: e.message.usage });
    if (e.type === 'result') result = e;
  }
  let stream: TokenUsage | null = null;
  const byCalls: Record<string, ModelTokens> = {};
  for (const { model, u } of calls.values()) byCalls[model] = addModel(byCalls[model] ?? zeroModel(), { ...claudeTokens(u, null), reasoning: 0 });
  if (calls.size) stream = usageOf(byCalls, true);
  // The main model: the one most calls went to.
  const counts = new Map<string, number>();
  for (const { model } of calls.values()) counts.set(model, (counts.get(model) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'claude';

  const ctxs = [...calls.values()].map(({ u }) => n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens));
  const turn = result?.usage ? usageOf({ [main]: claudeTokens(result.usage, null) }) : null;
  let reported: TokenUsage | null = null;
  const mu = result?.modelUsage;
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    const byModel: Record<string, ModelTokens> = {};
    for (const [model, m] of Object.entries<any>(mu)) {
      byModel[model] = {
        input: n(m.inputTokens), cacheRead: n(m.cacheReadInputTokens), cacheWrite: n(m.cacheCreationInputTokens),
        output: n(m.outputTokens), reasoning: n(m.thinkingTokens), costUsd: typeof m.costUSD === 'number' ? m.costUSD : null,
      };
    }
    reported = usageOf(byModel);
  } else if (result?.usage) {
    reported = usageOf({ [main]: claudeTokens(result.usage, typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null) });
  }
  return { reported, turn, stream, ctxs };
}

/** Codex `exec --json` output (thread totals). The stream names no model, so the caller passes the one it asked for. */
export function codexUsage(stdout: string, model?: string): ParsedUsage {
  let u: any = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('turn.completed')) continue;
    try { const e = JSON.parse(line); if (e.type === 'turn.completed' && e.usage) u = e.usage; } catch { /* next */ }
  }
  return { reported: u ? usageOf({ [model || 'codex']: codexTokens(u) }) : null, stream: null };
}

function codexTokens(u: any): ModelTokens {
  const cached = n(u.cached_input_tokens);
  return {
    input: Math.max(0, n(u.input_tokens) - cached), cacheRead: cached, cacheWrite: n(u.cache_write_input_tokens),
    output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens), costUsd: null,
  };
}

/**
 * Codex: the responses of one invocation, from the thread's rollout file. Records outside [since, until] belong to other
 * invocations of the thread. Null when the file or its records are missing (older CLI, purged sessions).
 */
export function codexRolloutUsage(rollout: string, since: number, until: number): TokenUsage | null {
  const modelOfTurn = new Map<string, string>();
  const records: { at: number; turn: string; u: any }[] = [];
  const counts: { at: number; model: string; u: any }[] = [];
  let lastModel = 'codex';
  for (const line of rollout.split(/\r?\n/)) {
    if (!line.includes('turn_context') && !line.includes('token_usage_record') && !line.includes('token_count')) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.timestamp ?? '');
    if (e.type === 'turn_context' && e.payload?.model) { lastModel = e.payload.model; if (e.payload.turn_id) modelOfTurn.set(e.payload.turn_id, e.payload.model); }
    else if (e.type === 'token_usage_record' && e.payload?.usage) records.push({ at, turn: e.payload.turn_id, u: e.payload.usage });
    else if (e.payload?.type === 'token_count' && e.payload.info?.last_token_usage) counts.push({ at, model: lastModel, u: e.payload.info.last_token_usage });
  }
  // token_usage_record (per response, with its turn) when the CLI writes them; else the per-response token_count events.
  const rows = records.length ? records.map(r => ({ at: r.at, model: modelOfTurn.get(r.turn) ?? lastModel, u: r.u })) : counts;
  const byModel: Record<string, ModelTokens> = {};
  const ctxs: number[] = [];
  let any = false;
  for (const r of rows) {
    if (!(r.at >= since && r.at <= until)) continue;
    byModel[r.model] = addModel(byModel[r.model] ?? zeroModel(), codexTokens(r.u));
    ctxs.push(n(r.u.input_tokens)); // Codex input_tokens include the cached part: the whole context of that response
    any = true;
  }
  return any ? withCtx(usageOf(byModel), ctxs) : null;
}

const rolloutPaths = new Map<string, string>();

/** CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, newest folders first. */
export function findCodexRollout(codexHome: string, threadId: string): string | null {
  const hit = rolloutPaths.get(threadId);
  if (hit && existsSync(hit)) return hit;
  const root = join(codexHome, 'sessions');
  const dirs = (p: string) => { try { return readdirSync(p).sort().reverse(); } catch { return []; } };
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    const f = dirs(join(root, y, m, d)).find(x => x.endsWith(`${threadId}.jsonl`));
    if (f) { const p = join(root, y, m, d, f); rolloutPaths.set(threadId, p); return p; }
  }
  return null;
}

/**
 * The tokens this one invocation spent, given the conversation's previous report.
 * Codex reports are thread totals: the previous report is subtracted (when known).
 * Claude: `result.usage` is always this invocation's; `modelUsage` adds helper models and cost but may be the session's running
 * totals on --resume. Whichever of modelUsage and modelUsage minus the previous report matches `result.usage` is used;
 * when neither does, `result.usage` alone.
 */
export function resolveInvocation(provider: Provider, parsed: ParsedUsage, prev: TokenUsage | null, resumed: boolean): TokenUsage | null {
  const { reported, stream, turn } = parsed;
  if (!reported) return stream;
  if (!resumed) return reported;
  if (provider === 'codex') return prev ? subUsage(reported, prev) : reported;
  const anchor = turn ?? stream;
  if (!anchor) return prev ? subUsage(reported, prev) : reported;
  const a = inputSide(anchor);
  const close = (u: TokenUsage) => Math.abs(inputSide(u) - a) <= Math.max(64, a * 0.02);
  if (close(reported)) return reported;
  if (prev) { const d = subUsage(reported, prev); if (close(d)) return d; }
  return turn ?? reported;
}

// ---------------- storage ----------------

/** Last report of a CLI conversation, the baseline of its next resumed turn. */
function lastReport(sessionId: string): TokenUsage | null {
  const r = getDb().prepare('SELECT usage FROM cli_usage WHERE session_id = ?').get(sessionId) as { usage: string } | undefined;
  return r ? json<TokenUsage | null>(r.usage, null) : null;
}

function saveReport(sessionId: string, u: TokenUsage) {
  getDb().prepare('INSERT INTO cli_usage (session_id, usage, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET usage = excluded.usage, updated_at = excluded.updated_at')
    .run(sessionId, JSON.stringify(u), now());
}

export interface InvocationOpts {
  model?: string;
  resumeId?: string;
  sessionId?: string;
  /** Codex: the account's CODEX_HOME and the invocation's time window (ms), to read its share from the rollout file. */
  codexHome?: string;
  since?: number;
  until?: number;
}

/** Tokens of one finished invocation; remembers the CLI's report so the next resumed turn can be told apart. */
export function invocationUsage(provider: Provider, stdout: string, opts: InvocationOpts): TokenUsage | null {
  const parsed = provider === 'codex' ? codexUsage(stdout, opts.model) : claudeUsage(stdout);
  const key = opts.sessionId ?? opts.resumeId;
  const prev = opts.resumeId ? lastReport(opts.resumeId) : null;
  let out: TokenUsage | null = null;
  if (provider === 'codex' && opts.codexHome && key && opts.since != null) {
    const file = findCodexRollout(opts.codexHome, key);
    const text = file ? readFileSync(file, 'utf8') : '';
    out = text ? codexRolloutUsage(text, opts.since - 2000, (opts.until ?? Date.now()) + 2000) : null;
    if (out && !parsed.reported) out.partial = true; // killed before the turn completed: what the rollout has so far
  }
  out ??= resolveInvocation(provider, parsed, prev, !!opts.resumeId);
  if (out && parsed.ctxs?.length && !out.calls) out = withCtx({ ...out }, parsed.ctxs);
  if (parsed.reported && key) saveReport(key, parsed.reported);
  return out;
}

// ---------------- totals ----------------

/** Totals of a project: per task, per role, the coordinator chat, and all of it. */
export function projectUsage(projectId: string): ProjectUsage {
  const db = getDb();
  const rows = db.prepare(`SELECT r.task_id AS taskId, t.role AS role, r.usage AS usage FROM runs r JOIN tasks t ON t.id = r.task_id
                           WHERE t.project_id = ? AND r.usage IS NOT NULL AND r.usage != 'null'`).all(projectId) as { taskId: string; role: string; usage: string }[];
  const tasks: Record<string, TokenUsage> = {}, byRole: Record<string, TokenUsage> = {};
  for (const r of rows) {
    const u = json<TokenUsage | null>(r.usage, null);
    if (!u) continue;
    tasks[r.taskId] = addUsage(tasks[r.taskId], u)!;
    byRole[r.role] = addUsage(byRole[r.role], u)!;
  }
  const chat = db.prepare(`SELECT meta FROM messages WHERE project_id = ? AND author = 'coordinator' AND meta LIKE '%"tokens"%'`).all(projectId) as { meta: string }[];
  const coordinator = sumUsage(chat.map(m => json<any>(m.meta, null)?.tokens ?? null));
  return { total: addUsage(sumUsage(Object.values(tasks)), coordinator), tasks, byRole, coordinator };
}

// ---------------- backfill ----------------

/**
 * Fill `runs.usage` from the logs of runs that finished before usage was recorded. A log holds one section per
 * invocation ("# prompt ..." then the CLI output); a section header names the conversation it resumed.
 * Runs without readable usage get the JSON `null`, so they are not read again.
 */
export function backfillRunUsage(readLog: (path: string) => string | null): number {
  const db = getDb();
  const rows = db.prepare(`SELECT r.id, r.log_path AS logPath, r.started_at AS startedAt, r.ended_at AS endedAt, a.provider, a.home FROM runs r
                           LEFT JOIN accounts a ON a.id = r.account_id WHERE r.usage IS NULL AND r.ended_at IS NOT NULL ORDER BY r.id`)
    .all() as { id: number; logPath: string; startedAt: string; endedAt: string; provider: Provider | null; home: string | null }[];
  const set = db.prepare('UPDATE runs SET usage = ? WHERE id = ?');
  let filled = 0;
  for (const r of rows) {
    const text = readLog(r.logPath);
    let total: TokenUsage | null = null;
    if (text) {
      const provider: Provider = r.provider === 'codex' || (!r.provider && text.includes('"thread.started"')) ? 'codex' : 'claude';
      for (const section of text.split(/^(?=# prompt)/m)) {
        const resumeId = section.match(/^# prompt \(resuming ([^)\s]+)\)/)?.[1];
        const sessionId = provider === 'codex'
          ? section.match(/"type":"thread\.started","thread_id":"([^"]+)"/)?.[1]
          : section.match(/"session_id":"([^"]+)"/)?.[1];
        // Each section is its own thread (a failed resume is followed by a fresh one), read within the run's window.
        const window = provider === 'codex' && r.home ? { codexHome: r.home, since: Date.parse(r.startedAt), until: Date.parse(r.endedAt) } : {};
        total = addUsage(total, invocationUsage(provider, section, { resumeId, sessionId, ...window }));
      }
    }
    set.run(JSON.stringify(total), r.id);
    if (total) filled++;
  }
  return filled;
}
