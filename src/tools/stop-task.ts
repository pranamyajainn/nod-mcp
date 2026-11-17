import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run, type Ctx } from './common.js';

export function registerStopTask(server: McpServer, ctx: Ctx) {
  server.registerTool(
    'nod_stop_task',
    {
      title: 'Stop a Nod task',
      description: 'Stops one Nod task. Always available, because stopping only reduces risk.',
      inputSchema: { task_id: z.uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ task_id }) =>
      run(ctx, async () => {
        await ctx.client.stopTask(task_id);
        return { stopped: task_id };
      }),
  );
}
