// Shared helpers for tests that start a Plexus daemon with mock agents.
// This file imports nothing from src/ at load time: a test calls testHome() first, so PLEXUS_HOME is set
// before any server module (paths, db) is loaded.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary root whose `home` folder is this process's Plexus data folder. Returns the root. */
export function testHome(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.PLEXUS_HOME = join(root, 'home');
  // Every commit/merge in a throwaway repo would otherwise start `git maintenance run --auto`.
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false' });
  return root;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll `fn` every `every` ms until it returns something truthy; on timeout throw, with `dump()` in the message. */
export async function waitFor<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number, label: string,
  dump?: () => Promise<string> | string, every = 50): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  const extra = dump ? await Promise.resolve(dump()).catch(e => `(dump failed: ${e?.message ?? e})`) : '';
  throw new Error(`timeout after ${ms}ms waiting for ${label}${extra ? `\n${extra}` : ''}`);
}

export type Call = (method: string, path: string, body?: unknown) => Promise<any>;

/** Authenticated JSON call to a daemon; throws with the response body on a non-2xx status. */
export function caller(port: number, token: string): Call {
  return async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-plexus-token': token }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
    return j;
  };
}

/** Status, phase, tasks and error events of every project: what a timed-out wait needs to say where it got stuck. */
export async function dumpProjects(call: Call): Promise<string> {
  const lines: string[] = [];
  for (const p of await call('GET', '/api/projects')) {
    const s = await call('GET', `/api/projects/${p.id}`);
    lines.push(`PROJECT ${p.id} ${s.project.status}/${s.project.phase}`);
    for (const t of s.tasks) lines.push(`  T${t.seq} ${t.kind} ${t.status} acct=${t.accountId ?? '-'} att=${t.attempts}${t.error ? ` err=${String(t.error).slice(0, 200)}` : ''}`);
    for (const ev of (await call('GET', `/api/projects/${p.id}/events`)).filter((e: any) => /error|fail/.test(e.type)).slice(-10)) {
      lines.push(`  EV ${ev.type} ${JSON.stringify(ev.data).slice(0, 300)}`);
    }
  }
  return lines.join('\n');
}

/** Scheduler pass interval for tests: the default (seconds) makes every pipeline step wait for the next pass. */
export const TEST_TICK_MS = 100;

export interface TestDaemon {
  port: number;
  token: string;
  call: Call;
  /** waitFor that dumps every project's state when it times out. */
  waitFor<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number, label: string): Promise<T>;
  shutdown(): Promise<void>;
}

/** Start a daemon on a free port (call testHome() first). */
export async function startTestDaemon(): Promise<TestDaemon> {
  const { startDaemon } = await import('../src/server/main.ts');
  const d = await startDaemon({ port: 0, quiet: true, tickMs: TEST_TICK_MS });
  const call = caller(d.port, d.token);
  return {
    port: d.port, token: d.token, call, shutdown: d.shutdown,
    waitFor: (fn, ms, label) => waitFor(fn, ms, label, () => dumpProjects(call)),
  };
}
