import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Account, AccountState, Provider, QuotaSnapshot } from '../shared/types.ts';
import { adapterFor, type Classification } from './adapters/index.ts';
import { CodexAppServer } from './adapters/codex-appserver.ts';
import { readClaudeStatus } from './adapters/claude-control.ts';
import { forgetModels, rememberModels } from './models.ts';
import { getDb, json, now } from './db.ts';
import { bus } from './events.ts';
import { paths } from './paths.ts';
import { childEnv, resolveCli, runStreaming } from './util/proc.ts';
import { appConfig, onConfigChange } from './config.ts';
import { spentPercent } from './adapters/claude-limits.ts';

function rowToAccount(r: any): Account {
  return {
    id: r.id, provider: r.provider, label: r.label, home: r.home, enabled: !!r.enabled, priority: r.priority,
    maxConcurrency: r.max_concurrency, state: r.state, stateReason: r.state_reason, cooldownUntil: r.cooldown_until,
    quota: json<QuotaSnapshot | null>(r.quota, null), createdAt: r.created_at,
  };
}

/** Number of workers currently running per account (maintained by the worker runtime). */
export const runningByAccount = new Map<string, number>();

export function listAccounts(): Account[] {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY provider, priority, id').all();
  return rows.map(r => ({ ...rowToAccount(r), running: runningByAccount.get((r as any).id) ?? 0 }));
}

export function getAccount(id: string): Account | null {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return r ? { ...rowToAccount(r), running: runningByAccount.get(id) ?? 0 } : null;
}

export function addAccount(input: { provider: Provider; label?: string; id?: string; home?: string; maxConcurrency?: number; priority?: number }): Account {
  const db = getDb();
  let id = input.id;
  if (!id) {
    for (let n = 1; ; n++) { id = `${input.provider}-${String(n).padStart(2, '0')}`; if (!getAccount(id)) break; }
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) throw new Error('invalid account id');
  if (getAccount(id)) throw new Error(`account ${id} exists`);
  const home = resolve(input.home ?? join(paths.accounts, id));
  mkdirSync(home, { recursive: true });
  db.prepare(`INSERT INTO accounts (id, provider, label, home, priority, max_concurrency, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?)`)
    .run(id, input.provider, input.label ?? id, home, input.priority ?? 10, input.maxConcurrency ?? 1, now());
  const acct = getAccount(id)!;
  bus.emitEvent('account.updated', null, acct);
  if (acct.provider === 'codex') quotaService.watch(acct);
  return acct;
}

export function updateAccount(id: string, patch: Partial<Pick<Account, 'label' | 'enabled' | 'priority' | 'maxConcurrency'>>): Account {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  getDb().prepare('UPDATE accounts SET label = ?, enabled = ?, priority = ?, max_concurrency = ? WHERE id = ?')
    .run(patch.label ?? a.label, (patch.enabled ?? a.enabled) ? 1 : 0, patch.priority ?? a.priority, patch.maxConcurrency ?? a.maxConcurrency, id);
  const out = getAccount(id)!;
  bus.emitEvent('account.updated', null, out);
  announceIfAvailable(a, out);
  return out;
}

const UNUSABLE = new Set<AccountState>(['limited', 'transient', 'needs_login', 'blocked']);
const usable = (a: Account) => a.enabled && !UNUSABLE.has(a.state);

/** Issue #5: emit `account.available` when an account goes from unusable to usable, so waiting projects resume at once. */
function announceIfAvailable(before: Account, after: Account) {
  if (!usable(before) && usable(after)) bus.emitEvent('account.available', null, { id: after.id, label: after.label, provider: after.provider });
}

/** Earliest reset of any quota window that is used up, when the CLI didn't say when the limit ends. */
export function resetFromQuota(q: QuotaSnapshot | null | undefined, nowIso = now()): string | null {
  const ws = [q?.primary, q?.secondary].filter(w => w && spentPercent(w.usedPercent) && w.resetsAt && w.resetsAt > nowIso);
  return ws.map(w => w!.resetsAt!).sort().at(-1) ?? null;
}

export function removeAccount(id: string): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  quotaService.unwatch(id);
  bus.emitEvent('account.removed', null, { id });
}

