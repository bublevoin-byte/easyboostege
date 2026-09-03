export const SHORT_DIAGNOSTIC_POLICY_V1 = Object.freeze({
  catalogVersion: 'ege-short-diagnostic-v1',
  depth: 'short',
  estimatedMinutes: 15,
  minimumItems: 8,
  targetItems: 10,
  maximumItems: 12,
  targetSeconds: 900,
  maximumSeconds: 1_200,
});

export const DEEP_DIAGNOSTIC_POLICY_V1 = Object.freeze({
  catalogVersion: 'ege-deep-diagnostic-v1',
  depth: 'deep',
  estimatedMinutes: 35,
  minimumItems: 16,
  targetItems: 20,
  maximumItems: 24,
  targetSeconds: 2_100,
  maximumSeconds: 2_700,
});

export const SHORT_DIAGNOSTIC_POLICY = Object.freeze({
  ...SHORT_DIAGNOSTIC_POLICY_V1,
  catalogVersion: 'ege-short-diagnostic-v2',
});

export const DEEP_DIAGNOSTIC_POLICY = Object.freeze({
  ...DEEP_DIAGNOSTIC_POLICY_V1,
  catalogVersion: 'ege-deep-diagnostic-v2',
});

const LEGACY_ITEMS = [
  {
    id: 'grammar-forms-present-perfect-1',
    skillId: 'ege.grammar.forms',
    module: 'grammar',
    egeImpact: 1,
    evidenceQuality: 'independent',
    prompt: 'Choose the correct form: She ___ her homework already.',
    choices: [
      { id: 'a', label: 'has finished' },
      { id: 'b', label: 'finished' },
      { id: 'c', label: 'is finishing' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 60,
  },
  {
    id: 'grammar-transformations-despite-1',
    skillId: 'ege.grammar.transformations',
    module: 'grammar',
    egeImpact: 0.9,
    evidenceQuality: 'independent',
    prompt: 'Choose the sentence with the same meaning: Although it rained, we went for a walk.',
    choices: [
      { id: 'a', label: 'Because of the rain, we stayed at home.' },
      { id: 'b', label: 'Despite the rain, we went for a walk.' },
      { id: 'c', label: 'We went for a walk so that it rained.' },
    ],
    correctChoiceId: 'b',
    estimatedSeconds: 75,
  },
  {
    id: 'vocabulary-lexical-choice-impact-1',
    skillId: 'ege.vocabulary.lexical_choice',
    module: 'vocabulary',
    egeImpact: 0.8,
    evidenceQuality: 'independent',
    prompt: 'Choose the word that best completes the sentence: The new law may have a major ___ on education.',
    choices: [
      { id: 'a', label: 'impact' },
      { id: 'b', label: 'occasion' },
      { id: 'c', label: 'habit' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 60,
  },
  {
    id: 'vocabulary-word-formation-success-1',
    skillId: 'ege.vocabulary.word_formation',
    module: 'vocabulary',
    egeImpact: 0.8,
    evidenceQuality: 'independent',
    prompt: 'Complete the sentence with the correct form of SUCCESS: Her project was very ___.',
    choices: [
      { id: 'a', label: 'successfully' },
      { id: 'b', label: 'successful' },
      { id: 'c', label: 'success' },
    ],
    correctChoiceId: 'b',
    estimatedSeconds: 60,
  },
  {
    id: 'reading-gist-library-1',
    skillId: 'ege.reading.gist',
    module: 'reading',
    egeImpact: 0.8,
    evidenceQuality: 'independent',
    prompt: 'A town library extended its opening hours after students asked for a quiet evening study space. Attendance doubled within a month. What is the main idea?',
    choices: [
      { id: 'a', label: 'Longer hours made the library more useful to students.' },
      { id: 'b', label: 'Students prefer studying only in the morning.' },
      { id: 'c', label: 'The town plans to close its library.' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 90,
  },
  {
    id: 'reading-detail-train-1',
    skillId: 'ege.reading.detail',
    module: 'reading',
    egeImpact: 1,
    evidenceQuality: 'independent',
    prompt: 'Maya took the earlier train because the afternoon service had been cancelled. Why did Maya travel earlier?',
    choices: [
      { id: 'a', label: 'Her ticket was cheaper in the morning.' },
      { id: 'b', label: 'She wanted to meet the driver.' },
      { id: 'c', label: 'The later train was not running.' },
    ],
    correctChoiceId: 'c',
    estimatedSeconds: 75,
  },
  {
    id: 'listening-gist-club-1',
    skillId: 'ege.listening.gist',
    module: 'listening',
    egeImpact: 0.8,
    evidenceQuality: 'assisted',
    presentation: 'audio',
    speechText: 'This Saturday our school eco club will meet in the garden at ten. We will plant trees, so please bring gloves.',
    measurementNotice: 'Это ориентировочная проверка аудирования: запись можно прослушать повторно, поэтому ответ не подтверждает навык самостоятельно.',
    prompt: 'What is the announcement mainly about?',
    choices: [
      { id: 'a', label: 'A tree-planting meeting.' },
      { id: 'b', label: 'A sports competition.' },
      { id: 'c', label: 'A change to school lessons.' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 90,
  },
  {
    id: 'listening-detail-museum-1',
    skillId: 'ege.listening.detail',
    module: 'listening',
    egeImpact: 1,
    evidenceQuality: 'assisted',
    presentation: 'audio',
    speechText: 'The museum opens at nine, but our guided tour begins at half past ten beside the main entrance.',
    measurementNotice: 'Это ориентировочная проверка аудирования: запись можно прослушать повторно, поэтому ответ не подтверждает навык самостоятельно.',
    prompt: 'When does the guided tour begin?',
    choices: [
      { id: 'a', label: 'At 9:00.' },
      { id: 'b', label: 'At 10:30.' },
      { id: 'c', label: 'At 11:30.' },
    ],
    correctChoiceId: 'b',
    estimatedSeconds: 90,
  },
  {
    id: 'writing-email-content-1',
    skillId: 'ege.writing.email',
    module: 'writing',
    egeImpact: 0.8,
    evidenceQuality: 'assisted',
    measurementNotice: 'Короткий тест проверяет выбор плана ответа, но не само письмо. Навык письма подтверждается только отдельной Premium-проверкой реальной работы.',
    prompt: 'An exam email asks three questions about your school trip. Which plan best answers the task?',
    choices: [
      { id: 'a', label: 'Answer all three questions and ask the required questions in a clear email.' },
      { id: 'b', label: 'Describe only the weather in one long paragraph.' },
      { id: 'c', label: 'Copy the task instructions without adding information.' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 75,
  },
  {
    id: 'writing-essay-linking-1',
    skillId: 'ege.writing.essay',
    module: 'writing',
    egeImpact: 1,
    evidenceQuality: 'assisted',
    measurementNotice: 'Короткий тест проверяет распознавание связки, но не развёрнутое высказывание. Навык письма подтверждается только отдельной Premium-проверкой реальной работы.',
    prompt: 'Which option gives the clearest contrast between two chart findings?',
    choices: [
      { id: 'a', label: 'The chart is nice and has different numbers.' },
      { id: 'b', label: 'Cycling 45%, running 12%, and that is all.' },
      { id: 'c', label: 'While 45% chose cycling, only 12% preferred running.' },
    ],
    correctChoiceId: 'c',
    estimatedSeconds: 75,
  },
  {
    id: 'speaking-interaction-follow-up-1',
    skillId: 'ege.speaking.interaction',
    module: 'speaking',
    egeImpact: 0.9,
    evidenceQuality: 'assisted',
    measurementNotice: 'Короткий тест проверяет выбор реплики, но не устную речь. Навык говорения подтверждается только отдельной Premium-проверкой реального ответа.',
    prompt: 'Which reply answers the question “How often do you practise English and why?” most fully?',
    choices: [
      { id: 'a', label: 'English.' },
      { id: 'b', label: 'I practise every day because regular work helps me remember new language.' },
      { id: 'c', label: 'Yes, I do.' },
    ],
    correctChoiceId: 'b',
    estimatedSeconds: 60,
  },
  {
    id: 'speaking-monologue-structure-1',
    skillId: 'ege.speaking.monologue',
    module: 'speaking',
    egeImpact: 1,
    evidenceQuality: 'assisted',
    measurementNotice: 'Короткий тест проверяет выбор структуры, но не устный монолог. Навык говорения подтверждается только отдельной Premium-проверкой реального ответа.',
    prompt: 'Which approach produces the clearest exam monologue?',
    choices: [
      { id: 'a', label: 'Cover every point in order, connect ideas and finish with a conclusion.' },
      { id: 'b', label: 'Repeat the first sentence until time ends.' },
      { id: 'c', label: 'Ignore the plan and list unrelated words.' },
    ],
    correctChoiceId: 'a',
    estimatedSeconds: 75,
  },
];

const ITEMS = LEGACY_ITEMS.map((item) => {
  if (item.id === 'speaking-interaction-follow-up-1') return {
    ...item,
    skillId: 'ege.speaking.direct_questions',
    measurementNotice: 'Короткий тест проверяет выбор реплики, но не устную речь. Навык подтверждается оценкой реального ответа в разделе «Говорение», доступной с обычной активной подпиской.',
  };
  if (item.id === 'speaking-monologue-structure-1') return {
    ...item,
    skillId: 'ege.speaking.monologue_organization',
    measurementNotice: 'Короткий тест проверяет выбор структуры, но не устный монолог. Навык подтверждается оценкой реального ответа в разделе «Говорение», доступной с обычной активной подпиской.',
  };
  return item;
});

const SPEAKING_DIAGNOSTIC_ITEMS = [
  ['reading-aloud-strategy-1', 'ege.speaking.reading_aloud', 'Which preparation step best supports clear reading aloud?', 'Mark sense groups and difficult words before recording.'],
  ['direct-questions-form-1', 'ege.speaking.direct_questions', 'Which option is a complete direct question?', 'Could you tell me when the course starts?'],
  ['interview-completeness-1', 'ege.speaking.interview_completeness', 'Which interview answer is complete?', 'I practise twice a week because it helps me speak confidently.'],
  ['monologue-content-1', 'ege.speaking.monologue_content', 'How should you cover a photo-project plan?', 'Address every point with relevant details.'],
  ['monologue-organization-2', 'ege.speaking.monologue_organization', 'Which structure is clearest?', 'Introduction, every plan point in order, and conclusion.'],
  ['spoken-grammar-1', 'ege.speaking.spoken_grammar', 'Which spoken sentence is grammatically complete?', 'The students have been preparing since Monday.'],
  ['spoken-lexis-1', 'ege.speaking.spoken_lexis', 'Which phrase is natural in a spoken answer?', 'This activity helps me broaden my horizons.'],
  ['speaking-fluency-1', 'ege.speaking.fluency', 'Which strategy supports fluent speech?', 'Use short planning notes and speak in connected sense groups.'],
  ['pronunciation-words-1', 'ege.speaking.pronunciation_words', 'What is the safest way to practise a difficult word?', 'Listen, repeat it in a phrase, record yourself, and compare.'],
  ['pronunciation-phonemes-1', 'ege.speaking.pronunciation_phonemes', 'How should a difficult sound be practised?', 'Contrast it in minimal pairs and then use it in words.'],
  ['speaking-signal-1', 'ege.speaking.signal_quality', 'Which setup gives the most reliable recording?', 'A quiet room with the microphone at a stable distance.'],
].map(([id, skillId, prompt, correct]) => ({
  id, skillId, module: 'speaking', egeImpact: 0.8, evidenceQuality: 'assisted',
  measurementNotice: 'Выбор стратегии не подтверждает самостоятельную устную речь; навык подтверждается оценкой реального ответа в разделе «Говорение», доступной с обычной активной подпиской.',
  prompt,
  choices: [
    { id: 'a', label: correct },
    { id: 'b', label: 'Skip preparation and rely on guessing.' },
    { id: 'c', label: 'Repeat unrelated words until the timer ends.' },
  ],
  correctChoiceId: 'a', estimatedSeconds: 60,
}));

const LEGACY_DEEP_ITEMS = [
  ['grammar-forms-conditionals-2', 'ege.grammar.forms', 'grammar', 1,
    'Choose the correct form: If I ___ about the change, I would have arrived earlier.',
    ['had known', 'knew', 'have known'], 'a'],
  ['grammar-transformations-unless-2', 'ege.grammar.transformations', 'grammar', 0.9,
    'Choose the closest meaning: You will miss the deadline if you do not start now.',
    ['Unless you start now, you will miss the deadline.', 'Unless you miss the deadline, start now.', 'Start now because you missed the deadline.'], 'a'],
  ['vocabulary-lexical-choice-raise-2', 'ege.vocabulary.lexical_choice', 'vocabulary', 0.8,
    'Choose the natural phrase: The campaign hopes to ___ awareness of recycling.',
    ['raise', 'rise', 'grow up'], 'a'],
  ['vocabulary-word-formation-rely-2', 'ege.vocabulary.word_formation', 'vocabulary', 0.8,
    'Choose the correct form of RELY: This source is generally ___.',
    ['reliable', 'reliably', 'reliance'], 'a'],
  ['reading-gist-volunteering-2', 'ege.reading.gist', 'reading', 0.8,
    'A student group began delivering books to people who could not visit the library. The project later expanded to three districts. What is the main idea?',
    ['A small volunteer service grew after meeting a local need.', 'Libraries stopped lending books.', 'Students moved to another district.'], 'a'],
  ['reading-detail-research-2', 'ege.reading.detail', 'reading', 1,
    'The researchers repeated the experiment in winter to check whether temperature caused the earlier result. Why was it repeated?',
    ['To test the effect of temperature.', 'To recruit more researchers.', 'To shorten the experiment.'], 'a'],
  ['listening-gist-course-2', 'ege.listening.gist', 'listening', 0.8,
    'What is the speaker mainly doing?',
    ['Explaining a change to a course timetable.', 'Advertising a sports centre.', 'Describing a holiday.'], 'a'],
  ['listening-detail-flight-2', 'ege.listening.detail', 'listening', 1,
    'Which detail should a listener record from a travel announcement?',
    ['The revised departure gate and time.', 'The colour of the aircraft.', 'The pilot’s favourite destination.'], 'a'],
  ['writing-email-register-2', 'ege.writing.email', 'writing', 0.8,
    'Which opening is most suitable for an informal email to an English-speaking friend?',
    ['Hi Sam, thanks for your message!', 'To whom it may concern:', 'Hereby I declare the following.'], 'a'],
  ['writing-essay-data-2', 'ege.writing.essay', 'writing', 1,
    'Which sentence reports chart data most precisely?',
    ['Nearly half chose cycling, compared with about one in ten who chose running.', 'Cycling was nice and running was small.', 'Everyone preferred cycling.'], 'a'],
  ['speaking-interaction-clarify-2', 'ege.speaking.interaction', 'speaking', 0.9,
    'Which question best asks for a missing practical detail?',
    ['Could you tell me whether the fee includes equipment?', 'Equipment is good, isn’t it.', 'I like the fee.'], 'a'],
  ['speaking-monologue-example-2', 'ege.speaking.monologue', 'speaking', 1,
    'Which response best develops a monologue point?',
    ['State the idea, explain why it matters and give a relevant example.', 'List unrelated nouns.', 'Repeat the task wording.'], 'a'],
].map(([id, skillId, module, egeImpact, prompt, labels, correctChoiceId]) => ({
  id,
  skillId,
  module,
  egeImpact,
  evidenceQuality: ['listening', 'writing', 'speaking'].includes(module) ? 'assisted' : 'independent',
  measurementNotice: module === 'listening'
    ? 'Это проверка понимания стратегии без аудиозаписи; результат ориентировочный.'
    : ['writing', 'speaking'].includes(module)
      ? 'Выбор варианта не подтверждает самостоятельное письмо или речь; результат ориентировочный.'
      : undefined,
  prompt,
  choices: labels.map((label, index) => ({ id: String.fromCharCode(97 + index), label })),
  correctChoiceId, estimatedSeconds: 90,
}));

const DEEP_ITEMS = LEGACY_DEEP_ITEMS.map((item) => {
  const skillId = item.id === 'speaking-interaction-clarify-2'
    ? 'ege.speaking.direct_questions'
    : item.id === 'speaking-monologue-example-2'
      ? 'ege.speaking.monologue_content'
      : item.skillId;
  return {
    ...item,
    skillId,
    measurementNotice: item.module === 'listening'
      ? 'Это проверка понимания стратегии без аудиозаписи; результат ориентировочный.'
      : item.module === 'speaking'
        ? 'Выбор варианта не подтверждает самостоятельную речь; навык подтверждается оценкой реального ответа в разделе «Говорение», доступной с обычной активной подпиской.'
        : item.module === 'writing'
          ? 'Выбор варианта не подтверждает самостоятельное письмо; результат ориентировочный.'
        : undefined,
  };
});

function freezeCatalogItems(items) {
  return Object.freeze(items.map((item) => Object.freeze({
    ...item,
    choices: Object.freeze(item.choices.map((choice) => Object.freeze({ ...choice }))),
  })));
}

export const SHORT_DIAGNOSTIC_CATALOG_V1 = Object.freeze({
  version: SHORT_DIAGNOSTIC_POLICY_V1.catalogVersion,
  items: freezeCatalogItems(LEGACY_ITEMS),
});

export const DEEP_DIAGNOSTIC_CATALOG_V1 = Object.freeze({
  version: DEEP_DIAGNOSTIC_POLICY_V1.catalogVersion,
  items: freezeCatalogItems([...LEGACY_ITEMS, ...LEGACY_DEEP_ITEMS]),
});

export const SHORT_DIAGNOSTIC_CATALOG = Object.freeze({
  version: SHORT_DIAGNOSTIC_POLICY.catalogVersion,
  items: freezeCatalogItems([...ITEMS, ...SPEAKING_DIAGNOSTIC_ITEMS]),
});

export const DEEP_DIAGNOSTIC_CATALOG = Object.freeze({
  version: DEEP_DIAGNOSTIC_POLICY.catalogVersion,
  items: freezeCatalogItems([...ITEMS, ...SPEAKING_DIAGNOSTIC_ITEMS, ...DEEP_ITEMS]),
});

export function createDiagnosticRegistry(definitions, { currentVersion } = {}) {
  const entries = new Map(definitions.map(({ catalog, policy }) => {
    if (!catalog?.version || catalog.version !== policy?.catalogVersion) {
      throw new Error('DIAGNOSTIC_CATALOG_POLICY_VERSION_MISMATCH');
    }
    return [catalog.version, Object.freeze({
      catalog,
      policy,
      itemById: new Map(catalog.items.map((item) => [item.id, item])),
    })];
  }));
  if (!entries.has(currentVersion)) throw new Error('DIAGNOSTIC_CURRENT_VERSION_UNSUPPORTED');
  const versionByDepth = new Map(definitions.map(({ policy }) => [policy.depth || 'short', policy.catalogVersion]));
  return Object.freeze({
    currentVersion,
    get(version) { return entries.get(version) || null; },
    versionForDepth(depth) { return versionByDepth.get(depth) || null; },
  });
}

export const DIAGNOSTIC_REGISTRY = createDiagnosticRegistry([
  { catalog: SHORT_DIAGNOSTIC_CATALOG_V1, policy: SHORT_DIAGNOSTIC_POLICY_V1 },
  { catalog: DEEP_DIAGNOSTIC_CATALOG_V1, policy: DEEP_DIAGNOSTIC_POLICY_V1 },
  { catalog: SHORT_DIAGNOSTIC_CATALOG, policy: SHORT_DIAGNOSTIC_POLICY },
  { catalog: DEEP_DIAGNOSTIC_CATALOG, policy: DEEP_DIAGNOSTIC_POLICY },
], { currentVersion: SHORT_DIAGNOSTIC_POLICY.catalogVersion });

export function getDiagnosticCatalog(catalogVersion, registry = DIAGNOSTIC_REGISTRY) {
  return registry.get(catalogVersion)?.catalog || null;
}

export function getDiagnosticPolicy(catalogVersion, registry = DIAGNOSTIC_REGISTRY) {
  return registry.get(catalogVersion)?.policy || null;
}

export function getDiagnosticItem(catalogVersion, itemId, registry = DIAGNOSTIC_REGISTRY) {
  return registry.get(catalogVersion)?.itemById.get(itemId) || null;
}

export function publicDiagnosticItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    prompt: item.prompt,
    choices: item.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    estimatedSeconds: item.estimatedSeconds,
    ...(item.presentation ? { presentation: item.presentation } : {}),
    ...(item.speechText ? { speechText: item.speechText } : {}),
    ...(item.measurementNotice ? { measurementNotice: item.measurementNotice } : {}),
  };
}

function sessionModuleUncertainty(catalog, sessionResponses) {
  const itemById = new Map(catalog.items.map((item) => [item.id, item]));
  const adjustmentByModule = new Map();
  for (const response of sessionResponses) {
    const item = itemById.get(response.item_id ?? response.itemId);
    const choiceId = response.choice_id ?? response.choiceId;
    if (!item || !item.choices.some((choice) => choice.id === choiceId)) continue;
    const adjustment = choiceId === item.correctChoiceId ? -35 : 50;
    adjustmentByModule.set(item.module, (adjustmentByModule.get(item.module) || 0) + adjustment);
  }
  return adjustmentByModule;
}

export function selectDiagnosticItem(
  catalogVersion,
  profile,
  answeredItemIds = [],
  sessionResponses = [],
  registry = DIAGNOSTIC_REGISTRY,
) {
  const catalog = getDiagnosticCatalog(catalogVersion, registry);
  if (!catalog) return null;
  const answered = new Set(answeredItemIds);
  const estimateById = new Map((profile?.skills || []).map((skill) => [skill.id, skill]));
  const adjustmentByModule = sessionModuleUncertainty(catalog, sessionResponses);
  return catalog.items
    .filter((item) => !answered.has(item.id))
    .sort((left, right) => {
      const leftEstimate = estimateById.get(left.skillId);
      const rightEstimate = estimateById.get(right.skillId);
      const leftUncertainty = Number.isFinite(Number(leftEstimate?.uncertainty))
        ? Number(leftEstimate.uncertainty) : 100;
      const rightUncertainty = Number.isFinite(Number(rightEstimate?.uncertainty))
        ? Number(rightEstimate.uncertainty) : 100;
      const leftAdaptiveUncertainty = Math.max(0, Math.min(
        150,
        leftUncertainty + (adjustmentByModule.get(left.module) || 0),
      ));
      const rightAdaptiveUncertainty = Math.max(0, Math.min(
        150,
        rightUncertainty + (adjustmentByModule.get(right.module) || 0),
      ));
      const leftPriority = leftAdaptiveUncertainty * left.egeImpact;
      const rightPriority = rightAdaptiveUncertainty * right.egeImpact;
      return rightPriority - leftPriority || left.id.localeCompare(right.id);
    })[0] || null;
}
