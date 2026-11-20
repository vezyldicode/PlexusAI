import { join } from 'node:path';
import type { Account } from '../../shared/types.ts';
import { runStreaming } from '../util/proc.ts';
import { classifyClaudeRun, claudeQuota } from './claude-limits.ts';
import { claudeSessionId, describeClaudeEvent } from './claude.ts';
import { invocationUsage } from '../usage.ts';
import { withSystem, writeMcpConfig } from './mcp-config.ts';
import type { ProviderAdapter, RunOutcome, RunSpec } from './types.ts';
import { createRunTimer } from './timing.ts';

const agentScript = join(import.meta.dirname, 'mock-agent.ts');

export const mockAdapter: ProviderAdapter = {
  provider: 'mock',
  accountEnv(account: Account) { return { MOCK_HOME: account.home }; },

  async run(spec: RunSpec): Promise<RunOutcome> {
    const mcp = writeMcpConfig(spec);
    const timer = createRunTimer('claude');
    const r = await runStreaming({
      cmd: process.execPath, args: [agentScript, ...(spec.resumeId ? ['--resume', spec.resumeId] : []), ...(mcp ? ['--mcp-config', mcp] : [])],
      cwd: spec.cwd, stdin: withSystem(spec), logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { timer.line(line); const d = describeClaudeEvent(line); if (d) spec.onEvent?.(d); },
      stopWhen: () => !!spec.maxCompactions && timer.compactions >= spec.maxCompactions,
    });
    const timing = timer.finish();
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    const sessionId = claudeSessionId(r.stdout);
    return {
      exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, sessionId, timing,
      usage: invocationUsage('mock', r.stdout, { resumeId: spec.resumeId, sessionId }),
      classification: { state: a.state, reason: a.reason, limitedWindow: a.limitedWindow, resetsAt: a.resetsAt, cooldownUntil: a.cooldownUntil, evidence: a.evidence },
      quota: claudeQuota(a.windows, 'cli-event'),
    };
  },

  async probe(account: Account) {
    return { classification: { state: 'ok', reason: 'mock', evidence: [] }, quota: null };
  },

  async listModels() {
    return [
      { id: 'mock-large', label: 'Mock Large', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true },
      { id: 'mock-small', label: 'Mock Small', efforts: [] },
    ];
  },

  loginCommand(account: Account) {
    return { cmd: process.execPath, args: ['-e', 'console.log("mock accounts need no login")'], env: {} };
  },
};
