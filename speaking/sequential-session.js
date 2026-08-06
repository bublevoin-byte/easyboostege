import crypto from 'node:crypto';

const DAY_MS = 86_400_000;
const DUE_DAYS = Object.freeze({ weak: 1, steady: 7, strong: 14 });
const RATING_ORDER = Object.freeze({ weak: 0, steady: 1, strong: 2 });

function pendingPositions({ positionCount, positionNumberKey }) {
  return Array.from({ length: positionCount }, (_, index) => ({
    [positionNumberKey]: index + 1,
    status: 'pending',
    recordingDurationSeconds: null,
    localPlayback: false,
    selfRating: null,
    completedAt: null,
  }));
}

export function newSequentialSpeakingSession({
  username, catalogId, catalogRevision, selection, now = new Date(), contract,
}) {
  return {
    id: crypto.randomUUID(),
    username,
    catalog_id: catalogId,
    catalog_revision: catalogRevision,
    task_id: selection.task.id,
    task_revision: selection.task.revision,
    selection_reason: selection.reason,
    status: 'assigned',
    [contract.currentStorageKey]: 1,
    [contract.collectionStorageKey]: pendingPositions(contract),
    assigned_at: new Date(now).toISOString(),
    completed_at: null,
    due_at: null,
    self_rating: null,
  };
}

export function applySequentialSpeakingPositionCompletion(
  session, positionNumber, completion, now = new Date(), contract,
) {
  const positions = session[contract.collectionStorageKey];
  const position = positions?.[positionNumber - 1];
  if (!position || position[contract.positionNumberKey] !== positionNumber) {
    throw Object.assign(new Error(`${contract.errorPrefix}_INVALID`), {
      code: `${contract.errorPrefix}_INVALID`,
    });
  }
  if (position.status === 'completed') return session;
  if (session.status === 'completed' || Number(session[contract.currentStorageKey]) !== positionNumber) {
    throw Object.assign(new Error(`${contract.errorPrefix}_OUT_OF_SEQUENCE`), {
      code: `${contract.errorPrefix}_OUT_OF_SEQUENCE`,
    });
  }
  const completedAt = new Date(now);
  Object.assign(position, {
    status: 'completed',
    recordingDurationSeconds: completion.recordingDurationSeconds,
    localPlayback: completion.localPlayback,
    selfRating: completion.selfRating,
    completedAt: completedAt.toISOString(),
  });
  if (positionNumber < contract.positionCount) {
    session.status = 'in_progress';
    session[contract.currentStorageKey] = positionNumber + 1;
    return session;
  }
  session.status = 'completed';
  session[contract.currentStorageKey] = contract.positionCount;
  session.completed_at = completedAt.toISOString();
  session.self_rating = positions.reduce((lowest, item) => (
    RATING_ORDER[item.selfRating] < RATING_ORDER[lowest] ? item.selfRating : lowest
  ), 'strong');
  session.due_at = new Date(completedAt.getTime() + DUE_DAYS[session.self_rating] * DAY_MS).toISOString();
  return session;
}

export function publicSequentialSpeakingSession(session, task, contract) {
  const positions = session[contract.collectionStorageKey];
  return {
    id: session.id,
    catalog: { id: session.catalog_id, revision: Number(session.catalog_revision) },
    task,
    selectionReason: session.selection_reason,
    status: session.status,
    [contract.currentPublicKey]: Number(session[contract.currentStorageKey]),
    [contract.collectionPublicKey]: positions.map((position) => ({
      [contract.positionNumberKey]: Number(position[contract.positionNumberKey]),
      status: position.status,
      ...(position.status === 'completed' ? {
        recordingDurationSeconds: Number(position.recordingDurationSeconds),
        localPlayback: Boolean(position.localPlayback),
        selfRating: position.selfRating,
        completedAt: new Date(position.completedAt).toISOString(),
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
