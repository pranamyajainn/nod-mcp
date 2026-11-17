// Shared pieces for tool handlers: context, result helpers and error handling.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { log, mask, render } from '../format.js';
import { NodError, type NodClient } from '../nod-client.js';

export interface Ctx {
  client: NodClient;
  config: Config;
  /** How often nod_wait polls /api/state. */
  pollIntervalMs: number;
  /** Length of one "second" for nod_wait timeouts (tests shorten it). */
  secondMs: number;
}

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: render(value) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: mask(message) }], isError: true };
}

/** Run a tool body after the startup self-check, turning errors into clear tool results. */
export async function run(ctx: Ctx, body: () => Promise<CallToolResult | unknown>): Promise<CallToolResult> {
  try {
    await ctx.client.ensureReady();
    const value = await body();
    return isToolResult(value) ? value : ok(value);
  } catch (error) {
    if (error instanceof NodError) return fail(error.message);
    const message = error instanceof Error ? error.message : String(error);
    log(`Unexpected error: ${message}`);
    return fail(`Unexpected error in nod-mcp: ${message}`);
  }
}

function isToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as CallToolResult).content);
}
