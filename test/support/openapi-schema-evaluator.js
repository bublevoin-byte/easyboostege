import { GRAMMAR_CATALOG, getGrammarCatalogRuntime } from '../../public/grammar-catalog.js';
import { egeMockDashboardSummaryMatchesPolicy } from '../../shared/ege-mock-forecast-metadata.js';
import {
  EGE_MOCK_FORECAST_POLICY,
  EGE_MOCK_RESULT_HISTORY_LIMIT,
  EGE_MOCK_RESULT_ITEM_MAXIMUMS,
  EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS,
  EGE_MOCK_RESULT_SECTION_MATRIX,
  egeMockAvailableResultMatchesComposite,
  egeMockCanonicalResponseStatesMatchItemKinds,
  egeMockCanonicalSectionStatusesMatchItems,
  egeMockCompositeResultMatchesCanonical,
  egeMockForecastScore,
  egeMockResultSkillForPosition,
} from '../../shared/ege-mock-result-contract.js';

function exactGrammarTransfers(items, catalog) {
  const runtime = getGrammarCatalogRuntime(catalog?.version, catalog?.revision);
  if (!runtime || !Array.isArray(items)) return false;
  return items.every((item, index) => {
    if (!item.transfer) return item.correct || items[index + 1]?.transfer === true;
    const original = items[index - 1];
    const originalEntry = runtime.getItem(original?.id);
    const transferEntry = runtime.getItem(item.id);
    return original?.transfer === false && original?.correct === false
      && originalEntry?.topicId === transferEntry?.topicId
      && originalEntry?.item?.type === transferEntry?.item?.type
      && originalEntry?.item?.transferPair === transferEntry?.item?.transferPair
      && original.id !== item.id;
  });
}

const EGE_WRITING_RUBRICS = Object.freeze({
  task37: Object.freeze({
    position: 37,
    maximum: 6,
    criteriaRef: 'writing-ege-2026-task37-v1',
    criteriaFingerprint: 'sha256:a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
    criteria: Object.freeze([
      ['Решение коммуникативной задачи', 2],
      ['Организация текста', 2],
      ['Языковое оформление', 2],
    ]),
  }),
  task38: Object.freeze({
    position: 38,
    maximum: 14,
    criteriaRef: 'writing-ege-2026-task38-v1',
    criteriaFingerprint: 'sha256:dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
    criteria: Object.freeze([
      ['Решение коммуникативной задачи', 3],
      ['Организация текста', 3],
      ['Лексика', 3],
      ['Грамматика', 3],
      ['Орфография и пунктуация', 2],
    ]),
  }),
});

