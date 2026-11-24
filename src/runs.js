import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pad = n => String(n).padStart(2, '0');

function timestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Writes one completed run as <timestamp>_<board_id>.md with owner-only
// permissions because briefs often carry private specs or source code.
export function saveRun(dir, boardId, markdown, brief) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeId = boardId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'board';
  const base = `${timestamp()}_${safeId}`;
  const body = `${markdown}\n## Brief\n\n${brief}\n`;
  for (let n = 1; n <= 1000; n++) {
    const path = join(dir, n === 1 ? `${base}.md` : `${base}_${n}.md`);
    try {
      writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('too many runs saved in the same second.');
}
