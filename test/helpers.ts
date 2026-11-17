// Connects a real MCP client to the bridge (in memory) and points the bridge at the mock Nod.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { setLogSink } from '../src/format.js';
import { createServer } from '../src/server.js';
import { TOKEN, type MockNod } from './mock-nod.js';

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: any }>;
  /** Every tool result text and every log line produced so far. */
  outputs: string[];
  logs: string[];
  instructions: string | undefined;
  close(): Promise<void>;
}

export async function connect(mock: MockNod, env: Record<string, string> = {}): Promise<Harness> {
  const logs: string[] = [];
  setLogSink((line) => logs.push(line));
  const config = loadConfig({ NOD_URL: mock.url, NOD_TOKEN: TOKEN, ...env });
  const { server } = createServer(config, { pollIntervalMs: 10, secondMs: 20, timeoutMs: 2000 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const outputs: string[] = [];
  return {
    outputs,
    logs,
    instructions: client.getInstructions(),
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as any;
      const text = (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
      outputs.push(text);
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { text, isError: Boolean(result.isError), json };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
