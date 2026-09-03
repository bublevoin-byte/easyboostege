import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_STT_MIME_TYPES = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav']);

export function baseMimeType(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase(); }

export function validateAudioUpload(contentType, buffer, maxBytes) {
  const mimeType = baseMimeType(contentType);
  if (!ALLOWED_STT_MIME_TYPES.has(mimeType)) return { ok: false, status: 415, code: 'UNSUPPORTED_AUDIO_TYPE' };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, status: 400, code: 'EMPTY_AUDIO' };
  if (buffer.length > maxBytes) return { ok: false, status: 413, code: 'AUDIO_TOO_LARGE' };
  return { ok: true, mimeType, size: buffer.length };
}

export function pruneAudioCache(directory, { maxAgeMs, maxBytes, now = Date.now() }) {
  const root = path.resolve(directory);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { removed: 0, bytes: 0 }; }
  const files = entries.filter((entry) => entry.isFile() && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\.mp3$/u.test(entry.name)).map((entry) => {
    const file = path.resolve(root, entry.name);
    if (path.dirname(file) !== root) return null;
    const stat = fs.statSync(file);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  }).filter(Boolean);
  let removed = 0;
  for (const item of files.filter((file) => now - file.mtimeMs > maxAgeMs)) {
    fs.unlinkSync(item.file); item.removed = true; removed++;
  }
  let active = files.filter((file) => !file.removed).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = active.reduce((sum, file) => sum + file.size, 0);
  while (bytes > maxBytes && active.length) {
    const item = active.shift(); fs.unlinkSync(item.file); bytes -= item.size; removed++;
  }
  return { removed, bytes };
}

export function withTimeout(promise, timeoutMs, code = 'EXTERNAL_TIMEOUT') {
  let timer;
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
