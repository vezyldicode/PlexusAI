import type { Account, ModelInfo, Provider, QuotaSnapshot } from '../../shared/types.ts';

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
  /** Reasoning effort, already checked against the model's supported efforts (see models.ts). */
  effort?: string;
  readOnly: boolean;
  /** Continue this provider CLI conversation instead of starting one (the prompt then only carries what is new). */
  resumeId?: string;
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
  /** Provider CLI conversation id of this run (claude session_id / codex thread_id), for a later resume. */
  sessionId?: string;
}

export interface LoginCommand { cmd: string; args: string[]; env: Record<string, string> }

export interface ProviderAdapter {
  provider: Provider;
  run(spec: RunSpec): Promise<RunOutcome>;
  /** Cheap check of account state + quota. May cost a tiny bit of quota (Claude). */
  probe(account: Account): Promise<{ classification: Classification; quota: QuotaSnapshot | null }>;
  /** Models (and their efforts) the CLI offers on this account. Free: no model call. */
  listModels(account: Account): Promise<ModelInfo[]>;
  loginCommand(account: Account): LoginCommand;
  /** Environment variables that bind the CLI to this account's home directory. */
  accountEnv(account: Account): Record<string, string>;
}
