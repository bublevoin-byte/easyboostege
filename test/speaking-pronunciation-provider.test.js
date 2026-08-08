import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAzurePronunciationProvider,
  createFakePronunciationProvider,
} from '../speaking/pronunciation-provider.js';
import { testPcmWavAudio } from './support/wav-audio.js';

const audio = testPcmWavAudio();
const request = (overrides = {}) => ({
  audio, mimeType: 'audio/wav', durationSeconds: 3, locale: 'en-US',
  mode: 'scripted', referenceText: 'A short trusted transcript.', ...overrides,
});

test('deterministic fake pronunciation provider covers success, low quality, partial, timeout and unavailable', async () => {
  const success = await createFakePronunciationProvider({ scenario: 'success' }).assess(request());
  assert.equal(success.status, 'success');
  assert.equal(success.locale, 'en-US');
  assert.equal(success.transcript, 'A short trusted transcript.');
  assert.equal(success.words[0].phonemes[0].name, 'æ');
  assert.equal(success.prosody.available, true);
  assert.equal(success.pauseAnalysisAvailable, true);

  const lowQuality = await createFakePronunciationProvider({ scenario: 'low_quality' }).assess(request());
  assert.equal(lowQuality.status, 'low_quality');
  assert.equal(lowQuality.quality.acceptable, false);
  assert.equal(lowQuality.overallScore, null);

  const partial = await createFakePronunciationProvider({ scenario: 'partial' }).assess(request());
  assert.equal(partial.status, 'low_quality');
  assert.equal(partial.quality.acceptable, false);
  assert.equal(partial.quality.warnings.includes('recognition_segments_truncated'), true);
  assert.equal(partial.transcript.length > 0, true);
  assert.equal(partial.isFinal, false);

  await assert.rejects(
    createFakePronunciationProvider({ scenario: 'timeout' }).assess(request()),
    (error) => error?.code === 'SPEAKING_PRONUNCIATION_TIMEOUT' && error?.processingStarted === true,
  );
  assert.deepEqual(await createFakePronunciationProvider({ scenario: 'unavailable' }).status(), {
    available: false, reason: 'provider_unavailable', provider: 'fake-azure',
  });
});

test('en-GB keeps acoustic scores but suppresses en-US-only phoneme names, IPA, syllables, candidates and prosody', async () => {
  const result = await createFakePronunciationProvider({ scenario: 'success' }).assess(request({ locale: 'en-GB' }));
  assert.equal(result.locale, 'en-GB');
  assert.equal(result.words[0].phonemes[0].accuracyScore > 0, true);
  assert.equal(result.words[0].phonemes[0].name, null);
  assert.equal(Object.hasOwn(result.words[0].phonemes[0], 'ipa'), false);
  assert.equal(Object.hasOwn(result.words[0], 'syllables'), false);
  assert.equal(Object.hasOwn(result.words[0].phonemes[0], 'candidates'), false);
  assert.deepEqual(result.prosody, { available: false, score: null, reason: 'locale_not_supported' });
  assert.equal(result.pauseAnalysisAvailable, false);
});

