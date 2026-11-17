import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { NodClient } from '../src/nod-client.js';
import { connect, type Harness } from './helpers.js';
import { message, startMockNod, task, TOKEN, type MockNod } from './mock-nod.js';

let mock: MockNod;
let h: Harness;
beforeEach(async () => {
  mock = await startMockNod();
  h = await connect(mock, { NOD_MCP_ALLOW_SEND: 'true' });
});
afterEach(async () => {
  await h.close();
  await mock.close();
});

const posts = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/api/messages');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('safety rule 7: read-only by default', () => {
  it('nod_send refuses and makes no request when sending is off', async () => {
    await h.close();
    h = await connect(mock);
    const r = await h.call('nod_send', { text: 'New task: hello' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Sending is turned off/);
    expect(mock.requests).toHaveLength(0);
  });

  it('stop tools still work when sending is off', async () => {
    await h.close();
    h = await connect(mock);
    const r = await h.call('nod_stop_all', { confirm: true });
    expect(r.isError).toBe(false);
  });
});

describe('safety rules 3 and 6: body and tag', () => {
  it('sends only the four allowed keys, with the tag in front', async () => {
    const t = task({ status: 'needs_you', question: 'Which date?' });
    const q = message({ text: 'Which date?' });
    t.questionMessageId = q.id;
    mock.state.tasks.push(t);
    mock.state.messages.push(q);
    const r1 = await h.call('nod_send', { text: 'New task: find a hotel in Goa' });
    const r2 = await h.call('nod_send', { text: 'Dec 20, 2 people, budget 5000 rupees', reply_to_message_id: q.id });
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(r2.json.task_id).toBe(t.id);
    expect(posts()).toHaveLength(2);
    for (const p of posts()) {
      const body = p.body as Record<string, string>;
      expect(Object.keys(body).every((k) => ['text', 'clientMessageId', 'replyToMessageId', 'threadId'].includes(k))).toBe(true);
      expect(body.text!.startsWith('[via Claude] ')).toBe(true);
      expect(body.clientMessageId).toMatch(UUID);
      expect(body.threadId).toBe(mock.state.threadId);
    }
    expect((posts()[1]!.body as any).replyToMessageId).toBe(q.id);
    expect(r1.json).toMatchObject({ message_id: expect.any(String), turn_id: expect.any(String), thread_id: mock.state.threadId });
    expect(r1.json.next).toMatch(/nod_wait/);
  });

  it('uses a custom tag', async () => {
    await h.close();
    h = await connect(mock, { NOD_MCP_ALLOW_SEND: 'true', NOD_MCP_TAG: '[Claude/Pranamya]' });
    await h.call('nod_send', { text: 'New task: x' });
    expect((posts()[0]!.body as any).text).toBe('[Claude/Pranamya] New task: x');
  });

  it('retries a lost response with the same clientMessageId, and Nod keeps one message', async () => {
    let lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (lose && init?.method === 'POST' && String(input).endsWith('/api/messages')) {
        lose = false;
        throw new TypeError('fetch failed');
      }
      return response;
    };
    const client = new NodClient(loadConfig({ NOD_URL: mock.url, NOD_TOKEN: TOKEN }), { fetch: lossy });
    const sent = await client.sendMessage({ text: '[via Claude] hi', clientMessageId: '7c1d2c55-3c1e-4a8e-9a55-0f7b1d2e3c4a' });
    expect(posts()).toHaveLength(2);
    expect((posts()[0]!.body as any).clientMessageId).toBe((posts()[1]!.body as any).clientMessageId);
    expect(mock.state.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(sent.messageId).toBe('7c1d2c55-3c1e-4a8e-9a55-0f7b1d2e3c4a');
  });
});

