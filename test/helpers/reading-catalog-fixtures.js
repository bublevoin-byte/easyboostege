import {
  READING_CATALOG_ID,
  READING_CONTRACT_VERSION,
} from '../../public/reading-catalog-contract.js';

export const READING_EXPECTED_CEFR_COUNTS = Object.freeze({ B1: 4, B2: 12, 'B2+/C1': 4 });
export const READING_POSITION_LABELS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

export function cloneReadingFixture(value) {
  return structuredClone(value);
}

export function normalizedReadingText(value) {
  return value.trim().toLocaleLowerCase('en').replace(/\s+/gu, ' ');
}

export function englishWordCount(value) {
  return value.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*/gu)?.length || 0;
}

export function russianWordCount(value) {
  return value.match(/[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/gu)?.length || 0;
}

function futureEnvelope(kind, index) {
  const cefr = index < 4 ? 'B1' : (index < 16 ? 'B2' : 'B2+/C1');
  return {
    id: `${READING_CATALOG_ID}.${kind}.future-${String(index + 1).padStart(2, '0')}`,
    revision: 1,
    kind,
    title: `Future ${kind} fixture ${index + 1}`,
    topic: `future-${kind}-${index + 1}`,
    cefr,
    provenance: 'original',
    validation: { contract: READING_CONTRACT_VERSION },
  };
}

export function futureTask11Set(index) {
  const set = futureEnvelope('task11', index);
  const segments = Array.from({ length: 7 }, (_, position) => (
    `Future gap fixture ${index + 1}, segment ${position + 1}, provides distinct surrounding context for strict catalog validation. `
  ));
  return {
    ...set,
    task: {
      segments,
      fragments: Array.from({ length: 7 }, (_, position) => (
        `future fragment ${index + 1}-${position + 1} completes one grammatical connection`
      )),
      answers: [0, 1, 2, 3, 4, 5],
      evidence: Array.from({ length: 6 }, (_, position) => ({
        position: READING_POSITION_LABELS[position],
        answer: position,
        leftContext: segments[position].trim(),
        rightContext: segments[position + 1].trim(),
        quote: `Future gap fixture ${index + 1}, segment ${position + 1}`,
        explanationRu: `Тестовый контекст позиции ${position + 1} однозначно связывает соседние части будущего комплекта ${index + 1}.`,
      })),
    },
  };
}

export function futureTask12Set(index) {
  const set = futureEnvelope('task12_18', index);
  const details = Array.from({ length: 7 }, (_, position) => (
    `Future detail fixture ${index + 1}-${position + 1} records an independent fact for strict validation. `
      + 'Its deliberately separate wording keeps the passage and question globally identifiable without modelling production content.'
  ));
  return {
    ...set,
    task: {
      text: details.join(' '),
      questions: details.map((_, position) => ({
        id: `${set.id}.q${position + 1}`,
        prompt: `Which independent fact is tested by future fixture ${index + 1}-${position + 1}?`,
        options: Array.from({ length: 4 }, (__, option) => (
          `Future option ${index + 1}-${position + 1}-${option + 1}`
        )),
        answer: position % 4,
        evidence: {
          quote: `Future detail fixture ${index + 1}-${position + 1} records an independent fact`,
          explanationRu: `Тестовая цитата позиции ${position + 1} связывает вопрос с отдельным фактом будущего комплекта ${index + 1}.`,
        },
      })),
    },
  };
}

export function futureTask11Sets() {
  return Array.from({ length: 20 }, (_, index) => futureTask11Set(index));
}

export function futureTask12Sets() {
  return Array.from({ length: 20 }, (_, index) => futureTask12Set(index));
}
