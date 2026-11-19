// Claude Code control protocol over stdio (verified on Claude Code 2.1.327, see docs/05-dynamic-model-effort-and-claude-quota.md).
// `claude -p --input-format stream-json --output-format stream-json` answers `control_request`s on stdin without a user
// message, so no model call is made and no quota is spent:
//   initialize → models (with supportedEffortLevels), account (logged in or not), claude_code_version
//   get_usage  → rate_limits (5h / weekly utilization in percent, 0-100) — the same data as `/usage`
// These subtypes are undocumented: every field is treated as optional and callers keep a fallback.
import { spawn } from 'node:child_process';
import type { Account, ModelInfo, QuotaSnapshot, QuotaWindow } from '../../shared/types.ts';
import { childEnv, killTree, resolveCli } from '../util/proc.ts';
import type { Classification } from './types.ts';

/** Send `initialize` plus the given control subtypes; resolve with each response body keyed by subtype. */
export function claudeControl(account: Account, subtypes: string[], timeoutMs = 30_000): Promise<Record<string, any>> {
  const { cmd, prefixArgs } = resolveCli('claude');
  const all = ['initialize', ...subtypes.filter(s => s !== 'initialize')];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, [...prefixArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      cwd: account.home, env: childEnv(cmd, { ...process.env, CLAUDE_CONFIG_DIR: account.home }), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const out: Record<string, any> = {};
    let buf = '', done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.stdin!.end(); } catch { /* closed */ }
      killTree(p);
      if (err) reject(err); else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error(`claude control timeout (${Object.keys(out).length}/${all.length} answers)`)), timeoutMs);
    p.on('error', e => finish(e));
    p.on('close', () => finish(Object.keys(out).length === all.length ? undefined : new Error('claude exited before answering')));
    p.stdin!.on('error', () => { /* reported by close */ });
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.type !== 'control_response') continue;
        const id = m.response?.request_id;
        if (!all.includes(id)) continue;
        out[id] = m.response?.subtype === 'success' ? (m.response.response ?? {}) : { error: m.response?.error ?? 'error' };
        if (Object.keys(out).length === all.length) finish();
      }
    });
    for (const s of all) p.stdin!.write(JSON.stringify({ type: 'control_request', request_id: s, request: { subtype: s } }) + '\n');
  });
}

export function claudeModelsFrom(init: any): ModelInfo[] {
  const list = Array.isArray(init?.models) ? init.models : [];
  return list.filter((m: any) => typeof m?.value === 'string').map((m: any): ModelInfo => ({
    id: m.value,
    resolved: typeof m.resolvedModel === 'string' ? m.resolvedModel : null,
    label: m.displayName ?? m.value,
    description: m.description ?? undefined,
    efforts: m.supportsEffort === false ? [] : (Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e: any) => typeof e === 'string') : []),
    defaultEffort: null,
    isDefault: m.value === 'default',
  }));
}

/** true / false when `initialize` says so; null when the answer has no account information. */
export function claudeLoggedInFrom(init: any): boolean | null {
  const a = init?.account;
  if (!a || typeof a !== 'object') return null;
  if (a.tokenSource === 'none') return false;
  return !!(a.email || a.subscriptionType || a.organization);
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v * 1000 : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function usageWindow(w: any, windowMins: number): QuotaWindow | null {
  if (!w || typeof w !== 'object') return null;
  // get_usage reports percent (0-100), unlike the stream's rate_limit_event (0-1).
  const pct = typeof w.utilization === 'number' ? Math.round(w.utilization) : null;
  return { usedPercent: pct, resetsAt: isoOrNull(w.resets_at), windowMins, status: w.locked_reason ?? null };
}

/** QuotaSnapshot from a `get_usage` answer; null when the account has no rate limits to report (not logged in, API key...). */
export function claudeUsageQuota(usage: any): QuotaSnapshot | null {
  const rl = usage?.rate_limits;
  if (!usage?.rate_limits_available || !rl) return null;
  const primary = usageWindow(rl.five_hour, 300), secondary = usageWindow(rl.seven_day, 7 * 1440);
  if (!primary && !secondary) return null;
  return { primary, secondary, plan: usage.subscription_type ?? null, source: 'usage-api', at: new Date().toISOString() };
}

/**
 * Account state from `get_usage`. Any limit (session, weekly, per-model) at 100% → limited until its reset;
 * ≥ 90% → warning. Reads both the generic `limits[]` list and the named windows.
 */
export function classifyClaudeUsage(usage: any, now = Date.now()): Classification | null {
  const rl = usage?.rate_limits;
  if (!usage?.rate_limits_available || !rl) return null;
  const all: { name: string; pct: number; resetsAt: string | null }[] = [];
  for (const l of Array.isArray(rl.limits) ? rl.limits : []) {
    if (typeof l?.percent === 'number') all.push({ name: String(l.kind ?? l.group ?? 'limit'), pct: l.percent, resetsAt: isoOrNull(l.resets_at) });
  }
  for (const [name, w] of Object.entries<any>(rl)) {
    if (w && typeof w === 'object' && typeof w.utilization === 'number' && 'resets_at' in w) all.push({ name, pct: w.utilization, resetsAt: isoOrNull(w.resets_at) });
  }
  if (!all.length) return null;
  const spent = all.filter(x => x.pct >= 100);
  if (spent.length) {
    const resets = spent.map(x => x.resetsAt).filter((r): r is string => !!r && Date.parse(r) > now).sort().at(-1) ?? null;
    return {
      state: 'limited', reason: 'quota_exhausted', limitedWindow: spent[0].name, resetsAt: resets,
      cooldownUntil: resets ?? new Date(now + 15 * 60_000).toISOString(), evidence: spent.map(x => `get_usage ${x.name}=${x.pct}%`),
    };
  }
  const max = all.reduce((a, b) => (b.pct > a.pct ? b : a));
  if (max.pct >= 90) return { state: 'warning', reason: 'near_limit', limitedWindow: max.name, evidence: [`get_usage ${max.name}=${max.pct}%`] };
  return { state: 'ok', reason: 'usage-api', evidence: [] };
}

export interface ClaudeStatus { loggedIn: boolean | null; models: ModelInfo[]; quota: QuotaSnapshot | null; classification: Classification | null; version: string | null }

/** One CLI start: login state, models with efforts and live quota. No model call. */
export async function readClaudeStatus(account: Account, timeoutMs?: number): Promise<ClaudeStatus> {
  const r = await claudeControl(account, ['get_usage'], timeoutMs);
  const init = r.initialize, usage = r.get_usage?.error ? null : r.get_usage;
  return {
    loggedIn: claudeLoggedInFrom(init), models: claudeModelsFrom(init), quota: claudeUsageQuota(usage),
    classification: classifyClaudeUsage(usage), version: typeof init?.claude_code_version === 'string' ? init.claude_code_version : null,
  };
}
