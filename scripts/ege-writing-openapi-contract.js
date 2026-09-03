import { getWritingRules } from '../ai/writing.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';
import { insertBefore, replaceSchema, schema } from './openapi-schema-editor.js';

function scoreVectors(criteria, index = 0, prefix = []) {
  if (index === criteria.length) return [prefix];
  const [name, maximum] = criteria[index];
  return Array.from({ length: maximum + 1 }, (_, got) => (
    scoreVectors(criteria, index + 1, [...prefix, { name, got, max: maximum }])
  )).flat();
}

function validWritingScoreVectors(criteria) {
  return scoreVectors(criteria).filter((vector) => (
    vector[0].got !== 0 || vector.every((criterion) => criterion.got === 0)
  ));
}

function exactWritingRubricSchema(name, criteria) {
  const grouped = Map.groupBy(
    validWritingScoreVectors(criteria),
    (vector) => vector.reduce((total, criterion) => total + criterion.got, 0),
  );
  return schema(name, [
    'description: Mechanically generated exact ordered pinned-rubric vectors and their item sum.',
    'oneOf:',
    ...[...grouped.entries()].map(([score, vectors]) => `  - ${JSON.stringify({
      type: 'object',
      required: ['score', 'criteria'],
      properties: {
        score: { type: 'integer', enum: [score] },
        criteria: {
          type: 'array', minItems: criteria.length, maxItems: criteria.length, enum: vectors,
        },
      },
    })}`),
  ]);
}

function exactScopeValue(fullWords, evaluatedLimit) {
  return {
    fullWords,
    evaluatedWords: fullWords,
    truncated: false,
    evaluatedLimit,
  };
}

function aboveWritingScope(upper, evaluatedLimit) {
  return {
    type: 'object',
    required: ['fullWords', 'evaluatedWords', 'truncated', 'evaluatedLimit'],
    properties: {
      fullWords: { type: 'integer', minimum: upper + 1 },
      evaluatedWords: { type: 'integer', enum: [evaluatedLimit] },
      truncated: { type: 'boolean', enum: [true] },
      evaluatedLimit: { type: 'integer', enum: [evaluatedLimit] },
    },
    additionalProperties: false,
  };
}

function writingScopeRanges({ shoulder, upper, evaluatedLimit }) {
  return {
    below: Array.from({ length: shoulder }, (_, fullWords) => (
      exactScopeValue(fullWords, evaluatedLimit)
    )),
    within: Array.from({ length: upper - shoulder + 1 }, (_, offset) => (
      exactScopeValue(shoulder + offset, evaluatedLimit)
    )),
    above: aboveWritingScope(upper, evaluatedLimit),
  };
}

function exactWritingScopeSchema(name, bounds) {
  const ranges = writingScopeRanges(bounds);
  return schema(name, [
    'description: Mechanically generated exact official lower shoulder, full-answer band and overlength cutoff scopes.',
    'oneOf:',
    `  - ${JSON.stringify({ type: 'object', enum: ranges.below })}`,
    `  - ${JSON.stringify({ type: 'object', enum: ranges.within })}`,
    `  - ${JSON.stringify(ranges.above)}`,
  ]);
}

function exactWritingCompletedContractSchema(name, rubricName, criteria, bounds) {
  const ranges = writingScopeRanges(bounds);
  const zeroVector = validWritingScoreVectors(criteria).find((vector) => (
    vector.every((criterion) => criterion.got === 0)
  ));
  const rubricRef = { $ref: `#/components/schemas/${rubricName}` };
  const exactScopeBranch = (scope) => ({
    type: 'object', required: ['score', 'criteria', 'scope'], properties: { scope },
  });
  return schema(name, [
    'description: Mechanically generated standard OAS3 coupling of official scope, zero cascade and exact pinned rubric.',
    'oneOf:',
    `  - ${JSON.stringify({
      type: 'object',
      required: ['score', 'criteria', 'scope'],
      properties: {
        score: { type: 'integer', enum: [0] },
        criteria: {
          type: 'array', minItems: criteria.length, maxItems: criteria.length, enum: [zeroVector],
        },
        scope: { type: 'object', enum: ranges.below },
      },
    })}`,
    `  - ${JSON.stringify({
      ...exactScopeBranch({ type: 'object', enum: ranges.within }), allOf: [rubricRef],
    })}`,
    `  - ${JSON.stringify({
      ...exactScopeBranch(ranges.above), allOf: [rubricRef],
    })}`,
  ]);
}

