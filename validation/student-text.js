import {
  describeEgeWritingTextSanitization,
  sanitizeEgeWritingText,
} from '../shared/ege-writing-text-sanitizer.js';

// Student text is untrusted input for both the model and the browser. Normalising it once at the
// API boundary means every later stage — deterministic checks, prompt, storage — sees the same
// clean string, and the word count cannot be inflated by things nobody typed.

export function sanitizeStudentText(value) {
  return sanitizeEgeWritingText(value);
}

// Reported so a caller can tell a rejected answer from one that merely lost formatting.
export function describeSanitization(original, sanitized) {
  return describeEgeWritingTextSanitization(original, sanitized);
}
