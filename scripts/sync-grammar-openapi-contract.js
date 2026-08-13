import fs from 'node:fs/promises';

import {
  GRAMMAR_CATALOG,
  GRAMMAR_CATALOG_REGISTRY,
  GRAMMAR_CATALOG_RUNTIMES,
  getGrammarCatalogRuntime,
} from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
} from '../public/grammar-domain-contract.js';
import { buildGrammarOpenApiCatalogOwnership } from './grammar-openapi-catalog-contract.js';

const kinds = Object.freeze(['c', 'c2', 'f', 'correction', 'transform']);
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const topicIdFromPointer = (id) => Number(id.match(/^core\.g\.(\d+)\./u)?.[1]);
const allItems = Object.values(GRAMMAR_CATALOG.bank).flatMap((levels) => (
  kinds.flatMap((kind) => levels[kind] || [])
)).sort((left, right) => ordinal(left.id, right.id));
const allItemIds = allItems.map((item) => item.id);
const examItems = GRAMMAR_CATALOG.exams.flatMap((form) => form.gaps.map((gap) => ({
  id: gap.id,
  topicId: Number(gap.t),
}))).sort((left, right) => ordinal(left.id, right.id));
const legacyItemIds = new Set(Object.values(GRAMMAR_CATALOG_REGISTRY)
  .filter((catalog) => catalog !== GRAMMAR_CATALOG)
  .flatMap((catalog) => {
    const runtime = getGrammarCatalogRuntime(catalog.version, catalog.revision);
    return GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS
      .filter((topicId) => !runtime.hasActivePractice(topicId))
      .flatMap((topicId) => ['c', 'c2', 'f'].flatMap((kind) => (
        catalog.bank[topicId][kind].map((item) => item.id)
      )));
  }));
const activeChoiceItems = GRAMMAR_ACTIVE_TOPIC_IDS.flatMap((topicId) => (
  GRAMMAR_CATALOG.bank[topicId].c
)).sort((left, right) => ordinal(left.id, right.id));
const activeTextItems = GRAMMAR_ACTIVE_TOPIC_IDS.flatMap((topicId) => (
  ['f', 'correction', 'transform'].flatMap((kind) => GRAMMAR_CATALOG.bank[topicId][kind])
)).sort((left, right) => ordinal(left.id, right.id));
const nullIndependentErrorItems = allItems.filter((item) => (
  item.type !== 'choice'
  || !item.diagnostics?.some(Boolean)
  || (GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.includes(topicIdFromPointer(item.id))
    && legacyItemIds.has(item.id))
));
const nullIndependentErrorItemIds = nullIndependentErrorItems.map((item) => item.id);

function schema(name, lines) {
  return [`    ${name}:`, ...lines.map((line) => `      ${line}`)].join('\n');
}

function exactNullableString(value) {
  return value == null
    ? { nullable: true, enum: [null] }
    : { type: 'string', enum: [value] };
}

function exactCatalogSchema(identity, description) {
  return {
    type: 'object',
    description,
    required: ['version', 'revision'],
    properties: {
      version: { type: 'string', enum: [identity.version] },
      revision: { type: 'integer', enum: [identity.revision] },
    },
    additionalProperties: false,
  };
}

const catalogOwnership = buildGrammarOpenApiCatalogOwnership({
  runtimes: GRAMMAR_CATALOG_RUNTIMES,
  activeTopicIds: GRAMMAR_ACTIVE_TOPIC_IDS,
  preActivationTopicIds: GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
});

const catalogItemIdSchema = schema('GrammarBuiltinCatalogItemId', [
  'type: string',
  `enum: ${JSON.stringify(allItemIds)}`,
  'description: Catalog-generated exact whitelist of built-in grammar item pointers.',
]);

