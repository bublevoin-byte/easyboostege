import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  GRAMMAR_CATALOG,
  grammarCatalogCoverage,
} from '../public/grammar-catalog.js';
import { EasyBoostGrammar as grammar } from '../public/modules/grammar.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';

const PARTS_OF_SPEECH_TOPIC_IDS = Object.freeze([10, 11, 12, 16, 17, 20]);
const TYPES = Object.freeze(['choice', 'input', 'correction', 'transform']);
const BANK_KIND = Object.freeze({ choice: 'c', input: 'f', correction: 'correction', transform: 'transform' });

function topicItems(topicId) {
  return Object.values(GRAMMAR_CATALOG.bank[topicId]).flat();
}

function itemById(itemId) {
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    const item = topicItems(topicId).find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  assert.fail(`missing parts-of-speech item ${itemId}`);
}

test('all six parts-of-speech topics expose the complete four-level public catalog contract', () => {
  const coverage = grammarCatalogCoverage(GRAMMAR_CATALOG);
  const allIds = [];

  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    assert.deepEqual(coverage.byPracticeType[topicId], {
      choice: 8, input: 8, correction: 8, transform: 8, total: 32,
    });
    assert.equal(grammar.hasActivePractice(GRAMMAR_CATALOG.bank[topicId]), true);

    for (const type of TYPES) {
      const items = GRAMMAR_CATALOG.bank[topicId][BANK_KIND[type]];
      assert.equal(items.length, 8, `${topicId}:${type}`);
      const pairs = Map.groupBy(items, (item) => item.transferPair);
      assert.equal(pairs.size, 4, `${topicId}:${type} four bounded pairs`);
      for (const pair of pairs.values()) {
        assert.equal(pair.length, 2, `${topicId}:${type} exact mate`);
        assert.equal(new Set(pair.map((item) => `${item.errorSkill}:${item.confusionPair || '-'}`)).size, 1,
          `${topicId}:${type} mate keeps the exact targeted weakness`);
      }
      for (const item of items) {
        assert.equal(item.type, type);
        assert.match(item.e, /\S/u);
        assert.match(item.provenance, /^(grammar-1-migrated|grammar-2-ticket-05)$/u);
        assert.ok(Number.isInteger(item.difficulty) && item.difficulty >= 1 && item.difficulty <= 3);
        allIds.push(item.id);
      }
    }
  }

  assert.equal(allIds.length, 192);
  assert.equal(new Set(allIds).size, 192);
});

test('irregular forms and controlled equivalents are explicit exact answers', () => {
  const accepted = Object.freeze({
    'core.g.10.f.2': ['worse'],
    'core.g.10.f.5': ['better'],
    'core.g.10.f.7': ['further', 'farther'],
    'core.g.11.transform.3': ['This bag is hers.'],
    'core.g.12.f.1': ['twelfth'],
    'core.g.12.f.6': ['fortieth'],
    'core.g.16.f.1': ['women'],
    'core.g.16.f.5': ['mice'],
    'core.g.16.f.6': ['geese'],
    'core.g.20.f.4': ['well'],
  });

  for (const [itemId, answers] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.deepEqual(item.ans, answers, `${itemId} publishes the finite answer set`);
    for (const answer of answers) assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
    if (answers[0].endsWith('.')) {
      assert.equal(grammar.checkPracticeAnswer(item, answers[0].slice(0, -1)).correct, true,
        `${itemId} uses the shared optional-terminal-punctuation normalization`);
    }
    assert.equal(grammar.checkPracticeAnswer(item, `${answers[0]}ly`).correct, false, `${itemId} rejects an unlisted form`);
  }
});

