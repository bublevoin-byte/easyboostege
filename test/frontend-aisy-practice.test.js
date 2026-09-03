import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { projectPractice } from '../public/modules/practice.js';

const EXPECTED_SKILLS = [
  ['vocabulary', 'Слова', 'scr2'],
  ['grammar', 'Грамматика', 'scr3'],
  ['reading', 'Чтение', 'scr7'],
  ['listening', 'Аудирование', 'scr4'],
  ['writing', 'Письмо', 'scr8'],
  ['speaking', 'Говорение', 'scr9'],
];

test('Practice exposes the six approved skills with one route action per row', () => {
  const view = projectPractice();

  assert.deepEqual(
    view.skills.map(({ id, label, screenId }) => [id, label, screenId]),
    EXPECTED_SKILLS,
  );
  assert.equal(view.skills.every((skill) => skill.action.screenId === skill.screenId), true);
  assert.equal(view.skills.every((skill) => skill.action.label === 'Открыть'), true);
  assert.equal(view.skills.every((skill) => skill.state === 'available'), true);
  assert.equal(new Set(view.skills.map((skill) => skill.icon)).size, 6);
  assert.equal(view.skills.every((skill) => !/\p{Extended_Pictographic}/u.test(skill.icon)), true);
});

test('Practice gives continue, review and recommendation honest precedence', () => {
  const now = Date.parse('2026-08-21T08:00:00.000Z');
  const view = projectPractice({
    now,
    recommendedSkill: 'listening',
    activeSkills: ['grammar', 'writing'],
    dueSkills: ['vocabulary', 'grammar'],
  });
  const byId = Object.fromEntries(view.skills.map((skill) => [skill.id, skill]));

  assert.deepEqual(
    ['state', 'action'].map((key) => key === 'state' ? byId.grammar.state : byId.grammar.action.label),
    ['continue', 'Продолжить'],
  );
  assert.equal(byId.writing.state, 'continue');
  assert.equal(byId.vocabulary.state, 'review');
  assert.equal(byId.vocabulary.action.label, 'Повторить');
  assert.equal(byId.listening.state, 'recommended');
  assert.equal(byId.listening.action.label, 'Начать');
  assert.equal(byId.reading.state, 'available');
  assert.match(byId.grammar.reason, /незаверш/u);
  assert.match(byId.vocabulary.reason, /повтор/u);
  assert.match(byId.listening.reason, /план/u);
  assert.deepEqual(view.nextAction, {
    skillId: 'grammar',
    label: 'Продолжить',
    screenId: 'scr3',
    title: 'Грамматика',
    reason: byId.grammar.reason,
    outcome: byId.grammar.outcome,
    availability: 'online',
    availabilityLabel: byId.grammar.availabilityLabel,
    disabled: false,
  });
});

test('Practice projects exactly one recommended next action without hiding any module', () => {
  const view = projectPractice({ recommendedSkill: 'speaking' });

  assert.equal(view.skills.length, 6);
  assert.deepEqual(view.nextAction, {
    skillId: 'speaking',
    label: 'Начать',
    screenId: 'scr9',
    title: 'Говорение',
    reason: 'Текущий план выделяет этот навык как следующий фокус.',
    outcome: 'После завершения запись можно прослушать; автоматическая оценка приблизительная.',
    availability: 'online',
    availabilityLabel: 'Задания открываются в приложении; запись и проверка используют сеть.',
    disabled: false,
  });
  assert.equal(view.skills.filter((skill) => skill.id === view.nextAction.skillId).length, 1);
});

