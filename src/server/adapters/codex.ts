import type { Account } from '../../shared/types.ts';
import { resolveCli, runStreaming } from '../util/proc.ts';
import { readCodexRateLimitsOnce } from './codex-appserver.ts';
import type { Classification, ProviderAdapter, RunOutcome, RunSpec } from './types.ts';

const UNKNOWN_RESET_BACKOFF_MS = 15 * 60 * 1000;
const TRANSIENT_BACKOFF_MS = 60 * 1000;

export function describeCodexEvent(line: string): { kind: 'text' | 'tool' | 'status' | 'raw'; text: string } | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return { kind: 'raw', text: line.slice(0, 500) }; }
  if (e.type === 'item.completed' || e.type === 'item.started') {
    const it = e.item ?? {};
    if (it.type === 'agent_message' && e.type === 'item.completed') return { kind: 'text', text: it.text ?? '' };
    if (it.type === 'command_execution' && e.type === 'item.started') return { kind: 'tool', text: `shell ${String(it.command ?? '').slice(0, 200)}` };
    if (it.type === 'file_change' && e.type === 'item.completed') return { kind: 'tool', text: `edit ${(it.changes ?? []).map((c: any) => c.path).join(', ').slice(0, 200)}` };
    if (it.type === 'error') return { kind: 'status', text: `error: ${it.message}` };
    return null;
  }
  if (e.type === 'turn.completed') return { kind: 'status', text: 'turn completed' };
  if (e.type === 'turn.failed') return { kind: 'status', text: `turn failed: ${e.error?.message ?? ''}` };
  if (e.type === 'error') return { kind: 'status', text: `error: ${e.message}` };
  return null;
}

export interface CodexRunAnalysis extends Classification { finalText: string; usage?: Record<string, number> }

/** Classify a `codex exec --json` run. Limit texts taken from the Codex 0.157 binary. */
export function classifyCodexRun(run: { stdout: string; stderr?: string; exitCode?: number; now?: number }): CodexRunAnalysis {
  const { stdout, stderr = '', exitCode = 0, now = Date.now() } = run;
  let finalText = '', completed = false, usage: Record<string, number> | undefined;
  const errors: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') finalText = e.item.text ?? finalText;
    if (e.type === 'item.completed' && e.item?.type === 'error') errors.push(String(e.item.message ?? ''));
    if (e.type === 'turn.completed') { completed = true; usage = e.usage; }
    if (e.type === 'turn.failed') errors.push(String(e.error?.message ?? 'turn failed'));
    if (e.type === 'error') errors.push(String(e.message ?? ''));
  }
  const text = errors.join('\n') + '\n' + stderr.split(/\r?\n/).filter(l => !/rmcp::|mcp\./i.test(l)).join('\n');
  const evidence: string[] = [];
  const hit = (re: RegExp) => { const m = text.match(re); if (m) evidence.push(`text: "${m[0].slice(0, 120)}"`); return !!m; };

  if (!completed || exitCode !== 0) {
    if (hit(/usage_not_included|not included in your plan/i)) return { state: 'blocked', reason: 'usage_not_included', finalText, evidence };
    if (hit(/usage[ _]limit|usage_limit_reached|quota_exceeded|reached your usage limit|hit your usage limit/i)) {
      return { state: 'limited', reason: 'quota_exhausted', cooldownUntil: new Date(now + UNKNOWN_RESET_BACKOFF_MS).toISOString(), finalText, evidence };
    }
    if (hit(/401|unauthori[sz]ed|not logged in|authentication required|please log ?in|refresh token/i)) return { state: 'needs_login', reason: 'auth', finalText, evidence };
    if (hit(/reconnecting|stream disconnected|connection (failed|refused)|error sending request|timed out|503|502|overloaded|rate limit/i)) {
      return { state: 'transient', reason: 'network_or_api', cooldownUntil: new Date(now + TRANSIENT_BACKOFF_MS).toISOString(), finalText, evidence };
    }
    evidence.push(completed ? `exit ${exitCode}` : 'turn not completed');
    return { state: 'task_error', reason: completed ? `exit ${exitCode}` : 'turn_not_completed', finalText, evidence };
  }
  return { state: 'ok', reason: 'ok', finalText, evidence, usage };
}

export const codexAdapter: ProviderAdapter = {
  provider: 'codex',

  accountEnv(account: Account) {
    return { CODEX_HOME: account.home };
  },

  async run(spec: RunSpec): Promise<RunOutcome> {
    const { cmd, prefixArgs } = resolveCli('codex');
    // --ignore-user-config: workers must not inherit per-machine config (custom endpoints, MCP servers...).
    const args = [...prefixArgs, 'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', spec.cwd];
    if (spec.model) args.push('-m', spec.model);
    if (spec.readOnly) args.push('--sandbox', 'read-only');
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push('-');
    const r = await runStreaming({
      cmd, args, cwd: spec.cwd, stdin: spec.prompt, logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { const d = describeCodexEvent(line); if (d) spec.onEvent?.(d); },
    });
    const a = classifyCodexRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    // Quota is not in the exec stream: read it from app-server right after the run.
    const rl = await readCodexRateLimitsOnce(spec.account.home).catch(() => null);
    const classification: Classification = { state: a.state, reason: a.reason, cooldownUntil: a.cooldownUntil, evidence: a.evidence };
    if (rl?.reached || a.state === 'limited') {
      const windows = [rl?.quota?.primary, rl?.quota?.secondary].filter(Boolean);
      const exhausted = windows.filter(w => (w!.usedPercent ?? 0) >= 100).map(w => w!.resetsAt).filter(Boolean) as string[];
      if (rl?.reached) classification.evidence.push(`app-server rateLimitReachedType=${rl.reached}`);
      classification.state = 'limited';
      classification.reason = 'quota_exhausted';
      if (exhausted.length) classification.cooldownUntil = classification.resetsAt = exhausted.sort().at(-1)!;
    }
    return { exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, usage: a.usage, classification, quota: rl?.quota ?? null };
  },

  async probe(account: Account) {
    const rl = await readCodexRateLimitsOnce(account.home);
    if (rl.needsLogin) return { classification: { state: 'needs_login', reason: 'auth', evidence: [rl.error ?? ''] }, quota: null };
    if (rl.error) return { classification: { state: 'transient', reason: 'app-server', cooldownUntil: new Date(Date.now() + TRANSIENT_BACKOFF_MS).toISOString(), evidence: [rl.error] }, quota: null };
    const windows = [rl.quota?.primary, rl.quota?.secondary].filter(Boolean);
    const maxUsed = Math.max(0, ...windows.map(w => w!.usedPercent ?? 0));
    if (rl.reached || maxUsed >= 100) {
      const resets = windows.filter(w => (w!.usedPercent ?? 0) >= 100).map(w => w!.resetsAt).filter(Boolean).sort().at(-1) ?? null;
      return { classification: { state: 'limited', reason: 'quota_exhausted', resetsAt: resets, cooldownUntil: resets ?? new Date(Date.now() + UNKNOWN_RESET_BACKOFF_MS).toISOString(), evidence: [`used ${maxUsed}%`] }, quota: rl.quota };
    }
    return { classification: { state: maxUsed >= 90 ? 'warning' : 'ok', reason: 'probe', evidence: [] }, quota: rl.quota };
  },

  loginCommand(account: Account) {
    const { cmd, prefixArgs } = resolveCli('codex');
    return { cmd, args: [...prefixArgs, 'login'], env: this.accountEnv(account) };
  },
};
