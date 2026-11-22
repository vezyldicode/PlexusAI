// First-run setup: is this machine ready to run agents (Git, a coding CLI, a signed-in account), and has the
// person been through the setup screen. The flag lives in the daemon (settings table), not in the browser, so the
// desktop window and a browser tab agree on it.
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '../shared/types.ts';
import { applyClassification, claudeLoggedIn, getAccount, listAccounts } from './accounts.ts';
import { adapterFor } from './adapters/index.ts';
import { getSetting, now, setSetting } from './db.ts';
import { listProjects } from './projects.ts';
import { childEnv, resolveCli } from './util/proc.ts';

export interface ToolStatus { found: boolean; version: string | null; path: string | null }
export interface SetupChecks { git: ToolStatus; claude: ToolStatus; codex: ToolStatus; platform: NodeJS.Platform }
export interface OnboardingState { onboarded: boolean; skipped: boolean }

const KEY = 'onboarding';
type Stored = { completedAt?: string; skipped?: boolean; pending?: boolean };

export const INSTALL_COMMANDS = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
} as const;
export type InstallTool = keyof typeof INSTALL_COMMANDS;

/**
 * The first read decides once: a home that already holds projects or real accounts is an existing install and
 * skips the setup screen; an empty home is marked pending, so accounts added during setup do not end it early.
 */
export function onboardingState(): OnboardingState {
  let s = getSetting<Stored | null>(KEY, null);
  if (!s) {
    const existing = listProjects().length > 0 || listAccounts().some(a => a.provider !== 'mock');
    s = existing ? { completedAt: now(), skipped: false } : { pending: true };
    setSetting(KEY, s);
  }
  return { onboarded: !!s.completedAt, skipped: !!s.skipped };
}

export function completeOnboarding(skipped: boolean): OnboardingState {
  setSetting(KEY, { completedAt: now(), skipped } satisfies Stored);
  return onboardingState();
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 15_000): Promise<{ ok: boolean; out: string }> {
  return new Promise(res => {
    execFile(cmd, args, { timeout, windowsHide: true, env: childEnv(cmd, env) }, (err, stdout, stderr) =>
      res({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }));
  });
}

/**
 * The daemon runs detached and keeps the PATH it started with, so a CLI installed afterwards is not found.
 * On Windows, add the PATH entries now stored in the registry (machine and user) to our own.
 */
async function refreshPath(): Promise<void> {
  if (process.platform !== 'win32') return;
  const ps = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], process.env, 10_000);
  if (!r.ok) return;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(process.env.PATH ?? '').split(';'), ...r.out.split(';')]) {
    const t = p.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  process.env.PATH = out.join(';');
}

const versionOf = (s: string) => s.match(/\d+\.\d+(\.\d+)?[\w.-]*/)?.[0] ?? null;

async function checkGit(): Promise<ToolStatus> {
  const r = await run('git', ['--version']);
  return { found: r.ok, version: r.ok ? versionOf(r.out) : null, path: null };
}

async function checkCli(name: 'claude' | 'codex'): Promise<ToolStatus> {
  let cmd: string, prefixArgs: string[];
  try { ({ cmd, prefixArgs } = resolveCli(name)); } catch { return { found: false, version: null, path: null }; }
  const r = await run(cmd, [...prefixArgs, '--version']);
  return { found: r.ok, version: r.ok ? versionOf(r.out) : null, path: prefixArgs[0] ?? cmd };
}

export async function setupChecks(): Promise<SetupChecks> {
  await refreshPath();
  const [git, claude, codex] = await Promise.all([checkGit(), checkCli('claude'), checkCli('codex')]);
  return { git, claude, codex, platform: process.platform };
}

async function codexLoggedIn(a: Account): Promise<boolean | null> {
  try {
    const { cmd, prefixArgs } = resolveCli('codex');
    const { env } = adapterFor('codex').loginCommand(a);
    const r = await run(cmd, [...prefixArgs, 'login', 'status'], { ...process.env, ...env });
    return r.ok && !/not logged in/i.test(r.out);
  } catch { return null; }
}

/** Free login check (no model call, no quota spent). Moves the account in or out of needs_login to match. */
export async function loginStatus(id: string): Promise<{ loggedIn: boolean | null; account: Account }> {
  const a = getAccount(id);
  if (!a) throw new Error('no such account');
  const loggedIn = a.provider === 'claude' ? await claudeLoggedIn(a) : a.provider === 'codex' ? await codexLoggedIn(a) : true;
  if (loggedIn && (a.state === 'needs_login' || a.state === 'unknown')) applyClassification(id, { state: 'ok', reason: 'login check', evidence: ['login status'] }, null);
  if (loggedIn === false && a.state !== 'needs_login') applyClassification(id, { state: 'needs_login', reason: 'not_logged_in', evidence: ['login status'] }, null);
  return { loggedIn, account: getAccount(id)! };
}

/** Open a terminal window that installs a CLI with npm (Windows); elsewhere return the command to run. */
export function openInstall(tool: InstallTool): { opened: boolean; command: string } {
  const command = INSTALL_COMMANDS[tool];
  if (!command) throw new Error('unknown tool');
  if (process.platform !== 'win32') return { opened: false, command };
  const script = join(mkdtempSync(join(tmpdir(), 'plexus-install-')), 'install.cmd');
  writeFileSync(script, [
    '@echo off',
    `title Plexus: install ${tool}`,
    `echo Installing with: ${command}`,
    `call ${command}`,
    'echo.',
    'echo Done. You can close this window and choose "Check again" in Plexus.',
  ].join('\r\n') + '\r\n');
  spawn('cmd.exe', ['/c', 'start', `"Plexus install ${tool}"`, 'cmd', '/k', `call "${script}"`], {
    env: childEnv('cmd.exe', process.env), detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
  }).unref();
  return { opened: true, command };
}