test('Practice derives only explicit due work from existing learner state', () => {
  const now = Date.parse('2026-08-21T08:00:00.000Z');
  const ownerBinding = { username: 'learner', generation: 7 };
  const readingSets = [
    { id: 'reading-pilot-v1.task10.01', revision: 1, kind: 'task10' },
    { id: 'reading-pilot-v1.task11.01', revision: 1, kind: 'task11' },
    { id: 'reading-pilot-v1.task12_18.01', revision: 1, kind: 'task12_18' },
  ];
  const view = projectPractice({
    now,
    ownerBinding,
    readingCatalog: { id: 'reading-pilot-v1', revision: 1, sets: readingSets },
    learnerState: {
      srs: {
        due: { s: 2, due: now - 1 },
        later: { s: 3, due: now + 60_000 },
      },
      grammarMastery: {
        1: { stage: 'learned', eligibleAt: now - 1 },
        2: { stage: 'stable', eligibleAt: now - 1 },
      },
      grammarRunner: {
        schema: 'grammar-runner-v5', sessionId: '00000000-0000-4000-8000-000000000041',
        queue: [{ id: 'grammar-item' }], i: 0, phase: 'question', mode: 'topic_practice',
      },
      drafts: { '38:0': 'My saved draft' },
      readingPilotDraft: {
        version: 1,
        id: 'reading-attempt-1',
        ownerId: ownerBinding.username,
        catalogId: 'reading-pilot-v1',
        catalogRevision: 1,
        sets: readingSets,
      },
      speakingTask3SessionId: '00000000-0000-4000-8000-000000000043',
    },
  });
  const byId = Object.fromEntries(view.skills.map((skill) => [skill.id, skill]));

  assert.equal(byId.vocabulary.state, 'review');
  assert.equal(byId.grammar.state, 'continue');
  assert.equal(byId.reading.state, 'continue');
  assert.equal(byId.writing.state, 'continue');
  assert.equal(byId.speaking.state, 'continue');
  assert.match(byId.speaking.reason, /сервер проверит/u);
  assert.equal(byId.listening.state, 'available');
});

test('Practice rejects completed, malformed and blank continuation markers', () => {
  const view = projectPractice({
    learnerState: {
      grammarRunner: {
        schema: 'grammar-runner-v5', sessionId: '00000000-0000-4000-8000-000000000044',
        queue: [{ id: 'grammar-item' }], i: 1, phase: 'completed', mode: 'topic_practice',
      },
      readingPilotDraft: { version: 1, ownerId: 'learner', catalogId: 'reading-pilot-v1' },
      drafts: { '37:0': '   ' },
      speakingTask2SessionId: 'stale-session-pointer',
    },
  });
  const byId = Object.fromEntries(view.skills.map((skill) => [skill.id, skill]));

  assert.equal(byId.grammar.state, 'available');
  assert.equal(byId.writing.state, 'available');
  assert.equal(byId.speaking.state, 'available');
  assert.equal(byId.reading.state, 'available');
});

test('Practice rejects snapshots the subject restorers cannot resume', () => {
  const incompleteGrammarExam = projectPractice({
    learnerState: {
      grammarRunner: {
        schema: 'grammar-exam-runner-v1',
        sessionId: '00000000-0000-4000-8000-000000000046',
        answers: ['', '', '', '', '', ''],
        startedAt: 1,
        source: 'builtin',
      },
    },
  });
  const wrongOwnerReading = projectPractice({
    ownerBinding: { username: 'new-incarnation', generation: 2 },
    learnerState: {
      readingPilotDraft: {
        version: 1,
        id: 'reading-attempt-old-owner',
        ownerId: 'old-incarnation',
        catalogId: 'reading-pilot-v1',
        catalogRevision: 1,
        sets: [
          { id: 'reading-pilot-v1.task10.01', revision: 1, kind: 'task10' },
          { id: 'reading-pilot-v1.task11.01', revision: 1, kind: 'task11' },
          { id: 'reading-pilot-v1.task12_18.01', revision: 1, kind: 'task12_18' },
        ],
      },
    },
  });
  const missingSetReading = projectPractice({
    ownerBinding: { username: 'learner', generation: 2 },
    readingCatalog: {
      id: 'reading-pilot-v1', revision: 1,
      sets: [
        { id: 'reading-pilot-v1.task10.real', revision: 1, kind: 'task10' },
        { id: 'reading-pilot-v1.task11.real', revision: 1, kind: 'task11' },
        { id: 'reading-pilot-v1.task12_18.real', revision: 1, kind: 'task12_18' },
      ],
    },
    learnerState: {
      readingPilotDraft: {
        version: 1, id: 'reading-attempt-forged-set', ownerId: 'learner',
        catalogId: 'reading-pilot-v1', catalogRevision: 1,
        sets: [
          { id: 'reading-pilot-v1.task10.not-real', revision: 999, kind: 'task10' },
          { id: 'reading-pilot-v1.task11.real', revision: 1, kind: 'task11' },
          { id: 'reading-pilot-v1.task12_18.real', revision: 1, kind: 'task12_18' },
        ],
      },
    },
  });

  assert.equal(incompleteGrammarExam.skills.find((skill) => skill.id === 'grammar').state, 'available');
  assert.equal(wrongOwnerReading.skills.find((skill) => skill.id === 'reading').state, 'available');
  assert.equal(missingSetReading.skills.find((skill) => skill.id === 'reading').state, 'available');
});

