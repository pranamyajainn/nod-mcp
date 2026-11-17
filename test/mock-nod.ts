// In-process HTTP mock of the Nod endpoints the bridge uses.
// Reproduces: bearer auth (401), strict Host check (403), the JSON shapes, the strict
// POST /api/messages body, and lets tests change turn and task state over time.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TOKEN = 'tok_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body?: unknown;
}

export interface MockState {
  threadId: string;
  tasks: any[];
  closedTasks: any[];
  messages: any[];
  turns: any[];
  activity: any[];
  verificationRequests: any[];
  configuration: any;
  events: Record<string, any[]>;
}

const NOW = () => new Date().toISOString();

export function message(over: Partial<any> = {}): any {
  return {
    id: randomUUID(),
    role: 'assistant',
    text: 'hello',
    turnId: randomUUID(),
    createdAt: NOW(),
    attachments: [],
    replyToMessageId: null,
    ...over,
  };
}

export function task(over: Partial<any> = {}): any {
  return {
    id: randomUUID(),
    title: 'A task',
    doneWhen: 'When it is done',
    now: 'Working on it',
    result: '',
    status: 'working',
    question: null,
    questionMessageId: null,
    waitingFor: [],
    nextCheck: null,
    createdAt: NOW(),
    updatedAt: NOW(),
    closedAt: null,
    messageId: null,
    ...over,
  };
}

export function turn(over: Partial<any> = {}): any {
  return { id: randomUUID(), status: 'running', source: 'user', createdAt: NOW(), finishedAt: null, error: null, ...over };
}

const MESSAGE_KEYS = new Set([
  'text', 'displayText', 'attachmentIds', 'replyToMessageId', 'questionAnswer', 'approvalAnswer',
  'replyQuote', 'seenMessageId', 'clientMessageId', 'threadId', 'verificationRequestId',
]);

export interface MockNod {
  url: string;
  port: number;
  state: MockState;
  requests: Recorded[];
  /** Called on each GET /api/state with the call count, before the response is built. */
  onState?: (count: number, state: MockState) => void;
  /** Called on POST /api/messages after the default handling created the user message and turn. */
  onSend?: (body: any, created: { message: any; turn: any }, state: MockState) => void;
  /** Force an error for a path: { status, error }. */
  failures: Map<string, { status: number; error: string }>;
  /** Replace a JSON response for a path (to simulate API changes). */
  overrides: Map<string, unknown>;
  emit(payload: unknown): void;
  close(): Promise<void>;
}

