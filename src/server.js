import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { saveBoard, searchBoards } from './boards.js';
import { resolveLanes } from './config.js';
import { runBoard } from './orchestrator.js';
import { saveRun } from './runs.js';

const HEARTBEAT_MS = 15000;

// The id doubles as the file name, so it is limited to safe characters.
const BOARD_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const roleSchema = z.object({
  title: z.string().trim().min(1).max(200).describe('Role name, for example security_expert.'),
  focus: z.string().trim().min(1).max(20000).describe("The role's system prompt: what it focuses on and what it leaves to the others.")
});

const rolesSchema = z.array(roleSchema).length(3).describe(
  'Exactly three roles, each with a name (title) and a system prompt (focus). The server sends "You are the <title>. <focus>" followed by an instruction to answer in Markdown without a preamble, so do not repeat that in focus. Give the roles clearly different focuses.'
);

const text = (body, isError = false) => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {})
});

function formatBoardList(boards) {
  const byCategory = Map.groupBy(boards, b => b.category);
  const sections = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => {
      const lines = list.map(b => `- ${b.id}: ${b.description} [${b.roles.map(r => r.title).join(', ')}]`);
      return `## ${category}\n${lines.join('\n')}`;
    });
  return `${boards.length} boards\n\n${sections.join('\n\n')}`;
}

function formatProviders(config) {
  const lines = Object.values(config.providers).map(p => {
    const state = p.apiKey ? 'ready' : p.keyOptional ? 'no key set, may still work' : `not configured, set ${p.keyEnv.join(' or ')}`;
    return `- ${p.name}: ${state}`;
  });
  const defaults = config.defaultModels.length ? config.defaultModels.join(', ') : 'none set';
  return `Default models: ${defaults}\n\nProviders:\n${lines.join('\n')}`;
}

// Long runs can outlast a client's request timeout. Clients that send a progress
// token get a notification per finished lane and a periodic heartbeat. The value
// is a counter because MCP requires progress to increase on every notification.
function progressReporter(extra) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return { send() {}, async stop() {} };
  let tick = 0;
  let status = 'running';
  let lastSent = Promise.resolve();
  const send = message => {
    if (message) status = message;
    lastSent = extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: ++tick, message: status }
    }).catch(() => {});
  };
  const timer = setInterval(() => send(), HEARTBEAT_MS);
  timer.unref();
  // Clients discard progress that arrives after the result, so the final
  // notification has to be written before the tool returns.
  return { send, stop: () => { clearInterval(timer); return lastSent; } };
}

function withSavedPath(markdown, savedPath) {
  if (!savedPath) return markdown;
  return markdown.replace('\n\n---\n\n', `\n**Saved:** ${savedPath}\n\n---\n\n`);
}