test('each Practice row explains the existing completion consequence', () => {
  const view = projectPractice();

  assert.equal(view.skills.every((skill) => typeof skill.outcome === 'string' && skill.outcome.length > 20), true);
  assert.match(view.skills.find((skill) => skill.id === 'vocabulary').outcome, /срок|повтор/u);
  assert.match(view.skills.find((skill) => skill.id === 'writing').outcome, /приблизител/u);
  assert.match(view.skills.find((skill) => skill.id === 'speaking').outcome, /приблизител/u);
});

test('Practice describes offline limits without claiming online-only checks work', () => {
  const online = projectPractice({ online: true });
  const offline = projectPractice({ online: false, loadedSkills: ['reading'] });
  const onlineById = Object.fromEntries(online.skills.map((skill) => [skill.id, skill]));
  const offlineById = Object.fromEntries(offline.skills.map((skill) => [skill.id, skill]));

  assert.equal(offlineById.vocabulary.availability, 'offline-ready');
  assert.equal(offlineById.grammar.availability, 'offline-ready');
  assert.equal(offlineById.reading.availability, 'cached');
  assert.equal(offlineById.listening.availability, 'cache-required');
  assert.match(offlineById.listening.availabilityLabel, /первого открытия/u);
  assert.match(offlineById.writing.availabilityLabel, /ИИ-проверка требует сеть/u);
  assert.match(offlineById.speaking.availabilityLabel, /запись|провер/u);
  assert.equal(onlineById.reading.availability, 'online');
});

test('Practice keeps an uncached offline recommendation honest and non-actionable', () => {
  const view = projectPractice({ online: false, loadedSkills: [], recommendedSkill: 'listening' });

  assert.deepEqual(view.nextAction, {
    skillId: 'listening',
    label: 'Начать',
    screenId: 'scr4',
    title: 'Аудирование',
    reason: 'Текущий план выделяет этот навык как следующий фокус.',
    outcome: 'После сдачи откроется разбор, а результат появится в прогрессе.',
    availability: 'cache-required',
    availabilityLabel: 'Для первого открытия нужно подключение; затем материалы сохранятся в кэше.',
    disabled: true,
  });
});

test('Practice stays lazy, keeps its visual shell offline and only navigates into subject screens', async () => {
  const [mainSource, loaderSource, screenSource, workerSource, indexSource, styles] = await Promise.all([
    fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/practice.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/practice.css', import.meta.url), 'utf8'),
  ]);

  assert.match(loaderSource, /'aisy-practice':function\(\)\{return import\('\.\/screens\/practice\.js'\)\}/u);
  assert.doesNotMatch(mainSource, /screens\/practice\.js/u);
  assert.match(workerSource, /'\/practice\.css'/u);
  const shell = workerSource.match(/const APP_SHELL=\[[^\]]*\]/u)?.[0] || '';
  assert.match(shell, /'\/screens\/practice\.js'/u);
  assert.match(shell, /'\/modules\/practice\.js'/u);
  assert.match(screenSource, /nav\(screenId,/u);
  assert.match(indexSource, /id="practice-recommendation"[^>]*aria-live="polite"/u);
  assert.match(screenSource, /view\.nextAction/u);
  assert.match(screenSource, /nextAction\.availabilityLabel/u);
  assert.match(screenSource, /action\.disabled = nextAction\.disabled/u);
  assert.doesNotMatch(screenSource, /function primarySkill/u);
  assert.match(screenSource, /aisy-button--secondary practice-row__action/u);
  assert.match(styles, /\.practice-recommendation/u);
  assert.match(styles, /var\(--aisy-color-background\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(screenSource, /wStartPractice|gStart\(|startTraining\(|lMt\(|checkWriting\(|initSpeaking\(/u);
});
