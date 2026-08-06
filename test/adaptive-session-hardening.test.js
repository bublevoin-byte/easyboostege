import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  buildAdaptiveSessionPreview,
  buildAdaptiveSessionReplacement,
  createAdaptiveLearningSessionFromPreview,
} from '../adaptive-learning/session.js';
import * as adaptiveSessionModule from '../adaptive-learning/session.js';
import { buildAdaptiveLearningPlan } from '../adaptive-learning/plan.js';
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';

const NOW = new Date('2026-08-05T09:30:00.000Z');
const COMPOSABLE_SKILLS = new Set(ADAPTIVE_ACTIVITY_REGISTRY.activities
  .filter((activity) => activity.compositionEnabled !== false
    && activity.launch.kind !== 'voice_tutor_recovery')
  .map((activity) => activity.skillId));
const ELIGIBLE_SKILLS = EGE_SKILL_TAXONOMY.skills.map((skill) => skill.id)
  .filter((skillId) => !skillId.startsWith('ege.vocabulary.'));

function allocation(percentages = {}, { dueSkillId = null } = {}) {
  return EGE_SKILL_TAXONOMY.skills.map((skill) => ({
    id: skill.id,
    label: skill.label,
    module: skill.module,
    percentage: percentages[skill.id] || 0,
    activityType: 'practice',
    reasonCodes: skill.id === dueSkillId ? ['due_review', 'target_gap'] : ['target_gap'],
  }));
}

function plan(percentages, options) {
  return {
    id: crypto.randomUUID(), revision: 4, version: 'adaptive-plan-v1', taxonomyVersion: 'ege-en-v1',
    allocation: { skills: allocation(percentages, options) },
  };
}

function profile(masteryBySkill = {}) {
  return {
    taxonomyVersion: 'ege-en-v1',
    weightingVersion: 'adaptive-evidence-v1',
    profileCalculationRevision: 1,
    evidenceWatermarkVersion: 'adaptive-evidence-watermark-v1',
    skills: EGE_SKILL_TAXONOMY.skills.map((skill) => ({
      id: skill.id,
      mastery: masteryBySkill[skill.id] ?? 90,
      status: 'established',
    })),
  };
}

function uniformEligiblePlan() {
  return plan(Object.fromEntries(ELIGIBLE_SKILLS.map((skillId) => [skillId, 10])));
}

function updateUsage(usage, preview) {
  const bySkill = new Map(usage.map((item) => [item.skillId, { ...item }]));
  for (const block of preview.blocks.filter((item) => item.kind === 'learning')) {
    const current = bySkill.get(block.skillId) || {
      skillId: block.skillId, plannedMinutes: 0, completedMinutes: 0,
    };
    current.plannedMinutes += block.plannedMinutes;
    bySkill.set(block.skillId, current);
  }
  return [...bySkill.values()];
}

test('shared launch descriptors are strict, versioned and present on every executable block', async () => {
  const contract = await import('../public/adaptive-activity-contract.js');
  assert.equal(contract.ADAPTIVE_LAUNCH_CONTRACT_VERSION, 'adaptive-launch-v1');
  const preview = buildAdaptiveSessionPreview({
    plan: uniformEligiblePlan(), goal: { weekly_minutes: 300 }, profile: profile(),
    weekUsage: [], durationMinutes: 120, now: NOW,
  });
  for (const block of preview.blocks.filter((item) => item.kind === 'learning')) {
    assert.equal(contract.isAdaptiveLaunchDescriptor(block.launch), true);
    assert.equal(typeof block.skillLabel, 'string');
    assert.equal(typeof block.activityLabel, 'string');
    assert.equal(typeof block.contentRef, 'string');
  }
});

