// Checks that run before every send (CLAUDE.md §4 rules 4, 5 and 6).
import { untrusted } from './format.js';
import type { NodClient } from './nod-client.js';
import type { AppState, Message } from './schemas.js';

// ---- Rule 5: refuse text that looks like a verification code, PIN or card security code ----
//
// Two simple checks, run on the text before the tag is added:
// 1. Only a number: after removing spaces, dashes, dots, "!" and one leading "+", the text
//    is 3–10 digits. (Nod itself treats "123 456" as a code, so spaces don't help.)
// 2. A standalone number of 3–8 digits (groups split by spaces or dashes count together) within 40 characters of a code word
//    (code, otp, cvv, cvc, pin, passcode, código, security code, verification, 2fa, one-time).
// Normal text with numbers ("budget 5000 rupees, 2 people, Dec 20") passes.

const CODE_WORD = /(?<![\p{L}\p{N}])(?:codes?|otp|cvv|cvc|pin|passcode|c[oó]digo|security\s+code|verification|verify|2fa|one[-\s]time)(?![\p{L}\p{N}])/giu;
// A number, possibly split into groups by single spaces or dashes ("99 88 77").
const NUMBER = /(?<![\p{L}\p{N}])\d+(?:[ -]\d+)*(?![\p{L}\p{N}])/gu;
const NEAR = 40;

export function codeLikeReason(text: string): string | null {
  const bare = text.trim().replace(/^\+/, '').replace(/[\s\-.!]/g, '');
  if (/^\d{3,10}$/.test(bare)) return 'The message is only a number, which Nod may treat as a verification code or card security code.';
  const words = [...text.matchAll(CODE_WORD)].map((m) => [m.index, m.index + m[0].length] as const);
  if (!words.length) return null;
  for (const n of text.matchAll(NUMBER)) {
    const digits = n[0].replace(/\D/g, '').length;
    if (digits < 3 || digits > 8) continue;
    const [start, end] = [n.index, n.index + n[0].length];
    if (words.some(([ws, we]) => start - we <= NEAR && ws - end <= NEAR))
      return 'The message has a short number next to a word like "code", "OTP", "PIN" or "CVV". Codes must be entered by the user in the Nod app.';
  }
  return null;
}

// ---- Rule 6: visible tag on every outgoing message ----

export function withTag(text: string, tag: string): string {
  if (!tag.trim()) throw new Error('The message tag cannot be empty.');
  return `${tag}${text}`;
}

// ---- Rule 4: check Nod's state right before each send ----

const WAITING_PREFIX = 'Waiting on you in the Nod app:';
const WAITING_SUFFIX = 'Approve or decline it there, then try again.';

/**
 * Returns a refusal message, or null when it is safe to send.
 * (a) any pending approval, (b) any pending verification, (c) a task needing a browser
 * sign-in, (d) the reply target is an approval message, or reaches one in a single step
 * (Nod follows the reply of a turnless assistant message), or can't be found.
 */
export async function preSendCheck(
  client: NodClient,
  state: AppState,
  replyToMessageId: string | undefined,
): Promise<string | null> {
  const reasons: string[] = [];
  for (const m of state.messages)
    if (m.approval?.state === 'pending') reasons.push(`approval "${untrusted(m.approval.title, 200)}"`);
  for (const v of state.verificationRequests ?? [])
    reasons.push(v.kind === 'payment' ? 'a card security code for a payment' : 'a verification code (sign-in)');
  for (const t of state.tasks ?? [])
    if (t.status === 'needs_you' && t.browserHandoff) reasons.push(`a sign-in in Nod's browser for task "${untrusted(t.title, 200)}"`);
  if (reasons.length) return `${WAITING_PREFIX} ${reasons.join('; ')}. ${WAITING_SUFFIX}`;

  if (replyToMessageId) {
    const target = await findMessage(client, state, replyToMessageId);
    if (!target) return 'Refused: the message to reply to was not found in Nod. Check the id with nod_list_tasks or nod_read_messages.';
    if (target.approval)
      return `${WAITING_PREFIX} that message is an approval request ("${untrusted(target.approval.title, 200)}", ${target.approval.state}). Approvals are answered only in the Nod app. ${WAITING_SUFFIX}`;
    if (target.role === 'assistant' && target.turnId === null && target.replyToMessageId) {
      const next = await findMessage(client, state, target.replyToMessageId);
      if (!next) return 'Refused: the message to reply to points to a message that could not be checked. Reply to the task message instead.';
      if (next.approval)
        return `${WAITING_PREFIX} that message is linked to an approval request ("${untrusted(next.approval.title, 200)}"). Approvals are answered only in the Nod app. ${WAITING_SUFFIX}`;
    }
  }
  return null;
}

async function findMessage(client: NodClient, state: AppState, id: string): Promise<Message | undefined> {
  const local = state.messages.find((m) => m.id === id);
  if (local) return local;
  try {
    return (await client.around(id)).find((m) => m.id === id);
  } catch {
    return undefined;
  }
}