function setState(id: string, state: AccountState, reason: string | null, cooldownUntil: string | null) {
  getDb().prepare('UPDATE accounts SET state = ?, state_reason = ?, cooldown_until = ? WHERE id = ?').run(state, reason, cooldownUntil, id);
}

export function setQuota(id: string, quota: QuotaSnapshot | null) {
  if (!quota) return;
  getDb().prepare('UPDATE accounts SET quota = ? WHERE id = ?').run(JSON.stringify(quota), id);
  bus.emitEvent('account.updated', null, getAccount(id), false);
}

/** Apply the outcome of a run/probe to the account. */
export function applyClassification(id: string, c: Classification, quota: QuotaSnapshot | null): void {
  const a = getAccount(id);
  if (!a) return;
  if (quota) getDb().prepare('UPDATE accounts SET quota = ? WHERE id = ?').run(JSON.stringify(quota), id);
  switch (c.state) {
    case 'ok': case 'warning': setState(id, c.state, null, null); break;
    case 'limited': case 'transient': {
      // No reset time from the CLI: fall back to the reset of the window that is used up, so the account is released on time.
      const until = c.cooldownUntil ?? (c.state === 'limited' ? resetFromQuota(quota ?? a.quota) : null);
      setState(id, c.state, c.evidence.join('; ') || c.reason, until);
      break;
    }
    case 'needs_login': case 'blocked': setState(id, c.state, c.reason, null); break;
    case 'task_error': if (a.state === 'unknown') setState(id, 'ok', null, null); break;
  }
  const out = getAccount(id)!;
  bus.emitEvent('account.updated', null, out, c.state !== 'ok' && c.state !== 'task_error' && c.state !== a.state);
  announceIfAvailable(a, out);
}

/** Accounts whose cooldown has elapsed become usable again ('unknown' until the next run/probe). */
export function releaseCooldowns(): void {
  const rows = getDb().prepare(`SELECT id FROM accounts WHERE state IN ('limited','transient') AND cooldown_until IS NOT NULL AND cooldown_until <= ?`).all(now()) as any[];
  for (const r of rows) {
    const before = getAccount(r.id)!;
    setState(r.id, 'unknown', 'cooldown elapsed', null);
    const after = getAccount(r.id)!;
    bus.emitEvent('account.updated', null, after);
    announceIfAvailable(before, after);
  }
}

export async function probeAccount(id: string): Promise<Account> {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  const r = await adapterFor(a.provider).probe(a);
  applyClassification(id, r.classification, r.quota);
  return getAccount(id)!;
}

/** Free login check for Claude accounts (`claude auth status`), no quota spent. */
export async function claudeLoggedIn(a: Account): Promise<boolean | null> {
  try {
    const { cmd, prefixArgs } = resolveCli('claude');
    const r = await runStreaming({ cmd, args: [...prefixArgs, 'auth', 'status'], cwd: a.home, env: { ...process.env, CLAUDE_CONFIG_DIR: a.home }, timeoutMs: appConfig().controlTimeoutSec * 1000 });
    return !!JSON.parse(r.stdout).loggedIn;
  } catch { return null; }
}

/** Open a visible terminal window running the provider's login command for this account. */
export function openLogin(id: string): { opened: boolean; command: string } {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  const lc = adapterFor(a.provider).loginCommand(a);
  const envPrefix = Object.entries(lc.env).map(([k, v]) => process.platform === 'win32' ? `$env:${k}='${v}';` : `${k}='${v}'`).join(' ');
  const quoted = [lc.cmd, ...lc.args].map(s => (/\s/.test(s) ? `"${s}"` : s)).join(' ');
  const command = process.platform === 'win32' ? `${envPrefix} & ${quoted}` : `${envPrefix} ${quoted}`;
  if (process.platform === 'win32') {
    // `cmd /k "a" "b"` strips the first and last quote of the whole line when it holds more than two quotes,
    // which breaks any quoted path (e.g. C:\Program Files\...). Put the command in a .cmd script instead and
    // start it with `call "script"`: the line no longer begins with a quote, so cmd keeps every quote.
    const script = writeLoginScript(a, lc);
    spawn('cmd.exe', ['/c', 'start', `"Plexus login ${id}"`, 'cmd', '/k', `call "${script}"`], {
      env: childEnv(lc.cmd, { ...process.env, ...lc.env }), detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
    }).unref();
    return { opened: true, command };
  }
  return { opened: false, command };
}

