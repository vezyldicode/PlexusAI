// Directives (.plexus/memory/directives.md): standing instructions from the user, one "- " line each.
//
// A directive may say who it is for, at the start of its line:
//   - [for: coordinator] Propose a plan before editing code.            only the coordinator
//   - [for: agents] Run the tests before finishing.                      every agent, not the coordinator
//   - [for: implementer,qa; paths: ui/**] Use Tailwind.                  those roles, on tasks touching ui/
// A line without a tag (and any other text in the file) is for everyone, so a hand-written file keeps working.
// Filtering is exact, never a guess at relevance: a directive must be followed, so when in doubt it is included
// (a task that does not list its paths gets every path-scoped directive of its role).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Task } from '../shared/types.ts';
import { appendMemory, memoryDir, readMemory, writeMemory } from './projects.ts';
import { pathsOverlap } from './tasks.ts';

export const FILE = 'directives.md';
/** Who reads a directive: the coordinator, or an agent of a role working on some paths. */
export type Reader = { role: 'coordinator' } | { role: string; paths: string[] };
export interface DirectiveScope { for: string[]; paths: string[] }

const TAG = /^(\s*-\s*)\[for:\s*([^\]]*)\]\s*/i;
const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

/** The scope written at the start of a directive line; null for a line meant for everyone. */
export function parseScope(line: string): DirectiveScope | null {
  const m = TAG.exec(line);
  if (!m) return null;
  const [who, ...rest] = m[2].split(';');
  const paths = rest.map(r => /^\s*paths:\s*(.*)$/i.exec(r)?.[1] ?? '').flatMap(list);
  return { for: list(who.toLowerCase()), paths };
}

export function formatScope(s: DirectiveScope | null): string {
  if (!s || (!s.for.length && !s.paths.length)) return '';
  return `[for: ${(s.for.length ? s.for : ['all']).join(',')}${s.paths.length ? `; paths: ${s.paths.join(',')}` : ''}] `;
}

/** Whether a reader must get a directive with this scope. */
export function scopeApplies(s: DirectiveScope | null, r: Reader): boolean {
  if (!s) return true;
  const who = s.for.length ? s.for : ['all'];
  const role = r.role.toLowerCase();
  if (role === 'coordinator') return who.includes('all') || who.includes('coordinator');
  if (!(who.includes('all') || who.includes('agents') || who.includes(role))) return false;
  const paths = 'paths' in r ? r.paths : [];
  return !s.paths.length || !paths.length || pathsOverlap(s.paths, paths);
}

/** The directives a reader must follow, as they stand in the file (scope tags kept, so the reader sees why). */
export function directivesFor(p: Project, r: Reader): string {
  const lines = readMemory(p, FILE).split('\n');
  return lines.filter(l => !l.trim().startsWith('-') || scopeApplies(parseScope(l), r)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const readerOf = (t: Pick<Task, 'role' | 'paths'>): Reader => ({ role: t.role, paths: t.paths ?? [] });

const norm = (l: string) => l.replace(TAG, '$1').replace(/^\s*-\s*/, '').replace(/\s*_\([^)]*\)_\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Add a directive. The same text already there (whatever its scope) is replaced, so repeating a directive with another
 * scope moves it instead of keeping two. Returns whether an earlier line was replaced.
 */
export function addDirective(p: Project, text: string, scope: DirectiveScope | null, at: string): boolean {
  const body = text.trim().replace(/^-\s*/, '');
  const line = `- ${formatScope(scope)}${body} _(${at.slice(0, 16)})_`;
  const lines = readMemory(p, FILE).split('\n');
  const key = norm(`- ${body}`);
  const i = lines.findIndex(l => l.trim().startsWith('-') && norm(l) === key);
  if (i < 0) { appendMemory(p, FILE, line); return false; }
  lines[i] = line;
  writeMemory(p, FILE, lines.join('\n'));
  return true;
}

/** When directives.md last changed (ISO), or null if it does not exist. */
export function directivesChangedAt(p: Project): string | null {
  try { return statSync(join(memoryDir(p), FILE)).mtime.toISOString(); } catch { return null; }
}
