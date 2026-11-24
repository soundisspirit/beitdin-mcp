import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMock } from './mock-provider.js';

// Drives the real server process over stdio, as an MCP client would, against
// local fake provider endpoints. No real provider is contacted.
let mock, client, customDir;
const root = fileURLToPath(new URL('..', import.meta.url));
const textOf = r => r.content[0].text;

before(async () => {
  mock = await startMock();
  customDir = mkdtempSync(join(tmpdir(), 'beitdin-boards-'));
  writeFileSync(join(customDir, 'mine.json'), JSON.stringify({
    id: 'my_exported_board', name: 'my_board',
    roles: [{ title: 'a', focus: 'Focus on a.' }, { title: 'b', focus: 'Focus on b.' }, { title: 'c', focus: 'Focus on c.' }]
  }));
  writeFileSync(join(customDir, 'broken.json'), JSON.stringify({ id: 'x', name: 'x', roles: [] }));
  writeFileSync(join(customDir, 'null.json'), 'null');
  writeFileSync(join(customDir, 'syntax.json'), '{not-json');
  writeFileSync(join(customDir, 'bad_tags.json'), JSON.stringify({
    id: 'bad_tags', name: 'bad_tags_board', tags: 'not-an-array',
    roles: [{ title: 'a', focus: 'Focus on a.' }, { title: 'b', focus: 'Focus on b.' }, { title: 'c', focus: 'Focus on c.' }]
  }));

  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['src/index.js'],
    cwd: root,
    stderr: 'ignore',
    env: {
      PATH: process.env.PATH,
      BEITDIN_MODELS: 'openai:gpt-test',
      BEITDIN_BOARDS_DIR: customDir,
      OPENAI_API_KEY: 'sk-openai-secret',
      GEMINI_API_KEY: 'gemini-secret',
      ANTHROPIC_API_KEY: 'ant-secret',
      BEITDIN_OPENAI_BASE_URL: `${mock.base}/openai`,
      BEITDIN_GEMINI_BASE_URL: `${mock.base}/gemini`,
      BEITDIN_ANTHROPIC_BASE_URL: `${mock.base}/anthropic`
    }
  }));
});

after(async () => {
  await client.close();
  mock.close();
  rmSync(customDir, { recursive: true });
});

const run = args => client.callTool({ name: 'run_board', arguments: args });

test('exposes the five tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['get_board', 'list_boards', 'list_providers', 'run_board', 'save_board']);
  const runBoard = tools.find(t => t.name === 'run_board');
  assert.match(runBoard.inputSchema.properties.models.description, /Default: openai:gpt-test\./);
});

