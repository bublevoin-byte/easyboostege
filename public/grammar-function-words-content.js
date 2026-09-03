const TOPIC_IDS = Object.freeze([14, 15, 19]);
const PROVENANCE = 'grammar-2-ticket-06';

function metadata(topicId, errorSkill, confusionPair = null, difficulty = 2, provenance = PROVENANCE) {
  if (!TOPIC_IDS.includes(Number(topicId))) throw new Error('UNKNOWN_ACTIVE_FUNCTION_WORD_TOPIC');
  return { errorSkill, confusionPair, difficulty, provenance };
}

function tagged(topicId, item, errorSkill, confusionPair = null, difficulty = 2) {
  return { ...item, ...metadata(topicId, errorSkill, confusionPair, difficulty) };
}

function diagnostic(errorCode, confusionPair = null) {
  return Object.freeze({ errorCode, confusionPair });
}

function optionDiagnostics(optionCount, answerIndex, errorCode, confusionPair = null) {
  return Object.freeze(Array.from({ length: optionCount }, (_, index) => (
    index === answerIndex ? null : diagnostic(errorCode, confusionPair)
  )));
}

function authoredDiagnostics(...definitions) {
  return Object.freeze(definitions.map((definition) => definition === null
    ? null
    : diagnostic(definition[0], definition[1] ?? null)));
}

function choice(topicId, t, o, a, e, errorSkill, confusionPair = null, difficulty = 2, diagnostics = null) {
  return tagged(topicId, {
    type: 'choice', t, o, a, e,
    diagnostics: diagnostics || optionDiagnostics(o.length, a, errorSkill, confusionPair),
  }, errorSkill, confusionPair, difficulty);
}

function input(topicId, s, b, ans, e, errorSkill, confusionPair = null, difficulty = 2) {
  return tagged(topicId, {
    type: 'input', s, b, ans: Array.isArray(ans) ? ans : [ans], e,
  }, errorSkill, confusionPair, difficulty);
}

function correction(topicId, s, ans, e, errorSkill, confusionPair = null, difficulty = 2) {
  return tagged(topicId, {
    type: 'correction', s, ans: Array.isArray(ans) ? ans : [ans], e,
  }, errorSkill, confusionPair, difficulty);
}

function transform(topicId, s, ans, e, errorSkill, confusionPair = null, difficulty = 2) {
  return tagged(topicId, {
    type: 'transform', s, ans: Array.isArray(ans) ? ans : [ans], e,
  }, errorSkill, confusionPair, difficulty);
}

const P = Object.freeze({
  indefiniteAAn: 'indefinite_a__indefinite_an',
  indefiniteNon: 'indefinite_article__non_indefinite_article',
  zeroIndefinite: 'zero_article__indefinite_article',
  zeroDefinite: 'zero_article__definite_article',
  timeAt: 'time_at__wrong_time_preposition',
  timeIn: 'time_in__wrong_time_preposition',
  timeOn: 'time_on__wrong_time_preposition',
  timeAtIn: 'time_at__time_in',
  timeAtOn: 'time_at__time_on',
  timeInOn: 'time_in__time_on',
  timeNon: 'time_preposition__non_time_preposition',
  dependent: 'dependent_preposition__wrong_preposition',
  becauseSo: 'because__so',
  althoughDespite: 'although__despite',
  howeverBut: 'however__but',
  causeConcession: 'cause_connector__concession_connector',
  resultConcession: 'result_connector__concession_connector',
  clausePhrase: 'clause_connector__phrase_connector',
  subordinatorAdverb: 'subordinator__sentence_adverb',
  targetRelation: 'target_relation__wrong_relation',
});

const legacy = (topicId, errorSkill, confusionPair = null, difficulty = 2) => (
  metadata(topicId, errorSkill, confusionPair, difficulty, 'grammar-1-migrated')
);

