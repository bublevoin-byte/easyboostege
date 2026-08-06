import { parsePcm16Mono16kWav } from './wav-audio.js';

const SUPPORTED_LOCALES = new Set(['en-GB', 'en-US']);
const SUPPORTED_MIME_TYPES = new Set(['audio/wav']);
const MAX_TRANSCRIPT_LENGTH = 10_000;
const MAX_WORDS = 500;
const MAX_PHONEMES_PER_WORD = 24;
const MAX_SYLLABLES_PER_WORD = 16;
const MAX_CANDIDATES = 5;
const MAX_REFERENCE_WORDS = 500;
const MAX_PROVIDER_SEGMENTS = 200;
const MAX_PROVIDER_JSON_BYTES = 256 * 1024;
const MAX_PROVIDER_TOTAL_JSON_BYTES = 2 * 1024 * 1024;

export class SpeakingPronunciationError extends Error {
  constructor(code, { processingStarted = false } = {}) {
    super(code);
    this.name = 'SpeakingPronunciationError';
    this.code = code;
    this.processingStarted = processingStarted;
  }
}

function boundedText(value, maxLength = MAX_TRANSCRIPT_LENGTH) {
  return String(value || '').trim().slice(0, maxLength);
}

function finiteScore(value) {
  if (value == null || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
}

function secondsFromTicks(value) {
  const ticks = Number(value);
  return Number.isFinite(ticks) && ticks >= 0 ? Math.round((ticks / 10_000_000) * 1_000) / 1_000 : null;
}

function providerErrorType(value) {
  const normalized = String(value || 'None').replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase();
  return ['none', 'omission', 'insertion', 'mispronunciation', 'unexpected_break', 'missing_break', 'monotone']
    .includes(normalized) ? normalized : 'unknown';
}

function validateAssessmentInput(input, { maxAudioBytes, maxDurationSeconds }) {
  const audio = Buffer.isBuffer(input?.audio) ? input.audio : null;
  if (!audio || audio.length === 0) throw new SpeakingPronunciationError('SPEAKING_AUDIO_REQUIRED');
  if (audio.length > maxAudioBytes) throw new SpeakingPronunciationError('SPEAKING_AUDIO_TOO_LARGE');
  const durationSeconds = Number(input.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxDurationSeconds) {
    throw new SpeakingPronunciationError('SPEAKING_AUDIO_DURATION_INVALID');
  }
  const locale = String(input.locale || '');
  if (!SUPPORTED_LOCALES.has(locale)) throw new SpeakingPronunciationError('SPEAKING_LOCALE_UNSUPPORTED');
  const mimeType = String(input.mimeType || '').split(';', 1)[0].toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new SpeakingPronunciationError('SPEAKING_AUDIO_TYPE_UNSUPPORTED');
  const wav = parsePcm16Mono16kWav(audio);
  if (!wav) throw new SpeakingPronunciationError('SPEAKING_AUDIO_CONTAINER_INVALID');
  if (wav.durationSeconds < 1 || wav.durationSeconds > maxDurationSeconds) {
    throw new SpeakingPronunciationError('SPEAKING_AUDIO_DURATION_INVALID');
  }
  const mode = input.mode === 'scripted' ? 'scripted' : input.mode === 'unscripted' ? 'unscripted' : null;
  if (!mode) throw new SpeakingPronunciationError('SPEAKING_ASSESSMENT_MODE_INVALID');
  const referenceText = boundedText(input.referenceText, 6_000);
  if (mode === 'scripted' && !referenceText) throw new SpeakingPronunciationError('SPEAKING_REFERENCE_REQUIRED');
  return { audio, durationSeconds: wav.durationSeconds, locale, mimeType, mode, referenceText };
}

function publicPhoneme(raw, locale) {
  const assessment = raw?.PronunciationAssessment || {};
  const base = {
    name: locale === 'en-US' ? boundedText(raw?.Phoneme, 24) || null : null,
    accuracyScore: finiteScore(assessment.AccuracyScore),
  };
  if (locale !== 'en-US') return base;
  return {
    ...base,
    ipa: boundedText(raw?.Phoneme, 24) || null,
    candidates: (Array.isArray(raw?.NBestPhonemes) ? raw.NBestPhonemes : [])
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => ({
        name: boundedText(candidate?.Phoneme, 24),
        score: finiteScore(candidate?.Score),
      }))
      .filter((candidate) => candidate.name),
  };
}

