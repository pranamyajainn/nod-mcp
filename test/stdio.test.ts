// Safety rule 10: stdout carries only MCP messages; logs go to stderr; the token never appears.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockNod, TOKEN, type MockNod } from './mock-nod.js';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function runServer(env: Record<string, string>, input: object[], waitForIds: number[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const seen = new Set<number>();
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        try {
          const id = JSON.parse(line).id;
          if (typeof id === 'number') seen.add(id);
        } catch {
          // partial line
        }
      }
      if (waitForIds.every((id) => seen.has(id))) child.stdin.end();
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    for (const msg of input) child.stdin.write(`${JSON.stringify(msg)}\n`);
    if (!waitForIds.length) child.stdin.end();
  });
}

let mock: MockNod;
beforeEach(async () => {
  mock = await startMockNod();
});
afterEach(async () => {
  await mock.close();
});

describe('safety rule 10: stdio', () => {
  it('writes only JSON-RPC to stdout and logs to stderr', async () => {
    const { stdout, stderr } = await runServer(
      { NOD_URL: mock.url, NOD_TOKEN: TOKEN },
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nod_status', arguments: {} } },
      ],
      [1, 2, 3],
    );
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    const tools = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['nod_status', 'nod_list_tasks', 'nod_stop_all']));
    expect(stderr).toMatch(/Ready/);
    expect(stdout + stderr).not.toContain(TOKEN);
  });

  it('refuses to start on a non-local URL, prints nothing to stdout', async () => {
    const { stdout, stderr, code } = await runServer({ NOD_URL: 'http://example.com', NOD_TOKEN: TOKEN }, [], []);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/this computer/);
    expect(stderr).not.toContain(TOKEN);
  });

  it('refuses to start with an empty tag', async () => {
    const { code, stderr } = await runServer({ NOD_URL: mock.url, NOD_TOKEN: TOKEN, NOD_MCP_TAG: '' }, [], []);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot be empty/);
  });
});

describe('safety rule 10: no stdout writes or telemetry in the source', () => {
  it('no console.* calls, process.stdout writes or outside URLs in src/', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
    for (const file of files(root)) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/console\.(log|info|warn|error|debug)|process\.stdout/);
      expect(code.match(/https?:\/\/[^\s'"`]+/g)?.filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(u)) ?? [], file).toEqual([]);
    }
  });
});