test('controlled reconstructions accept every finite equivalent named by their prompts', () => {
  const equivalents = Object.freeze({
    'core.g.10.transform.3': ["Leo's result is better than my result.", 'Leo’s result is better than my result.'],
    'core.g.10.transform.4': [
      'Hotel C is the worst on the list.',
      'Hotel C is the worst hotel in the list.',
      'Hotel C is the worst in the list.',
      'Hotel C is the worst of the hotels in the list.',
    ],
    'core.g.10.transform.5': [
      'The first box is as heavy as the second one.',
      'The first box is as heavy as the second.',
      'The first box is as heavy as the other.',
    ],
    'core.g.10.transform.8': [
      'Team D has the least experience among the four teams.',
      'Team D has the least experience out of the four teams.',
    ],
    'core.g.11.correction.1': ['My bag is blue, but her bag is red.'],
    'core.g.12.transform.3': ['The hall has exactly three hundred seats.'],
    'core.g.12.transform.7': ['Turn to page 3.'],
  });

  const grading = {};
  for (const [itemId, answers] of Object.entries(equivalents)) {
    const item = itemById(itemId);
    for (const answer of answers) {
      grading[`${itemId}:${answer}`] = grammar.checkPracticeAnswer(item, answer).correct;
    }
  }
  assert.deepEqual(grading, Object.fromEntries(Object.keys(grading).map((key) => [key, true])),
    'every finite grammatical equivalent named by a controlled prompt is accepted');
});

test('legacy irregular-plural prompts explicitly require more than one body part', () => {
  const foot = itemById('core.g.16.c.3');
  const tooth = itemById('core.g.16.f.3');
  assert.deepEqual({
    foot: /^Both my /u.test(foot.t.join('')),
    tooth: /^Both my /u.test(tooth.s),
  }, { foot: true, tooth: true },
  'hurt alone has identical singular and plural agreement, so the visible context must require plural');
});

test('choice prompts state the comparison or no-help meaning that makes their grading unambiguous', () => {
  const weather = itemById('core.g.10.c.4');
  const reflexive = itemById('core.g.11.c.7');
  assert.deepEqual({
    comparisonRequired: /\bthan\b/iu.test(weather.t.join('')),
    noHelpMeaningRequired: /(?:no one helped|without (?:any )?help)/iu.test(reflexive.t.join('')),
  }, { comparisonRequired: true, noHelpMeaningRequired: true },
  'choice prompts must distinguish bad/worse and by them/by themselves before automatic grading');
});

test('correction and transform require active reconstruction and never expose answer options', () => {
  let checked = 0;
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    for (const kind of ['correction', 'transform']) {
      for (const item of GRAMMAR_CATALOG.bank[topicId][kind]) {
        assert.equal(Object.hasOwn(item, 'o'), false, item.id);
        assert.equal(Object.hasOwn(item, 'a'), false, item.id);
        assert.ok(Array.isArray(item.ans) && item.ans.length >= 1, item.id);
        assert.equal(grammar.checkPracticeAnswer(item, item.ans[0]).correct, true, item.id);
        assert.equal(grammar.checkPracticeAnswer(item, '__not_an_answer__').correct, false, item.id);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 96);
});

test('generic runner preserves the exact parts-of-speech weakness in the next transfer item', () => {
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    const queue = grammar.buildActiveTopicQueue(bank, topicId, `parts-${topicId}`);
    assert.equal(queue.length, 16, `${topicId} full active queue`);
    assert.deepEqual(Object.fromEntries(TYPES.map((type) => [type, queue.filter((item) => item.k === type).length])), {
      choice: 4, input: 4, correction: 4, transform: 4,
    });

    const session = { activeRunner: true, i: 0, queue: queue.slice(), reservedItemIds: queue.map((item) => item.q.id) };
    const transfers = queue.map((failedItem, index) => (
      grammar.enqueueTransferAfterFailure(session, bank, failedItem, `parts-transfer-${topicId}-${index}`)
    ));
    assert.equal(transfers.every((item) => item?.q), true, `${topicId} every original has a transfer`);
    assert.equal(new Set(transfers.map((item) => item.q.id)).size, 16, `${topicId} transfers stay unseen`);
    transfers.forEach((transfer, index) => {
      assert.equal(transfer.q.transferPair, queue[index].q.transferPair);
      assert.equal(transfer.q.errorSkill, queue[index].q.errorSkill);
      assert.equal(transfer.q.confusionPair, queue[index].q.confusionPair);
    });
  }
});

