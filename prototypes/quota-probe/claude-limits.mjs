// Classify the outcome of one `claude -p ... --output-format stream-json --verbose` run
// into an account state the swarm scheduler can act on.
//
// Evidence used (Claude Code 2.1.327):
//  - rate_limit_event.rate_limit_info.status ∈ "allowed" | "allowed_warning" | "rejected"
//    (+ rateLimitType, resetsAt, unifiedWindows.{five_hour,seven_day}.{utilization,status,resetsAt},
//     surpassedThreshold). Seen live: "allowed". "allowed_warning"/"rejected" taken from the CLI's enum.
//  - assistant message `error` ∈ authentication_failed | oauth_org_not_allowed | account_on_hold |
//    verification_required | billing_error | rate_limit | overloaded | invalid_request |
//    model_not_found | server_error | unknown | max_output_tokens | cloud_credential_error
//    (seen live: authentication_failed → "Not logged in · Please run /login").
//  - Text fallback: "You've hit your limit / session limit / weekly limit ..." in the result.
//
// Account states:
//   ok           usable
//   warning      usable, but past a warning threshold → avoid starting large tasks here
//   limited      subscription quota exhausted → cooldown until `cooldownUntil`, hand task off
//   transient    API overloaded / short 429 / 5xx → retry the same account soon
//   needs_login  credentials missing/expired → user must log in again (UI shows a button)
//   blocked      account on hold / billing problem → disable account, notify user
//   task_error   run failed for reasons unrelated to the account (bad prompt, model, tool...)

export const WARN_UTILIZATION = 0.9;          // treat ≥ 90 % used as warning even if server says "allowed"
export const UNKNOWN_RESET_BACKOFF_MS = 15 * 60 * 1000; // limited but no reset time → re-probe after 15 min
export const TRANSIENT_BACKOFF_MS = 60 * 1000;

const LIMIT_TEXT = /you'?ve hit your (?:(session|weekly|fast|monthly(?: spend)?|opus|sonnet)\s+)?limit|usage limit reached/i;
const LOGIN_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'verification_required']);
const BLOCKED_ERRORS = new Set(['account_on_hold', 'billing_error']);
const TRANSIENT_ERRORS = new Set(['overloaded', 'server_error']);

// Parse NDJSON tolerantly. Some CLI versions inject rate_limit_event in the middle of another
// line, so if a line does not parse we also scan it for embedded {"type":"rate_limit_event"...} objects.
export function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); continue; } catch {}
    let from = 0, i;
    while ((i = line.indexOf('{"type":"rate_limit_event"', from)) >= 0) {
      const obj = scanObject(line, i);
      if (!obj) break;
      try { events.push(JSON.parse(obj)); } catch {}
      from = i + obj.length;
    }
  }
  return events;
}

