import type { Account } from '../../shared/types.ts';
import { resolveCli, runStreaming } from '../util/proc.ts';
import { listCodexModelsOnce, readCodexRateLimitsOnce } from './codex-appserver.ts';
import { invocationUsage } from '../usage.ts';
import { codexMcpOverrides, withSystem } from './mcp-config.ts';
import type { Classification, ProviderAdapter, RunOutcome, RunSpec } from './types.ts';
import { appConfig } from '../config.ts';
import { spentPercent, transientBackoffMs, unknownResetBackoffMs } from './claude-limits.ts';
import { createRunTimer } from './timing.ts';
import { PLAN_TOOL, planEvent, planItems, type StreamEvent } from './plan.ts';
import { codexUserDefaults } from './codex-config.ts';


export function describeCodexEvent(line: string): StreamEvent | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return { kind: 'raw', text: line.slice(0, 500) }; }
  if (e.type === 'item.completed' || e.type === 'item.started' || e.type === 'item.updated') {
    const it = e.item ?? {};
    // The checklist: Codex's own todo list (started, then updated as steps finish) or Plexus's plexus_plan tool.
    if (it.type === 'todo_list') { const plan = planItems(it.items); return plan ? planEvent(plan) : null; }
    if (it.type === 'mcp_tool_call' && e.type === 'item.started') {
      let args = it.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* shown as is */ } }
      const plan = it.tool === PLAN_TOOL ? planItems(args?.items) : null;
      if (plan) return planEvent(plan);
      const arg = args && typeof args === 'object' ? Object.values(args).find(v => typeof v === 'string' || typeof v === 'number') : args;
      return { kind: 'tool', text: `${it.tool ?? 'mcp'} ${arg == null ? '' : String(arg).slice(0, 200)}`.trim() };
    }
    if (e.type === 'item.updated') return null;
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

/** The thread id of a `codex exec --json` run (thread.started event), usable with `codex exec resume`. */
export function codexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('thread.started')) continue;
    try { const e = JSON.parse(line); if (e.type === 'thread.started' && typeof e.thread_id === 'string') return e.thread_id; } catch { /* next */ }
  }
  return undefined;
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
      return { state: 'limited', reason: 'quota_exhausted', cooldownUntil: new Date(now + unknownResetBackoffMs()).toISOString(), finalText, evidence };
    }
    if (hit(/401|unauthori[sz]ed|not logged in|authentication required|please log ?in|refresh token/i)) return { state: 'needs_login', reason: 'auth', finalText, evidence };
    if (hit(/reconnecting|stream disconnected|connection (failed|refused)|error sending request|timed out|503|502|overloaded|rate limit/i)) {
      return { state: 'transient', reason: 'network_or_api', cooldownUntil: new Date(now + transientBackoffMs()).toISOString(), finalText, evidence };
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
    // --disable plugins: curated plugins in CODEX_HOME/plugins (e.g. Notion) start their MCP servers despite
    // --ignore-user-config, adding tool schemas to every call (and failing on auth). Plexus's own MCP server is a config override.
    // `exec resume` has no -C/--sandbox: the working directory is the spawn cwd and read-only is a config override.
    const args = spec.resumeId
      ? [...prefixArgs, 'exec', 'resume', '--json', '--ignore-user-config', '--disable', 'plugins', '--skip-git-repo-check']
      : [...prefixArgs, 'exec', '--json', '--ignore-user-config', '--disable', 'plugins', '--skip-git-repo-check', '-C', spec.cwd];
    // --ignore-user-config drops the model and effort the person chose for Codex too: pass those explicitly when Plexus
    // has no choice of its own, so a run uses the same model as the Codex app.
    const user = !spec.model || !spec.effort ? codexUserDefaults(spec.account.home) : {};
    const model = spec.model ?? user.model, effort = spec.effort ?? user.effort;
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    // Note: on Windows the read-only sandbox refuses to start any process (even `Get-Location`), so a read-only Codex
    // agent cannot even read files there. Only use it where that is acceptable.
    if (spec.readOnly) args.push(...(spec.resumeId ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only']));
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push(...codexMcpOverrides(spec));
    if (spec.autocompact && spec.autocompact > 0) args.push('-c', `model_auto_compact_token_limit=${Math.floor(spec.autocompact)}`);
    if (spec.resumeId) args.push(spec.resumeId);
    args.push('-');
    const since = Date.now();
    const timer = createRunTimer('codex', since);
    const r = await runStreaming({
      cmd, args, cwd: spec.cwd, stdin: withSystem(spec), logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { timer.line(line); const d = describeCodexEvent(line); if (d) spec.onEvent?.(d); },
    });
    const timing = timer.finish();
    const a = classifyCodexRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    // Quota is not in the exec stream: read it from app-server right after the run.
    const rl = await readCodexRateLimitsOnce(spec.account.home).catch(() => null);
    const classification: Classification = { state: a.state, reason: a.reason, cooldownUntil: a.cooldownUntil, evidence: a.evidence };
    if (rl?.reached || a.state === 'limited') {
      const windows = [rl?.quota?.primary, rl?.quota?.secondary].filter(Boolean);
      const exhausted = windows.filter(w => spentPercent(w!.usedPercent)).map(w => w!.resetsAt).filter(Boolean) as string[];
      if (rl?.reached) classification.evidence.push(`app-server rateLimitReachedType=${rl.reached}`);
      classification.state = 'limited';
      classification.reason = 'quota_exhausted';
      if (exhausted.length) classification.cooldownUntil = classification.resetsAt = exhausted.sort().at(-1)!;
    }
    const sessionId = codexThreadId(r.stdout) ?? spec.resumeId;
    const usage = invocationUsage('codex', r.stdout, { model, resumeId: spec.resumeId, sessionId, codexHome: spec.account.home, since, until: Date.now() });
    return { exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, usage, classification, quota: rl?.quota ?? null, sessionId, timing };
  },

  async probe(account: Account) {
    const rl = await readCodexRateLimitsOnce(account.home);
    if (rl.needsLogin) return { classification: { state: 'needs_login', reason: 'auth', evidence: [rl.error ?? ''] }, quota: null };
    if (rl.error) return { classification: { state: 'transient', reason: 'app-server', cooldownUntil: new Date(Date.now() + transientBackoffMs()).toISOString(), evidence: [rl.error] }, quota: null };
    const windows = [rl.quota?.primary, rl.quota?.secondary].filter(Boolean);
    const maxUsed = Math.max(0, ...windows.map(w => w!.usedPercent ?? 0));
    if (rl.reached || spentPercent(maxUsed)) {
      const resets = windows.filter(w => spentPercent(w!.usedPercent)).map(w => w!.resetsAt).filter(Boolean).sort().at(-1) ?? null;
      return { classification: { state: 'limited', reason: 'quota_exhausted', resetsAt: resets, cooldownUntil: resets ?? new Date(Date.now() + unknownResetBackoffMs()).toISOString(), evidence: [`used ${maxUsed}%`] }, quota: rl.quota };
    }
    return { classification: { state: maxUsed >= appConfig().warnPercent ? 'warning' : 'ok', reason: 'probe', evidence: [] }, quota: rl.quota };
  },

  listModels(account: Account) {
    return listCodexModelsOnce(account.home);
  },

  loginCommand(account: Account) {
    const { cmd, prefixArgs } = resolveCli('codex');
    return { cmd, args: [...prefixArgs, 'login'], env: this.accountEnv(account) };
  },
};
