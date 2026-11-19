import { join } from 'node:path';
import type { Account } from '../../shared/types.ts';
import { runStreaming } from '../util/proc.ts';
import { classifyClaudeRun, claudeQuota } from './claude-limits.ts';
import { claudeSessionId, describeClaudeEvent } from './claude.ts';
import type { ProviderAdapter, RunOutcome, RunSpec } from './types.ts';

const agentScript = join(import.meta.dirname, 'mock-agent.ts');

export const mockAdapter: ProviderAdapter = {
  provider: 'mock',
  accountEnv(account: Account) { return { MOCK_HOME: account.home }; },

  async run(spec: RunSpec): Promise<RunOutcome> {
    const r = await runStreaming({
      cmd: process.execPath, args: [agentScript, ...(spec.resumeId ? ['--resume', spec.resumeId] : [])], cwd: spec.cwd, stdin: spec.prompt, logPath: spec.logPath,
      env: { ...process.env, ...this.accountEnv(spec.account) },
      timeoutMs: spec.timeoutMs, idleTimeoutMs: spec.idleTimeoutMs, signal: spec.signal,
      onLine: line => { const d = describeClaudeEvent(line); if (d) spec.onEvent?.(d); },
    });
    const a = classifyClaudeRun({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    return {
      exitCode: r.exitCode, finalText: a.finalText, killedReason: r.killedReason, usage: a.usage, sessionId: claudeSessionId(r.stdout),
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
