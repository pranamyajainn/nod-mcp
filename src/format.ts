// Output helpers: secret masking, stderr logging, text cutting and untrusted-content quoting.
// Every string the server outputs (tool results, errors, logs) must pass through mask().
import type { Activity, Message, Task } from './schemas.js';

const secrets = new Set<string>();

/** Remember a secret so mask() hides it everywhere. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Replace every registered secret in the string with a fixed placeholder. */
export function mask(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[hidden]');
  return out;
}

export type LogSink = (line: string) => void;
let sink: LogSink = (line) => process.stderr.write(`${line}\n`);

/** Tests can capture log lines. Production writes to stderr only (stdout is the MCP channel). */
export function setLogSink(next: LogSink): void {
  sink = next;
}

export function log(message: string): void {
  sink(mask(`[nod-mcp] ${message}`));
}

/** Cut text to `max` characters and say how much was left out. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [cut: ${text.length - max} more characters]`;
}

export const DATA_OPEN = '<nod-data>';
export const DATA_CLOSE = '</nod-data>';

/**
 * Wrap text that came from Nod (and so may contain text from web pages and emails) in
 * clear markers. Any marker inside the text is broken up so the text can't close the
 * block early and pretend to be outside it.
 */
export function untrusted(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  if (text === '') return '';
  const safe = cut(text, max).replace(/<\/?\s*nod-data\s*>/gi, (tag) => tag.replace('<', '‹'));
  return `${DATA_OPEN}${safe}${DATA_CLOSE}`;
}

/** Turn a result object into the text Claude sees. */
export function render(value: unknown): string {
  return mask(JSON.stringify(value, null, 2));
}

// ---- Short views of Nod objects. All free text from Nod is wrapped with untrusted(). ----

const TITLE_MAX = 300;

export function shortMessage(m: Message, max: number) {
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    turnId: m.turnId,
    text: untrusted(m.text, max),
    ...(m.replyToMessageId ? { replyToMessageId: m.replyToMessageId } : {}),
    ...(m.work ? { work: { kind: m.work.kind, id: m.work.id, title: untrusted(m.work.title, TITLE_MAX) } } : {}),
    // Approvals: only title and state. Never fields or body.
    ...(m.approval ? { approval: { title: untrusted(m.approval.title, TITLE_MAX), state: m.approval.state } } : {}),
    ...(m.answerChoices?.options?.length
      ? {
          answerChoices: m.answerChoices.options.slice(0, 6).map((o) => untrusted(o.label, 200)),
          answerChoicesPending: m.answerChoicesPending ?? false,
        }
      : {}),
  };
}

export function shortTask(t: Task, max: number) {
  return {
    id: t.id,
    title: untrusted(t.title, TITLE_MAX),
    status: t.status,
    now: untrusted(t.now, max),
    result: untrusted(t.result, max),
    question: untrusted(t.question, max),
    questionMessageId: t.questionMessageId ?? null,
    messageId: t.messageId ?? null,
    ...(t.browserHandoff ? { browserHandoff: true } : {}),
    nextCheck: t.nextCheck,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt,
  };
}

export function shortActivity(a: Activity) {
  return {
    turnId: a.turnId,
    taskId: a.taskId,
    title: untrusted(a.title, TITLE_MAX),
    step: untrusted(a.step, TITLE_MAX),
    site: untrusted(a.site, TITLE_MAX),
    doing: a.doing,
    since: a.since,
  };
}
