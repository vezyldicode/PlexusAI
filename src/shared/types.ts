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
  /** Compact an agent's conversation once its context passes this many tokens (Claude ≥ 100000; 0 = the CLI's default). */
  autocompactTokens: number;
  /**
   * Context budget of one run: after this many automatic compactions the work is larger than one session, so Plexus stops
   * the agent and has it commit, report what is left (status partial) and hand the rest on (0 = no limit). Claude only.
   */
  maxCompactions: number;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  maxParallel: 3,
  maxTasks: 80,
  maxEvalRounds: 4,
  maxReviewCycles: 2,
  maxAttempts: 4,
  reviewEnabled: true,
  quotaStrategy: 'spread',
  independentReviewWaitMin: 3,
  coordinatorAccountId: null,
  coordinatorModels: {},
  coordinatorEfforts: {},
  decisionsCompactAt: 6000,
  pipeline: 'auto',
  reviewPolicy: 'auto',
  reviewMinLines: 300,
  qaPhase: false,
  resumeSessions: true,
  autocompactTokens: 150_000,
  maxCompactions: 2,
};

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Set by the project list when `path` is gone (moved, renamed, deleted): the sidebar marks it. */
  folderMissing?: boolean;
  goal: string;
  status: ProjectStatus;
  phase: string;
  mainBranch: string;
  settings: ProjectSettings;
  evalRounds: number;
  createdAt: string;
}

export type TaskKind = 'ingest' | 'architect' | 'plan' | 'build' | 'fix' | 'review' | 'integrate' | 'qa' | 'evaluate' | 'compact' | 'solo' | 'custom'
  /** Work the coordinator did itself (edited the project folder or merged its worktree): recorded as a finished task. */
  | 'coordinator';
/** `blocked`: the agent said it cannot go on without the user (an answer, a decision, a change of input); never retried by itself. */
export type TaskStatus = 'pending' | 'running' | 'interrupted' | 'in_review' | 'done' | 'failed' | 'cancelled' | 'blocked';

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
  /** Context size (tokens) of the last model call of that conversation, and when it ended: decides whether resuming it is cheaper than a fresh start. */
  cliCtxTokens: number;
  cliUsedAt: string | null;
  /** Set when `cliSessionId` is a conversation held in another working directory (the coordinator's chat): the first run
   *  forks it into this task's worktree instead of resuming it, so the agent starts with what the coordinator learned. */
  cliForkCwd: string | null;
  /** Run only on this account while it can run; when it cannot (quota, login), another account takes over. */
  pinnedAccountId: string | null;
  /** The task whose agent this one continues (same worktree path and CLI conversation): a "lane" of one agent. */
  laneFrom: string | null;
  /** Messages for the agent (from the coordinator or the user), delivered at the start of its next run. */
  inbox: string[];
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
  /** Model calls of the invocation and their context sizes (input + cache read + cache write of a call), when the stream shows them. */
  calls?: number;
  firstCtx?: number;
  maxCtx?: number;
  lastCtx?: number;
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
  /** Model and effort the run was started with (null: the CLI default). */
  model?: string | null;
  effort?: string | null;
  /** Where the run's time went (null for runs recorded before this was measured). */
  timing?: RunTiming | null;
}

/**
 * Where the wall time of a run went, measured from the CLI's stream. `model` is what is left after startup, tools and
 * compaction: the model reading and writing (thinking included). `wait` is the time the task waited for this run
 * (dependencies, a free account, the user's approval) after it was created or its previous run ended.
 */
export interface RunTiming {
  totalMs: number;
  startupMs: number;
  modelMs: number;
  toolMs: number;
  compactMs: number;
  waitMs: number;
  toolCalls: number;
  compactions: number;
  /** Model calls (Claude: assistant messages; Codex: not reported). */
  calls?: number;
}

/**
 * The model and effort a task runs with on a provider, and where each comes from: the task's own override, the
 * coordinator's settings (single-agent tasks), the role, or the CLI default.
 */
export interface TaskModelInfo {
  provider: Provider;
  model: string | null;
  effort: string | null;
  /** `plexus`: Plexus's default for the role (an explicit, moderate effort); `default`: whatever the CLI uses. */
  modelFrom: 'task' | 'coordinator' | 'role' | 'plexus' | 'default';
  effortFrom: 'task' | 'coordinator' | 'role' | 'plexus' | 'default';
  /** The last run: what it was started with, and the model id the CLI reported (the one that did most of the work). */
  ran: { model: string | null; effort: string | null; reported: string | null; running: boolean } | null;
  /** The choice can still change something: the task is not running (it applies from its next run, or to a continuation). */
  editable: boolean;
}