const examItemIdSchema = schema('GrammarBuiltinExamItemId', [
  'type: string',
  `enum: ${JSON.stringify(examItems.map((item) => item.id))}`,
  'description: Catalog-generated exact whitelist of immutable built-in 19–24 gap pointers.',
]);
const examItemOwnershipSchema = schema('GrammarBuiltinExamItemOwnership', [
  'type: object',
  'description: Catalog-generated exact built-in exam gap and physical topic ownership.',
  'required: [id, topicId]',
  'oneOf:',
  ...examItems.map((item) => `  - ${JSON.stringify({
    required: ['id', 'topicId'],
    properties: {
      id: { type: 'string', enum: [item.id] },
      topicId: { type: 'integer', enum: [item.topicId] },
    },
  })}`),
]);
const examIndependentErrorOwnershipSchema = schema('GrammarBuiltinExamIndependentErrorOwnership', [
  'type: object',
  'description: Catalog-generated exact built-in exam error pointer and physical topic ownership.',
  'required: [itemId, topicId]',
  'oneOf:',
  ...examItems.map((item) => `  - ${JSON.stringify({
    required: ['itemId', 'topicId'],
    properties: {
      itemId: { type: 'string', enum: [item.id] },
      topicId: { type: 'integer', enum: [item.topicId] },
    },
  })}`),
]);

const diagnosticBranches = activeChoiceItems.flatMap((item) => (
  item.diagnostics.filter(Boolean).map((diagnostic) => ({
    title: `Exact diagnostic tuple for ${diagnostic.id}`,
    required: ['diagnosticId', 'confusionPair'],
    properties: {
      diagnosticId: { type: 'string', enum: [diagnostic.id] },
      confusionPair: exactNullableString(diagnostic.confusionPair || null),
    },
    oneOf: [
      {
        required: ['id', 'correct', 'errorCode'],
        properties: {
          id: { type: 'string', enum: [item.id] },
          correct: { type: 'boolean', enum: [false] },
          errorCode: { type: 'string', enum: [diagnostic.errorCode] },
        },
      },
      {
        required: ['itemId', 'reason'],
        properties: {
          itemId: { type: 'string', enum: [item.id] },
          reason: { type: 'string', enum: [diagnostic.errorCode] },
        },
      },
    ],
  }))
));
const activeTextSessionBranches = activeTextItems.map((item) => ({
  title: `Exact active text session weakness for ${item.id}`,
  required: ['id', 'correct', 'diagnosticId', 'errorCode', 'confusionPair'],
  properties: {
    id: { type: 'string', enum: [item.id] },
    correct: { type: 'boolean', enum: [false] },
    diagnosticId: { nullable: true, enum: [null] },
    errorCode: { type: 'string', enum: [item.errorSkill] },
    confusionPair: exactNullableString(item.confusionPair || null),
  },
}));
const nullIndependentErrorBranches = nullIndependentErrorItems.flatMap((item) => {
  const preActivationLegacy = GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.includes(topicIdFromPointer(item.id))
    && legacyItemIds.has(item.id);
  const tuples = [];
  if (item.type !== 'choice' || !item.diagnostics?.some(Boolean)) {
    tuples.push({
      contract: 'current',
      reason: item.errorSkill || (item.type === 'input' ? 'word_or_verb_form' : 'construction_choice'),
      confusionPair: item.confusionPair || null,
    });
  }
  if (preActivationLegacy) {
    tuples.push({
      contract: 'historical',
      reason: item.type === 'input' ? 'word_or_verb_form' : 'construction_choice',
      confusionPair: null,
    });
  }
  const unique = new Map(tuples.map((tuple) => (
    [`${tuple.reason}\t${tuple.confusionPair || ''}`, tuple]
  )));
  return [...unique.values()].map(({ contract, reason, confusionPair }) => ({
    title: `Exact ${contract} null-diagnostic independent error for ${item.id}`,
    required: ['itemId', 'diagnosticId', 'reason', 'confusionPair'],
    properties: {
      itemId: { type: 'string', enum: [item.id] },
      diagnosticId: { nullable: true, enum: [null] },
      reason: { type: 'string', enum: [reason] },
      confusionPair: exactNullableString(confusionPair),
    },
  }));
});
const ownershipSchema = schema('GrammarActiveItemDiagnosticOwnership', [
  'type: object',
  'description: Catalog-generated exact item, selected-option diagnostic, weakness and confusion tuple shared by submitted outcomes and independent errors.',
  'required: [diagnosticId]',
  'oneOf:',
  '  - title: Correct built-in session outcome without weakness evidence',
  '    required: [id, correct, diagnosticId, errorCode, confusionPair]',
  '    properties:',
  "      id: { $ref: '#/components/schemas/GrammarBuiltinCatalogItemId' }",
  '      correct: { type: boolean, enum: [true] }',
  '      diagnosticId: { nullable: true, enum: [null] }',
  '      errorCode: { nullable: true, enum: [null] }',
  '      confusionPair: { nullable: true, enum: [null] }',
  ...diagnosticBranches.map((branch) => `  - ${JSON.stringify(branch)}`),
  ...activeTextSessionBranches.map((branch) => `  - ${JSON.stringify(branch)}`),
  ...nullIndependentErrorBranches.map((branch) => `  - ${JSON.stringify(branch)}`),
]);