test('all durations avoid identical consecutive content and constrained registries fail closed', () => {
  const currentPlan = uniformEligiblePlan();
  for (let duration = 15; duration <= 120; duration += 5) {
    const preview = buildAdaptiveSessionPreview({
      plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
      weekUsage: [], durationMinutes: duration, now: NOW,
    });
    const learning = preview.blocks.filter((item) => item.kind === 'learning');
    assert.ok(learning.every((block, index) => index === 0
      || block.contentRef !== learning[index - 1].contentRef));
  }
  const single = { ...ADAPTIVE_ACTIVITY_REGISTRY, activities: [ADAPTIVE_ACTIVITY_REGISTRY.activities[0]] };
  assert.throws(() => buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
    weekUsage: [], durationMinutes: 35, now: NOW, registry: single,
  }), (error) => error?.code === 'ADAPTIVE_SESSION_COVERAGE_GAP');
});

test('prerequisite support requires an authoritative weak prerequisite and remaining deficit', () => {
  const percentages = Object.fromEntries(ELIGIBLE_SKILLS.map((skillId) => [skillId, 10]));
  const currentPlan = plan(percentages, { dueSkillId: 'ege.grammar.transformations' });
  const strong = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
    weekUsage: [], durationMinutes: 30, now: NOW,
  });
  assert.equal(strong.blocks.some((block) => block.reasonCodes.includes('prerequisite_support')), false);
  const weak = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 },
    profile: profile({ 'ege.grammar.forms': 35 }),
    weekUsage: [], durationMinutes: 30, now: NOW,
  });
  assert.equal(weak.blocks.some((block) => (
    block.skillId === 'ege.grammar.forms' && block.reasonCodes.includes('prerequisite_support')
  )), true);
  const covered = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 },
    profile: profile({ 'ege.grammar.forms': 35 }),
    weekUsage: [{ skillId: 'ege.grammar.forms', plannedMinutes: 30, completedMinutes: 0 }],
    durationMinutes: 30, now: NOW,
  });
  assert.equal(covered.blocks.some((block) => block.reasonCodes.includes('prerequisite_support')), false);
});

test('five sessions converge across every positive eligible weekly budget instead of starving dependents', () => {
  const currentPlan = uniformEligiblePlan();
  let usage = [];
  for (let index = 0; index < 5; index += 1) {
    const preview = buildAdaptiveSessionPreview({
      plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
      weekUsage: usage, durationMinutes: 60, now: NOW,
    });
    usage = updateUsage(usage, preview);
  }
  const bySkill = new Map(usage.map((item) => [item.skillId, item.plannedMinutes]));
  for (const skillId of ELIGIBLE_SKILLS.filter((id) => COMPOSABLE_SKILLS.has(id))) {
    assert.ok((bySkill.get(skillId) || 0) > 0, skillId);
  }
  assert.equal(bySkill.has('ege.speaking.interaction'), false);
  assert.equal(bySkill.has('ege.speaking.monologue'), false);
  assert.equal([...bySkill.values()].reduce((sum, value) => sum + value, 0), 300);
});

function reasonPlan(targetSkillId, alternativeSkillId) {
  return plan({ [targetSkillId]: 80, [alternativeSkillId]: 20 });
}

function oneBlockSession(targetSkillId, alternativeSkillId) {
  const currentPlan = reasonPlan(targetSkillId, alternativeSkillId);
  const durationMinutes = targetSkillId === 'ege.writing.essay' ? 30 : 15;
  const preview = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
    weekUsage: [], durationMinutes, now: NOW,
  });
  return { currentPlan, session: createAdaptiveLearningSessionFromPreview(preview, {
    id: crypto.randomUUID(), now: NOW,
  }) };
}

