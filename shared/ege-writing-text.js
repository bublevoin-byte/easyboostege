import { sanitizeEgeWritingText } from './ege-writing-text-sanitizer.js';

export { sanitizeEgeWritingText };

// The FIPI 2026 written-part counting rules are shared by the browser and the assessment service.
// Keep source offsets: the overlength rule must return the exact student fragment, not rebuilt text.
const TOKEN = /\p{L}[\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{M}\p{N}]+)*(?:[ \t\u00a0\u202f]*\/[ \t\u00a0\u202f]*\p{L}[\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{M}\p{N}]+)*)+|\d+[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}\p{N}]+)*|(?:\d{1,3}(?:[ \t\u00a0\u202f]\d{3})+|\d+(?:[.,]\d+)?)(?:[ \t\u00a0\u202f]*%)?|\p{L}[\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{M}\p{N}]+)*/gu;
const TERMINATOR_CANDIDATE = /[.!?…]+/gu;
function rawTokens(text) {
  const value = String(text ?? '');
  return [...value.matchAll(TOKEN)].map((match) => Object.freeze({
    value: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

function tokenKey(token) {
  return token.value.toLocaleLowerCase('en').replace(/[ \t\u00a0\u202f]*\/[ \t\u00a0\u202f]*/gu, '/');
}

function matchingSequence(tokens, sequence, start) {
  return sequence.every((token, offset) => tokenKey(tokens[start + offset]) === tokenKey(token));
}

function copiedQuestionIndexes(value, tokens, assignment) {
  if (typeof assignment?.stimulus !== 'string') return new Set();
  const copied = new Set();
  const questions = assignment.stimulus.match(/[^.!?…]*\?/gu) || [];
  for (const question of questions) {
    const questionTokens = rawTokens(question);
    if (!questionTokens.length) continue;
    for (let index = 0; index <= tokens.length - questionTokens.length; index += 1) {
      if (!matchingSequence(tokens, questionTokens, index)) continue;
      for (let offset = 0; offset < questionTokens.length; offset += 1) copied.add(index + offset);
    }
  }
  return copied;
}

const GENERIC_HEADINGS = new Set([
  'introduction', 'conclusion', 'overview', 'summary', 'report', 'findings', 'results',
  'advantages', 'disadvantages', 'benefits', 'drawbacks', 'problem', 'problems',
  'solution', 'solutions', 'opinion', 'recommendation', 'recommendations', 'main',
]);
const HEADING_CONNECTORS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

function casedStart(value) {
  return value.match(/\p{L}/u)?.[0] || '';
}

function detectedHeading(line, lineTokens, publishedHeadingTokens, topOfDocument) {
  if (!lineTokens.length || lineTokens.length > 12) return false;
  if (publishedHeadingTokens.some((published) => (
    lineTokens.length === published.length && matchingSequence(lineTokens, published, 0)
  ))) return true;
  const keys = lineTokens.map(tokenKey);
  const labelledBlock = /^\s*(?:#{1,6}\s+|(?:question|topic|heading|section|part|introduction|conclusion|overview|summary|findings|results|recommendations?)(?:\s+\d+)?\s*:)/iu.test(line);
  if (labelledBlock) return true;
  if (/[.!?…]\s*$/u.test(line)) return false;
  if (!topOfDocument) return false;
  if (keys.length === 1 && GENERIC_HEADINGS.has(keys[0])) return true;
  const letters = lineTokens.map((token) => casedStart(token.value)).filter(Boolean);
  if (letters.length && letters.every((letter) => letter === letter.toLocaleUpperCase('en'))) return true;
  const titleWords = lineTokens.filter((token) => !HEADING_CONNECTORS.has(tokenKey(token)));
  return titleWords.length >= 2 && titleWords.every((token) => {
    const letter = casedStart(token.value);
    return letter && letter === letter.toLocaleUpperCase('en');
  });
}

const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
const DATE_LINE = new RegExp(`^\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s*,?\\s*\\d{2,4})?|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{2,4})?|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4})\\s*$`, 'iu');
const LETTER_GREETING_LINE = /^\s*(?:dear|hi|hello|hey)\b/iu;
const ADDRESS_LINE = /^\s*\d+[a-z]?\s+(?:[\p{L}\p{M}.'-]+\s+){1,6}(?:street|st|road|rd|avenue|ave|lane|drive|boulevard|square|ulitsa|prospekt)(?:\s*,\s*(?:[\p{L}\p{M}.'-]+\s*){1,3})?\s*$/iu;
const POSTAL_LINE = /^\s*(?:postcode|zip)\s*:\s*[\p{L}\p{N} -]{2,16}\s*$/iu;
const LOCATION_LINE = /^\s*(?:\p{Lu}[\p{L}\p{M}.'-]*(?:\s+(?:(?:of|the|and)\s+)?\p{Lu}[\p{L}\p{M}.'-]*){0,3}|[A-Z]{2,3})\s*$/u;
const LETTER_SIGN_OFF_LINE = /^\s*(?:best\s+wishes|yours(?:\s+(?:sincerely|faithfully))?|kind\s+regards|regards|love|all\s+the\s+best|take\s+care|cheers)\s*,?\s*$/iu;
const LETTER_SIGNATURE_LINE = /^\s*[\p{L}\p{M}'’-]+(?:\s+[\p{L}\p{M}'’-]+)?\s*$/u;

function letterAssessableStart(value) {
  let envelopeObserved = false;
  let locationLinesRemaining = 0;
  for (const line of value.matchAll(/^.*$/gmu)) {
    const content = line[0];
    if (!content.trim()) continue;
    if (LETTER_GREETING_LINE.test(content)) return line.index;
    const header = /^\s*(?:from|to|subject)\s*:/iu.test(content);
    const date = DATE_LINE.test(content);
    const address = ADDRESS_LINE.test(content);
    const postal = POSTAL_LINE.test(content);
    const location = locationLinesRemaining > 0 && LOCATION_LINE.test(content);
    if (!header && !date && !address && !postal && !location) {
      return envelopeObserved ? line.index : 0;
    }
    envelopeObserved = true;
    if (address || postal) locationLinesRemaining = 2;
    else if (location) locationLinesRemaining -= 1;
  }
  return envelopeObserved ? value.length : 0;
}

function letterAssessableBounds(value) {
  const start = letterAssessableStart(value);
  const lines = [...value.matchAll(/^.*$/gmu)];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.index < start || !LETTER_SIGN_OFF_LINE.test(line[0])) continue;
    const signature = lines.slice(index + 1).find((candidate) => candidate[0].trim());
    if (signature && LETTER_SIGNATURE_LINE.test(signature[0])) {
      return Object.freeze({ start, end: signature.index + signature[0].length });
    }
  }
  return Object.freeze({ start, end: value.length });
}