function exactEgeCanonicalResult(value) {
  if (!Array.isArray(value?.sections) || value.sections.length !== 5
    || !Array.isArray(value?.items) || value.items.length !== 42
    || value.masteryCredit !== false
    || !egeMockCanonicalResponseStatesMatchItemKinds(value)
    || !egeMockCanonicalSectionStatusesMatchItems(value)) return false;
  const itemScores = new Map(EGE_MOCK_RESULT_SECTION_MATRIX.map(([id]) => [id, []]));
  const weak = new Map();
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    const position = index + 1;
    const section = position <= 9 ? 'listening' : position <= 18 ? 'reading'
      : position <= 36 ? 'grammar_lexis' : position <= 38 ? 'writing' : 'speaking';
    const scoreKind = position <= 36 ? 'exact' : 'approximate';
    const scoredWritingReviewInvalid = position <= 38 && item?.score != null
      && (!Array.isArray(item.criteria) || item.criteria.length < 3
        || item.feedback == null || !Array.isArray(item.evidence));
    const scoredSpeakingReviewInvalid = position >= 39 && item?.score != null
      && (!Array.isArray(item.criteria) || item.criteria.length < 1 || item.feedback == null);
    const writingStatusInvalid = position >= 37 && position <= 38 && (item?.score == null
      ? !['not_started', 'pending', 'retryable', 'ambiguous'].includes(item.status)
      : item.status !== 'completed');
    const speakingStatusInvalid = position >= 39 && (item?.score == null
      ? !['not_started', 'pending', 'retryable'].includes(item.status)
      : item.status !== 'completed');
    if (item?.position !== position || item.section !== section || item.scoreKind !== scoreKind
      || item.maximum !== EGE_MOCK_RESULT_ITEM_MAXIMUMS[index]
      || writingStatusInvalid
      || speakingStatusInvalid
      || (scoreKind === 'exact' && (item.status !== 'completed'
        || !Number.isInteger(item.score) || item.correctAnswer == null
        || item.correct !== (item.score === item.maximum)))
      || (scoreKind === 'approximate' && (item.learnerAnswer !== null || item.correctAnswer !== null
        || !item.criteriaRef || !/^sha256:[a-f0-9]{64}$/u.test(item.criteriaFingerprint || '')
        || scoredWritingReviewInvalid || scoredSpeakingReviewInvalid))
      || (item.score != null && (!Number.isInteger(item.score)
        || item.score < 0 || item.score > item.maximum))) return false;
    itemScores.get(section).push(item.score);
    if (item.score != null && item.score < item.maximum) {
      const skill = egeMockResultSkillForPosition(position);
      const evidence = weak.get(skill) || [];
      evidence.push(position);
      weak.set(skill, evidence);
    }
  }
  let objective = 0;
  let provisional = 0;
  let missing = 0;
  let scoredSubjectiveItems = 0;
  for (let index = 0; index < EGE_MOCK_RESULT_SECTION_MATRIX.length; index += 1) {
    const [id, maximum, scoreKind] = EGE_MOCK_RESULT_SECTION_MATRIX[index];
    const section = value.sections[index];
    const scores = itemScores.get(id);
    const known = scores.filter((score) => score != null);
    const score = known.length ? known.reduce((sum, itemScore) => sum + itemScore, 0) : null;
    if (section?.id !== id || section.maximum !== maximum || section.scoreKind !== scoreKind
      || section.score !== score || (scoreKind === 'exact' && score == null)) return false;
    if (scoreKind === 'exact') {
      if (known.length !== scores.length) return false;
      objective += score;
    } else {
      provisional += known.reduce((sum, itemScore) => sum + itemScore, 0);
      scoredSubjectiveItems += known.length;
      const positions = value.items.filter((item) => item.section === id);
      missing += positions.filter((item) => item.score == null)
        .reduce((sum, item) => sum + item.maximum, 0);
    }
  }
  const complete = missing === 0;
  const minimum = objective + provisional;
  const maximum = minimum + missing;
  if (value.score?.objectivePrimary !== objective
    || value.score?.provisionalSubjectivePrimary !== (scoredSubjectiveItems ? provisional : null)
    || value.score?.primaryTotal !== (complete ? minimum : null)
    || value.score?.maximum !== 82
    || value.score?.range?.minimum !== minimum || value.score?.range?.maximum !== maximum
    || value.forecast?.policyId !== EGE_MOCK_FORECAST_POLICY.id
    || value.forecast?.score !== (value.mode === 'diagnostic' && complete
      ? egeMockForecastScore(minimum) : null)
    || (value.mode === 'diagnostic' && (value.forecast?.range?.minimum
      !== egeMockForecastScore(minimum)
      || value.forecast?.range?.maximum !== egeMockForecastScore(maximum)))
    || (value.mode === 'training' && value.forecast?.range !== null)
    || value.forecast?.baselineEligible !== (value.mode === 'diagnostic')
    || value.label !== (value.mode === 'diagnostic' ? 'Диагностический' : 'Тренировочный повтор')) {
    return false;
  }
  const actual = value.recommendations;
  if (!Array.isArray(actual) || actual.length !== weak.size) return false;
  const seen = new Set();
  for (const recommendation of actual) {
    const definition = EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS[recommendation?.skillId];
    const positions = weak.get(recommendation?.skillId);
    const provisionalEvidence = positions?.some((position) => position >= 37);
    if (!definition || seen.has(recommendation.skillId) || recommendation.id !== recommendation.skillId
      || recommendation.module !== definition.module || recommendation.href !== definition.href
      || recommendation.masteryCredit !== false
      || recommendation.evidenceKind !== (provisionalEvidence
        ? 'provisional_low_score' : 'objective_error')
      || JSON.stringify(recommendation.evidencePositions) !== JSON.stringify(positions)) return false;
    seen.add(recommendation.skillId);
  }
  return true;
}

