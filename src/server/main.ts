import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { quotaService } from './accounts.ts';
import { buildApi } from './api.ts';
import { closeDb, getDb } from './db.ts';
import { orchestrator } from './orchestrator.ts';
import { paths } from './paths.ts';
import { seedRoles } from './roles.ts';
import { backfillRunUsage } from './usage.ts';
import { runtime } from './runtime.ts';

export function loadToken(): string {
  if (existsSync(paths.token)) return readFileSync(paths.token, 'utf8').trim();
  const t = randomBytes(24).toString('hex');
  writeFileSync(paths.token, t, { mode: 0o600 });
  return t;
}

export async function startDaemon(opts: { port?: number; host?: string; quiet?: boolean } = {}) {
  getDb();
  seedRoles();
  const token = loadToken();
  const hooks = { shutdown: async () => {} };
  const app = await buildApi(token, hooks);
  const port = opts.port ?? Number(process.env.PLEXUS_PORT ?? 4317);
  const host = opts.host ?? process.env.PLEXUS_HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  quotaService.start();
  orchestrator.start();
  // Runs recorded before token usage was stored: read it back from their logs, once.
  setImmediate(() => {
    // A stored path may predate a move of the data folder (swarm → plexus): fall back to <logs>/<project>/<file>.
    const readLog = (p: string) => {
      const here = join(paths.logs, ...p.split(/[\\/]/).slice(-2));
      const f = existsSync(p) ? p : existsSync(here) ? here : null;
      return f ? readFileSync(f, 'utf8') : null;
    };
    try { backfillRunUsage(readLog); } catch (e: any) { console.error('usage backfill failed:', e?.message ?? e); }
  });
  const addr = app.server.address();
  const realPort = typeof addr === 'object' && addr ? addr.port : port;
  runtime.port = realPort;
  runtime.token = token;
  if (!opts.quiet) {
    console.log(`plexus daemon listening on http://${host}:${realPort}`);
    console.log(`data: ${paths.home}`);
  }
  const shutdown = async () => {
    await orchestrator.stopAll();
    quotaService.stop();
    await app.close();
    closeDb();
  };
  hooks.shutdown = shutdown;
  return { app, port: realPort, token, shutdown };
}

function openBrowser(url: string) {
  return import('node:child_process').then(({ spawn }) => {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
  });
}

/** Is a Plexus daemon already answering on this port? */
async function existingDaemon(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j: any = await r.json(); return j?.app === 'plexus' || j?.ok === true; // older daemons only answer { ok: true }
  } catch { return false; }
}

if (import.meta.main) {
  const open = process.argv.includes('--open');
  const port = Number(process.env.PLEXUS_PORT ?? 4317);
  let d: Awaited<ReturnType<typeof startDaemon>>;
  try {
    d = await startDaemon({ port });
  } catch (e: any) {
    if (e?.code !== 'EADDRINUSE') throw e;
    const url = `http://127.0.0.1:${port}`;
    if (await existingDaemon(port)) {
      console.log(`Plexus is already running at ${url}.`);
      console.log('To restart it (e.g. after updating the code): npm run stop, then npm start.');
      if (open) await openBrowser(url);
      process.exit(0);
    }
    console.error(`Port ${port} is used by another program. Start Plexus on another port, e.g. in PowerShell: $env:PLEXUS_PORT=4320; npm start`);
    process.exit(1);
  }
  if (open) await openBrowser(`http://127.0.0.1:${d.port}`);
  const stop = async () => { console.log('shutting down…'); await d.shutdown(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
