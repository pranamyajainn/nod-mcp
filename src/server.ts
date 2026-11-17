// Builds the MCP server: instructions plus all tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { INSTRUCTIONS } from './instructions.js';
import { NodClient, type ClientOptions } from './nod-client.js';
import type { Ctx } from './tools/common.js';
import { registerGetTask } from './tools/get-task.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerReadMessages } from './tools/read-messages.js';
import { registerSearchMessages } from './tools/search-messages.js';
import { registerStatus } from './tools/status.js';
import { registerStopAll } from './tools/stop-all.js';
import { registerStopTask } from './tools/stop-task.js';

export const VERSION = '0.1.0';

export interface ServerOptions extends ClientOptions {
  pollIntervalMs?: number;
  secondMs?: number;
}

export function createServer(config: Config, options: ServerOptions = {}) {
  const ctx: Ctx = {
    client: new NodClient(config, options),
    config,
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    secondMs: options.secondMs ?? 1000,
  };
  const server = new McpServer({ name: 'nod-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  registerStatus(server, ctx);
  registerListTasks(server, ctx);
  registerGetTask(server, ctx);
  registerReadMessages(server, ctx);
  registerSearchMessages(server, ctx);
  registerStopTask(server, ctx);
  registerStopAll(server, ctx);
  return { server, ctx };
}
