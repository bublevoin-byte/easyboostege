import crypto from 'node:crypto';

import { EGE_SKILL_TAXONOMY } from './profile.js';
import {
  ADAPTIVE_ACTIVITY_DEFINITIONS,
  ADAPTIVE_LAUNCH_CONTRACT_VERSION,
  isAdaptiveLaunchDescriptor,
} from '../public/adaptive-activity-contract.js';

export const ADAPTIVE_SESSION_VERSION = 'adaptive-session-v1';
export const ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION = 'adaptive-composer-v1';
export const ADAPTIVE_CONTENT_REGISTRY_VERSION = 'adaptive-content-v1';

const BREAK_MINUTES = 10;
const MAX_LEARNING_BLOCK_MINUTES = 30;
const REPLACEMENT_REASONS = Object.freeze([
  'too_difficult', 'too_easy', 'not_relevant', 'accessibility', 'excluded',
]);
const SESSION_STATUSES = new Set(['created', 'in_progress', 'completed', 'abandoned']);
const SKILL_BY_ID = new Map(EGE_SKILL_TAXONOMY.skills.map((skill) => [skill.id, skill]));
const PREREQUISITE_POLICY_VERSION = 'adaptive-prerequisite-v1';
const SESSION_REASON_CODES = new Set([
  'due_review', 'prerequisite_support', 'weekly_budget_deficit', 'high_uncertainty_probe',
  'target_gap', 'plan_priority', 'content_coverage_fallback', 'learner_replacement',
  'learner_exclusion',
  ...REPLACEMENT_REASONS.map((reason) => `replacement_${reason}`),
]);

const activities = ADAPTIVE_ACTIVITY_DEFINITIONS.map((definition) => {
  const skill = SKILL_BY_ID.get(definition.skillId);
  return Object.freeze({
    ...definition,
    skillLabel: skill.label,
    module: skill.module,
  });
});

export const ADAPTIVE_ACTIVITY_REGISTRY = Object.freeze({
  version: ADAPTIVE_CONTENT_REGISTRY_VERSION,
  taxonomyVersion: EGE_SKILL_TAXONOMY.version,
  launchContractVersion: ADAPTIVE_LAUNCH_CONTRACT_VERSION,
  activities: Object.freeze(activities),
});

const PREREQUISITES = new Map([
  ['ege.vocabulary.word_formation', ['ege.vocabulary.lexical_choice']],
  ['ege.grammar.transformations', ['ege.grammar.forms']],
  ['ege.reading.detail', ['ege.reading.gist']],
  ['ege.listening.detail', ['ege.listening.gist']],
  ['ege.writing.essay', ['ege.writing.email']],
  ['ege.speaking.monologue', ['ege.speaking.interaction']],
]);

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalSha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function field(value, camel, snake) {
  return value?.[camel] ?? value?.[snake];
}