export function egeWritingAssessableText(text, { taskType = null } = {}) {
  const value = String(text ?? '');
  if (taskType !== 'writing_37') return value.trim();
  const { start, end } = letterAssessableBounds(value);
  return value.slice(start, end).trim();
}

export function egeWritingLetterStructure(text) {
  const value = egeWritingAssessableText(text, { taskType: 'writing_37' });
  const lines = value.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  const signOffIndex = lines.findIndex((line) => LETTER_SIGN_OFF_LINE.test(line));
  return Object.freeze({
    greeting: lines.length > 0 && LETTER_GREETING_LINE.test(lines[0]),
    signOff: signOffIndex !== -1,
    signature: signOffIndex !== -1 && signOffIndex < lines.length - 1
      && LETTER_SIGNATURE_LINE.test(lines.at(-1)),
  });
}

function copiedHeadingIndexes(value, tokens, assignment) {
  const publishedHeadingTokens = [
    rawTokens(assignment?.topic),
    ...(Array.isArray(assignment?.rows)
      ? assignment.rows.map((row) => rawTokens(row?.label)) : []),
  ].filter((sequence) => sequence.length);
  const copied = new Set();
  let topOfDocument = true;
  for (const line of value.matchAll(/^.*$/gmu)) {
    if (!line[0].trim()) continue;
    const lineTokens = rawTokens(line[0]);
    if (detectedHeading(line[0], lineTokens, publishedHeadingTokens, topOfDocument)) {
      const start = line.index;
      const end = start + line[0].length;
      tokens.forEach((token, index) => {
        if (token.start >= start && token.end <= end) copied.add(index);
      });
    }
    topOfDocument = false;
  }
  return copied;
}