/** Windows: write <home>/plexus-login.cmd that sets the account's env vars and runs the login command. */
export function writeLoginScript(a: Account, lc: { cmd: string; args: string[]; env: Record<string, string> }): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [
    '@echo off',
    `title Plexus login ${a.id}`,
    ...Object.entries(lc.env).map(([k, v]) => `set "${k}=${v}"`),
    `echo Signing in account ${a.id} (${a.provider}). Finish the sign-in in your browser.`,
    `${q(lc.cmd)} ${lc.args.map(q).join(' ')}`,
    'echo.',
    'echo Done. You can close this window and click "Refresh" in Plexus.',
  ];
  const file = join(a.home, 'plexus-login.cmd');
  writeFileSync(file, lines.join('\r\n') + '\r\n');
  return file;
}

// ---------------- Quota service ----------------

/** Intervals come from Settings → Quota; the timers re-arm when they change. */
const claudePollMs = () => appConfig().claudePollMin * 60_000;

class QuotaService {
  private codex = new Map<string, CodexAppServer>();
  private timer: NodeJS.Timeout | null = null;
  private loginTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private lastProbe = new Map<string, number>();
  /** Claude idle-account usage poll: next allowed time and current backoff per account (get_usage hits a rate-limited endpoint). */
  private claudeNext = new Map<string, number>();
  private claudeBackoff = new Map<string, number>();
  private started = false;

  private offConfig: (() => void) | null = null;
  /** Interval of the Codex poll: the argument (tests), else Settings → Quota. */
  private codexPollMs: number | null = null;

  start(pollMs?: number) {
    this.started = true;
    this.codexPollMs = pollMs ?? null;
    for (const a of listAccounts()) if (a.provider === 'codex') this.watch(a);
    this.arm();
    this.checkClaudeLogins();
    this.offConfig = onConfigChange(() => { if (this.started) this.arm(); });
  }

  /** (Re)start the timers with the current intervals. The Claude timer ticks at least every minute; each account keeps its own pace. */
  private arm() {
    this.clearTimers();
    const c = appConfig();
    this.timer = setInterval(() => this.pollCodex(), this.codexPollMs ?? c.codexPollSec * 1000);
    this.loginTimer = setInterval(() => void this.checkClaudeLogins(), Math.min(claudePollMs(), 60_000));
    this.recheckTimer = setInterval(() => void this.recheckLimited(), Math.min(c.limitedRecheckMin * 60_000, 5 * 60_000));
  }

