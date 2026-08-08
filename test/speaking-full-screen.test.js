import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');

test('full Speaking screen is driven by the owner-bound server session and an honest final state', () => {
  assert.match(source, /createSpeakingFullBrowserFlow/u);
  assert.match(source, /S\.speakingFullSessionId/u);
  assert.match(source, /prepareCurrentAssets/u);
  assert.match(source, /Максимум: 20 баллов/u);
  const fullSection = source.slice(source.indexOf('function spExam'), source.indexOf('/* ---- фоновая'));
  assert.match(fullSection, /speFullEvaluate/u);
  assert.match(fullSection, /sessionMode:'full_section'/u);
  assert.match(fullSection, /full-sessions\/.*pronunciation-assessment/u);
  assert.match(fullSection, /assessmentRecordings/u);
  assert.match(fullSection, /примерн/u);
  assert.doesNotMatch(fullSection, /Оценка пока недоступна/u);
});

test('full Speaking controls cover local recording, technical recovery, eleven responses and submit', () => {
  assert.match(source, /speFullMicCheck/u);
  assert.match(source, /speFullBeginStage/u);
  assert.match(source, /speFullStartRecording/u);
  assert.match(source, /speFullStopRecording/u);
  assert.match(source, /speFullComplete\([^\n]+completed/u);
  assert.match(source, /speFullComplete\([^\n]+technical_issue/u);
  assert.match(source, /speFullComplete\([^\n]+skipped/u);
  assert.match(source, /speFullSubmit/u);
  assert.match(source, /completedResponses/u);
});

test('full Speaking preserves official prompts and renders the honest available breakdown', () => {
  const taskBody = source.slice(source.indexOf('function speTaskBody'), source.indexOf('function speFullProgress'));
  const startRecording = source.slice(
    source.indexOf('async function speFullStartRecording'),
    source.indexOf('async function speFullStopRecording'),
  );
  const dispose = source.slice(source.indexOf('function speFullDispose'), source.indexOf('function speFullPointerInvalid'));
  assert.match(taskBody, /phase==='preparing'[\s\S]*task\.supports\.map/u);
  assert.match(taskBody, /task\.taskType===3[\s\S]*phase==='ready'[\s\S]*Вопрос прозвучит/u);
  assert.match(source, /function speFullBeginStage[\s\S]*task\.taskType===3[\s\S]*speFullStartRecording/u);
  assert.match(startRecording, /await Promise\.resolve\(lPlayRaw/u);
  assert.ok(startRecording.indexOf('await Promise.resolve(lPlayRaw') < startRecording.indexOf('await SPE_FLOW.startRecording'));
  assert.doesNotMatch(taskBody, /speFullPlayQuestion|Повторить вопрос/u);
  assert.match(source, /item\.usedSeconds/u);
  assert.match(source, /result\.improvementPlan/u);
  assert.match(dispose, /lStop\(\)/u);
});