function fakeSdk(rawJson, {
  stopEvent = true, recognitions = 1, stopCallback = true, recognitionReasons = [],
} = {}) {
  const lifecycle = { start: 0, stop: 0, pushWrites: 0, pushClosed: 0, applied: 0 };
  class Recognizer {
    constructor(speechConfig, audioConfig) {
      this.speechConfig = speechConfig;
      this.audioConfig = audioConfig;
      lifecycle.recognizer = this;
    }
    startContinuousRecognitionAsync(success) {
      lifecycle.start += 1;
      success();
      if (!stopEvent) return;
      queueMicrotask(() => {
        for (let index = 0; index < recognitions; index += 1) {
          const providerPayload = Array.isArray(rawJson) ? rawJson[index] : rawJson;
          this.recognized?.(this, { result: {
            reason: recognitionReasons[index] || 'recognized', text: 'SDK transcript',
            properties: { getProperty: () => JSON.stringify(providerPayload) },
          } });
        }
        this.sessionStopped?.(this, {});
      });
    }
    stopContinuousRecognitionAsync(success) { lifecycle.stop += 1; if (stopCallback) success(); }
    close() { lifecycle.closed = true; }
  }
  class PronunciationConfig {
    constructor(referenceText, _grading, _granularity, enableMiscue) {
      this.referenceText = referenceText;
      lifecycle.referenceText = referenceText;
      lifecycle.enableMiscue = enableMiscue;
    }
    enableProsodyAssessment() { lifecycle.prosodyEnabled = true; }
    applyTo() { lifecycle.applied += 1; }
  }
  return {
    lifecycle,
    SpeechConfig: { fromSubscription(key, region) {
      lifecycle.subscription = { key, region };
      return { setProperty(name, value) { lifecycle.properties ||= {}; lifecycle.properties[name] = value; } };
    } },
    AudioInputStream: { createPushStream() { return {
      write() { lifecycle.pushWrites += 1; }, close() { lifecycle.pushClosed += 1; },
    }; } },
    AudioConfig: {
      fromStreamInput(stream) { lifecycle.streamInputs = (lifecycle.streamInputs || 0) + 1; return { stream }; },
      fromWavFileInput(buffer) { lifecycle.wavInputs = (lifecycle.wavInputs || 0) + 1; lifecycle.wavBuffer = buffer; return { buffer }; },
    },
    SpeechRecognizer: Recognizer,
    PronunciationAssessmentConfig: PronunciationConfig,
    PronunciationAssessmentGradingSystem: { HundredMark: 'hundred' },
    PronunciationAssessmentGranularity: { Phoneme: 'phoneme' },
    ResultReason: { RecognizedSpeech: 'recognized' },
    PropertyId: { SpeechServiceResponse_JsonResult: 'json' },
  };
}

const azureRaw = {
  NBest: [{ Display: 'SDK transcript', Confidence: 0.92, PronunciationAssessment: {
    AccuracyScore: 88, FluencyScore: 77, CompletenessScore: 99, PronScore: 84, ProsodyScore: 73,
  }, Words: [{ Word: 'SDK', Offset: 10_000, Duration: 5_000_000,
    PronunciationAssessment: { AccuracyScore: 88, ErrorType: 'None' },
    Phonemes: [{ Phoneme: 's', PronunciationAssessment: { AccuracyScore: 91 },
      NBestPhonemes: [{ Phoneme: 's', Score: 91 }] }],
    Syllables: [{ Syllable: 's d k', Offset: 10_000, Duration: 5_000_000,
      PronunciationAssessment: { AccuracyScore: 87 } }],
  }] }],
};

test('Azure adapter uses the official JavaScript continuous recognition lifecycle through an injected SDK', async () => {
  const sdk = fakeSdk(azureRaw);
  const logs = [];
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'test-key-must-never-be-logged', region: 'test-region',
    sdkLoader: async () => sdk, timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
    logger: (entry) => logs.push(entry),
  });
  assert.deepEqual(await provider.status(), { available: true, provider: 'azure-speech', reason: null });
  const result = await provider.assess(request());
  assert.equal(result.transcript, 'SDK transcript');
  assert.equal(result.processedDurationSeconds, 3);
  assert.equal(sdk.lifecycle.start, 1);
  assert.equal(sdk.lifecycle.stop, 1);
  assert.equal(sdk.lifecycle.wavInputs, 1);
  assert.equal(sdk.lifecycle.wavBuffer, audio);
  assert.equal(sdk.lifecycle.streamInputs || 0, 0);
  assert.equal(sdk.lifecycle.pushWrites, 0);
  assert.equal(sdk.lifecycle.pushClosed, 0);
  assert.equal(sdk.lifecycle.applied, 1);
  assert.equal(sdk.lifecycle.closed, true);
  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes('test-key-must-never-be-logged'), false);
  assert.equal(serializedLogs.includes(audio.toString('base64')), false);
  assert.equal(serializedLogs.includes('SDK transcript'), false);
});

