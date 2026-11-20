// A run log is one or more turns, each written as
//   # prompt[ (resuming <id>)] (<time>)
//   <the prompt sent to the CLI>
//
//   # output
//   <the CLI's stream>
// (a failed resume is followed by a fresh turn in the same run). The chat logs of the coordinator use the same layout.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export interface LogTurn {
  /** CLI conversation this turn continued, when it was a resume. */
  resuming: string | null;
  at: string | null;
  prompt: string;
  output: string;
}

const HEADER = /^# prompt(?: \(resuming ([^)\s]+)\))?(?: \(([^)]*)\))?\n/gm;

/** Read at most `max` bytes from the start of a file (prompts are at the head of each turn; huge logs are cut, not loaded). */
function readHead(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

export function parseLogTurns(text: string): LogTurn[] {
  const heads = [...text.matchAll(HEADER)];
  if (!heads.length) return text.trim() ? [{ resuming: null, at: null, prompt: '', output: text }] : [];
  return heads.map((h, i) => {
    const start = h.index! + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    const body = text.slice(start, end);
    const cut = body.indexOf('\n# output\n');
    return {
      resuming: h[1] ?? null, at: h[2] ?? null,
      prompt: (cut < 0 ? body : body.slice(0, cut)).replace(/\n+$/, ''),
      output: cut < 0 ? '' : body.slice(cut + '\n# output\n'.length),
    };
  });
}

export function readLogTurns(path: string, maxBytes = 16 * 1024 * 1024): LogTurn[] {
  if (!path || !existsSync(path)) return [];
  return parseLogTurns(readHead(path, maxBytes));
}

/** What the turn asked the agent beyond its task: the messages delivered with it (from the coordinator or the user). */
export function turnMessages(prompt: string): string[] {
  const m = prompt.match(/## Messages for you[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
  return m ? m[1].split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean) : [];
}
