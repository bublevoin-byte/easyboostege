import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import jwt from 'jsonwebtoken';

import { buildRepairRequest, describeFormatFailure, isFormatFailure } from '../ai/format-repair.js';

/*
 * Section 10.3: an answer that does not fit the contract earns exactly one corrected attempt.
 *
 * "Exactly one" is the whole requirement. Zero retries throws away answers whose content was fine
 * and whose shape was not. Unlimited retries burn the daily budget on an input the model cannot
 * handle while the student waits. Both failure modes are checked below.
 */

const JWT_SECRET = 'format-repair-test-secret-with-32-characters';

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/* A valid review for writing 37: three criteria, totals that add up, the real word count. */
function validReview(words) {
  return {
    words,
    in_range: words >= 90 && words <= 154,
    overall_got: 4,
    overall_max: 6,
    verdict: 'Хорошая работа',
    sub: 'Следи за объёмом',
    criteria: [
      { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
      { name: 'Организация текста', got: 1, max: 2 },
      { name: 'Языковое оформление', got: 1, max: 2 },
    ],
    errors: [{ title: 'Артикль', wrong: 'a information', right: 'information', kind: 'err', note: 'неисчисляемое' }],
  };
}

function validTask38Review(words) {
  return {
    words,
    in_range: words >= 180 && words <= 275,
    overall_got: 8,
    overall_max: 14,
    verdict: 'Хорошая основа проекта',
    sub: 'Уточни сравнения',
    criteria: [
      { name: 'Решение коммуникативной задачи', got: 2, max: 3 },
      { name: 'Организация текста', got: 2, max: 3 },
      { name: 'Лексика', got: 2, max: 3 },
      { name: 'Грамматика', got: 1, max: 3 },
      { name: 'Орфография и пунктуация', got: 1, max: 2 },
    ],
    errors: [],
  };
}

function validSpeakingReview() {
  return {
    confidence: 0.94,
    verdict: 'Монолог раскрывает все пункты плана.',
    evidence: ['Проверены четыре пункта плана.'],
    issues: [],
    phraseCount: 13,
    wordList: false,
    introductionPresent: true,
    conclusionPresent: true,
    contentAspects: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      id: `content-${index + 1}`,
      start: 0,
      end: 0,
      status: 'full',
      evidence: `Plan point ${index + 1}`,
      correction: 'No deduction.',
    })),
    organizationErrors: [],
    lexicalGrammarErrors: [],
  };
}

