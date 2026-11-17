// Shapes of the Nod API fields the bridge uses (checked against Nod commit 3017a94).
// Objects are loose (unknown keys pass through). Status values are strict on purpose:
// a new status means Nod changed and the bridge should say so instead of guessing.
import { z } from 'zod';

export const NOD_COMMIT = '3017a94';

const id = z.string().min(1);
const nullableString = z.string().nullable().optional();

export const turnStatus = z.enum(['queued', 'running', 'succeeded', 'waiting', 'failed', 'cancelled']);
export const taskStatus = z.enum([
  'queued',
  'working',
  'needs_you',
  'waiting',
  'scheduled',
  'failed',
  'done',
  'cancelled',
]);
export const approvalState = z.enum(['pending', 'working', 'done', 'declined', 'expired', 'uncertain']);

export const approvalSchema = z.looseObject({ id, state: approvalState, title: z.string() });

export const messageSchema = z.looseObject({
  id,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  turnId: z.string().nullable(),
  createdAt: z.string(),
  replyToMessageId: nullableString,
  approval: approvalSchema.nullable().optional(),
  work: z.looseObject({ kind: z.string(), id, title: z.string() }).nullable().optional(),
  answerChoices: z
    .looseObject({ options: z.array(z.looseObject({ label: z.string() })) })
    .nullable()
    .optional(),
  answerChoicesPending: z.boolean().optional(),
});

export const turnSchema = z.looseObject({
  id,
  status: turnStatus,
  source: z.string(),
  createdAt: z.string(),
  finishedAt: nullableString,
  error: nullableString,
});

export const taskSchema = z.looseObject({
  id,
  title: z.string(),
  doneWhen: z.string(),
  now: z.string(),
  result: z.string(),
  status: taskStatus,
  question: z.string().nullable(),
  questionMessageId: nullableString,
  browserHandoff: z.boolean().optional(),
  nextCheck: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  messageId: nullableString,
});

export const activitySchema = z.looseObject({
  turnId: id,
  taskId: z.string().nullable(),
  title: z.string().nullable(),
  step: z.string().nullable(),
  site: z.string().nullable(),
  since: z.string(),
  doing: z.enum(['queued', 'model', 'tool']),
});

export const verificationRequestSchema = z.looseObject({ id, turnId: id, kind: z.string() });

export const configurationSchema = z.looseObject({
  provider: z.string(),
  model: z.string(),
  llmReady: z.boolean(),
  modelReconnect: z.boolean().optional(),
  modelIssue: z.unknown().optional(),
});

export const stateSchema = z.looseObject({
  threadId: id,
  tasks: z.array(taskSchema).optional(),
  messages: z.array(messageSchema),
  turns: z.array(turnSchema),
  activity: z.array(activitySchema).optional(),
  verificationRequests: z.array(verificationRequestSchema).optional(),
  configuration: configurationSchema,
});

export const healthSchema = z.looseObject({ ok: z.literal(true) });
export const okSchema = z.looseObject({ ok: z.literal(true) });
export const messagesPageSchema = z.looseObject({ messages: z.array(messageSchema), hasMore: z.boolean() });
export const searchResultsSchema = z.array(messageSchema.extend({ snippet: z.string().nullable().optional() }));
export const aroundSchema = z.array(messageSchema);
export const tasksSchema = z.array(taskSchema);
export const taskDetailSchema = z.looseObject({
  task: taskSchema,
  events: z.array(
    z.looseObject({
      id,
      type: z.string(),
      summary: z.string().nullable(),
      site: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export const submitResponseSchema = z.looseObject({
  threadId: id,
  turnId: id,
  messageId: id,
  verificationStatus: z.string().optional(),
});

export type Message = z.infer<typeof messageSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type AppState = z.infer<typeof stateSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type SubmitResponse = z.infer<typeof submitResponseSchema>;