test('Azure raw confidence and timing require finite bounded JavaScript numbers', async () => {
  for (const invalid of [null, undefined, '', '100000', Number.POSITIVE_INFINITY, -1, 2_000_000_000]) {
    const raw = structuredClone(azureRaw);
    raw.NBest[0].Words[0].Offset = invalid;
    raw.NBest[0].Words[0].Duration = invalid;
    const result = await createAzurePronunciationProvider({
      subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(raw),
      timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
    }).assess(request());
    assert.equal(result.status, 'low_quality', `invalid timing ${String(invalid)} cannot succeed`);
    assert.equal(result.fluencyScore, null);
    assert.equal(result.words[0].offsetSeconds, null);
    assert.equal(result.words[0].durationSeconds, null);
    assert.equal(result.quality.warnings.includes('assessment_scores_unavailable'), true);
  }

  for (const invalid of [null, undefined, '', '0.92', Number.POSITIVE_INFINITY, -0.1, 1.1]) {
    const raw = structuredClone(azureRaw);
    raw.NBest[0].Confidence = invalid;
    const result = await createAzurePronunciationProvider({
      subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(raw),
      timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
    }).assess(request());
    assert.equal(result.confidence, null);
    assert.equal(result.status, 'low_quality', `invalid confidence ${String(invalid)} is unavailable`);
    assert.equal(result.quality.acceptable, false);
    assert.equal(result.quality.warnings.includes('recognition_confidence_unavailable'), true);
  }
});

test('Azure continuous coverage fails closed for malformed segments, missing facts and pre-slice overflow', async () => {
  const validSecond = structuredClone(azureRaw);
  validSecond.NBest[0].Display = 'second segment';
  validSecond.NBest[0].Words[0].Word = 'second';
  validSecond.NBest[0].Words[0].Offset = 6_000_000;

  const cases = [
    {
      label: 'missing NBest', raw: [azureRaw, { RecognitionStatus: 'Success', NBest: [] }],
      warning: 'recognition_segment_unavailable',
    },
    {
      label: 'non-object provider JSON', raw: [azureRaw, 'malformed-segment'],
      warning: 'recognition_segment_unavailable',
    },
    {
      label: 'missing segment confidence', raw: [azureRaw, {
        ...validSecond, NBest: [{ ...validSecond.NBest[0], Confidence: undefined }],
      }], warning: 'recognition_confidence_unavailable',
    },
    {
      label: 'missing word score', raw: [{
        ...azureRaw, NBest: [{ ...azureRaw.NBest[0], Words: [{
          ...azureRaw.NBest[0].Words[0], PronunciationAssessment: { ErrorType: 'None' },
        }] }],
      }], warning: 'word_facts_unavailable',
    },
  ];
  for (const scenario of cases) {
    const provider = createAzurePronunciationProvider({
      subscriptionKey: 'configured', region: 'configured',
      sdkLoader: async () => fakeSdk(scenario.raw, {
        recognitions: Array.isArray(scenario.raw) ? scenario.raw.length : 1,
      }),
      timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
    });
    const result = await provider.assess(request({ mode: 'unscripted', referenceText: '' }));
    assert.equal(result.status, 'low_quality', scenario.label);
    assert.equal(result.quality.acceptable, false, scenario.label);
    assert.equal(result.quality.warnings.includes(scenario.warning), true, scenario.label);
    assert.equal(result.overallScore, null, scenario.label);
  }

  const overflowRaw = structuredClone(azureRaw);
  overflowRaw.NBest[0].Words = Array.from({ length: 501 }, (_, index) => ({
    Word: `word${index}`, Offset: 100_000 + index * 40_000, Duration: 30_000,
    PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' },
  }));
  const overflow = await createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(overflowRaw),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request({ mode: 'unscripted', referenceText: '' }));
  assert.equal(overflow.words.length, 500);
  assert.equal(overflow.status, 'low_quality');
  assert.equal(overflow.quality.acceptable, false);
  assert.equal(overflow.quality.warnings.includes('word_details_truncated'), true);
});