/** One step of an agent's checklist (reported with the plexus_plan tool or the CLI's own todo tool). */
export interface PlanItem { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** One thing the coordinator did while answering: words it wrote along the way, or a tool call. */
export interface ChatStep { kind: 'text' | 'tool'; text: string }

/**
 * What the coordinator did while answering one message: its tool calls (oldest first), its last checklist, and (newer
 * replies) its steps in order, the words it wrote between tool calls included.
 */
export interface ChatActivity { tools: string[]; plan: PlanItem[] | null; steps?: ChatStep[] }

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
  // analyst / solo / architect: a short map of the code (modules, responsibilities, entry points, how to test) for later agents
  codemap: z.string().optional(),
  // planner
  tasks: z.array(FollowUpTaskSchema).optional(),
  // reviewer
  review: z.object({ verdict: z.enum(['approve', 'changes_requested']), comments: z.array(z.string()).default([]) }).optional(),
  // evaluator
  evaluation: z.object({
    complete: z.boolean(),
    // pass "blocked": cannot be checked here (missing environment, needs a person or a decision); never becomes a gap to fix.
    criteria: z.array(z.object({
      id: z.string(), pass: z.union([z.boolean(), z.literal('blocked')]), evidence: z.string().default(''),
      needs: z.enum(['environment', 'human', 'decision']).optional(),
    })).default([]),
    report: z.string().optional(),
  }).optional(),
}).passthrough();
export type AgentResult = z.infer<typeof AgentResultSchema>;

// ---------------- Coordinator contract ----------------

export const CoordinatorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('add_task'), title: z.string(), description: z.string().default(''), role: z.string().default('implementer'), depends_on: z.array(z.string()).default([]), priority: z.number().optional(), images: z.array(z.string()).optional(), attachments: z.array(z.string()).optional() }),
  // `fresh`: start a new agent even when the last single agent could continue (its conversation is small and recent).
  z.object({ type: z.literal('solo_task'), title: z.string(), description: z.string().default(''), account: z.string().optional(), fresh: z.boolean().optional(), images: z.array(z.string()).optional(), attachments: z.array(z.string()).optional() }),
  z.object({ type: z.literal('cancel_task'), task_id: z.string() }),
  z.object({ type: z.literal('retry_task'), task_id: z.string() }),
  z.object({ type: z.literal('reprioritize'), task_id: z.string(), priority: z.number() }),
  z.object({ type: z.literal('update_task'), task_id: z.string(), description: z.string() }),
  z.object({ type: z.literal('record_decision'), title: z.string(), decision: z.string(), rationale: z.string().default('') }),
  z.object({ type: z.literal('add_directive'), text: z.string() }),
  z.object({ type: z.literal('set_goal'), goal: z.string() }),
  z.object({ type: z.literal('replan'), reason: z.string() }),
  // Run a task on one account (another takes over while it cannot run). "auto" clears the pin.
  z.object({ type: z.literal('assign_account'), task_id: z.string(), account: z.string() }),
  // Remove directives whose text contains `match` (case-insensitive).
  z.object({ type: z.literal('remove_directive'), match: z.string() }),
  // Give more work to the agent that did `task_id`, in its own conversation and worktree (no fresh context).
  z.object({ type: z.literal('continue_task'), task_id: z.string(), title: z.string().default(''), instructions: z.string(), images: z.array(z.string()).optional(), attachments: z.array(z.string()).optional() }),
  // A message for the agent of `task_id`: delivered at the start of its next run (a running task gets it when its turn ends).
  z.object({ type: z.literal('send_message'), task_id: z.string(), text: z.string(), images: z.array(z.string()).optional(), attachments: z.array(z.string()).optional() }),
]);
export type CoordinatorAction = z.infer<typeof CoordinatorActionSchema>;

export const CoordinatorOutputSchema = z.object({
  reply: z.string(),
  actions: z.array(CoordinatorActionSchema).default([]),
  proposal: z.object({ summary: z.string(), actions: z.array(CoordinatorActionSchema) }).nullable().optional(),
});
export type CoordinatorOutput = z.infer<typeof CoordinatorOutputSchema>;