test('replacement reasons enforce difficulty, accessibility and relevance semantics', () => {
  const cases = [
    ['too_difficult', 'ege.writing.essay', 'ege.reading.detail'],
    ['too_easy', 'ege.grammar.forms', 'ege.grammar.transformations'],
    ['accessibility', 'ege.listening.gist', 'ege.grammar.forms'],
    ['not_relevant', 'ege.grammar.forms', 'ege.grammar.transformations'],
    ['excluded', 'ege.grammar.forms', 'ege.grammar.transformations'],
  ];
  for (const [reason, targetSkillId, alternativeSkillId] of cases) {
    const { currentPlan, session } = oneBlockSession(targetSkillId, alternativeSkillId);
    const target = session.blocks.find((block) => block.kind === 'learning');
    const replaced = buildAdaptiveSessionReplacement({
      session, plan: currentPlan, blockId: target.id, reason, now: NOW,
    });
    const next = replaced.blocks.find((block) => block.id === target.id);
    if (reason === 'too_difficult') assert.ok(next.difficulty < target.difficulty);
    if (reason === 'too_easy') assert.ok(next.difficulty > target.difficulty);
    if (reason === 'accessibility') {
      assert.notEqual(next.modality, target.modality);
      assert.equal(next.requiresAudio, false);
      assert.equal(next.requiresMicrophone, false);
    }
    if (['not_relevant', 'excluded'].includes(reason)) assert.notEqual(next.skillId, target.skillId);
    if (reason === 'excluded') {
      assert.ok(next.reasonCodes.includes('learner_exclusion'));
      assert.equal(replaced.durationMinutes, session.durationMinutes);
      assert.equal(replaced.blocks.reduce((sum, block) => sum + block.plannedMinutes, 0), session.durationMinutes);
    }
  }
});

test('frontend dispatcher consumes the shared descriptor vocabulary without eval or arbitrary names', async () => {
  const source = await fs.readFile(new URL('../public/adaptive-activity-launch.js', import.meta.url), 'utf8');
  const progress = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(source, /isAdaptiveLaunchDescriptor/u);
  assert.match(source, /case 'vocabulary_practice'/u);
  assert.match(source, /case 'grammar_practice'/u);
  assert.match(source, /case 'exam_workflow'/u);
  assert.match(source, /case 'writing_task'/u);
  assert.match(source, /adaptiveRecoveryRepeatId = launch\.repeatId/u);
  assert.match(source, /adaptiveRecoveryTaskId = launch\.taskId/u);
  assert.match(progress, /item\.id===requestedRepeat/u);
  assert.match(progress, /item\.task_id===requestedTask/u);
  assert.doesNotMatch(source, /eval\(|new Function|window\[[^\]]+\]/u);
});

test('adaptive dispatcher aborts a Reading launch that outlives its timeout', async () => {
  const source = await fs.readFile(new URL('../public/adaptive-activity-launch.js', import.meta.url), 'utf8');
  const executable = `${source.replace(/^import .*;\r?\n/gmu, '').replace('export function launchAdaptiveActivity', 'function launchAdaptiveActivity')}\nwindow.__launchAdaptiveActivity=launchAdaptiveActivity;`;
  let timeoutCallback;
  let navigationCallback;
  let receivedSignal = null;
  let launchLocked = false;
  let launchCount = 0;
  const window = {
    launchReadingPractice(...args) {
      launchCount += 1;
      if (launchLocked) return false;
      launchLocked = true;
      receivedSignal = args[3]?.signal || null;
      if (launchCount > 1) { launchLocked = false; return true; }
      return new Promise((resolve) => receivedSignal?.addEventListener('abort', () => {
        launchLocked = false;
        resolve(false);
      }, { once: true }));
    },
  };
  vm.runInNewContext(executable, {
    window, document: { getElementById: () => ({ dataset: {} }) },
    isAdaptiveLaunchDescriptor: () => true,
    nav: (_screenId, callback) => { navigationCallback = callback; },
    setTimeout: (callback) => { timeoutCallback = callback; return 1; }, clearTimeout() {},
    AbortController, Promise, Boolean, String, Object, Error, CustomEvent,
  });
  const resultPromise = window.__launchAdaptiveActivity({
    kind: 'reading_mode', screenId: 'scr7', mode: 'task10', cefr: 'B1',
  }, 'builtin:reading:task10:b1:v1');
  const navigationPromise = navigationCallback();
  await Promise.resolve();
  timeoutCallback();
  assert.equal(await resultPromise, false);
  assert.equal(receivedSignal?.aborted, true);
  await navigationPromise;
  assert.equal(launchLocked, false);

  const secondResult = window.__launchAdaptiveActivity({
    kind: 'reading_mode', screenId: 'scr7', mode: 'task10', cefr: 'B1',
  }, 'builtin:reading:task10:b1:v1');
  await navigationCallback();
  assert.equal(await secondResult, true);
  assert.equal(launchCount, 2);
});

