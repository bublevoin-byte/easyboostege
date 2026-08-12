import fs from 'node:fs/promises';

import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
} from '../public/grammar-domain-contract.js';

const kinds = Object.freeze(['c', 'c2', 'f', 'correction', 'transform']);
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const topicIdFromPointer = (id) => Number(id.match(/^core\.g\.(\d+)\./u)?.[1]);
const allItems = Object.values(GRAMMAR_CATALOG.bank).flatMap((levels) => (
  kinds.flatMap((kind) => levels[kind] || [])
)).sort((left, right) => ordinal(left.id, right.id));
const allItemIds = allItems.map((item) => item.id);
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
    && item.provenance === 'grammar-1-migrated')
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

const catalogItemIdSchema = schema('GrammarBuiltinCatalogItemId', [
  'type: string',
  `enum: ${JSON.stringify(allItemIds)}`,
  'description: Catalog-generated exact whitelist of built-in grammar item pointers.',
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
    && item.provenance === 'grammar-1-migrated';
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
if (generated.includes('    GrammarBuiltinCatalogItemId:')) {
  generated = replaceSchema(generated, 'GrammarBuiltinCatalogItemId', catalogItemIdSchema);
} else {
  generated = insertBefore(generated, 'GrammarActiveDiagnosticId', catalogItemIdSchema);
}
generated = replaceSchema(generated, 'GrammarActiveItemDiagnosticOwnership', ownershipSchema);
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