export function createServer({ config, catalog }) {
  let activeRuns = 0;

  const server = new McpServer(
    { name: 'beitdin', version: '0.1.0' },
    {
      instructions: 'Runs a brief past a board of three expert roles, each answering independently through a direct model API call. Find a board with list_boards, then call run_board with its id and a complete, self-contained brief. The roles see only the brief, not this conversation or any files.'
    }
  );

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'Browse the catalog of three-role expert boards. Filter by category or by search words. Returns each board id, when to use it, and its roles.',
    inputSchema: {
      category: z.string().max(200).optional().describe('Exact category name, for example engineering.'),
      query: z.string().max(500).optional().describe('Words that must all appear on the board, for example "system security".')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async args => {
    const boards = searchBoards(catalog, args);
    if (boards.length === 0) return text('No boards matched. Call list_boards with no filters to see the whole catalog.');
    return text(formatBoardList(boards));
  });

  server.registerTool('get_board', {
    title: 'Get board',
    description: 'Show a board in full, including the exact focus prompt of each of its three roles.',
    inputSchema: { board_id: z.string().max(200).describe('Board id from list_boards.') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ board_id }) => {
    const board = catalog.get(board_id);
    if (!board) return text(`Unknown board "${board_id}". Call list_boards to find a valid id.`, true);
    return text(JSON.stringify(board, null, 2));
  });

  server.registerTool('list_providers', {
    title: 'List providers',
    description: 'Show the default models and which model providers this server can call. Never returns API keys.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => text(formatProviders(config)));

  server.registerTool('run_board', {
    title: 'Run board',
    description: 'Send one brief to the three roles of a board at once and return their combined answers as Markdown. Give either board_id for a catalog board or roles for a one-off board that is not saved. Each role makes one paid model API call and may take minutes. The roles see only the brief, so include all the context they need.',
    inputSchema: {
      board_id: z.string().max(200).optional().describe('Board id from list_boards. Give this or roles, not both.'),
      roles: rolesSchema.optional(),
      brief: z.string().trim().min(1).max(500000).describe('The complete, self-contained brief.'),
      models: z.array(z.string().max(250)).min(1).max(3).optional().describe(`provider:model values. Give one to use it for all roles or three for one per role. Default: ${config.defaultModels.join(', ') || 'none configured, so this is required'}.`)
    },
    // Not marked read-only: clients may auto-approve read-only tools, and every
    // call here spends money on the operator's API keys.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ board_id, roles, brief, models }, extra) => {
    if ((board_id === undefined) === (roles === undefined)) {
      return text('Give either board_id or roles, not both and not neither.', true);
    }
    const board = roles
      ? { id: 'one_off', name: 'one-off board', roles: roles.map((r, id) => ({ id, ...r })) }
      : catalog.get(board_id);
    if (!board) return text(`Unknown board "${board_id}". Call list_boards to find a valid id.`, true);

    let slots;
    try {
      slots = resolveLanes(models, config);
    } catch (e) {
      return text(e.message, true);
    }

    if (activeRuns >= config.maxConcurrentRuns) {
      return text(`Too many board runs in flight (limit: ${config.maxConcurrentRuns}). Wait for active runs to finish.`, true);
    }

    activeRuns++;
    const progress = progressReporter(extra);
    progress.send(`0/3 lanes done on ${board.name}`);
    try {
      const { markdown, allFailed } = await runBoard(board, brief, slots, {
        signal: extra.signal,
        timeoutMs: config.timeoutMs,
        onLaneDone: (done, role) => progress.send(`${done}/3 lanes done, last: ${role}`)
      });
      let savedPath = '';
      if (config.runsDir && !allFailed) {
        try {
          savedPath = saveRun(config.runsDir, board.id, markdown, brief);
        } catch (e) {
          console.error(`beitdin: could not save run to ${config.runsDir}: ${e.message}`);
        }
      }
      return text(withSavedPath(markdown, savedPath), allFailed);
    } finally {
      activeRuns--;
      await progress.stop();
    }
  });

  server.registerTool('save_board', {
    title: 'Save board',
    description: `Save a new three-role board to the catalog so it can be found with list_boards and run by id, now and in later sessions. It is written as a JSON file in the server's custom boards folder${config.boardsDir ? '' : ', which is not configured on this server, so saving will fail until BEITDIN_BOARDS_DIR is set'}. Existing boards are only replaced with overwrite. Write description and tags so that other agents can tell when to use the board.`,
    inputSchema: {
      board_id: z.string().regex(BOARD_ID).describe('New id: lowercase letters, digits, _ and -, for example api_review.'),
      name: z.string().trim().min(1).max(200).optional().describe('Display name. Defaults to the id.'),
      description: z.string().trim().min(1).max(1000).describe('One sentence on when to use this board.'),
      tags: z.array(z.string().trim().min(1).max(50)).min(1).max(20).describe('Search words, for example ["api", "review"].'),
      category: z.string().regex(BOARD_ID).optional().describe('Category name. Defaults to custom.'),
      roles: rolesSchema,
      overwrite: z.boolean().optional().describe('Replace an existing board with this id. Off by default.')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ board_id, name, description, tags, category, roles, overwrite }) => {
    const board = { id: board_id, name: name || board_id, category: category || 'custom', description, tags, roles };
    try {
      const { path } = saveBoard(catalog, config.boardsDir, board, { overwrite });
      return text(`Saved board "${board_id}" to ${path}. Run it with run_board and board_id "${board_id}".`);
    } catch (e) {
      return text(e.message, true);
    }
  });

  return server;
}
