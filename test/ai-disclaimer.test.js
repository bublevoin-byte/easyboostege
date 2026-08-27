import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  AUTOMATIC_ASSESSMENT_WARNING,
  EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  EGE_MOCK_WRITING_ASSESSMENT_LABEL,
  validEgeMockWritingAssessmentState,
} from '../public/automatic-assessment-contract.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT as SHARED_AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../shared/automatic-assessment-contract.js';

const REQUIRED = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';

/*
 * Код предметных экранов приезжает отдельными чанками, поэтому «приложение» — это оболочка
 * public/app.js плюс всё, что лежит в public/screens.
 */
async function readApplicationSource() {
  const screensDirectory = new URL('../public/screens/', import.meta.url);
  const names = (await fs.readdir(screensDirectory)).filter((name) => name.endsWith('.js')).sort();
  const sources = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    ...names.map((name) => fs.readFile(new URL(name, screensDirectory), 'utf8')),
  ]);
  return sources.join('\n');
}

const [html, app, openapi] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readApplicationSource(),
  fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
]);

function normalize(value) {
  return value.replace(/\s+/gu, ' ');
}

test('the public automatic-assessment warning equals the required wording', () => {
  assert.equal(AUTOMATIC_ASSESSMENT_WARNING, REQUIRED, 'the canonical constant must match the specification');
  assert.equal(SHARED_AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT.warning, AUTOMATIC_ASSESSMENT_WARNING,
    'the browser adapter re-exports the neutral server/browser contract');
});

test('the ordinary Writing API documents the exact assessment warning and task-specific payload limits', () => {
  const writing = openapi.match(/  \/api\/v1\/ai\/evaluate-writing:[\s\S]*?(?=\n  \/api\/v1\/ai\/generate-content:)/u)?.[0] || '';
  const assessment = openapi.match(/    ExperimentalAssessment:[\s\S]*?(?=\n    [A-Z][A-Za-z]+:)/u)?.[0] || '';
  assert.match(writing, /oneOf:[\s\S]*enum: \[writing_37\][\s\S]*maxLength: 12000[\s\S]*enum: \[writing_38\][\s\S]*maxLength: 20000/u);
  assert.match(writing, /taskId: \{ type: string, minLength: 1, maxLength: 120 \}/u);
  assert.match(writing, /WRITING_EVALUATION_REPEAT_ACKNOWLEDGED/u);
  assert.match(assessment, new RegExp(REQUIRED.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(assessment, /additionalProperties: false/u);
});

test('the browser-safe EGE writing projection validator matches every discriminated state', () => {
  const base = {
    assessmentRevision: 1,
    mode: 'experimental',
    scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING,
    label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryCount: 0,
  };
  const accepted = [
    { ...base, status: 'not_started', retryAllowed: false },
    { ...base, status: 'pending', retryAllowed: false },
    { ...base, status: 'in_progress', retryAllowed: false },
    { ...base, status: 'completed', retryAllowed: false },
    { ...base, status: 'retryable', retryAllowed: true },
    { ...base, status: 'retryable', retryAllowed: false, retryCount: 3 },
    {
      ...base, status: 'ambiguous', retryAllowed: true,
      retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
    },
    {
      ...base, status: 'ambiguous', retryAllowed: false, retryCount: 3,
      retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
    },
    {
      ...base, status: 'pending', retryAllowed: false,
      runDisposition: 'subscription_required',
    },
  ];
  accepted.forEach((candidate) => assert.equal(validEgeMockWritingAssessmentState(candidate), true));

  const rejected = [
    { ...accepted[1], mode: 'official' },
    { ...accepted[1], scoreKind: 'final' },
    { ...accepted[1], warning: '' },
    { ...accepted[1], label: 'Итоговая оценка' },
    { ...accepted[4], retryAllowed: false },
    { ...accepted[6], retryWarning: '' },
    { ...accepted[8], status: 'completed' },
    { ...accepted[1], extra: true },
  ];
  rejected.forEach((candidate) => assert.equal(validEgeMockWritingAssessmentState(candidate), false));
});

test('the written review screen shows the disclaimer', () => {
  assert.match(html, /id="ai_disclaimer"/u);
  assert.match(app, /getElementById\('ai_disclaimer'\)\.textContent=ui\.AI_DISCLAIMER/u);
  assert.match(
    normalize(html),
    /id="rv_score"[\s\S]{0,1200}id="ai_disclaimer"/u,
    'the warning must be part of the score banner, not below the whole review',
  );
});

test('the written review screen shows the server evaluation scope without replacing the disclaimer', () => {
  assert.match(html, /id="rv_scope_notice" hidden/u);
  assert.match(app, /writingModule\.evaluationNotice\(evaluationScope\)/u);
  assert.match(app, /renderReview\(d,response\.evaluationScope,response\.voiceTutor,\{progressStored\}\)/u);
  assert.match(app, /getElementById\('ai_disclaimer'\)\.textContent=ui\.AI_DISCLAIMER/u);
});

test('the speaking review shows the same disclaimer from the shared constant', () => {
  assert.match(app, /ui\.escapeHtml\(ui\.AI_DISCLAIMER\)/u);
  assert.match(app, /class="[^"]*\bai-disclaimer\b[^"]*"/u,
    'the shared disclaimer class may coexist with a screen-specific presentation class');
  assert.match(app, /speakingModule\.isExperimentalTask\(SP\.t\)/u, 'only free-response speaking tasks 3–4 carry the experimental warning');
  assert.match(
    normalize(app),
    /d\.got\+' из '\+d\.max[\s\S]{0,1200}class="[^"]*\bai-disclaimer\b[^"]*"/u,
    'the warning must be rendered immediately with the speaking score',
  );
  // Nobody may paste a second, drifting copy of the sentence into the application code.
  assert.doesNotMatch(app, /Экспериментальная ИИ-оценка/u);
});
