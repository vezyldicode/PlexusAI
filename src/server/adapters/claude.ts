import type { Account } from '../../shared/types.ts';
import { resolveCli, runStreaming } from '../util/proc.ts';
import { classifyClaudeRun, claudeQuota, parseEvents } from './claude-limits.ts';
import { readClaudeStatus } from './claude-control.ts';
import { invocationUsage } from '../usage.ts';
import { writeMcpConfig } from './mcp-config.ts';
import type { ProviderAdapter, RunOutcome, RunSpec } from './types.ts';
import { appConfig } from '../config.ts';
import { createRunTimer } from './timing.ts';
import { PLAN_TOOL, planEvent, planItems, type StreamEvent } from './plan.ts';

/**
 * Everything one line of Claude Code's stream says, in order. An assistant message can hold words and several tool
 * calls: each becomes its own event, so neither the words before a call nor the calls after the first are lost.
 */
export function describeClaudeEvents(line: string): StreamEvent[] {
  let e: any;
  try { e = JSON.parse(line); } catch { return [{ kind: 'raw', text: line.slice(0, 500) }]; }
  if (e.type === 'assistant') {
    const out: StreamEvent[] = [];
    let words: string[] = [];
    const flush = () => { if (words.length) out.push({ kind: 'text', text: words.join('\n') }); words = []; };
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) words.push(c.text.trim());
      if (c.type === 'tool_use') {
        flush();
        // The checklist: Plexus's plexus_plan tool (mcp__plexus__plexus_plan) or Claude Code's own TodoWrite.
        const plan = c.name === 'TodoWrite' ? planItems(c.input?.todos) : String(c.name).endsWith(PLAN_TOOL) ? planItems(c.input?.items) : null;
        out.push(plan ? planEvent(plan) : { kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}` });
      }
    }
    flush();
    return out;
  }
  if (e.type === 'result') return [{ kind: 'status', text: `result: ${e.subtype}${e.is_error ? ' (error)' : ''}` }];
  if (e.type === 'rate_limit_event') {
    const w = e.rate_limit_info?.unifiedWindows;
    const pct = (x: any) => (typeof x?.utilization === 'number' ? Math.round(x.utilization * 100) + '%' : '?');
    return [{ kind: 'status', text: `quota ${e.rate_limit_info?.status}: 5h ${pct(w?.five_hour)} · week ${pct(w?.seven_day)}` }];
  }
  return [];
}

/** The first event of a line (tests and callers that look at one event). */
export function describeClaudeEvent(line: string): StreamEvent | null {
  return describeClaudeEvents(line)[0] ?? null;
}

/** The conversation id Claude Code reports in its stream (system init / result events). */
export function claudeSessionId(stdout: string): string | undefined {
  for (const e of parseEvents(stdout)) if (typeof e.session_id === 'string' && e.session_id) return e.session_id;
  return undefined;
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? '';
  return String(v).slice(0, 200);
}

export const claudeAdapter: ProviderAdapter = {
  provider: 'claude',

  accountEnv(account: Account) {
    return { CLAUDE_CONFIG_DIR: account.home };
  },

  async run(spec: RunSpec): Promise<RunOutcome> {
    const { cmd, prefixArgs } = resolveCli('claude');
    const args = [...prefixArgs, '-p', '--output-format', 'stream-json', '--verbose'];
    if (spec.resumeId) args.push('--resume', spec.resumeId);
    if (spec.resumeId && spec.forkSession) args.push('--fork-session');
    if (spec.model) args.push('--model', spec.model);
    if (spec.effort) args.push('--effort', spec.effort);
    if (spec.readOnly) args.push('--tools', 'Read,Glob,Grep');
    // Rules and role in the system prompt (identical across tasks of a role: cached), without the per-worktree sections
    // (cwd, git status) that would make every worktree's system prompt different. A resume reuses the recorded one.
    if (spec.system && !spec.resumeId) args.push('--append-system-prompt', spec.system, '--exclude-dynamic-system-prompt-sections');
    // Only Plexus's own MCP server (if any): the user's MCP servers would add their tool schemas to every call.
    const mcp = writeMcpConfig(spec);
    if (mcp) args.push('--mcp-config', mcp);
    args.push('--strict-mcp-config');
    if (spec.autocompact && spec.autocompact >= 100_000) args.push('--autocompact', String(spec.autocompact));
    args.push('--dangerously-skip-permissions');
    const timer = createRunTimer('claude');
    const r = await runStreaming({
      cmd, args, cwd: spec.cwd, stdin: spec.prompt, logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { timer.line(line); for (const d of describeClaudeEvents(line)) spec.onEvent?.(d); },
      stopWhen: () => !!spec.maxCompactions && timer.compactions >= spec.maxCompactions,
    });
    const timing = timer.finish();
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    const sessionId = claudeSessionId(r.stdout);
    return {
      exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, sessionId, timing,
      usage: invocationUsage('claude', r.stdout, { resumeId: spec.resumeId, sessionId }),
      classification: { state: a.state, reason: a.reason, limitedWindow: a.limitedWindow, resetsAt: a.resetsAt, cooldownUntil: a.cooldownUntil, evidence: a.evidence },
      quota: claudeQuota(a.windows, 'cli-event'),
    };
  },

  async probe(account: Account) {
    // Free path first: login state and live quota through the control protocol (no model call).
    const st = await readClaudeStatus(account).catch(() => null);
    if (st?.loggedIn === false) return { classification: { state: 'needs_login' as const, reason: 'not_logged_in', evidence: ['initialize: no credentials'] }, quota: null };
    if (st?.classification) return { classification: st.classification, quota: st.quota };
    // Fallback: one tiny Haiku call, which reports the rate limits in its stream (costs a little quota).
    const { cmd, prefixArgs } = resolveCli('claude');
    const r = await runStreaming({
      cmd, args: [...prefixArgs, '-p', 'ok', '--model', appConfig().probeModel || 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--tools', ''],
      cwd: account.home, env: { ...process.env, ...this.accountEnv(account) }, timeoutMs: 90_000,
    });
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    return {
      classification: { state: a.state, reason: a.reason, limitedWindow: a.limitedWindow, resetsAt: a.resetsAt, cooldownUntil: a.cooldownUntil, evidence: a.evidence },
      quota: claudeQuota(a.windows, 'probe'),
    };
  },

  async listModels(account: Account) {
    return (await readClaudeStatus(account)).models;
  },

  loginCommand(account: Account) {
    const { cmd, prefixArgs } = resolveCli('claude');
    return { cmd, args: [...prefixArgs, 'auth', 'login'], env: this.accountEnv(account) };
  },
};
