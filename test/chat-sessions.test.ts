// Coordinator chat sessions: isolation, unread marks, routing of system/agent notices, and CLI conversation resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon, testHome } from './helpers.ts';

const root = testHome('plexus-chat');

const chat = await import('../src/server/chat.ts');
const { listMessages, postMessage } = await import('../src/server/projects.ts');
const { createTask } = await import('../src/server/tasks.ts');
const { taskAttachmentRefs, sessionAttachments } = await import('../src/server/attachments.ts');
const { mockAdapter } = await import('../src/server/adapters/mock.ts');

test('chat sessions: isolation, unread routing and CLI resume', { timeout: 60_000 }, async () => {
  const d = await startTestDaemon();
  const { call, waitFor } = d;
  try {
    await call('POST', '/api/accounts', { provider: 'mock', id: 'mock-c' });
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'README.md'), '# Demo\n');
    const p = await call('POST', '/api/projects', { path: proj, goal: 'demo' });

    // A project always has a conversation to talk in.
    let sessions = await call('GET', `/api/projects/${p.id}/chat-sessions`);
    assert.equal(sessions.length, 1);
    const A = sessions[0].id;
    const B = (await call('POST', `/api/projects/${p.id}/chat-sessions`, {})).id;

    const replies = async (sid: string, n: number) => waitFor(async () => {
      const ms = (await call('GET', `/api/projects/${p.id}/messages?session=${sid}`)).filter((m: any) => m.author === 'coordinator');
      return ms.length >= n ? ms : null;
    }, 30_000, `reply ${n} in ${sid}`);
    const say = (sid: string, text: string) => call('POST', `/api/projects/${p.id}/messages`, { text, sessionId: sid });

    // First turn: full prompt, a CLI conversation is remembered. The session is named after the first message.
    await say(A, 'hello there');
    const [r1] = await replies(A, 1);
    assert.match(r1.text, /\[full history\]/);
    assert.equal(r1.meta.resumed, false);
    assert.equal(r1.meta.cli, true);
    const s1 = chat.getSession(A)!;
    assert.ok(s1.cliSessionId && s1.cliAccountId === 'mock-c');
    assert.equal(s1.title, 'hello there');

    // Second turn resumes it and only carries what is new (here: a notice that arrived in between).
    chat.setControlSession(p.id, A);
    postMessage(p.id, 'system', 'Paused: for the test.');
    await say(A, 'what now');
    const r2 = (await replies(A, 2))[1];
    assert.match(r2.text, new RegExp(`\\[resumed ${s1.cliSessionId}; news: \\[system\\] Paused: for the test\\.`));
    assert.doesNotMatch(r2.text, /full history/);
    assert.equal(r2.meta.resumed, true);

    // Another session is a separate conversation: its own history, its own CLI conversation.
    await say(B, 'second chat');
    const [rb] = await replies(B, 1);
    assert.match(rb.text, /\[full history\]/);
    assert.notEqual(chat.getSession(B)!.cliSessionId, s1.cliSessionId);
    const inA = await call('GET', `/api/projects/${p.id}/messages?session=${A}`);
    const inB = await call('GET', `/api/projects/${p.id}/messages?session=${B}`);
    assert.ok(inA.every((m: any) => m.sessionId === A) && inB.every((m: any) => m.sessionId === B));
    assert.ok(!inB.some((m: any) => /hello there|what now/.test(m.text)));

    // Files are uploaded one by one (raw body, streamed to disk outside the repo) and a message names them by id.
    const upload = async (sid: string, name: string, data: Buffer, mime = 'application/octet-stream') => {
      const r = await fetch(`http://127.0.0.1:${d.port}/api/chat-sessions/${sid}/attachments?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-plexus-token': d.token }, body: new Uint8Array(data) });
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j));
      return j;
    };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64');
    const up1 = await upload(B, 'screen.png', png, 'image/png');
    assert.equal(up1.kind, 'image');
    assert.equal(up1.path, undefined); // the server's path is not handed to the browser
    const up2 = await upload(B, '../../notes v2.csv', Buffer.from('a,b\n1,2\n'), 'text/csv');
    assert.deepEqual([up2.kind, up2.name, up2.mime, up2.size], ['file', 'notes v2.csv', 'text/csv', 8]);
    // What claims to be a PNG but is not one is a plain file; an HTML page too.
    const fake = await upload(B, 'fake.png', Buffer.from('not a png'), 'image/png');
    assert.equal(fake.kind, 'file');
    const page = await upload(B, 'x.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    // An upload taken back before sending is removed.
    assert.equal((await call('DELETE', `/api/chat-sessions/${B}/attachments/${fake.id}`)).ok, true);
    await assert.rejects(upload(B, 'empty.txt', Buffer.alloc(0)), /empty file/);
    await assert.rejects(call('POST', `/api/projects/${p.id}/messages`, { text: '', sessionId: B, attachments: [fake.id] }), /unknown file/);
    await assert.rejects(call('POST', `/api/projects/${p.id}/messages`, { text: 'x', sessionId: B, attachments: Array.from({ length: 21 }, () => up1.id) }), /up to 20 files/);

    await call('POST', `/api/projects/${p.id}/messages`, { text: '', sessionId: B, attachments: [up1.id, up2.id, page.id] });
    await replies(B, 2);
    const fileMessage = (await call('GET', `/api/projects/${p.id}/messages?session=${B}`)).find((m: any) => m.author === 'user' && m.meta?.attachments?.length);
    const [image, csv, html] = fileMessage.meta.attachments;
    assert.equal(image.name, 'screen.png');
    assert.ok(existsSync(image.path) && existsSync(csv.path) && csv.path.endsWith('notes v2.csv'));
    // A message's upload cannot be deleted any more.
    assert.equal((await call('DELETE', `/api/chat-sessions/${B}/attachments/${csv.id}`)).ok, false);
    const get = (aid: string) => fetch(`http://127.0.0.1:${d.port}/api/messages/${fileMessage.id}/attachments/${aid}`, { headers: { 'x-plexus-token': d.token } });
    const served = await get(image.id);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-disposition') ?? '', /^inline/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), readFileSync(image.path));
    const servedCsv = await get(csv.id);
    assert.match(servedCsv.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''notes%20v2\.csv/);
    assert.equal(await servedCsv.text(), 'a,b\n1,2\n');
    // HTML is never served as a page (it would run on Plexus's origin).
    const servedHtml = await get(html.id);
    assert.equal(servedHtml.headers.get('content-type'), 'application/octet-stream');
    assert.match(servedHtml.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(servedHtml.headers.get('x-content-type-options'), 'nosniff');
    // The old image URL still works for messages from before.
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/api/messages/${fileMessage.id}/images/${image.id}`, { headers: { 'x-plexus-token': d.token } })).status, 200);

    // A chat task gets its own copy and the worker passes it to its adapter: images as images, others as files.
    const seen: { images?: string[]; files?: string[] }[] = [];
    const originalRun = mockAdapter.run.bind(mockAdapter);
    mockAdapter.run = async spec => { if (spec.images?.length || spec.files?.length) seen.push({ images: spec.images, files: spec.files }); return originalRun(spec); };
    const beforeTasks = (await call('GET', `/api/projects/${p.id}`)).tasks.length;
    const rejected = await call('POST', `/api/projects/${p.id}/actions`, { sessionId: B, actions: [{ type: 'solo_task', title: 'Bad file', description: '', attachments: ['missing'] }] });
    assert.match(rejected.applied[0], /unknown attachment/);
    assert.equal((await call('GET', `/api/projects/${p.id}`)).tasks.length, beforeTasks);
    // `images` (as older prompts wrote it) still works next to `attachments`.
    const applied = await call('POST', `/api/projects/${p.id}/actions`, { sessionId: B, actions: [{ type: 'solo_task', title: 'Inspect screenshot', description: 'Use screenshot', images: [image.id], attachments: [csv.id] }] });
    assert.match(applied.applied[0], /started/);
    const taskWithImage = (await call('GET', `/api/projects/${p.id}`)).tasks.find((t: any) => t.title === 'Inspect screenshot');
    const refs = taskAttachmentRefs(taskWithImage.id);
    const copied = refs.find(r => r.kind === 'image')!.path, copiedCsv = refs.find(r => r.kind === 'file')!.path;
    assert.ok(copied !== image.path && existsSync(copied) && copiedCsv.endsWith('notes v2.csv'));
    await waitFor(() => Promise.resolve(seen.length ? seen[0] : null), 30_000, 'task attachments RunSpec');
    assert.deepEqual(seen[0], { images: [copied], files: [copiedCsv] });
    mockAdapter.run = originalRun;

    // Notices raise an unread mark on the session they belong to, and only there; opening it clears the mark.
    const unread = async () => Object.fromEntries((await call('GET', `/api/projects/${p.id}/chat-sessions`)).map((s: any) => [s.id, s.unread]));
    await call('POST', `/api/chat-sessions/${A}/read`);
    await call('POST', `/api/chat-sessions/${B}/read`);
    assert.deepEqual(await unread(), { [A]: 0, [B]: 0 });
    postMessage(p.id, 'system', 'something happened'); // → control session (A)
    assert.deepEqual(await unread(), { [A]: 1, [B]: 0 });
    // A task created from chat in B reports to B (children inherit it), whoever controls the project.
    const t = createTask(p.id, { title: 'from B', role: 'implementer', kind: 'build', originSessionId: B });
    const child = createTask(p.id, { title: 'child', role: 'reviewer', kind: 'review', parentId: t.id });
    assert.equal(child.originSessionId, B);
    postMessage(p.id, 'agent', 'implementer (T1) asks: ok?', { taskId: child.id });
    assert.deepEqual(await unread(), { [A]: 1, [B]: 1 });
    await call('POST', `/api/chat-sessions/${A}/read`);
    assert.deepEqual(await unread(), { [A]: 0, [B]: 1 });
    // The user's own and the coordinator's messages never count as unread.
    await say(A, 'ping');
    await replies(A, 3);
    assert.equal((await unread())[A], 0);

    // Controls used from a session make it the destination of project-level notices.
    await call('POST', `/api/projects/${p.id}/pause`, { sessionId: B });
    assert.ok((await call('GET', `/api/projects/${p.id}/messages?session=${B}`)).some((m: any) => /^Paused/.test(m.text)));

    // The CLI lost its conversation: fall back to the chat history and remember the new one.
    chat.setCliSession(A, { sessionId: 'dead-1', accountId: 'mock-c', syncedMessageId: 0 });
    await say(A, 'still there?');
    const r4 = (await replies(A, 4))[3];
    assert.match(r4.text, /\[full history\]/);
    assert.equal(r4.meta.resumed, false);
    assert.notEqual(chat.getSession(A)!.cliSessionId, 'dead-1');
    // A conversation bound to another account is not resumed on this one.
    chat.setCliSession(A, { sessionId: 'mock-other', accountId: 'someone-else', syncedMessageId: 0 });
    await say(A, 'again');
    const r5 = (await replies(A, 5))[4];
    assert.match(r5.text, /\[full history\]/);

    // Rename / archive / delete; the last chat cannot be deleted.
    assert.equal((await call('PATCH', `/api/chat-sessions/${B}`, { title: 'Ideas' })).title, 'Ideas');
    await call('DELETE', `/api/chat-sessions/${B}`);
    assert.ok(!existsSync(sessionAttachments(B)));
    assert.ok(existsSync(copied));
    assert.ok(!(await call('GET', `/api/projects/${p.id}/messages`)).some((m: any) => m.sessionId === B));
    sessions = await call('GET', `/api/projects/${p.id}/chat-sessions`);
    assert.deepEqual(sessions.map((s: any) => s.id), [A]);
    await assert.rejects(call('DELETE', `/api/chat-sessions/${A}`), /last chat/);
    // A task whose session was deleted routes its notices to the default session again.
    assert.equal(chat.routeSession(p.id, { taskId: child.id }), A);
  } finally {
    await d.shutdown();
  }
});

test('a chat session keeps its coordinator account, model and effort until that account cannot run', { timeout: 60_000 }, async () => {
  const { getDb } = await import('../src/server/db.ts');
  const { addAccount, removeAccount, updateAccount } = await import('../src/server/accounts.ts');
  const { createProject, updateProject } = await import('../src/server/projects.ts');
  const { coordinatorTarget, applyPickerToSession, handleChat } = await import('../src/server/coordinator.ts');
  const dir = join(root, 'sticky');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Sticky\n');
  const p = createProject({ path: dir, goal: 'sticky coordinator' });
  for (const id of ['stk-a', 'stk-b']) addAccount({ provider: 'mock', id });
  const used = (id: string, pct: number) => getDb().prepare('UPDATE accounts SET state = ?, quota = ?, cooldown_until = NULL WHERE id = ?')
    .run('ok', JSON.stringify({ primary: { usedPercent: pct }, secondary: null, source: 'probe', at: new Date().toISOString() }), id);
  const setState = (id: string, state: string, cooldownUntil: string | null = null) =>
    getDb().prepare('UPDATE accounts SET state = ?, cooldown_until = ? WHERE id = ?').run(state, cooldownUntil, id);
  const reset = () => { used('stk-a', 90); used('stk-b', 10); updateAccount('stk-a', { enabled: true }); };
  const others = () => getDb().prepare("SELECT id FROM accounts WHERE id NOT IN ('stk-a', 'stk-b')").all() as { id: string }[];
  for (const o of others()) updateAccount(o.id, { enabled: false });
  try {
    reset();
    const s1 = chat.createSession(p.id), s2 = chat.createSession(p.id);
    // Without a stored choice, automatic selection spreads by quota: B.
    assert.equal(coordinatorTarget(p, chat.getSession(s1.id)).account?.id, 'stk-b');
    // A stored choice wins over quota: A stays, with its own model and effort.
    chat.setSessionCoordinator(s1.id, { accountId: 'stk-a', model: 'model-a', effort: 'high' });
    for (let turn = 0; turn < 3; turn++) {
      const t = coordinatorTarget(p, chat.getSession(s1.id));
      assert.deepEqual([t.account?.id, t.model, t.effort, t.moved], ['stk-a', 'model-a', 'high', null]);
    }
    // The project's pinned account does not take a session back from an account that can run.
    updateProject(p.id, { settings: { coordinatorAccountId: 'stk-b' } });
    assert.equal(coordinatorTarget(p, chat.getSession(s1.id)).account?.id, 'stk-a');
    updateProject(p.id, { settings: { coordinatorAccountId: null } });

    // It moves only when A cannot run: limited, cooling down, disabled, logged out.
    const breaks: [string, () => void][] = [
      ['limited', () => setState('stk-a', 'limited')],
      ['cooldown', () => setState('stk-a', 'ok', new Date(Date.now() + 3_600_000).toISOString())],
      ['disabled', () => updateAccount('stk-a', { enabled: false })],
      ['needs_login', () => setState('stk-a', 'needs_login')],
    ];
    for (const [name, breakA] of breaks) {
      reset(); breakA();
      const t = coordinatorTarget(p, chat.getSession(s1.id));
      assert.equal(t.account?.id, 'stk-b', name);
      assert.ok(t.moved && /stk-a/.test(t.moved.from), name);
    }

    // A turn on the moved session stores the new choice and says so once.
    reset(); setState('stk-a', 'limited');
    await handleChat(p.id, 'hello', s1.id);
    assert.equal(chat.getSession(s1.id)!.coordAccountId, 'stk-b');
    const notices = () => listMessages(p.id, 100, s1.id).filter((m: any) => m.author === 'system' && /this chat moves to/.test(m.text));
    assert.equal(notices().length, 1);
    // Back to normal: the session stays on B (no switch back), no new notice.
    reset();
    await handleChat(p.id, 'again', s1.id);
    assert.equal(chat.getSession(s1.id)!.coordAccountId, 'stk-b');
    assert.equal(notices().length, 1);

    // A picker change in one session is that session's choice only.
    chat.setSessionCoordinator(s2.id, { accountId: 'stk-b', model: null, effort: 'low' });
    const p2 = updateProject(p.id, { settings: { coordinatorAccountId: 'stk-a' } });
    applyPickerToSession(p2, s1.id, { coordinatorAccountId: 'stk-a' });
    assert.equal(chat.getSession(s1.id)!.coordAccountId, 'stk-a');
    assert.deepEqual([chat.getSession(s2.id)!.coordAccountId, chat.getSession(s2.id)!.coordEffort], ['stk-b', 'low']);
    // "Automatic" clears only that session's choice.
    applyPickerToSession(updateProject(p.id, { settings: { coordinatorAccountId: null } }), s1.id, { coordinatorAccountId: null });
    assert.equal(chat.getSession(s1.id)!.coordAccountId, null);
    assert.equal(chat.getSession(s2.id)!.coordAccountId, 'stk-b');
  } finally {
    for (const o of others()) updateAccount(o.id, { enabled: true });
    for (const id of ['stk-a', 'stk-b']) removeAccount(id);
  }
});
