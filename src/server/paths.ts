import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

/** Root of all Plexus app data. Override with PLEXUS_HOME (tests use a temp dir). */
export function plexusHome(): string {
  const base = process.env.PLEXUS_HOME ?? defaultHome();
  mkdirSync(base, { recursive: true });
  return resolve(base);
}

/** %APPDATA%\plexus or ~/.plexus. Keeps using the folder from before the rename (swarm) if only that one exists,
 *  since the database stores absolute paths into it (account logins, worktrees). */
export function defaultHome(): string {
  const win = process.platform === 'win32';
  const root = win ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') : homedir();
  const cur = join(root, win ? 'plexus' : '.plexus'), legacy = join(root, win ? 'swarm' : '.swarm');
  return !existsSync(cur) && existsSync(legacy) ? legacy : cur;
}

export const paths = {
  get home() { return plexusHome(); },
  get db() { const h = plexusHome(), legacy = join(h, 'swarm.db'); return !existsSync(join(h, 'plexus.db')) && existsSync(legacy) ? legacy : join(h, 'plexus.db'); },
  get accounts() { return ensure(join(plexusHome(), 'accounts')); },
  get roles() { return ensure(join(plexusHome(), 'roles')); },
  get skills() { return ensure(join(plexusHome(), 'skills')); },
  get worktrees() { return ensure(join(plexusHome(), 'worktrees')); },
  get logs() { return ensure(join(plexusHome(), 'logs')); },
  get token() { return join(plexusHome(), 'api-token'); },
};

export function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Repository root of this app (for bundled defaults and UI build). */
export const appRoot = resolve(import.meta.dirname, '..', '..');