test('OpenAPI documents the exact strict launch descriptor union and block metadata', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  assert.match(openapi, /AdaptiveActivityLaunch:/u);
  for (const kind of ['vocabulary_practice', 'grammar_practice', 'exam_workflow', 'reading_mode', 'listening_mode', 'writing_task', 'speaking_task', 'voice_tutor_recovery']) {
    assert.match(openapi, new RegExp(`kind: \\{ type: string, enum: \\[${kind}\\]`, 'u'));
  }
  assert.match(openapi, /required: \[version, kind, screenId/u);
  assert.match(openapi, /required: \[version, kind, screenId, skillId, module, repeatId, taskId, stage, status, dueAt, windowEndsAt\]/u);
  assert.match(openapi, /required: \[weeklyAvailableMinutes, coverageGaps, prerequisiteEvidence, skills\]/u);
  assert.match(openapi, /content_coverage_fallback/u);
  assert.match(openapi, /too_difficult, too_easy, not_relevant, accessibility, excluded/u);
  assert.match(openapi, /replacement_excluded/u);
  assert.doesNotMatch(openapi, /matching lazy-loaded activity screen/u);
  assert.match(openapi, /required: \[id, position, kind, module, skillId, skillLabel, activityId, activityLabel/u);
});

test('the grammar exam launches fixed built-in content and reports through the shared exact-claim recorder', async () => {
  const contract = await fs.readFile(new URL('../public/adaptive-activity-contract.js', import.meta.url), 'utf8');
  const grammar = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');
  assert.match(contract, /activityId: 'grammar_forms_exam_19_24'/u);
  assert.match(contract, /contentRef: 'builtin:exam:grammar:19-24:v1'/u);
  assert.match(grammar, /adaptive\?G_EXAMS\[0\]/u);
  assert.match(grammar, /grammarModule\.activityId\(null,'exam_19_24'\)/u);
  assert.match(grammar, /recordCompletedLearningActivity\(\{id:evidence\.id,module:'grammar'/u);
  assert.match(grammar, /function launchGrammarExam\(contentRef\)/u);
});

test('adaptive Speaking stays out of composition until its evaluation is owner-bound', async () => {
  const speakingActivities = ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
    activity.launch.kind === 'speaking_task'
  ));
  assert.equal(speakingActivities.length, 2);
  assert.ok(speakingActivities.every((activity) => activity.compositionEnabled === false));
  assert.throws(() => buildAdaptiveSessionPreview({
    plan: plan({ 'ege.speaking.interaction': 100 }), goal: { weekly_minutes: 300 },
    profile: profile(), weekUsage: [], durationMinutes: 15, now: NOW,
    registry: { ...ADAPTIVE_ACTIVITY_REGISTRY, activities: [speakingActivities[0]] },
  }), (error) => error?.code === 'ADAPTIVE_SESSION_COVERAGE_GAP');

  const speaking = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
  assert.match(speaking, /function adaptiveSpeakingLock\(\)/u);
  assert.match(speaking, /function launchAdaptiveSpeakingLock\(lock\).*openAdaptivePlan\(\).*return true/su);
  const evaluation = speaking.slice(speaking.indexOf('async function spEval'), speaking.indexOf('function spShowEval'));
  assert.doesNotMatch(evaluation, /contentRef/u);
});

test('execution hardening migrates legacy plaintext starts and keeps context labels factual', async () => {
  const migration = await fs.readFile(new URL('../migrations/036_adaptive_execution_hardening.sql', import.meta.url), 'utf8');
  const execution = await fs.readFile(new URL('../adaptive-learning/session-execution.js', import.meta.url), 'utf8');
  assert.match(migration, /UPDATE adaptive_learning_execution_claims claim\s+SET consumed_at = NULL,[\s\S]+revoked_at = NOW\(\)/u);
  assert.match(migration, /legacy claim, consumed or not/u);
  assert.match(migration, /response_snapshot \? 'recoveryAttempt'/u);
  assert.match(migration, /DELETE FROM adaptive_learning_session_mutations\s+WHERE operation = 'start'/u);
  assert.match(migration, /exam_practice.*planned_practice.*scheduled_review.*ai_assisted_review/su);
  assert.doesNotMatch(execution, /timed_unassisted|ordinary_unassisted|hinted_or_repeated/u);
});

function randomizedEligiblePlan(seed) {
  let state = seed >>> 0;
  const weights = ELIGIBLE_SKILLS.map(() => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return 1 + (state % 100);
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const percentages = weights.map((value) => Math.floor(value * 100 / total));
  let remainder = 100 - percentages.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) percentages[index] += 1;
  return plan(Object.fromEntries(ELIGIBLE_SKILLS.map((skillId, index) => (
    [skillId, percentages[index]]
  ))));
}

test('replacement is break-aware for every long duration, randomized plan and reason', () => {
  let beforeBreak = 0;
  let afterBreak = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const currentPlan = randomizedEligiblePlan(seed);
    for (let durationMinutes = 65; durationMinutes <= 120; durationMinutes += 5) {
      let preview;
      try {
        preview = buildAdaptiveSessionPreview({
          plan: currentPlan, goal: { weekly_minutes: 600 }, profile: profile(),
          weekUsage: [], durationMinutes, now: NOW,
        });
      } catch (error) {
        assert.equal(error?.code, 'ADAPTIVE_SESSION_COVERAGE_GAP');
        continue;
      }
      const session = createAdaptiveLearningSessionFromPreview(preview, {
        id: crypto.randomUUID(), now: NOW,
      });
      const breakIndex = session.blocks.findIndex((block) => block.kind === 'break');
      for (const [index, block] of session.blocks.entries()) {
        if (block.kind !== 'learning') continue;
        if (index === breakIndex - 1) beforeBreak += 1;
        if (index === breakIndex + 1) afterBreak += 1;
        for (const reason of ['too_difficult', 'too_easy', 'not_relevant', 'accessibility']) {
          try {
            const replaced = buildAdaptiveSessionReplacement({
              session, plan: currentPlan, blockId: block.id, reason, now: NOW,
            });
            assert.equal(replaced.revision, 2);
          } catch (error) {
            assert.equal(error?.code, 'ADAPTIVE_SESSION_NO_REPLACEMENT', [
              seed, durationMinutes, block.position, reason, error?.message,
            ].join(':'));
          }
        }
      }
    }
  }
  assert.ok(beforeBreak > 0);
  assert.ok(afterBreak > 0);
});

