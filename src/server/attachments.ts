import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { paths } from './paths.ts';
import { getDb } from './db.ts';

/**
 * A file the user attached to a chat message. Any type is accepted; `kind: 'image'` only when the content really is a
 * PNG / JPEG / GIF / WebP small enough to hand to the CLIs as an image (Codex `-i`). Files live outside the project
 * folder (~/.plexus/attachments), one directory per attachment, keeping the original (cleaned) file name.
 */
export interface AttachmentRef { id: string; name: string; mime: string; size?: number; kind: 'image' | 'file'; path: string }

export const MAX_ATTACHMENTS = 20;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const META = '.meta.json';

const root = () => join(paths.home, 'attachments');
export const sessionAttachments = (id: string) => join(root(), 'sessions', id);
export const taskAttachments = (id: string) => join(root(), 'tasks', id);

const ID = /^[0-9a-f-]{36}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A file name safe on every OS: no directories, no reserved characters, at most 200 characters. */
export function safeFileName(name: unknown): string {
  let n = basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (n.length > 200) { const dot = n.lastIndexOf('.'); const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : ''; n = n.slice(0, 200 - ext.length) + ext; }
  if (!n) n = 'file';
  return RESERVED.test(n) ? `_${n}` : n;
}

/** The image type the content really has (magic bytes), whatever the client claimed. */
export function sniffImage(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function head(path: string, n = 16): Buffer {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); const len = readSync(fd, b, 0, n, 0); return b.subarray(0, len); } finally { closeSync(fd); }
}

const cleanMime = (m: unknown) => typeof m === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m) && m.length <= 100 ? m.toLowerCase() : 'application/octet-stream';

/**
 * Store one upload for a chat session (streamed to disk, at most MAX_FILE_BYTES). It is not part of any message yet:
 * the message names it by id when it is sent.
 */
export async function saveUpload(sessionId: string, input: { name: unknown; mime?: unknown; stream: Readable }): Promise<AttachmentRef> {
  const id = randomUUID();
  const name = safeFileName(input.name);
  const dir = join(sessionAttachments(sessionId), id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) done(new Error(`file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB`));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(input.stream, limit, createWriteStream(path));
    if (!size) throw new Error('empty file');
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  const image = size <= MAX_IMAGE_BYTES ? sniffImage(head(path)) : null;
  const ref: AttachmentRef = { id, name, mime: image ?? cleanMime(input.mime), size, kind: image ? 'image' : 'file', path };
  writeFileSync(join(dir, META), JSON.stringify(ref));
  return ref;
}

/** An upload of this session that is not yet in a message (or is): read from its directory. */
function uploadRef(sessionId: string, id: string): AttachmentRef | null {
  if (!ID.test(id)) return null;
  const meta = join(sessionAttachments(sessionId), id, META);
  if (!existsSync(meta)) return null;
  try { const ref = JSON.parse(readFileSync(meta, 'utf8')) as AttachmentRef; return existsSync(ref.path) ? ref : null; } catch { return null; }
}

/** The uploads a message being sent names, in order. */
export function resolveUploads(sessionId: string, ids: unknown): AttachmentRef[] {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw new Error(`up to ${MAX_ATTACHMENTS} files are allowed`);
  const seen = new Set<string>();
  return ids.map(x => {
    const id = String(x);
    if (seen.has(id)) throw new Error(`file ${id} attached twice`);
    seen.add(id);
    const ref = uploadRef(sessionId, id);
    if (!ref) throw new Error(`unknown file ${id}`);
    return ref;
  });
}

/** Remove an upload the user took back before sending. One that a message already holds stays. */
export function deleteUpload(sessionId: string, id: string): boolean {
  if (!ID.test(id) || sessionRefs(sessionId).some(x => x.id === id)) return false;
  const dir = join(sessionAttachments(sessionId), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Attachments of a message's meta: `attachments`, or `images` in messages from before files. */
export function messageAttachments(meta: any): AttachmentRef[] {
  const list = (meta?.attachments ?? meta?.images ?? []) as any[];
  return Array.isArray(list) ? list.map(x => ({ ...x, kind: x.kind ?? 'image' })) : [];
}

export function sessionRefs(sessionId: string): AttachmentRef[] {
  const rows = getDb().prepare("SELECT meta FROM messages WHERE session_id = ? AND author = 'user' AND meta IS NOT NULL").all(sessionId) as { meta: string }[];
  return rows.flatMap(r => { try { return messageAttachments(JSON.parse(r.meta)); } catch { return []; } });
}

function selected(sessionId: string | null | undefined, ids: string[] | undefined): AttachmentRef[] {
  if (!ids?.length) return [];
  if (!sessionId) throw new Error('attachments require a chat session');
  const refs = sessionRefs(sessionId);
  return [...new Set(ids)].map(id => {
    const ref = refs.find(x => x.id === id);
    if (!ref || !existsSync(ref.path)) throw new Error(`unknown attachment ${id}`);
    return ref;
  });
}

export function validateTaskAttachments(sessionId: string | null | undefined, ids: string[] | undefined): void { selected(sessionId, ids); }

/** Copy chat attachments into the task's own directory (it outlives the chat); returns the copies. */
export function copyTaskAttachments(sessionId: string | null | undefined, ids: string[] | undefined, taskId: string): AttachmentRef[] {
  return selected(sessionId, ids).map(ref => {
    const dir = join(taskAttachments(taskId), ref.id);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, safeFileName(ref.name));
    copyFileSync(ref.path, dest);
    const copy: AttachmentRef = { ...ref, path: dest };
    writeFileSync(join(dir, META), JSON.stringify(copy));
    return copy;
  });
}

/** Every file attached to a task (also the flat `<id>.<ext>` images of tasks made before files). */
export function taskAttachmentRefs(taskId: string): AttachmentRef[] {
  const dir = taskAttachments(taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((entry): AttachmentRef[] => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      try { const ref = JSON.parse(readFileSync(join(p, META), 'utf8')) as AttachmentRef; return existsSync(ref.path) ? [ref] : []; } catch { return []; }
    }
    const mime = sniffImage(head(p));
    return [{ id: entry.replace(/\.[^.]+$/, ''), name: entry, mime: mime ?? 'application/octet-stream', kind: mime ? 'image' : 'file', path: p }];
  });
}

/** The line(s) that tell an agent where a message's attachments are. */
export function attachmentNote(refs: AttachmentRef[]): string {
  return refs.length ? `Attached files:\n${refs.map(r => `- ${r.path}${r.kind === 'image' ? ' (image)' : ''}`).join('\n')}` : '';
}

/** The RunSpec fields for a set of attachments. */
export const runFiles = (refs: AttachmentRef[]) => ({ images: refs.filter(r => r.kind === 'image').map(r => r.path), files: refs.filter(r => r.kind !== 'image').map(r => r.path) });

export function deleteSessionAttachments(id: string): void { rmSync(sessionAttachments(id), { recursive: true, force: true }); }
export function deleteTaskAttachments(id: string): void { rmSync(taskAttachments(id), { recursive: true, force: true }); }