function exactEgeResultHistory(value) {
  if (!Array.isArray(value?.attempts)
    || value.attempts.length > EGE_MOCK_RESULT_HISTORY_LIMIT) return false;
  const ids = new Set();
  const baselines = value.attempts.filter((attempt) => attempt?.isBaseline === true);
  for (const attempt of value.attempts) {
    if (!attempt?.id || ids.has(attempt.id) || attempt.replacesBaseline !== false
      || attempt.result?.attemptId !== attempt.id || attempt.result?.mode !== attempt.mode
      || attempt.result?.attemptNumber !== attempt.attemptNumber
      || attempt.result?.formId !== attempt.formId
      || attempt.result?.formRevision !== attempt.formRevision
      || attempt.isBaseline !== (attempt.id === value.baselineAttemptId)
      || (attempt.isBaseline && attempt.mode !== 'diagnostic')) return false;
    ids.add(attempt.id);
  }
  return value.baselineAttemptId == null
    ? baselines.length === 0 : baselines.length === 1 && baselines[0].id === value.baselineAttemptId;
}

function exactEgeDashboardSummary(value) {
  return egeMockDashboardSummaryMatchesPolicy(value);
}

function splitFlow(source, separator = ',') {
  const parts = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function flowPair(source) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
    else if (character === ':' && depth === 0) return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
  }
  throw new Error(`Unsupported YAML flow pair: ${source}`);
}

