// App-wide engine settings (Settings → Quota, Scheduler, Context, Coordinator, Advanced).
// Only values that differ from the defaults are stored (settings table, key `app-config`); a missing key means its default.
// Units are the ones people think in (seconds, minutes, thousands of tokens), converted where the value is used.

export interface AppConfig {
  // ---- quota monitoring
  /** Minutes between free usage checks (`get_usage`) of an idle Claude account. */
  claudePollMin: number;
  /** Longest wait, in minutes, between usage checks of a Claude account whose check keeps failing. */
  claudeBackoffMaxMin: number;
  /** Seconds between rate-limit reads of the Codex app-server. */
  codexPollSec: number;
  /** Minutes between probes of an account that ran out of quota with no known reset time. */
  limitedRecheckMin: number;
  /** Usage percent at which an account counts as nearly spent (picked last). */
  warnPercent: number;
  /** Usage percent at which a window counts as spent (the account rests until it resets). */
  exhaustedPercent: number;
  /** Minutes an account rests when it ran out of quota and the CLI gave no reset time. */
  unknownResetBackoffMin: number;
  /** Seconds an account rests after a temporary API or network error. */
  transientBackoffSec: number;
  /** Seconds to wait for the Claude CLI to answer a status request. */
  controlTimeoutSec: number;

  // ---- scheduler
  /** Seconds between scheduler passes (start ready tasks, release rested accounts). */
  tickSec: number;
  /** Shortest no-output timeout of an agent run, in minutes. */
  idleTimeoutMinMin: number;
  /** Longest no-output timeout of an agent run, in minutes (the role's max runtime is used in between). */
  idleTimeoutMaxMin: number;
  /** Minutes between "no account available" notices in a project chat. */
  noAccountNoticeMin: number;
  /** Seconds after start in which a failed resume is retried as a fresh conversation. */
  resumeFailWindowSec: number;
  /** Evaluation gaps up to this many go to one agent; more become separate tasks. */
  gapBundleMax: number;
  /** Times an integrator may try to resolve a merge conflict before the task fails. */
  mergeConflictTries: number;
  /** Minutes merges wait while the coordinator edits the main checkout. */
  mainHoldMin: number;
  /** Below this many characters of goal (and too few docs), Plexus asks before starting. */
  minGoalChars: number;
  /** Below this many characters of documentation (and a short goal), Plexus asks before starting. */
  minDocChars: number;

  // ---- context and token use
  /** Largest conversation, in thousands of tokens, that is still resumed instead of started fresh. */
  laneCtxMaxK: number;
  /** Minutes after which a conversation counts as cold (the provider's prompt cache has expired). */
  laneIdleMaxMin: number;
  /** A cold conversation is still resumed up to this many thousand tokens. */
  laneColdCtxMaxK: number;
  briefChars: number;
  summaryChars: number;
  acceptanceChars: number;
  decisionsFullChars: number;
  decisionsRelevantChars: number;
  decisionTitles: number;
  issuesChars: number;
  taskIssuesChars: number;
  codemapChars: number;
  laneNotesChars: number;
  handoffFiles: number;

  // ---- coordinator chat
  /** Minutes the coordinator may stay silent before its turn is stopped. */
  chatIdleTimeoutMin: number;
  /** Chat messages put into the coordinator's prompt. */
  chatHistoryMessages: number;
  /** Characters kept of each chat message in the prompt. */
  chatMessageChars: number;
  /** Largest chat conversation, in thousands of tokens, that is still resumed. */
  chatCtxMaxK: number;
  /** Recent events in the coordinator's status digest. */
  digestEvents: number;
  /** Recently finished tasks in the coordinator's status digest. */
  digestDone: number;

  // ---- advanced
  /** Hours the model list of an account is cached. */
  modelCacheHours: number;
  /** Model for the fallback Claude probe (one tiny call, used only when the free status check fails). */
  probeModel: string;
  /** Claude CLI executable; empty = PLEXUS_CLAUDE_BIN or the PATH. */
  claudeBin: string;
  /** Codex CLI executable; empty = PLEXUS_CODEX_BIN or the PATH. */
  codexBin: string;
  /** Author name of the commits Plexus makes. */
  gitName: string;
  /** Author email of the commits Plexus makes. */
  gitEmail: string;
  /**
   * Off (default): Plexus never commits on the user's branches; finished work lands in the project folder as uncommitted
   * changes and the user commits it. On: the old behaviour (snapshot commit before a run, merges committed on the branch).
   */
  autoCommit: boolean;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  claudePollMin: 5,
  claudeBackoffMaxMin: 30,
  codexPollSec: 60,
  limitedRecheckMin: 30,
  warnPercent: 90,
  exhaustedPercent: 100,
  unknownResetBackoffMin: 15,
  transientBackoffSec: 60,
  controlTimeoutSec: 30,