function repeatedPhraseIndexes(tokens) {
  const repeated = new Set();
  const keys = tokens.map(tokenKey);
  const bigramPositions = new Map();
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = `${keys[index]}\u0000${keys[index + 1]}`;
    const positions = bigramPositions.get(key) || [];
    positions.push(index);
    bigramPositions.set(key, positions);
  }
  const sameBlock = (left, right, length) => {
    for (let offset = 0; offset < length; offset += 1) {
      if (keys[left + offset] !== keys[right + offset]) return false;
    }
    return true;
  };
  for (let start = 0; start < keys.length - 3;) {
    const positions = bigramPositions.get(`${keys[start]}\u0000${keys[start + 1]}`) || [];
    let matched = null;
    for (const next of positions) {
      const length = next - start;
      if (length < 2 || next + length > keys.length) continue;
      if (sameBlock(start, next, length)) {
        matched = { length, end: next + length };
        break;
      }
    }
    if (!matched) {
      start += 1;
      continue;
    }
    while (matched.end + matched.length <= keys.length
      && sameBlock(start, matched.end, matched.length)) matched.end += matched.length;
    for (let index = start + matched.length; index < matched.end; index += 1) repeated.add(index);
    start = matched.end;
  }
  return repeated;
}

function artificialRepeatIndexes(tokens, taskType) {
  const repeated = new Set();
  const minimumWordRun = taskType === 'writing_38' ? 2 : 3;
  for (let start = 0; start < tokens.length;) {
    let end = start + 1;
    while (end < tokens.length && tokenKey(tokens[end]) === tokenKey(tokens[start])) end += 1;
    if (end - start >= minimumWordRun) {
      for (let index = start + 1; index < end; index += 1) repeated.add(index);
      start = end;
    } else {
      start += 1;
    }
  }
  if (taskType === 'writing_38') {
    repeatedPhraseIndexes(tokens).forEach((index) => repeated.add(index));
  }
  return repeated;
}

export function egeWritingWordTokens(text, { taskType = null, assignment = null } = {}) {
  const value = String(text ?? '');
  const tokens = rawTokens(value);
  const excluded = artificialRepeatIndexes(tokens, taskType);
  const taskExcluded = taskType === 'writing_37'
    ? (() => {
      const result = copiedQuestionIndexes(value, tokens, assignment);
      const { start, end } = letterAssessableBounds(value);
      tokens.forEach((token, index) => {
        if (token.start < start || token.end > end) result.add(index);
      });
      return result;
    })()
    : taskType === 'writing_38'
      ? copiedHeadingIndexes(value, tokens, assignment) : new Set();
  taskExcluded.forEach((index) => excluded.add(index));
  return tokens.filter((_token, index) => !excluded.has(index));
}

export function countEgeWritingWords(text, context) {
  return egeWritingWordTokens(text, context).length;
}

function publishedSourceBlocks(assignment) {
  if (!assignment || typeof assignment !== 'object') return [];
  const corpus = [
    typeof assignment.topic === 'string' ? assignment.topic : '',
    ...(Array.isArray(assignment.rows) ? assignment.rows.map((row) => [
      typeof row?.label === 'string' ? row.label : '',
      Number.isInteger(row?.percent) ? `${row.percent}%` : '',
    ].filter(Boolean).join(' ')) : []),
  ].filter(Boolean).join('\n');
  const tokens = rawTokens(corpus);
  return tokens.length >= 10 ? [tokens] : [];
}

