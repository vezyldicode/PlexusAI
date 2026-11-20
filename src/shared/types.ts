// Types shared by daemon, CLI and UI.
import { z } from 'zod';

export type Provider = 'claude' | 'codex' | 'mock';

/** Account availability as decided by the classifier / quota service. */
export type AccountState =
  | 'unknown'      // not probed yet / cooldown elapsed
  | 'ok'
  | 'warning'      // near limit: avoid starting large tasks
  | 'limited'      // quota exhausted, cooldown until cooldown_until
  | 'transient'    // API hiccup, short cooldown
  | 'needs_login'
  | 'blocked'      // account on hold / billing / plan does not include the tool
  | 'disabled';

export interface QuotaWindow {
  usedPercent: number | null;
  resetsAt: string | null;
  windowMins?: number | null;
  status?: string | null;
}

export interface QuotaSnapshot {
  primary: QuotaWindow | null;   // 5h window
  secondary: QuotaWindow | null; // weekly window
  plan?: string | null;
  source: 'cli-event' | 'app-server' | 'usage-api' | 'probe' | 'estimate';
  at: string;
}

export interface Account {
  id: string;
  provider: Provider;
  label: string;
  home: string;
  enabled: boolean;
  priority: number;
  maxConcurrency: number;
  state: AccountState;
  stateReason: string | null;
  cooldownUntil: string | null;
  quota: QuotaSnapshot | null;
  createdAt: string;
  running?: number;
}

/** A model a provider CLI offers on one account, read from the CLI itself (Claude `initialize`, Codex `model/list`). */
export interface ModelInfo {
  /** Value passed to --model / -m (an alias such as `opus` or a full id). */
  id: string;
  /** Full model id an alias resolves to, when the CLI reports it. */
  resolved?: string | null;
  label: string;
  description?: string;
  /** Supported reasoning efforts; empty = the model takes no effort setting. */
  efforts: string[];
  defaultEffort?: string | null;
  isDefault?: boolean;
  hidden?: boolean;
}

/** Models per provider, merged over the enabled accounts (GET /api/models). */
export interface ModelCatalogEntry extends ModelInfo { accounts: string[] }
export type ModelCatalog = Partial<Record<Provider, ModelCatalogEntry[]>>;

export type ProjectStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed';

export interface ProjectSettings {
  maxParallel: number;
  maxTasks: number;
  maxEvalRounds: number;
  maxReviewCycles: number;
  maxAttempts: number;
  reviewEnabled: boolean;
  quotaStrategy: 'spread' | 'drain' | 'priority';
  /** How long a review/evaluation waits for an account other than the author before using the author's account. */
  independentReviewWaitMin: number;
  /** Account the coordinator chat runs on; null picks one automatically. */
  coordinatorAccountId: string | null;
  /** Coordinator chat model per provider; empty falls back to the coordinator role's models. */
  coordinatorModels: Partial<Record<Provider, string>>;
  /** Coordinator chat effort per provider; empty falls back to the coordinator role's efforts. */
  coordinatorEfforts: Partial<Record<Provider, string>>;
  /** When decisions.md grows past this many characters, a librarian task compacts it (0 = never). */
  decisionsCompactAt: number;
  /**
   * How a project is built. `single`: after the analyst, one agent (the coordinator's model) builds and verifies everything.
   * `team`: architect (who also plans) → parallel implementers → evaluation. `auto`: the analyst picks one from the docs.
   */
  pipeline: 'auto' | 'single' | 'team';
  /** `auto`: review only large changes (≥ reviewMinLines changed lines) or ones the author flagged; fixes are not re-reviewed. */
  reviewPolicy: 'auto' | 'always' | 'never';
  reviewMinLines: number;
  /** Run a separate QA task before evaluation (the evaluator verifies anyway). */
  qaPhase: boolean;
  /** Continue the author's CLI conversation (same account, same worktree) for fixes and retries instead of starting cold. */
  resumeSessions: boolean;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  maxParallel: 3,
  maxTasks: 80,
  maxEvalRounds: 4,
  maxReviewCycles: 2,
  maxAttempts: 4,
  reviewEnabled: true,
  quotaStrategy: 'spread',
  independentReviewWaitMin: 20,
  coordinatorAccountId: null,
  coordinatorModels: {},
  coordinatorEfforts: {},
  decisionsCompactAt: 6000,
  pipeline: 'auto',
  reviewPolicy: 'auto',
  reviewMinLines: 300,
  qaPhase: false,
  resumeSessions: true,
};

