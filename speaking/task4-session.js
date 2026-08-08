import crypto from 'node:crypto';
import { selectSpeakingTrainingAssignment } from './training-session.js';

const DAY_MS = 86_400_000;
const DUE_DAYS = Object.freeze({ weak: 1, steady: 7, strong: 14 });

export function selectSpeakingTask4Assignment(tasks, sessions, now = new Date()) {
  return selectSpeakingTrainingAssignment(tasks, sessions, now);
}

export function speakingTask4CompletionMetadata(input, now = new Date()) {
  const completedAt = new Date(now);
  return {
    recording_duration_seconds: input.recordingDurationSeconds,
    mic_check: input.micCheck,
    local_playback: input.localPlayback,
    self_rating: input.selfRating,
    completed_at: completedAt.toISOString(),
    due_at: new Date(completedAt.getTime() + DUE_DAYS[input.selfRating] * DAY_MS).toISOString(),
  };
}

export function newSpeakingTask4Session({
  username, catalogId, catalogRevision, selection, accentProfile = null, now = new Date(),
}) {
  return {
    id: crypto.randomUUID(), username, catalog_id: catalogId, catalog_revision: catalogRevision,
    task_id: selection.task.id, task_revision: selection.task.revision,
    selection_reason: selection.reason,
    targeted_practice: selection.targetedPractice || null,
    accent_locale: accentProfile?.locale || null,
    accent_profile_revision: accentProfile?.revision == null ? null : Number(accentProfile.revision),
    accent_effective_at: accentProfile?.effective_at || null,
    status: 'assigned', assigned_at: new Date(now).toISOString(),
    completed_at: null, due_at: null, recording_duration_seconds: null,
    mic_check: null, local_playback: false, self_rating: null,
    assistance_used: false,
  };
}

export function publicSpeakingTask4Session(session, task) {
  return {
    id: session.id,
    catalog: { id: session.catalog_id, revision: Number(session.catalog_revision) },
    task,
    selectionReason: session.selection_reason,
    targetedPractice: session.targeted_practice || null,
    accentProfile: session.accent_locale ? {
      locale: session.accent_locale,
      revision: Number(session.accent_profile_revision),
      effectiveAt: new Date(session.accent_effective_at).toISOString(),
    } : null,
    status: session.status,
    assignedAt: new Date(session.assigned_at).toISOString(),
    completedAt: session.completed_at ? new Date(session.completed_at).toISOString() : null,
    assistanceUsed: Boolean(session.assistance_used),
    practice: session.status === 'completed' ? {
      recordingDurationSeconds: Number(session.recording_duration_seconds),
      micCheck: session.mic_check,
      localPlayback: Boolean(session.local_playback),
      selfRating: session.self_rating,
    } : null,
    assessment: {
      available: false,
      reason: 'deferred_to_tickets_06_07',
      message: 'Automatic assessment will be added after provider and methodology validation in later tickets.',
    },
  };
}