function exactWritingTotalSchema(name, task37Maximum, task38Maximum) {
  const pairs = Array.from({ length: task37Maximum + 1 }, (_, task37Score) => (
    Array.from({ length: task38Maximum + 1 }, (_, task38Score) => ({
      task37Score, task38Score,
    }))
  )).flat();
  return schema(name, [
    'description: Mechanically generated exact completed task-score pairs and their overall sum.',
    'oneOf:',
    ...pairs.map(({ task37Score, task38Score }) => `  - ${JSON.stringify({
      type: 'object',
      required: ['score', 'items'],
      properties: {
        score: { type: 'integer', enum: [task37Score + task38Score] },
        items: {
          type: 'array', minItems: 2, maxItems: 2,
          items: {
            oneOf: [
              {
                type: 'object', required: ['position', 'status', 'score'],
                properties: {
                  position: { type: 'integer', enum: [37] },
                  status: { type: 'string', enum: ['completed'] },
                  score: { type: 'integer', enum: [task37Score] },
                },
              },
              {
                type: 'object', required: ['position', 'status', 'score'],
                properties: {
                  position: { type: 'integer', enum: [38] },
                  status: { type: 'string', enum: ['completed'] },
                  score: { type: 'integer', enum: [task38Score] },
                },
              },
            ],
          },
          not: {
            oneOf: [
              {
                type: 'array', items: {
                  type: 'object', required: ['position'],
                  properties: { position: { type: 'integer', enum: [37] } },
                },
              },
              {
                type: 'array', items: {
                  type: 'object', required: ['position'],
                  properties: { position: { type: 'integer', enum: [38] } },
                },
              },
            ],
          },
        },
      },
    })}`),
  ]);
}

function writingSchemas() {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const task37Rules = getWritingRules('writing_37');
  const task38Rules = getWritingRules('writing_38');
  const task37Criteria = task37Rules.criteria;
  const task38Criteria = task38Rules.criteria;
  const task37Bounds = {
    shoulder: Math.round(task37Rules.minWords * 0.9),
    upper: Math.round(task37Rules.maxWords * 1.1),
    evaluatedLimit: task37Rules.maxWords,
  };
  const task38Bounds = {
    shoulder: Math.round(task38Rules.minWords * 0.9),
    upper: Math.round(task38Rules.maxWords * 1.1),
    evaluatedLimit: task38Rules.maxWords,
  };
  return [
    ['EgeMockWritingTask37Scope', exactWritingScopeSchema(
      'EgeMockWritingTask37Scope', task37Bounds,
    )],
    ['EgeMockWritingTask38Scope', exactWritingScopeSchema(
      'EgeMockWritingTask38Scope', task38Bounds,
    )],
    ['EgeMockWritingTask37CompletedRubric', exactWritingRubricSchema(
      'EgeMockWritingTask37CompletedRubric', task37Criteria,
    )],
    ['EgeMockWritingTask38CompletedRubric', exactWritingRubricSchema(
      'EgeMockWritingTask38CompletedRubric', task38Criteria,
    )],
    ['EgeMockWritingTask37CompletedContract', exactWritingCompletedContractSchema(
      'EgeMockWritingTask37CompletedContract',
      'EgeMockWritingTask37CompletedRubric', task37Criteria, task37Bounds,
    )],
    ['EgeMockWritingTask38CompletedContract', exactWritingCompletedContractSchema(
      'EgeMockWritingTask38CompletedContract',
      'EgeMockWritingTask38CompletedRubric', task38Criteria, task38Bounds,
    )],
    ['EgeMockWritingCompletedTotal', exactWritingTotalSchema(
      'EgeMockWritingCompletedTotal', form.positions[36].maxScore, form.positions[37].maxScore,
    )],
  ];
}

export function syncEgeWritingOpenApiContract(source) {
  let generated = source;
  for (const [name, replacement] of writingSchemas()) {
    if (generated.includes(`    ${name}:`)) generated = replaceSchema(generated, name, replacement);
    else generated = insertBefore(generated, 'EgeMockWritingResultItem', replacement);
  }
  return generated;
}