// FIPI task 38: exact published-source fragments count as non-productive when each contiguous
// match has at least ten words. Coverage is counted once per answer token, even if source blocks
// overlap, and the strict threshold is greater than 30%, not greater-than-or-equal.
export function egeWritingPublishedSourceOverlap(text, assignment) {
  const answerTokens = egeWritingWordTokens(text, { taskType: 'writing_38', assignment });
  const sources = publishedSourceBlocks(assignment);
  let matchedWords = 0;
  for (let answerStart = 0; answerStart < answerTokens.length;) {
    let longest = 0;
    for (const source of sources) {
      for (let sourceStart = 0; sourceStart < source.length; sourceStart += 1) {
        let length = 0;
        while (answerStart + length < answerTokens.length && sourceStart + length < source.length
          && tokenKey(answerTokens[answerStart + length]) === tokenKey(source[sourceStart + length])) {
          length += 1;
        }
        if (length >= 10) longest = Math.max(longest, length);
      }
    }
    if (longest >= 10) {
      matchedWords += longest;
      answerStart += longest;
    } else answerStart += 1;
  }
  const totalWords = answerTokens.length;
  return Object.freeze({
    matchedWords,
    totalWords,
    ratio: totalWords ? matchedWords / totalWords : 0,
    exceedsThirtyPercent: totalWords > 0 && matchedWords * 10 > totalWords * 3,
  });
}

function enclosingSentence(value, tokens, boundaryIndex) {
  const boundary = tokens[boundaryIndex];
  const terminators = sentenceTerminators(value);
  const previous = terminators.filter((mark) => mark.end <= boundary.start).at(-1);
  const next = terminators.find((mark) => mark.start >= boundary.end) || {
    value: '', start: value.length, end: value.length,
  };
  const firstToken = tokens.findIndex((token) => token.start >= (previous?.end ?? 0));
  let lastToken = boundaryIndex;
  for (let index = boundaryIndex; index < tokens.length && tokens[index].start < next.end; index += 1) {
    lastToken = index;
  }
  return {
    firstToken: firstToken === -1 ? boundaryIndex : firstToken,
    lastToken,
    terminator: next.value,
    end: next.end,
  };
}

const TITLE_ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st']);
const CONTINUING_ABBREVIATIONS = new Set(['e', 'g', 'i', 'ie', 'eg', 'etc', 'fig', 'no', 'vs']);

function sentenceTerminators(value) {
  return [...value.matchAll(TERMINATOR_CANDIDATE)].filter((match) => {
    if (match[0] !== '.') return true;
    const start = match.index;
    const previousCharacter = value[start - 1] || '';
    const nextCharacter = value[start + 1] || '';
    if (/\d/u.test(previousCharacter) && /\d/u.test(nextCharacter)) return false;
    if (/[\p{L}\p{N}]/u.test(nextCharacter)) return false;
    const previousWord = /([\p{L}]{1,12})$/u.exec(value.slice(0, start))?.[1]?.toLocaleLowerCase('en');
    const nextVisible = /\S/u.exec(value.slice(start + 1))?.[0] || '';
    if (previousWord && nextVisible && (TITLE_ABBREVIATIONS.has(previousWord)
      || (CONTINUING_ABBREVIATIONS.has(previousWord) && /\p{Ll}|\d/u.test(nextVisible)))) return false;
    return true;
  }).map((match) => ({
    value: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

function exactBoundaryEnd(value, tokens, boundaryIndex) {
  return tokens[boundaryIndex + 1]?.start ?? value.length;
}

// FIPI Appendix 3: when the formal cutoff lands inside task 37's question, exclude that whole
// question unless only one word is missing. For task 38 the same rule applies to a sentence, with
// a tolerance of one or two missing words. Text after the accepted boundary is never evaluated.
export function takeEgeWritingEvaluationFragment(text, { taskType, assignment = null, limit }) {
  const value = egeWritingAssessableText(String(text ?? '').trim(), { taskType });
  const tokens = egeWritingWordTokens(value, { taskType, assignment });
  if (!Number.isInteger(limit) || limit < 1 || tokens.length === 0) return '';
  if (tokens.length <= limit) return value;

  const boundaryIndex = limit - 1;
  const sentence = enclosingSentence(value, tokens, boundaryIndex);
  const missingWords = sentence.lastToken - boundaryIndex;
  const isQuestion = sentence.terminator.includes('?');
  const boundaryRuleApplies = taskType === 'writing_38'
    || (taskType === 'writing_37' && isQuestion);
  if (boundaryRuleApplies && missingWords > 0) {
    const tolerance = taskType === 'writing_37' ? 1 : 2;
    if (missingWords <= tolerance) return value.slice(0, sentence.end).trim();
    return value.slice(0, tokens[sentence.firstToken].start).trim();
  }
  return value.slice(0, exactBoundaryEnd(value, tokens, boundaryIndex)).trim();
}
