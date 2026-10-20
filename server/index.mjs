#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConnection, ConfigurationError } from './config.mjs';
import { LklaudApi } from './api.mjs';
import { createMcpServer } from './mcp.mjs';

try {
  const api = new LklaudApi(await loadConnection());
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
  process.once('SIGTERM', () => { server.close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { server.close().finally(() => process.exit(0)); });
} catch (error) {
  // stdout is reserved for MCP. Do not log environment, tokens or raw errors.
  process.stderr.write(`${error instanceof ConfigurationError ? error.message : 'Не вдалося запустити MCP-сервер ЛКЛАУД.'}\n`);
  process.exitCode = 1;
}