test('Azure continuous coverage fails closed when a final NoMatch follows a valid segment', async () => {
  const result = await createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured',
    sdkLoader: async () => fakeSdk([azureRaw, azureRaw], {
      recognitions: 2, recognitionReasons: ['recognized', 'no_match'],
    }),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request({ mode: 'unscripted', referenceText: '' }));

  assert.equal(result.transcript, 'SDK transcript');
  assert.equal(result.status, 'low_quality');
  assert.equal(result.isFinal, false);
  assert.equal(result.quality.acceptable, false);
  assert.equal(result.quality.warnings.includes('recognition_segment_unavailable'), true);
  assert.equal(result.overallScore, null);
});

test('Azure exposes pause and prosody capability only after the SDK method succeeds', async () => {
  const assess = async (sdk, overrides = {}) => createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request(overrides));

  const withoutMethod = fakeSdk(azureRaw);
  delete withoutMethod.PronunciationAssessmentConfig.prototype.enableProsodyAssessment;
  const unavailable = await assess(withoutMethod);
  assert.equal(unavailable.pauseAnalysisAvailable, false);
  assert.deepEqual(unavailable.prosody, {
    available: false, score: null, reason: 'provider_pause_metric_unavailable',
  });

  const throwingMethod = fakeSdk(azureRaw);
  throwingMethod.PronunciationAssessmentConfig.prototype.enableProsodyAssessment = () => {
    throw new Error('unsupported SDK build');
  };
  const failedCapability = await assess(throwingMethod);
  assert.equal(failedCapability.pauseAnalysisAvailable, false);
  assert.deepEqual(failedCapability.prosody, {
    available: false, score: null, reason: 'provider_pause_metric_unavailable',
  });

  const zeroProsodyRaw = structuredClone(azureRaw);
  zeroProsodyRaw.NBest[0].PronunciationAssessment.ProsodyScore = 0;
  const supported = await assess(fakeSdk(zeroProsodyRaw), { mode: 'unscripted', referenceText: '' });
  assert.equal(supported.pauseAnalysisAvailable, true);
  assert.deepEqual(supported.prosody, { available: true, score: 0 });
});

test('Azure word timing is bounded by the trusted WAV duration with explicit tolerance', async () => {
  const impossible = structuredClone(azureRaw);
  impossible.NBest[0].Words[0].Offset = 29_000_000;
  impossible.NBest[0].Words[0].Duration = 2_000_000;
  const rejected = await createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(impossible),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request({ mode: 'unscripted', referenceText: '' }));
  assert.equal(rejected.status, 'low_quality');
  assert.equal(rejected.words[0].offsetSeconds, null);
  assert.equal(rejected.words[0].durationSeconds, null);
  assert.equal(rejected.fluencyScore, null);
  assert.equal(rejected.quality.warnings.includes('word_timing_out_of_bounds'), true);

  const tolerated = structuredClone(azureRaw);
  tolerated.NBest[0].Words[0].Offset = 29_500_000;
  tolerated.NBest[0].Words[0].Duration = 400_000;
  const accepted = await createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(tolerated),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request({ mode: 'unscripted', referenceText: '' }));
  assert.equal(accepted.status, 'success');
  assert.equal(accepted.words[0].offsetSeconds, 2.95);
  assert.equal(accepted.words[0].durationSeconds, 0.04);
});