function scanObject(s, start) {
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

const iso = sec => (sec ? new Date(sec * 1000).toISOString() : null);

function windowsFrom(info) {
  const out = {};
  for (const [name, w] of Object.entries(info?.unifiedWindows ?? {})) {
    out[name] = {
      usedPercent: typeof w.utilization === 'number' ? Math.round(w.utilization * 100) : null,
      utilization: w.utilization ?? null,
      status: w.status ?? null,
      resetsAt: iso(w.resetsAt),
      surpassedThreshold: w.surpassedThreshold ?? null,
    };
  }
  return out;
}

/**
 * @param {{stdout: string, stderr?: string, exitCode?: number, now?: number}} run
 * @returns {{state: string, reason: string, limitedWindow?: string|null, resetsAt?: string|null,
 *            cooldownUntil?: string|null, windows: object, evidence: string[]}}
 */
export function classifyClaudeRun({ stdout, stderr = '', exitCode = 0, now = Date.now() }) {
  const events = parseEvents(stdout);
  const evidence = [];
  let rl = null, assistantError = null, assistantText = '', result = null;

  for (const e of events) {
    if (e.type === 'rate_limit_event' && e.rate_limit_info) rl = e.rate_limit_info; // keep the latest
    if (e.type === 'assistant') {
      if (e.error) assistantError = e.error;
      for (const c of e.message?.content ?? []) if (c.type === 'text') assistantText += c.text + '\n';
    }
    if (e.type === 'result') result = e;
  }
  const windows = windowsFrom(rl);
  const text = [assistantText, result?.result ?? '', stderr].join('\n');

  // 1) Structured rate-limit status — most reliable.
  const rejectedWindow = Object.entries(windows).find(([, w]) => w.status === 'rejected')?.[0];
  if (rl?.status === 'rejected' || rejectedWindow) {
    const win = rl?.status === 'rejected' ? rl.rateLimitType : rejectedWindow;
    const resetsAt = (rl?.status === 'rejected' && iso(rl.resetsAt)) || windows[win]?.resetsAt || null;
    evidence.push(`rate_limit_event status=rejected window=${win}`);
    return limited(win, resetsAt, now, windows, evidence);
  }

  // 2) Assistant/result error codes.
  if (assistantError) evidence.push(`assistant.error=${assistantError}`);
  if (LOGIN_ERRORS.has(assistantError)) return { state: 'needs_login', reason: assistantError, windows, evidence };
  if (BLOCKED_ERRORS.has(assistantError)) return { state: 'blocked', reason: assistantError, windows, evidence };

  // 3) Text fallback for "You've hit your … limit" (covers versions without rejected events).
  const m = text.match(LIMIT_TEXT);
  if (m) {
    evidence.push(`text: "${m[0]}"`);
    const win = /weekly/i.test(m[0]) ? 'seven_day' : /session/i.test(m[0]) ? 'five_hour' : rl?.rateLimitType ?? null;
    return limited(win, (win && windows[win]?.resetsAt) || iso(rl?.resetsAt) || parseLegacyReset(text), now, windows, evidence);
  }
  if (/not logged in|please run \/login/i.test(text)) {
    evidence.push('text: not logged in');
    return { state: 'needs_login', reason: 'not_logged_in', windows, evidence };
  }

  // 4) Transient API problems: retry the same account shortly.
  if (assistantError === 'rate_limit' || TRANSIENT_ERRORS.has(assistantError) || /overloaded|529|rate_limit_error/i.test(text) && result?.is_error) {
    return { state: 'transient', reason: assistantError ?? 'api_error', cooldownUntil: new Date(now + TRANSIENT_BACKOFF_MS).toISOString(), windows, evidence };
  }

  // 5) Run failed but the account itself is fine.
  if (result?.is_error || exitCode !== 0 || assistantError) {
    return { state: 'task_error', reason: assistantError ?? result?.subtype ?? `exit ${exitCode}`, windows, evidence };
  }

  // 6) Success: ok or warning.
  const maxUtil = Math.max(0, ...Object.values(windows).map(w => w.utilization ?? 0));
  if (rl?.status === 'allowed_warning' || maxUtil >= WARN_UTILIZATION) {
    evidence.push(rl?.status === 'allowed_warning' ? 'rate_limit_event status=allowed_warning' : `utilization ${Math.round(maxUtil * 100)}% ≥ ${WARN_UTILIZATION * 100}%`);
    return { state: 'warning', reason: 'near_limit', limitedWindow: rl?.rateLimitType ?? null, windows, evidence };
  }
  if (!rl) evidence.push('no rate_limit_event in output');
  return { state: 'ok', reason: 'ok', windows, evidence };
}

function limited(win, resetsAt, now, windows, evidence) {
  const known = !!resetsAt && Date.parse(resetsAt) > now;
  if (!known) evidence.push('reset time unknown → re-probe after backoff');
  return {
    state: 'limited', reason: 'quota_exhausted', limitedWindow: win ?? null, resetsAt: resetsAt ?? null,
    cooldownUntil: known ? resetsAt : new Date(now + UNKNOWN_RESET_BACKOFF_MS).toISOString(), windows, evidence,
  };
}

// Older CLIs printed "Claude AI usage limit reached|<epoch seconds>".
function parseLegacyReset(text) {
  const m = text.match(/usage limit reached\|(\d{10})/i);
  return m ? iso(Number(m[1])) : null;
}

// Compact snapshot for the quota panel (used by probe.mjs).
export function claudeRateLimitSnapshot(classification) {
  const w = classification.windows;
  return {
    status: classification.state,
    primary: w.five_hour ?? null,
    secondary: w.seven_day ?? null,
    limitedWindow: classification.limitedWindow ?? null,
    cooldownUntil: classification.cooldownUntil ?? null,
    evidence: classification.evidence,
  };
}