test('vocabulary has a truthful executable consumer and cannot silently starve its weekly budget', () => {
  const vocabulary = ADAPTIVE_ACTIVITY_REGISTRY.activities.find((activity) => (
    activity.skillId === 'ege.vocabulary.lexical_choice'
  ));
  assert.equal(vocabulary?.launch.kind, 'vocabulary_practice');
  assert.equal(vocabulary?.launch.screenId, 'scr2');
  const percentages = {
    'ege.vocabulary.lexical_choice': 40,
    'ege.vocabulary.word_formation': 40,
    'ege.grammar.forms': 10,
    'ege.grammar.transformations': 10,
  };
  const currentPlan = plan(percentages);
  let usage = [];
  let vocabularyMinutes = 0;
  let grammarMinutes = 0;
  let coverageCode = null;
  let sawFallback = false;
  for (let index = 0; index < 5; index += 1) {
    try {
      const preview = buildAdaptiveSessionPreview({
        plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
        weekUsage: usage, durationMinutes: 60, now: NOW,
      });
      assert.ok(preview.weeklyBudgetSnapshot.coverageGaps.includes('ege.vocabulary.word_formation'));
      for (const block of preview.blocks.filter((item) => item.kind === 'learning')) {
        if (block.module === 'vocabulary') vocabularyMinutes += block.plannedMinutes;
        if (block.module === 'grammar') grammarMinutes += block.plannedMinutes;
        if (block.reasonCodes.includes('content_coverage_fallback')) sawFallback = true;
      }
      usage = updateUsage(usage, preview);
    } catch (error) {
      coverageCode = error?.code;
      break;
    }
  }
  assert.equal(coverageCode, null);
  assert.ok(vocabularyMinutes >= 225, `vocabulary received only ${vocabularyMinutes}`);
  assert.ok(grammarMinutes <= 75, `grammar overscheduled to ${grammarMinutes}`);
  assert.equal(sawFallback, true);
});

