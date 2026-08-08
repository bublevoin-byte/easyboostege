import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEAKING_SCORING_VERSION,
  combineFullSpeakingScore,
  parseStoredSpeakingReview,
  scoreSpeakingTask,
} from '../speaking/fipi-scoring.js';

function common(overrides = {}) {
  return {
    confidence: 0.92,
    verdict: 'Ответ можно оценить.',
    evidence: ['Проверены только ограниченные факты.'],
    issues: [],
    ...overrides,
  };
}

function acoustic(overrides = {}) {
  return {
    available: true,
    recognitionConfidence: 0.94,
    signalQuality: 'good',
    recordingDurationSeconds: 60,
    itemDurations: [],
    completenessScore: 96,
    fluencyScore: 83,
    wordEvents: [],
    ...overrides,
  };
}

function task2Acoustic(overrides = {}) {
  return acoustic({
    recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({
      itemIndex: index + 1, durationSeconds: 12,
    })),
    ...overrides,
  });
}

function task3Acoustic(overrides = {}) {
  return acoustic({
    recordingDurationSeconds: 60,
    itemDurations: Array.from({ length: 5 }, (_, index) => ({
      itemIndex: index + 1, durationSeconds: 12,
    })),
    ...overrides,
  });
}

function event(index, overrides = {}) {
  return {
    id: `azure-${index}`,
    type: 'mispronunciation',
    gross: false,
    itemIndex: null,
    accuracyScore: 78,
    owner: 'azure_pronunciation',
    start: 1_000 + index * 4,
    end: 1_002 + index * 4,
    ...overrides,
  };
}

function task2Facts(overrides = {}) {
  return common({
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      relevant: true,
      directQuestion: true,
      lexicalGrammarBlocksCommunication: false,
      evidence: `Question ${index + 1}`,
    })),
    ...overrides,
  });
}

function task3Facts(overrides = {}) {
  return common({
    items: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      relevant: true,
      complete: true,
      communicativelyAppropriate: true,
      phraseCount: 2,
      elementaryLexicalGrammarError: false,
      evidence: `Answer ${index + 1}`,
    })),
    ...overrides,
  });
}

function task4Facts(overrides = {}) {
  return common({
    phraseCount: 13,
    wordList: false,
    introductionPresent: true,
    conclusionPresent: true,
    contentAspects: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      id: `content-${index + 1}`,
      start: 0,
      end: 0,
      status: 'full',
      evidence: `Plan point ${index + 1}`,
      correction: 'No deduction.',
    })),
    organizationErrors: [],
    lexicalGrammarErrors: [],
    ...overrides,
  });
}

test('the versioned combiner owns exact 1/4/5/10 maxima and total 20', () => {
  const task1 = scoreSpeakingTask({ taskType: 1, semantic: common(), acoustic: acoustic({
    wordEvents: [event(1)],
  }) });
  const task2 = scoreSpeakingTask({ taskType: 2, semantic: task2Facts(), acoustic: task2Acoustic() });
  const task3 = scoreSpeakingTask({ taskType: 3, semantic: task3Facts(), acoustic: task3Acoustic() });
  const task4 = scoreSpeakingTask({ taskType: 4, semantic: task4Facts(), acoustic: acoustic() });
  assert.deepEqual(
    [task1, task2, task3, task4].map(({ score, maxScore }) => [score, maxScore]),
    [[1, 1], [4, 4], [5, 5], [10, 10]],
  );
  const full = combineFullSpeakingScore([task1, task2, task3, task4]);
  assert.deepEqual(
    { status: full.status, score: full.score, maxScore: full.maxScore, version: full.scoringVersion },
    { status: 'scored', score: 20, maxScore: 20, version: SPEAKING_SCORING_VERSION },
  );
});