test('Azure pause and monotone annotations preserve recognized-word scoring and remain visible', async () => {
  const ordinary = structuredClone(azureRaw);
  ordinary.NBest[0].Words[0].Word = 'SDK';
  ordinary.NBest[0].Words[0].PronunciationAssessment.AccuracyScore = 40;
  ordinary.NBest[0].Words[0].PronunciationAssessment.ErrorType = 'None';
  const paused = structuredClone(ordinary);
  paused.NBest[0].Words[0].PronunciationAssessment.ErrorType = 'UnexpectedBreak';
  const monotone = structuredClone(ordinary);
  monotone.NBest[0].Words[0].PronunciationAssessment.ErrorType = 'Monotone';
  const assess = async (raw, locale = 'en-US') => createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(raw),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  }).assess(request({ locale, referenceText: 'SDK' }));
  const [baseline, annotated, monotoneAnnotated, unsupported] = await Promise.all([
    assess(ordinary), assess(paused), assess(monotone), assess(paused, 'en-GB'),
  ]);
  assert.equal(baseline.status, 'success');
  assert.equal(annotated.status, 'success');
  assert.deepEqual({
    accuracy: annotated.accuracyScore,
    fluency: annotated.fluencyScore,
    completeness: annotated.completenessScore,
  }, {
    accuracy: baseline.accuracyScore,
    fluency: baseline.fluencyScore,
    completeness: baseline.completenessScore,
  });
  assert.equal(annotated.words[0].errorType, 'unexpected_break');
  assert.deepEqual({
    accuracy: monotoneAnnotated.accuracyScore,
    fluency: monotoneAnnotated.fluencyScore,
    completeness: monotoneAnnotated.completenessScore,
  }, {
    accuracy: baseline.accuracyScore,
    fluency: baseline.fluencyScore,
    completeness: baseline.completenessScore,
  });
  assert.equal(monotoneAnnotated.words[0].errorType, 'monotone');
  assert.equal(annotated.pauseAnalysisAvailable, true);
  assert.equal(unsupported.pauseAnalysisAvailable, false);
});

test('Azure adapter awaits the durable start claim before settlement and gives unscripted recognition no reference text', async () => {
  const sdk = fakeSdk(azureRaw);
  let releaseStart;
  const startClaim = new Promise((resolve) => { releaseStart = resolve; });
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  let settled = false;
  const assessment = provider.assess(request({ mode: 'unscripted', referenceText: 'must-not-be-sent' }), {
    onProcessingStarted: async () => startClaim,
  }).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(sdk.lifecycle.referenceText, '');
  releaseStart();
  assert.equal((await assessment).mode, 'unscripted');
});

test('Azure adapter bounds continuous recognition segments before normalization and logging', async () => {
  const sdk = fakeSdk(azureRaw, { recognitions: 250 });
  const logs = [];
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
    logger: (entry) => logs.push(entry),
  });
  const result = await provider.assess(request());
  assert.equal(result.status, 'low_quality');
  assert.equal(result.quality.acceptable, false);
  assert.equal(result.quality.warnings.includes('recognition_segments_truncated'), true);
  assert.equal(result.words.length >= 200 && result.words.length <= 500, true);
  assert.equal(logs.find((entry) => entry.event === 'completed').segmentCount, 200);
});