test('generic transfer selection follows the exact chosen diagnostic and fails closed for a forged weakness', () => {
  let checked = 0;
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    for (const item of bank.c) {
      item.diagnostics.forEach((diagnostic, choiceIndex) => {
        if (choiceIndex === item.a) return;
        const failed = { k: 'choice', q: item, t: topicId, transfer: false };
        const session = { activeRunner: true, i: 0, queue: [failed], reservedItemIds: [item.id] };
        const transfer = grammar.enqueueTransferAfterFailure(
          session,
          bank,
          failed,
          `parts-diagnostic-transfer-${topicId}-${item.id}-${choiceIndex}`,
          { errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null },
        );
        assert.ok(transfer?.q, `${item.id}:${choiceIndex} gets an authored transfer`);
        assert.equal(transfer.k, 'choice');
        assert.equal(transfer.q.transferPair, item.transferPair);
        assert.equal(transfer.q.diagnostics.some((candidate) => candidate
          && candidate.errorCode === diagnostic.errorCode
          && (candidate.confusionPair || null) === (diagnostic.confusionPair || null)), true,
        `${item.id}:${choiceIndex} transfer supports the selected option's exact weakness`);
        checked += 1;
      });

      const forged = { errorCode: 'auxiliary', confusionPair: 'be__have' };
      const failed = { k: 'choice', q: item, t: topicId, transfer: false };
      const session = { activeRunner: true, i: 0, queue: [failed], reservedItemIds: [item.id] };
      assert.deepEqual(grammar.enqueueTransferAfterFailure(
        session, bank, failed, `parts-forged-transfer-${item.id}`, forged,
      ), {
        status: 'due_next_session', errorCode: forged.errorCode,
        confusionPair: forged.confusionPair, maxTransferAttempts: 1,
      }, `${item.id} cannot turn a forged weakness into an unrelated pair mate`);
    }
  }
  assert.equal(checked, 144);
});

test('every wrong choice exposes only its own exact parts-of-speech diagnostic', () => {
  let checked = 0;
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    for (const item of GRAMMAR_CATALOG.bank[topicId].c) {
      item.o.forEach((_, choiceIndex) => {
        const result = grammar.checkPracticeAnswer(item, choiceIndex);
        if (choiceIndex === item.a) {
          assert.deepEqual(result, {
            correct: true, normalized: String(choiceIndex), diagnosticId: null, errorCode: null, confusionPair: null,
          });
        } else {
          const diagnostic = item.diagnostics[choiceIndex];
          assert.deepEqual(result, {
            correct: false, normalized: String(choiceIndex), diagnosticId: diagnostic.id,
            errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair,
          });
          checked += 1;
        }
      });
    }
  }
  assert.equal(checked, 144);
});

