import { resolveEgeMockCriteriaRef as resolveCriteriaRef } from './criteria.js';
import { fingerprintEgeMockForm } from './domain.js';
import { deepFreeze } from './immutable.js';
import { EGE_MOCK_RELEASE, resolveEgeMockContentRef as resolveContentRef } from './release.js';

export const EGE_MOCK_FORM_ID = 'ege-en-2026-form-1';
export const EGE_MOCK_FORM_REVISION = 1;
const PINNED_FORM_FINGERPRINT = 'sha256:0a24dad6e3e3e37d2a30b0062351e216f0106ca1b55a859440f06f895642f001';

const SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'listening', positionRange: Object.freeze([1, 9]), maxScore: 12 }),
  Object.freeze({ id: 'reading', positionRange: Object.freeze([10, 18]), maxScore: 12 }),
  Object.freeze({ id: 'grammar_lexis', positionRange: Object.freeze([19, 36]), maxScore: 18 }),
  Object.freeze({ id: 'writing', positionRange: Object.freeze([37, 38]), maxScore: 20 }),
  Object.freeze({ id: 'speaking', positionRange: Object.freeze([39, 42]), maxScore: 20 }),
]);

const POSITION_MAX_SCORES = Object.freeze(EGE_MOCK_RELEASE.positions.map(({ maxScore }) => maxScore));
const POSITION_CONTENT_REFS = Object.freeze(EGE_MOCK_RELEASE.positions.map(({ contentRef }) => contentRef));

function sectionForPosition(position) {
  return SECTION_DEFINITIONS.find(({ positionRange: [first, last] }) => (
    position >= first && position <= last
  )).id;
}

const FORM_CONTENT = {
  id: EGE_MOCK_FORM_ID,
  revision: EGE_MOCK_FORM_REVISION,
  identity: `${EGE_MOCK_FORM_ID}@${EGE_MOCK_FORM_REVISION}`,
  examYear: 2026,
  maxScore: 82,
  sections: SECTION_DEFINITIONS,
  stimuli: EGE_MOCK_RELEASE.stimuli,
  assets: EGE_MOCK_RELEASE.assets,
  positions: Object.freeze(EGE_MOCK_RELEASE.positions.map((authoredContent) => {
    const { position, maxScore } = authoredContent;
    return Object.freeze({
      position,
      section: sectionForPosition(position),
      maxScore,
      contentRef: authoredContent.contentRef,
      presentation: authoredContent.presentation,
      assessment: authoredContent.assessment,
      assetIds: authoredContent.assetIds,
    });
  })),
};
const FORM = Object.freeze({
  ...FORM_CONTENT,
  fingerprint: PINNED_FORM_FINGERPRINT,
});
if (fingerprintEgeMockForm(FORM_CONTENT) !== PINNED_FORM_FINGERPRINT) {
  throw new Error('EGE_MOCK_FORM_RELEASE_DRIFT');
}