export interface Project {
  id: string;
  name: string;
  path: string;
  goal: string;
  status: ProjectStatus;
  phase: string;
  mainBranch: string;
  settings: ProjectSettings;
  evalRounds: number;
  createdAt: string;
}

export type TaskKind = 'ingest' | 'architect' | 'plan' | 'build' | 'fix' | 'review' | 'integrate' | 'qa' | 'evaluate' | 'compact' | 'solo' | 'custom';
export type TaskStatus = 'pending' | 'running' | 'interrupted' | 'in_review' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  projectId: string;
  seq: number;
  title: string;
  description: string;
  role: string;
  kind: TaskKind;
  status: TaskStatus;
  deps: string[];
  parentId: string | null;
  branch: string | null;
  worktree: string | null;
  priority: number;
  attempts: number;
  accountId: string | null;      // currently running on
  lastAccountId: string | null;
  authorAccountId: string | null; // who wrote the code (for reviewer independence)
  reviewCycles: number;
  acceptance: string[];
  /** Acceptance criterion ids (AC1, ...) this task serves; only those are put in its prompt. */
  acIds: string[];
  result: AgentResult | null;
  error: string | null;
  /** Model override per provider for this task only; falls back to the role's models. */
  models: Partial<Record<Provider, string>>;
  /** Effort override per provider for this task only; falls back to the role's efforts. */
  efforts: Partial<Record<Provider, string>>;
  /** Files or directories this task expects to change (from the planner); used to keep parallel writers apart. */
  paths: string[];
  /** Chat session that created this task (children inherit it); its notices go to that session. */
  originSessionId: string | null;
  /** Requested from the chat outside the project pipeline: runs even when the project is idle/completed, triggers no phase change. */
  adhoc: boolean;
  /** Provider CLI conversation of the last attempt and the account it lives on (resumed for fixes and retries). */
  cliSessionId: string | null;
  cliAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Tokens of one model. `input` excludes cache reads and writes; `output` includes `reasoning`. */
export interface ModelTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** API list-price equivalent the CLI reports (Claude only); not what a subscription is charged. */
  costUsd: number | null;
}

/** Tokens spent by one CLI invocation, a run, a task or a project. `total` = input + cacheRead + cacheWrite + output. */
export interface TokenUsage extends ModelTokens {
  total: number;
  byModel: Record<string, ModelTokens>;
  /** The run ended without the CLI's final report (killed, crashed): a lower bound. */
  partial?: boolean;
}

/** Token totals of a project (GET /api/projects/:id). */
export interface ProjectUsage {
  total: TokenUsage | null;
  tasks: Record<string, TokenUsage>;
  byRole: Record<string, TokenUsage>;
  coordinator: TokenUsage | null;
}

export interface Run {
  id: number;
  taskId: string;
  accountId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  classification: unknown;
  logPath: string;
  exitCode: number | null;
  usage: TokenUsage | null;
}

