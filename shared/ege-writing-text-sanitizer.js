// This cross-runtime policy has no DOM or Node dependency. The server and the browser adapters
// both delegate here so transformation and removal reporting cannot drift.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
const HTML_TAG = /<\/?[a-zA-Z][^<>]{0,200}>/gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;

export function sanitizeEgeWritingText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(HTML_COMMENT, ' ')
    .replace(HTML_TAG, ' ')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function describeEgeWritingTextSanitization(original, sanitized) {
  const source = String(original ?? '');
  return {
    changed: source !== sanitized,
    removedTags: (source.match(HTML_TAG) || []).length + (source.match(HTML_COMMENT) || []).length,
    removedControl: (source.match(CONTROL) || []).length,
    removedInvisible: (source.match(INVISIBLE) || []).length,
  };
}
