import crypto from 'node:crypto';
import { selectSpeakingTrainingAssignment } from './training-session.js';

const DAY_MS = 86_400_000;
const DUE_DAYS = Object.freeze({ weak: 1, steady: 7, strong: 14 });

export function selectSpeakingTask1Assignment(tasks, sessions, now = new Date()) {
  return selectSpeakingTrainingAssignment(tasks, sessions, now);
}

export function speakingTask1CompletionMetadata(input, now = new Date()) {
  const completedAt = new Date(now);
  const dueAt = new Date(completedAt.getTime() + DUE_DAYS[input.selfRating] * DAY_MS);
  return {
    recording_duration_seconds: input.recordingDurationSeconds,
    mic_check: input.micCheck,
    local_playback: input.localPlayback,
    self_rating: input.selfRating,
    completed_at: completedAt.toISOString(),
    due_at: dueAt.toISOString(),
  };
}

export function newSpeakingTask1Session({
  username, catalogId, catalogRevision, selection, accentProfile = null,
  calibrationSetupId = null, now = new Date(),
}) {
  return {
    id: crypto.randomUUID(),
    username,
    catalog_id: catalogId,
    catalog_revision: catalogRevision,
    task_id: selection.task.id,
    task_revision: selection.task.revision,
    selection_reason: selection.reason,
    targeted_practice: selection.targetedPractice || null,
    accent_locale: accentProfile?.locale || null,
    accent_profile_revision: accentProfile?.revision == null ? null : Number(accentProfile.revision),
    accent_effective_at: accentProfile?.effective_at || null,
    calibration_setup_id: accentProfile ? null : calibrationSetupId,
    status: 'assigned',
    assigned_at: new Date(now).toISOString(),
    completed_at: null,
    due_at: null,
    recording_duration_seconds: null,
    mic_check: null,
    local_playback: false,
    self_rating: null,
    assistance_used: false,
  };
}

export function publicSpeakingTask1Session(session, task) {
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
    pronunciationAssessment: {
      available: false,
      reason: 'provider_not_connected',
      message: 'Оценка произношения пока не подключена.',
    },
  };
}
