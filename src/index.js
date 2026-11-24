#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadCatalog } from './boards.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

// Stdout carries the MCP protocol, so all diagnostics go to stderr. Real
// environment variables win over the optional .env file next to the package.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`beitdin: could not read .env: ${e.message}`);
}

const config = loadConfig();
const catalog = loadCatalog(config.boardsDir);
await createServer({ config, catalog }).connect(new StdioServerTransport());
console.error(`beitdin: ready with ${catalog.size} boards`);
