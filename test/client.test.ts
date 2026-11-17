import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { API_CHANGED, NodClient, NodError, buildMessageBody, isAllowed } from '../src/nod-client.js';
import { startMockNod, TOKEN, type MockNod } from './mock-nod.js';

let mock: MockNod;
beforeEach(async () => {
  mock = await startMockNod();
});
afterEach(async () => {
  await mock.close();
});

const client = (url = mock.url, token = TOKEN) => new NodClient(loadConfig({ NOD_URL: url, NOD_TOKEN: token }), { timeoutMs: 2000 });

describe('safety rule 2: endpoint allowlist', () => {
  const forbidden: Array<[string, string]> = [
    ['GET', '/api/vault'],
    ['POST', '/api/vault'],
    ['GET', '/api/vault/sessions'],
    ['GET', '/api/models'],
    ['PATCH', '/api/account'],
    ['GET', '/api/apps'],
    ['GET', '/api/channel-settings'],
    ['GET', '/api/channels'],
    ['GET', '/api/trust/export'],
    ['POST', '/api/conversation/reset'],
    ['POST', '/api/uploads'],
    ['GET', '/api/local-files/keep-out'],
    ['POST', '/api/schedules'],
    ['GET', '/api/browser'],
    ['POST', '/api/browser-handoff'],
    ['POST', '/api/messages/audio'],
    ['POST', '/api/messages/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c/reaction'],
    ['PATCH', '/api/tasks/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c'],
    ['PUT', '/api/tasks/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c/model'],
    ['GET', '/api/tasks/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c/commands'],
    ['POST', '/api/onboarding/profile'],
    ['GET', '/api/speech'],
    ['POST', '/api/webhooks/telegram'],
    ['GET', '/api/memory'],
    ['PATCH', '/api/preferences'],
    ['GET', '/api/tasks/../vault'],
    ['GET', '/api/tasks/not-a-uuid'],
    ['GET', '/api/state/'],
    ['POST', '/api/state'],
  ];
  for (const [method, path] of forbidden)
    it(`blocks ${method} ${path}`, () => {
      expect(isAllowed(method, path)).toBe(false);
    });

  it('throws before any network call for /api/vault', async () => {
    const fetchSpy = vi.fn();
    const c = new NodClient(loadConfig({ NOD_URL: mock.url, NOD_TOKEN: TOKEN }), { fetch: fetchSpy as any });
    const { z } = await import('zod');
    await expect(c.request('GET', '/api/vault', z.any())).rejects.toMatchObject({ kind: 'blocked' });
    await expect(c.request('POST' as any, '/api/conversation/reset', z.any())).rejects.toMatchObject({ kind: 'blocked' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it('allows the documented endpoints', () => {
    for (const [method, path] of [
      ['GET', '/api/health'],
      ['GET', '/api/state'],
      ['GET', '/api/messages'],
      ['POST', '/api/messages'],
      ['GET', '/api/tasks/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c'],
      ['POST', '/api/tasks/0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c/stop'],
      ['POST', '/api/thread/stop'],
    ] as const)
      expect(isAllowed(method, path)).toBe(true);
  });
});

describe('safety rule 3: fixed message body', () => {
  it('buildMessageBody keeps only the four allowed keys', () => {
    const body = buildMessageBody({
      text: 'hi',
      clientMessageId: 'c',
      replyToMessageId: 'r',
      threadId: 't',
      approvalAnswer: { approved: true },
      verificationRequestId: 'v',
    } as any);
    expect(Object.keys(body).sort()).toEqual(['clientMessageId', 'replyToMessageId', 'text', 'threadId']);
  });

  it('request() refuses a message body with any other key', async () => {
    const { z } = await import('zod');
    for (const key of ['approvalAnswer', 'questionAnswer', 'verificationRequestId', 'attachmentIds', 'displayText', 'seenMessageId', 'replyQuote'])
      await expect(client().request('POST', '/api/messages', z.any(), { body: { text: 'x', [key]: 'y' } })).rejects.toMatchObject({ kind: 'blocked' });
    expect(mock.requests.filter((r) => r.path === '/api/messages')).toHaveLength(0);
  });
});

describe('auth, host and errors', () => {
  it('sends a bearer token and no Origin header', async () => {
    await client().health();
    const req = mock.requests[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.host).toBe(`localhost:${mock.port}`);
  });

  it('maps 401 to a clear message', async () => {
    await expect(client(mock.url, 'W'.repeat(43)).health()).rejects.toThrow(/Token rejected/);
  });

  it('maps 403 (wrong Host) to a clear message', async () => {
    await expect(client(`http://127.0.0.1:${mock.port}`).health()).rejects.toThrow(/Host not permitted/);
  });

  it('maps connection refused to "not running"', async () => {
    const port = mock.port;
    await mock.close();
    await expect(client(`http://localhost:${port}`).health()).rejects.toThrow(/isn't running/);
    mock = await startMockNod();
  });

  it('maps 409, 429 and 503', async () => {
    mock.failures.set('/api/state', { status: 409, error: 'This conversation has been reset.' });
    await expect(client().state()).rejects.toThrow(/Conflict/);
    mock.failures.set('/api/state', { status: 429, error: 'slow down' });
    await expect(client().state()).rejects.toThrow(/Rate limited/);
    mock.failures.set('/api/state', { status: 503, error: 'Configure an agent provider before starting a conversation.' });
    await expect(client().state()).rejects.toThrow(/No model configured/);
  });

  it('reports an API change when a shape does not match', async () => {
    mock.overrides.set('/api/state', { threadId: 'x', messages: 'not-an-array' });
    await expect(client().state()).rejects.toThrow(API_CHANGED);
    mock.overrides.set('/api/state', {
      threadId: 'x', messages: [], turns: [{ id: 't', status: 'paused', source: 'user', createdAt: 'now' }],
      configuration: { provider: 'a', model: 'b', llmReady: true },
    });
    await expect(client().state()).rejects.toBeInstanceOf(NodError);
  });

  it('masks the token if Nod echoes it back in an error', async () => {
    mock.failures.set('/api/state', { status: 400, error: `bad token ${TOKEN}` });
    const error = await client().state().catch((e) => e as Error);
    expect(error.message).toContain('[hidden]');
    expect(error.message).not.toContain(TOKEN);
  });
});