  tickSec: 2,
  idleTimeoutMinMin: 10,
  idleTimeoutMaxMin: 30,
  noAccountNoticeMin: 30,
  resumeFailWindowSec: 90,
  gapBundleMax: 4,
  mergeConflictTries: 2,
  mainHoldMin: 10,
  minGoalChars: 25,
  minDocChars: 300,

  laneCtxMaxK: 120,
  laneIdleMaxMin: 55,
  laneColdCtxMaxK: 40,
  briefChars: 12_000,
  summaryChars: 1_800,
  acceptanceChars: 8_000,
  decisionsFullChars: 8_000,
  decisionsRelevantChars: 4_000,
  decisionTitles: 80,
  issuesChars: 3_000,
  taskIssuesChars: 1_500,
  codemapChars: 4_000,
  laneNotesChars: 4_000,
  handoffFiles: 8,

  chatIdleTimeoutMin: 5,
  chatHistoryMessages: 20,
  chatMessageChars: 1_500,
  chatCtxMaxK: 120,
  digestEvents: 10,
  digestDone: 15,

  modelCacheHours: 12,
  probeModel: 'haiku',
  claudeBin: '',
  codexBin: '',
  gitName: 'Plexus',
  gitEmail: 'plexus@localhost',
  autoCommit: false,
};

/** Allowed range of each number (inclusive). Values outside are clamped on save. */
export const CONFIG_BOUNDS: { [K in keyof AppConfig]?: [number, number] } = {
  claudePollMin: [1, 60],
  claudeBackoffMaxMin: [5, 240],
  codexPollSec: [15, 900],
  limitedRecheckMin: [5, 240],
  warnPercent: [50, 99],
  exhaustedPercent: [80, 100],
  unknownResetBackoffMin: [1, 240],
  transientBackoffSec: [10, 1800],
  controlTimeoutSec: [5, 180],

  tickSec: [1, 30],
  idleTimeoutMinMin: [1, 240],
  idleTimeoutMaxMin: [1, 480],
  noAccountNoticeMin: [5, 480],
  resumeFailWindowSec: [10, 600],
  gapBundleMax: [1, 20],
  mergeConflictTries: [0, 5],
  mainHoldMin: [1, 120],
  minGoalChars: [0, 1000],
  minDocChars: [0, 10_000],

  laneCtxMaxK: [10, 1000],
  laneIdleMaxMin: [5, 1440],
  laneColdCtxMaxK: [0, 500],
  briefChars: [1000, 60_000],
  summaryChars: [300, 10_000],
  acceptanceChars: [1000, 60_000],
  decisionsFullChars: [1000, 60_000],
  decisionsRelevantChars: [500, 30_000],
  decisionTitles: [0, 500],
  issuesChars: [500, 30_000],
  taskIssuesChars: [300, 15_000],
  codemapChars: [500, 30_000],
  laneNotesChars: [500, 30_000],
  handoffFiles: [0, 50],

  chatIdleTimeoutMin: [1, 60],
  chatHistoryMessages: [2, 100],
  chatMessageChars: [200, 20_000],
  chatCtxMaxK: [10, 1000],
  digestEvents: [0, 200],
  digestDone: [0, 100],

  modelCacheHours: [1, 168],
};

/** Keep known keys with values of the right type, clamped to their range. `null` means "back to the default". */
export function cleanConfigPatch(patch: Record<string, unknown>): Partial<Record<keyof AppConfig, AppConfig[keyof AppConfig] | null>> {
  const out: Partial<Record<keyof AppConfig, AppConfig[keyof AppConfig] | null>> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in DEFAULT_APP_CONFIG)) continue;
    const key = k as keyof AppConfig;
    if (v === null) { out[key] = null; continue; }
    const def = DEFAULT_APP_CONFIG[key];
    if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = CONFIG_BOUNDS[key] ?? [-Infinity, Infinity];
      out[key] = Math.min(hi, Math.max(lo, Math.round(n)));
    } else if (typeof def === 'boolean') { if (typeof v === 'boolean') out[key] = v; }
    else if (typeof v === 'string') out[key] = v.trim().slice(0, 500);
  }
  return out;
}