export interface ChatMessage {
  id: number;
  projectId: string;
  sessionId: string;
  author: 'user' | 'coordinator' | 'system' | 'agent';
  text: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** A coordinator conversation. `unread` counts system/agent messages the user has not seen yet. */
export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  unread: number;
  /** Provider CLI conversation to resume (claude --resume / codex exec resume), bound to one account. */
  cliSessionId: string | null;
  cliAccountId: string | null;
  /** Last message id the CLI conversation already knows about. */
  cliSyncedMessageId: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlexusEvent {
  id: number;
  projectId: string | null;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface Role {
  name: string;
  description: string;
  /** Preferred providers, best first (soft preference: other providers are used when these are unavailable). */
  providers: Provider[];
  /** Model per provider (e.g. { claude: 'opus' }); omitted = CLI default. */
  models: Partial<Record<Provider, string>>;
  /** Reasoning effort per provider (e.g. { claude: 'high' }); omitted = CLI default. */
  efforts: Partial<Record<Provider, string>>;
  skills: string[];
  writesCode: boolean;
  maxRuntimeMin: number;
  /** Only run on the providers listed in `providers`; never fall back to others. */
  onlyListed: boolean;
  /** Most tasks of this role running at once in a project; 0 = no limit beyond the project's maxParallel. */
  maxParallel: number;
  instructions: string;
}

export interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  path: string;
  createdAt: string;
}

// ---------------- Agent result contract ----------------

export const FollowUpTaskSchema = z.object({
  key: z.string().optional(),
  title: z.string(),
  description: z.string().default(''),
  role: z.string().default('implementer'),
  depends_on: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  ac_ids: z.array(z.string()).default([]),
  priority: z.number().optional(),
});
export type FollowUpTask = z.infer<typeof FollowUpTaskSchema>;

export const DecisionSchema = z.object({
  title: z.string(), decision: z.string(), rationale: z.string().default(''),
  /** What the decision is about, so a task's prompt carries only the decisions relevant to it. */
  paths: z.array(z.string()).default([]),
  ac_ids: z.array(z.string()).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const AgentResultSchema = z.object({
  status: z.enum(['done', 'partial', 'blocked', 'failed']).default('done'),
  summary: z.string().default(''),
  decisions: z.array(DecisionSchema).default([]),
  issues: z.array(z.string()).default([]),
  questions: z.array(z.object({ question: z.string(), default_answer: z.string().default('') })).default([]),
  follow_up_tasks: z.array(FollowUpTaskSchema).default([]),
  // analyst
  project_brief: z.string().optional(),
  project_summary: z.string().optional(),
  acceptance_criteria: z.array(z.object({ id: z.string(), criterion: z.string(), verify: z.string().default('') })).optional(),
  // analyst: is the documentation enough to start, and how should the project be built
  docs_check: z.object({ sufficient: z.boolean(), questions: z.array(z.string()).default([]) }).optional(),
  execution: z.object({ mode: z.enum(['single', 'team']), reason: z.string().default('') }).optional(),
  // solo: the work needs several agents after all
  escalate: z.object({ reason: z.string().default('') }).nullable().optional(),
  // librarian: the compacted list that replaces the decisions it was given
  decisions_digest: z.array(DecisionSchema).optional(),
  // planner
  tasks: z.array(FollowUpTaskSchema).optional(),
  // reviewer
  review: z.object({ verdict: z.enum(['approve', 'changes_requested']), comments: z.array(z.string()).default([]) }).optional(),
  // evaluator
  evaluation: z.object({
    complete: z.boolean(),
    criteria: z.array(z.object({ id: z.string(), pass: z.boolean(), evidence: z.string().default('') })).default([]),
    report: z.string().optional(),
  }).optional(),
}).passthrough();
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ---------------- Coordinator contract ----------------

export const CoordinatorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('add_task'), title: z.string(), description: z.string().default(''), role: z.string().default('implementer'), depends_on: z.array(z.string()).default([]), priority: z.number().optional() }),
  z.object({ type: z.literal('solo_task'), title: z.string(), description: z.string().default('') }),
  z.object({ type: z.literal('cancel_task'), task_id: z.string() }),
  z.object({ type: z.literal('retry_task'), task_id: z.string() }),
  z.object({ type: z.literal('reprioritize'), task_id: z.string(), priority: z.number() }),
  z.object({ type: z.literal('update_task'), task_id: z.string(), description: z.string() }),
  z.object({ type: z.literal('record_decision'), title: z.string(), decision: z.string(), rationale: z.string().default('') }),
  z.object({ type: z.literal('add_directive'), text: z.string() }),
  z.object({ type: z.literal('set_goal'), goal: z.string() }),
  z.object({ type: z.literal('replan'), reason: z.string() }),
]);
export type CoordinatorAction = z.infer<typeof CoordinatorActionSchema>;

export const CoordinatorOutputSchema = z.object({
  reply: z.string(),
  actions: z.array(CoordinatorActionSchema).default([]),
  proposal: z.object({ summary: z.string(), actions: z.array(CoordinatorActionSchema) }).nullable().optional(),
});
export type CoordinatorOutput = z.infer<typeof CoordinatorOutputSchema>;