describe('safety rule 4: check before every send', () => {
  const refuses = async (args: Record<string, unknown>, pattern: RegExp) => {
    const r = await h.call('nod_send', args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(pattern);
    expect(posts()).toHaveLength(0);
  };

  it('(a) a pending approval blocks sending', async () => {
    mock.state.messages.push(message({ approval: { id: 'a', state: 'pending', title: 'Send email to Bob', app: 'gmail', slug: 's' } }));
    await refuses({ text: 'sure, go ahead' }, /Waiting on you in the Nod app: approval "<nod-data>Send email to Bob<\/nod-data>"/);
  });

  it('(b) a pending verification blocks sending', async () => {
    mock.state.verificationRequests.push({ id: 'v', turnId: 't', kind: 'payment' });
    await refuses({ text: 'New task: x' }, /card security code/);
  });

  it('(c) a task waiting for a browser sign-in blocks sending', async () => {
    mock.state.tasks.push(task({ status: 'needs_you', browserHandoff: true, title: 'Log in to bank' }));
    await refuses({ text: 'New task: x' }, /sign-in in Nod's browser/);
  });

  it('(d) a reply to an approval message is blocked, even when the approval is no longer pending', async () => {
    const a = message({ approval: { id: 'a', state: 'expired', title: 'Pay 500', app: 'stripe', slug: 's' } });
    mock.state.messages.push(a);
    await refuses({ text: 'yes', reply_to_message_id: a.id }, /approval request/);
  });

  it('(d) a reply that reaches an approval through a turnless message is blocked', async () => {
    const a = message({ approval: { id: 'a', state: 'expired', title: 'Pay 500', app: 'stripe', slug: 's' } });
    const relay = message({ turnId: null, replyToMessageId: a.id, text: 'Reminder: still waiting' });
    mock.state.messages.push(a, relay);
    await refuses({ text: 'yes', reply_to_message_id: relay.id }, /linked to an approval/);
  });

  it('(d) a reply target outside /api/state is looked up, and an unknown one is refused', async () => {
    const a = message({ approval: { id: 'a', state: 'done', title: 'Old', app: 'x', slug: 's' } });
    mock.state.messages.push(a);
    for (let i = 0; i < 160; i++) mock.state.messages.push(message({ text: `filler ${i}` }));
    await refuses({ text: 'yes', reply_to_message_id: a.id }, /approval request/);
    expect(mock.requests.some((r) => r.path === `/api/messages/around/${a.id}`)).toBe(true);
    await refuses({ text: 'yes', reply_to_message_id: '0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c' }, /not found/);
  });

  it('refuses when the model is not ready', async () => {
    mock.state.configuration.llmReady = false;
    await refuses({ text: 'New task: x' }, /model isn't ready/);
  });

  it('safety rule 5: code-like text is blocked before any request', async () => {
    await refuses({ text: '482913' }, /only a number/);
    await refuses({ text: 'the otp is 482913' }, /OTP/);
  });

  it('normal text with numbers is allowed', async () => {
    const r = await h.call('nod_send', { text: 'New task: find a hotel, budget 5000 rupees, 2 people, Dec 20' });
    expect(r.isError).toBe(false);
    expect(posts()).toHaveLength(1);
  });
});

describe('nod_wait', () => {
  async function send(text = 'New task: find a hotel') {
    const r = await h.call('nod_send', { text });
    expect(r.isError).toBe(false);
    return r.json as { turn_id: string; message_id: string };
  }

  it('running → Nod asks a question (task needs_you)', async () => {
    let t: any;
    let q: any;
    mock.onSend = (_body, created, state) => {
      const ack = message({ turnId: created.turn.id, text: "On it. I'll look for hotels." });
      state.messages.push(ack);
      t = task({ title: 'Find a hotel', messageId: ack.id });
      state.tasks.push(t);
      created.turn.status = 'succeeded';
    };
    mock.onState = (count, state) => {
      if (count === 6 && t) {
        q = message({ text: 'Which dates?', turnId: 'child-turn' });
        state.messages.push(q);
        t.status = 'needs_you';
        t.question = 'Which dates?';
        t.questionMessageId = q.id;
        state.events[t.id] = [{ id: q.id, type: 'message', summary: 'Which dates?', site: null, createdAt: q.createdAt }];
      }
    };
    const sent = await send();
    const r = await h.call('nod_wait', { turn_id: sent.turn_id, timeout_seconds: 45 });
    expect(r.json.status).toBe('question');
    expect(r.json.task.id).toBe(t.id);
    expect(r.json.next).toContain(`reply_to_message_id=${q.id}`);
    expect(r.json.next).toMatch(/only if the user's instructions already cover the answer/);
    expect(r.json.newMessages.map((m: any) => m.text)).toEqual(
      expect.arrayContaining(["<nod-data>On it. I'll look for hotels.</nod-data>", '<nod-data>Which dates?</nod-data>']),
    );
  });

  it('running → succeeded with no task (Nod answered directly)', async () => {
    let created: any;
    mock.onSend = (_b, c) => (created = c);
    mock.onState = (count, state) => {
      if (count === 4) {
        state.messages.push(message({ turnId: created.turn.id, text: 'The top story is X.' }));
        created.turn.status = 'succeeded';
      }
    };
    const sent = await send('New task: top HN story');
    const r = await h.call('nod_wait', { turn_id: sent.turn_id });
    expect(r.json.status).toBe('done');
    expect(r.json.task).toBeUndefined();
    expect(r.json.newMessages.at(-1).text).toBe('<nod-data>The top story is X.</nod-data>');
    expect(r.json.next).toBe('Done. Check the result before reporting it.');
  });

  it('task finishes and closes before the wait sees it', async () => {
    let t: any;
    mock.onSend = (_b, created, state) => {
      const ack = message({ turnId: created.turn.id, text: 'Starting.' });
      state.messages.push(ack);
      t = task({ messageId: ack.id, status: 'done', result: 'Found 3 hotels', closedAt: new Date().toISOString() });
      state.closedTasks.push(t);
      created.turn.status = 'succeeded';
    };
    const sent = await send();
    const r = await h.call('nod_wait', { turn_id: sent.turn_id });
    expect(r.json.status).toBe('done');
    expect(r.json.task.result).toBe('<nod-data>Found 3 hotels</nod-data>');
  });

  it('times out while still running', async () => {
    const sent = await send();
    const started = Date.now();
    const r = await h.call('nod_wait', { turn_id: sent.turn_id, timeout_seconds: 5 });
    expect(r.json.status).toBe('running');
    expect(r.json.next).toMatch(/Still working. Call nod_wait again/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('turn fails', async () => {
    let created: any;
    mock.onSend = (_b, c) => (created = c);
    mock.onState = (count) => {
      if (count === 3) {
        created.turn.status = 'failed';
        created.turn.error = 'The model provider returned an error.';
      }
    };
    const sent = await send();
    const r = await h.call('nod_wait', { turn_id: sent.turn_id });
    expect(r.json.status).toBe('failed');
    expect(r.json.next).toMatch(/^Failed: .*model provider returned an error/);
  });

  it('stops and tells the user when an approval appears', async () => {
    let t: any;
    mock.onSend = (_b, created, state) => {
      const ack = message({ turnId: created.turn.id, text: 'Drafting the email.' });
      state.messages.push(ack);
      t = task({ messageId: ack.id });
      state.tasks.push(t);
      created.turn.status = 'succeeded';
    };
    mock.onState = (count, state) => {
      if (count === 4)
        state.messages.push(
          message({ work: { kind: 'task', id: t.id, title: t.title }, approval: { id: 'a', state: 'pending', title: 'Send email to Bob', app: 'gmail', slug: 's' } }),
        );
    };
    const sent = await send('New task: draft and send the email the user dictated');
    const r = await h.call('nod_wait', { turn_id: sent.turn_id });
    expect(r.json.status).toBe('action_needed');
    expect(r.json.next).toMatch(/User action needed in the Nod app: approve or decline .*Send email to Bob.*Don't answer it through chat/);
  });

  it('follows a task by id', async () => {
    const t = task({ status: 'working' });
    mock.state.tasks.push(t);
    mock.onState = (count) => {
      if (count === 3) {
        t.status = 'scheduled';
        t.nextCheck = '2026-11-18T09:00:00.000Z';
      }
    };
    const r = await h.call('nod_wait', { task_id: t.id });
    expect(r.json.status).toBe('scheduled');
    expect(r.json.next).toContain('2026-11-18T09:00:00.000Z');
  });

  it('needs turn_id or task_id, and limits the timeout to 5–45 seconds', async () => {
    expect((await h.call('nod_wait', {})).isError).toBe(true);
    expect((await h.call('nod_wait', { task_id: '0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c', timeout_seconds: 60 })).isError).toBe(true);
    expect((await h.call('nod_wait', { task_id: '0b6f8b8e-4a39-4c39-9a8c-2a1f4d3e5b6c', timeout_seconds: 2 })).isError).toBe(true);
  });
});

describe('safety rule 8: token never shows up during send and wait', () => {
  it('in results or logs', async () => {
    mock.onSend = (_b, created, state) => {
      state.messages.push(message({ turnId: created.turn.id, text: `echo ${TOKEN}` }));
      created.turn.status = 'succeeded';
    };
    const s = await h.call('nod_send', { text: 'New task: x' });
    await h.call('nod_wait', { turn_id: s.json.turn_id });
    mock.failures.set('/api/messages', { status: 400, error: `bad ${TOKEN}` });
    await h.call('nod_send', { text: 'New task: y' });
    for (const out of [...h.outputs, ...h.logs]) expect(out).not.toContain(TOKEN);
  });
});