test('Base registry schedules every available vocabulary topic and distinct practice evidence mode', async () => {
  const vocabulary = ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
    activity.launch.kind === 'vocabulary_practice'
  ));
  const expectedModes = [
    'lexical_choice', 'english_production', 'contextual_production', 'listening',
  ];
  for (let topicId = 1; topicId <= 10; topicId += 1) {
    for (const mode of expectedModes) {
      const matches = vocabulary.filter((activity) => (
        activity.launch.topicId === topicId && activity.launch.mode === mode
      ));
      assert.equal(matches.length, 1, `${topicId}:${mode}`);
      assert.equal(matches[0].module, 'vocabulary');
      assert.equal(matches[0].skillId, 'ege.vocabulary.lexical_choice');
      assert.equal((await import('../public/adaptive-activity-contract.js'))
        .isAdaptiveLaunchDescriptor(matches[0].launch), true);
    }
  }
  assert.equal(new Set(vocabulary.map((activity) => activity.contentRef)).size, 40);

  const vocabularyOnly = plan({ 'ege.vocabulary.lexical_choice': 100 });
  const preview = buildAdaptiveSessionPreview({
    plan: vocabularyOnly, goal: { weekly_minutes: 300 }, profile: profile(),
    access: { capabilities: { premiumDepth: false } },
    weekUsage: [], durationMinutes: 60, now: NOW,
  });
  assert.deepEqual(preview.blocks.map((block) => block.launch.mode), [
    'english_production', 'contextual_production', 'listening', 'lexical_choice',
  ]);
  assert.ok(preview.blocks.every((block) => block.reasonCodes.length > 0));

  const extended = buildAdaptiveSessionPreview({
    plan: vocabularyOnly, goal: { weekly_minutes: 300 }, profile: profile(),
    access: { capabilities: { premiumDepth: false } },
    weekUsage: [], durationMinutes: 90, now: NOW,
  });
  assert.ok(new Set(extended.blocks
    .filter((block) => block.kind === 'learning')
    .map((block) => block.launch.topicId)).size >= 2);
});