  private clearTimers() {
    if (this.timer) clearInterval(this.timer);
    if (this.loginTimer) clearInterval(this.loginTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.timer = this.loginTimer = this.recheckTimer = null;
  }

  stop() {
    this.started = false;
    this.clearTimers();
    this.offConfig?.(); this.offConfig = null;
    for (const c of this.codex.values()) c.close();
    this.codex.clear();
  }

  watch(a: Account) {
    if (a.provider !== 'codex' || this.codex.has(a.id) || !this.started) return;
    const c = new CodexAppServer(a.home);
    c.onRateLimits = r => setQuota(a.id, r.quota);
    this.codex.set(a.id, c);
    void this.pollOne(a.id, c);
  }

  unwatch(id: string) { this.codex.get(id)?.close(); this.codex.delete(id); }

  async pollCodex() {
    for (const [id, c] of this.codex) {
      if (c.closed) { this.codex.delete(id); const a = getAccount(id); if (a) this.watch(a); continue; }
      await this.pollOne(id, c);
    }
  }

  private async pollOne(id: string, c: CodexAppServer) {
    {
      const a = getAccount(id);
      if (!a?.enabled) return;
      const r = await c.readRateLimits();
      if (r.needsLogin) applyClassification(id, { state: 'needs_login', reason: 'auth', evidence: [r.error ?? ''] }, null);
      else if (r.quota) {
        setQuota(id, r.quota);
        const spent = [r.quota.primary, r.quota.secondary].some(w => spentPercent(w?.usedPercent));
        if (a.state === 'needs_login' || a.state === 'unknown') applyClassification(id, { state: 'ok', reason: 'app-server', evidence: [] }, null);
        // Issue #5: a limited Codex account whose windows have room again is usable; the app-server poll is free.
        else if ((a.state === 'limited' || a.state === 'transient') && !spent) applyClassification(id, { state: 'ok', reason: 'quota reset', evidence: ['app-server rate limits'] }, null);
      }
    }
  }

  /**
   * Every few minutes (Settings → Quota): login state, quota and models of idle Claude accounts through the control protocol (no model call).
   * Busy accounts are skipped: their runs report quota in the stream for free. Falls back to `claude auth status`.
   */
  async checkClaudeLogins() {
    for (const a of listAccounts()) {
      if (a.provider !== 'claude' || !a.enabled) continue;
      if ((a.running ?? 0) > 0 || Date.now() < (this.claudeNext.get(a.id) ?? 0)) continue;
      if (a.state === 'limited' && a.cooldownUntil && a.cooldownUntil > now()) continue;
      const st = await readClaudeStatus(a).catch(() => null);
      if (st && st.loggedIn !== null) {
        this.claudeBackoff.delete(a.id);
        this.claudeNext.set(a.id, Date.now() + Math.max(claudePollMs() - 30_000, claudePollMs() * 0.9));
        if (st.models.length && st.loggedIn) rememberModels(a.id, st.models);
        if (!st.loggedIn) {
          if (a.state !== 'needs_login') { forgetModels(a.id); applyClassification(a.id, { state: 'needs_login', reason: 'not_logged_in', evidence: ['claude initialize: no credentials'] }, null); }
          continue;
        }
        if (st.classification) {
          // Do not override a transient cooldown with 'ok'; everything else follows the live quota.
          if (!(a.state === 'transient' && st.classification.state === 'ok')) applyClassification(a.id, st.classification, st.quota);
          else setQuota(a.id, st.quota);
          continue;
        }
        if (a.state === 'needs_login') { forgetModels(a.id); setState(a.id, 'unknown', 'logged in', null); const after = getAccount(a.id)!; bus.emitEvent('account.updated', null, after); announceIfAvailable(a, after); }
        continue;
      }
      const back = Math.min(Math.max(appConfig().claudeBackoffMaxMin * 60_000, claudePollMs()), (this.claudeBackoff.get(a.id) ?? claudePollMs() / 2) * 2);
      this.claudeBackoff.set(a.id, back);
      this.claudeNext.set(a.id, Date.now() + back);
      const ok = await claudeLoggedIn(a);
      if (ok === false && a.state !== 'needs_login') applyClassification(a.id, { state: 'needs_login', reason: 'not_logged_in', evidence: ['claude auth status'] }, null);
      if (ok === true && a.state === 'needs_login') { setState(a.id, 'unknown', 'logged in', null); const after = getAccount(a.id)!; bus.emitEvent('account.updated', null, after); announceIfAvailable(a, after); }
    }
  }

  /**
   * Issue #5: accounts that are limited without a known reset time are never released by the cooldown timer.
   * Re-check them: Codex through the free app-server poll (above), Claude and mock with a probe at most every 30 minutes
   * (a probe of a limited Claude account is rejected up front, so it costs next to nothing).
   */
  async recheckLimited() {
    const nowIso = now();
    for (const a of listAccounts()) {
      if (!a.enabled || !(a.state === 'limited' || a.state === 'transient')) continue;
      if (a.cooldownUntil && a.cooldownUntil > nowIso) continue;
      if (a.provider === 'codex') continue;
      const last = this.lastProbe.get(a.id) ?? 0;
      if (Date.now() - last < appConfig().limitedRecheckMin * 60_000) continue;
      this.lastProbe.set(a.id, Date.now());
      await probeAccount(a.id).catch(() => {});
    }
  }
}

export const quotaService = new QuotaService();
