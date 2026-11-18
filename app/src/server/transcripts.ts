// Reads Claude Code's own session transcripts (~/.claude/projects/<dir>/<id>.jsonl),
// the same files `claude --resume` lists.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionSummary } from '../shared/protocol.js';

/** Claude Code names a project's folder after its path with every non-alphanumeric character as "-". */
export function projectDirName(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function projectsRoot(env: NodeJS.ProcessEnv = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

export type TranscriptEntry = Record<string, unknown> & { type?: string; uuid?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown } };

export async function readTranscript(file: string, limit = Infinity): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  const rl = createInterface({ input: createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // Skip a partly written line.
    }
    if (out.length >= limit) {
      rl.close();
      break;
    }
  }
  return out;
}

export function firstPromptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b: { type?: string }) => b?.type === 'text') as { text?: string } | undefined;
    return t?.text ?? '';
  }
  return '';
}

export function summarize(entries: TranscriptEntry[]): { title: string; gitBranch?: string } {
  let title = '';
  let gitBranch: string | undefined;
  for (const e of entries) {
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') return { title: e.customTitle, gitBranch };
    if (e.type === 'summary' && typeof e.summary === 'string' && !title) title = e.summary;
    if (!gitBranch && typeof e.gitBranch === 'string') gitBranch = e.gitBranch;
    if (!title && e.type === 'user' && !e.isSidechain) {
      const t = firstPromptText(e.message?.content).trim();
      if (t && !t.startsWith('<')) title = t.slice(0, 80);
    }
  }
  return { title: title || 'Untitled session', gitBranch };
}

export async function listSessions(cwd: string, limit = 50): Promise<SessionSummary[]> {
  const dir = join(projectsRoot(), projectDirName(cwd));
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
  const withTimes = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })));
  withTimes.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const { f, mtime } of withTimes.slice(0, limit)) {
    const entries = await readTranscript(join(dir, f), 200);
    out.push({ sessionId: f.replace(/\.jsonl$/, ''), lastModified: mtime, ...summarize(entries) });
  }
  return out;
}

export async function sessionEntries(cwd: string, sessionId: string): Promise<TranscriptEntry[]> {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) throw new Error('Bad session id');
  return readTranscript(join(projectsRoot(), projectDirName(cwd), `${sessionId}.jsonl`));
}
