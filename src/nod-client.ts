// The only module that talks HTTP to Nod.
// - Allowlist: any method/path not listed is refused before a network call.
// - Fixed POST /api/messages body: only text, clientMessageId, replyToMessageId, threadId.
// - Bearer auth, no Origin header, timeouts, error mapping, token masking.
import type { z } from 'zod';
import type { Config } from './config.js';
import { cut, mask } from './format.js';
import {
  NOD_COMMIT,
  aroundSchema,
  healthSchema,
  messagesPageSchema,
  okSchema,
  searchResultsSchema,
  stateSchema,
  submitResponseSchema,
  taskDetailSchema,
  tasksSchema,
  configurationSchema,
  type AppState,
  type SubmitResponse,
} from './schemas.js';

type Method = 'GET' | 'POST';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const UUID_RE = new RegExp(`^${UUID}$`);

/** Every request the bridge may make. Nothing else is ever sent. (CLAUDE.md §3.4) */
const ALLOWLIST: ReadonlyArray<{ method: Method; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/health$/ },
  { method: 'GET', path: /^\/api\/configuration$/ },
  { method: 'GET', path: /^\/api\/state$/ },
  { method: 'GET', path: /^\/api\/messages$/ },
  { method: 'GET', path: /^\/api\/messages\/search$/ },
  { method: 'GET', path: new RegExp(`^/api/messages/around/${UUID}$`) },
  { method: 'GET', path: /^\/api\/tasks$/ },
  { method: 'GET', path: new RegExp(`^/api/tasks/${UUID}$`) },
  { method: 'POST', path: new RegExp(`^/api/tasks/${UUID}/stop$`) },
  { method: 'POST', path: /^\/api\/thread\/stop$/ },
  { method: 'POST', path: /^\/api\/messages$/ },
  { method: 'GET', path: /^\/api\/events$/ },
];

/** The only keys a POST /api/messages body may ever have. (Safety rule 3) */
/** Nod's limit for message text (src/shared/message-limits.ts). */
export const MESSAGE_TEXT_LIMIT = 100_000;

export const MESSAGE_BODY_KEYS = ['text', 'clientMessageId', 'replyToMessageId', 'threadId'] as const;

export function isAllowed(method: string, path: string): boolean {
  return ALLOWLIST.some((rule) => rule.method === method && rule.path.test(path));
}

export type NodErrorKind = 'blocked' | 'http' | 'offline' | 'timeout' | 'api_changed';

export class NodError extends Error {
  constructor(
    message: string,
    readonly kind: NodErrorKind,
    readonly status?: number,
  ) {
    super(mask(message));
  }
}

export const API_CHANGED = `Nod's internal API seems to have changed (checked against commit ${NOD_COMMIT}). Update nod-mcp.`;

export interface MessageInput {
  text: string;
  clientMessageId: string;
  replyToMessageId?: string;
  threadId?: string;
}

