// The decision log is compacted by a librarian task once it grows past the project's threshold (mock agents).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome, type TestDaemon } from './helpers.ts';

const root = testHome('plexus-compact');
const { orchestrator } = await import('../src/server/orchestrator.ts');

let d: TestDaemon;
before(async () => { d = await startTestDaemon(); });
after(async () => { await d?.shutdown(); });

test('a librarian task compacts decisions.md and archives the old text', { timeout: 120_000 }, async () => {
  const { call } = d;
  const a = await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-a' });
  writeFileSync(join(a.home, 'mock.json'), JSON.stringify({ delayMs: 10, steps: 1 }));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'README.md'), '# Demo\nCreate alpha.txt and beta.txt.\n');
  const p = await call('POST', '/api/projects', { path: proj, goal: 'Create alpha.txt and beta.txt', settings: { maxParallel: 2, independentReviewWaitMin: 0, reviewEnabled: false, decisionsCompactAt: 20 } });
  await call('POST', `/api/projects/${p.id}/start`);

  const s = await d.waitFor(async () => { const s = await call('GET', `/api/projects/${p.id}`); return s.project.status === 'completed' ? s : null; }, 90_000, 'project completion');
  await orchestrator.idle();
  const compact = s.tasks.filter((t: any) => t.kind === 'compact');
  assert.ok(compact.length >= 1, 'a compact task ran');
  assert.ok(compact.every((t: any) => t.status === 'done'));
  const mem = join(proj, '.plexus', 'memory');
  assert.match(readFileSync(join(mem, 'decisions.md'), 'utf8'), /digest of Use plain text files/);
  assert.ok(existsSync(join(mem, 'decisions-archive.md')));
  assert.match(readFileSync(join(mem, 'summary.md'), 'utf8'), /Mock project/);
  // planned tasks carry the criteria the planner gave them
  assert.deepEqual(s.tasks.find((t: any) => t.title === 'Create alpha').acIds, ['AC1']);
});
