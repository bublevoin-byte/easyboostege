const PROVENANCE = Object.freeze({
  kind: 'original',
  author: 'Easy Boost',
  createdAt: '2026-08-13',
  reviewStatus: 'contract_checked',
});

function freezeItem(position, kind, prompt, details, accepted) {
  const family = kind === 'word_formation' ? 'word-formation.community-repair' : 'lexical-choice.community-library';
  return Object.freeze({
    position,
    contentRef: Object.freeze({
      catalogId: 'ege-mock-lexis-v1',
      id: `ege-mock-lexis-v1.${family}.${position}`,
      revision: 1,
    }),
    presentation: Object.freeze({
      kind,
      prompt,
      ...details,
      provenance: PROVENANCE,
    }),
    assessment: Object.freeze({
      type: kind === 'lexical_choice' ? 'single_choice' : 'short_text',
      maxScore: 1,
      accepted: Object.freeze(accepted),
      scoreRule: Object.freeze({ kind: 'all_or_nothing' }),
    }),
  });
}

const wordFormation = (position, prompt, base, accepted) => freezeItem(
  position,
  'word_formation',
  prompt,
  { passageId: 'community-repair', base },
  accepted,
);

const lexicalChoice = (position, prompt, options, accepted) => freezeItem(
  position,
  'lexical_choice',
  prompt,
  {
    passageId: 'community-library',
    options: Object.freeze(options.map((id) => Object.freeze({ id, text: id }))),
  },
  accepted,
);

export const AUTHORED_LEXIS_ITEMS = Object.freeze([
  wordFormation(
    25,
    'The neighbourhood repair event began with twelve _____ who offered their time for free.',
    'VOLUNTEER',
    ['volunteers'],
  ),
  wordFormation(
    26,
    'The organisers were surprised by its immediate _____.',
    'SUCCEED',
    ['success'],
  ),
  wordFormation(
    27,
    'Visitors received _____ advice about simple household repairs.',
    'PRACTICE',
    ['practical'],
  ),
  wordFormation(
    28,
    'By the end of the day, there was a clear _____ in the amount of rubbish.',
    'REDUCE',
    ['reduction'],
  ),
  wordFormation(
    29,
    'The team’s greatest _____ was teaching families to repair things themselves.',
    'ACHIEVE',
    ['achievement'],
  ),
  lexicalChoice(
    30,
    'When the old branch library was threatened with closure, local teenagers decided to _____ action.',
    ['take', 'do', 'make', 'have'],
    ['take'],
  ),
  lexicalChoice(
    31,
    'They _____ up with a plan to turn unused rooms into study spaces.',
    ['came', 'went', 'brought', 'held'],
    ['came'],
  ),
  lexicalChoice(
    32,
    'First, they carried _____ a survey of students and local residents.',
    ['out', 'off', 'over', 'away'],
    ['out'],
  ),
  lexicalChoice(
    33,
    'The results showed that students were keen _____ evening opening hours.',
    ['on', 'at', 'for', 'by'],
    ['on'],
  ),
  lexicalChoice(
    34,
    'The volunteers also managed to _____ the attention of local businesses.',
    ['attract', 'pull', 'collect', 'earn'],
    ['attract'],
  ),
  lexicalChoice(
    35,
    'Several companies agreed to _____ new equipment permanently to the media room.',
    ['donate', 'reserve', 'owe', 'borrow'],
    ['donate'],
  ),
  lexicalChoice(
    36,
    'The project proved that young people can make a real _____ to public services.',
    ['difference', 'change', 'contrast', 'distinction'],
    ['difference'],
  ),
]);