test('low confidence and poor acoustic evidence ask for retry, never manufacture zero', () => {
  const semanticRetry = scoreSpeakingTask({
    taskType: 2,
    semantic: task2Facts({ confidence: 0.4 }),
    acoustic: acoustic(),
  });
  assert.deepEqual(
    { status: semanticRetry.status, score: semanticRetry.score, maxScore: semanticRetry.maxScore },
    { status: 'needs_retry', score: null, maxScore: 4 },
  );
  const acousticRetry = scoreSpeakingTask({
    taskType: 1,
    semantic: common({ confidence: 0.1 }),
    acoustic: acoustic({ recognitionConfidence: 0.3, signalQuality: 'poor' }),
  });
  assert.equal(acousticRetry.status, 'needs_retry');
  assert.equal(acousticRetry.score, null);
  const shortMonologue = scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts(),
    acoustic: acoustic({ recordingDurationSeconds: 10 }),
  });
  assert.equal(shortMonologue.status, 'needs_retry',
    'a task 4 recording that is too short for a 12-15 phrase response is not scored');
  assert.equal(shortMonologue.reason, 'acoustic_recording_too_short');
  assert.equal(combineFullSpeakingScore([semanticRetry]).status, 'needs_retry');
});

test('task 1 counts omission and insertion exactly once and resolves decisive zero before unknown grossness', () => {
  const tooMany = scoreSpeakingTask({
    taskType: 1,
    semantic: common(),
    acoustic: acoustic({
      wordEvents: [
        ...Array.from({ length: 3 }, (_, index) => event(index + 1)),
        ...Array.from({ length: 2 }, (_, index) => event(index + 4, { type: 'omission', gross: true })),
        event(6, { type: 'insertion', gross: null }),
      ],
    }),
  });
  assert.equal(tooMany.status, 'scored');
  assert.equal(tooMany.score, 0, 'more than five total events is already a deterministic zero');

  const unknownCanChange = scoreSpeakingTask({
    taskType: 1,
    semantic: common(),
    acoustic: acoustic({ wordEvents: [event(1, { gross: null })] }),
  });
  assert.equal(unknownCanChange.status, 'needs_retry');
  assert.equal(unknownCanChange.reason, 'critical_error_evidence_unknown');

  const xaiCannotLowerCoverage = scoreSpeakingTask({
    taskType: 1,
    semantic: common({ confidence: 0.01 }),
    acoustic: acoustic(),
  });
  assert.equal(xaiCannotLowerCoverage.score, 1);
});

test('task 1 score is invariant to pause and monotone Azure annotations', () => {
  const baseline = scoreSpeakingTask({
    taskType: 1, semantic: common(), acoustic: acoustic({ wordEvents: [] }),
  });
  const annotated = scoreSpeakingTask({
    taskType: 1,
    semantic: common(),
    acoustic: acoustic({
      pauseAnalysisAvailable: true,
      wordEvents: [
        event(1, { type: 'unexpected_break', gross: null }),
        event(2, { type: 'missing_break', gross: null }),
        event(3, { type: 'monotone', gross: null }),
      ],
    }),
  });
  assert.deepEqual(
    { status: annotated.status, score: annotated.score, criteria: annotated.criteria },
    { status: baseline.status, score: baseline.score, criteria: baseline.criteria },
  );
});

