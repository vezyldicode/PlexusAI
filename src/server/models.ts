// Models and reasoning efforts per account, read from the provider CLIs (no model call) and cached.
// The catalog feeds the UI pickers; resolveEffort() checks an effort before a run, because Claude silently ignores an
// unknown --effort and Codex sends it to the API, which fails the whole turn with a 400.
import type { Account, ModelCatalog, ModelCatalogEntry, ModelInfo, Provider } from '../shared/types.ts';
import { adapterFor } from './adapters/index.ts';
import { getSetting, setSetting } from './db.ts';
import { appConfig } from './config.ts';

const EFFORT_RE = /^[a-z][a-z0-9_-]{0,19}$/;

interface Cached { at: number; models: ModelInfo[] }
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<ModelInfo[]>>();

const key = (id: string) => `models:${id}`;

function cached(a: Account): Cached | null {
  const hit = cache.get(a.id) ?? getSetting<Cached | null>(key(a.id), null);
  if (hit && !cache.has(a.id)) cache.set(a.id, hit);
  return hit;
}

/** Store models read some other way (e.g. by the quota poll, which gets them from the same CLI start). */
export function rememberModels(accountId: string, models: ModelInfo[]): void {
  if (!models.length) return;
  const c = { at: Date.now(), models };
  cache.set(accountId, c);
  setSetting(key(accountId), c);
}

export function forgetModels(accountId: string): void {
  cache.delete(accountId);
  setSetting(key(accountId), null);
}

/** Models of one account; refreshed from the CLI when older than 12 h (or on `refresh`). Stale data beats none on error. */
export async function modelsFor(a: Account, refresh = false): Promise<ModelInfo[]> {
  const hit = cached(a);
  if (hit && !refresh && Date.now() - hit.at < appConfig().modelCacheHours * 3600_000) return hit.models;
  let p = inflight.get(a.id);
  if (!p) {
    p = adapterFor(a.provider).listModels(a).then(m => { rememberModels(a.id, m); return m; }).finally(() => inflight.delete(a.id));
    inflight.set(a.id, p);
  }
  try { return await p; } catch (e) { if (hit) return hit.models; throw e; }
}

/** Cached models only (never starts a CLI). */
export function cachedModels(a: Account): ModelInfo[] | null {
  return cached(a)?.models ?? null;
}

/** Union of the enabled accounts' models per provider; each entry lists the accounts that offer it. */
export async function modelCatalog(accounts: Account[], refresh = false): Promise<{ catalog: ModelCatalog; errors: Record<string, string> }> {
  const catalog: ModelCatalog = {};
  const errors: Record<string, string> = {};
  // A logged-out Claude CLI still lists its generic aliases; only accounts that can run count.
  const lists = await Promise.all(accounts.filter(a => a.enabled && a.state !== 'needs_login' && a.state !== 'blocked').map(async a => {
    try { return { a, models: await modelsFor(a, refresh) }; } catch (e: any) { errors[a.id] = String(e?.message ?? e); return { a, models: [] as ModelInfo[] }; }
  }));
  for (const { a, models } of lists) {
    const list = (catalog[a.provider] ??= []);
    for (const m of models) {
      const ex = list.find(x => x.id === m.id);
      if (!ex) { list.push({ ...m, accounts: [a.id] }); continue; }
      ex.accounts.push(a.id);
      ex.efforts = [...new Set([...ex.efforts, ...m.efforts])];
    }
  }
  return { catalog, errors };
}

/** The model a run will use: the requested id/alias, or the CLI's default model when none is given. */
export function findModel(models: ModelInfo[], model: string | undefined | null): ModelInfo | null {
  if (!model) return models.find(m => m.isDefault) ?? null;
  const want = model.toLowerCase();
  return models.find(m => m.id.toLowerCase() === want) ?? models.find(m => m.resolved?.toLowerCase() === want) ?? null;
}

export interface EffortDecision { effort: string | undefined; warning: string | null }

/**
 * Decide the effort to pass for a run. Without model information for the account (never listed, CLI failed),
 * a well-formed effort is passed through unchanged; with it, an effort the model does not support is dropped.
 */
export function resolveEffort(models: ModelInfo[] | null, model: string | undefined, effort: string | undefined): EffortDecision {
  const e = effort?.trim().toLowerCase();
  if (!e) return { effort: undefined, warning: null };
  if (!EFFORT_RE.test(e)) return { effort: undefined, warning: `ignored effort "${effort}": not a valid effort name` };
  if (!models?.length) return { effort: e, warning: null };
  const m = findModel(models, model);
  if (!m) return { effort: e, warning: null };
  if (!m.efforts.length) return { effort: undefined, warning: `ignored effort "${e}": ${m.label} has no effort setting` };
  if (!m.efforts.includes(e)) return { effort: undefined, warning: `ignored effort "${e}": ${m.label} supports ${m.efforts.join(', ')}` };
  return { effort: e, warning: null };
}

/** Effort for a run on `account`, using cached models when present and reading them once otherwise. */
export async function effortForRun(account: Account, model: string | undefined, effort: string | undefined): Promise<EffortDecision> {
  if (!effort?.trim()) return { effort: undefined, warning: null };
  const models = cachedModels(account) ?? await modelsFor(account).catch(() => null);
  return resolveEffort(models, model, effort);
}

/** Keep only known providers with a well-formed effort name (API input). */
export function cleanEfforts(m: Record<string, unknown>): Partial<Record<Provider, string>> {
  return Object.fromEntries(Object.entries(m ?? {})
    .filter(([k, v]) => ['claude', 'codex', 'mock'].includes(k) && typeof v === 'string' && EFFORT_RE.test(v.trim().toLowerCase()))
    .map(([k, v]) => [k, String(v).trim().toLowerCase()]));
}

export type { ModelCatalogEntry };