const nullIndependentErrorSchema = schema('GrammarNullDiagnosticIndependentErrorItemId', [
  'type: string',
  `enum: ${JSON.stringify(nullIndependentErrorItemIds)}`,
  'description: Catalog-generated exact whitelist of text, c2, inactive legacy and queued pre-activation pointers that can carry historical null diagnostic evidence.',
]);

const preActivationLegacyCatalogBranches = catalogOwnership.preActivationLegacyBranches.map((branch) => ({
  title: branch.title,
  required: ['topicId', 'event'],
  properties: {
    topicId: { type: 'integer', enum: [branch.topicId] },
    event: {
      type: 'object', required: ['session'], properties: {
        session: {
          type: 'object', required: ['catalog', 'items'], properties: {
            catalog: exactCatalogSchema(branch.catalog, 'Exact immutable queued catalog identity.'),
            items: {
              type: 'array', items: {
                type: 'object', required: ['id'], properties: {
                  id: { type: 'string', enum: branch.itemIds },
                },
              },
            },
          },
        },
      },
    },
  },
}));
const preActivationLegacySchema = schema('GrammarPreActivationLegacyBuiltinMasteryEventRequest', [
  'type: object',
  'description: Catalog-generated compatibility envelope for a built-in choice/input session queued before its topic was activated. Catalog identity, inactive capability and exact immutable item membership are coupled in one branch.',
  'required: [topicId, event]',
  'properties:',
  `  topicId: { type: integer, enum: ${JSON.stringify(GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS)} }`,
  '  event:',
  '    allOf:',
  "      - $ref: '#/components/schemas/GrammarMasterySessionEvent'",
  '      - type: object',
  '        x-easyboost-grammar-legacy-retry-order: session-items',
  '        required: [source, session]',
  '        properties:',
  '          source: { type: string, enum: [builtin] }',
  '          session:',
  '            type: object',
  '            required: [mode, items]',
  '            properties:',
  '              mode: { type: string, enum: [legacy_practice] }',
  '              items:',
  '                type: array',
  '                items:',
  '                  oneOf:',
  "                    - $ref: '#/components/schemas/GrammarPreActivationLegacyChoiceSessionItem'",
  "                    - $ref: '#/components/schemas/GrammarPreActivationLegacyInputSessionItem'",
  'oneOf:',
  ...preActivationLegacyCatalogBranches.map((branch) => `  - ${JSON.stringify(branch)}`),
  'additionalProperties: false',
]);