test('list_boards filters, and custom boards are loaded while broken ones are skipped', async () => {
  const r = await client.callTool({ name: 'list_boards', arguments: { query: 'my_exported_board' } });
  assert.match(textOf(r), /^1 boards/);
  assert.match(textOf(r), /## custom/);
  const none = await client.callTool({ name: 'list_boards', arguments: { query: 'zzz-not-a-word' } });
  assert.match(textOf(none), /No boards matched/);
});

test('get_board returns the full prompts', async () => {
  const r = await client.callTool({ name: 'get_board', arguments: { board_id: 'architecture' } });
  assert.equal(JSON.parse(textOf(r)).roles[1].title, 'security_expert');
});

test('list_providers reports state and never exposes keys', async () => {
  const body = textOf(await client.callTool({ name: 'list_providers', arguments: {} }));
  assert.match(body, /openai: ready/);
  assert.match(body, /mistral: not configured, set MISTRAL_API_KEY/);
  assert.ok(!body.includes('secret'));
});

test('default model runs all three roles with the original system prompt', async () => {
  mock.requests.length = 0;
  const r = await run({ board_id: 'architecture', brief: 'Design a queue.' });
  assert.equal(r.isError, undefined);
  assert.equal(mock.requests.length, 3);
  const sent = mock.requests.map(q => q.body.messages[0].content).sort();
  assert.equal(sent[1], 'You are the security_expert. Focus on security, attack vectors and data protection. Do not design features.\nAnswer clearly and structure your output in Markdown. Do not write a preamble, just the output.');
  assert.ok(mock.requests.every(q => q.body.messages[1].content === 'Design a queue.'));
  assert.ok(mock.requests.every(q => q.headers.authorization === 'Bearer sk-openai-secret'));
  const md = textOf(r);
  assert.match(md, /\*\*Board:\*\* architecture_board/);
  assert.match(md, /## Lane 2: security_expert \(Model: gpt-test\)\n\nopenai says: You are the security_expert/);
  assert.match(md, /11 in, 7 out/);
});

test('three models send each role to its own provider and adapter', async () => {
  mock.requests.length = 0;
  const r = await run({
    board_id: 'product', brief: 'B',
    models: ['gemini:gem-test', 'anthropic:claude-opus-5-5', 'openai:gpt-test']
  });
  const md = textOf(r);
  assert.match(md, /Lane 1: product_manager \(Model: gem-test\)\n\ngemini says: You are the product_manager/);
  assert.ok(!md.includes('hidden'));
  assert.match(md, /Lane 2: ux_designer \(Model: claude-opus-5-5\)\n\nanthropic says: You are the ux_designer/);
  assert.match(md, /Lane 3: tech_lead \(Model: gpt-test\)\n\nopenai says: You are the tech_lead/);

  const g = mock.requests.find(q => q.url.startsWith('/gemini'));
  assert.equal(g.headers['x-goog-api-key'], 'gemini-secret');
  assert.ok(!g.url.includes('secret'));

  const a = mock.requests.find(q => q.url.startsWith('/anthropic'));
  assert.equal(a.headers.authorization, 'Bearer ant-secret');
  assert.equal(a.body.max_tokens, 64000);
  assert.equal(a.body.fallbacks, 'default');
  assert.deepEqual(a.body.output_config, { effort: 'high' });
});

test('older Claude models get a plain request', async () => {
  mock.requests.length = 0;
  await run({ board_id: 'product', brief: 'B', models: ['anthropic:claude-haiku-4-5'] });
  assert.ok(mock.requests.every(q => q.body.fallbacks === undefined && q.body.output_config === undefined));
});

test('one failing lane still returns the others and does not leak the key', async () => {
  const r = await run({
    board_id: 'product', brief: 'B',
    models: ['openai:unauthorized', 'gemini:gem-test', 'openai:gpt-test']
  });
  assert.equal(r.isError, undefined);
  const md = textOf(r);
  assert.match(md, /\[FAILED: authentication error \(401\): bad key \*\*\*\]/);
  assert.match(md, /gemini says/);
  assert.ok(!md.includes('sk-openai-secret'));
});

test('all lanes failing is a tool error', async () => {
  const r = await run({ board_id: 'product', brief: 'B', models: ['openai:unauthorized'] });
  assert.equal(r.isError, true);
});

test('incomplete, empty, blocked and refused answers are failures, not successes', async () => {
  const cases = [
    ['openai:cut', /stream ended before the model finished/],
    ['openai:empty', /returned no text/],
    ['gemini:blocked', /blocked.*SAFETY/],
    ['anthropic:claude-refuses', /declined this brief \(cyber\)/]
  ];
  for (const [model, pattern] of cases) {
    const r = await run({ board_id: 'product', brief: 'B', models: [model] });
    assert.equal(r.isError, true, model);
    assert.match(textOf(r), pattern);
  }
});

test('a length-limited answer is returned and flagged', async () => {
  const r = await run({ board_id: 'product', brief: 'B', models: ['openai:long'] });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /cut off at the output limit/);
});

test('bad requests are rejected before any provider call', async () => {
  mock.requests.length = 0;
  const cases = [
    [{ board_id: 'nope', brief: 'B' }, /Unknown board/],
    [{ board_id: 'product', brief: 'B', models: ['mistral:m'] }, /no API key. Set MISTRAL_API_KEY/],
    [{ board_id: 'product', brief: 'B', models: ['http://evil.example:m'] }, /invalid model/],
    [{ board_id: 'product', brief: 'B', models: ['constructor:m'] }, /invalid model/],
    [{ board_id: 'product', brief: 'B', models: ['gemini:../v1/secret'] }, /invalid model/],
    [{ board_id: 'product', brief: 'B', models: ['openai:gpt-test\n## Fake Lane'] }, /invalid model/],
    [{ board_id: 'product', brief: 'B', models: ['openai:a', 'openai:b'] }, /expected 1 or 3/],
    [{ board_id: 'product', brief: '   ' }, /brief/]
  ];
  for (const [args, pattern] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true);
    assert.match(textOf(r), pattern);
  }
  assert.equal(mock.requests.length, 0);
});

