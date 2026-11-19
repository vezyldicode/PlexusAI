import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

/** Root of all swarm app data. Override with SWARM_HOME (tests use a temp dir). */
export function swarmHome(): string {
  const base = process.env.SWARM_HOME
    ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'swarm') : join(homedir(), '.swarm'));
  mkdirSync(base, { recursive: true });
  return resolve(base);
}

export const paths = {
  get home() { return swarmHome(); },
  get db() { return join(swarmHome(), 'swarm.db'); },
  get accounts() { return ensure(join(swarmHome(), 'accounts')); },
  get roles() { return ensure(join(swarmHome(), 'roles')); },
  get skills() { return ensure(join(swarmHome(), 'skills')); },
  get worktrees() { return ensure(join(swarmHome(), 'worktrees')); },
  get logs() { return ensure(join(swarmHome(), 'logs')); },
  get token() { return join(swarmHome(), 'api-token'); },
};

export function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Repository root of this app (for bundled defaults and UI build). */
export const appRoot = resolve(import.meta.dirname, '..', '..');