function publicWord(raw, locale) {
  const assessment = raw?.PronunciationAssessment || {};
  const word = {
    text: boundedText(raw?.Word, 120),
    offsetSeconds: secondsFromTicks(raw?.Offset),
    durationSeconds: secondsFromTicks(raw?.Duration),
    accuracyScore: finiteScore(assessment.AccuracyScore),
    errorType: providerErrorType(assessment.ErrorType),
    phonemes: (Array.isArray(raw?.Phonemes) ? raw.Phonemes : [])
      .slice(0, MAX_PHONEMES_PER_WORD)
      .map((phoneme) => publicPhoneme(phoneme, locale)),
  };
  if (locale === 'en-US') {
    word.syllables = (Array.isArray(raw?.Syllables) ? raw.Syllables : [])
      .slice(0, MAX_SYLLABLES_PER_WORD)
      .map((syllable) => ({
        text: boundedText(syllable?.Syllable, 80),
        offsetSeconds: secondsFromTicks(syllable?.Offset),
        durationSeconds: secondsFromTicks(syllable?.Duration),
        accuracyScore: finiteScore(syllable?.PronunciationAssessment?.AccuracyScore),
      }));
  }
  return word;
}

function average(values) {
  const scores = values.filter((value) => value != null);
  if (!scores.length) return null;
  return Math.round((scores.reduce((total, value) => total + value, 0) / scores.length) * 10) / 10;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function wordToken(value) {
  return String(value || '').toLocaleLowerCase('en-US')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function assessedRawWord(raw, forcedErrorType = null) {
  const assessment = raw?.PronunciationAssessment || {};
  const score = finiteScore(assessment.AccuracyScore);
  const current = providerErrorType(forcedErrorType || assessment.ErrorType);
  const errorType = current === 'none' && score != null && score < 60 ? 'mispronunciation' : current;
  return {
    ...raw,
    PronunciationAssessment: {
      ...assessment,
      ErrorType: errorType,
    },
  };
}

function alignScriptedWords(referenceText, providerWords) {
  const referenceWords = String(referenceText || '').split(/\s+/u)
    .map(wordToken).filter(Boolean).slice(0, MAX_REFERENCE_WORDS);
  const recognized = providerWords.map((raw) => ({ raw, token: wordToken(raw?.Word) }))
    .filter((item) => item.token);
  const referenceCount = referenceWords.length;
  const recognizedCount = recognized.length;
  const width = recognizedCount + 1;
  const lcs = new Uint16Array((referenceCount + 1) * width);
  for (let referenceIndex = referenceCount - 1; referenceIndex >= 0; referenceIndex -= 1) {
    for (let recognizedIndex = recognizedCount - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
      const index = referenceIndex * width + recognizedIndex;
      lcs[index] = referenceWords[referenceIndex] === recognized[recognizedIndex].token
        ? lcs[(referenceIndex + 1) * width + recognizedIndex + 1] + 1
        : Math.max(lcs[(referenceIndex + 1) * width + recognizedIndex], lcs[index + 1]);
    }
  }
  const aligned = [];
  let referenceIndex = 0;
  let recognizedIndex = 0;
  while (referenceIndex < referenceCount || recognizedIndex < recognizedCount) {
    if (referenceIndex < referenceCount && recognizedIndex < recognizedCount
      && referenceWords[referenceIndex] === recognized[recognizedIndex].token) {
      aligned.push(assessedRawWord(recognized[recognizedIndex].raw));
      referenceIndex += 1;
      recognizedIndex += 1;
    } else if (recognizedIndex < recognizedCount && (referenceIndex >= referenceCount
      || lcs[referenceIndex * width + recognizedIndex + 1]
        >= lcs[(referenceIndex + 1) * width + recognizedIndex])) {
      aligned.push(assessedRawWord(recognized[recognizedIndex].raw, 'insertion'));
      recognizedIndex += 1;
    } else if (referenceIndex < referenceCount) {
      aligned.push(assessedRawWord({
        Word: referenceWords[referenceIndex],
        PronunciationAssessment: { AccuracyScore: 0, ErrorType: 'omission' },
      }));
      referenceIndex += 1;
    }
  }
  // Keep the complete bounded alignment (at most MAX_REFERENCE_WORDS + MAX_WORDS)
  // for paragraph scoring. The public DTO applies MAX_WORDS separately below.
  return aligned;
}

function continuousScores(rawWords, alignedWords, { locale, mode, phraseAssessments }) {
  const nonInsertions = alignedWords.filter((word) => (
    providerErrorType(word?.PronunciationAssessment?.ErrorType) !== 'insertion'
  ));
  const accuracyValues = nonInsertions.map((word) => (
    finiteScore(word?.PronunciationAssessment?.AccuracyScore) ?? 0
  ));
  const accuracyScore = accuracyValues.length
    ? rounded(accuracyValues.reduce((total, value) => total + value, 0) / accuracyValues.length)
    : null;
  const validWords = alignedWords.filter((word) => (
    providerErrorType(word?.PronunciationAssessment?.ErrorType) === 'none'
      && finiteScore(word?.PronunciationAssessment?.AccuracyScore) != null
  ));
  const timedWords = rawWords.filter((word) => (
    Number.isFinite(Number(word?.Offset)) && Number.isFinite(Number(word?.Duration))
      && Number(word.Offset) >= 0 && Number(word.Duration) >= 0
  ));
  const startOffset = timedWords.length ? Math.min(...timedWords.map((word) => Number(word.Offset))) : null;
  const endOffset = timedWords.length
    ? Math.max(...timedWords.map((word) => Number(word.Offset) + Number(word.Duration) + 100_000)) : null;
  const spokenTicks = validWords.reduce((total, word) => {
    const duration = Number(word?.Duration);
    return Number.isFinite(duration) && duration >= 0 ? total + duration + 100_000 : total;
  }, 0);
  const fluencyScore = startOffset != null && endOffset > startOffset
    ? rounded(Math.max(0, Math.min(100, (spokenTicks / (endOffset - startOffset)) * 100))) : null;
  const completenessScore = mode === 'scripted' && nonInsertions.length
    ? rounded(Math.min(100, (validWords.length / nonInsertions.length) * 100)) : null;
  const prosodyScore = locale === 'en-US'
    ? average(phraseAssessments.map((assessment) => finiteScore(assessment.ProsodyScore))) : null;
  const scoreParts = mode === 'scripted'
    ? [accuracyScore, fluencyScore, completenessScore]
    : [accuracyScore, fluencyScore];
  if (locale === 'en-US' && prosodyScore != null) scoreParts.push(prosodyScore);
  let overallScore = null;
  if (scoreParts.every((score) => score != null)) {
    const sorted = scoreParts.sort((left, right) => left - right);
    if (sorted.length === 4) {
      overallScore = rounded(sorted[0] * 0.4 + sorted.slice(1).reduce((sum, score) => sum + score * 0.2, 0));
    } else if (sorted.length === 3) {
      overallScore = rounded(sorted[0] * 0.6 + sorted[1] * 0.2 + sorted[2] * 0.2);
    } else if (sorted.length === 2) {
      overallScore = rounded(sorted[0] * 0.6 + sorted[1] * 0.4);
    }
  }
  return { accuracyScore, fluencyScore, completenessScore, prosodyScore, overallScore };
}

function normalizeAzureResults(rawResults, {
  locale, mode, referenceText = '', partial = false, fallbackTranscript = '', claimedDurationSeconds,
}) {
  const recognized = rawResults.map((raw) => raw?.NBest?.[0]).filter(Boolean);
  const rawWords = recognized.flatMap((best) => (Array.isArray(best.Words) ? best.Words : []))
    .slice(0, MAX_WORDS);
  const alignedWords = mode === 'scripted' && referenceText
    ? alignScriptedWords(referenceText, rawWords)
    : rawWords.map((word) => assessedRawWord(word));
  const words = alignedWords.slice(0, MAX_WORDS).map((word) => publicWord(word, locale));
  const transcript = boundedText(
    recognized.map((best) => best.Display || best.Lexical || '').filter(Boolean).join(' ') || fallbackTranscript,
  );
  const assessments = recognized.map((best) => best.PronunciationAssessment || {});
  const scores = continuousScores(rawWords, alignedWords, {
    locale, mode, phraseAssessments: assessments,
  });
  const confidence = average(recognized.map((best) => finiteScore(Number(best.Confidence) * 100)));
  const processedDurationSeconds = Math.round(Number(claimedDurationSeconds) * 1_000) / 1_000;
  const warnings = [];
  const detailsTruncated = alignedWords.length > words.length;
  if (!transcript || rawWords.length === 0) warnings.push('speech_not_recognized');
  if (confidence != null && confidence < 35) warnings.push('low_recognition_confidence');
  if (detailsTruncated) warnings.push('word_details_truncated');
  const requiredScores = mode === 'scripted'
    ? [scores.accuracyScore, scores.fluencyScore, scores.completenessScore]
    : [scores.accuracyScore, scores.fluencyScore];
  const scoresAvailable = requiredScores.every((score) => score != null);
  if (rawWords.length > 0 && !scoresAvailable) warnings.push('assessment_scores_unavailable');
  const acceptable = transcript.length > 0 && rawWords.length > 0
    && (confidence == null || confidence >= 35) && scoresAvailable;
  const status = partial || detailsTruncated ? 'partial' : acceptable ? 'success' : 'low_quality';
  return {
    status,
    isFinal: !partial,
    provider: 'azure-speech',
    providerVersion: 'speech-sdk-continuous-v1',
    locale,
    mode,
    transcript,
    processedDurationSeconds,
    confidence,
    overallScore: acceptable ? scores.overallScore : null,
    accuracyScore: acceptable ? scores.accuracyScore : null,
    fluencyScore: acceptable ? scores.fluencyScore : null,
    completenessScore: acceptable && mode === 'scripted' ? scores.completenessScore : null,
    prosody: locale === 'en-US'
      ? { available: true, score: acceptable ? scores.prosodyScore : null }
      : { available: false, score: null, reason: 'locale_not_supported' },
    words,
    quality: { acceptable, warnings: warnings.slice(0, 12) },
  };
}

function fakeRaw(locale, scenario) {
  const confidence = scenario === 'low_quality' ? 0.12 : 0.94;
  const accuracy = scenario === 'low_quality' ? 20 : 91;
  return {
    NBest: [{
      Display: scenario === 'low_quality' ? '' : 'A short trusted transcript.',
      Confidence: confidence,
      PronunciationAssessment: {
        AccuracyScore: accuracy, FluencyScore: 86, CompletenessScore: 98,
        PronScore: 90, ProsodyScore: locale === 'en-US' ? 84 : undefined,
      },
      Words: scenario === 'low_quality' ? [] : [{
        Word: 'A', Offset: 0, Duration: 2_000_000,
        PronunciationAssessment: { AccuracyScore: 93, ErrorType: 'None' },
        Phonemes: [{
          Phoneme: 'æ', PronunciationAssessment: { AccuracyScore: 92 },
          NBestPhonemes: [{ Phoneme: 'æ', Score: 92 }],
        }],
        Syllables: [{
          Syllable: 'æ', Offset: 0, Duration: 2_000_000,
          PronunciationAssessment: { AccuracyScore: 92 },
        }],
      }],
    }],
  };
}

export function createFakePronunciationProvider({
  scenario = 'success', maxAudioBytes = 10 * 1024 * 1024, maxDurationSeconds = 180,
} = {}) {
  return Object.freeze({
    async status() {
      return scenario === 'unavailable'
        ? { available: false, reason: 'provider_unavailable', provider: 'fake-azure' }
        : { available: true, reason: null, provider: 'fake-azure' };
    },
    async assess(input, { onProcessingStarted } = {}) {
      const validated = validateAssessmentInput(input, { maxAudioBytes, maxDurationSeconds });
      if (scenario === 'unavailable') throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_UNAVAILABLE');
      await onProcessingStarted?.();
      if (scenario === 'timeout') {
        throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_TIMEOUT', { processingStarted: true });
      }
      const result = normalizeAzureResults([fakeRaw(validated.locale, scenario)], {
        locale: validated.locale,
        mode: validated.mode,
        partial: scenario === 'partial',
        claimedDurationSeconds: validated.durationSeconds,
      });
      return { ...result, provider: 'fake-azure' };
    },
  });
}

function optionalSdkLoader() {
  return import('microsoft-cognitiveservices-speech-sdk');
}

function loadFailureReason(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || /cannot find (?:package|module)/iu.test(String(error?.message || ''))
    ? 'sdk_not_installed' : 'provider_unavailable';
}

function redactedLog(logger, event, fields = {}) {
  try {
    logger({
      type: 'speaking_pronunciation_provider', event,
      provider: 'azure-speech',
      ...(fields.code ? { code: boundedText(fields.code, 80) } : {}),
      ...(Number.isFinite(fields.segmentCount) ? { segmentCount: fields.segmentCount } : {}),
      ...(fields.locale && SUPPORTED_LOCALES.has(fields.locale) ? { locale: fields.locale } : {}),
    });
  } catch {}
}

export function createAzurePronunciationProvider({
  subscriptionKey = '', region = '', sdkLoader = optionalSdkLoader,
  timeoutMs = 30_000, maxAudioBytes = 10 * 1024 * 1024, maxDurationSeconds = 180,
  logger = () => {},
} = {}) {
  let sdkPromise = null;
  const configured = Boolean(String(subscriptionKey).trim() && String(region).trim());

  async function loadSdk() {
    if (!configured) return { sdk: null, reason: 'provider_not_configured' };
    sdkPromise ||= Promise.resolve().then(sdkLoader)
      .then((module) => ({ sdk: module?.default || module, reason: null }))
      .catch((error) => ({ sdk: null, reason: loadFailureReason(error) }));
    return sdkPromise;
  }

  async function status() {
    const loaded = await loadSdk();
    return loaded.sdk
      ? { available: true, provider: 'azure-speech', reason: null }
      : { available: false, provider: 'azure-speech', reason: loaded.reason };
  }

  async function assess(input, { onProcessingStarted } = {}) {
    const validated = validateAssessmentInput(input, { maxAudioBytes, maxDurationSeconds });
    const loaded = await loadSdk();
    if (!loaded.sdk) throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_UNAVAILABLE');
    const sdk = loaded.sdk;
    let recognizer;
    let audioConfig;
    let processingStarted = false;
    const rawResults = [];
    const transcripts = [];
    let recognizedSegments = 0;
    let providerJsonBytes = 0;
    let partial = false;
    let timer;

    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(String(subscriptionKey), String(region));
      speechConfig.speechRecognitionLanguage = validated.locale;
      audioConfig = sdk.AudioConfig.fromWavFileInput(validated.audio);
      const pronunciation = new sdk.PronunciationAssessmentConfig(
        validated.mode === 'scripted' ? validated.referenceText : '',
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Phoneme,
        false,
      );
      if (validated.locale === 'en-US') {
        pronunciation.phonemeAlphabet = 'IPA';
        pronunciation.nbestPhonemeCount = MAX_CANDIDATES;
        pronunciation.enableProsodyAssessment?.();
      }
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      pronunciation.applyTo(recognizer);

      await new Promise((resolve, reject) => {
        let finishing = false;
        let startBarrier = Promise.resolve();
        const deadlineAt = Date.now() + timeoutMs;
        const stop = (afterStop) => {
          if (!processingStarted) { afterStop(); return; }
          let stopped = false;
          const stopTimer = setTimeout(completeStop, Math.min(1_000, Math.max(25, timeoutMs)));
          function completeStop() {
            if (stopped) return;
            stopped = true;
            clearTimeout(stopTimer);
            afterStop();
          }
          try { recognizer.stopContinuousRecognitionAsync(completeStop, completeStop); } catch { completeStop(); }
        };
        const finish = async (error = null) => {
          if (finishing) return;
          finishing = true;
          let finalError = error;
          let barrierTimer;
          try {
            await Promise.race([
              startBarrier,
              new Promise((_, reject) => {
                barrierTimer = setTimeout(() => reject(new SpeakingPronunciationError(
                  'SPEAKING_PRONUNCIATION_TIMEOUT', { processingStarted },
                )), Math.max(0, deadlineAt - Date.now()));
              }),
            ]);
          } catch (startError) { finalError = startError; }
          clearTimeout(barrierTimer);
          clearTimeout(timer);
          stop(() => (finalError ? reject(finalError) : resolve()));
        };
        recognizer.recognized = (_sender, event) => {
          const result = event?.result;
          if (!result || result.reason !== sdk.ResultReason.RecognizedSpeech) return;
          if (recognizedSegments >= MAX_PROVIDER_SEGMENTS) { partial = true; return; }
          recognizedSegments += 1;
          transcripts.push(boundedText(result.text, 500));
          try {
            const json = result.properties?.getProperty(
              sdk.PropertyId.SpeechServiceResponse_JsonResult,
            );
            const jsonBytes = Buffer.byteLength(String(json || ''), 'utf8');
            if (jsonBytes > MAX_PROVIDER_JSON_BYTES
              || providerJsonBytes + jsonBytes > MAX_PROVIDER_TOTAL_JSON_BYTES) {
              partial = true;
              return;
            }
            providerJsonBytes += jsonBytes;
            const parsed = JSON.parse(json || '{}');
            if (parsed && typeof parsed === 'object') rawResults.push(parsed);
          } catch {
            partial = true;
          }
        };
        recognizer.canceled = () => {
          if (rawResults.length) { partial = true; finish(); }
          else finish(new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_PROVIDER_ERROR', {
            processingStarted,
          }));
        };
        recognizer.sessionStopped = () => finish();
        timer = setTimeout(() => finish(new SpeakingPronunciationError(
          'SPEAKING_PRONUNCIATION_TIMEOUT', { processingStarted },
        )), timeoutMs);
        recognizer.startContinuousRecognitionAsync(() => {
          processingStarted = true;
          startBarrier = Promise.resolve()
            .then(() => onProcessingStarted?.())
            .then(() => {
            redactedLog(logger, 'started', { locale: validated.locale });
            });
          startBarrier.catch((error) => finish(error));
        }, () => finish(new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_PROVIDER_ERROR')));
      });
      const normalized = normalizeAzureResults(rawResults, {
        locale: validated.locale,
        mode: validated.mode,
        referenceText: validated.referenceText,
        partial,
        fallbackTranscript: transcripts.join(' '),
        claimedDurationSeconds: validated.durationSeconds,
      });
      redactedLog(logger, 'completed', { locale: validated.locale, segmentCount: rawResults.length });
      return normalized;
    } catch (error) {
      const safeError = error instanceof SpeakingPronunciationError
        ? error
        : new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_PROVIDER_ERROR', { processingStarted });
      if (processingStarted) safeError.processingStarted = true;
      redactedLog(logger, 'failed', { locale: validated.locale, code: safeError.code });
      throw safeError;
    } finally {
      try { recognizer?.close?.(); } catch {}
      try { audioConfig?.close?.(); } catch {}
    }
  }

  return Object.freeze({ status, assess });
}