test('continuous scripted assessment aligns omissions/insertions and recomputes paragraph scores from words', async () => {
  const segments = [{
    RecognitionStatus: 'Success',
    NBest: [{ Display: 'one', Confidence: 0.9, PronunciationAssessment: {
      AccuracyScore: 95, FluencyScore: 95, CompletenessScore: 95, PronScore: 95, ProsodyScore: 100,
    }, Words: [{ Word: 'one', Offset: 1_000_000, Duration: 4_000_000,
      PronunciationAssessment: { AccuracyScore: 100, ErrorType: 'None' } }] }],
  }, {
    RecognitionStatus: 'Success',
    NBest: [{ Display: 'extra two four', Confidence: 0.7, PronunciationAssessment: {
      AccuracyScore: 5, FluencyScore: 5, CompletenessScore: 5, PronScore: 5, ProsodyScore: 20,
    }, Words: [
      { Word: 'extra', Offset: 6_000_000, Duration: 1_000_000,
        PronunciationAssessment: { AccuracyScore: 80, ErrorType: 'None' } },
      { Word: 'two', Offset: 8_000_000, Duration: 2_000_000,
        PronunciationAssessment: { AccuracyScore: 80, ErrorType: 'None' } },
      { Word: 'four', Offset: 15_000_000, Duration: 5_000_000,
        PronunciationAssessment: { AccuracyScore: 60, ErrorType: 'None' } },
    ] }],
  }];
  const sdk = fakeSdk(segments, { recognitions: 2 });
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  const result = await provider.assess(request({ referenceText: 'one two three four' }));
  assert.equal(sdk.lifecycle.enableMiscue, false);
  assert.deepEqual(result.words.map((word) => [word.text, word.errorType]), [
    ['one', 'none'], ['extra', 'insertion'], ['two', 'none'], ['three', 'omission'], ['four', 'none'],
  ]);
  assert.equal(result.accuracyScore, 60);
  assert.equal(result.fluencyScore, 59.16);
  assert.equal(result.completenessScore, 75);
  assert.deepEqual(result.prosody, { available: true, score: 60 });
  assert.equal(result.overallScore, 62.66);
});

test('continuous alignment orders a replacement as insertion then omission and warnings use recognized words', async () => {
  const replacementRaw = {
    RecognitionStatus: 'Success',
    NBest: [{ Display: 'one two', Confidence: 0.9, PronunciationAssessment: {}, Words: [
      { Word: 'one', Offset: 100_000, Duration: 1_000_000,
        PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } },
      { Word: 'two', Offset: 1_200_000, Duration: 1_000_000,
        PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } },
    ] }],
  };
  const replacementProvider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(replacementRaw),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  const replacement = await replacementProvider.assess(request({ referenceText: 'one three' }));
  assert.deepEqual(replacement.words.map((word) => [word.text, word.errorType]), [
    ['one', 'none'], ['two', 'insertion'], ['three', 'omission'],
  ]);

  const noWordsRaw = {
    RecognitionStatus: 'Success',
    NBest: [{ Display: 'text without word facts', Confidence: 0.9, PronunciationAssessment: {}, Words: [] }],
  };
  const noWordsProvider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(noWordsRaw),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  const noWords = await noWordsProvider.assess(request({ referenceText: 'one three' }));
  assert.equal(noWords.status, 'low_quality');
  assert.equal(noWords.quality.warnings.includes('speech_not_recognized'), true);
});

test('continuous paragraph scores retain omissions when the public word cap is saturated by insertions', async () => {
  const recognizedWords = Array.from({ length: 500 }, (_, index) => ({
    Word: `extra${index}`,
    Offset: index * 1_100_000,
    Duration: 1_000_000,
    PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' },
  }));
  const referenceText = Array.from({ length: 70 }, (_, index) => `required${index}`).join(' ');
  const saturatedRaw = {
    RecognitionStatus: 'Success',
    NBest: [{
      Display: 'many unmatched recognized words',
      Confidence: 0.9,
      PronunciationAssessment: { ProsodyScore: 80 },
      Words: recognizedWords,
    }],
  };
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(saturatedRaw),
    timeoutMs: 100, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });

  const result = await provider.assess(request({ referenceText }));

  assert.equal(result.status, 'low_quality');
  assert.equal(result.isFinal, true);
  assert.equal(result.words.length, 500);
  assert.equal(result.words.every((word) => word.errorType === 'insertion'), true);
  assert.equal(result.accuracyScore, 0);
  assert.equal(result.completenessScore, 0);
  assert.equal(result.fluencyScore, null, 'no valid timed word means fluency is unavailable');
  assert.equal(result.overallScore, null, 'missing fluency cannot manufacture an aggregate score');
  assert.equal(result.quality.warnings.includes('word_details_truncated'), true);
});

