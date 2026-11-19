// Skill registry. Skills use the Agent Skills layout (a folder with SKILL.md + optional files), which both
// Claude Code (.claude/skills/) and Codex (.agents/skills/) load from the repository they run in.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Skill } from '../shared/types.ts';
import { getDb, now } from './db.ts';
import { paths } from './paths.ts';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function rowToSkill(r: any): Skill {
  return { name: r.name, description: r.description, enabled: !!r.enabled, source: r.source, path: r.path, createdAt: r.created_at };
}

export function listSkills(): Skill[] {
  return (getDb().prepare('SELECT * FROM skills ORDER BY name').all() as any[]).map(rowToSkill);
}

export function getSkill(name: string): Skill | null {
  const r = getDb().prepare('SELECT * FROM skills WHERE name = ?').get(name);
  return r ? rowToSkill(r) : null;
}

/** Find skill folders (containing SKILL.md) inside a directory tree. */
function findSkillDirs(root: string, depth = 0): string[] {
  if (existsSync(join(root, 'SKILL.md'))) return [root];
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') out.push(...findSkillDirs(join(root, e.name), depth + 1));
  }
  return out;
}

function register(dir: string, source: string): Skill {
  const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const fm = parseFrontmatter(md);
  const name = (fm.name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-') || dir.split(/[\\/]/).pop()!.toLowerCase();
  if (!NAME.test(name)) throw new Error(`invalid skill name "${name}"`);
  const dest = join(paths.skills, name);
  if (dest !== dir) { rmSync(dest, { recursive: true, force: true }); cpSync(dir, dest, { recursive: true, filter: s => !/[\\/]\.git([\\/]|$)/.test(s) }); }
  // Newly installed skills start disabled: the user reviews the files first.
  getDb().prepare(`INSERT INTO skills (name, description, enabled, source, path, created_at) VALUES (?, ?, 0, ?, ?, ?)
                   ON CONFLICT(name) DO UPDATE SET description = excluded.description, source = excluded.source, path = excluded.path, enabled = 0`)
    .run(name, fm.description ?? '', source, dest, now());
  return getSkill(name)!;
}

/** Install from a local folder, a .zip file, or a git URL (optionally `url#subdir`). */
export function installSkill(source: string): Skill[] {
  let root = source;
  let tmp: string | null = null;
  try {
    if (/^(https?:\/\/|git@)/.test(source)) {
      const [url, sub] = source.split('#');
      tmp = mkdtempSync(join(tmpdir(), 'swarm-skill-'));
      execFileSync('git', ['clone', '--depth', '1', url, tmp], { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      root = sub ? join(tmp, sub) : tmp;
    } else if (/\.zip$/i.test(source)) {
      tmp = mkdtempSync(join(tmpdir(), 'swarm-skill-'));
      execFileSync('tar', ['-xf', source, '-C', tmp], { stdio: 'pipe' });
      root = tmp;
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
    const dirs = findSkillDirs(root);
    if (!dirs.length) throw new Error('no SKILL.md found');
    return dirs.map(d => register(d, source));
  } finally {
    if (tmp) removeTemp(tmp);
  }
}

/** Make every entry under `dir` writable (git marks object files read-only, which blocks rm on Windows). */
function makeWritable(dir: string): void {
  try { chmodSync(dir, 0o777); } catch {}
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) makeWritable(p);
    else try { chmodSync(p, 0o666); } catch {}
  }
}

/** Best-effort cleanup of a temp folder: a leftover temp dir must never fail an install that already succeeded. */
export function removeTemp(dir: string): void {
  try {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[skills] could not remove temp folder ${dir}: ${(err as Error).message}`);
  }
}

export function createSkill(name: string, description: string, body: string): Skill {
  if (!NAME.test(name)) throw new Error('skill name must be lowercase letters, digits and dashes');
  const dir = join(paths.skills, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n${body.trim()}\n`);
  const s = register(dir, 'editor');
  setSkillEnabled(name, true); // written by the user in the app: no review needed
  return { ...s, enabled: true };
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  getDb().prepare('UPDATE skills SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

export function deleteSkill(name: string): void {
  const s = getSkill(name);
  if (!s) return;
  rmSync(s.path, { recursive: true, force: true });
  getDb().prepare('DELETE FROM skills WHERE name = ?').run(name);
}

/** All files of a skill with contents (text, truncated) so the user can review before enabling. */
export function skillFiles(name: string): { path: string; size: number; content: string }[] {
  const s = getSkill(name);
  if (!s) throw new Error('no such skill');
  const out: { path: string; size: number; content: string }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const size = statSync(p).size;
        const buf = readFileSync(p);
        const binary = buf.subarray(0, 8000).includes(0);
        out.push({ path: relative(s.path, p).replace(/\\/g, '/'), size, content: binary ? '[binary file]' : buf.toString('utf8').slice(0, 100_000) });
      }
    }
  };
  walk(s.path);
  return out;
}

/** Copy the enabled skills of a role into a worktree for both CLIs. */
export function materializeSkills(worktree: string, names: string[]): string[] {
  const used: string[] = [];
  for (const n of names) {
    const s = getSkill(n);
    if (!s?.enabled || !existsSync(s.path)) continue;
    for (const base of ['.claude/skills', '.agents/skills']) {
      const dest = join(worktree, base, n);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(join(worktree, base), { recursive: true });
      cpSync(s.path, dest, { recursive: true });
    }
    used.push(n);
  }
  return used;
}
