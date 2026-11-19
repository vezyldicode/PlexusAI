// Models and efforts offered by the accounts' CLIs (GET /api/models), shared by every model picker.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { ModelCatalog, ModelCatalogEntry, Provider } from './types.ts';

/** Used until the daemon answers, or when no account could list its models. */
export const FALLBACK: Record<Provider, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: [], mock: [] };

let shared: Promise<ModelCatalog> | null = null;
const listeners = new Set<(c: ModelCatalog) => void>();

function load(refresh = false): Promise<ModelCatalog> {
  const p = api<{ catalog: ModelCatalog }>('GET', `/api/models${refresh ? '?refresh=1' : ''}`).then(r => r.catalog ?? {}).catch(() => ({} as ModelCatalog));
  shared = p;
  void p.then(c => { for (const l of listeners) l(c); });
  return p;
}

/** Re-read the models from the CLIs (e.g. after a login). */
export const refreshModels = () => load(true);

export function useModels(): ModelCatalog {
  const [c, setC] = useState<ModelCatalog>({});
  useEffect(() => {
    listeners.add(setC);
    void (shared ?? load()).then(setC);
    return () => { listeners.delete(setC); };
  }, []);
  return c;
}

function find(list: ModelCatalogEntry[], model: string | undefined): ModelCatalogEntry | undefined {
  if (!model) return list.find(m => m.isDefault);
  const w = model.toLowerCase();
  return list.find(m => m.id.toLowerCase() === w) ?? list.find(m => m.resolved?.toLowerCase() === w);
}

/** Suggestions for a model input of this provider. */
export function ModelDatalist({ id, provider, catalog }: { id: string; provider: Provider; catalog: ModelCatalog }) {
  const list = (catalog[provider] ?? []).filter(m => !m.hidden);
  return (
    <datalist id={id}>
      {list.length
        ? list.map(m => <option key={m.id} value={m.id}>{m.label !== m.id ? m.label : m.description ?? ''}</option>)
        : FALLBACK[provider].map(m => <option key={m} value={m} />)}
    </datalist>
  );
}

/** Efforts the model accepts; for an unknown model, every effort the provider offers. */
export function effortsFor(catalog: ModelCatalog, provider: Provider, model: string | undefined): { efforts: string[]; known: boolean; defaultEffort: string | null } {
  const list = catalog[provider] ?? [];
  const m = find(list, model);
  if (m) return { efforts: m.efforts, known: true, defaultEffort: m.defaultEffort ?? null };
  return { efforts: [...new Set(list.flatMap(x => x.efforts))], known: false, defaultEffort: null };
}

/** Effort picker for one provider; the list follows the chosen model (or the CLI default model). */
export function EffortSelect({ catalog, provider, model, value, onChange, fallbackLabel, title }: {
  catalog: ModelCatalog; provider: Provider; model: string | undefined; value: string; onChange: (v: string) => void;
  /** What an empty value means, e.g. "high (role)"; defaults to the CLI default. */
  fallbackLabel?: string; title?: string;
}) {
  const { efforts, known, defaultEffort } = effortsFor(catalog, provider, model);
  const unsupported = !!value && known && !efforts.includes(value);
  if (!efforts.length && !value) return <select className="effort" disabled title={known ? 'This model has no effort setting' : 'No effort information yet'}><option>Effort: n/a</option></select>;
  return (
    <select className={`effort ${unsupported ? 'bad' : ''}`} value={value} onChange={e => onChange(e.target.value)}
      title={unsupported ? `${value} is not supported by this model and will be ignored` : title ?? 'Reasoning effort'}>
      <option value="">{fallbackLabel ?? `Effort: default${defaultEffort ? ` (${defaultEffort})` : ''}`}</option>
      {efforts.map(e => <option key={e} value={e}>{e}</option>)}
      {value && !efforts.includes(value) && <option value={value}>{value} (unsupported)</option>}
    </select>
  );
}
