export const EGE_MOCK_PUBLIC_SCHEMA_VERSION = 'ege-mock-browser-form-v1';
export const EGE_MOCK_PUBLIC_FORM_ID = 'ege-en-2026-form-1';
export const EGE_MOCK_PUBLIC_FORM_REVISION = 1;
export const EGE_MOCK_PUBLIC_FORM_FINGERPRINT = 'sha256:0a24dad6e3e3e37d2a30b0062351e216f0106ca1b55a859440f06f895642f001';

const FORBIDDEN_KEYS = new Set([
  'accepted', 'answer', 'answers', 'assessment', 'contentRef', 'criteriaRef',
  'evidence', 'explanationRu', 'reference', 'rubric', 'script', 'scoreRule',
]);

function invalid(location) {
  throw new TypeError(`EGE_MOCK_PUBLIC_FORM_INVALID: ${location}`);
}

function assertAnswerFree(value, location = 'form') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) invalid(`${location}.${key}`);
    assertAnswerFree(child, `${location}.${key}`);
  }
}

export function assertEgeMockPublicForm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('form');
  if (value.schemaVersion !== EGE_MOCK_PUBLIC_SCHEMA_VERSION
    || value.id !== EGE_MOCK_PUBLIC_FORM_ID
    || value.revision !== EGE_MOCK_PUBLIC_FORM_REVISION
    || value.identity !== `${EGE_MOCK_PUBLIC_FORM_ID}@${EGE_MOCK_PUBLIC_FORM_REVISION}`
    || value.examYear !== 2026 || value.maxScore !== 82
    || value.fingerprint !== EGE_MOCK_PUBLIC_FORM_FINGERPRINT) {
    invalid('identity');
  }
  if (!Array.isArray(value.positions) || value.positions.length !== 42
    || !Array.isArray(value.sections) || value.sections.length !== 5
    || !Array.isArray(value.assets) || value.assets.length !== 21) {
    invalid('matrix');
  }
  value.positions.forEach((item, index) => {
    if (item?.position !== index + 1 || !item.presentation || !Array.isArray(item.assetIds)) {
      invalid(`positions[${index}]`);
    }
  });
  assertAnswerFree(value);
  return value;
}

export async function loadEgeMockPublicForm() {
  const { EGE_MOCK_FORM_1_V1_PUBLIC } = await import('./ege-mock-form-1-v1.js');
  return assertEgeMockPublicForm(EGE_MOCK_FORM_1_V1_PUBLIC);
}
