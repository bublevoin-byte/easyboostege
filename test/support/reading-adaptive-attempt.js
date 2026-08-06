import { READING_TASK10_SETS } from '../../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../../public/content/reading/task12-18-v1.js';

const SETS = [...READING_TASK10_SETS, ...READING_TASK11_SETS, ...READING_TASK12_18_SETS];

export function readingAdaptiveAttemptMetadata(block, { attemptId = 'reading-adaptive-test-01' } = {}) {
  if (block?.module !== 'reading') return undefined;
  const match = /^builtin:reading:(task10|task11|task12_18):(b1|b2|b2-plus-c1):v1$/u.exec(block.contentRef);
  const cefr = { b1: 'B1', b2: 'B2', 'b2-plus-c1': 'B2+/C1' }[match?.[2]];
  const set = SETS.find((item) => item.kind === match?.[1] && item.cefr === cefr);
  if (!set) throw new TypeError('test Reading block is not canonical');
  return {
    mode: set.kind === 'task10' ? 'reading_headings' : (set.kind === 'task11' ? 'reading_gaps' : 'reading_detail'),
    source: 'catalog', helpUsed: false, hintsUsed: 0,
    readingProvenance: 'canonical', readingSetId: set.id, readingSetRevision: set.revision,
    readingKind: set.kind, readingCefr: set.cefr, readingContentRef: block.contentRef,
    readingAttemptId: attemptId, readingSlice: set.kind === 'task10' ? 'gist' : 'detail',
  };
}
