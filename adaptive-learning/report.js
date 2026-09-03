const REPORT_VERSION = 'adaptive-detailed-report-v1';
const MAX_REPORT_SESSIONS = 12;

function boundedEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.session?.status === 'completed' && entry?.summary)
    .slice(0, MAX_REPORT_SESSIONS);
}

function reportSession(entry) {
  const summary = entry.summary;
  return {
    id: entry.session.id,
    completedAt: entry.session.completedAt,
    durationMinutes: Number(entry.session.durationMinutes),
    completedLearningBlocks: Number(summary.completedLearningBlocks || 0),
    plannedLearningMinutes: Number(summary.plannedLearningMinutes || 0),
    actualLearningMinutes: summary.actualMinutesComplete
      ? Number(summary.actualLearningMinutes || 0) : null,
    planRevisionBefore: Number(summary.planChange?.planRevisionBefore || entry.session.planRevision || 0),
    planRevisionAfter: Number(summary.planChange?.planRevisionAfter || entry.session.planRevision || 0),
    completedWork: (summary.completedWork || []).map((work) => ({
      module: work.module,
      skillId: work.skillId,
      activityLabel: work.activityLabel,
      plannedMinutes: Number(work.plannedMinutes || 0),
      actualMinutes: work.actualMinutes == null ? null : Number(work.actualMinutes),
      evidenceQuality: work.evidenceQuality,
      evidenceContext: work.evidenceContext,
    })),
  };
}

function moduleRows(sessions) {
  const totals = new Map();
  for (const session of sessions) {
    for (const work of session.completedWork) {
      const row = totals.get(work.module) || {
        module: work.module,
        completedBlocks: 0,
        plannedMinutes: 0,
        actualMinutes: 0,
        actualMinutesComplete: true,
        independentEvidence: 0,
        assistedEvidence: 0,
        clientReportedEvidence: 0,
      };
      row.completedBlocks += 1;
      row.plannedMinutes += work.plannedMinutes;
      if (work.actualMinutes == null) row.actualMinutesComplete = false;
      else row.actualMinutes += work.actualMinutes;
      if (work.evidenceQuality === 'server_verified_unassisted') row.independentEvidence += 1;
      else if (work.evidenceQuality === 'server_verified_assisted') row.assistedEvidence += 1;
      else row.clientReportedEvidence += 1;
      totals.set(work.module, row);
    }
  }
  return [...totals.values()].sort((left, right) => left.module.localeCompare(right.module));
}

export function buildAdaptiveDetailedReport({ entries, profile, plan, orientation, generatedAt }) {
  const sessions = boundedEntries(entries).map(reportSession);
  const modules = moduleRows(sessions);
  return {
    version: REPORT_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    scope: { maximumSessions: MAX_REPORT_SESSIONS, includedSessions: sessions.length },
    totals: {
      completedSessions: sessions.length,
      completedLearningBlocks: sessions.reduce((sum, session) => sum + session.completedLearningBlocks, 0),
      plannedLearningMinutes: sessions.reduce((sum, session) => sum + session.plannedLearningMinutes, 0),
      actualLearningMinutes: sessions.every((session) => session.actualLearningMinutes != null)
        ? sessions.reduce((sum, session) => sum + session.actualLearningMinutes, 0) : null,
    },
    profile: {
      status: profile?.status || 'preliminary',
      confidence: Number(profile?.confidence || 0),
      establishedSkillCount: Number(profile?.establishedSkillCount || 0),
      evidenceCount: Number(profile?.evidenceCount || 0),
      independentEvidenceCount: Number(profile?.independentEvidenceCount || 0),
      assistedEvidenceCount: Number(profile?.assistedEvidenceCount || 0),
    },
    forecast: plan?.forecast ? {
      lowScore: plan.forecast.lowScore,
      highScore: plan.forecast.highScore,
      confidence: plan.forecast.confidence,
      requiredWeeklyMinutes: plan.forecast.requiredWeeklyMinutes,
      feasibility: plan.forecast.feasibility,
    } : null,
    modules,
    sessions,
    secondaryOrientation: {
      ...orientation,
      approximate: true,
      officialIeltsResult: false,
      disclaimer: 'Ориентация CEFR/IELTS примерная и не является официальным результатом экзамена или сертификатом.',
    },
  };
}

export { MAX_REPORT_SESSIONS };
