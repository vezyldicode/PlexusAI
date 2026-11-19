import type { Provider } from '../../shared/types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { mockAdapter } from './mock.ts';
import type { ProviderAdapter } from './types.ts';

const adapters: Record<Provider, ProviderAdapter> = { claude: claudeAdapter, codex: codexAdapter, mock: mockAdapter };

export function adapterFor(p: Provider): ProviderAdapter {
  const a = adapters[p];
  if (!a) throw new Error(`unknown provider ${p}`);
  return a;
}

export type { ProviderAdapter, RunSpec, RunOutcome, Classification } from './types.ts';
