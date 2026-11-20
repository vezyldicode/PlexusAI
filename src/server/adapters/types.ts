import type { Account, ModelInfo, Provider, QuotaSnapshot, TokenUsage } from '../../shared/types.ts';

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
  /** Text for the CLI's system prompt (same for every task of a role, so it is cached); prepended to the prompt where unsupported. Not sent on resume. */
  system?: string;
  /** An MCP server the agent gets (the coordinator's `plexus` tools). */
  mcp?: McpServerSpec;
  /** Compact the conversation once its context passes this many tokens (0/undefined: the CLI's default). */
  autocompact?: number;
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
  /** Tokens this invocation spent (null when the CLI reported none). */
  usage: TokenUsage | null;
  /** Provider CLI conversation id of this run (claude session_id / codex thread_id), for a later resume. */
  sessionId?: string;
}

export interface McpServerSpec { name: string; command: string; args: string[]; env: Record<string, string> }

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