test('create candidate recomputes the canonical preview fingerprint and deterministic block ids', () => {
  assert.equal(typeof adaptiveSessionModule.adaptiveSessionPreviewFingerprint, 'function');
  const currentPlan = uniformEligiblePlan();
  const preview = buildAdaptiveSessionPreview({
    plan: currentPlan, goal: { weekly_minutes: 300 }, profile: profile(),
    weekUsage: [], durationMinutes: 60, now: NOW,
  });
  assert.equal(adaptiveSessionModule.adaptiveSessionPreviewFingerprint(preview), preview.previewFingerprint);
  const session = createAdaptiveLearningSessionFromPreview(preview, {
    id: crypto.randomUUID(), now: NOW,
  });
  const candidate = {
    idempotencyKey: 'hardening-create-candidate-01', requestHash: 'a'.repeat(64),
    planId: preview.planId, planRevision: preview.planRevision,
    previewFingerprint: preview.previewFingerprint, session, now: NOW,
  };
  assert.equal(adaptiveSessionModule.assertAdaptiveSessionCreateCandidate(candidate), true);

  const registeredTamper = structuredClone(session);
  const block = registeredTamper.blocks.find((item) => (
    item.kind === 'learning' && item.skillId === 'ege.grammar.forms'
  ));
  const alternative = ADAPTIVE_ACTIVITY_REGISTRY.activities.find((item) => (
    item.skillId === 'ege.grammar.forms' && item.activityId !== block.activityId
  ));
  for (const key of [
    'activityId', 'activityLabel', 'contentRef', 'difficulty', 'modality', 'requiresAudio',
    'requiresMicrophone', 'launch',
  ]) block[key] = structuredClone(alternative[key]);
  assert.throws(() => adaptiveSessionModule.assertAdaptiveSessionCreateCandidate({
    ...candidate, session: registeredTamper,
  }), /ADAPTIVE_SESSION_INVALID/u);

  const idTamper = structuredClone(session);
  idTamper.blocks[0].id = 'asb_ffffffffffffffff_99';
  idTamper.currentBlockId = idTamper.blocks[0].id;
  assert.throws(() => adaptiveSessionModule.assertAdaptiveSessionCreateCandidate({
    ...candidate, session: idTamper,
  }), /ADAPTIVE_SESSION_INVALID/u);

  const budgetTamper = structuredClone(session);
  budgetTamper.weeklyBudgetSnapshot.weeklyAvailableMinutes += 1;
  assert.throws(() => adaptiveSessionModule.assertAdaptiveSessionCreateCandidate({
    ...candidate, session: budgetTamper,
  }), /ADAPTIVE_SESSION_INVALID/u);

  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  assert.equal(adaptiveSessionModule.assertAdaptiveSessionCreateCandidate({
    ...candidate, session: reverseKeys(session),
  }), true);
});

test('actual low-budget plans remain rolling priorities across every duration and sequential sessions', () => {
  for (const weeklyMinutes of [30, 35, 60]) {
    const goal = {
      target_exam: 'ege_english', target_score: 85, exam_date: '2027-06-01',
      weekly_minutes: weeklyMinutes,
    };
    const calculated = buildAdaptiveLearningPlan({
      goal, profile: buildAdaptiveLearningProfile(), now: NOW,
    });
    const currentPlan = {
      ...calculated, id: crypto.randomUUID(), revision: 1,
    };
    let usage = [];
    const servedModules = new Map();
    const servedSkills = new Set();
    let sawFallback = false;
    let sawPersistedOvershoot = false;
    for (let durationMinutes = 15; durationMinutes <= 120; durationMinutes += 5) {
      const preview = buildAdaptiveSessionPreview({
        plan: currentPlan, goal, profile: buildAdaptiveLearningProfile(),
        weekUsage: usage, durationMinutes, now: NOW,
      });
      assert.equal(preview.blocks.reduce((sum, block) => sum + block.plannedMinutes, 0), durationMinutes);
      assert.equal(preview.breakMinutes, durationMinutes > 60 ? 10 : 0);
      assert.ok(preview.weeklyBudgetSnapshot.coverageGaps.includes('ege.vocabulary.word_formation'));
      if (preview.weeklyBudgetSnapshot.skills.some((skill) => (
        skill.plannedBeforeMinutes > skill.targetMinutes
      ))) sawPersistedOvershoot = true;
      for (const block of preview.blocks.filter((item) => item.kind === 'learning')) {
        servedModules.set(block.module, (servedModules.get(block.module) || 0) + block.plannedMinutes);
        servedSkills.add(block.skillId);
        if (block.reasonCodes.includes('content_coverage_fallback')) sawFallback = true;
      }
      usage = updateUsage(usage, preview);
    }
    assert.deepEqual([...servedModules.keys()].sort(), [
      'grammar', 'listening', 'reading', 'vocabulary', 'writing',
    ]);
    assert.deepEqual([...servedSkills].sort(), [...new Set(ADAPTIVE_ACTIVITY_REGISTRY.activities
      .filter((activity) => activity.launch.kind !== 'voice_tutor_recovery'
        && activity.compositionEnabled !== false)
      .map((activity) => activity.skillId))].sort());
    assert.equal(servedModules.has('speaking'), false,
      'disabled Speaking activities must not leak into a composed session');
    assert.equal(sawFallback, true);
    assert.equal(sawPersistedOvershoot, true);
  }
});
