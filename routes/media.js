import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';

import { config } from '../config.js';
import { pruneAudioCache, validateAudioUpload, withTimeout } from '../audio/controls.js';
import { recordDependencyEvent } from '../observability/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XAI_KEY = config.ai.xaiKey;

// Speech synthesis and recognition: cached TTS on disk, streamed STT uploads with hard limits.
export function createMediaRoutes({ authentication, access }) {
  const router = express.Router();
  const { auth } = authentication;
  const { ttsLimiter, sttLimiter, requireActiveSubscription, requirePrivacyConsent } = access;

  const TTS_DIR = path.join(__dirname, 'tts-cache');
  try { fs.mkdirSync(TTS_DIR, { recursive: true }); } catch (e) {}
  pruneAudioCache(TTS_DIR, { maxAgeMs: config.ai.ttsCacheMaxAgeMs, maxBytes: config.ai.ttsCacheMaxBytes });
  const TTS_VOICES = new Set(['en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-LibbyNeural', 'en-GB-ThomasNeural']);
  // соответствие ролей: женский/мужской
  const GROK_VOICE = { 'en-GB-SoniaNeural': 'eve', 'en-GB-RyanNeural': 'rex', 'en-GB-LibbyNeural': 'ara', 'en-GB-ThomasNeural': 'leo' };
  let _ttsMod = null;

  function ttsSend(res, buf, file) {
    try { fs.writeFileSync(file, buf); } catch (e) {}
    try { pruneAudioCache(TTS_DIR, { maxAgeMs: config.ai.ttsCacheMaxAgeMs, maxBytes: config.ai.ttsCacheMaxBytes }); } catch (e) {}
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.end(buf);
  }
  async function grokTts(text, voice) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ai.ttsTimeoutMs);
    let r;
    try { r = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + XAI_KEY }, signal: controller.signal,
      body: JSON.stringify({ text, voice_id: GROK_VOICE[voice] || 'eve', language: 'en' }),
    }); } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error('Grok TTS HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('Grok TTS: пустое аудио');
    return buf;
  }
  async function edgeTts(text, voice, slow) {
    if (!_ttsMod) _ttsMod = await import('msedge-tts');
    const { MsEdgeTTS, OUTPUT_FORMAT } = _ttsMod;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const st = await tts.toStream(text, slow ? { rate: '-25%' } : undefined);
    const stream = st && st.audioStream ? st.audioStream : st;
    return withTimeout(new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { const b = Buffer.concat(chunks); b.length ? resolve(b) : reject(new Error('пустое аудио')); });
      stream.on('error', reject);
    }), config.ai.ttsTimeoutMs, 'TTS_TIMEOUT');
  }
  router.get('/api/v1/tts', auth, requireActiveSubscription, ttsLimiter, async (req, res) => {
    const text = String(req.query.text || '').slice(0, 500).trim();
    if (!text) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Не указан текст для озвучивания.' } });
    const voice = TTS_VOICES.has(req.query.voice) ? req.query.voice : 'en-GB-SoniaNeural';
    const slow = req.query.slow === '1';
    const useGrok = config.ai.xaiEnabled && !!XAI_KEY && !slow;
    const key = crypto.createHash('sha256').update((useGrok ? 'g' : 'e') + '|' + voice + '|' + (slow ? 1 : 0) + '|' + text).digest('hex');
    const file = path.join(TTS_DIR, key + '.mp3');
    if (fs.existsSync(file)) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=604800');
      return res.sendFile(file);
    }
    if (useGrok) {
      try {
        const audio = await grokTts(text, voice);
        recordDependencyEvent('tts', 'success');
        return ttsSend(res, audio, file);
      } catch (e) {
        recordDependencyEvent('tts', 'error');
        recordDependencyEvent('tts', 'fallback');
        console.log('Grok TTS не сработал, пробую Edge:', e.message);
      }
    }
    try {
      const ekey = crypto.createHash('sha256').update('e|' + voice + '|' + (slow ? 1 : 0) + '|' + text).digest('hex');
      const audio = await edgeTts(text, voice, slow);
      recordDependencyEvent('tts', 'success');
      return ttsSend(res, audio, path.join(TTS_DIR, ekey + '.mp3'));
    } catch (e) {
      recordDependencyEvent('tts', 'error');
      res.status(503).json({ error: { code: 'TTS_UNAVAILABLE', message: 'Озвучка временно недоступна.' } });
    }
  });

  // ---- расшифровка речи (Grok STT) для оценки говорения ----
  router.post('/api/v1/stt', auth, requireActiveSubscription, requirePrivacyConsent('voice_processing'), sttLimiter, express.raw({ type: () => true, limit: config.ai.sttMaxBytes }), async (req, res) => {
    try {
      if (!config.ai.xaiEnabled || !XAI_KEY) {
        recordDependencyEvent('stt', 'error');
        return res.status(503).json({ error: { code: 'STT_NOT_CONFIGURED', message: 'Распознавание речи не настроено.' } });
      }
      const buf = req.body;
      const upload = validateAudioUpload(req.headers['content-type'], buf, config.ai.sttMaxBytes);
      if (!upload.ok) return res.status(upload.status).json({ error: { code: upload.code, message: upload.code === 'UNSUPPORTED_AUDIO_TYPE' ? 'Формат аудио не поддерживается.' : upload.code === 'AUDIO_TOO_LARGE' ? 'Аудиозапись слишком большая.' : 'Аудиозапись пуста.' } });
      const fd = new FormData();
      const extension = upload.mimeType === 'audio/mp4' ? 'mp4' : upload.mimeType === 'audio/mpeg' ? 'mp3' : upload.mimeType.includes('wav') ? 'wav' : upload.mimeType === 'audio/ogg' ? 'ogg' : 'webm';
      fd.append('file', new Blob([buf], { type: upload.mimeType }), `rec.${extension}`);
      fd.append('language', 'en');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.ai.sttTimeoutMs);
      let r;
      try { r = await fetch('https://api.x.ai/v1/stt', { method: 'POST', headers: { Authorization: 'Bearer ' + XAI_KEY }, body: fd, signal: controller.signal }); }
      finally { clearTimeout(timer); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        recordDependencyEvent('stt', 'error');
        return res.status(502).json({ error: { code: 'STT_PROVIDER_UNAVAILABLE', message: 'Распознавание речи временно недоступно.' } });
      }
      recordDependencyEvent('stt', 'success');
      res.json({ text: j.text || '', duration: j.duration || 0 });
    } catch (e) {
      recordDependencyEvent('stt', 'error');
      res.status(502).json({ error: { code: 'STT_UNAVAILABLE', message: 'Не удалось распознать запись.' } });
    }
  });

  return router;
}