function iso(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validIso(value) {
  return typeof value === 'string' && iso(value) === value;
}

export function isAdaptiveSessionDuration(value) {
  return Number.isInteger(value) && value >= 15 && value <= 120 && value % 5 === 0;
}

export function isAdaptiveSessionReplacementReason(value) {
  return REPLACEMENT_REASONS.includes(value);
}

export function adaptiveSessionWeekStart(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('ADAPTIVE_SESSION_TIME_INVALID');
  const day = date.getUTCDay();
  const sinceMonday = (day + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString();
}

function apportionWeeklyBudget(plan, weeklyMinutes) {
  const skills = [...(plan?.allocation?.skills || [])].sort((left, right) => left.id.localeCompare(right.id));
  const raw = skills.map((skill) => ({
    id: skill.id,
    exact: weeklyMinutes * Number(skill.percentage || 0) / 100,
  }));
  const budget = raw.map((item) => ({ ...item, minutes: Math.floor(item.exact) }));
  let remaining = weeklyMinutes - budget.reduce((sum, item) => sum + item.minutes, 0);
  budget.sort((left, right) => (
    (right.exact - Math.floor(right.exact)) - (left.exact - Math.floor(left.exact))
      || left.id.localeCompare(right.id)
  ));
  for (let index = 0; index < remaining; index += 1) budget[index % budget.length].minutes += 1;
  return new Map(budget.map((item) => [item.id, item.minutes]));
}

function normalizeUsage(weekUsage = []) {
  const result = new Map();
  for (const item of weekUsage) {
    if (!SKILL_BY_ID.has(item?.skillId)) continue;
    result.set(item.skillId, {
      plannedMinutes: Math.max(0, Math.round(Number(item.plannedMinutes) || 0)),
      completedMinutes: Math.max(0, Math.round(Number(item.completedMinutes) || 0)),
    });
  }
  return result;
}

export function adaptiveActivityRequiresPremiumDepth(activity) {
  return ['writing', 'speaking'].includes(activity?.module)
    && activity?.launch?.kind !== 'voice_tutor_recovery';
}

function materializedActivities(registry, retention) {
  const dueChecks = Array.isArray(retention?.dueChecks) ? retention.dueChecks : [];
  return registry.activities.flatMap((activity) => {
    if (activity.launch?.kind !== 'voice_tutor_recovery') return [activity];
    return dueChecks
      .filter((check) => check?.skillId === activity.skillId && check?.module === activity.module)
      .map((check) => ({
        ...activity,
        contentRef: `voice-tutor-repeat:${check.repeatId}`,
        launch: {
          ...activity.launch,
          repeatId: check.repeatId,
          taskId: check.taskId,
          stage: check.stage,
          status: check.status,
          dueAt: check.dueAt,
          windowEndsAt: check.windowEndsAt,
        },
      }));
  });
}

function eligibleActivities(registry, plan, { profile = null, access = null, retention = null } = {}) {
  if (!registry || registry.version !== ADAPTIVE_CONTENT_REGISTRY_VERSION
    || registry.taxonomyVersion !== field(plan, 'taxonomyVersion', 'taxonomy_version')
    || registry.launchContractVersion !== ADAPTIVE_LAUNCH_CONTRACT_VERSION
    || !Array.isArray(registry.activities)) return [];
  const allocated = new Set((plan?.allocation?.skills || []).filter((skill) => Number(skill.percentage) > 0)
    .map((skill) => skill.id));
  const dueSkills = new Set((profile?.skills || [])
    .filter((skill) => ['due', 'overdue', 'critical_due'].includes(skill.dueState))
    .map((skill) => skill.id));
  const premiumDepth = access?.capabilities?.premiumDepth !== false;
  return materializedActivities(registry, retention).filter((activity) => (
    allocated.has(activity.skillId)
    && SKILL_BY_ID.get(activity.skillId)?.module === activity.module
    && SKILL_BY_ID.get(activity.skillId)?.label === activity.skillLabel
    && isAdaptiveLaunchDescriptor(activity.launch)
    && Number.isInteger(activity.minimumMinutes)
    && activity.minimumMinutes >= 15
    && activity.minimumMinutes <= activity.recommendedMinutes
    && activity.recommendedMinutes <= MAX_LEARNING_BLOCK_MINUTES
    && Number.isInteger(activity.difficulty) && activity.difficulty >= 1 && activity.difficulty <= 5
    && ['visual_text', 'audio', 'written', 'microphone'].includes(activity.modality)
    && typeof activity.requiresAudio === 'boolean'
    && typeof activity.requiresMicrophone === 'boolean'
    && typeof activity.activityId === 'string'
    && typeof activity.activityLabel === 'string'
    && typeof activity.contentRef === 'string'
    && (premiumDepth || !adaptiveActivityRequiresPremiumDepth(activity))
    && (activity.launch.kind !== 'voice_tutor_recovery'
      || dueSkills.has(activity.skillId))
  ));
}

function prerequisiteEvidence(profile, plan, budget, usage) {
  const skills = Array.isArray(profile?.skills) ? profile.skills : [];
  const canonical = skills.length === EGE_SKILL_TAXONOMY.skills.length
    && profile?.taxonomyVersion === EGE_SKILL_TAXONOMY.version
    && profile?.weightingVersion === 'adaptive-evidence-v1'
    && skills.every((skill) => SKILL_BY_ID.has(skill?.id)
      && Number.isInteger(skill.mastery) && skill.mastery >= 0 && skill.mastery <= 100
      && ['unobserved', 'preliminary', 'established'].includes(skill.status));
  if (!canonical) {
    return {
      policyVersion: PREREQUISITE_POLICY_VERSION,
      profileFingerprint: null,
      supported: false,
      skillIds: [],
    };
  }
  const profileBySkill = new Map(skills.map((skill) => [skill.id, skill]));
  const planBySkill = new Map(plan.allocation.skills.map((skill) => [skill.id, skill]));
  const needed = new Set();
  for (const [dependentSkillId, prerequisites] of PREREQUISITES) {
    const dependent = planBySkill.get(dependentSkillId);
    if (!dependent || Number(dependent.percentage) <= 0
      || !(dependent.reasonCodes || []).some((reason) => ['target_gap', 'due_review'].includes(reason))) continue;
    for (const prerequisiteSkillId of prerequisites) {
      const estimate = profileBySkill.get(prerequisiteSkillId);
      const target = budget.get(prerequisiteSkillId) || 0;
      const planned = usage.get(prerequisiteSkillId)?.plannedMinutes || 0;
      if (estimate && estimate.mastery < 60 && target > planned) needed.add(prerequisiteSkillId);
    }
  }
  const vector = [...skills].sort((left, right) => left.id.localeCompare(right.id)).map((skill) => ({
    id: skill.id, mastery: skill.mastery, status: skill.status,
  }));
  return {
    policyVersion: PREREQUISITE_POLICY_VERSION,
    profileFingerprint: sha([
      profile.taxonomyVersion, profile.weightingVersion,
      Number(profile.profileCalculationRevision || 0), profile.evidenceWatermarkVersion || null, vector,
    ]),
    supported: true,
    skillIds: [...needed].sort(),
  };
}

function remainingDeficit(activity, budget, usage) {
  const target = budget.get(activity.skillId) || 0;
  const alreadyPlanned = usage.get(activity.skillId)?.plannedMinutes || 0;
  return Math.max(0, target - alreadyPlanned);
}

function coverageGapSkillIds(plan, available) {
  return (plan?.allocation?.skills || [])
    .filter((skill) => Number(skill.percentage) > 0)
    .filter((skill) => !available.some((activity) => activity.skillId === skill.id))
    .map((skill) => skill.id)
    .sort();
}

function coverageError(plan, available) {
  return Object.assign(new Error('ADAPTIVE_SESSION_COVERAGE_GAP'), {
    code: 'ADAPTIVE_SESSION_COVERAGE_GAP',
    coverageSkillIds: coverageGapSkillIds(plan, available),
  });
}

function priorityContext(plan, available, budget) {
  const executableSkillIds = [...new Set(available.map((activity) => activity.skillId))];
  const planBySkill = new Map(plan.allocation.skills.map((skill) => [skill.id, skill]));
  const fallbackMinutes = new Map(executableSkillIds.map((skillId) => [skillId, 0]));
  const moduleTargets = new Map();
  for (const skill of plan.allocation.skills) {
    const module = SKILL_BY_ID.get(skill.id)?.module;
    moduleTargets.set(module, (moduleTargets.get(module) || 0) + (budget.get(skill.id) || 0));
  }
  for (const gapSkillId of coverageGapSkillIds(plan, available)) {
    const gapModule = SKILL_BY_ID.get(gapSkillId)?.module;
    const sameModule = executableSkillIds.filter((skillId) => SKILL_BY_ID.get(skillId)?.module === gapModule);
    const recipients = sameModule.length ? sameModule : executableSkillIds;
    const recipient = [...recipients].sort((left, right) => (
      Number(planBySkill.get(right)?.percentage || 0) - Number(planBySkill.get(left)?.percentage || 0)
      || left.localeCompare(right)
    ))[0];
    if (!recipient) continue;
    const fallback = budget.get(gapSkillId) || 0;
    fallbackMinutes.set(recipient, (fallbackMinutes.get(recipient) || 0) + fallback);
    const recipientModule = SKILL_BY_ID.get(recipient)?.module;
    if (recipientModule !== gapModule) {
      moduleTargets.set(gapModule, Math.max(0, (moduleTargets.get(gapModule) || 0) - fallback));
      moduleTargets.set(recipientModule, (moduleTargets.get(recipientModule) || 0) + fallback);
    }
  }
  return { fallbackMinutes, moduleTargets };
}

function modulePlannedMinutes(module, usage) {
  let total = 0;
  for (const [skillId, value] of usage) {
    if (SKILL_BY_ID.get(skillId)?.module === module) total += Number(value?.plannedMinutes || 0);
  }
  return total;
}

function servicePriorityScore(activity, budget, usage, priority) {
  const target = (budget.get(activity.skillId) || 0)
    + (priority.fallbackMinutes.get(activity.skillId) || 0);
  const planned = usage.get(activity.skillId)?.plannedMinutes || 0;
  const skillRatio = target > 0 ? (target - planned) / target : -planned;
  const moduleTarget = priority.moduleTargets.get(activity.module) || 0;
  const modulePlanned = modulePlannedMinutes(activity.module, usage);
  const moduleRatio = moduleTarget > 0 ? (moduleTarget - modulePlanned) / moduleTarget : -modulePlanned;
  return Math.round(moduleRatio * 100_000) + Math.round(skillRatio * 10_000);
}

function candidateScore(activity, planSkill, budget, usage, prerequisiteSkillIds, scheduledSkills, priority) {
  const alreadyPlanned = usage.get(activity.skillId)?.plannedMinutes || 0;
  const exactRetention = activity.launch.kind === 'voice_tutor_recovery';
  const due = exactRetention || ((planSkill.reasonCodes || []).includes('due_review')
    && alreadyPlanned === 0 && !scheduledSkills.has(activity.skillId))
    ? 1 : 0;
  const effectiveTarget = (budget.get(activity.skillId) || 0)
    + (priority.fallbackMinutes.get(activity.skillId) || 0);
  const prerequisite = prerequisiteSkillIds.has(activity.skillId)
    && alreadyPlanned < effectiveTarget && !scheduledSkills.has(activity.skillId) ? 1 : 0;
  const retentionUrgency = exactRetention
    ? Number(activity.launch.status === 'critical_due') * 2 + Number(activity.launch.stage === 'day_1')
    : 0;
  if (exactRetention) return 10_000_000 + retentionUrgency * 100_000;
  return prerequisite * 2_000_000 + due * 1_000_000
    + retentionUrgency * 100_000
    + servicePriorityScore(activity, budget, usage, priority) + Number(planSkill.percentage || 0)
    + (planSkill.activityType === 'diagnostic_probe' ? 1 : 0);
}

function reasonsFor(activity, planSkill, budget, usage, prerequisiteSkillIds, scheduledSkills,
  priority, plannedMinutes) {
  const reasons = [];
  const alreadyPlanned = usage.get(activity.skillId)?.plannedMinutes || 0;
  if (activity.launch.kind === 'voice_tutor_recovery'
    || ((planSkill.reasonCodes || []).includes('due_review')
      && alreadyPlanned === 0 && !scheduledSkills.has(activity.skillId))) reasons.push('due_review');
  const deficit = remainingDeficit(activity, budget, usage);
  const effectiveTarget = (budget.get(activity.skillId) || 0)
    + (priority.fallbackMinutes.get(activity.skillId) || 0);
  if (prerequisiteSkillIds.has(activity.skillId) && alreadyPlanned < effectiveTarget
    && !scheduledSkills.has(activity.skillId)) reasons.push('prerequisite_support');
  if (deficit > 0) reasons.push('weekly_budget_deficit');
  if ((priority.fallbackMinutes.get(activity.skillId) || 0) > 0
    && alreadyPlanned + plannedMinutes > (budget.get(activity.skillId) || 0)) {
    reasons.push('content_coverage_fallback');
  }
  if (planSkill.activityType === 'diagnostic_probe') reasons.push('high_uncertainty_probe');
  if ((planSkill.reasonCodes || []).includes('target_gap')) reasons.push('target_gap');
  if (!reasons.length) reasons.push('plan_priority');
  return reasons;
}

function composeLearningBlocks({
  plan, activities: available, budget, usage, learningMinutes, prerequisiteSkillIds,
}) {
  const planBySkill = new Map(plan.allocation.skills.map((skill) => [skill.id, skill]));
  const priority = priorityContext(plan, available, budget);
  const failedStates = new Set();
  const search = (remaining, currentUsage, scheduledSkills, scheduledRetentionRefs, previous) => {
    if (remaining === 0) return [];
    const stateKey = JSON.stringify([
      remaining,
      previous?.contentRef || null,
      [...scheduledSkills].sort(),
      [...scheduledRetentionRefs].sort(),
      [...new Set(available.map((activity) => activity.skillId))].sort().map((skillId) => {
        const activity = available.find((item) => item.skillId === skillId);
        return [skillId, currentUsage.get(activity.skillId)?.plannedMinutes || 0];
      }),
    ]);
    if (failedStates.has(stateKey)) return null;
    const candidates = available.filter((activity) => (
      activity.contentRef !== previous?.contentRef
      && (activity.launch.kind !== 'voice_tutor_recovery'
        || !scheduledRetentionRefs.has(activity.contentRef))
      && activity.minimumMinutes <= remaining
    )).sort((left, right) => (
      candidateScore(right, planBySkill.get(right.skillId), budget, currentUsage,
        prerequisiteSkillIds, scheduledSkills, priority)
        - candidateScore(left, planBySkill.get(left.skillId), budget, currentUsage,
          prerequisiteSkillIds, scheduledSkills, priority)
      || Number(right.module !== previous?.module) - Number(left.module !== previous?.module)
      || left.skillId.localeCompare(right.skillId)
      || left.contentRef.localeCompare(right.contentRef)
    ));
    for (const chosen of candidates) {
      const maximum = Math.min(MAX_LEARNING_BLOCK_MINUTES, remaining);
      const minuteOptions = Array.from({ length: maximum - chosen.minimumMinutes + 1 }, (_, index) => (
        chosen.minimumMinutes + index
      )).sort((left, right) => (
        Math.abs(left - chosen.recommendedMinutes) - Math.abs(right - chosen.recommendedMinutes)
        || right - left
      ));
      for (const minutes of minuteOptions) {
        const nextRemaining = remaining - minutes;
        const nextUsage = new Map([...currentUsage].map(([skillId, value]) => [skillId, { ...value }]));
        const current = nextUsage.get(chosen.skillId) || { plannedMinutes: 0, completedMinutes: 0 };
        nextUsage.set(chosen.skillId, { ...current, plannedMinutes: current.plannedMinutes + minutes });
        if (nextRemaining > 0 && !available.some((activity) => (
          activity.contentRef !== chosen.contentRef
          && activity.minimumMinutes <= nextRemaining
        ))) continue;
        const nextScheduled = new Set(scheduledSkills).add(chosen.skillId);
        const nextRetentionRefs = new Set(scheduledRetentionRefs);
        if (chosen.launch.kind === 'voice_tutor_recovery') {
          nextRetentionRefs.add(chosen.contentRef);
        }
        const tail = search(nextRemaining, nextUsage, nextScheduled, nextRetentionRefs, chosen);
        if (tail) return [{
          kind: 'learning', module: chosen.module, skillId: chosen.skillId,
          skillLabel: chosen.skillLabel, activityId: chosen.activityId,
          activityLabel: chosen.activityLabel, contentRef: chosen.contentRef,
          difficulty: chosen.difficulty, modality: chosen.modality,
          requiresAudio: chosen.requiresAudio, requiresMicrophone: chosen.requiresMicrophone,
          launch: structuredClone(chosen.launch), plannedMinutes: minutes,
          reasonCodes: reasonsFor(chosen, planBySkill.get(chosen.skillId), budget, currentUsage,
            prerequisiteSkillIds, scheduledSkills, priority, minutes),
        }, ...tail];
      }
    }
    failedStates.add(stateKey);
    return null;
  };
  const initialUsage = new Map([...usage].map(([skillId, value]) => [skillId, { ...value }]));
  const blocks = search(learningMinutes, initialUsage, new Set(), new Set(), null);
  if (!blocks) throw coverageError(plan, available);
  return blocks;
}

function insertBreak(blocks, learningMinutes) {
  let elapsed = 0;
  let index = blocks.length;
  for (let current = 0; current < blocks.length - 1; current += 1) {
    elapsed += blocks[current].plannedMinutes;
    if (elapsed >= learningMinutes / 2) {
      index = current + 1;
      break;
    }
  }
  blocks.splice(index, 0, {
    kind: 'break', module: null, skillId: null, skillLabel: null,
    activityId: null, activityLabel: null, contentRef: null,
    difficulty: null, modality: null, requiresAudio: null, requiresMicrophone: null,
    launch: null, plannedMinutes: BREAK_MINUTES, reasonCodes: ['scheduled_break'],
  });
}

function budgetSnapshot(plan, weeklyMinutes, budget, usage, blocks, prerequisite, available) {
  const selected = new Map();
  for (const block of blocks.filter((item) => item.kind === 'learning')) {
    selected.set(block.skillId, (selected.get(block.skillId) || 0) + block.plannedMinutes);
  }
  return {
    weeklyAvailableMinutes: weeklyMinutes,
    coverageGaps: coverageGapSkillIds(plan, available),
    prerequisiteEvidence: structuredClone(prerequisite),
    skills: [...plan.allocation.skills].sort((left, right) => left.id.localeCompare(right.id)).map((skill) => {
      const current = usage.get(skill.id) || { plannedMinutes: 0, completedMinutes: 0 };
      const targetMinutes = budget.get(skill.id) || 0;
      return {
        skillId: skill.id, targetMinutes,
        plannedBeforeMinutes: current.plannedMinutes,
        completedBeforeMinutes: current.completedMinutes,
        deficitBeforeMinutes: Math.max(0, targetMinutes - current.plannedMinutes),
        selectedMinutes: selected.get(skill.id) || 0,
      };
    }),
  };
}

function previewFingerprintBlocks(blocks) {
  return (blocks || []).map((block) => {
    const value = structuredClone(block);
    delete value.id;
    delete value.position;
    return value;
  });
}

export function adaptiveSessionPreviewFingerprint(value) {
  return canonicalSha([
    value?.composerPolicyVersion,
    value?.contentRegistryVersion,
    value?.taxonomyVersion,
    value?.planId,
    Number(value?.planRevision),
    value?.weekStart,
    Number(value?.durationMinutes),
    value?.weeklyBudgetSnapshot,
    previewFingerprintBlocks(value?.blocks),
  ]);
}

export function buildAdaptiveSessionPreview({
  plan,
  goal,
  profile,
  weekUsage = [],
  durationMinutes,
  now,
  registry = ADAPTIVE_ACTIVITY_REGISTRY,
  access = null,
  retention = null,
}) {
  if (!isAdaptiveSessionDuration(durationMinutes)) {
    throw Object.assign(new Error('ADAPTIVE_SESSION_DURATION_INVALID'), {
      code: 'ADAPTIVE_SESSION_DURATION_INVALID',
    });
  }
  const planId = plan?.id;
  const planRevision = Number(plan?.revision);
  const taxonomyVersion = field(plan, 'taxonomyVersion', 'taxonomy_version');
  const weeklyMinutes = Number(field(goal, 'weeklyMinutes', 'weekly_minutes'));
  if (typeof planId !== 'string' || !Number.isInteger(planRevision) || planRevision < 1
    || taxonomyVersion !== EGE_SKILL_TAXONOMY.version
    || !Number.isInteger(weeklyMinutes) || weeklyMinutes < 30) {
    throw new Error('ADAPTIVE_SESSION_PLAN_INVALID');
  }
  const available = eligibleActivities(registry, plan, { profile, access, retention });
  const breakMinutes = durationMinutes > 60 ? BREAK_MINUTES : 0;
  const learningMinutes = durationMinutes - breakMinutes;
  const budget = apportionWeeklyBudget(plan, weeklyMinutes);
  const usage = normalizeUsage(weekUsage);
  const prerequisite = prerequisiteEvidence(profile, plan, budget, usage);
  const prerequisiteSkillIds = new Set(prerequisite.skillIds);
  const blocks = composeLearningBlocks({
    plan, activities: available, budget, usage, learningMinutes, prerequisiteSkillIds,
  });
  if (breakMinutes) insertBreak(blocks, learningMinutes);
  const weekStart = adaptiveSessionWeekStart(now);
  const snapshot = budgetSnapshot(plan, weeklyMinutes, budget, usage, blocks, prerequisite, available);
  const fingerprint = adaptiveSessionPreviewFingerprint({
    composerPolicyVersion: ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION,
    contentRegistryVersion: registry.version,
    taxonomyVersion,
    planId,
    planRevision,
    weekStart,
    durationMinutes,
    weeklyBudgetSnapshot: snapshot,
    blocks,
  });
  const ordered = blocks.map((block, position) => ({
    id: `asb_${fingerprint.slice(0, 16)}_${String(position + 1).padStart(2, '0')}`,
    position: position + 1,
    ...block,
  }));
  return {
    version: ADAPTIVE_SESSION_VERSION,
    composerPolicyVersion: ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION,
    contentRegistryVersion: registry.version,
    taxonomyVersion,
    previewFingerprint: fingerprint,
    planId,
    planRevision,
    weekStart,
    durationMinutes,
    learningMinutes,
    breakMinutes,
    weeklyBudgetSnapshot: snapshot,
    blocks: ordered,
  };
}

export function createAdaptiveLearningSessionFromPreview(preview, { id, now }) {
  const createdAt = iso(now);
  const first = preview.blocks.find((block) => block.kind === 'learning');
  const session = {
    id,
    sessionVersion: preview.version,
    revision: 1,
    planId: preview.planId,
    planRevision: preview.planRevision,
    previewFingerprint: preview.previewFingerprint,
    composerPolicyVersion: preview.composerPolicyVersion,
    contentRegistryVersion: preview.contentRegistryVersion,
    taxonomyVersion: preview.taxonomyVersion,
    weekStart: preview.weekStart,
    durationMinutes: preview.durationMinutes,
    learningMinutes: preview.learningMinutes,
    breakMinutes: preview.breakMinutes,
    weeklyBudgetSnapshot: structuredClone(preview.weeklyBudgetSnapshot),
    blocks: structuredClone(preview.blocks),
    status: 'created',
    currentBlockId: first?.id || null,
    completedLearningMinutes: 0,
    replacement: null,
    createdAt,
    updatedAt: createdAt,
  };
  assertAdaptiveLearningSession(session);
  return session;
}

function replacementCandidates(session, plan, target, reason, registry, access, profile, retention) {
  const targetIndex = session.blocks.findIndex((block) => block.id === target.id);
  const previous = session.blocks.slice(0, targetIndex).reverse()
    .find((block) => block.kind === 'learning');
  const next = session.blocks.slice(targetIndex + 1)
    .find((block) => block.kind === 'learning');
  const available = eligibleActivities(registry, plan, { access, profile, retention });
  const budget = new Map(session.weeklyBudgetSnapshot.skills.map((skill) => (
    [skill.skillId, skill.targetMinutes]
  )));
  const usage = new Map(session.weeklyBudgetSnapshot.skills.map((skill) => (
    [skill.skillId, {
      plannedMinutes: skill.plannedBeforeMinutes + skill.selectedMinutes
        - (skill.skillId === target.skillId ? target.plannedMinutes : 0),
    }]
  )));
  const priority = priorityContext(plan, available, budget);
  const serviceScore = (activity) => servicePriorityScore(activity, budget, usage, priority);
  return available
    .filter((activity) => activity.contentRef !== target.contentRef
      && activity.minimumMinutes <= target.plannedMinutes
      && activity.contentRef !== (previous?.kind === 'learning' ? previous.contentRef : null)
      && activity.contentRef !== (next?.kind === 'learning' ? next.contentRef : null)
      && (reason !== 'too_difficult' || activity.difficulty < target.difficulty)
      && (reason !== 'too_easy' || activity.difficulty > target.difficulty)
      && (reason !== 'accessibility' || (
        activity.modality !== target.modality
        && activity.requiresAudio === false
        && activity.requiresMicrophone === false
      ))
      && (!['not_relevant', 'excluded'].includes(reason) || activity.skillId !== target.skillId))
    .sort((left, right) => {
      if (reason === 'too_difficult') return right.difficulty - left.difficulty
        || serviceScore(right) - serviceScore(left)
        || left.skillId.localeCompare(right.skillId);
      if (reason === 'too_easy') return left.difficulty - right.difficulty
        || serviceScore(right) - serviceScore(left)
        || left.skillId.localeCompare(right.skillId);
      return serviceScore(right) - serviceScore(left)
      || left.skillId.localeCompare(right.skillId);
    });
}

export function buildAdaptiveSessionReplacement({
  session,
  plan,
  blockId,
  reason,
  now,
  registry = ADAPTIVE_ACTIVITY_REGISTRY,
  access = null,
  profile = null,
  retention = null,
}) {
  assertAdaptiveLearningSession(session);
  if (session.replacement || Number(session.revision) !== 1) throw new Error('ADAPTIVE_SESSION_REPLACEMENT_ALREADY_USED');
  if (!isAdaptiveSessionReplacementReason(reason)) throw new Error('ADAPTIVE_SESSION_REPLACEMENT_REASON_INVALID');
  const target = session.blocks.find((block) => block.id === blockId);
  if (!target || target.kind !== 'learning') throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_FOUND');
  const available = eligibleActivities(registry, plan, { profile, access, retention });
  const replacementBudget = new Map(session.weeklyBudgetSnapshot.skills.map((skill) => (
    [skill.skillId, skill.targetMinutes]
  )));
  const replacementUsage = new Map(session.weeklyBudgetSnapshot.skills.map((skill) => (
    [skill.skillId, {
      plannedMinutes: skill.plannedBeforeMinutes + skill.selectedMinutes
        - (skill.skillId === target.skillId ? target.plannedMinutes : 0),
    }]
  )));
  const replacementPriority = priorityContext(plan, available, replacementBudget);
  for (const replacement of replacementCandidates(
    session, plan, target, reason, registry, access, profile, retention,
  )) {
    const next = structuredClone(session);
    const targetIndex = next.blocks.findIndex((block) => block.id === blockId);
    next.blocks[targetIndex] = {
      ...next.blocks[targetIndex],
      module: replacement.module,
      skillId: replacement.skillId,
      skillLabel: replacement.skillLabel,
      activityId: replacement.activityId,
      activityLabel: replacement.activityLabel,
      contentRef: replacement.contentRef,
      difficulty: replacement.difficulty,
      modality: replacement.modality,
      requiresAudio: replacement.requiresAudio,
      requiresMicrophone: replacement.requiresMicrophone,
      launch: structuredClone(replacement.launch),
      reasonCodes: [
        reason === 'excluded' ? 'learner_exclusion' : 'learner_replacement',
        `replacement_${reason}`,
        ...(remainingDeficit(replacement, replacementBudget, replacementUsage) > 0
          ? ['weekly_budget_deficit'] : []),
        ...((replacementPriority.fallbackMinutes.get(replacement.skillId) || 0) > 0
          && (replacementUsage.get(replacement.skillId)?.plannedMinutes || 0) + target.plannedMinutes
            > (replacementBudget.get(replacement.skillId) || 0)
          ? ['content_coverage_fallback'] : []),
      ],
    };
    const oldBudget = next.weeklyBudgetSnapshot.skills.find((skill) => skill.skillId === target.skillId);
    const newBudget = next.weeklyBudgetSnapshot.skills.find((skill) => skill.skillId === replacement.skillId);
    if (oldBudget) oldBudget.selectedMinutes -= target.plannedMinutes;
    if (newBudget) newBudget.selectedMinutes += target.plannedMinutes;
    next.revision = 2;
    next.replacement = {
      blockId,
      reason,
      replacedSkillId: target.skillId,
      replacedActivityId: target.activityId,
      replacedContentRef: target.contentRef,
      replacedAt: iso(now),
    };
    next.updatedAt = iso(now);
    try {
      assertAdaptiveLearningSession(next);
      assertAdaptiveSessionReplacementTransition(session, {
        sessionId: session.id,
        expectedRevision: session.revision,
        blockId,
        reason,
        idempotencyKey: 'internal-transition-check',
        requestHash: '0'.repeat(64),
        session: next,
        now,
      }, { validateEnvelope: false });
      return next;
    } catch (error) {
      if (error?.message !== 'ADAPTIVE_SESSION_INVALID') throw error;
    }
  }
  throw Object.assign(new Error('ADAPTIVE_SESSION_NO_REPLACEMENT'), {
    code: 'ADAPTIVE_SESSION_NO_REPLACEMENT',
  });
}

export function assertAdaptiveSessionCreateCandidate(candidate) {
  const requiredKeys = [
    'idempotencyKey', 'now', 'planId', 'planRevision', 'previewFingerprint', 'requestHash', 'session',
  ];
  const allowedKeys = new Set([...requiredKeys, 'commercialMode', 'commercialScope']);
  const candidateKeys = candidate && typeof candidate === 'object' ? Object.keys(candidate) : [];
  if (requiredKeys.some((key) => !Object.hasOwn(candidate || {}, key))
    || candidateKeys.some((key) => !allowedKeys.has(key))
    || (candidate.commercialMode !== undefined && candidate.commercialMode !== 'free_demo')
    || (candidate.commercialScope !== undefined
      && !['free_demo', 'base', 'premium'].includes(candidate.commercialScope))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/u.test(candidate.idempotencyKey)
    || !/^[0-9a-f]{64}$/u.test(candidate.requestHash)
    || !/^[0-9a-f]{64}$/u.test(candidate.previewFingerprint)
    || candidate.session?.previewFingerprint !== candidate.previewFingerprint
    || candidate.session?.planId !== candidate.planId
    || Number(candidate.session?.planRevision) !== Number(candidate.planRevision)
    || adaptiveSessionPreviewFingerprint(candidate.session) !== candidate.previewFingerprint
    || candidate.session?.createdAt !== iso(candidate.now)
    || candidate.session?.updatedAt !== iso(candidate.now)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  assertAdaptiveLearningSession(candidate.session);
  return true;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function equalValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

export function assertAdaptiveSessionReplacementTransition(previousValue, candidate, {
  validateEnvelope = true,
} = {}) {
  const previous = structuredClone(previousValue);
  const next = candidate?.session;
  if ((validateEnvelope && !exactKeys(candidate, [
    'blockId', 'expectedRevision', 'idempotencyKey', 'now', 'reason', 'requestHash', 'session', 'sessionId',
  ])) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/u.test(candidate?.idempotencyKey)
    || !/^[0-9a-f]{64}$/u.test(candidate?.requestHash)
    || !isAdaptiveSessionReplacementReason(candidate?.reason)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  assertAdaptiveLearningSession(previous);
  assertAdaptiveLearningSession(next);
  const immutableFields = [
    'breakMinutes', 'completedLearningMinutes', 'composerPolicyVersion', 'contentRegistryVersion',
    'createdAt', 'currentBlockId', 'durationMinutes', 'id', 'learningMinutes', 'planId',
    'planRevision', 'previewFingerprint', 'sessionVersion', 'status', 'taxonomyVersion', 'weekStart',
  ];
  if (candidate.sessionId !== previous.id || next.id !== previous.id
    || Number(candidate.expectedRevision) !== Number(previous.revision)
    || previous.revision !== 1 || previous.replacement !== null || next.revision !== 2
    || immutableFields.some((fieldName) => !equalValue(previous[fieldName], next[fieldName]))
    || next.updatedAt !== iso(candidate.now)
    || new Date(next.updatedAt) < new Date(previous.updatedAt)
    || previous.blocks.length !== next.blocks.length) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  const changed = [];
  for (let index = 0; index < previous.blocks.length; index += 1) {
    const before = previous.blocks[index];
    const after = next.blocks[index];
    if (!equalValue(before, after)) changed.push({ before, after });
  }
  if (changed.length !== 1) throw new Error('ADAPTIVE_SESSION_INVALID');
  const { before, after } = changed[0];
  if (before.id !== candidate.blockId || after.id !== before.id || before.kind !== 'learning'
    || after.kind !== 'learning' || after.position !== before.position
    || after.plannedMinutes !== before.plannedMinutes || after.contentRef === before.contentRef
    || next.replacement?.blockId !== before.id || next.replacement?.reason !== candidate.reason
    || next.replacement?.replacedSkillId !== before.skillId
    || next.replacement?.replacedActivityId !== before.activityId
    || next.replacement?.replacedContentRef !== before.contentRef
    || next.replacement?.replacedAt !== next.updatedAt
    || !after.reasonCodes.includes(candidate.reason === 'excluded'
      ? 'learner_exclusion' : 'learner_replacement')
    || !after.reasonCodes.includes(`replacement_${candidate.reason}`)
    || (candidate.reason === 'too_difficult' && !(after.difficulty < before.difficulty))
    || (candidate.reason === 'too_easy' && !(after.difficulty > before.difficulty))
    || (candidate.reason === 'accessibility' && !(
      after.modality !== before.modality && !after.requiresAudio && !after.requiresMicrophone
    ))
    || (['not_relevant', 'excluded'].includes(candidate.reason)
      && after.skillId === before.skillId)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  const previousBudget = previous.weeklyBudgetSnapshot;
  const nextBudget = next.weeklyBudgetSnapshot;
  if (previousBudget.weeklyAvailableMinutes !== nextBudget.weeklyAvailableMinutes
    || !equalValue(previousBudget.coverageGaps, nextBudget.coverageGaps)
    || !equalValue(previousBudget.prerequisiteEvidence, nextBudget.prerequisiteEvidence)
    || previousBudget.skills.length !== nextBudget.skills.length) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  for (let index = 0; index < previousBudget.skills.length; index += 1) {
    const oldSkill = previousBudget.skills[index];
    const newSkill = nextBudget.skills[index];
    for (const fieldName of [
      'skillId', 'targetMinutes', 'plannedBeforeMinutes', 'completedBeforeMinutes', 'deficitBeforeMinutes',
    ]) if (!equalValue(oldSkill[fieldName], newSkill[fieldName])) throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  return true;
}

export function assertAdaptiveLearningSession(session) {
  if (!exactKeys(session, [
    'blocks', 'breakMinutes', 'completedLearningMinutes', 'composerPolicyVersion',
    'contentRegistryVersion', 'createdAt', 'currentBlockId', 'durationMinutes', 'id',
    'learningMinutes', 'planId', 'planRevision', 'previewFingerprint', 'replacement',
    'revision', 'sessionVersion', 'status', 'taxonomyVersion', 'updatedAt', 'weekStart',
    'weeklyBudgetSnapshot',
  ]) || session.sessionVersion !== ADAPTIVE_SESSION_VERSION
    || session.composerPolicyVersion !== ADAPTIVE_SESSION_COMPOSER_POLICY_VERSION
    || session.contentRegistryVersion !== ADAPTIVE_CONTENT_REGISTRY_VERSION
    || session.taxonomyVersion !== EGE_SKILL_TAXONOMY.version
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(session.id)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(session.planId)
    || !Number.isInteger(session.planRevision) || session.planRevision < 1
    || !/^[0-9a-f]{64}$/u.test(session.previewFingerprint)
    || !validIso(session.weekStart) || adaptiveSessionWeekStart(session.weekStart) !== session.weekStart
    || !validIso(session.createdAt) || !validIso(session.updatedAt)
    || new Date(session.updatedAt) < new Date(session.createdAt)
    || !isAdaptiveSessionDuration(session.durationMinutes)
    || !Number.isInteger(session.learningMinutes) || !Number.isInteger(session.breakMinutes)
    || session.learningMinutes + session.breakMinutes !== session.durationMinutes
    || session.breakMinutes !== (session.durationMinutes > 60 ? BREAK_MINUTES : 0)
    || !SESSION_STATUSES.has(session.status)
    || !Number.isInteger(session.revision) || ![1, 2].includes(session.revision)
    || !Number.isInteger(session.completedLearningMinutes) || session.completedLearningMinutes < 0
    || session.completedLearningMinutes > session.learningMinutes
    || !Array.isArray(session.blocks) || !session.blocks.length
    || session.blocks.reduce((sum, block) => sum + block.plannedMinutes, 0) !== session.durationMinutes
    || session.blocks.filter((block) => block.kind === 'break').length !== (session.breakMinutes ? 1 : 0)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  if (!exactKeys(session.weeklyBudgetSnapshot, [
    'coverageGaps', 'prerequisiteEvidence', 'skills', 'weeklyAvailableMinutes',
  ])
    || !Number.isInteger(session.weeklyBudgetSnapshot.weeklyAvailableMinutes)
    || session.weeklyBudgetSnapshot.weeklyAvailableMinutes < 30
    || session.weeklyBudgetSnapshot.weeklyAvailableMinutes > 2520
    || !Array.isArray(session.weeklyBudgetSnapshot.skills)
    || session.weeklyBudgetSnapshot.skills.length !== EGE_SKILL_TAXONOMY.skills.length) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  if (!Array.isArray(session.weeklyBudgetSnapshot.coverageGaps)
    || session.weeklyBudgetSnapshot.coverageGaps.some((skillId) => !SKILL_BY_ID.has(skillId))
    || new Set(session.weeklyBudgetSnapshot.coverageGaps).size
      !== session.weeklyBudgetSnapshot.coverageGaps.length
    || !equalValue(session.weeklyBudgetSnapshot.coverageGaps,
      [...session.weeklyBudgetSnapshot.coverageGaps].sort())) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  const prerequisite = session.weeklyBudgetSnapshot.prerequisiteEvidence;
  if (!exactKeys(prerequisite, [
    'policyVersion', 'profileFingerprint', 'skillIds', 'supported',
  ]) || prerequisite.policyVersion !== PREREQUISITE_POLICY_VERSION
    || typeof prerequisite.supported !== 'boolean'
    || (prerequisite.supported
      ? !/^[0-9a-f]{64}$/u.test(prerequisite.profileFingerprint)
      : prerequisite.profileFingerprint !== null)
    || !Array.isArray(prerequisite.skillIds)
    || prerequisite.skillIds.some((skillId) => !SKILL_BY_ID.has(skillId))
    || new Set(prerequisite.skillIds).size !== prerequisite.skillIds.length) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  const selectedBySkill = new Map();
  const learningBlocks = session.blocks.filter((item) => item.kind === 'learning');
  if (learningBlocks.some((block, index) => index > 0
    && block.contentRef === learningBlocks[index - 1].contentRef)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  for (const block of learningBlocks) {
    selectedBySkill.set(block.skillId, (selectedBySkill.get(block.skillId) || 0) + block.plannedMinutes);
  }
  const budgetSkillIds = new Set();
  for (const skill of session.weeklyBudgetSnapshot.skills) {
    if (!exactKeys(skill, [
      'completedBeforeMinutes', 'deficitBeforeMinutes', 'plannedBeforeMinutes', 'selectedMinutes',
      'skillId', 'targetMinutes',
    ]) || !SKILL_BY_ID.has(skill.skillId) || budgetSkillIds.has(skill.skillId)
      || ['targetMinutes', 'plannedBeforeMinutes', 'completedBeforeMinutes', 'deficitBeforeMinutes', 'selectedMinutes']
        .some((key) => !Number.isInteger(skill[key]) || skill[key] < 0)
      || skill.deficitBeforeMinutes !== Math.max(0, skill.targetMinutes - skill.plannedBeforeMinutes)
      || skill.selectedMinutes !== (selectedBySkill.get(skill.skillId) || 0)) {
      throw new Error('ADAPTIVE_SESSION_INVALID');
    }
    budgetSkillIds.add(skill.skillId);
  }
  const ids = new Set();
  for (const [index, block] of session.blocks.entries()) {
    if (!exactKeys(block, [
      'activityId', 'activityLabel', 'contentRef', 'difficulty', 'id', 'kind', 'launch',
      'modality', 'module', 'plannedMinutes', 'position', 'reasonCodes', 'requiresAudio',
      'requiresMicrophone', 'skillId', 'skillLabel',
    ]) || block.id !== `asb_${session.previewFingerprint.slice(0, 16)}_${String(index + 1).padStart(2, '0')}`
      || ids.has(block.id) || block.position !== index + 1
      || !Number.isInteger(block.plannedMinutes) || block.plannedMinutes < 5
      || !Array.isArray(block.reasonCodes) || new Set(block.reasonCodes).size !== block.reasonCodes.length) {
      throw new Error('ADAPTIVE_SESSION_INVALID');
    }
    ids.add(block.id);
    if (block.kind === 'break') {
      if (block.plannedMinutes !== BREAK_MINUTES || block.module !== null || block.skillId !== null
        || block.skillLabel !== null || block.activityId !== null || block.activityLabel !== null
        || block.contentRef !== null || block.difficulty !== null || block.modality !== null
        || block.requiresAudio !== null || block.requiresMicrophone !== null || block.launch !== null
        || block.reasonCodes.length !== 1 || block.reasonCodes[0] !== 'scheduled_break') {
        throw new Error('ADAPTIVE_SESSION_INVALID');
      }
      continue;
    }
    const activity = ADAPTIVE_ACTIVITY_REGISTRY.activities.find((item) => (
      item.skillId === block.skillId && item.module === block.module && item.activityId === block.activityId
      && item.skillLabel === block.skillLabel && item.activityLabel === block.activityLabel
      && (item.launch.kind === 'voice_tutor_recovery'
        ? block.launch?.kind === 'voice_tutor_recovery'
          && block.contentRef === `voice-tutor-repeat:${block.launch.repeatId}`
          && item.launch.skillId === block.launch.skillId
          && item.launch.module === block.launch.module
          && item.launch.screenId === block.launch.screenId
          && item.launch.version === block.launch.version
        : item.contentRef === block.contentRef && equalValue(item.launch, block.launch))
      && item.difficulty === block.difficulty
      && item.modality === block.modality && item.requiresAudio === block.requiresAudio
      && item.requiresMicrophone === block.requiresMicrophone
    ));
    if (block.kind !== 'learning' || !activity || block.plannedMinutes < activity.minimumMinutes
      || block.plannedMinutes > MAX_LEARNING_BLOCK_MINUTES
      || !isAdaptiveLaunchDescriptor(block.launch)
      || block.reasonCodes.some((code) => !SESSION_REASON_CODES.has(code))) {
      throw new Error('ADAPTIVE_SESSION_INVALID');
    }
  }
  const hasCurrentBlock = session.currentBlockId !== null
    && session.blocks.some((block) => block.id === session.currentBlockId);
  if ((session.currentBlockId !== null && !hasCurrentBlock)
    || (session.status === 'created' && session.currentBlockId === null)
    || (session.status === 'completed' && session.currentBlockId !== null)) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  if ((session.revision === 1) !== (session.replacement === null)) throw new Error('ADAPTIVE_SESSION_INVALID');
  if (session.replacement && (!exactKeys(session.replacement, [
    'blockId', 'reason', 'replacedActivityId', 'replacedAt', 'replacedContentRef', 'replacedSkillId',
  ]) || !isAdaptiveSessionReplacementReason(session.replacement.reason)
    || !validIso(session.replacement.replacedAt)
    || !SKILL_BY_ID.has(session.replacement.replacedSkillId)
    || typeof session.replacement.replacedActivityId !== 'string'
    || typeof session.replacement.replacedContentRef !== 'string'
    || !session.blocks.some((block) => block.id === session.replacement.blockId
      && block.kind === 'learning'
      && block.contentRef !== session.replacement.replacedContentRef
      && block.reasonCodes.includes(`replacement_${session.replacement.reason}`)))) {
    throw new Error('ADAPTIVE_SESSION_INVALID');
  }
  return true;
}