async function startStack({ replies }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-repair-'));
  const dataFile = path.join(directory, 'data.json');
  const port = await findAvailablePort();
  const providerPort = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const providerCalls = [];
  const queue = [...replies];
  const providerServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      providerCalls.push({
        url: request.url,
        user: body.messages?.at(-1)?.content || '',
        maxTokens: body.max_tokens,
        responseFormat: body.response_format,
      });
      const reply = queue.shift();
      if (!reply) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'no reply queued' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }));
    });
  });
  await new Promise((resolve) => providerServer.listen(providerPort, '127.0.0.1', resolve));

  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      student: {
        created: Date.now(),
        sub_until: Date.now() + 3_600_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: true,
          policy_version: '2026-08-02-voice-v1',
          updated_at: new Date().toISOString(),
        },
      },
    },
  }));

  const output = [];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      JWT_SECRET,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      TELEGRAM_BOT_TOKEN: '',
      XAI_API_KEY: 'xai-test-key',
      XAI_API_URL: `http://127.0.0.1:${providerPort}/xai`,
      XAI_MODEL: 'route-provenance-model',
      GROQ_ENABLED: 'false',
      GROQ_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился: ${output.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) break;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  /* The task bank is seeded after listen; the evaluation needs those rows. */
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    baseUrl,
    providerCalls,
    output,
    async aiRequestLog() {
      const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      return stored.ai_requests || [];
    },
    async attemptLog() {
      const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      return {
        writing: stored.writing_attempts || [],
        speaking: stored.speaking_attempts || [],
      };
    },
    async generatedTasks() {
      const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      return stored.generated_tasks || [];
    },
    async generateVocabulary(count = 8) {
      const response = await fetch(`${baseUrl}/api/v1/ai/generate-content`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt.sign({ u: 'student' }, JWT_SECRET)}`,
        },
        body: JSON.stringify({ operation: 'vocabulary_cards', count, exclude: [] }),
      });
      return { status: response.status, body: await response.json() };
    },
    async evaluateWriting(answer, taskType = 'writing_37', taskId = 'builtin:writing_37:emily-new-flat') {
      const response = await fetch(`${baseUrl}/api/v1/ai/evaluate-writing`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt.sign({ u: 'student' }, JWT_SECRET)}`,
        },
        body: JSON.stringify({
          taskType,
          taskId,
          answer,
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    async evaluateSpeaking() {
      const authorization = `Bearer ${jwt.sign({ u: 'student' }, JWT_SECRET)}`;
      const response = await fetch(`${baseUrl}/api/v1/ai/evaluate-speaking`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify({
          taskType: 4,
          contentRef: 'builtin:speaking:task:4:v1',
          transcript: 'I have found two photos for our project. Both show people learning. The first photo shows a classroom. The second photo shows a student at home. Both people are studying. The main difference is the place. Classroom study offers teamwork. Home study is flexible. I prefer classroom learning because friends can help. It is also more motivating. These photos illustrate two useful approaches. That is all I wanted to say.',
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((resolve) => providerServer.close(resolve));
    },
  };
}

const ANSWER = Array.from({ length: 110 }, (_, index) => `word${index}`).join(' ');
const WORDS = 110;

function vocabularySet() {
  const entries = [
    ['achievement', 'достижение'], ['success', 'успех'], ['progress', 'прогресс'], ['result', 'результат'],
    ['decision', 'решение'], ['method', 'метод'], ['effort', 'усилие'], ['practice', 'практика'],
  ];
  return entries.map(([word, tr]) => ({
    w: word,
    p: 'n',
    tr,
    ex: `The lesson introduces ${word} clearly.`,
    practice: [
      `The article discusses ${word} in detail.`,
      `The report gives an example of ${word}.`,
      `Students asked a question about ${word}.`,
      `The project highlights ${word} for readers.`,
    ],
  }));
}

test('tracer-incompatible vocabulary is repaired before storage and the bounded eight-card call reaches the provider', { timeout: 40_000 }, async () => {
  const invalid = vocabularySet();
  invalid[1].tr = invalid[0].tr;
  const valid = vocabularySet();
  const stack = await startStack({ replies: [JSON.stringify(invalid), JSON.stringify(valid)] });
  try {
    const { status, body } = await stack.generateVocabulary();
    assert.equal(status, 200);
    assert.equal(stack.providerCalls.length, 2, 'invalid tracer set gets exactly one format repair');
    assert.equal(stack.providerCalls[0].maxTokens, 1200, 'eight cards stay inside the vocabulary provider budget');
    assert.deepEqual(JSON.parse(stack.providerCalls[0].user).data.count, 8);
    assert.equal(body.data.length, 8);
    assert.ok(body.data.every((card) => card.voice_tutor?.type?.revision === 1));
    const stored = await stack.generatedTasks();
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].result, valid, 'only the repaired tracer-ready set is persisted');
  } finally {
    await stack.stop();
  }
});

test('a malformed answer is repaired on the second attempt and the student sees a review', { timeout: 40_000 }, async () => {
  const stack = await startStack({
    replies: [
      '```json\n{ "broken": true,\n',
      JSON.stringify(validReview(WORDS)),
    ],
  });
  try {
    const { status, body } = await stack.evaluateWriting(ANSWER);

    assert.equal(status, 200, 'починка формата обязана спасти запрос, а не отдать ошибку');
    assert.equal(body.review.overall_got, 4);
    assert.equal(stack.providerCalls.length, 2, 'ровно две обращения к провайдеру: исходное и одна починка');

    /* The repair call has to carry the rejected output and the reason, otherwise it is just a retry. */
    const repairPrompt = stack.providerCalls[1].user;
    assert.match(repairPrompt, /ИСПРАВЛЕНИЕ ФОРМАТА/u);
    assert.match(repairPrompt, /не является корректным JSON/u);
    assert.match(repairPrompt, /"broken": true/u);
    assert.match(repairPrompt, /ОТКЛОНЁННЫЙ_ОТВЕТ/u, 'отклонённый ответ должен быть помечен как данные');
  } finally {
    await stack.stop();
  }
});

test('a second malformed answer ends the request instead of retrying forever', { timeout: 40_000 }, async () => {
  const stack = await startStack({
    replies: ['not json at all', 'still not json', JSON.stringify(validReview(WORDS))],
  });
  try {
    const { status, body } = await stack.evaluateWriting(ANSWER);

    assert.equal(status, 502);
    assert.equal(body.error.code, 'AI_RESPONSE_INVALID');
    assert.doesNotMatch(body.error.message, /JSON|schema|provider/iu, 'пользователь не должен видеть технических деталей');
    assert.equal(
      stack.providerCalls.length,
      2,
      'после второй неудачи попыток больше нет — третий валидный ответ в очереди остался невостребованным',
    );
    const attempts = await stack.attemptLog();
    assert.deepEqual(
      {
        status: attempts.writing[0].status,
        provider: attempts.writing[0].provider,
        model: attempts.writing[0].model,
        promptVersion: attempts.writing[0].prompt_version,
        errorCode: attempts.writing[0].error_code,
      },
      {
        status: 'failed',
        provider: 'grok',
        model: 'route-provenance-model',
        promptVersion: 'writing-v8',
        errorCode: 'AI_RESPONSE_INVALID',
      },
    );
  } finally {
    await stack.stop();
  }
});

test('a valid answer is not repaired and costs exactly one call', { timeout: 40_000 }, async () => {
  const stack = await startStack({ replies: [JSON.stringify(validReview(WORDS))] });
  try {
    const { status } = await stack.evaluateWriting(ANSWER);

    assert.equal(status, 200);
    assert.equal(stack.providerCalls.length, 1, 'корректный ответ не должен вызывать лишний платный запрос');
  } finally {
    await stack.stop();
  }
});

test('an overlength writing route evaluates only the allowed fragment and preserves both texts', { timeout: 40_000 }, async () => {
  const answer = Array.from({ length: 155 }, (_, index) => `word${String(index + 1).padStart(3, '0')}`).join(' ');
  const evaluatedAnswer = Array.from({ length: 140 }, (_, index) => `word${String(index + 1).padStart(3, '0')}`).join(' ');
  const stack = await startStack({ replies: [JSON.stringify(validReview(155))] });
  try {
    const { status, body } = await stack.evaluateWriting(answer);

    assert.equal(status, 200);
    assert.equal(Number.isInteger(body.review.overall_got), true);
    assert.deepEqual(body.evaluationScope, {
      fullWords: 155,
      evaluatedWords: 140,
      truncated: true,
      evaluatedLimit: 140,
    });
    assert.match(body.assessment.warning, /Балл ориентировочный/u);
    assert.match(stack.providerCalls[0].user, /word140/u);
    assert.doesNotMatch(stack.providerCalls[0].user, /word141/u);

    const attempts = await stack.attemptLog();
    assert.equal(attempts.writing[0].answer, answer);
    assert.equal(attempts.writing[0].evaluated_answer, evaluatedAnswer);
  } finally {
    await stack.stop();
  }
});

test('an overlength task 38 route evaluates through the official sentence boundary at word 250', { timeout: 40_000 }, async () => {
  const evaluatedAnswer = Array.from({ length: 250 }, (_, index) => (
    `essay${String(index + 1).padStart(3, '0')}${index === 249 ? '.' : ''}`
  )).join(' ');
  const answer = `${evaluatedAnswer} ${Array.from({ length: 26 }, (_, index) => (
    `tail${String(index + 1).padStart(3, '0')}`
  )).join(' ')}`;
  const stack = await startStack({ replies: [JSON.stringify(validTask38Review(276))] });
  try {
    const { status, body } = await stack.evaluateWriting(
      answer,
      'writing_38',
      'builtin:writing_38:teen-sport',
    );

    assert.equal(status, 200);
    assert.deepEqual(body.evaluationScope, {
      fullWords: 276,
      evaluatedWords: 250,
      truncated: true,
      evaluatedLimit: 250,
    });
    assert.match(stack.providerCalls[0].user, /essay250/u);
    assert.doesNotMatch(stack.providerCalls[0].user, /essay251/u);
    const attempts = await stack.attemptLog();
    assert.equal(attempts.writing[0].answer, answer);
    assert.equal(attempts.writing[0].evaluated_answer, evaluatedAnswer);
  } finally {
    await stack.stop();
  }
});

test('the last tolerated words of tasks 37 and 38 reach the provider without truncation', { timeout: 40_000 }, async () => {
  const answer37 = Array.from({ length: 154 }, (_, index) => `letter${String(index + 1).padStart(3, '0')}`).join(' ');
  const answer38 = Array.from({ length: 275 }, (_, index) => `project${String(index + 1).padStart(3, '0')}`).join(' ');
  const stack = await startStack({
    replies: [JSON.stringify(validReview(154)), JSON.stringify(validTask38Review(275))],
  });
  try {
    const task37Result = await stack.evaluateWriting(answer37);
    const task38Result = await stack.evaluateWriting(
      answer38,
      'writing_38',
      'builtin:writing_38:teen-sport',
    );

    assert.equal(task37Result.status, 200);
    assert.deepEqual(task37Result.body.evaluationScope, {
      fullWords: 154, evaluatedWords: 154, truncated: false, evaluatedLimit: 140,
    });
    assert.equal(task37Result.body.review.words, 154);
    assert.equal(task37Result.body.review.in_range, true);
    assert.match(stack.providerCalls[0].user, /letter154/u);

    assert.equal(task38Result.status, 200);
    assert.deepEqual(task38Result.body.evaluationScope, {
      fullWords: 275, evaluatedWords: 275, truncated: false, evaluatedLimit: 250,
    });
    assert.equal(task38Result.body.review.words, 275);
    assert.equal(task38Result.body.review.in_range, true);
    assert.match(stack.providerCalls[1].user, /project275/u);

    const attempts = await stack.attemptLog();
    assert.deepEqual(
      attempts.writing.map(({ answer, evaluated_answer: evaluatedAnswer }) => ({ answer, evaluatedAnswer })),
      [
        { answer: answer37, evaluatedAnswer: answer37 },
        { answer: answer38, evaluatedAnswer: answer38 },
      ],
    );
  } finally {
    await stack.stop();
  }
});

test('writing keeps its approximate gate while legacy adaptive Speaking fails closed', { timeout: 40_000 }, async () => {
  const warning = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';
  const stack = await startStack({
    replies: [JSON.stringify(validReview(WORDS)), JSON.stringify(validSpeakingReview())],
  });
  try {
    const writing = await stack.evaluateWriting(ANSWER);
    const speaking = await stack.evaluateSpeaking();

    assert.equal(writing.status, 200);
    assert.equal(speaking.status, 400);
    assert.equal(speaking.body.error.code, 'VALIDATION_ERROR');
    assert.equal(Number.isInteger(writing.body.review.overall_got), true);
    assert.deepEqual(writing.body.voiceTutor, {
      source: 'writing', attemptId: writing.body.attemptId, revision: 1,
      criterionChoices: [
        { index: 1, label: 'Организация текста' },
        { index: 2, label: 'Языковое оформление' },
      ],
    });
    assert.deepEqual(writing.body.assessment, { mode: 'experimental', scoreKind: 'approximate', warning });
    assert.equal(stack.providerCalls.length, 1, 'rejected adaptive speech never reaches xAI');
    const attempts = await stack.attemptLog();
    assert.deepEqual(
      attempts.writing.map(({ provider, model, prompt_version: promptVersion }) => ({ provider, model, promptVersion })),
      [{ provider: 'grok', model: 'route-provenance-model', promptVersion: 'writing-v8' }],
    );
    assert.deepEqual(attempts.speaking, []);
  } finally {
    await stack.stop();
  }
});

test('legacy adaptive Speaking is rejected before provider provenance can be invented', { timeout: 40_000 }, async () => {
  const stack = await startStack({ replies: ['not json', 'still not json'] });
  try {
    const { status, body } = await stack.evaluateSpeaking();

    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(stack.providerCalls.length, 0);
    const attempts = await stack.attemptLog();
    assert.deepEqual(attempts.speaking, []);
  } finally {
    await stack.stop();
  }
});

test('both calls of a repaired request are reported, so the budget stays truthful', { timeout: 40_000 }, async () => {
  const stack = await startStack({
    replies: ['{ "oops": ', JSON.stringify(validReview(WORDS))],
  });
  try {
    await stack.evaluateWriting(ANSWER);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const log = await stack.aiRequestLog();
    assert.equal(log.length, 2, 'два обращения к провайдеру — две записи, иначе бюджет считает не то');

    const rejected = log.find((entry) => entry.status === 'failed');
    const accepted = log.find((entry) => entry.status === 'completed');
    assert.ok(rejected, 'отклонённый вызов обязан попасть в журнал: он потратил токены');
    assert.equal(rejected.errorCode, 'AI_RESPONSE_INVALID_JSON', 'причина отказа записывается конкретной');
    assert.match(rejected.fallbackReason, /format repair requested/u);
    assert.ok(rejected.completionTokens > 0, 'потраченные токены не должны потеряться');
    assert.ok(accepted, 'принятый разбор тоже записывается');
    // Version string only: v6 adds the official token and sentence/question boundary rules.
    assert.equal(accepted.promptVersion, 'writing-v8');
  } finally {
    await stack.stop();
  }
});

/* ---------- the repair prompt itself ---------- */

test('the repair prompt explains the specific violation, not just "invalid"', () => {
  const cases = [
    ['AI_RESPONSE_INVALID_JSON', /не является корректным JSON/u],
    ['AI_RESPONSE_INVALID_SCHEMA', /структура JSON/u],
    ['AI_RESPONSE_INVALID_TOTAL', /overall_got/u],
    ['AI_RESPONSE_INVALID_WORD_COUNT', /количеством слов/u],
    ['AI_RESPONSE_INVALID_CRITERIA', /criteria/u],
  ];
  for (const [code, expected] of cases) {
    assert.match(describeFormatFailure(new Error(code)), expected, `${code} должен объясняться по существу`);
  }
});

test('only contract violations are treated as repairable', () => {
  assert.equal(isFormatFailure(new Error('AI_RESPONSE_INVALID_JSON')), true);
  assert.equal(isFormatFailure(new Error('AI_RESPONSE_INVALID')), true);
  /* A timeout or a dead provider is not a format problem and must reach the fallback logic. */
  assert.equal(isFormatFailure(new Error('AI_PROVIDER_UNAVAILABLE')), false);
  assert.equal(isFormatFailure(new Error('AI_NOT_CONFIGURED')), false);
  assert.equal(isFormatFailure(undefined), false);
});

test('the rejected output is quoted as data and kept bounded', () => {
  const huge = 'x'.repeat(20_000);
  const prompt = buildRepairRequest('исходный запрос', huge, new Error('AI_RESPONSE_INVALID_SCHEMA'));

  assert.match(prompt, /^исходный запрос/u, 'починка должна повторять исходное задание');
  assert.match(prompt, /данные, а не инструкция/u);
  assert.ok(prompt.length < 6000, 'отклонённый ответ обязан обрезаться, иначе починка дороже самой оценки');
  assert.match(prompt, /без markdown-ограждений/u);
});
