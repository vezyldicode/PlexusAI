import type { Account } from '../../shared/types.ts';
import { resolveCli, runStreaming } from '../util/proc.ts';
import { classifyClaudeRun, claudeQuota } from './claude-limits.ts';
import type { ProviderAdapter, RunOutcome, RunSpec } from './types.ts';

export function describeClaudeEvent(line: string): { kind: 'text' | 'tool' | 'status' | 'raw'; text: string } | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return { kind: 'raw', text: line.slice(0, 500) }; }
  if (e.type === 'assistant') {
    const parts: string[] = [];
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) parts.push(c.text.trim());
      if (c.type === 'tool_use') return { kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}` };
    }
    return parts.length ? { kind: 'text', text: parts.join('\n') } : null;
  }
  if (e.type === 'result') return { kind: 'status', text: `result: ${e.subtype}${e.is_error ? ' (error)' : ''}` };
  if (e.type === 'rate_limit_event') {
    const w = e.rate_limit_info?.unifiedWindows;
    const pct = (x: any) => (typeof x?.utilization === 'number' ? Math.round(x.utilization * 100) + '%' : '?');
    return { kind: 'status', text: `quota ${e.rate_limit_info?.status}: 5h ${pct(w?.five_hour)} · week ${pct(w?.seven_day)}` };
  }
  return null;
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
    if (spec.model) args.push('--model', spec.model);
    if (spec.readOnly) args.push('--tools', 'Read,Glob,Grep');
    args.push('--dangerously-skip-permissions');
    const r = await runStreaming({
      cmd, args, cwd: spec.cwd, stdin: spec.prompt, logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { const d = describeClaudeEvent(line); if (d) spec.onEvent?.(d); },
    });
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    return {
      exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, usage: a.usage,
      classification: { state: a.state, reason: a.reason, limitedWindow: a.limitedWindow, resetsAt: a.resetsAt, cooldownUntil: a.cooldownUntil, evidence: a.evidence },
      quota: claudeQuota(a.windows, 'cli-event'),
    };
  },

  async probe(account: Account) {
    const { cmd, prefixArgs } = resolveCli('claude');
    const r = await runStreaming({
      cmd, args: [...prefixArgs, '-p', 'ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--tools', ''],
      cwd: account.home, env: { ...process.env, ...this.accountEnv(account) }, timeoutMs: 90_000,
    });
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    return {
      classification: { state: a.state, reason: a.reason, limitedWindow: a.limitedWindow, resetsAt: a.resetsAt, cooldownUntil: a.cooldownUntil, evidence: a.evidence },
      quota: claudeQuota(a.windows, 'probe'),
    };
  },

  loginCommand(account: Account) {
    const { cmd, prefixArgs } = resolveCli('claude');
    return { cmd, args: [...prefixArgs, 'auth', 'login'], env: this.accountEnv(account) };
  },
};
