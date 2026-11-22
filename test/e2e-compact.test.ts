// The decision log is compacted by a librarian task once it grows past the project's threshold (mock agents).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plexus-compact-'));
process.env.PLEXUS_HOME = join(root, 'home');

const { startDaemon } = await import('../src/server/main.ts');
const { orchestrator } = await import('../src/server/orchestrator.ts');

test('a librarian task compacts decisions.md and archives the old text', { timeout: 180_000 }, async () => {
  const d = await startDaemon({ port: 0, quiet: true });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': d.token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
    return j;
  };
  try {
    const a = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a' });
    writeFileSync(join(a.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1 }));
    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'docs'), { recursive: true });
    writeFileSync(join(proj, 'docs', 'README.md'), '# Demo\nCreate alpha.txt and beta.txt.\n');
    const p = await call('POST', '/api/projects', { path: proj, goal: 'Create alpha.txt and beta.txt', settings: { maxParallel: 2, independentReviewWaitMin: 0, reviewEnabled: false, decisionsCompactAt: 20 } });
    await call('POST', `/api/projects/${p.id}/start`);

    const end = Date.now() + 150_000;
    let s: any;
    while (Date.now() < end) {
      s = await call('GET', `/api/projects/${p.id}`);
      if (s.project.status === 'completed') break;
      await new Promise(r => setTimeout(r, 300));
    }
    await orchestrator.idle();
    assert.equal(s.project.status, 'completed', JSON.stringify(s.tasks.map((t: any) => [t.seq, t.kind, t.status, t.error])));
    const compact = s.tasks.filter((t: any) => t.kind === 'compact');
    assert.ok(compact.length >= 1, 'a compact task ran');
    assert.ok(compact.every((t: any) => t.status === 'done'));
    const mem = join(proj, '.plexus', 'memory');
    assert.match(readFileSync(join(mem, 'decisions.md'), 'utf8'), /digest of Use plain text files/);
    assert.ok(existsSync(join(mem, 'decisions-archive.md')));
    assert.match(readFileSync(join(mem, 'summary.md'), 'utf8'), /Mock project/);
    // planned tasks carry the criteria the planner gave them
    assert.deepEqual(s.tasks.find((t: any) => t.title === 'Create alpha').acIds, ['AC1']);
  } finally {
    await d.shutdown();
  }
});