test('Azure adapter fails closed without config/package and stops a timed-out continuous recognizer', async () => {
  const unconfigured = createAzurePronunciationProvider({ subscriptionKey: '', region: '' });
  assert.deepEqual(await unconfigured.status(), {
    available: false, provider: 'azure-speech', reason: 'provider_not_configured',
  });
  const missingSdk = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured',
    sdkLoader: async () => { throw Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }); },
  });
  assert.deepEqual(await missingSdk.status(), {
    available: false, provider: 'azure-speech', reason: 'sdk_not_installed',
  });

  const hangingSdk = fakeSdk(azureRaw, { stopEvent: false });
  const timed = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => hangingSdk,
    timeoutMs: 5, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  await assert.rejects(timed.assess(request()), (error) => (
    error?.code === 'SPEAKING_PRONUNCIATION_TIMEOUT' && error?.processingStarted === true
  ));
  assert.equal(hangingSdk.lifecycle.start, 1);
  assert.equal(hangingSdk.lifecycle.stop, 1);
  assert.equal(hangingSdk.lifecycle.closed, true);
});

test('Azure adapter bounds cleanup when the SDK stop callback hangs', async () => {
  const sdk = fakeSdk(azureRaw, { stopCallback: false });
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 5, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  const outcome = await Promise.race([
    provider.assess(request()),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  assert.notEqual(outcome, 'hung');
  assert.equal(sdk.lifecycle.stop, 1);
  assert.equal(sdk.lifecycle.closed, true);
});

test('Azure adapter bounds a never-resolving durable-start callback and still stops and closes', async () => {
  const sdk = fakeSdk(azureRaw);
  const provider = createAzurePronunciationProvider({
    subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => sdk,
    timeoutMs: 5, maxAudioBytes: 128 * 1024, maxDurationSeconds: 180,
  });
  const outcome = await Promise.race([
    provider.assess(request(), { onProcessingStarted: () => new Promise(() => {}) })
      .then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  assert.notEqual(outcome, 'hung');
  assert.equal(outcome?.code, 'SPEAKING_PRONUNCIATION_TIMEOUT');
  assert.equal(outcome?.processingStarted, true);
  assert.equal(sdk.lifecycle.stop, 1);
  assert.equal(sdk.lifecycle.closed, true);
});

test('provider input is bounded and normalizes only en-GB/en-US', async () => {
  const provider = createFakePronunciationProvider({ scenario: 'success', maxAudioBytes: 8, maxDurationSeconds: 10 });
  await assert.rejects(provider.assess(request()), (error) => error?.code === 'SPEAKING_AUDIO_TOO_LARGE');
  await assert.rejects(
    createFakePronunciationProvider({ scenario: 'success' }).assess(request({ locale: 'fr-FR' })),
    (error) => error?.code === 'SPEAKING_LOCALE_UNSUPPORTED',
  );
  await assert.rejects(
    createFakePronunciationProvider({ scenario: 'success' }).assess(request({ durationSeconds: 181 })),
    (error) => error?.code === 'SPEAKING_AUDIO_DURATION_INVALID',
  );
  await assert.rejects(
    createFakePronunciationProvider({ scenario: 'success' }).assess(request({
      audio: testPcmWavAudio({ durationSeconds: 0.5 }), durationSeconds: 1,
    })),
    (error) => error?.code === 'SPEAKING_AUDIO_DURATION_INVALID',
  );
  await assert.rejects(
    createAzurePronunciationProvider({
      subscriptionKey: 'configured', region: 'configured', sdkLoader: async () => fakeSdk(azureRaw),
    }).assess(request({ mimeType: 'audio/webm' })),
    (error) => error?.code === 'SPEAKING_AUDIO_TYPE_UNSUPPORTED',
  );
});