export async function startMockNod(options: { hosts?: (port: number) => string[] } = {}): Promise<MockNod> {
  const state: MockState = {
    threadId: randomUUID(),
    tasks: [],
    closedTasks: [],
    messages: [],
    turns: [],
    activity: [],
    verificationRequests: [],
    configuration: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      llmReady: true,
      modelReconnect: false,
      integrationsReady: true,
      conversationResetEnabled: true,
    },
    events: {},
  };
  const requests: Recorded[] = [];
  const streams = new Set<ServerResponse>();
  let stateCalls = 0;
  const sent = new Map<string, { body: string; response: any }>();

  const mock: MockNod = {
    url: '',
    port: 0,
    state,
    requests,
    failures: new Map(),
    overrides: new Map(),
    emit(payload) {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const stream of streams) stream.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return json(res, 400, { error: 'Bad JSON.' });
    }
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

    const hosts = options.hosts ? options.hosts(mock.port) : [`localhost:${mock.port}`];
    if (!hosts.includes(req.headers.host ?? '')) return json(res, 403, { error: 'This host is not permitted.' });
    if (req.headers.origin) return json(res, 403, { error: 'This origin is not permitted.' });
    const auth = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (path.startsWith('/api/') && auth !== TOKEN) return json(res, 401, { error: 'Enter your server authentication token.' });

    const failure = mock.failures.get(path);
    if (failure) return json(res, failure.status, { error: failure.error });
    if (mock.overrides.has(path)) return json(res, 200, mock.overrides.get(path));

    const m = req.method;
    if (m === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
    if (m === 'GET' && path === '/api/configuration') return json(res, 200, state.configuration);
    if (m === 'GET' && path === '/api/state') {
      stateCalls++;
      mock.onState?.(stateCalls, state);
      return json(res, 200, {
        threadId: state.threadId,
        tasks: state.tasks,
        messages: state.messages.slice(-150),
        turns: state.turns.slice(-50),
        activity: state.activity,
        verificationRequests: state.verificationRequests,
        pendingAnswerChoiceMessageIds: [],
        configuration: state.configuration,
      });
    }
    if (m === 'GET' && path === '/api/messages') {
      const before = url.searchParams.get('before');
      const beforeId = url.searchParams.get('beforeId');
      const older = before
        ? state.messages.filter((x) => x.createdAt < before || (x.createdAt === before && beforeId && x.id < beforeId))
        : state.messages;
      return json(res, 200, { messages: older.slice(-60), hasMore: older.length > 60 });
    }
    if (m === 'GET' && path === '/api/messages/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const hits = state.messages.filter((x) => x.text.toLowerCase().includes(q)).reverse().slice(0, 50);
      return json(res, 200, hits.map((x) => ({ ...x, snippet: x.text.slice(0, 100) })));
    }
    const around = /^\/api\/messages\/around\/([^/]+)$/.exec(path);
    if (m === 'GET' && around) {
      const index = state.messages.findIndex((x) => x.id === around[1]);
      if (index < 0) return json(res, 404, { error: 'Message not found.' });
      return json(res, 200, state.messages.slice(Math.max(0, index - 30), index + 30));
    }
    if (m === 'GET' && path === '/api/tasks') return json(res, 200, [...state.tasks, ...state.closedTasks]);
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (m === 'GET' && taskMatch) {
      const found = [...state.tasks, ...state.closedTasks].find((t) => t.id === taskMatch[1]);
      if (!found) return json(res, 404, { error: 'Task not found.' });
      return json(res, 200, { task: found, events: state.events[found.id] ?? [] });
    }
    const stopMatch = /^\/api\/tasks\/([^/]+)\/stop$/.exec(path);
    if (m === 'POST' && stopMatch) {
      const found = state.tasks.find((t) => t.id === stopMatch[1]);
      if (found) found.status = 'cancelled';
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && path === '/api/thread/stop') {
      for (const t of state.tasks) t.status = 'cancelled';
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && path === '/api/messages') {
      const input = (body ?? {}) as Record<string, any>;
      const unknown = Object.keys(input).filter((k) => !MESSAGE_KEYS.has(k));
      if (unknown.length || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000)
        return json(res, 400, { error: 'Check the supplied values.' });
      if (!state.configuration.llmReady)
        return json(res, 503, { error: 'Configure an agent provider before starting a conversation.' });
      if (input.threadId && input.threadId !== state.threadId)
        return json(res, 409, { error: 'This conversation has been reset. Reload it before continuing.' });
      const id = input.clientMessageId ?? randomUUID();
      const previous = sent.get(id);
      if (previous) {
        if (previous.body !== raw) return json(res, 409, { error: 'This message ID is already in use. Send this as a new message.' });
        return json(res, 200, previous.response);
      }
      const t = turn();
      const userMessage = message({
        id,
        role: 'user',
        text: input.text,
        turnId: t.id,
        replyToMessageId: input.replyToMessageId ?? null,
      });
      state.turns.push(t);
      state.messages.push(userMessage);
      mock.onSend?.(input, { message: userMessage, turn: t }, state);
      const response = { threadId: state.threadId, turnId: t.id, messageId: id };
      sent.set(id, { body: raw, response });
      return json(res, 200, response);
    }
    if (m === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`);
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    // Routes that exist in Nod but must never be called by the bridge.
    if (path.startsWith('/api/')) return json(res, 200, { secret: 'should never be reached' });
    return json(res, 404, { error: 'Not found.' });
  });

  await new Promise<void>((resolve) => server.listen({ port: 0, host: '::', ipv6Only: false }, resolve));
  mock.port = (server.address() as AddressInfo).port;
  mock.url = `http://localhost:${mock.port}`;
  return mock;
}