const threeRoles = [
  { title: 'api_designer', focus: 'Focus on the API surface.' },
  { title: 'client_developer', focus: 'Focus on how clients call it.' },
  { title: 'operator', focus: 'Focus on running it in production.' }
];

test('run_board with roles runs a one-off board without saving it', async () => {
  mock.requests.length = 0;
  const r = await run({ roles: threeRoles, brief: 'Review this API.' });
  assert.equal(r.isError, undefined);
  assert.equal(mock.requests.length, 3);
  const sent = mock.requests.map(q => q.body.messages[0].content).sort();
  assert.equal(sent[0], 'You are the api_designer. Focus on the API surface.\nAnswer clearly and structure your output in Markdown. Do not write a preamble, just the output.');
  assert.match(textOf(r), /## Lane 3: operator/);
  const list = await client.callTool({ name: 'list_boards', arguments: { query: 'client_developer operator' } });
  assert.match(textOf(list), /No boards matched/);
});

test('run_board needs exactly one of board_id and roles', async () => {
  mock.requests.length = 0;
  for (const args of [{ brief: 'B' }, { board_id: 'product', roles: threeRoles, brief: 'B' }]) {
    const r = await run(args);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /either board_id or roles/);
  }
  const two = await run({ roles: threeRoles.slice(0, 2), brief: 'B' });
  assert.equal(two.isError, true);
  assert.equal(mock.requests.length, 0);
});

test('save_board writes a file, adds the board to the catalog and refuses to clobber', async () => {
  const save = args => client.callTool({ name: 'save_board', arguments: args });
  const base = { board_id: 'api_review', description: 'Review an HTTP API design.', tags: ['api', 'review'], roles: threeRoles };

  const r = await save(base);
  assert.equal(r.isError, undefined, textOf(r));
  const savedBoardPath = join(customDir, 'api_review.json');
  assert.equal(statSync(savedBoardPath).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(savedBoardPath, 'utf8'));
  assert.equal(file.category, 'custom');
  assert.equal(file.roles[2].title, 'operator');

  const list = await client.callTool({ name: 'list_boards', arguments: { query: 'api review' } });
  assert.match(textOf(list), /- api_review: Review an HTTP API design\./);
  mock.requests.length = 0;
  assert.equal((await run({ board_id: 'api_review', brief: 'B' })).isError, undefined);
  assert.equal(mock.requests.length, 3);

  const again = await save(base);
  assert.equal(again.isError, true);
  assert.match(textOf(again), /already exists as a saved board/);
  const replaced = await save({ ...base, description: 'Second version.', overwrite: true });
  assert.equal(replaced.isError, undefined);
  assert.equal(JSON.parse(readFileSync(join(customDir, 'api_review.json'), 'utf8')).description, 'Second version.');

  const bundled = await save({ ...base, board_id: 'architecture' });
  assert.match(textOf(bundled), /already exists as a bundled board/);
  const shared = await save({ ...base, board_id: 'my_exported_board', overwrite: true });
  assert.match(textOf(shared), /defined in mine\.json/);
  const badId = await save({ ...base, board_id: '../escape' });
  assert.equal(badId.isError, true);
  assert.ok(!existsSync(join(customDir, '..', 'escape.json')));

  // Existing broken file on disk is not silently clobbered without overwrite.
  const brokenConflict = await save({ ...base, board_id: 'syntax' });
  assert.equal(brokenConflict.isError, true);
  assert.match(textOf(brokenConflict), /already exists/);

  // Symlink target in customDir is refused even with overwrite: true.
  const outside = join(tmpdir(), `beitdin-outside-${process.pid}.json`);
  writeFileSync(outside, 'keep');
  symlinkSync(outside, join(customDir, 'sym_board.json'));
  try {
    const symAttempt = await save({ ...base, board_id: 'sym_board', overwrite: true });
    assert.equal(symAttempt.isError, true);
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
  } finally {
    rmSync(outside, { force: true });
  }
});

