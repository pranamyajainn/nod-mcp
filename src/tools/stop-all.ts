import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run, type Ctx } from './common.js';

export function registerStopAll(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'nod_stop_all',
    {
      title: 'Stop all Nod work',
      description:
        'Stops ALL running Nod work (every task in the conversation). Needs confirm: true. Use only when the user asks to stop everything or something is clearly going wrong.',
      inputSchema: { confirm: z.literal(true).describe('Must be exactly true.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      run(ctx, async () => {
        await ctx.client.stopAll();
        return { stopped: 'all running work' };
      }),
  );
}
