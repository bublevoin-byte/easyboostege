// Student text is untrusted input for both the model and the browser. Normalising it once at the
// API boundary means every later stage — deterministic checks, prompt, storage — sees the same
// clean string, and the word count cannot be inflated by things nobody typed.

// Everything below C0 except tab and newline, plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
// Zero-width and bidirectional overrides: invisible in the editor, but they hide text from a
// reviewer while the model still reads it.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
// A tag-like sequence is never part of an English essay; a lone "<" in "5 < 10" is kept.
const HTML_TAG = /<\/?[a-zA-Z][^<>]{0,200}>/gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;

export function sanitizeStudentText(value) {
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

// Reported so a caller can tell a rejected answer from one that merely lost formatting.
export function describeSanitization(original, sanitized) {
  const source = String(original ?? '');
  return {
    changed: source !== sanitized,
    removedTags: (source.match(HTML_TAG) || []).length + (source.match(HTML_COMMENT) || []).length,
    removedControl: (source.match(CONTROL) || []).length,
    removedInvisible: (source.match(INVISIBLE) || []).length,
  };
}
