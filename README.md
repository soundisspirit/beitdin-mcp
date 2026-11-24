# beitdin-mcp

An MCP server based on [beitdin.dev](https://beitdin.dev). Any MCP client, such as a coding agent, sends a brief to a board of three expert roles. It ships with the two default boards from [beitdin.dev](https://beitdin.dev) (`architecture` and `product`), supports one-off roles passed in the call, and lets you or your agent save custom boards to a local folder. The server makes one direct model API call per role, runs all three roles at once, and returns their answers as one Markdown document.

The roles do not run agents, use tools or read files. Each one sees its role prompt and the brief, so the brief has to contain everything they need.

## Setup

Requires Node 20.12 or newer.

```sh
npm install
cp .env.example .env
```

In `.env`, set an API key for at least one provider and choose your default model in `BEITDIN_MODELS`.

Register the server with Claude Code, using the real path to this folder:

```sh
claude mcp add --scope user beitdin -- node "/path/to/this/folder/src/index.js"
```

Other MCP clients use the same stdio command:

```json
{ "mcpServers": { "beitdin": { "command": "node", "args": ["/path/to/this/folder/src/index.js"] } } }
```

## Agent skill

`skills/beitdin-board/SKILL.md` teaches an agent when to use a board and how to write a good brief. Copy the `beitdin-board` folder to `~/.claude/skills/` for Claude Code, or to `~/.gemini/config/skills/` for Antigravity. For Antigravity, also add the server to `~/.gemini/config/mcp_config.json`.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_boards` | Browse the catalog, optionally by `category` or search `query`. |
| `get_board` | Show a board's exact role prompts. |
| `list_providers` | Show the default models and which providers have keys. |
| `run_board` | Run a `brief` on `board_id`, or on three `roles` given in the call for a one-off board, optionally with `models`. |
| `save_board` | Save three roles as a new board in `BEITDIN_BOARDS_DIR`, with a description and tags. |

## Choosing models

Models are written as `provider:model`. Give one to use it for all three roles, or three to give each role its own, in `BEITDIN_MODELS` or in the `models` argument of a call.

```
anthropic:claude-opus-5-5
anthropic:claude-opus-5-5,openai:gpt-example,gemini:gemini-example
```

Providers: `anthropic`, `openai`, `gemini`, `mistral`, `groq`, `together`, `openrouter`, and `local` for an OpenAI-compatible server such as Ollama (`http://localhost:11434/v1` by default).

Callers can only choose among these providers. Base URLs and keys come from the server environment.

On current Claude models the server requests `high` effort and turns on Anthropic's server-side refusal fallback, so a declined request can be answered by a fallback model. The lane heading shows the model that actually answered.

## Your own boards

Set `BEITDIN_BOARDS_DIR` to a folder of JSON files. A file can be a board exported from the beitdin web app, or a category file:

```json
{ "category": "my_team", "boards": [
  { "id": "my_board", "name": "my_board", "description": "When to use it.", "tags": ["example"],
    "roles": [
      { "title": "first_role", "focus": "Focus on X. Do not Y." },
      { "title": "second_role", "focus": "Focus on Y. Do not Z." },
      { "title": "third_role", "focus": "Focus on Z. Do not X." }
    ] }
] }
```

A custom board replaces a bundled board with the same id.

Each role is a name (`title`) and a system prompt (`focus`). The server sends `You are the <title>. <focus>` followed by an instruction to answer in Markdown without a preamble, so the focus should not repeat that.

Agents can also create boards with `save_board`. It writes `<id>.json` to this folder, and the board can be run straight away. It replaces an existing board only when `overwrite` is set, never edits a file that holds several boards, and never writes to the bundled `boards/` folder. Keep this folder outside the repository, or add it to `.gitignore`.

## Behaviour to know about

- `run_board` spends money on your API keys: three model calls per run.
- Set `BEITDIN_RUNS_DIR` to save every completed run as `<timestamp>_<board_id>.md` (with the three answers and the brief) and show its path at the top of the result. When unset, nothing is written to disk.
- Runs can take minutes. The server sends MCP progress notifications when the client asks for them. A client with a short request timeout needs a longer one, or needs to reset its timeout on progress.
- If some lanes fail, the others are still returned and the failure is shown in place. The tool only reports an error if all three fail.
- Each lane times out after `BEITDIN_TIMEOUT_MS`, 10 minutes by default.

## Publishing

`package.json` has `"private": true` to prevent an accidental `npm publish`. Remove it when you decide to publish. This server is stdio only and uses the operator's keys, so a hosted multi-user version would need HTTP transport, authentication and a spending limit.

## Tests

```sh
npm test
```

The tests start the real server over stdio and use local fake provider endpoints, so they cost nothing.

## License

MIT
