import type { Account, Provider, QuotaSnapshot } from '../../shared/types.ts';

export type RunState = 'ok' | 'warning' | 'limited' | 'transient' | 'needs_login' | 'blocked' | 'task_error';

export interface Classification {
  state: RunState;
  reason: string;
  limitedWindow?: string | null;
  resetsAt?: string | null;
  cooldownUntil?: string | null;
  evidence: string[];
}

export interface RunSpec {
  account: Account;
  cwd: string;
  prompt: string;
  model?: string;
  readOnly: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  logPath: string;
  signal?: AbortSignal;
  /** Called for each parsed stream event (already JSON-parsed when possible). */
  onEvent?: (ev: { kind: 'text' | 'tool' | 'status' | 'raw'; text: string }) => void;
}

export interface RunOutcome {
  exitCode: number;
  finalText: string;
  classification: Classification;
  quota: QuotaSnapshot | null;
  killedReason: 'timeout' | 'idle' | 'aborted' | null;
  usage?: Record<string, number>;
}

export interface LoginCommand { cmd: string; args: string[]; env: Record<string, string> }

export interface ProviderAdapter {
  provider: Provider;
  run(spec: RunSpec): Promise<RunOutcome>;
  /** Cheap check of account state + quota. May cost a tiny bit of quota (Claude). */
  probe(account: Account): Promise<{ classification: Classification; quota: QuotaSnapshot | null }>;
  loginCommand(account: Account): LoginCommand;
  /** Environment variables that bind the CLI to this account's home directory. */
  accountEnv(account: Account): Record<string, string>;
}
