import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLED_DIR = fileURLToPath(new URL('../boards/', import.meta.url));
const MAX_BOARD_BYTES = 1_048_576;

const singleLine = s => s.replace(/[\r\n]+/g, ' ').trim();

// A board is only usable if it has an id, a name, valid optional metadata and
// exactly three roles that each carry a title and a focus.
function isUsableBoard(b) {
  return b && typeof b === 'object'
    && typeof b.id === 'string' && b.id.trim() !== ''
    && typeof b.name === 'string' && b.name.trim() !== ''
    && (b.description === undefined || typeof b.description === 'string')
    && (b.category === undefined || typeof b.category === 'string')
    && (b.tags === undefined || (Array.isArray(b.tags) && b.tags.every(t => typeof t === 'string')))
    && Array.isArray(b.roles) && b.roles.length === 3
    && b.roles.every(r => r && typeof r.title === 'string' && r.title.trim() !== '' && typeof r.focus === 'string');
}

function normalize(board, category) {
  return {
    id: singleLine(board.id),
    name: singleLine(board.name),
    category: singleLine(category || 'custom') || 'custom',
    description: board.description ? singleLine(board.description) : '',
    tags: board.tags || [],
    roles: board.roles.map((r, id) => ({ id, title: singleLine(r.title), focus: r.focus }))
  };
}

function loadBundled(catalog) {
  const files = readdirSync(BUNDLED_DIR).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(BUNDLED_DIR, file), 'utf8'));
    for (const board of data.boards) {
      if (!isUsableBoard(board)) throw new Error(`bad board in ${file}: ${board?.id}`);
      if (catalog.has(board.id)) throw new Error(`duplicate board id: ${board.id}`);
      catalog.set(board.id, normalize(board, data.category));
    }
  }
}

// Custom files may be a category file like the bundled ones, or a single board
// exported from the beitdin web app. A custom board replaces a bundled board
// with the same id. Bad input is reported and skipped per file, never fatal:
// one broken personal file should not take the whole server down.
function loadCustom(catalog, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`beitdin: could not read custom boards from ${dir}: ${e.message}`);
    return;
  }
  const files = entries.filter(d => d.isFile() && d.name.endsWith('.json')).map(d => d.name).sort();
  for (const file of files) {
    let data;
    try {
      const fullPath = join(dir, file);
      if (lstatSync(fullPath).size > MAX_BOARD_BYTES) throw new Error('file exceeds 1 MiB limit');
      data = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (e) {
      console.error(`beitdin: skipped unreadable board file ${file}: ${e.message}`);
      continue;
    }
    if (!data || typeof data !== 'object') {
      console.error(`beitdin: skipped invalid board in ${file}`);
      continue;
    }
    const boards = Array.isArray(data.boards) ? data.boards : [data];
    const fallbackCategory = typeof data.category === 'string' ? data.category : 'custom';
    for (const board of boards) {
      if (isUsableBoard(board)) {
        const normalized = normalize(board, board.category || fallbackCategory);
        catalog.set(normalized.id, normalized);
        catalog.customFiles.set(normalized.id, file);
      } else {
        console.error(`beitdin: skipped invalid board in ${file}`);
      }
    }
  }
}

export function loadCatalog(customDir) {
  const catalog = new Map();
  // Which custom file each custom board came from, so save_board knows what it
  // would replace.
  catalog.customFiles = new Map();
  loadBundled(catalog);
  if (customDir) loadCustom(catalog, customDir);
  return catalog;
}

// Writes one board as <id>.json in the custom folder and adds it to the
// running catalog. The bundled boards/ folder is never written to. Existing
// boards or files are only replaced with overwrite, and a custom board that
// lives in a shared file (for example a category file) is never replaced,
// because writing a second file with the same id would leave which one wins to
// file order.
export function saveBoard(catalog, dir, board, { overwrite = false } = {}) {
  if (!dir) throw new Error('Saving needs a custom boards folder. Set BEITDIN_BOARDS_DIR in the server environment.');
  const file = `${board.id}.json`;
  const existingFile = catalog.customFiles.get(board.id);
  if (existingFile && existingFile !== file) {
    throw new Error(`Board "${board.id}" is defined in ${existingFile}, which may hold other boards. Edit that file directly or choose another id.`);
  }
  for (const [otherId, otherFile] of catalog.customFiles) {
    if (otherFile === file && otherId !== board.id) {
      throw new Error(`File ${file} defines board "${otherId}". Edit that file directly or choose another id.`);
    }
  }
  if (catalog.has(board.id) && !overwrite) {
    const kind = existingFile ? 'a saved board' : 'a bundled board';
    throw new Error(`Board "${board.id}" already exists as ${kind}. Choose another id, or set overwrite to replace it.`);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Refusing to overwrite non-regular file ${file}.`);
    if (!overwrite) {
      throw new Error(`File ${file} already exists in the custom boards folder. Choose another id, or set overwrite to replace it.`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const normalized = normalize(board, board.category);
  catalog.set(normalized.id, normalized);
  catalog.customFiles.set(normalized.id, file);
  return { board: normalized, path };
}

// Every query word must appear somewhere on the board.
export function searchBoards(catalog, { category, query } = {}) {
  const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...catalog.values()].filter(b => {
    if (category && b.category !== category) return false;
    const text = [b.id, b.name, b.category, b.description, ...b.tags, ...b.roles.map(r => r.title)]
      .join(' ').toLowerCase();
    return terms.every(t => text.includes(t));
  });
}