function invalidForm(details) {
  throw new TypeError(`EGE_MOCK_FORM_INVALID: ${details}`);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function assertEgeMockForm(candidate) {
  if (!isPlainObject(candidate)) invalidForm('form must be an object');
  if (candidate.id !== EGE_MOCK_FORM_ID || candidate.revision !== EGE_MOCK_FORM_REVISION
    || candidate.identity !== `${EGE_MOCK_FORM_ID}@${EGE_MOCK_FORM_REVISION}`
    || candidate.examYear !== 2026 || candidate.maxScore !== 82) {
    invalidForm('identity or exam envelope does not match the authored release');
  }
  if (!Array.isArray(candidate.sections) || candidate.sections.length !== SECTION_DEFINITIONS.length) {
    invalidForm('section matrix is incomplete');
  }
  candidate.sections.forEach((section, index) => {
    const expected = SECTION_DEFINITIONS[index];
    if (!isPlainObject(section) || section.id !== expected.id
      || JSON.stringify(section.positionRange) !== JSON.stringify(expected.positionRange)
      || section.maxScore !== expected.maxScore) {
      invalidForm(`section ${index + 1} does not match the exact score matrix`);
    }
  });
  if (!Array.isArray(candidate.positions) || candidate.positions.length !== 42) {
    invalidForm('positions must contain exactly 42 entries');
  }
  const refs = new Set();
  let scoreTotal = 0;
  candidate.positions.forEach((item, index) => {
    const position = index + 1;
    const expectedRef = POSITION_CONTENT_REFS[index];
    if (!isPlainObject(item) || item.position !== position
      || item.section !== sectionForPosition(position)
      || item.maxScore !== POSITION_MAX_SCORES[index]) {
      invalidForm(`position ${position} has an invalid identity or score`);
    }
    scoreTotal += item.maxScore;
    if (!isPlainObject(item.contentRef)
      || item.contentRef.catalogId !== expectedRef.catalogId
      || item.contentRef.id !== expectedRef.id
      || item.contentRef.revision !== expectedRef.revision) {
      invalidForm(`position ${position} content reference drifted`);
    }
    const resolvedContent = resolveContentRef(item.contentRef);
    if (!resolvedContent || resolvedContent.presentation !== FORM.positions[index].presentation
      || resolvedContent.assessment !== FORM.positions[index].assessment) {
      invalidForm(`position ${position} content reference does not resolve exactly`);
    }
    const refKey = `${item.contentRef.catalogId}:${item.contentRef.id}@${item.contentRef.revision}`;
    if (refs.has(refKey)) invalidForm(`position ${position} content reference is duplicated`);
    refs.add(refKey);
    if (!isPlainObject(item.presentation) || !isPlainObject(item.assessment)
      || item.assessment.maxScore !== item.maxScore) {
      invalidForm(`position ${position} content is incomplete`);
    }
    if (item.assessment.type === 'provisional') {
      const criteria = resolveCriteriaRef(item.assessment.criteriaRef);
      if (!criteria || criteria.maxScore !== item.maxScore
        || criteria.fingerprint !== item.assessment.criteriaFingerprint) {
        invalidForm(`position ${position} provisional criteria reference is invalid`);
      }
    } else if (!['ordered_choice_list', 'single_choice', 'short_text'].includes(item.assessment.type)
      || !Array.isArray(item.assessment.accepted) || item.assessment.accepted.length === 0
      || item.assessment.accepted.some((answer) => typeof answer !== 'string' || !answer)) {
      invalidForm(`position ${position} objective assessment is invalid`);
    }
    if (!Array.isArray(item.assetIds) || new Set(item.assetIds).size !== item.assetIds.length) {
      invalidForm(`position ${position} asset references are invalid`);
    }
  });
  if (scoreTotal !== 82) invalidForm('position scores must total 82');
  if (!Array.isArray(candidate.stimuli) || candidate.stimuli.length !== 2
    || new Set(candidate.stimuli.map(({ id }) => id)).size !== candidate.stimuli.length) {
    invalidForm('shared stimuli are incomplete');
  }
  if (!Array.isArray(candidate.assets) || candidate.assets.length !== 21) {
    invalidForm('asset manifest must contain exactly 21 assets');
  }
  const assetIds = new Set();
  candidate.assets.forEach((asset, index) => {
    if (!isPlainObject(asset) || asset.id !== asset.path || assetIds.has(asset.id)
      || !['audio', 'image'].includes(asset.kind)
      || !asset.path.startsWith('/') || asset.path.includes('..')
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1
      || !/^[a-f0-9]{64}$/u.test(asset.sha256 || '')) {
      invalidForm(`asset ${index + 1} is invalid`);
    }
    assetIds.add(asset.id);
  });
  const referencedAssets = new Set(candidate.positions.flatMap(({ assetIds: ids }) => ids));
  if (referencedAssets.size !== assetIds.size
    || [...referencedAssets].some((id) => !assetIds.has(id))) {
    invalidForm('asset manifest is not exactly covered by form positions');
  }
  if (candidate.fingerprint !== FORM.fingerprint
    || fingerprintEgeMockForm(candidate) !== candidate.fingerprint) {
    invalidForm('fingerprint does not match the immutable authored release');
  }
  return candidate;
}

export function getEgeMockForm(formId, formRevision) {
  return formId === EGE_MOCK_FORM_ID && formRevision === EGE_MOCK_FORM_REVISION ? FORM : null;
}

const PUBLIC_FORM = deepFreeze({
  schemaVersion: 'ege-mock-browser-form-v1',
  id: FORM.id,
  revision: FORM.revision,
  identity: FORM.identity,
  examYear: FORM.examYear,
  maxScore: FORM.maxScore,
  fingerprint: FORM.fingerprint,
  sections: structuredClone(FORM.sections),
  stimuli: structuredClone(FORM.stimuli),
  assets: structuredClone(FORM.assets),
  positions: FORM.positions.map(({ position, section, maxScore, presentation, assetIds }) => ({
    position,
    section,
    maxScore,
    presentation: structuredClone(presentation),
    assetIds: [...assetIds],
  })),
});

export function getEgeMockPublicForm(formId, formRevision) {
  return formId === EGE_MOCK_FORM_ID && formRevision === EGE_MOCK_FORM_REVISION ? PUBLIC_FORM : null;
}