test('redirects are rejected without forwarding credentials and non-string errors do not crash sibling lanes', async () => {
  mock.requests.length = 0;
  const r = await run({
    board_id: 'product',
    brief: 'B',
    models: ['gemini:redirect', 'openai:bad-error', 'openai:gpt-test']
  });
  assert.equal(r.isError, undefined);
  const md = textOf(r);
  assert.match(md, /Lane 1: product_manager[\s\S]*\[FAILED: network or stream error:/);
  assert.match(md, /Lane 2: ux_designer[\s\S]*\[FAILED: the provider reported an error mid-stream\.\]/);
  assert.match(md, /Lane 3: tech_lead[\s\S]*openai says:/);
  assert.ok(!mock.requests.some(q => q.url === '/collector'));
});

test('ANTHROPIC_AUTH_TOKEN is redacted if echoed in an error', async () => {
  const tokenClient = new Client({ name: 'test-token', version: '1' });
  await tokenClient.connect(new StdioClientTransport({
    command: process.execPath, args: ['src/index.js'], cwd: root, stderr: 'ignore',
    env: {
      PATH: process.env.PATH,
      BEITDIN_MODELS: 'openai:unauthorized',
      OPENAI_API_KEY: 'sk-other-key',
      ANTHROPIC_AUTH_TOKEN: 'sk-openai-secret',
      BEITDIN_OPENAI_BASE_URL: `${mock.base}/openai`
    }
  }));
  try {
    const r = await tokenClient.callTool({ name: 'run_board', arguments: { board_id: 'product', brief: 'B' } });
    assert.equal(r.isError, true);
    assert.ok(!textOf(r).includes('sk-openai-secret'));
    assert.match(textOf(r), /bad key \*\*\*/);
  } finally {
    await tokenClient.close();
  }
});

test('save_board explains what to set when no custom folder is configured', async () => {
  const bare = new Client({ name: 'test-bare', version: '1' });
  await bare.connect(new StdioClientTransport({
    command: process.execPath, args: ['src/index.js'], cwd: root, stderr: 'ignore',
    env: { PATH: process.env.PATH, BEITDIN_MODELS: 'openai:gpt-test', BEITDIN_BOARDS_DIR: '' }
  }));
  try {
    const r = await bare.callTool({ name: 'save_board', arguments: { board_id: 'x', description: 'd', tags: ['t'], roles: threeRoles } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Set BEITDIN_BOARDS_DIR/);
  } finally {
    await bare.close();
  }
});

test('BEITDIN_RUNS_DIR saves completed runs with the brief and skips total failures', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'beitdin-runs-'));
  const saving = new Client({ name: 'test-runs', version: '1' });
  await saving.connect(new StdioClientTransport({
    command: process.execPath, args: ['src/index.js'], cwd: root, stderr: 'ignore',
    env: {
      PATH: process.env.PATH,
      BEITDIN_MODELS: 'openai:gpt-test',
      BEITDIN_RUNS_DIR: runsDir,
      OPENAI_API_KEY: 'sk-openai-secret',
      BEITDIN_OPENAI_BASE_URL: `${mock.base}/openai`
    }
  }));
  try {
    const failed = await saving.callTool({ name: 'run_board', arguments: { board_id: 'product', brief: 'B', models: ['openai:unauthorized'] } });
    assert.equal(failed.isError, true);
    assert.equal(readdirSync(runsDir).length, 0);

    const ok = await saving.callTool({ name: 'run_board', arguments: { board_id: 'architecture', brief: 'Keep exact 8px grid tokens.' } });
    assert.equal(ok.isError, undefined);
    const files = readdirSync(runsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_architecture\.md$/);

    const savedPath = join(runsDir, files[0]);
    assert.equal(statSync(savedPath).mode & 0o777, 0o600);
    const returned = textOf(ok);
    assert.ok(returned.includes(`**Saved:** ${savedPath}`));
    assert.ok(!returned.includes('## Brief'));

    const onDisk = readFileSync(savedPath, 'utf8');
    assert.match(onDisk, /## Lane 1: technical_architect/);
    assert.match(onDisk, /## Brief\n\nKeep exact 8px grid tokens\./);
  } finally {
    await saving.close();
    rmSync(runsDir, { recursive: true });
  }
});

test('progress notifications arrive with strictly increasing values', async () => {
  const seen = [];
  await client.callTool(
    { name: 'run_board', arguments: { board_id: 'product', brief: 'B' } },
    undefined,
    { onprogress: p => seen.push(p) }
  );
  // The client library may drop updates that arrive together with the result,
  // so only the first one is guaranteed here.
  assert.match(seen[0].message, /^0\/3 lanes done/);
  assert.ok(seen.every((p, i) => i === 0 || p.progress > seen[i - 1].progress));
});
