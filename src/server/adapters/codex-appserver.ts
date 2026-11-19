// Minimal JSON-RPC client for `codex app-server` (stdio). Verified on Codex CLI 0.157:
// initialize → initialized → account/rateLimits/read, push notification account/rateLimits/updated.
import { spawn, type ChildProcess } from 'node:child_process';
import type { QuotaSnapshot, QuotaWindow } from '../../shared/types.ts';
import { childEnv, killTree, resolveCli } from '../util/proc.ts';

export interface CodexRateLimits { quota: QuotaSnapshot | null; reached: string | null; error?: string; needsLogin?: boolean }

export function codexQuotaFrom(rl: any, source: QuotaSnapshot['source']): QuotaSnapshot | null {
  if (!rl) return null;
  const win = (w: any): QuotaWindow | null => w ? {
    usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null,
    windowMins: w.windowDurationMins ?? null,
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
  } : null;
  return { primary: win(rl.primary), secondary: win(rl.secondary), plan: rl.planType ?? null, source, at: new Date().toISOString() };
}

export class CodexAppServer {
  private proc: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, (m: any) => void>();
  private buf = '';
  private ready: Promise<void>;
  onRateLimits?: (r: CodexRateLimits) => void;
  closed = false;

  constructor(home: string) {
    const { cmd, prefixArgs } = resolveCli('codex');
    this.proc = spawn(cmd, [...prefixArgs, 'app-server'], {
      env: childEnv(cmd, { ...process.env, CODEX_HOME: home }), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    this.proc.stdin!.on('error', () => { this.closed = true; });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (d: string) => this.onData(d));
    this.proc.on('close', () => { this.closed = true; for (const r of this.pending.values()) r({ error: { message: 'app-server exited' } }); this.pending.clear(); });
    this.proc.on('error', () => { this.closed = true; });
    this.ready = this.request('initialize', { clientInfo: { name: 'multiagent-swarm', version: '0.1.0' } }).then(m => {
      if (m.error) throw new Error(m.error.message);
      this.proc.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      else if (m.method === 'account/rateLimits/updated') {
        const rl = m.params?.rateLimits ?? m.params;
        this.onRateLimits?.({ quota: codexQuotaFrom(rl, 'app-server'), reached: rl?.rateLimitReachedType ?? null });
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
    if (this.closed) return Promise.resolve({ error: { message: 'app-server closed' } });
    const id = ++this.nextId;
    return new Promise(resolve => {
      const t = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `timeout ${method}` } }); }, timeoutMs);
      this.pending.set(id, m => { clearTimeout(t); resolve(m); });
      this.proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async readRateLimits(): Promise<CodexRateLimits> {
    try { await this.ready; } catch (e: any) { return { quota: null, reached: null, error: e.message }; }
    const m = await this.request('account/rateLimits/read', { excludeResetCreditDetails: true });
    if (m.error) return { quota: null, reached: null, error: m.error.message, needsLogin: /auth/i.test(m.error.message ?? '') };
    const rl = m.result?.rateLimits;
    return { quota: codexQuotaFrom(rl, 'app-server'), reached: rl?.rateLimitReachedType ?? null };
  }

  close() { this.closed = true; killTree(this.proc); }
}

/** One-shot read (spawns and closes an app-server). */
export async function readCodexRateLimitsOnce(home: string): Promise<CodexRateLimits> {
  const c = new CodexAppServer(home);
  try { return await c.readRateLimits(); } finally { c.close(); }
}
