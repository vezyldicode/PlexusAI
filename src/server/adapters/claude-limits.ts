// Classify one `claude -p --output-format stream-json --verbose` run (verified against Claude Code 2.1.327).
// See docs/02-quota-monitoring-feasibility.md §3.5 for the evidence behind each rule.
import type { Classification } from './types.ts';
import type { QuotaSnapshot, QuotaWindow } from '../../shared/types.ts';

export const WARN_UTILIZATION = 0.9;
export const UNKNOWN_RESET_BACKOFF_MS = 15 * 60 * 1000;
export const TRANSIENT_BACKOFF_MS = 60 * 1000;

const LIMIT_TEXT = /you'?ve hit your (?:(session|weekly|fast|monthly(?: spend)?|opus|sonnet)\s+)?limit|usage limit reached/i;
const LOGIN_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'verification_required']);
const BLOCKED_ERRORS = new Set(['account_on_hold', 'billing_error']);
const TRANSIENT_ERRORS = new Set(['overloaded', 'server_error']);

/** Tolerant NDJSON parse; recovers rate_limit_event objects injected mid-line. */
export function parseEvents(stdout: string): any[] {
  const events: any[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); continue; } catch { /* fall through */ }
    let from = 0, i: number;
    while ((i = line.indexOf('{"type":"rate_limit_event"', from)) >= 0) {
      const obj = scanObject(line, i);
      if (!obj) break;
      try { events.push(JSON.parse(obj)); } catch { /* ignore */ }
      from = i + obj.length;
    }
  }
  return events;
}

function scanObject(s: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, k + 1);
  }
  return null;
}

const iso = (sec?: number | null) => (sec ? new Date(sec * 1000).toISOString() : null);

export interface ClaudeWindow extends QuotaWindow { utilization: number | null }

export function windowsFrom(info: any): Record<string, ClaudeWindow> {
  const out: Record<string, ClaudeWindow> = {};
  for (const [name, w] of Object.entries<any>(info?.unifiedWindows ?? {})) {
    out[name] = {
      usedPercent: typeof w.utilization === 'number' ? Math.round(w.utilization * 100) : null,
      utilization: typeof w.utilization === 'number' ? w.utilization : null,
      status: w.status ?? null,
      resetsAt: iso(w.resetsAt),
    };
  }
  return out;
}

export interface ClaudeRunAnalysis extends Classification { windows: Record<string, ClaudeWindow>; finalText: string; usage?: Record<string, number> }

export function classifyClaudeRun(run: { stdout: string; stderr?: string; exitCode?: number; now?: number }): ClaudeRunAnalysis {
  const { stdout, stderr = '', exitCode = 0, now = Date.now() } = run;
  const events = parseEvents(stdout);
  const evidence: string[] = [];
  let rl: any = null, assistantError: string | null = null, assistantText = '', result: any = null;

  for (const e of events) {
    if (e.type === 'rate_limit_event' && e.rate_limit_info) rl = e.rate_limit_info;
    if (e.type === 'assistant') {
      if (e.error) assistantError = e.error;
      for (const c of e.message?.content ?? []) if (c.type === 'text') assistantText += c.text + '\n';
    }
    if (e.type === 'result') result = e;
  }
  const windows = windowsFrom(rl);
  const finalText = typeof result?.result === 'string' ? result.result : assistantText.trim();
  const usage = result?.usage ? Object.fromEntries(Object.entries(result.usage).filter(([, v]) => typeof v === 'number')) as Record<string, number> : undefined;
  const base = { windows, finalText, usage };
  const text = [assistantText, result?.result ?? '', stderr].join('\n');

  const rejectedWindow = Object.entries(windows).find(([, w]) => w.status === 'rejected')?.[0];
  if (rl?.status === 'rejected' || rejectedWindow) {
    const win = rl?.status === 'rejected' ? rl.rateLimitType : rejectedWindow!;
    const resetsAt = (rl?.status === 'rejected' && iso(rl.resetsAt)) || windows[win]?.resetsAt || null;
    evidence.push(`rate_limit_event status=rejected window=${win}`);
    return { ...base, ...limited(win, resetsAt, now, evidence) };
  }

  if (assistantError) evidence.push(`assistant.error=${assistantError}`);
  if (assistantError && LOGIN_ERRORS.has(assistantError)) return { ...base, state: 'needs_login', reason: assistantError, evidence };
  if (assistantError && BLOCKED_ERRORS.has(assistantError)) return { ...base, state: 'blocked', reason: assistantError, evidence };

  const m = text.match(LIMIT_TEXT);
  if (m) {
    evidence.push(`text: "${m[0]}"`);
    const win = /weekly/i.test(m[0]) ? 'seven_day' : /session/i.test(m[0]) ? 'five_hour' : rl?.rateLimitType ?? null;
    return { ...base, ...limited(win, (win && windows[win]?.resetsAt) || iso(rl?.resetsAt) || parseLegacyReset(text), now, evidence) };
  }
  if (/not logged in|please run \/login/i.test(text)) {
    evidence.push('text: not logged in');
    return { ...base, state: 'needs_login', reason: 'not_logged_in', evidence };
  }

  if (assistantError === 'rate_limit' || (assistantError && TRANSIENT_ERRORS.has(assistantError)) || (/overloaded|529|rate_limit_error/i.test(text) && result?.is_error)) {
    return { ...base, state: 'transient', reason: assistantError ?? 'api_error', cooldownUntil: new Date(now + TRANSIENT_BACKOFF_MS).toISOString(), evidence };
  }

  if (result?.is_error || exitCode !== 0 || assistantError || !result) {
    if (!result) evidence.push('no result event');
    return { ...base, state: 'task_error', reason: assistantError ?? result?.subtype ?? `exit ${exitCode}`, evidence };
  }

  const maxUtil = Math.max(0, ...Object.values(windows).map(w => w.utilization ?? 0));
  if (rl?.status === 'allowed_warning' || maxUtil >= WARN_UTILIZATION) {
    evidence.push(rl?.status === 'allowed_warning' ? 'rate_limit_event status=allowed_warning' : `utilization ${Math.round(maxUtil * 100)}%`);
    return { ...base, state: 'warning', reason: 'near_limit', limitedWindow: rl?.rateLimitType ?? null, evidence };
  }
  if (!rl) evidence.push('no rate_limit_event in output');
  return { ...base, state: 'ok', reason: 'ok', evidence };
}

function limited(win: string | null, resetsAt: string | null, now: number, evidence: string[]): Classification {
  const known = !!resetsAt && Date.parse(resetsAt) > now;
  if (!known) evidence.push('reset time unknown → re-probe after backoff');
  return {
    state: 'limited', reason: 'quota_exhausted', limitedWindow: win ?? null, resetsAt: resetsAt ?? null,
    cooldownUntil: known ? resetsAt : new Date(now + UNKNOWN_RESET_BACKOFF_MS).toISOString(), evidence,
  };
}

function parseLegacyReset(text: string): string | null {
  const m = text.match(/usage limit reached\|(\d{10})/i);
  return m ? iso(Number(m[1])) : null;
}

export function claudeQuota(windows: Record<string, ClaudeWindow>, source: QuotaSnapshot['source']): QuotaSnapshot | null {
  if (!windows.five_hour && !windows.seven_day) return null;
  const strip = (w?: ClaudeWindow): QuotaWindow | null => w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt, status: w.status } : null;
  return { primary: strip(windows.five_hour), secondary: strip(windows.seven_day), source, at: new Date().toISOString() };
}
