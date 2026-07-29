import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/*
 * Section 10.1: the client sends the identifier of a task, never its content.
 *
 * Before this, a student's browser posted the whole assignment back with the answer, so the server
 * had no way to know whether the essay it was paying to mark belonged to the task it was told
 * about. The bank fixes that by owning the tasks: an identifier is all the client needs to send,
 * and the server looks up what that identifier actually means.
 *
 * The bank is shared on purpose. A generated task costs a paid call once and is then available to
 * every student who has not seen it yet, so the bill grows with the number of distinct tasks rather
 * than with the number of students. Generation only happens when a particular student has already
 * been through everything the bank holds.
 *
 * Built-in tasks live in public/task-bank.json — one file, read by the server at startup and
 * shipped to the browser as part of the offline shell, so section 6.1 keeps working without a
 * network and both sides agree on the identifiers.
 */

const BUILTIN_PATH = fileURLToPath(new URL('../public/task-bank.json', import.meta.url));

export const BANK_OPERATIONS = Object.freeze(['writing_task_37', 'writing_task_38']);

/* What a stored task looks like. The shape is the model's output shape, so a generated task can be
   put in the bank without translation, and a built-in one is indistinguishable from a generated one. */
const task37Content = z.object({
  from: z.string().trim().min(1).max(40),
  stim: z.string().trim().min(20).max(1500),
  ask: z.string().trim().min(1).max(120),
}).strict();

const task38Content = z.object({
  topic: z.string().trim().min(1).max(300),
  rows: z.array(z.tuple([z.string().trim().min(1).max(160), z.number().int().min(0).max(100)])).min(3).max(8),
}).strict();

const CONTENT_SCHEMAS = Object.freeze({
  writing_task_37: task37Content,
  writing_task_38: task38Content,
});

export function isBankOperation(operation) {
  return BANK_OPERATIONS.includes(operation);
}

export function parseTaskContent(operation, content) {
  const schema = CONTENT_SCHEMAS[operation];
  if (!schema) throw Object.assign(new Error('UNKNOWN_TASK_OPERATION'), { code: 'UNKNOWN_TASK_OPERATION' });
  const result = schema.safeParse(content);
  if (!result.success) throw Object.assign(new Error('TASK_CONTENT_INVALID'), { code: 'TASK_CONTENT_INVALID' });
  return result.data;
}

/* Two tasks are the same task when their content is the same, whoever produced them. The hash is
   what stops the bank filling up with near-identical copies of one topic. */
export function contentHash(operation, content) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ operation, content: parseTaskContent(operation, content) }))
    .digest('hex');
}

/* The prompt wants a different shape than storage does; the translation lives here so that a task
   from the bank and a task from a migration reach the model identically. */
export function assignmentFor(operation, content) {
  const parsed = parseTaskContent(operation, content);
  if (operation === 'writing_task_37') {
    return { from: parsed.from, stimulus: parsed.stim, questionsTopic: parsed.ask };
  }
  return { topic: parsed.topic, rows: parsed.rows.map(([label, percent]) => ({ label, percent })) };
}

export const TASK_TYPE_FOR_OPERATION = Object.freeze({
  writing_task_37: 'writing_37',
  writing_task_38: 'writing_38',
});

export const OPERATION_FOR_TASK_TYPE = Object.freeze({
  writing_37: 'writing_task_37',
  writing_38: 'writing_task_38',
});

let builtinCache = null;

export function readBuiltinTasks({ reload = false } = {}) {
  if (builtinCache && !reload) return builtinCache;

  const raw = JSON.parse(fs.readFileSync(BUILTIN_PATH, 'utf8'));
  const tasks = [];
  const seen = new Set();

  for (const operation of BANK_OPERATIONS) {
    const entries = Array.isArray(raw[operation]) ? raw[operation] : [];
    for (const entry of entries) {
      const { id, ...content } = entry;
      if (typeof id !== 'string' || !id.startsWith('builtin:')) {
        throw new Error(`task-bank.json: встроенное задание без корректного id в ${operation}`);
      }
      if (seen.has(id)) throw new Error(`task-bank.json: повторяющийся id ${id}`);
      seen.add(id);
      tasks.push({
        externalId: id,
        operation,
        content: parseTaskContent(operation, content),
        contentHash: contentHash(operation, content),
      });
    }
  }

  if (!tasks.length) throw new Error('task-bank.json: встроенных заданий не найдено');
  builtinCache = tasks;
  return tasks;
}

/* A short description of what is already in the bank, so a generation request can ask for something
   else instead of paying for a topic that exists. */
export function describeForExclusion(operation, content) {
  const parsed = parseTaskContent(operation, content);
  return operation === 'writing_task_37' ? `${parsed.from}: ${parsed.ask}` : parsed.topic;
}
