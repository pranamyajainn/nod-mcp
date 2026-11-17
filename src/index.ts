#!/usr/bin/env node
// Entry point: load config, build the server, connect over stdio.
// stdout carries MCP messages only. All logging goes to stderr through log().
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { log } from './format.js';
import { createServer } from './server.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log(`Can't start: ${error instanceof ConfigError ? error.message : String(error)}`);
    process.exit(1);
  }
  const { server } = createServer(config);
  await server.connect(new StdioServerTransport());
  log(`Ready. Nod at ${config.baseUrl.origin}. Sending ${config.allowSend ? 'ON' : 'off (read-only)'}.`);
}

main().catch((error) => {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