function scalar(source) {
  const value = source.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlow(value.slice(1, -1)).map(scalar);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    return Object.fromEntries(splitFlow(value.slice(1, -1)).map((part) => {
      const [key, child] = flowPair(part);
      return [scalar(key), scalar(child)];
    }));
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

function indentation(line) {
  return line.match(/^ */u)[0].length;
}

function mappingPair(source) {
  const index = source.indexOf(':');
  if (index < 0) throw new Error(`Unsupported YAML mapping line: ${source}`);
  return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
}

function parseYamlBlock(lines, start = 0, indent = indentation(lines[start] || '')) {
  const sequence = lines[start]?.slice(indent).startsWith('- ');
  const value = sequence ? [] : {};
  let index = start;
  while (index < lines.length && indentation(lines[index]) === indent
    && lines[index].slice(indent).startsWith('- ') === sequence) {
    const content = lines[index].slice(indent + (sequence ? 2 : 0));
    if (sequence) {
      if (!content) {
        const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
        value.push(parsed.value); index = parsed.index; continue;
      }
      if (content.startsWith('{') && content.endsWith('}')) {
        value.push(scalar(content)); index += 1; continue;
      }
      if (content.includes(':')) {
        const item = {};
        const [key, rest] = mappingPair(content);
        if (rest) item[key] = scalar(rest);
        else {
          const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
          item[key] = parsed.value; index = parsed.index - 1;
        }
        index += 1;
        if (index < lines.length && indentation(lines[index]) > indent
          && !lines[index].slice(indentation(lines[index])).startsWith('- ')) {
          const parsed = parseYamlBlock(lines, index, indentation(lines[index]));
          Object.assign(item, parsed.value); index = parsed.index;
        }
        value.push(item);
        continue;
      }
      value.push(scalar(content)); index += 1; continue;
    }

    const [key, rest] = mappingPair(content);
    if (/^[>|]/u.test(rest)) {
      const blockIndent = index + 1 < lines.length ? indentation(lines[index + 1]) : indent;
      const text = [];
      index += 1;
      while (index < lines.length && indentation(lines[index]) >= blockIndent && blockIndent > indent) {
        text.push(lines[index].slice(blockIndent)); index += 1;
      }
      value[key] = text.join(' ');
      continue;
    }
    if (rest) {
      value[key] = scalar(rest); index += 1; continue;
    }
    const parsed = parseYamlBlock(lines, index + 1, indentation(lines[index + 1]));
    value[key] = parsed.value; index = parsed.index;
  }
  return { value, index };
}

function schemaBlock(openapi, name) {
  const lines = openapi.replace(/\r/gu, '').split('\n');
  const start = lines.findIndex((line) => line === `    ${name}:`);
  if (start < 0) throw new Error(`Missing OpenAPI schema ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {4}[A-Za-z0-9][A-Za-z0-9_-]*:$/u.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  return parseYamlBlock(body).value;
}

function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== 'object') return value;
  const converted = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSchema(child)]));
  if (converted.nullable === true) {
    delete converted.nullable;
    if (typeof converted.type === 'string') converted.type = [converted.type, 'null'];
    if (Array.isArray(converted.enum) && !converted.enum.includes(null)) converted.enum.push(null);
  }
  return converted;
}

function referencedSchemas(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((child) => referencedSchemas(child, found));
  else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
      found.add(value.$ref.slice('#/components/schemas/'.length));
    }
    Object.values(value).forEach((child) => referencedSchemas(child, found));
  }
  return found;
}

export function compileOpenApiSchema(openapi, name) {
  const schemas = new Map();
  function collect(schemaName) {
    if (schemas.has(schemaName)) return;
    const schema = jsonSchema(schemaBlock(openapi, schemaName));
    schemas.set(schemaName, schema);
    referencedSchemas(schema).forEach(collect);
  }
  collect(name);
  function matches(schema, value, path, errors) {
    if (schema.$ref) {
      const reference = schema.$ref.slice('#/components/schemas/'.length);
      return matches(schemas.get(reference), value, path, errors);
    }
    if (schema.allOf && !schema.allOf.every((child) => matches(child, value, path, errors))) return false;
    if (schema.oneOf) {
      const count = schema.oneOf.filter((child) => matches(child, value, path, [])).length;
      if (count !== 1) { errors.push(`${path} must match exactly one branch; matched ${count}`); return false; }
    }
    if (schema.not && matches(schema.not, value, path, [])) {
      errors.push(`${path} matches a forbidden branch`); return false;
    }
    if (schema['x-easyboost-ege-result'] === 'canonical-v1'
      && !exactEgeCanonicalResult(value)) {
      errors.push(`${path} must preserve exact EGE result totals, review and recommendations`);
      return false;
    }
    if (schema['x-easyboost-ege-result-history'] === 'baseline-v1'
      && !exactEgeResultHistory(value)) {
      errors.push(`${path} must bind one immutable diagnostic baseline without replacement`);
      return false;
    }
    if (schema['x-easyboost-ege-dashboard'] === 'baseline-v1'
      && !exactEgeDashboardSummary(value)) {
      errors.push(`${path} must bind one immutable EGE dashboard baseline to its displayed history window`);
      return false;
    }
    if (schema['x-easyboost-ege-composite-result'] === 'canonical-v1'
      && !egeMockCompositeResultMatchesCanonical(value)) {
      errors.push(`${path} must match canonical Writing and Speaking statuses`);
      return false;
    }
    if (schema['x-easyboost-ege-result-envelope'] === 'canonical-v1'
      && !egeMockAvailableResultMatchesComposite(value)) {
      errors.push(`${path} must match top-level assessment controls to the canonical result`);
      return false;
    }
    if (schema['x-easyboost-ege-writing-rubric']) {
      const rubric = EGE_WRITING_RUBRICS[schema['x-easyboost-ege-writing-rubric']];
      const exactCriteria = rubric && Array.isArray(value?.criteria)
        && value.criteria.length === rubric.criteria.length
        && value.criteria.every((criterion, index) => (
          criterion?.name === rubric.criteria[index][0]
          && criterion?.max === rubric.criteria[index][1]
          && Number.isInteger(criterion?.got)
          && criterion.got >= 0
          && criterion.got <= criterion.max
        ));
      const score = exactCriteria
        ? value.criteria.reduce((total, criterion) => total + criterion.got, 0) : null;
      if (!rubric || value?.position !== rubric.position || value?.maximum !== rubric.maximum
        || value?.criteriaRef !== rubric.criteriaRef
        || value?.criteriaFingerprint !== rubric.criteriaFingerprint
        || score !== value?.score) {
        errors.push(`${path} must equal the pinned EGE writing rubric and criterion sum`);
        return false;
      }
    }
    if (schema['x-easyboost-ege-writing-total'] === 'completed') {
      const items = value?.items;
      const exactTotal = Array.isArray(items) && items.length === 2
        && items.every((item) => item?.status === 'completed' && Number.isInteger(item.score))
        && items.reduce((total, item) => total + item.score, 0) === value?.score;
      if (!exactTotal) {
        errors.push(`${path}/score must equal the completed writing item sum`); return false;
      }
    }
    if (schema['x-easyboost-grammar-type-scores'] === 'session-items') {
      const items = value?.session?.items;
      const declared = value?.typeScores;
      if (!Array.isArray(items) || !declared || typeof declared !== 'object' || Array.isArray(declared)) return false;
      const actual = {};
      for (const item of items) {
        if (!actual[item.type]) actual[item.type] = { correct: 0, total: 0 };
        actual[item.type].total += 1;
        if (item.correct === true) actual[item.type].correct += 1;
      }
      const types = Object.keys(actual).sort();
      const declaredTypes = Object.keys(declared).sort();
      if (JSON.stringify(declaredTypes) !== JSON.stringify(types)
        || types.some((type) => declared[type]?.correct !== actual[type].correct
          || declared[type]?.total !== actual[type].total)) {
        errors.push(`${path}/typeScores must exactly equal counts from session.items`); return false;
      }
    }
    if (schema['x-easyboost-grammar-independent-error'] === 'session-items' && value?.independentError) {
      const evidence = value.independentError;
      const matchingOutcome = value?.session?.items?.some((outcome) => !outcome.correct
        && outcome.id === evidence.itemId
        && outcome.diagnosticId === evidence.diagnosticId
        && outcome.errorCode === evidence.reason
        && (outcome.confusionPair || null) === (evidence.confusionPair || null));
      if (!matchingOutcome) {
        errors.push(`${path}/independentError must exactly equal one wrong session.items outcome`); return false;
      }
    }
    if (schema['x-easyboost-grammar-topic-items'] === 'session-items') {
      const topicId = value?.topicId;
      const items = value?.event?.session?.items;
      const topicMatches = Array.isArray(items) && Number.isInteger(topicId)
        && items.every((item) => Number(/^core\.g\.(\d+)\./u.exec(item?.id || '')?.[1]) === topicId);
      if (!topicMatches) {
        errors.push(`${path}/event/session/items must all belong to topicId`); return false;
      }
    }
    if (schema['x-easyboost-grammar-mixed-bindings'] === 'event-session') {
      const event = value?.event;
      const items = event?.session?.items;
      const originals = Array.isArray(items) ? items.filter((item) => !item.transfer) : [];
      const topics = [...new Set(originals.map((item) => item.topicId))];
      const expectations = event?.session?.topicExpectations;
      const exactExpectations = Array.isArray(expectations) && expectations.length === topics.length
        && expectations.every((item, index) => item?.topicId === topics[index]);
      const ownerExpectation = expectations?.find((item) => item?.topicId === value?.topicId);
      const ownerMatches = ownerExpectation
        && ownerExpectation.expectedRevision === event.expectedRevision
        && ownerExpectation.expectedStage === event.expectedStage
        && ownerExpectation.expectedReviewStep === event.expectedReviewStep;
      const independentErrors = event?.independentErrors || [];
      const exactErrors = Array.isArray(independentErrors)
        && new Set(independentErrors.map((item) => item.topicId)).size === independentErrors.length
        && independentErrors.every((evidence) => items.some((outcome) => outcome?.correct === false
          && outcome.topicId === evidence.topicId && outcome.id === evidence.itemId
          && outcome.diagnosticId === evidence.diagnosticId && outcome.errorCode === evidence.reason
          && (outcome.confusionPair || null) === (evidence.confusionPair || null)));
      if (!exactExpectations || !ownerMatches || !exactErrors) {
        errors.push(`${path}/event/session mixed bindings are not exact`); return false;
      }
    }
    if (schema['x-easyboost-grammar-exam-bindings'] === 'event-session') {
      const event = value?.event;
      const items = event?.session?.items;
      const expectations = event?.session?.topicExpectations;
      const topics = Array.isArray(items) ? [...new Set(items.map((item) => item.topicId))] : [];
      const exactExpectations = Array.isArray(expectations) && expectations.length === topics.length
        && expectations.every((item, index) => item?.topicId === topics[index]);
      const ownerExpectation = expectations?.[0];
      const ownerMatches = value?.topicId === ownerExpectation?.topicId
        && ownerExpectation?.expectedRevision === event?.expectedRevision
        && ownerExpectation?.expectedStage === event?.expectedStage
        && ownerExpectation?.expectedReviewStep === event?.expectedReviewStep;
      let exactItems = false;
      let exactErrors = false;
      if (event?.source === 'builtin' && Array.isArray(items)) {
        exactItems = GRAMMAR_CATALOG.exams.some((form) => form.gaps.length === items.length
          && form.gaps.every((gap, index) => gap.id === items[index]?.id
            && Number(gap.t) === items[index]?.topicId));
        const expectedErrors = [];
        for (const item of items) {
          if (item.correct || expectedErrors.some((error) => error.topicId === item.topicId)) continue;
          expectedErrors.push({
            topicId: item.topicId, itemId: item.id, diagnosticId: null,
            reason: item.errorCode, confusionPair: item.confusionPair || null,
          });
        }
        exactErrors = JSON.stringify(event.independentErrors || []) === JSON.stringify(expectedErrors);
      } else if (event?.source === 'generated' && Array.isArray(items)) {
        const pointers = items.map((item) => /^generated\.g\.e\.([a-f0-9]{64})\.([a-f0-9]{16})\.([1-9]\d*)$/u.exec(item?.id || ''));
        exactItems = pointers.every(Boolean)
          && pointers.every((pointer, index) => pointer[1] === pointers[0][1]
            && pointer[2] === pointers[0][2] && Number(pointer[3]) === index + 1);
        exactErrors = !event.independentErrors;
      }
      if (!exactExpectations || !ownerMatches || !exactItems || !exactErrors) {
        errors.push(`${path}/event/session exam bindings are not exact`); return false;
      }
    }
    if (schema['x-easyboost-grammar-targeted-binding'] === 'event-session') {
      const session = value?.event?.session;
      const binding = session?.recommendation;
      const originals = Array.isArray(session?.items) ? session.items.filter((item) => !item.transfer) : [];
      const ids = originals.map((item) => item.id);
      const runtime = getGrammarCatalogRuntime(session?.catalog?.version, session?.catalog?.revision);
      const pointer = binding?.pointer;
      const supports = (item, exact) => Boolean(item && pointer) && (item.type === 'choice'
        ? item.diagnostics?.some((diagnostic) => diagnostic?.errorCode === pointer.errorCode
          && (!exact || (diagnostic.confusionPair || null) === (pointer?.confusionPair || null)))
        : item.errorSkill === pointer.errorCode
          && (!exact || (item.confusionPair || null) === (pointer.confusionPair || null)));
      const selected = ids.map((id) => runtime?.getItem(id)?.item);
      const exactCount = selected.filter((item) => supports(item, true)).length;
      const errorCount = selected.filter((item) => supports(item, false)).length;
      if (!binding || pointer?.topicId !== value?.topicId
        || pointer?.catalogVersion !== session?.catalog?.version
        || pointer?.catalogRevision !== session?.catalog?.revision
        || pointer?.masteryRevision !== value?.event?.expectedRevision
        || JSON.stringify(binding.itemIds) !== JSON.stringify(ids)
        || exactCount < 2 || errorCount < 4) {
        errors.push(`${path}/event/session targeted recommendation binding is not exact`); return false;
      }
    }
    if (schema['x-easyboost-grammar-mixed-balance'] === 'four-types-eight-topics') {
      const items = value?.items;
      const originals = Array.isArray(items) ? items.filter((item) => !item.transfer) : [];
      const typeCounts = new Map();
      const topicCounts = new Map();
      for (const item of originals) {
        typeCounts.set(item.type, (typeCounts.get(item.type) || 0) + 1);
        topicCounts.set(item.topicId, (topicCounts.get(item.topicId) || 0) + 1);
      }
      const exactTypes = ['choice', 'input', 'correction', 'transform']
        .every((type) => typeCounts.get(type) === 4) && typeCounts.size === 4;
      const balancedTopics = topicCounts.size >= 8
        && [...topicCounts.values()].every((count) => count <= 2);
      const exactTransfers = exactGrammarTransfers(items, value?.catalog)
        && items.every((item, index) => !item.transfer
          || items[index - 1]?.topicId === item.topicId);
      if (!Array.isArray(items) || originals.length !== 16 || !exactTypes || !balancedTopics
        || !exactTransfers) {
        errors.push(`${path}/items must contain four originals per type across at least eight topics, max two per topic`);
        return false;
      }
    }
    if (schema['x-easyboost-grammar-targeted-balance'] === 'eight-originals') {
      const items = value?.items;
      const originals = Array.isArray(items) ? items.filter((item) => !item.transfer) : [];
      const exactTransfers = exactGrammarTransfers(items, value?.catalog);
      if (originals.length !== 8 || !exactTransfers) {
        errors.push(`${path}/items must contain eight originals and only adjacent transfers`); return false;
      }
    }
    if (schema['x-easyboost-grammar-legacy-retry-order'] === 'session-items') {
      const items = value?.session?.items;
      if (!Array.isArray(items)) return false;
      const occurrences = new Map();
      const totals = new Map(items.map((item) => [
        item.id, items.filter((candidate) => candidate.id === item.id).length,
      ]));
      for (const item of items) {
        const occurrence = (occurrences.get(item.id) || 0) + 1;
        occurrences.set(item.id, occurrence);
        const total = totals.get(item.id);
        const first = items.find((candidate) => candidate.id === item.id);
        const validShape = total <= 2
          && !(total === 2 && (first?.correct || occurrence === 1 && item.correct))
          && !(total === 1 && !item.correct);
        const expectedTransferStatus = occurrence === 2 && !item.correct ? 'due_next_session' : null;
        if (!validShape || (item.transferStatus || null) !== expectedTransferStatus) {
          errors.push(`${path}/session/items must preserve exact legacy retry order`); return false;
        }
      }
    }
    if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      errors.push(`${path} is outside the enum`); return false;
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const normalized = actual === 'number' && Number.isInteger(value) ? ['integer', 'number'] : [actual];
      if (!types.some((type) => normalized.includes(type))) {
        errors.push(`${path} must have type ${types.join('|')}`); return false;
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) {
        errors.push(`${path} is shorter than ${schema.minLength}`); return false;
      }
      if (schema.maxLength != null && value.length > schema.maxLength) {
        errors.push(`${path} is longer than ${schema.maxLength}`); return false;
      }
      if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
        errors.push(`${path} does not match ${schema.pattern}`); return false;
      }
    }
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) return false;
      if (schema.maximum != null && value > schema.maximum) return false;
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) {
        errors.push(`${path} has fewer than ${schema.minItems} items`); return false;
      }
      if (schema.maxItems != null && value.length > schema.maxItems) {
        errors.push(`${path} has more than ${schema.maxItems} items`); return false;
      }
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
      if (schema.items && !value.every((item, index) => matches(schema.items, item, `${path}/${index}`, errors))) return false;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) return false;
      if (schema.maxProperties != null && Object.keys(value).length > schema.maxProperties) return false;
      if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) {
        errors.push(`${path} misses required properties`); return false;
      }
      if (schema.properties && !Object.entries(schema.properties).every(([key, child]) => (
        !Object.hasOwn(value, key) || matches(child, value[key], `${path}/${key}`, errors)
      ))) return false;
      if (schema.additionalProperties === false
        && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) {
        errors.push(`${path} has unsupported properties`); return false;
      }
    }
    return true;
  }
  const validate = (value) => {
    const errors = [];
    const accepted = matches(schemas.get(name), value, '#', errors);
    validate.errors = accepted ? null : errors;
    return accepted;
  };
  validate.errors = null;
  return validate;
}