export const ACTIVE_FUNCTION_WORDS_LEGACY_META = Object.freeze({
  14: Object.freeze({
    c: Object.freeze([
      legacy(14, 'confusion_pair', P.indefiniteAAn),
      legacy(14, 'confusion_pair', P.zeroDefinite),
      legacy(14, 'confusion_pair', P.zeroDefinite),
      legacy(14, 'confusion_pair', P.zeroDefinite),
      legacy(14, 'confusion_pair', P.zeroDefinite),
    ]),
    f: Object.freeze([]),
  }),
  15: Object.freeze({
    c: Object.freeze([
      legacy(15, 'confusion_pair', P.timeAt),
      legacy(15, 'confusion_pair', P.timeIn),
      legacy(15, 'confusion_pair', P.timeOn),
      legacy(15, 'confusion_pair', P.dependent),
      legacy(15, 'confusion_pair', P.dependent),
    ]),
    f: Object.freeze([]),
  }),
  19: Object.freeze({
    c: Object.freeze([
      legacy(19, 'confusion_pair', P.becauseSo),
      legacy(19, 'confusion_pair', P.althoughDespite),
      legacy(19, 'confusion_pair', P.althoughDespite),
      legacy(19, 'confusion_pair', P.targetRelation),
      legacy(19, 'confusion_pair', P.targetRelation),
    ]),
    f: Object.freeze([]),
  }),
});

export const ACTIVE_FUNCTION_WORDS_LEGACY_CHOICE_DIAGNOSTICS = Object.freeze({
  14: Object.freeze([
    authoredDiagnostics(['confusion_pair', P.indefiniteAAn], null,
      ['confusion_pair', P.indefiniteNon], ['confusion_pair', P.zeroIndefinite]),
    authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
      null, ['confusion_pair', P.zeroDefinite]),
    authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
      null, ['confusion_pair', P.zeroDefinite]),
    authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
      ['confusion_pair', P.zeroDefinite], null),
    authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
      null, ['confusion_pair', P.zeroDefinite]),
  ]),
  15: Object.freeze([
    authoredDiagnostics(null, ['confusion_pair', P.timeAtOn], ['confusion_pair', P.timeAtIn],
      ['confusion_pair', P.timeNon]),
    authoredDiagnostics(['confusion_pair', P.timeAtIn], ['confusion_pair', P.timeInOn], null,
      ['confusion_pair', P.timeNon]),
    authoredDiagnostics(['confusion_pair', P.timeAtOn], null, ['confusion_pair', P.timeInOn],
      ['confusion_pair', P.timeNon]),
    optionDiagnostics(4, 1, 'confusion_pair', P.dependent),
    optionDiagnostics(4, 2, 'confusion_pair', P.dependent),
  ]),
  19: Object.freeze([
    authoredDiagnostics(['confusion_pair', P.becauseSo], null, ['confusion_pair', P.clausePhrase],
      ['confusion_pair', P.subordinatorAdverb]),
    authoredDiagnostics(['confusion_pair', P.causeConcession], ['confusion_pair', P.causeConcession],
      null, ['confusion_pair', P.resultConcession]),
    authoredDiagnostics(['confusion_pair', P.causeConcession], null, ['confusion_pair', P.targetRelation],
      ['confusion_pair', P.causeConcession]),
    optionDiagnostics(4, 2, 'confusion_pair', P.targetRelation),
    optionDiagnostics(4, 1, 'confusion_pair', P.targetRelation),
  ]),
});

export const ACTIVE_FUNCTION_WORDS_LEGACY_OVERRIDES = Object.freeze({
  14: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({
        t: Object.freeze(['The listener has not heard this suggestion before: I have ', ' idea for our project!']),
        e: 'The idea is new to the listener, and idea begins with a vowel sound, so use an.',
      }),
      4: Object.freeze({
        e: 'USA conventionally uses the definite article: the USA.',
      }),
    }),
  }),
  15: Object.freeze({
    c: Object.freeze({
      2: Object.freeze({ o: Object.freeze(['at', 'on', 'in', 'of']) }),
    }),
  }),
  19: Object.freeze({
    c: Object.freeze({
      1: Object.freeze({
        t: Object.freeze(['Kai completed the outdoor test ', ' his severe cold.']),
        o: Object.freeze(['because of', 'owing to', 'despite', 'as a result of']),
        e: 'Completing the test contrasts with his severe cold, so use despite.',
      }),
      2: Object.freeze({
        o: Object.freeze(['Since', 'Although', 'If', 'Because']),
        e: 'Continuing to work despite tiredness is a concession, so use Although.',
      }),
      3: Object.freeze({ o: Object.freeze(['so', 'because', 'but', 'or']) }),
      4: Object.freeze({ o: Object.freeze(['because', 'so', 'although', 'but']) }),
    }),
  }),
});

const ZERO_ARTICLE_ANSWERS = Object.freeze(['—', '-', 'no article', 'zero article']);