test('reviewed controlled prompts make the required exact reconstruction surface explicit', () => {
  const constraints = Object.freeze({
    'core.g.10.transform.2': /оценку интересности.*Lecture A.*более высокую оценку/u,
    'core.g.10.transform.4': /После worst разрешены только: hotel on the list; on the list; hotel in the list; in the list; of the hotels in the list/u,
    'core.g.10.transform.5': /Используйте буквальную конструкцию: The first box is as heavy as \.\.\./u,
    'core.g.10.transform.8': /Начните: Team D has.*закончите только: of the four teams; among the four teams; out of the four teams/u,
    'core.g.11.correction.7': /Замените только some на any.*не меняйте/u,
    'core.g.16.transform.1': /Замените One на Two/u,
    'core.g.16.transform.2': /Замените One на Two/u,
    'core.g.16.transform.3': /Замените One на Two/u,
    'core.g.16.transform.4': /Замените One на Two/u,
    'core.g.16.transform.5': /Замените One на Two/u,
    'core.g.16.transform.6': /Замените One на Two/u,
    'core.g.17.transform.1': /Начните: The film was/u,
    'core.g.17.transform.2': /Начните: The story was/u,
    'core.g.17.transform.3': /Начните: We were.*by the result/u,
    'core.g.17.transform.4': /Начните: Leo was.*by the instructions/u,
    'core.g.17.transform.5': /Начните: The game was.*for the children/u,
    'core.g.17.transform.6': /Начните: The children were.*by the noise/u,
    'core.g.17.transform.7': /Начните: The long climb was.*for us/u,
    'core.g.17.transform.8': /Начните: We were.*by the long climb/u,
    'core.g.20.transform.5': /Начните: The students worked.*on the project/u,
    'core.g.20.transform.6': /Начните: We could.*see the road/u,
    'core.g.20.transform.7': /Начните: The cyclist moved/u,
    'core.g.20.transform.8': /Начните: The train arrived/u,
    'core.g.12.transform.4': /Начните: Hundreds of people/u,
    'core.g.12.transform.8': /Начните: Mia came/u,
    'core.g.11.transform.7': /закончите: himself/u,
    'core.g.11.transform.8': /закончите: ourselves/u,
  });
  for (const [itemId, pattern] of Object.entries(constraints)) assert.match(itemById(itemId).s, pattern, itemId);

  const least = itemById('core.g.10.transform.8');
  assert.equal(least.ans.every((answer) => /^Team D has the least experience (?:of|among|out of) the four teams\.$/u.test(answer)), true,
    'every accepted LEAST reconstruction obeys the literal start and finite ending published by its prompt');
});

test('choice prompts disambiguate neutral some/any and cause-versus-feeling meaning', () => {
  assert.match(itemById('core.g.11.c.5').t.join(''), /neutral information question.*no expected answer/iu);
  assert.match(itemById('core.g.17.c.7').t.join(''), /instructions caused confusion/iu);
});

test('deterministic queues always leave one unseen exact transfer mate per selected item', () => {
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    for (let seed = 0; seed < 256; seed += 1) {
      const queue = grammar.buildActiveTopicQueue(bank, topicId, `parts-property-${topicId}-${seed}`);
      assert.equal(queue.length, 16);
      const selectedIds = new Set(queue.map((item) => item.q.id));
      assert.equal(selectedIds.size, 16);
      for (const selected of queue) {
        const kind = BANK_KIND[selected.k];
        const unseenMates = bank[kind].filter((candidate) => (
          candidate.id !== selected.q.id && candidate.transferPair === selected.q.transferPair && !selectedIds.has(candidate.id)
        ));
        assert.equal(unseenMates.length, 1, `${topicId}:${seed}:${selected.q.id}`);
      }
    }
  }
});

test('each clean parts-of-speech session passes the shared server envelope and reaches learned', () => {
  for (const topicId of PARTS_OF_SPEECH_TOPIC_IDS) {
    const id = `00000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`;
    const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[topicId], topicId, `parts-flow-${topicId}`);
    const items = queue.map((item) => ({
      id: item.q.id, type: item.k, transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    }));
    const event = {
      id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: [...TYPES],
      typeScores: Object.fromEntries(TYPES.map((type) => [type, { correct: 4, total: 4 }])),
      session: {
        id, scope: 'topic', mode: 'topic_practice', source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 2_000, assisted: false,
      },
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true, `topic ${topicId} envelope`);
    const learned = grammar.reduceMastery(grammar.migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
    assert.equal(learned.stage, 'learned');
    assert.equal(learned.eligibleAt, 86_402_000);
    assert.equal(learned.masteryHistory.at(-1).session.items.length, 16);
  }
});

test('the parts-of-speech bank is available in an already-installed offline shell', async () => {
  const serviceWorker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  assert.match(serviceWorker, /['"]\/grammar-parts-of-speech-content\.js['"]/u);
});