test('tasks 2 and 3 apply semantic and phonetic FIPI gates per response', () => {
  const task2 = scoreSpeakingTask({
    taskType: 2,
    semantic: task2Facts(),
    acoustic: task2Acoustic({ wordEvents: [event(1, { itemIndex: 2, gross: true })] }),
  });
  assert.equal(task2.score, 3);
  assert.equal(task2.criteria[1].score, 0);

  const decisiveItems = task2Facts().items.map((item) => ({ ...item }));
  decisiveItems[0].relevant = false;
  const decisiveZero = scoreSpeakingTask({
    taskType: 2,
    semantic: task2Facts({ items: decisiveItems }),
    acoustic: task2Acoustic({ wordEvents: [event(1, { itemIndex: 1, gross: null })] }),
  });
  assert.equal(decisiveZero.status, 'scored');
  assert.equal(decisiveZero.criteria[0].score, 0,
    'unknown acoustic severity cannot change an already decisive semantic zero');

  const items = task3Facts().items.map((item) => ({ ...item }));
  items[2].phraseCount = 1;
  items[3].elementaryLexicalGrammarError = true;
  const task3 = scoreSpeakingTask({
    taskType: 3,
    semantic: task3Facts({ items }),
    acoustic: task3Acoustic({ wordEvents: [event(1, { itemIndex: 5 })] }),
  });
  assert.equal(task3.score, 2);
  assert.deepEqual(task3.criteria.map((criterion) => criterion.score), [1, 1, 0, 0, 0]);

  const oneTruncatedAnswer = scoreSpeakingTask({
    taskType: 3,
    semantic: task3Facts(),
    acoustic: task3Acoustic({
      recordingDurationSeconds: 10,
      itemDurations: [1, 2, 2, 2, 3].map((durationSeconds, index) => ({
        itemIndex: index + 1, durationSeconds,
      })),
    }),
  });
  assert.equal(oneTruncatedAnswer.status, 'needs_retry');
  assert.equal(oneTruncatedAnswer.reason, 'acoustic_recording_too_short',
    'one truncated interview answer cannot hide behind the aggregate duration');
});

test('task 4 implements exact content phrase bands and global content-zero rule', () => {
  const cases = [
    [task4Facts(), 4],
    [task4Facts({ contentAspects: task4Facts().contentAspects.map((item, index) => (
      index === 0 ? { ...item, status: 'missing' } : item
    )) }), 3],
    [task4Facts({ phraseCount: 10 }), 2],
    [task4Facts({ phraseCount: 8 }), 1],
    [task4Facts({ phraseCount: 7 }), 0],
  ];
  for (const [semantic, expected] of cases) {
    const result = scoreSpeakingTask({ taskType: 4, semantic, acoustic: acoustic() });
    assert.equal(result.criteria[0].score, expected);
    if (expected === 0) assert.equal(result.score, 0);
  }
});

test('task 4 implements exact organization and language bands', () => {
  const orgErrors = Array.from({ length: 4 }, (_, index) => ({
    id: `org-${index + 1}`, start: index * 4, end: index * 4 + 2,
    evidence: `logic ${index + 1}`, correction: 'Use a clear linker.',
  }));
  const languageErrors = Array.from({ length: 4 }, (_, index) => ({
    id: `lang-${index + 1}`, start: 30 + index * 4, end: 32 + index * 4,
    evidence: `grammar ${index + 1}`, correction: 'Correct the form.', gross: false,
  }));
  const result = scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({ organizationErrors: orgErrors, lexicalGrammarErrors: languageErrors }),
    acoustic: acoustic(),
  });
  assert.deepEqual(result.criteria.map((criterion) => criterion.score), [4, 1, 2]);

  const absent = scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({ introductionPresent: false, conclusionPresent: false }),
    acoustic: acoustic(),
  });
  assert.equal(absent.criteria[1].score, 0);

  const mixedLanguageErrors = Array.from({ length: 3 }, (_, index) => ({
    id: `mixed-lang-${index + 1}`, start: 60 + index * 4, end: 62 + index * 4,
    evidence: `grammar mix ${index + 1}`, correction: 'Correct the form.', gross: false,
  }));
  const mixedAcousticErrors = Array.from({ length: 3 }, (_, index) => (
    event(index + 1, { itemIndex: null, gross: false })
  ));
  const combined = scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({ lexicalGrammarErrors: mixedLanguageErrors }),
    acoustic: acoustic({ wordEvents: mixedAcousticErrors }),
  });
  assert.equal(combined.criteria[2].score, 1,
    'K3 counts lexical-grammar and phonetic errors together');
});

