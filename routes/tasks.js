import express from 'express';
import { z } from 'zod';

import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';
import {
  BANK_OPERATIONS, describeForExclusion, isBankOperation, parseTaskContent, readBuiltinTasks, contentHash,
} from '../ai/task-bank.js';

/*
 * Section 10.1: where a student gets a task from.
 *
 * The bank is checked first and only runs out per student, not globally: a task generated for one
 * student stays in the bank and is handed to everyone else who has not seen it. With a growing
 * number of students that turns generation from a per-student cost into a one-off cost per distinct
 * task. A paid call happens only when this particular student has already been through everything
 * the bank holds for that operation.
 */

const nextTaskSchema = z.object({
  operation: z.enum(BANK_OPERATIONS),
}).strict();

export function createTaskRoutes({ authentication, access, db, generateBankTask }) {
  const router = express.Router();
  const { auth } = authentication;
  const { requireActiveSubscription } = access;
  const { claimUnseenBankTask, upsertBankTask, recordTaskDelivery, listBankTaskContents } = db;
  function bindRequiredExpectedOwner(req, res, next) {
    if (req.get('x-easyboost-expected-owner') == null) {
      return res.status(428).json({ error: {
        code: 'CLIENT_UPDATE_REQUIRED',
        message: 'Обновите приложение перед загрузкой новых письменных заданий.',
        requestId: req.requestId,
      } });
    }
    if (!requireExpectedOwner(req, res)) return undefined;
    bindResponseOwner(res, req.user);
    return next();
  }

  router.post('/api/v1/tasks/next', auth, bindRequiredExpectedOwner, requireActiveSubscription, async (req, res, next) => {
    const parsed = nextTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Неизвестный тип задания.', requestId: req.requestId } });
    }
    const { operation } = parsed.data;

    try {
      /* Free path: something in the bank this student has not seen. */
      const fromBank = await claimUnseenBankTask(req.user, operation);
      if (fromBank) {
        return res.json({
          taskId: String(fromBank.id),
          externalId: fromBank.externalId || null,
          task: fromBank.content,
          source: fromBank.source === 'builtin' ? 'builtin' : 'bank',
        });
      }

      /* Paid path: the bank has nothing new for this student, so one task is generated and kept. */
      const existing = await listBankTaskContents(operation, 60);
      const exclude = existing.map((content) => describeForExclusion(operation, content)).filter(Boolean);
      const generated = await generateBankTask({ username: req.user, operation, exclude });

      const content = parseTaskContent(operation, generated.data);
      const taskId = await upsertBankTask({
        operation,
        contentHash: contentHash(operation, content),
        content,
        source: 'generated',
        provider: generated.provider || '',
        promptVersion: generated.promptVersion || '',
      });
      await recordTaskDelivery(req.user, taskId);

      return res.json({ taskId: String(taskId), externalId: null, task: content, source: 'generated' });
    } catch (error) {
      if (error.status && error.code) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
      }
      return next(error);
    }
  });

  return router;
}

/*
 * Built-in tasks are part of the application shell so that section 6.1 keeps working offline, but
 * the server still needs rows for them: without those rows a built-in task has no identifier the
 * client could send, and the bank could not tell that a student has already worked through them.
 * Seeding is keyed on content, so restarting does not duplicate anything.
 */
export async function seedBuiltinTasks(db, { log = console.log } = {}) {
  const tasks = readBuiltinTasks();
  let created = 0;

  for (const task of tasks) {
    if (!isBankOperation(task.operation)) continue;
    const existing = await db.getBankTaskByExternalId(task.externalId);
    if (existing) continue;
    await db.upsertBankTask({
      operation: task.operation,
      externalId: task.externalId,
      contentHash: task.contentHash,
      content: task.content,
      source: 'builtin',
      provider: '',
      promptVersion: 'builtin',
    });
    created += 1;
  }

  if (created) {
    log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      type: 'task_bank_seeded',
      created,
      total: tasks.length,
    }));
  }
  return created;
}
