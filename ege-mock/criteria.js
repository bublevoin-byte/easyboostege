import crypto from 'node:crypto';

import { getWritingRules } from '../ai/writing.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { deepFreeze } from './immutable.js';

function exactTask(catalog, id) {
  const task = catalog.tasks.find((candidate) => candidate.id === id && candidate.revision === 1);
  if (!task) throw new Error(`EGE_MOCK_CRITERIA_SOURCE_MISSING: ${id}@1`);
  return task;
}

const writing37 = getWritingRules('writing_37');
const writing38 = getWritingRules('writing_38');
const speaking1 = exactTask(SPEAKING_TASK1_CATALOG, 'speaking-pilot-v1.task1.citizen-weather');
const speaking2 = exactTask(SPEAKING_TASK2_CATALOG, 'speaking-pilot-v1.task2.organic-farm-volunteers');
const speaking3 = exactTask(SPEAKING_TASK3_CATALOG, 'speaking-pilot-v1.task3.volunteer-projects');
const speaking4 = exactTask(SPEAKING_TASK4_CATALOG, 'speaking-pilot-v1.task4.school-projects');

const entrySources = [
  { id: 'writing-ege-2026-task37-v1', maxScore: 6, rules: structuredClone(writing37) },
  { id: 'writing-ege-2026-task38-v1', maxScore: 14, rules: structuredClone(writing38) },
  {
    id: 'speaking-ege-2026-task1-v1',
    maxScore: 1,
    rules: {
      methodicalProfile: speaking1.reference.methodicalProfile,
      criteria: [{ name: 'read_aloud', maxScore: 1 }],
    },
  },
  { id: 'speaking-ege-2026-task2-v1', maxScore: 4, rules: structuredClone(speaking2.rubric) },
  {
    id: 'speaking-ege-2026-task3-v1',
    maxScore: 5,
    rules: { perAnswerMaxScore: 1, completeness: structuredClone(speaking3.completeness) },
  },
  { id: 'speaking-ege-2026-task4-v1', maxScore: 10, rules: structuredClone(speaking4.rubric) },
];

const PINNED_FINGERPRINTS = Object.freeze({
  'writing-ege-2026-task37-v1': 'a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
  'writing-ege-2026-task38-v1': 'dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
  'speaking-ege-2026-task1-v1': '49bc79635efbd1b83ea757c6574632f1022aeb38972b9e4e2957ba6343b35311',
  'speaking-ege-2026-task2-v1': '16657f2f71118f41931a4d2881a3e5f2620922ecb6ae66eeabf7a1e6e192f627',
  'speaking-ege-2026-task3-v1': 'a6a48bbcd5abc000fe19ee53e7311a59a0bae3b1f8316359d14f02094a08a306',
  'speaking-ege-2026-task4-v1': 'ab18bb168e2e294dad719bbae829841f2f6cdfae95293d781793b2739ce67a4f',
});

const entries = entrySources.map((entry) => {
  const actual = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  if (actual !== PINNED_FINGERPRINTS[entry.id]) {
    throw new Error(`EGE_MOCK_CRITERIA_DRIFT: ${entry.id}`);
  }
  return { ...entry, fingerprint: `sha256:${actual}` };
});

for (const entry of entries) {
  const sourceMaximum = entry.id.startsWith('writing-')
    ? entry.rules.overallMax
    : [speaking1, speaking2, speaking3, speaking4]
      .find((task) => `speaking-ege-2026-task${task.taskType}-v1` === entry.id)?.maxScore;
  if (sourceMaximum !== entry.maxScore) throw new Error(`EGE_MOCK_CRITERIA_MAXIMUM_DRIFT: ${entry.id}`);
}

const EGE_MOCK_CRITERIA = deepFreeze(entries);

export function resolveEgeMockCriteriaRef(criteriaRef) {
  return EGE_MOCK_CRITERIA.find(({ id }) => id === criteriaRef) || null;
}
