import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '../shared/types.ts';
import { cleanEfforts } from './models.ts';
import { appRoot, paths } from './paths.ts';

const defaultsFile = join(appRoot, 'defaults', 'roles.json');
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

export function defaultRoles(): Role[] {
  return JSON.parse(readFileSync(defaultsFile, 'utf8'));
}

export const BUILTIN_ROLES = new Set(defaultRoles().map(r => r.name));

/** Seed missing default roles into the user's role directory (never overwrites edits). */
export function seedRoles(): void {
  for (const r of defaultRoles()) if (!existsSync(join(paths.roles, `${r.name}.json`))) writeRole(r);
}

function writeRole(r: Role) {
  const { instructions, ...meta } = r;
  writeFileSync(join(paths.roles, `${r.name}.json`), JSON.stringify(meta, null, 2));
  writeFileSync(join(paths.roles, `${r.name}.md`), instructions.trimEnd() + '\n');
}

export function listRoles(): Role[] {
  return readdirSync(paths.roles).filter(f => f.endsWith('.json')).map(f => readRole(f.slice(0, -5))!).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readRole(name: string): Role | null {
  const meta = join(paths.roles, `${name}.json`);
  if (!existsSync(meta)) return null;
  const m = JSON.parse(readFileSync(meta, 'utf8'));
  const mdPath = join(paths.roles, `${name}.md`);
  return {
    name, description: m.description ?? '', providers: m.providers ?? [], models: m.models ?? {}, efforts: m.efforts ?? {}, skills: m.skills ?? [],
    writesCode: !!m.writesCode, maxRuntimeMin: m.maxRuntimeMin ?? 60,
    onlyListed: !!m.onlyListed, maxParallel: Math.max(0, Number(m.maxParallel ?? 0) || 0),
    instructions: existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '',
  };
}

export function getRole(name: string): Role {
  return readRole(name) ?? readRole('implementer')!;
}

export function saveRole(r: Role): Role {
  if (!NAME.test(r.name)) throw new Error('role name must be lowercase letters, digits and dashes');
  writeRole({ ...r, providers: [...new Set(r.providers ?? [])], models: r.models ?? {}, efforts: cleanEfforts(r.efforts ?? {}), skills: r.skills ?? [], onlyListed: !!r.onlyListed, maxParallel: Math.max(0, Math.floor(Number(r.maxParallel) || 0)) });
  return readRole(r.name)!;
}

export function deleteRole(name: string): void {
  if (BUILTIN_ROLES.has(name)) throw new Error('built-in roles can be edited or reset, not deleted');
  rmSync(join(paths.roles, `${name}.json`), { force: true });
  rmSync(join(paths.roles, `${name}.md`), { force: true });
}

export function resetRole(name: string): Role {
  const d = defaultRoles().find(r => r.name === name);
  if (!d) throw new Error('not a built-in role');
  writeRole(d);
  return readRole(name)!;
}
