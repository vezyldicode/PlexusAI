import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Claude Code's folder name for a working directory under <config>/projects (every non-alphanumeric becomes '-'). */
export function claudeProjectDir(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Make a conversation held for another working directory resumable from `toCwd`. Claude Code looks a session up in the
 * folder of the current directory only, so the coordinator's chat (run in the project folder) is copied into the
 * worktree's folder; `--resume <id> --fork-session` then continues a copy under a new id and leaves the chat untouched.
 * Returns false when the transcript cannot be found or the path is one Claude shortens (then the run starts fresh).
 */
export function forkClaudeConversation(configDir: string, fromCwd: string, toCwd: string, sessionId: string): boolean {
  try {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return false;
    const projects = join(configDir, 'projects');
    const file = `${sessionId}.jsonl`;
    const target = claudeProjectDir(toCwd);
    if (target.length > 200) return false;
    const dest = join(projects, target, file);
    if (existsSync(dest)) return true;
    let src = join(projects, claudeProjectDir(fromCwd), file);
    if (!existsSync(src)) {
      const hit = existsSync(projects) ? readdirSync(projects).find(d => existsSync(join(projects, d, file))) : undefined;
      if (!hit) return false;
      src = join(projects, hit, file);
    }
    mkdirSync(join(projects, target), { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}
