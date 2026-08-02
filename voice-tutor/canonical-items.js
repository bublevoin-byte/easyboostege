const ITEMS = Object.freeze({
  'grammar.past-simple.last-summer': Object.freeze({
    id: 'grammar.past-simple.last-summer',
    revision: 1,
    module: 'grammar',
    prompt: 'Last summer Kate and her brother _____ to St Petersburg. (GO)',
    reference: Object.freeze(['went']),
    errorType: 'incorrect_form',
    skill: Object.freeze({ id: 'ege.grammar.past_simple', label: 'Past Simple: неправильные глаголы' }),
    rule: Object.freeze({
      id: 'grammar.past-simple.v1',
      revision: 1,
      title: 'Past Simple с маркером законченного прошлого',
      explanation: 'После last summer нужен Past Simple. У неправильного глагола go форма прошедшего времени — went.',
      examples: Object.freeze(['I went to school yesterday.', 'We bought the tickets last week.']),
    }),
    microCheck: Object.freeze({ id: 'grammar.past-simple.micro.v1', prompt: 'Yesterday my sister _____ to the library. (GO)', answers: Object.freeze(['went']) }),
    transferTask: Object.freeze({ id: 'grammar.past-simple.transfer.v1', prompt: 'Last week we _____ new books for class. (BUY)', answers: Object.freeze(['bought']) }),
  }),
  'vocabulary.relationship.meaning': Object.freeze({
    id: 'vocabulary.relationship.meaning',
    revision: 1,
    module: 'vocabulary',
    prompt: 'Выбери точное значение слова relationship.',
    reference: Object.freeze(['отношения']),
    errorType: 'incorrect_meaning',
    skill: Object.freeze({ id: 'ege.vocabulary.meaning_in_context', label: 'Значение слова в контексте' }),
    rule: Object.freeze({
      id: 'vocabulary.relationship.v1',
      revision: 1,
      title: 'Relationship — отношения или связь',
      explanation: 'Relationship называет отношения или связь между людьми и понятиями; это не отдельный родственник.',
      examples: Object.freeze(['They have a close relationship.', 'There is a clear relationship between sleep and memory.']),
    }),
    microCheck: Object.freeze({ id: 'vocabulary.relationship.micro.v1', prompt: 'Как перевести relationship в сочетании a close relationship?', answers: Object.freeze(['отношения', 'близкие отношения']) }),
    transferTask: Object.freeze({ id: 'vocabulary.relationship.transfer.v1', prompt: 'Complete: Trust is important in every _____.', answers: Object.freeze(['relationship']) }),
  }),
});

export function getCanonicalVoiceTutorItem(itemId) {
  return ITEMS[String(itemId || '')] || null;
}
