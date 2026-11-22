// Engine settings (see shared/config.ts) and the defaults new projects start with. Read on every use from a memory copy,
// so a change in Settings takes effect on the next scheduler pass, poll or run without a restart.
import { cleanConfigPatch, DEFAULT_APP_CONFIG, type AppConfig } from '../shared/config.ts';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../shared/types.ts';
import { getSetting, setSetting } from './db.ts';
import { bus } from './events.ts';

const KEY = 'app-config';
const PROJECT_KEY = 'project-defaults';

let cached: AppConfig | null = null;
const listeners = new Set<(c: AppConfig) => void>();

/** Stored overrides only (what differs from the defaults). */
export function configOverrides(): Partial<AppConfig> {
  return getSetting<Partial<AppConfig>>(KEY, {}) ?? {};
}

export function appConfig(): AppConfig {
  if (!cached) cached = { ...DEFAULT_APP_CONFIG, ...cleanStored(configOverrides()) };
  return cached;
}

function cleanStored(o: Partial<AppConfig>): Partial<AppConfig> {
  const c = cleanConfigPatch(o as Record<string, unknown>);
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null)) as Partial<AppConfig>;
}

/** Apply a patch; `null` (or the default value) removes a key so it follows the default again. */
export function updateConfig(patch: Record<string, unknown>): AppConfig {
  const next: Record<string, unknown> = { ...configOverrides() };
  for (const [k, v] of Object.entries(cleanConfigPatch(patch))) {
    if (v === null || v === DEFAULT_APP_CONFIG[k as keyof AppConfig]) delete next[k];
    else next[k] = v;
  }
  setSetting(KEY, next);
  cached = null;
  const c = appConfig();
  for (const l of listeners) { try { l(c); } catch { /* a listener must not break saving */ } }
  bus.emitEvent('config.updated', null, c, false);
  return c;
}

/** Called after every change (timers re-arm with their new interval). */
export function onConfigChange(fn: (c: AppConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests and a moved data folder: read the stored settings again. */
export function forgetConfigCache(): void { cached = null; }

// ---------------- defaults for new projects ----------------

const PROJECT_NUM: { [K in keyof ProjectSettings]?: [number, number] } = {
  maxParallel: [1, 20], maxTasks: [1, 1000], maxEvalRounds: [1, 20], maxReviewCycles: [0, 10], maxAttempts: [1, 20],
  independentReviewWaitMin: [0, 480], decisionsCompactAt: [0, 200_000], reviewMinLines: [0, 100_000], autocompactTokens: [0, 2_000_000],
  maxCompactions: [0, 20],
};
const PROJECT_ENUM: { [K in keyof ProjectSettings]?: readonly string[] } = {
  quotaStrategy: ['spread', 'drain', 'priority'], pipeline: ['auto', 'single', 'team'], reviewPolicy: ['auto', 'always', 'never'],
};
const PROJECT_BOOL = new Set<keyof ProjectSettings>(['reviewEnabled', 'qaPhase', 'resumeSessions']);

/** Project settings from the API, clamped and typed; unknown keys dropped (coordinator choices pass through). */
export function cleanProjectSettings(s: Record<string, unknown>): Partial<ProjectSettings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s ?? {})) {
    const key = k as keyof ProjectSettings;
    if (!(key in DEFAULT_PROJECT_SETTINGS)) continue;
    const range = PROJECT_NUM[key], values = PROJECT_ENUM[key];
    if (range) { const n = Number(v); if (Number.isFinite(n)) out[k] = Math.min(range[1], Math.max(range[0], Math.round(n))); }
    else if (values) { if (typeof v === 'string' && values.includes(v)) out[k] = v; }
    else if (PROJECT_BOOL.has(key)) { if (typeof v === 'boolean') out[k] = v; }
    else out[k] = v;
  }
  return out as Partial<ProjectSettings>;
}

/** What a new project starts with: the built-in defaults plus the user's own. */
export function projectDefaults(): ProjectSettings {
  return { ...DEFAULT_PROJECT_SETTINGS, ...cleanProjectSettings(getSetting<Record<string, unknown>>(PROJECT_KEY, {}) ?? {}) };
}

export function updateProjectDefaults(patch: Record<string, unknown>): ProjectSettings {
  const next: Record<string, unknown> = { ...(getSetting<Record<string, unknown>>(PROJECT_KEY, {}) ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete next[k];
  }
  for (const [k, v] of Object.entries(cleanProjectSettings(patch))) {
    if (JSON.stringify(v) === JSON.stringify(DEFAULT_PROJECT_SETTINGS[k as keyof ProjectSettings])) delete next[k];
    else next[k] = v;
  }
  // The coordinator's account and models belong to one project, not to the defaults.
  delete next.coordinatorAccountId; delete next.coordinatorModels; delete next.coordinatorEfforts;
  setSetting(PROJECT_KEY, next);
  return projectDefaults();
}
