import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME_RE = /^[A-Za-z0-9._:\/-]{1,80}$/;

/** Top-level `key = "value"` of a config.toml (before the first [table]); enough for model and effort. */
function topLevel(text: string, key: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) return undefined;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

/**
 * The model and reasoning effort the person chose for Codex: the account's own config.toml first, then the one the Codex
 * app uses (~/.codex or CODEX_HOME of the daemon). Workers run with --ignore-user-config, which would drop them.
 */
export function codexUserDefaults(accountHome: string): { model?: string; effort?: string } {
  const files = [join(accountHome, 'config.toml'), join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')];
  const out: { model?: string; effort?: string } = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const model = topLevel(text, 'model'), effort = topLevel(text, 'model_reasoning_effort');
    if (!out.model && model && NAME_RE.test(model)) out.model = model;
    if (!out.effort && effort && /^[a-z][a-z0-9_-]{0,19}$/.test(effort)) out.effort = effort;
  }
  return out;
}