export const ACTIVE_FUNCTION_WORDS_BANK = Object.freeze({
  14: Object.freeze({
    c: Object.freeze([
      choice(14, ['We are describing Mina, not identifying her among known people: Mina is ', ' honest person.'],
        ['a', 'an', 'the', '—'], 1,
        'Honest begins with a vowel sound, so use an.', 'confusion_pair', P.indefiniteAAn, 2,
        authoredDiagnostics(['confusion_pair', P.indefiniteAAn], null,
          ['confusion_pair', P.indefiniteNon], ['confusion_pair', P.zeroIndefinite])),
      choice(14, ['Mount Everest is ', ' highest mountain above sea level.'], ['a', 'an', 'the', '—'], 2,
        'A superlative takes the definite article: the highest.', 'confusion_pair', P.zeroDefinite, 2,
        authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
          null, ['confusion_pair', P.zeroDefinite])),
      choice(14, ['My brother plays ', ' chess after school.'], ['a', 'an', 'the', '—'], 3,
        'Games normally take no article: play chess.', 'confusion_pair', P.zeroDefinite, 2,
        authoredDiagnostics(['confusion_pair', P.indefiniteNon], ['confusion_pair', P.indefiniteNon],
          ['confusion_pair', P.zeroDefinite], null)),
    ]),
    f: Object.freeze([
      input(14, 'The listener does not know which solution it is: It was _____ unusual solution. Write the article.',
        'ARTICLE', 'an',
        'This is a first mention, and unusual begins with a vowel sound, so use an.',
        'confusion_pair', P.indefiniteAAn),
      input(14, 'The listener does not know which umbrella it is: She carried _____ umbrella. Write the article.',
        'ARTICLE', 'an',
        'This is a first mention, and umbrella begins with a vowel sound, so use an.',
        'confusion_pair', P.indefiniteAAn),
      input(14, 'This is our ordinary meal, not a scheduled event: We have _____ lunch at noon. Write — if no article is needed.',
        'ARTICLE', ZERO_ARTICLE_ANSWERS,
        'Names of ordinary meals take no article: have lunch.', 'confusion_pair', P.zeroDefinite),
      input(14, 'The children go to _____ school by bus as pupils. Write — if no article is needed for this normal purpose.',
        'ARTICLE', ZERO_ARTICLE_ANSWERS,
        'Go to school as pupils, for its normal purpose, takes no article.', 'confusion_pair', P.zeroDefinite),
      input(14, '_____ moon looked bright above the lake. Write the article.', 'ARTICLE', 'the',
        'The moon is unique in this context, so use the.', 'confusion_pair', P.zeroDefinite),
      input(14, 'Please close _____ door nearest the window. Write the article.', 'ARTICLE', 'the',
        'The description identifies one specific door.', 'confusion_pair', P.zeroDefinite),
      input(14, 'Eva speaks _____ Spanish fluently. Write — if no article is needed.', 'ARTICLE', ZERO_ARTICLE_ANSWERS,
        'Language names normally take no article.', 'confusion_pair', P.zeroDefinite),
      input(14, 'They travelled through _____ Netherlands by train. Write the article.', 'ARTICLE', 'the',
        'The Netherlands conventionally takes the definite article.', 'confusion_pair', P.zeroDefinite),
    ]),
    correction: Object.freeze([
      correction(14, 'Исправьте артикль: He is a honest guide.', 'He is an honest guide.',
        'Honest begins with a vowel sound.', 'confusion_pair', P.indefiniteAAn),
      correction(14, 'Исправьте артикль: She waited for a hour.', 'She waited for an hour.',
        'Hour begins with a vowel sound because h is silent.', 'confusion_pair', P.indefiniteAAn),
      correction(14, 'Это ordinary meal, not a scheduled event. Уберите лишний артикль: We had a breakfast at seven.',
        'We had breakfast at seven.',
        'Ordinary meals take no article.', 'confusion_pair', P.zeroIndefinite),
      correction(14, 'Уберите лишний неопределённый артикль перед ordinary meal: We ate a lunch at noon.',
        'We ate lunch at noon.',
        'An ordinary meal takes no article.', 'confusion_pair', P.zeroIndefinite),
      correction(14, 'Добавьте нужный артикль: Sun was already setting.', 'The sun was already setting.',
        'The sun is unique, so it takes the.', 'confusion_pair', P.zeroDefinite),
      correction(14, 'Добавьте нужный артикль: This is most useful map here.', 'This is the most useful map here.',
        'A superlative takes the.', 'confusion_pair', P.zeroDefinite),
      correction(14, 'Уберите лишний артикль: Nora speaks the Italian at home.', 'Nora speaks Italian at home.',
        'Language names normally take no article.', 'confusion_pair', P.zeroDefinite),
      correction(14, 'Добавьте нужный артикль: They moved to United Kingdom.', 'They moved to the United Kingdom.',
        'The United Kingdom conventionally takes the.', 'confusion_pair', P.zeroDefinite),
    ]),
    transform: Object.freeze([
      transform(14, 'Замените A на AN и перепишите: It was a unusual event.', 'It was an unusual event.',
        'Unusual begins with a vowel sound.', 'confusion_pair', P.indefiniteAAn),
      transform(14, 'Замените A на AN и перепишите: Leo bought a hourglass.', 'Leo bought an hourglass.',
        'Hourglass begins with a vowel sound because h is silent.', 'confusion_pair', P.indefiniteAAn),
      transform(14, 'Перепишите без артикля перед приёмом пищи: We ate the dinner at six.', 'We ate dinner at six.',
        'An ordinary meal takes no article.', 'confusion_pair', P.zeroDefinite),
      transform(14, 'Перепишите без артикля перед языком: She studies the German online.', 'She studies German online.',
        'Language names normally take no article.', 'confusion_pair', P.zeroDefinite),
      transform(14, 'Добавьте THE перед уникальным объектом и перепишите: Earth moves around the sun.',
        'The Earth moves around the sun.',
        'Earth is unique in this context.', 'confusion_pair', P.zeroDefinite),
      transform(14, 'Добавьте THE перед превосходной степенью и перепишите: It was hardest test of the term.',
        'It was the hardest test of the term.',
        'A superlative takes the definite article.', 'confusion_pair', P.zeroDefinite),
      transform(14, 'Перепишите без артикля перед игрой: They play the volleyball on Fridays.',
        'They play volleyball on Fridays.',
        'Games normally take no article.', 'confusion_pair', P.zeroDefinite),
      transform(14, 'Добавьте THE к названию страны и перепишите: She lives in United States.',
        'She lives in the United States.',
        'The United States conventionally takes the.', 'confusion_pair', P.zeroDefinite),
    ]),
  }),
  15: Object.freeze({
    c: Object.freeze([
      choice(15, ['The final begins ', ' noon.'], ['at', 'on', 'in', 'of'], 0,
        'A precise clock time takes at.', 'confusion_pair', P.timeAt, 2,
        authoredDiagnostics(null, ['confusion_pair', P.timeAtOn], ['confusion_pair', P.timeAtIn],
          ['confusion_pair', P.timeNon])),
      choice(15, ['Our course ends ', ' December, sometime during that month.'], ['at', 'on', 'in', 'of'], 2,
        'A month used as a time period takes in.', 'confusion_pair', P.timeIn, 2,
        authoredDiagnostics(['confusion_pair', P.timeAtIn], ['confusion_pair', P.timeInOn], null,
          ['confusion_pair', P.timeNon])),
      choice(15, ['The museum is closed ', ' Tuesdays.'], ['at', 'on', 'in', 'of'], 1,
        'A day of the week takes on.', 'confusion_pair', P.timeOn, 2,
        authoredDiagnostics(['confusion_pair', P.timeAtOn], null, ['confusion_pair', P.timeInOn],
          ['confusion_pair', P.timeNon])),
    ]),
    f: Object.freeze([
      input(15, 'The doors open _____ 8:30 exactly, not earlier, later, or approximately. Supply the preposition.', 'PREPOSITION', 'at',
        'A precise clock time takes at.', 'confusion_pair', P.timeAt),
      input(15, 'The streets are quiet _____ night. Complete the specific rule-card expression with NIGHT, not another literary time expression.', 'PREPOSITION', 'at',
        'The fixed time expression is at night.', 'confusion_pair', P.timeAt),
      input(15, 'The match takes place _____ Saturday; this names the scheduled day when it actually happens.', 'PREPOSITION', 'on',
        'A day of the week takes on.', 'confusion_pair', P.timeOn),
      input(15, 'The exam takes place _____ the fifth of June; this names the scheduled date when it actually happens.', 'PREPOSITION', 'on',
        'A specific date takes on.', 'confusion_pair', P.timeOn),
      input(15, 'The school opened _____ 1998; its exact date lies somewhere inside that calendar year.', 'PREPOSITION', ['in', 'during'],
        'A year normally takes in; during is also grammatical when 1998 is treated as a period.',
        'confusion_pair', P.timeIn),
      input(15, 'We usually travel _____ summer, at one or more times inside the season, not across the whole period.', 'PREPOSITION', ['in', 'during', 'over'],
        'A season normally takes in; during and over are also grammatical when summer is treated as a period.',
        'confusion_pair', P.timeIn),
      input(15, 'Please listen _____ the guide\'s spoken instructions. Supply the verb\'s fixed dependent preposition for the meaning “pay attention”.', 'PREPOSITION', 'to',
        'The dependent preposition is listen to.', 'confusion_pair', P.dependent),
      input(15, 'They are responsible _____ maintaining the equipment: their duty is to maintain it. Supply the dependent preposition.', 'PREPOSITION', 'for',
        'The dependent preposition is responsible for.', 'confusion_pair', P.dependent),
    ]),
    correction: Object.freeze([
      correction(15, 'Исправьте предлог времени: The film starts in seven.', 'The film starts at seven.',
        'A precise clock time takes at.', 'confusion_pair', P.timeAt),
      correction(15, 'Исправьте устойчивое выражение: The streets are empty in night.', 'The streets are empty at night.',
        'The fixed expression is at night.', 'confusion_pair', P.timeAt),
      correction(15, 'Исправьте предлог дня: We meet at Friday.', 'We meet on Friday.',
        'A day of the week takes on.', 'confusion_pair', P.timeOn),
      correction(15, 'Исправьте предлог даты: The test is in 12 May.', ['The test is on 12 May.', 'The test is on the 12th of May.'],
        'A specific date takes on.', 'confusion_pair', P.timeOn),
      correction(15, 'Исправьте предлог месяца. Используйте IN: The festival is on August.', 'The festival is in August.',
        'A month takes in.', 'confusion_pair', P.timeIn),
      correction(15, 'Исправьте предлог года. Используйте IN: The bridge opened at 2010.', 'The bridge opened in 2010.',
        'A year takes in.', 'confusion_pair', P.timeIn),
      correction(15, 'Исправьте устойчивый предлог: We listened the guide carefully.', 'We listened to the guide carefully.',
        'The verb listen takes to.', 'confusion_pair', P.dependent),
      correction(15, 'Исправьте устойчивый предлог. Используйте ON: Success depends from regular practice.',
        'Success depends on regular practice.',
        'The verb depend takes on.', 'confusion_pair', P.dependent),
    ]),
    transform: Object.freeze([
      transform(15, 'Добавьте AT и перепишите: The lesson begins 9:15.', 'The lesson begins at 9:15.',
        'A precise clock time takes at.', 'confusion_pair', P.timeAt),
      transform(15, 'Добавьте AT в устойчивое выражение и перепишите: Owls hunt night.', 'Owls hunt at night.',
        'The fixed expression is at night.', 'confusion_pair', P.timeAt),
      transform(15, 'Добавьте ON и перепишите: We leave Monday morning.', 'We leave on Monday morning.',
        'A named day takes on.', 'confusion_pair', P.timeOn),
      transform(15, 'Добавьте ON и перепишите: The office closes 31 December.', 'The office closes on 31 December.',
        'A specific date takes on.', 'confusion_pair', P.timeOn),
      transform(15, 'Добавьте IN и перепишите: The trees bloom spring.', 'The trees bloom in spring.',
        'A season takes in.', 'confusion_pair', P.timeIn),
      transform(15, 'Добавьте IN и перепишите: The company started 2005.', 'The company started in 2005.',
        'A year takes in.', 'confusion_pair', P.timeIn),
      transform(15, 'Добавьте устойчивый предлог TO и перепишите: Please listen this recording.',
        'Please listen to this recording.',
        'The verb listen takes to.', 'confusion_pair', P.dependent),
      transform(15, 'Добавьте устойчивый предлог FOR и перепишите: We waited the results all morning.',
        'We waited for the results all morning.',
        'The verb wait takes for.', 'confusion_pair', P.dependent),
    ]),
  }),
  19: Object.freeze({
    c: Object.freeze([
      choice(19, ['The path was closed ', ' the river had flooded.'], ['so', 'because', 'despite', 'however'], 1,
        'The second clause gives the reason, so use because.', 'confusion_pair', P.becauseSo, 2,
        authoredDiagnostics(['confusion_pair', P.becauseSo], null, ['confusion_pair', P.clausePhrase],
          ['confusion_pair', P.subordinatorAdverb])),
      choice(19, ['', ' his nervousness, Kai answered every question.'],
        ['Because of', 'Owing to', 'Despite', 'As a result of'], 2,
        'Answering every question despite nervousness is a concession.', 'confusion_pair', P.althoughDespite, 2,
        authoredDiagnostics(['confusion_pair', P.causeConcession], ['confusion_pair', P.causeConcession],
          null, ['confusion_pair', P.resultConcession])),
      choice(19, ['', ' the task was difficult, everyone finished it.'], ['Since', 'Although', 'If', 'Because'], 1,
        'Finishing despite the difficulty is a concession, so use Although.', 'confusion_pair', P.althoughDespite, 2,
        authoredDiagnostics(['confusion_pair', P.causeConcession], null, ['confusion_pair', P.targetRelation],
          ['confusion_pair', P.causeConcession])),
    ]),
    f: Object.freeze([
      input(19, 'We stayed inside _____ the storm was getting worse. Supply a one-word subordinating cause connector before the full clause.', 'CONNECTOR', ['because', 'since', 'as'],
        'The second clause gives the reason.', 'confusion_pair', P.becauseSo),
      input(19, 'The storm was getting worse, _____ we stayed inside. Supply the result conjunction taught in this topic’s rule card; it may be preceded by AND.',
        'CONNECTOR', ['so', 'and so', 'and therefore'],
        'The second clause gives the result; so, and so and and therefore fit this relation.',
        'confusion_pair', P.becauseSo),
      input(19, '_____ she felt tired, she completed the report. Supply a concessive subordinator that asserts she actually felt tired, followed by the full clause.', 'CONNECTOR', ['although', 'though', 'even though', 'while', 'whereas', 'whilst'],
        'Although, though, even though, concessive while, whereas and whilst are followed by a full clause.', 'confusion_pair', P.althoughDespite),
      input(19, '_____ her tiredness, she completed the report. Supply one of the concessive prepositions contrasted with a clause subordinator on this topic’s rule card.', 'CONNECTOR', ['despite', 'in spite of'],
        'Despite or in spite of is followed by a noun phrase.', 'confusion_pair', P.althoughDespite),
      input(19, 'The route was longer. _____, it was much safer. Supply a single-word contrast adverb for the safer route despite being longer, at the start of the separate sentence.', 'CONNECTOR', ['however', 'nevertheless', 'nonetheless', 'regardless', 'still', 'yet'],
        'However, nevertheless, nonetheless, regardless, still and yet can introduce the contrasting independent sentence.', 'confusion_pair', P.howeverBut),
      input(19, 'The route was longer, _____ it was much safer. Supply a coordinating conjunction of contrast: use one word, or AND followed by another coordinating conjunction.',
        'CONNECTOR', ['but', 'yet', 'and yet'],
        'Both single-word forms (but, yet) and the multiword form and yet join two contrasting clauses.',
        'confusion_pair', P.howeverBut),
      input(19, 'Lena prefers tea, _____ Omar prefers coffee. Supply a conjunction that contrasts the two parallel facts inside one sentence; do not use an independent-sentence adverb.',
        'CONNECTOR', ['while', 'whilst', 'whereas', 'although', 'though', 'even though', 'but', 'yet', 'and yet'],
        'While, whilst, whereas, although, though, even though, but, yet and and yet can contrast the two parallel facts.',
        'confusion_pair', P.targetRelation),
      input(19, 'The alarm rang, _____ everyone left the building. Supply the result conjunction taught in this topic’s rule card; it may be preceded by AND.',
        'CONNECTOR', ['so', 'and so', 'and therefore'],
        'The result may be introduced by so, and so or and therefore.', 'confusion_pair', P.targetRelation),
    ]),
    correction: Object.freeze([
      correction(19, 'Замените BECAUSE на SO и перепишите: We left early, because we caught the first train.',
        'We left early, so we caught the first train.',
        'The second clause is the result, so use so.', 'confusion_pair', P.becauseSo),
      correction(19, 'Замените SO на BECAUSE и перепишите: We drove slowly, so the road was icy.',
        ['We drove slowly because the road was icy.', 'Because the road was icy, we drove slowly.'],
        'The icy road is the reason, so use because.', 'confusion_pair', P.becauseSo),
      correction(19, 'Замените DESPITE на ALTHOUGH и перепишите: Despite it was raining, we went out.',
        'Although it was raining, we went out.',
        'Although is followed by a clause.', 'confusion_pair', P.althoughDespite),
      correction(19, 'Замените ALTHOUGH на DESPITE или IN SPITE OF и перепишите: Although the heavy rain, the match continued.',
        ['Despite the heavy rain, the match continued.', 'In spite of the heavy rain, the match continued.'],
        'Despite or in spite of is followed by a noun phrase.', 'confusion_pair', P.althoughDespite),
      correction(19, 'Исправьте пунктуацию связки: The shop was closed, however we waited outside.',
        ['The shop was closed; however, we waited outside.', 'The shop was closed. However, we waited outside.'],
        'However connects independent sentences and is set off by punctuation.', 'confusion_pair', P.howeverBut),
      correction(19, 'Замените HOWEVER на BUT и перепишите: The shop was closed, however we found another one.',
        'The shop was closed, but we found another one.',
        'But joins the two clauses inside one sentence.', 'confusion_pair', P.howeverBut),
      correction(19, 'Замените SO на WHILE или BUT и перепишите: Mira likes cities, so Dan prefers the countryside.',
        ['Mira likes cities, while Dan prefers the countryside.', 'Mira likes cities, but Dan prefers the countryside.'],
        'The clauses contrast rather than show a result.', 'confusion_pair', P.targetRelation),
      correction(19, 'Замените WHILE на SO и перепишите: The bus was cancelled, while we took a taxi.',
        'The bus was cancelled, so we took a taxi.',
        'Taking a taxi is the result, so use so.', 'confusion_pair', P.targetRelation),
    ]),
    transform: Object.freeze([
      transform(19, 'Соедините с BECAUSE. Начните: We stayed home ... Исходное: It was snowing. We stayed home.',
        'We stayed home because it was snowing.',
        'Because introduces the reason clause.', 'confusion_pair', P.becauseSo),
      transform(19, 'Соедините с SO. Начните: The road was icy, ... Исходное: The road was icy. We drove slowly.',
        'The road was icy, so we drove slowly.',
        'So introduces the result clause.', 'confusion_pair', P.becauseSo),
      transform(19, 'Замените DESPITE на ALTHOUGH. Начните: Although it was raining, ... Исходное: Despite the rain, the game continued.',
        'Although it was raining, the game continued.',
        'Although requires a full clause.', 'confusion_pair', P.althoughDespite),
      transform(19, 'Замените ALTHOUGH на DESPITE. Начните: Despite being tired, ... Исходное: Although she was tired, she kept working.',
        'Despite being tired, she kept working.',
        'Despite takes a noun phrase or gerund.', 'confusion_pair', P.althoughDespite),
      transform(19, 'Разделите предложения связкой HOWEVER. Начните: The room was small. However, ... Исходное: The room was small but comfortable.',
        'The room was small. However, it was comfortable.',
        'However begins the contrasting second sentence and takes a comma.', 'confusion_pair', P.howeverBut),
      transform(19, 'Объедините предложения союзом BUT. Используйте две полные части и начните: The route was long, but it ... Исходное: The route was long. It was safe.',
        'The route was long, but it was safe.',
        'But joins contrasting clauses inside one sentence.', 'confusion_pair', P.howeverBut),
      transform(19, 'Соедините факты союзом WHILE. Начните: Ava works at home, ... Исходное: Ava works at home. Ben works in an office.',
        'Ava works at home, while Ben works in an office.',
        'While contrasts two parallel facts.', 'confusion_pair', P.targetRelation),
      transform(19, 'Соедините причину и результат союзом SO. Начните: The lift was broken, ... Исходное: The lift was broken. We used the stairs.',
        'The lift was broken, so we used the stairs.',
        'So introduces the result.', 'confusion_pair', P.targetRelation),
    ]),
  }),
});

export const ACTIVE_FUNCTION_WORDS_TRANSFER_PAIR_PLANS = Object.freeze({
  14: Object.freeze({
    c: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]),
    f: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  15: Object.freeze({
    c: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]),
    f: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  19: Object.freeze({
    c: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]),
    f: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
});
