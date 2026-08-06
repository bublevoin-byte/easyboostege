import crypto from 'node:crypto';

const DAY_MS = 86_400_000;
const DUE_DAYS = Object.freeze({ weak: 1, steady: 7, strong: 14 });
const RATING_ORDER = Object.freeze({ weak: 0, steady: 1, strong: 2 });

function pendingQuestions() {
  return Array.from({ length: 4 }, (_, index) => ({
    questionNumber: index + 1,
    status: 'pending',
    recordingDurationSeconds: null,
    localPlayback: false,
    selfRating: null,
    completedAt: null,
  }));
}

export function newSpeakingTask2Session({ username, catalogId, catalogRevision, selection, now = new Date() }) {
  return {
    id: crypto.randomUUID(),
    username,
    catalog_id: catalogId,
    catalog_revision: catalogRevision,
    task_id: selection.task.id,
    task_revision: selection.task.revision,
    selection_reason: selection.reason,
    status: 'assigned',
    current_question: 1,
    questions: pendingQuestions(),
    assigned_at: new Date(now).toISOString(),
    completed_at: null,
    due_at: null,
    self_rating: null,
  };
}

export function applySpeakingTask2QuestionCompletion(session, questionNumber, completion, now = new Date()) {
  const question = session.questions?.[questionNumber - 1];
  if (!question || question.questionNumber !== questionNumber) {
    throw Object.assign(new Error('SPEAKING_TASK2_QUESTION_INVALID'), { code: 'SPEAKING_TASK2_QUESTION_INVALID' });
  }
  if (question.status === 'completed') return session;
  if (session.status === 'completed' || Number(session.current_question) !== questionNumber) {
    throw Object.assign(new Error('SPEAKING_TASK2_QUESTION_OUT_OF_SEQUENCE'), { code: 'SPEAKING_TASK2_QUESTION_OUT_OF_SEQUENCE' });
  }
  const completedAt = new Date(now);
  Object.assign(question, {
    status: 'completed',
    recordingDurationSeconds: completion.recordingDurationSeconds,
    localPlayback: completion.localPlayback,
    selfRating: completion.selfRating,
    completedAt: completedAt.toISOString(),
  });
  if (questionNumber < 4) {
    session.status = 'in_progress';
    session.current_question = questionNumber + 1;
    return session;
  }
  session.status = 'completed';
  session.current_question = 4;
  session.completed_at = completedAt.toISOString();
  session.self_rating = session.questions.reduce((lowest, item) => (
    RATING_ORDER[item.selfRating] < RATING_ORDER[lowest] ? item.selfRating : lowest
  ), 'strong');
  session.due_at = new Date(completedAt.getTime() + DUE_DAYS[session.self_rating] * DAY_MS).toISOString();
  return session;
}

export function publicSpeakingTask2Session(session, task) {
  return {
    id: session.id,
    catalog: { id: session.catalog_id, revision: Number(session.catalog_revision) },
    task,
    selectionReason: session.selection_reason,
    status: session.status,
    currentQuestion: Number(session.current_question),
    questions: session.questions.map((question) => ({
      questionNumber: Number(question.questionNumber),
      status: question.status,
      ...(question.status === 'completed' ? {
        recordingDurationSeconds: Number(question.recordingDurationSeconds),
        localPlayback: Boolean(question.localPlayback),
        selfRating: question.selfRating,
        completedAt: new Date(question.completedAt).toISOString(),
      } : {}),
    })),
    assignedAt: new Date(session.assigned_at).toISOString(),
    completedAt: session.completed_at ? new Date(session.completed_at).toISOString() : null,
    assessment: {
      available: false,
      reason: 'deferred_to_tickets_06_07',
      message: 'Автоматическая оценка появится после подключения и методической проверки в следующих этапах.',
    },
  };
}
