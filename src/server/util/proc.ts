import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appConfig } from '../config.ts';

export interface ResolvedCommand { cmd: string; prefixArgs: string[] }

const cache = new Map<string, ResolvedCommand>();

/**
 * Resolve a CLI to something spawnable without a shell (no cmd.exe length limits / quoting issues).
 * npm on Windows installs .cmd shims; we look behind them for the real exe / JS entry.
 */
export function resolveCli(name: 'claude' | 'codex'): ResolvedCommand {
  // Settings → Advanced first, then the environment variable, then the PATH. The cache is per override value.
  const override = (name === 'claude' ? appConfig().claudeBin : appConfig().codexBin) || process.env[`PLEXUS_${name.toUpperCase()}_BIN`] || '';
  const hit = cache.get(`${name}|${override}`);
  if (hit) return hit;
  let out: ResolvedCommand | null = override ? { cmd: override, prefixArgs: [] } : null;
  if (!out) {
    const found = which(name);
    for (const shim of found) {
      const dir = dirname(shim);
      if (name === 'claude') {
        const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (existsSync(exe)) { out = { cmd: exe, prefixArgs: [] }; break; }
      } else {
        const js = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (existsSync(js)) { out = { cmd: nodeBinary(), prefixArgs: [js] }; break; }
      }
      if (!/\.(cmd|bat|ps1)$/i.test(shim) && existsSync(shim)) { out = { cmd: shim, prefixArgs: [] }; break; }
    }
  }
  if (!out) throw new Error(`${name} CLI not found on PATH (set PLEXUS_${name.toUpperCase()}_BIN)`);
  cache.set(`${name}|${override}`, out);
  return out;
}

/**
 * Node to run JS CLIs with. Normally our own process. Under the desktop app our process is Electron in Node
 * mode; prefer a real `node` from PATH so the CLI (and every command it runs) does not need ELECTRON_RUN_AS_NODE.
 */
function nodeBinary(): string {
  if (!process.versions.electron) return process.execPath;
  const real = which('node').find(p => !/\.(cmd|bat|ps1)$/i.test(p) && existsSync(p));
  return real ?? process.execPath;
}

function which(name: string): string[] {
  const r = process.platform === 'win32'
    ? spawnSync('where', [name], { encoding: 'utf8' })
    : spawnSync('which', ['-a', name], { encoding: 'utf8' });
  return (r.stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

export interface StreamRunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  logPath?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  /** Checked after every stdout line (and its onLine): returning true stops the run with killedReason `budget`. */
  stopWhen?: () => boolean;
}

export interface StreamRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killedReason: 'timeout' | 'idle' | 'aborted' | 'budget' | null;
}

/**
 * In the desktop app the daemon runs on Electron's Node (ELECTRON_RUN_AS_NODE=1). Only children started with
 * that same binary (process.execPath, e.g. codex.js) need the flag; anything else an agent runs that is built
 * on Electron (VS Code's `code`, …) must not inherit it.
 */
export function childEnv(cmd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.ELECTRON_RUN_AS_NODE || cmd === process.execPath) return env;
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env;
  return rest;
}

/** Spawn a process, feed stdin, stream stdout line by line, enforce wall/idle timeouts and abort. */
export function runStreaming(o: StreamRunOptions): Promise<StreamRunResult> {
  return new Promise(resolve => {
    const child = spawn(o.cmd, o.args, {
      cwd: o.cwd, env: childEnv(o.cmd, o.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const log = o.logPath ? createWriteStream(o.logPath, { flags: 'a' }) : null;
    let stdout = '', stderr = '', partial = '', killedReason: StreamRunResult['killedReason'] = null;
    let lastActivity = Date.now();

    const kill = (why: NonNullable<StreamRunResult['killedReason']>) => { if (!killedReason) { killedReason = why; killTree(child); } };
    const wall = o.timeoutMs ? setTimeout(() => kill('timeout'), o.timeoutMs) : null;
    const idle = o.idleTimeoutMs ? setInterval(() => { if (Date.now() - lastActivity > o.idleTimeoutMs!) kill('idle'); }, 5000) : null;
    const onAbort = () => kill('aborted');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();

    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      lastActivity = Date.now();
      stdout += d; log?.write(d);
      partial += d;
      let i: number;
      while ((i = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, i).replace(/\r$/, '');
        partial = partial.slice(i + 1);
        if (line.trim()) try { o.onLine?.(line); } catch { /* listener errors must not kill the run */ }
        if (o.stopWhen?.()) kill('budget');
      }
    });
    child.stderr!.on('data', (d: string) => { lastActivity = Date.now(); stderr += d; log?.write(`[stderr] ${d}`); });
    // A process that cannot start (missing CLI, missing working folder) prints nothing: say why in the log too.
    child.on('error', err => {
      const why = (err as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(o.cwd) ? `working folder not found: ${o.cwd}` : err.message;
      stderr += `\n[spawn error] ${why}`;
      log?.write(`[spawn error] ${why}\n`);
    });
    child.on('close', code => {
      if (partial.trim()) try { o.onLine?.(partial); } catch { /* ignore */ }
      if (wall) clearTimeout(wall);
      if (idle) clearInterval(idle);
      o.signal?.removeEventListener('abort', onAbort);
      log?.end();
      resolve({ exitCode: code ?? (killedReason ? 137 : 1), stdout, stderr, killedReason });
    });
    // The child may exit (or be killed) before reading stdin: ignore EPIPE instead of crashing the daemon.
    child.stdin!.on('error', err => { stderr += `\n[stdin] ${err.message}`; });
    if (o.stdin !== undefined) child.stdin!.end(o.stdin);
    else child.stdin!.end();
  });
}