const activeCatalogBranches = catalogOwnership.activeCatalogBranches.map((branch) => ({
  title: branch.title,
  required: ['topicId', 'event'],
  properties: {
    topicId: { type: 'integer', enum: branch.topicIds },
    event: {
      type: 'object', required: ['session'], properties: {
        session: {
          type: 'object', required: ['catalog'], properties: {
            catalog: exactCatalogSchema(branch.catalog, 'Registry-generated active catalog identity.'),
          },
        },
      },
    },
  },
}));
const activeTopicPointerBranches = GRAMMAR_ACTIVE_TOPIC_IDS.map((topicId) => ({
  title: `Active topic ${topicId} pointer ownership`,
  required: ['topicId', 'event'],
  properties: {
    topicId: { type: 'integer', enum: [topicId] },
    event: {
      type: 'object', required: ['session'], properties: {
        session: {
          type: 'object', required: ['items'], properties: {
            items: {
              type: 'array', items: {
                type: 'object', required: ['id'], properties: {
                  id: {
                    type: 'string',
                    pattern: `^core\\.g\\.${topicId}\\.(?:c|c2|f|correction|transform)\\.[1-9]\\d*$`,
                  },
                  diagnosticId: {
                    type: 'string', nullable: true,
                    pattern: `^core\\.g\\.${topicId}\\.c\\.[1-9]\\d*\\.diagnostic\\.[1-9]\\d*$`,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}));
const activeBuiltinMasteryEventSchema = schema('GrammarActiveBuiltinMasteryEventRequest', [
  'type: object',
  'required: [topicId, event]',
  'properties:',
  `  topicId: { type: integer, enum: ${JSON.stringify(GRAMMAR_ACTIVE_TOPIC_IDS)} }`,
  '  event:',
  '    allOf:',
  "      - $ref: '#/components/schemas/GrammarMasterySessionEvent'",
  '      - type: object',
  '        required: [source, session]',
  '        properties:',
  '          source: { type: string, enum: [builtin] }',
  '          session:',
  '            type: object',
  '            required: [mode]',
  '            properties:',
  '              mode: { type: string, enum: [topic_practice] }',
  'allOf:',
  "  - $ref: '#/components/schemas/GrammarActiveTopicIndependentErrorOwnership'",
  '  - oneOf:',
  ...activeCatalogBranches.map((branch) => `      - ${JSON.stringify(branch)}`),
  'oneOf:',
  ...activeTopicPointerBranches.map((branch) => `  - ${JSON.stringify(branch)}`),
]);

const activePracticeSessionSchema = schema('GrammarActivePracticeSession', [
  'type: object',
  'description: Bounded answer-free evidence stored atomically with the mastery event. IDs, outcomes and weakness codes are validated against the indicated server catalog. The server appends endedAt from its authoritative clock when it persists mastery history; clients cannot submit endedAt.',
  'required: [id, scope, mode, source, catalog, items, startedAt, assisted]',
  'properties:',
  '  id: { type: string, format: uuid }',
  '  scope: { type: string, enum: [topic] }',
  '  mode: { type: string, enum: [topic_practice] }',
  '  source: { type: string, enum: [builtin] }',
  '  catalog:',
  '    oneOf:',
  ...catalogOwnership.activeCatalogIdentities.map((identity) => (
    `      - ${JSON.stringify(exactCatalogSchema(identity, 'Registry-generated active Grammar 2.0 catalog identity.'))}`
  )),
  '  items:',
  '    type: array',
  '    minItems: 16',
  '    maxItems: 32',
  '    uniqueItems: true',
  '    description: Ordered completed item outcomes with exactly four non-transfer originals of every practice type plus at most sixteen distinct authored transfers. Every wrong original is immediately followed by its unique paired transfer, and a wrong transfer ends with due_next_session.',
  '    items:',
  '      allOf:',
  "        - $ref: '#/components/schemas/GrammarBuiltinPracticeSessionItem'",
  '        - not:',
  '            required: [topicId]',
  '  startedAt: { type: integer, minimum: 0, maximum: 9007199254740991 }',
  '  assisted: { type: boolean }',
  'additionalProperties: false',
]);

const legacyPracticeSessionSchema = schema('GrammarLegacyPracticeSession', [
  'type: object',
  'required: [id, scope, mode, source, catalog, items, startedAt, assisted]',
  'properties:',
  '  id: { type: string, format: uuid }',
  '  scope: { type: string, enum: [topic] }',
  '  mode: { type: string, enum: [legacy_practice] }',
  '  source: { type: string, enum: [builtin, mixed, generated] }',
  '  catalog:',
  '    description: The immutable built-in base catalog; generated items override it only through their own required owner-bound item source/revision pointer.',
  '    oneOf:',
  ...catalogOwnership.legacyCatalogIdentities.map((identity) => (
    `      - ${JSON.stringify(exactCatalogSchema(identity, 'Registry-generated immutable Grammar catalog identity.'))}`
  )),
  '  items:',
  '    type: array',
  '    minItems: 1',
  '    maxItems: 16',
  '    description: Ordered catalog-backed outcomes. Each original may appear once more only as its single retry; a second wrong outcome is closed with due_next_session and is not requeued.',
  "    items: { $ref: '#/components/schemas/GrammarLegacyPracticeSessionItem' }",
  '  startedAt: { type: integer, minimum: 0, maximum: 9007199254740991 }',
  '  assisted: { type: boolean }',
  'oneOf:',
  "  - $ref: '#/components/schemas/GrammarBuiltinLegacyPracticeSession'",
  "  - $ref: '#/components/schemas/GrammarGeneratedLegacyPracticeSession'",
  "  - $ref: '#/components/schemas/GrammarMixedLegacyPracticeSession'",
  'additionalProperties: false',
]);

function replaceSchema(source, name, replacement) {
  const startMarker = `    ${name}:`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing OpenAPI schema ${name}`);
  const remainder = source.slice(start + startMarker.length);
  const next = remainder.search(/^    [A-Za-z0-9][A-Za-z0-9_-]*:$/mu);
  if (next < 0) throw new Error(`Cannot find end of OpenAPI schema ${name}`);
  const end = start + startMarker.length + next;
  return `${source.slice(0, start)}${replacement}\n${source.slice(end)}`;
}

function insertBefore(source, nextName, replacement) {
  const marker = `    ${nextName}:`;
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Missing OpenAPI insertion point ${nextName}`);
  return `${source.slice(0, index)}${replacement}\n${source.slice(index)}`;
}

const openApiUrl = new URL('../docs/openapi.yaml', import.meta.url);
const original = (await fs.readFile(openApiUrl, 'utf8')).replace(/\r\n/gu, '\n');
let generated = original;
for (const [name, replacement] of [
  ['GrammarBuiltinExamItemId', examItemIdSchema],
  ['GrammarBuiltinExamItemOwnership', examItemOwnershipSchema],
  ['GrammarBuiltinExamIndependentErrorOwnership', examIndependentErrorOwnershipSchema],
]) {
  if (generated.includes(`    ${name}:`)) generated = replaceSchema(generated, name, replacement);
  else generated = insertBefore(generated, 'GrammarBuiltinCatalogItemId', replacement);
}
if (generated.includes('    GrammarBuiltinCatalogItemId:')) {
  generated = replaceSchema(generated, 'GrammarBuiltinCatalogItemId', catalogItemIdSchema);
} else {
  generated = insertBefore(generated, 'GrammarActiveDiagnosticId', catalogItemIdSchema);
}
generated = replaceSchema(generated, 'GrammarActiveItemDiagnosticOwnership', ownershipSchema);
generated = replaceSchema(generated, 'GrammarActiveBuiltinMasteryEventRequest', activeBuiltinMasteryEventSchema);
generated = replaceSchema(generated, 'GrammarPreActivationLegacyBuiltinMasteryEventRequest', preActivationLegacySchema);
generated = replaceSchema(generated, 'GrammarActivePracticeSession', activePracticeSessionSchema);
generated = replaceSchema(generated, 'GrammarLegacyPracticeSession', legacyPracticeSessionSchema);
if (generated.includes('    GrammarNullDiagnosticIndependentErrorItemId:')) {
  generated = replaceSchema(generated, 'GrammarNullDiagnosticIndependentErrorItemId', nullIndependentErrorSchema);
} else {
  generated = insertBefore(generated, 'GrammarBuiltinPracticeSessionItem', nullIndependentErrorSchema);
}

if (process.argv.includes('--check')) {
  if (generated !== original) throw new Error('Grammar OpenAPI catalog contract is stale; run npm run openapi:grammar:sync');
} else {
  await fs.writeFile(openApiUrl, generated, 'utf8');
}
