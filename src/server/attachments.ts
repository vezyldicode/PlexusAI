import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { paths } from './paths.ts';
import { getDb } from './db.ts';

export interface ImageRef { id: string; name: string; mime: string; path: string }
const types: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const root = () => join(paths.home, 'attachments');
export const sessionImages = (id: string) => join(root(), 'sessions', id);
export const taskImages = (id: string) => join(root(), 'tasks', id);

export function saveImages(sessionId: string, input: unknown): ImageRef[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 5) throw new Error('up to 5 images are allowed');
  const decoded = input.map((x: any) => {
    if (!x || typeof x.name !== 'string' || typeof x.mime !== 'string' || typeof x.dataBase64 !== 'string' || !types[x.mime]) throw new Error('invalid image');
    if (x.dataBase64.length > 14_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.dataBase64)) throw new Error('invalid image data');
    const data = Buffer.from(x.dataBase64, 'base64');
    if (!data.length || data.length > 10 * 1024 * 1024) throw new Error('image exceeds 10 MB');
    const magic = x.mime === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : x.mime === 'image/jpeg' ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : x.mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    if (!magic) throw new Error('image content does not match mime type');
    return { name: x.name.slice(0, 200), mime: x.mime, data };
  });
  if (decoded.length) mkdirSync(sessionImages(sessionId), { recursive: true });
  return decoded.map(x => {
    const id = randomUUID();
    const path = join(sessionImages(sessionId), `${id}.${types[x.mime]}`);
    writeFileSync(path, x.data);
    return { id, name: x.name, mime: x.mime, path };
  });
}

export function sessionImageRefs(sessionId: string): ImageRef[] {
  const rows = getDb().prepare("SELECT meta FROM messages WHERE session_id = ? AND author = 'user' AND meta IS NOT NULL").all(sessionId) as { meta: string }[];
  return rows.flatMap(r => { try { return JSON.parse(r.meta)?.images ?? []; } catch { return []; } });
}

function selectedImages(sessionId: string | null | undefined, ids: string[] | undefined): ImageRef[] {
  if (!ids?.length) return [];
  if (!sessionId) throw new Error('images require a chat session');
  const refs = sessionImageRefs(sessionId);
  return ids.map(id => {
    const ref = refs.find(x => x.id === id);
    if (!ref || !existsSync(ref.path)) throw new Error(`unknown image ${id}`);
    return ref;
  });
}

export function validateTaskImages(sessionId: string | null | undefined, ids: string[] | undefined): void {
  selectedImages(sessionId, ids);
}

export function copyTaskImages(sessionId: string | null | undefined, ids: string[] | undefined, taskId: string): string[] {
  const selected = selectedImages(sessionId, ids);
  if (!selected.length) return [];
  mkdirSync(taskImages(taskId), { recursive: true });
  return selected.map(ref => {
    const dest = join(taskImages(taskId), `${ref.id}.${types[ref.mime]}`);
    copyFileSync(ref.path, dest);
    return dest;
  });
}

export function taskImagePaths(taskId: string): string[] {
  return existsSync(taskImages(taskId)) ? readdirSync(taskImages(taskId)).map(name => join(taskImages(taskId), name)) : [];
}

export function deleteSessionImages(id: string): void { rmSync(sessionImages(id), { recursive: true, force: true }); }
export function deleteTaskImages(id: string): void { rmSync(taskImages(id), { recursive: true, force: true }); }