/** Build the POST body from scratch so no other key can ever be included. */
export function buildMessageBody(input: MessageInput): Record<string, string> {
  const body: Record<string, string> = { text: input.text, clientMessageId: input.clientMessageId };
  if (input.replyToMessageId) body.replyToMessageId = input.replyToMessageId;
  if (input.threadId) body.threadId = input.threadId;
  return body;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class NodClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private checked = false;

  constructor(
    private readonly config: Config,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Startup self-check: health, then state shape. Runs until it passes once. */
  async ensureReady(): Promise<void> {
    if (this.checked) return;
    await this.health();
    await this.state();
    this.checked = true;
  }

  health() {
    return this.request('GET', '/api/health', healthSchema);
  }
  configuration() {
    return this.request('GET', '/api/configuration', configurationSchema);
  }
  state(): Promise<AppState> {
    return this.request('GET', '/api/state', stateSchema);
  }
  messages(before?: { createdAt: string; id: string }) {
    return this.request(
      'GET',
      '/api/messages',
      messagesPageSchema,
      before ? { query: { before: before.createdAt, beforeId: before.id } } : {},
    );
  }
  search(q: string) {
    return this.request('GET', '/api/messages/search', searchResultsSchema, { query: { q } });
  }
  around(messageId: string) {
    return this.request('GET', `/api/messages/around/${messageId}`, aroundSchema);
  }
  tasks() {
    return this.request('GET', '/api/tasks', tasksSchema);
  }
  task(taskId: string) {
    return this.request('GET', `/api/tasks/${taskId}`, taskDetailSchema);
  }
  stopTask(taskId: string) {
    return this.request('POST', `/api/tasks/${taskId}/stop`, okSchema, { body: {} });
  }
  stopAll() {
    return this.request('POST', '/api/thread/stop', okSchema, { body: {} });
  }
  /** Retries once on a network failure with the same clientMessageId; Nod treats it as the same message. */
  async sendMessage(input: MessageInput): Promise<SubmitResponse> {
    const body = buildMessageBody(input);
    try {
      return await this.request('POST', '/api/messages', submitResponseSchema, { body });
    } catch (error) {
      if (error instanceof NodError && (error.kind === 'offline' || error.kind === 'timeout'))
        return this.request('POST', '/api/messages', submitResponseSchema, { body });
      throw error;
    }
  }

  private url(method: Method, path: string, query?: Record<string, string>): URL {
    if (!isAllowed(method, path)) throw new NodError(`Blocked: ${method} ${path} is not on the nod-mcp allowlist.`, 'blocked');
    const url = new URL(path, this.config.baseUrl);
    if (url.origin !== this.config.baseUrl.origin || url.pathname !== path)
      throw new NodError(`Blocked: ${method} ${path} resolves outside the allowed paths.`, 'blocked');
    if (query) url.search = new URLSearchParams(query).toString();
    return url;
  }

  private headers(): Record<string, string> {
    // No Origin header (Nod checks it if present). Host comes from the URL.
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    options: { query?: Record<string, string>; body?: Record<string, unknown> } = {},
  ): Promise<z.infer<S>> {
    const url = this.url(method, path, options.query);
    if (path === '/api/messages' && method === 'POST') {
      const extra = Object.keys(options.body ?? {}).filter((key) => !(MESSAGE_BODY_KEYS as readonly string[]).includes(key));
      if (extra.length) throw new NodError(`Blocked: message body has keys that are not allowed (${extra.join(', ')}).`, 'blocked');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw this.networkError(error);
    }
    if (!response.ok) throw await this.httpError(response);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new NodError(API_CHANGED, 'api_changed');
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new NodError(API_CHANGED, 'api_changed');
    return parsed.data;
  }

  private networkError(error: unknown): NodError {
    if (error instanceof NodError) return error;
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError')
      return new NodError(`Nod did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`, 'timeout');
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    return new NodError(
      `Nod server isn't running or can't be reached at ${this.config.baseUrl.origin}${code ? ` (${code})` : ''}. Start the Docker stack.`,
      'offline',
    );
  }

  private async httpError(response: Response): Promise<NodError> {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === 'string') detail = cut(body.error, 300);
    } catch {
      // No JSON body.
    }
    const said = detail ? ` Nod said: "${detail}"` : '';
    const status = response.status;
    const message =
      status === 401
        ? 'Token rejected. Check NOD_ENV_FILE or NOD_TOKEN.'
        : status === 403
          ? `Host not permitted. Use http://localhost:4310, or the NOD_PUBLIC_URL from Nod's .env.${said}`
          : status === 409
            ? /already in use/i.test(detail)
              ? `Duplicate message id.${said}`
              : `Conflict, for example the conversation was reset. Re-read the state and try again.${said}`
            : status === 429
              ? 'Rate limited by Nod. Wait a minute and try again.'
              : status === 503
                ? `No model configured in Nod. Set one up in the Nod app.${said}`
                : status === 404
                  ? `Not found in Nod.${said}`
                  : status === 400
                    ? `Nod rejected the request.${said}`
                    : `Nod returned HTTP ${status}.${said}`;
    return new NodError(message, 'http', status);
  }
}