test('score-affecting task-4 events have one stable owner and cannot overlap', () => {
  const ownedContentAspects = task4Facts().contentAspects.map((item, index) => ({
    ...item,
    id: `content-${index + 1}`,
    start: index === 0 ? 10 : 0,
    end: index === 0 ? 20 : 0,
    correction: index === 0 ? 'Complete the comparison.' : 'No deduction.',
    status: index === 0 ? 'partial' : 'full',
  }));
  assert.doesNotThrow(() => scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({
      contentAspects: ownedContentAspects,
      lexicalGrammarErrors: [{
        id: 'separate-language', start: 30, end: 35,
        evidence: 'separate language event', correction: 'fix', gross: false,
      }],
    }),
    acoustic: acoustic(),
  }));
  assert.throws(() => scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({
      organizationErrors: [{ id: 'same-org', start: 10, end: 20, evidence: 'same event', correction: 'fix' }],
      lexicalGrammarErrors: [{ id: 'same-lang', start: 15, end: 25, evidence: 'paraphrase', correction: 'fix', gross: false }],
    }),
    acoustic: acoustic(),
  }), /SPEAKING_SEMANTIC_FACTS_INVALID/u);
  assert.throws(() => scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({
      contentAspects: ownedContentAspects,
      lexicalGrammarErrors: [{
        id: 'overlapping-language', start: 15, end: 25,
        evidence: 'same event under another owner', correction: 'fix', gross: false,
      }],
    }),
    acoustic: acoustic(),
  }), /SPEAKING_SEMANTIC_FACTS_INVALID/u);

  const crossSourceConflict = scoreSpeakingTask({
    taskType: 4,
    semantic: task4Facts({
      lexicalGrammarErrors: [{
        id: 'semantic-language-owner', start: 30, end: 35,
        evidence: 'same underlying word', correction: 'fix', gross: false,
      }],
    }),
    acoustic: acoustic({
      wordEvents: [event(9, { start: 31, end: 34 })],
    }),
  });
  assert.equal(crossSourceConflict.status, 'needs_retry');
  assert.equal(crossSourceConflict.reason, 'scoring_event_ownership_conflict',
    'one transcript event cannot be deducted by both semantic and acoustic owners');
});

test('xAI cannot invent acoustic events or directly choose a score', () => {
  const base = task2Facts();
  assert.throws(
    () => scoreSpeakingTask({ taskType: 2, semantic: { ...base, score: 0 }, acoustic: acoustic() }),
    /SPEAKING_SEMANTIC_FACTS_INVALID/u,
  );
  assert.throws(
    () => scoreSpeakingTask({ taskType: 2, semantic: { ...base, wordEvents: [] }, acoustic: acoustic() }),
    /SPEAKING_SEMANTIC_FACTS_INVALID/u,
  );
});

test('stored reviews are exactly reproducible from semantic and acoustic facts', () => {
  const semanticFacts = task4Facts();
  const acousticFacts = acoustic();
  assert.throws(() => parseStoredSpeakingReview(4, {
    status: 'scored', got: 7, max: 10, verdict: 'Подменённый критерий.',
    criteria: [{ name: 'Один произвольный критерий', got: 7, max: 10 }],
    good: [], fix: [], confidence: 0.9, needsRetryReason: null,
    scoringVersion: SPEAKING_SCORING_VERSION, semanticFacts, acousticFacts,
  }), /SPEAKING_SEMANTIC_FACTS_INVALID/u);

  assert.throws(() => parseStoredSpeakingReview(4, {
    status: 'scored', got: 10, max: 10, verdict: 'Подменённый итог.',
    criteria: [
      { name: 'Решение коммуникативной задачи', got: 4, max: 4 },
      { name: 'Организация', got: 3, max: 3 },
      { name: 'Языковое оформление', got: 3, max: 3 },
    ],
    good: [], fix: [], confidence: 0.9, needsRetryReason: null,
    scoringVersion: SPEAKING_SCORING_VERSION,
    semanticFacts: { ...semanticFacts, phraseCount: 7 }, acousticFacts,
  }), /SPEAKING_SEMANTIC_FACTS_INVALID/u);
});
