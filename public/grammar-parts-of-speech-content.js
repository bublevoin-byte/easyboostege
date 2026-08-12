const TOPIC_IDS = Object.freeze([10, 11, 12, 16, 17, 20]);

function metadata(topicId, errorSkill, confusionPair = null, difficulty = 2, provenance = 'grammar-2-ticket-05') {
  if (!TOPIC_IDS.includes(Number(topicId))) throw new Error('UNKNOWN_ACTIVE_PARTS_OF_SPEECH_TOPIC');
  return { errorSkill, confusionPair, difficulty, provenance };
}

function tagged(topicId, item, errorSkill, confusionPair = null, difficulty = 2) {
  return { ...item, ...metadata(topicId, errorSkill, confusionPair, difficulty) };
}

function diagnostic(errorCode, confusionPair = null) {
  return Object.freeze({ errorCode, confusionPair });
}

function choice(topicId, t, o, a, e, errorSkill, confusionPair, difficulty, diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length !== o.length || diagnostics[a] !== null
    || diagnostics.some((entry, index) => index !== a && entry === null)) {
    throw new Error('INVALID_ACTIVE_PARTS_OF_SPEECH_CHOICE_DIAGNOSTICS');
  }
  return tagged(topicId, { type: 'choice', t, o, a, e, diagnostics }, errorSkill, confusionPair, difficulty);
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
  comparativeForm: 'comparative_form__superlative_form',
  adjectiveLength: 'short_adjective__long_adjective',
  irregularComparison: 'irregular_comparative__regular_comparative',
  positiveComparison: 'positive_degree__comparative_degree',
  littleScale: 'little_less__least',
  possessiveForm: 'possessive_adjective__possessive_pronoun',
  pronounCase: 'subject_pronoun__object_pronoun',
  reflexiveForm: 'reflexive_pronoun__object_pronoun',
  someAny: 'some__any',
  itsForm: 'possessive_its__it_is_contraction',
  cardinalOrdinal: 'cardinal_number__ordinal_number',
  exactApproximate: 'exact_hundred__hundreds_of',
  ordinalSpelling: 'ordinal_spelling__cardinal_spelling',
  regularIrregularPlural: 'regular_plural__irregular_plural',
  singularPlural: 'singular_form__plural_form',
  invariantPlural: 'changed_plural__invariant_plural',
  causeFeeling: 'cause_adjective__feeling_adjective',
  adjectiveAdverb: 'adjective__adverb',
  goodWell: 'good__well',
  hardHardly: 'hard__hardly',
  flatAdverb: 'flat_adverb__ly_adverb',
});

const legacy = (topicId, errorSkill, confusionPair = null, difficulty = 2) => (
  metadata(topicId, errorSkill, confusionPair, difficulty, 'grammar-1-migrated')
);
const repeat = (length, value) => Object.freeze(Array.from({ length }, () => value));
const optionDiagnostics = (...definitions) => Object.freeze(
  definitions.map((definition) => definition === null ? null : diagnostic(definition[0], definition[1] ?? null)),
);

export const ACTIVE_PARTS_OF_SPEECH_LEGACY_META = Object.freeze({
  10: Object.freeze({
    c: Object.freeze([
      legacy(10, 'construction_choice', P.adjectiveLength),
      legacy(10, 'word_or_verb_form', P.irregularComparison),
      legacy(10, 'construction_choice', P.adjectiveLength),
      legacy(10, 'word_or_verb_form', P.irregularComparison),
      legacy(10, 'construction_choice', P.positiveComparison),
    ]),
    f: Object.freeze([
      legacy(10, 'construction_choice', P.comparativeForm),
      legacy(10, 'word_or_verb_form', P.irregularComparison),
      legacy(10, 'construction_choice', P.comparativeForm),
      legacy(10, 'word_or_verb_form'),
      legacy(10, 'word_or_verb_form', P.irregularComparison),
    ]),
  }),
  11: Object.freeze({
    c: Object.freeze([
      legacy(11, 'construction_choice', P.possessiveForm),
      legacy(11, 'construction_choice', P.possessiveForm),
      legacy(11, 'word_or_verb_form', P.reflexiveForm),
      legacy(11, 'construction_choice', P.someAny),
      legacy(11, 'construction_choice', P.someAny),
    ]),
    f: Object.freeze([
      legacy(11, 'construction_choice', P.possessiveForm),
      legacy(11, 'construction_choice', P.possessiveForm),
      legacy(11, 'word_or_verb_form', P.reflexiveForm),
      legacy(11, 'word_or_verb_form', P.itsForm),
      legacy(11, 'word_or_verb_form', P.reflexiveForm),
    ]),
  }),
  12: Object.freeze({
    c: Object.freeze([
      legacy(12, 'construction_choice', P.cardinalOrdinal),
      legacy(12, 'construction_choice', P.cardinalOrdinal),
      legacy(12, 'construction_choice', P.cardinalOrdinal),
      legacy(12, 'construction_choice', P.cardinalOrdinal),
      legacy(12, 'construction_choice', P.exactApproximate),
    ]),
    f: repeat(5, legacy(12, 'word_or_verb_form', P.ordinalSpelling)),
  }),
  16: Object.freeze({
    c: Object.freeze([
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.invariantPlural),
    ]),
    f: Object.freeze([
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
      legacy(16, 'word_or_verb_form', P.regularIrregularPlural),
    ]),
  }),
  17: Object.freeze({
    c: repeat(5, legacy(17, 'confusion_pair', P.causeFeeling)),
    f: repeat(5, legacy(17, 'confusion_pair', P.causeFeeling)),
  }),
  20: Object.freeze({
    c: Object.freeze([
      legacy(20, 'confusion_pair', P.goodWell),
      legacy(20, 'confusion_pair', P.flatAdverb),
      legacy(20, 'construction_choice', P.adjectiveAdverb),
      legacy(20, 'confusion_pair', P.hardHardly),
      legacy(20, 'confusion_pair', P.hardHardly),
    ]),
    f: Object.freeze([
      legacy(20, 'word_or_verb_form', P.adjectiveAdverb),
      legacy(20, 'word_or_verb_form', P.adjectiveAdverb),
      legacy(20, 'word_or_verb_form', P.adjectiveAdverb),
      legacy(20, 'confusion_pair', P.goodWell),
      legacy(20, 'word_or_verb_form', P.adjectiveAdverb),
    ]),
  }),
});

export const ACTIVE_PARTS_OF_SPEECH_LEGACY_CHOICE_DIAGNOSTICS = Object.freeze({
  10: Object.freeze([
    optionDiagnostics(['word_or_verb_form'], null, ['confusion_pair', P.comparativeForm], ['construction_choice', P.adjectiveLength]),
    optionDiagnostics(['word_or_verb_form', P.irregularComparison], ['confusion_pair', P.comparativeForm], null, ['word_or_verb_form', P.irregularComparison]),
    optionDiagnostics(null, ['confusion_pair', P.comparativeForm], ['construction_choice', P.adjectiveLength], ['word_or_verb_form']),
    optionDiagnostics(['word_or_verb_form', P.irregularComparison], null, ['confusion_pair', P.comparativeForm], ['word_or_verb_form', P.irregularComparison]),
    optionDiagnostics(null, ['confusion_pair', P.positiveComparison], ['confusion_pair', P.comparativeForm], ['construction_choice', P.adjectiveLength]),
  ]),
  11: Object.freeze([
    optionDiagnostics(null, ['construction_choice', P.possessiveForm], ['word_or_verb_form', P.pronounCase], ['word_or_verb_form', P.reflexiveForm]),
    optionDiagnostics(['construction_choice', P.possessiveForm], null, ['word_or_verb_form', P.pronounCase], ['word_or_verb_form', P.reflexiveForm]),
    optionDiagnostics(['word_or_verb_form', P.pronounCase], ['construction_choice', P.possessiveForm], null, ['construction_choice', P.possessiveForm]),
    optionDiagnostics(null, ['construction_choice', P.someAny], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['construction_choice', P.someAny], null, ['word_or_verb_form'], ['word_or_verb_form']),
  ]),
  12: Object.freeze([
    optionDiagnostics(['construction_choice', P.cardinalOrdinal], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(null, ['construction_choice', P.cardinalOrdinal], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(null, ['construction_choice', P.cardinalOrdinal], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(null, ['construction_choice', P.cardinalOrdinal], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['construction_choice', P.exactApproximate], null, ['construction_choice', P.exactApproximate], ['construction_choice', P.cardinalOrdinal]),
  ]),
  16: Object.freeze([
    optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['confusion_pair', P.singularPlural], ['word_or_verb_form', P.regularIrregularPlural]),
    optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['confusion_pair', P.singularPlural], ['word_or_verb_form', P.regularIrregularPlural]),
    optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['confusion_pair', P.singularPlural], ['word_or_verb_form', P.regularIrregularPlural]),
    optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['word_or_verb_form', P.regularIrregularPlural], ['confusion_pair', P.singularPlural]),
    optionDiagnostics(['word_or_verb_form', P.invariantPlural], null, ['word_or_verb_form'], ['word_or_verb_form', P.invariantPlural]),
  ]),
  17: Object.freeze([
    optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form']),
  ]),
  20: Object.freeze([
    optionDiagnostics(['confusion_pair', P.goodWell], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(null, ['confusion_pair', P.flatAdverb], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['construction_choice', P.adjectiveAdverb], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.hardHardly], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(null, ['confusion_pair', P.hardHardly], ['word_or_verb_form'], ['word_or_verb_form']),
  ]),
});

export const ACTIVE_PARTS_OF_SPEECH_LEGACY_OVERRIDES = Object.freeze({
  10: Object.freeze({
    c: Object.freeze({
      3: Object.freeze({ t: Object.freeze(['The weather is getting ', ' than it was this morning.']) }),
    }),
  }),
  11: Object.freeze({
    c: Object.freeze({
      4: Object.freeze({ t: Object.freeze(['In a neutral information question with no expected answer: Is there ', ' juice left?']) }),
    }),
  }),
  16: Object.freeze({
    c: Object.freeze({
      2: Object.freeze({ t: Object.freeze(['Both my ', ' hurt after the long walk.']) }),
      3: Object.freeze({ t: Object.freeze(['Use the ordinary everyday plural of person: Some ', ' prefer quiet rooms.']) }),
    }),
    f: Object.freeze({
      2: Object.freeze({ s: 'Both my _____ (TOOTH) hurt after too many sweets.' }),
    }),
  }),
});

export const ACTIVE_PARTS_OF_SPEECH_BANK = Object.freeze({
  10: Object.freeze({
    c: Object.freeze([
      choice(10, ['This exercise is not as ', ' as the previous one.'], ['difficult', 'more difficult', 'most difficult', 'difficulter'], 0,
        'The as ... as frame requires the positive degree difficult.', 'construction_choice', P.positiveComparison, 2,
        optionDiagnostics(null, ['confusion_pair', P.positiveComparison], ['confusion_pair', P.comparativeForm], ['construction_choice', P.adjectiveLength])),
      choice(10, ['For additional details, read ', ' in the guide.'], ['farther', 'further', 'farthest', 'more far'], 1,
        'Further means additional or more advanced; farther is reserved here for physical distance.', 'word_or_verb_form', P.irregularComparison, 3,
        optionDiagnostics(['word_or_verb_form', P.irregularComparison], null, ['confusion_pair', P.comparativeForm], ['word_or_verb_form', P.irregularComparison])),
      choice(10, ['Of all three plans, this is the ', ' expensive.'], ['less', 'least', 'little', 'lesser'], 1,
        'A comparison within a group of three requires the superlative least.', 'word_or_verb_form', P.irregularComparison, 2,
        optionDiagnostics(['confusion_pair', P.comparativeForm], null, ['word_or_verb_form', P.irregularComparison], ['word_or_verb_form', P.irregularComparison])),
    ]),
    f: Object.freeze([
      input(10, 'We have _____ (LITTLE) time than yesterday.', 'LITTLE', 'less',
        'The comparative form of little for amount is less.', 'confusion_pair', P.littleScale),
      input(10, 'The northern station is _____ (FAR) from here than the central one.', 'FAR', ['further', 'farther'],
        'Both further and farther are accepted for greater physical distance.', 'word_or_verb_form', null, 3),
      input(10, 'This route causes the _____ (LITTLE) delay of the four options.', 'LITTLE', 'least',
        'A comparison among four options requires the superlative least.', 'confusion_pair', P.littleScale),
    ]),
    correction: Object.freeze([
      correction(10, 'Исправьте форму: This test is more easy than the last one.', 'This test is easier than the last one.',
        'A short adjective takes -er.', 'construction_choice', P.adjectiveLength),
      correction(10, 'Исправьте форму: The blue sofa is comfortabler than the grey one.', 'The blue sofa is more comfortable than the grey one.',
        'A long adjective uses more.', 'construction_choice', P.adjectiveLength),
      correction(10, 'Исправьте форму: Her result is gooder than mine.', 'Her result is better than mine.',
        'Good has the irregular comparative better.', 'word_or_verb_form', P.irregularComparison),
      correction(10, 'Исправьте форму: That was the baddest storm this year.', 'That was the worst storm this year.',
        'Bad has the irregular superlative worst.', 'word_or_verb_form', P.irregularComparison),
      correction(10, 'Исправьте конструкцию: The new hall is not as larger as the old one.', 'The new hall is not as large as the old one.',
        'As ... as requires the positive degree.', 'construction_choice', P.positiveComparison),
      correction(10, 'Исправьте конструкцию: This map is as more useful as that one.', 'This map is as useful as that one.',
        'Do not use more inside as ... as.', 'construction_choice', P.positiveComparison),
      correction(10, 'Исправьте степень: This is the less expensive of the three tickets.', 'This is the least expensive of the three tickets.',
        'A group of three requires the superlative least.', 'confusion_pair', P.littleScale),
      correction(10, 'Исправьте степень: We had the least time than yesterday.', 'We had less time than yesterday.',
        'Than requires the comparative less.', 'confusion_pair', P.littleScale),
    ]),
    transform: Object.freeze([
      transform(10, 'Сравните два маршрута, используя SHORT: Route A is 5 km; route B is 8 km. Начните: Route A ...',
        'Route A is shorter than route B.', 'A short adjective takes -er + than.', 'construction_choice', P.adjectiveLength),
      transform(10, 'Сравните оценку интересности двух лекций, используя INTERESTING: Lecture A получила более высокую оценку за интересность, чем lecture B. Начните: Lecture A ...',
        'Lecture A is more interesting than lecture B.', 'A long adjective uses more + adjective.', 'construction_choice', P.adjectiveLength),
      transform(10, 'Перефразируйте с BETTER: My result is good, but Leo’s result is higher. Начните: Leo’s result ...',
        ["Leo's result is better than mine.", 'Leo’s result is better than mine.',
          "Leo's result is better than my result.", 'Leo’s result is better than my result.'],
        'The irregular comparative of good is better.', 'word_or_verb_form', P.irregularComparison),
      transform(10, 'Перефразируйте с WORST: No hotel in the list is as bad as Hotel C. Начните: Hotel C is the worst ... После worst разрешены только: hotel on the list; on the list; hotel in the list; in the list; of the hotels in the list.',
        ['Hotel C is the worst hotel on the list.', 'Hotel C is the worst on the list.',
          'Hotel C is the worst hotel in the list.', 'Hotel C is the worst in the list.',
          'Hotel C is the worst of the hotels in the list.'],
        'The irregular superlative of bad is worst.', 'word_or_verb_form', P.irregularComparison),
      transform(10, 'Объедините через as ... as: The two boxes have equal weight. Используйте буквальную конструкцию: The first box is as heavy as ... Закончите только: the second box; the second one; the second; the other.',
        ['The first box is as heavy as the second box.', 'The first box is as heavy as the second one.',
          'The first box is as heavy as the second.', 'The first box is as heavy as the other.'],
        'Equal degree uses as + positive adjective + as.', 'construction_choice', P.positiveComparison),
      transform(10, 'Объедините через not as ... as: Plan A is less practical than plan B. Начните: Plan A ...',
        'Plan A is not as practical as plan B.', 'Lower degree can be expressed with not as ... as.', 'construction_choice', P.positiveComparison),
      transform(10, 'Выберите LESS и перепишите: Today we have a smaller amount of free time than yesterday.',
        'Today we have less free time than yesterday.', 'Less is the comparative form for a smaller amount.', 'confusion_pair', P.littleScale),
      transform(10, 'Выберите LEAST и перепишите. Начните: Team D has ... и закончите только: of the four teams; among the four teams; out of the four teams. Исходный смысл: Of the four teams, Team D has the smallest amount of experience.',
        ['Team D has the least experience of the four teams.', 'Team D has the least experience among the four teams.',
          'Team D has the least experience out of the four teams.'],
        'Least is the superlative form for the smallest amount.', 'confusion_pair', P.littleScale),
    ]),
  }),
  11: Object.freeze({
    c: Object.freeze([
      choice(11, ['Lena invited Tom and ', ' to the exhibition.'], ['he', 'him', 'himself', 'his'], 1,
        'After invited, use the object pronoun him.', 'word_or_verb_form', P.pronounCase, 2,
        optionDiagnostics(['word_or_verb_form', P.pronounCase], null, ['word_or_verb_form', P.reflexiveForm], ['construction_choice', P.possessiveForm])),
      choice(11, ['To say that no one helped, complete: The children made the sandwiches by ', '.'], ['them', 'their', 'themselves', 'theirs'], 2,
        'By themselves means without help.', 'word_or_verb_form', P.reflexiveForm, 2,
        optionDiagnostics(['word_or_verb_form', P.pronounCase], ['construction_choice', P.possessiveForm], null, ['construction_choice', P.possessiveForm])),
      choice(11, ['Choose the subject pronoun: ', ' gave us the directions.'], ['Them', 'They', 'Their', 'Themselves'], 1,
        'A subject position requires they.', 'word_or_verb_form', P.pronounCase, 2,
        optionDiagnostics(['word_or_verb_form', P.pronounCase], null, ['construction_choice', P.possessiveForm], ['word_or_verb_form', P.reflexiveForm])),
    ]),
    f: Object.freeze([
      input(11, 'Lena invited _____ (THEY) to join the team.', 'THEY', 'them',
        'The object of invited is the object pronoun them.', 'word_or_verb_form', P.pronounCase),
      input(11, '_____ (IT) colour changes when the light is dim.', 'IT', 'its',
        'Before a noun, use possessive its without an apostrophe.', 'word_or_verb_form', P.itsForm),
      input(11, 'The teacher called _____ (WE) after class.', 'WE', 'us',
        'The object of called is the object pronoun us.', 'word_or_verb_form', P.pronounCase),
    ]),
    correction: Object.freeze([
      correction(11, 'Исправьте местоимение: My bag is blue, but her is red.',
        ['My bag is blue, but hers is red.', 'My bag is blue, but her bag is red.'],
        'A possessive pronoun stands without a following noun.', 'construction_choice', P.possessiveForm),
      correction(11, 'Исправьте местоимение: This notebook is my.', 'This notebook is mine.',
        'Use mine when the noun is omitted.', 'construction_choice', P.possessiveForm),
      correction(11, 'Исправьте падеж: Me saw the notice first.', 'I saw the notice first.',
        'The subject position requires I.', 'word_or_verb_form', P.pronounCase),
      correction(11, 'Исправьте падеж: The coach invited he to practise.', 'The coach invited him to practise.',
        'The object of invited requires him.', 'word_or_verb_form', P.pronounCase),
      correction(11, 'Исправьте возвратную форму: He cut hisself while cooking.', 'He cut himself while cooking.',
        'The standard reflexive form is himself.', 'word_or_verb_form', P.reflexiveForm),
      correction(11, 'Исправьте возвратную форму: We prepared the room ourself.', 'We prepared the room ourselves.',
        'The plural subject we requires ourselves.', 'word_or_verb_form', P.reflexiveForm),
      correction(11, 'Замените только some на any; остальные слова не меняйте: There is not some sugar left.', 'There is not any sugar left.',
        'A negative statement normally uses any.', 'construction_choice', P.someAny),
      correction(11, 'Исправьте нейтральный информационный вопрос: Are there some messages for me?', 'Are there any messages for me?',
        'A neutral information question uses any.', 'construction_choice', P.someAny),
    ]),
    transform: Object.freeze([
      transform(11, 'Замените сочетание притяжательным местоимением: This is my notebook. Начните: This notebook ...',
        'This notebook is mine.', 'Mine replaces my notebook.', 'construction_choice', P.possessiveForm),
      transform(11, 'Замените сочетание притяжательным местоимением: Those are our seats. Начните: Those seats ...',
        'Those seats are ours.', 'Ours replaces our seats.', 'construction_choice', P.possessiveForm),
      transform(11, 'Замените сочетание притяжательным местоимением: This is her bag. Начните: This bag ...',
        'This bag is hers.', 'Hers stands without a following noun.', 'construction_choice', P.possessiveForm),
      transform(11, 'Замените сочетание притяжательным местоимением: This is his coat. Начните: This coat ...',
        'This coat is his.', 'His can be used as a possessive pronoun.', 'construction_choice', P.possessiveForm),
      transform(11, 'Замените выделенное имя объектным местоимением: I called Maya after class.',
        'I called her after class.', 'Maya becomes the object pronoun her.', 'word_or_verb_form', P.pronounCase),
      transform(11, 'Замените выделенные имена объектным местоимением: We thanked Alex and Ben for the help.',
        'We thanked them for the help.', 'Alex and Ben become the object pronoun them.', 'word_or_verb_form', P.pronounCase),
      transform(11, 'Покажите, что Leo сделал всё без помощи, используя HIMSELF. Начните: Leo repaired the bike и закончите: himself.',
        'Leo repaired the bike himself.', 'Himself adds the meaning without help.', 'word_or_verb_form', P.reflexiveForm),
      transform(11, 'Покажите, что мы сделали всё без помощи, используя OURSELVES. Начните: We painted the room и закончите: ourselves.',
        'We painted the room ourselves.', 'Ourselves agrees with we.', 'word_or_verb_form', P.reflexiveForm),
    ]),
  }),
  12: Object.freeze({
    c: Object.freeze([
      choice(12, ['The school bought ', ' new chairs.'], ['two hundreds', 'two hundred', 'two hundred of', 'two hundredth'], 1,
        'An exact number uses two hundred without -s or of.', 'construction_choice', P.exactApproximate, 2,
        optionDiagnostics(['construction_choice', P.exactApproximate], null, ['construction_choice', P.exactApproximate], ['construction_choice', P.cardinalOrdinal])),
      choice(12, ['The correct spelling of 40th is ', '.'], ['forty', 'fourtieth', 'fortyth', 'fortieth'], 3,
        'Forty changes to fortieth.', 'word_or_verb_form', P.ordinalSpelling, 2,
        optionDiagnostics(['construction_choice', P.cardinalOrdinal], ['word_or_verb_form', P.ordinalSpelling], ['word_or_verb_form', P.ordinalSpelling], null)),
      choice(12, ['The correct spelling of 9th is ', '.'], ['nine', 'nineth', 'ninth', 'ninetieth'], 2,
        'Nine drops e before -th: ninth.', 'word_or_verb_form', P.ordinalSpelling, 2,
        optionDiagnostics(['construction_choice', P.cardinalOrdinal], ['word_or_verb_form', P.ordinalSpelling], null, ['word_or_verb_form', P.ordinalSpelling])),
    ]),
    f: Object.freeze([
      input(12, 'The office is on the _____ (FORTY) floor.', 'FORTY', 'fortieth',
        'Forty changes to fortieth.', 'word_or_verb_form', P.ordinalSpelling),
      input(12, 'September is the _____ (NINE) month of the year.', 'NINE', 'ninth',
        'Nine changes to ninth.', 'word_or_verb_form', P.ordinalSpelling),
      input(12, 'This is the _____ (EIGHT) chapter in the book.', 'EIGHT', 'eighth',
        'Eight changes to eighth.', 'word_or_verb_form', P.ordinalSpelling),
    ]),
    correction: Object.freeze([
      correction(12, 'Исправьте порядковое числительное: Today is her twelveth birthday.', 'Today is her twelfth birthday.',
        'Twelve changes to twelfth.', 'word_or_verb_form', P.ordinalSpelling),
      correction(12, 'Исправьте порядковое числительное: Our office is on the fourtieth floor.', 'Our office is on the fortieth floor.',
        'Forty changes to fortieth.', 'word_or_verb_form', P.ordinalSpelling),
      correction(12, 'Исправьте точное число: Two hundreds students joined the course.', 'Two hundred students joined the course.',
        'An exact number uses hundred without -s.', 'construction_choice', P.exactApproximate),
      correction(12, 'Исправьте приблизительное число: Hundred of birds crossed the lake.', 'Hundreds of birds crossed the lake.',
        'An approximate large number uses hundreds of.', 'construction_choice', P.exactApproximate),
      correction(12, 'Исправьте форму 21st: She finished twenty-oneth in the race.', 'She finished twenty-first in the race.',
        'Compound ordinals change the final element: twenty-first.', 'construction_choice', P.cardinalOrdinal),
      correction(12, 'Исправьте форму 3rd: This is the threeth attempt.', 'This is the third attempt.',
        'Three has the irregular ordinal third.', 'construction_choice', P.cardinalOrdinal),
      correction(12, 'Исправьте номер страницы: Open the book at page third.', 'Open the book at page three.',
        'A page label uses the cardinal number after page.', 'construction_choice', P.cardinalOrdinal),
      correction(12, 'Исправьте порядковое значение: The team came four in the final.', 'The team came fourth in the final.',
        'A finishing position uses an ordinal.', 'construction_choice', P.cardinalOrdinal),
    ]),
    transform: Object.freeze([
      transform(12, 'Запишите порядковым словом: This is visit number 2 for me. Начните: This is my ...',
        'This is my second visit.', 'Two changes to the ordinal second.', 'construction_choice', P.cardinalOrdinal),
      transform(12, 'Запишите порядковым словом: Today is birthday number 12 for her. Начните: Today is her ...',
        'Today is her twelfth birthday.', 'Twelve changes to the ordinal twelfth.', 'construction_choice', P.cardinalOrdinal),
      transform(12, 'Перепишите точное число словами: The hall has exactly 300 seats.',
        ['The hall has three hundred seats.', 'The hall has exactly three hundred seats.'],
        'An exact number uses hundred without -s or of.', 'construction_choice', P.exactApproximate),
      transform(12, 'Передайте приблизительное количество через HUNDREDS OF: Very many people visited the market. Начните: Hundreds of people ...',
        'Hundreds of people visited the market.', 'An approximate number uses hundreds of.', 'construction_choice', P.exactApproximate),
      transform(12, 'Запишите 5th словом: The lesson is number 5. Начните: It is the ...',
        'It is the fifth lesson.', 'Five changes to fifth.', 'word_or_verb_form', P.ordinalSpelling),
      transform(12, 'Запишите 9th словом: September is month number 9. Начните: September is the ...',
        'September is the ninth month.', 'Nine changes to ninth.', 'word_or_verb_form', P.ordinalSpelling),
      transform(12, 'Преобразуйте метку страницы, сохранив смысл: Turn to the third page. Используйте page 3.',
        ['Turn to page three.', 'Turn to page 3.'],
        'A page label after page uses a cardinal number.', 'construction_choice', P.cardinalOrdinal),
      transform(12, 'Преобразуйте результат, используя порядковое слово: Mia was number 1 in the race. Начните: Mia came ...',
        'Mia came first in the race.', 'A finishing position uses the ordinal first.', 'construction_choice', P.cardinalOrdinal),
    ]),
  }),
  16: Object.freeze({
    c: Object.freeze([
      choice(16, ['Two ', ' crossed the road near the forest.'], ['deers', 'deer', 'deeres', 'deeries'], 1,
        'Deer has the same singular and plural form.', 'word_or_verb_form', P.invariantPlural, 2,
        optionDiagnostics(['word_or_verb_form', P.invariantPlural], null, ['word_or_verb_form', P.invariantPlural], ['word_or_verb_form'])),
      choice(16, ['The chef sharpened three ', '.'], ['knifes', 'knives', 'knife', 'knive'], 1,
        'Nouns ending in -fe often change to -ves: knives.', 'word_or_verb_form', P.regularIrregularPlural, 2,
        optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['confusion_pair', P.singularPlural], ['word_or_verb_form'])),
      choice(16, ['Several European ', ' have old town centres.'], ['citys', 'cities', 'city', 'citis'], 1,
        'A consonant + y changes to -ies: cities.', 'word_or_verb_form', P.regularIrregularPlural, 2,
        optionDiagnostics(['word_or_verb_form', P.regularIrregularPlural], null, ['confusion_pair', P.singularPlural], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(16, 'Six _____ (GOOSE) flew over the lake.', 'GOOSE', 'geese',
        'Goose has the irregular plural geese.', 'word_or_verb_form', P.regularIrregularPlural),
      input(16, 'Ten _____ (SHEEP) were grazing near the farm.', 'SHEEP', 'sheep',
        'Sheep is unchanged in the plural.', 'word_or_verb_form', P.invariantPlural),
      input(16, 'Three _____ (DEER) appeared at the edge of the forest.', 'DEER', 'deer',
        'Deer is unchanged in the plural.', 'word_or_verb_form', P.invariantPlural),
    ]),
    correction: Object.freeze([
      correction(16, 'Исправьте множественное число: Two mans were waiting outside.', 'Two men were waiting outside.',
        'Man has the irregular plural men.', 'word_or_verb_form', P.regularIrregularPlural),
      correction(16, 'Исправьте множественное число: My foots are wet.', 'My feet are wet.',
        'Foot has the irregular plural feet.', 'word_or_verb_form', P.regularIrregularPlural),
      correction(16, 'Исправьте множественное число: The childs are in the garden.', 'The children are in the garden.',
        'Child has the irregular plural children.', 'word_or_verb_form', P.regularIrregularPlural),
      correction(16, 'Исправьте множественное число: We saw two mouses in the shed.', 'We saw two mice in the shed.',
        'Mouse has the irregular plural mice.', 'word_or_verb_form', P.regularIrregularPlural),
      correction(16, 'Исправьте неизменяемую форму: Five sheeps crossed the field.', 'Five sheep crossed the field.',
        'Sheep does not change in the plural.', 'word_or_verb_form', P.invariantPlural),
      correction(16, 'Исправьте неизменяемую форму: Three deers stood by the road.', 'Three deer stood by the road.',
        'Deer does not change in the plural.', 'word_or_verb_form', P.invariantPlural),
      correction(16, 'Исправьте согласование: The children is ready.', 'The children are ready.',
        'The plural subject children takes are.', 'agreement', P.singularPlural),
      correction(16, 'Исправьте согласование: Those people has tickets.', 'Those people have tickets.',
        'The plural subject people takes have.', 'agreement', P.singularPlural),
    ]),
    transform: Object.freeze([
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One woman is waiting by the gate.',
        'Two women are waiting by the gate.', 'Woman changes to women and the plural subject takes are.', 'word_or_verb_form', P.regularIrregularPlural),
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One man works in this office.',
        'Two men work in this office.', 'Man changes to men and the plural verb loses -s.', 'word_or_verb_form', P.regularIrregularPlural),
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One mouse is under the table.',
        'Two mice are under the table.', 'Mouse changes to mice.', 'word_or_verb_form', P.regularIrregularPlural),
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One child has a red hat.',
        'Two children have red hats.', 'Child changes to children; have and hats agree with the plural.', 'word_or_verb_form', P.regularIrregularPlural),
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One sheep is near the fence.',
        'Two sheep are near the fence.', 'Sheep is unchanged in the plural.', 'word_or_verb_form', P.invariantPlural),
      transform(16, 'Замените One на Two и поставьте остальные изменяемые слова во множественное число: One deer is in the field.',
        'Two deer are in the field.', 'Deer is unchanged in the plural.', 'word_or_verb_form', P.invariantPlural),
      transform(16, 'Согласуйте сказуемое с готовым множественным подлежащим: The people (BE) outside.',
        'The people are outside.', 'People is a plural noun and takes are.', 'agreement', P.singularPlural),
      transform(16, 'Согласуйте сказуемое с готовым множественным подлежащим: The children (HAVE) lunch at school.',
        'The children have lunch at school.', 'Children is a plural noun and takes have.', 'agreement', P.singularPlural),
    ]),
  }),
  17: Object.freeze({
    c: Object.freeze([
      choice(17, ['After the long delay, the students felt ', '.'], ['boring', 'bored', 'bore', 'boringly'], 1,
        'The students experience the feeling, so use bored.', 'confusion_pair', P.causeFeeling, 2,
        optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(17, ['The instructions caused confusion and were therefore ', ' to follow.'], ['confused', 'confusing', 'confuse', 'confusedly'], 1,
        'The instructions cause confusion, so use confusing.', 'confusion_pair', P.causeFeeling, 2,
        optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(17, ['I was ', ' by the contradictory instructions.'], ['confusing', 'confused', 'confuse', 'confusingly'], 1,
        'I experience the feeling, so use confused.', 'confusion_pair', P.causeFeeling, 2,
        optionDiagnostics(['confusion_pair', P.causeFeeling], null, ['word_or_verb_form'], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(17, 'The listeners became _____ (BORE) during the repeated announcement.', 'BORE', 'bored',
        'The listeners experience the feeling, so use bored.', 'confusion_pair', P.causeFeeling),
      input(17, 'The final match was _____ (EXCITE) from start to finish.', 'EXCITE', 'exciting',
        'The match causes excitement, so use exciting.', 'confusion_pair', P.causeFeeling),
      input(17, 'We were _____ (SURPRISE) by the sudden result.', 'SURPRISE', 'surprised',
        'We experience the feeling, so use surprised.', 'confusion_pair', P.causeFeeling),
    ]),
    correction: Object.freeze([
      correction(17, 'Исправьте прилагательное: The documentary was bored.', 'The documentary was boring.',
        'The documentary causes the feeling, so use -ing.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: The lecture was interested.', 'The lecture was interesting.',
        'The lecture causes interest, so use -ing.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: We were surprising by the news.', 'We were surprised by the news.',
        'We experience the feeling, so use -ed.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: Maya felt confusing after the explanation.', 'Maya felt confused after the explanation.',
        'Maya experiences the feeling, so use -ed.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: The final minute was excited.', 'The final minute was exciting.',
        'The minute causes excitement, so use -ing.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: The children were frightening by the noise.', 'The children were frightened by the noise.',
        'The children experience fear, so use -ed.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: The repeated task was tired.', 'The repeated task was tiring.',
        'The task causes tiredness, so use -ing.', 'confusion_pair', P.causeFeeling),
      correction(17, 'Исправьте прилагательное: I was exhausting after the hike.', 'I was exhausted after the hike.',
        'I experience exhaustion, so use -ed.', 'confusion_pair', P.causeFeeling),
    ]),
    transform: Object.freeze([
      transform(17, 'Выберите -ing форму и перепишите. Начните: The film was ... Исходное: The film caused boredom.', 'The film was boring.',
        'A thing that causes a feeling takes -ing.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ing форму и перепишите. Начните: The story was ... Исходное: The story caused interest.', 'The story was interesting.',
        'A thing that causes interest takes -ing.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ed форму и перепишите. Начните: We were ... и закончите: by the result. Исходное: The result surprised us.', 'We were surprised by the result.',
        'People who experience the feeling take -ed.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ed форму и перепишите. Начните: Leo was ... и закончите: by the instructions. Исходное: The instructions confused Leo.', 'Leo was confused by the instructions.',
        'Leo experiences the feeling, so use confused.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ing форму. Начните: The game was ... и закончите: for the children. Исходное: The game excited the children.', 'The game was exciting for the children.',
        'The game causes excitement, so use exciting.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ed форму и перепишите. Начните: The children were ... и закончите: by the noise. Исходное: The noise frightened the children.', 'The children were frightened by the noise.',
        'The children experience fear, so use frightened.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ing форму и перепишите. Начните: The long climb was ... и закончите: for us. Исходное: The long climb tired us.', 'The long climb was tiring for us.',
        'The climb causes tiredness, so use tiring.', 'confusion_pair', P.causeFeeling),
      transform(17, 'Выберите -ed форму и перепишите. Начните: We were ... и закончите: by the long climb. Исходное: The long climb exhausted us.', 'We were exhausted by the long climb.',
        'We experience exhaustion, so use exhausted.', 'confusion_pair', P.causeFeeling),
    ]),
  }),
  20: Object.freeze({
    c: Object.freeze([
      choice(20, ['The team performed very ', ' in the final.'], ['good', 'well', 'goodly', 'best'], 1,
        'Performed is an action verb, so use the adverb well.', 'confusion_pair', P.goodWell, 2,
        optionDiagnostics(['confusion_pair', P.goodWell], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(20, ['The delayed train arrived ', ' at night.'], ['lately', 'late', 'latest', 'latefully'], 1,
        'Late is a flat adverb meaning after the expected time.', 'confusion_pair', P.flatAdverb, 3,
        optionDiagnostics(['confusion_pair', P.flatAdverb], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(20, ['Please read the safety instructions ', '.'], ['careful', 'carefully', 'carefulness', 'more careful'], 1,
        'Read is an action verb, so use the adverb carefully.', 'construction_choice', P.adjectiveAdverb, 2,
        optionDiagnostics(['construction_choice', P.adjectiveAdverb], null, ['word_or_verb_form'], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(20, 'The singer performed _____ (GOOD) at the concert.', 'GOOD', 'well',
        'Good changes to the irregular adverb well.', 'confusion_pair', P.goodWell),
      input(20, 'The volunteers worked _____ (HARD) to finish before sunset.', 'HARD', 'hard',
        'Hard means with great effort; it is already an adverb.', 'confusion_pair', P.hardHardly),
      input(20, 'From the back row, we could _____ (HARD) see the screen.', 'HARD', 'hardly',
        'Hardly means almost not.', 'confusion_pair', P.hardHardly),
    ]),
    correction: Object.freeze([
      correction(20, 'Исправьте наречие: The violinist played good.', 'The violinist played well.',
        'After an action verb, good changes to well.', 'confusion_pair', P.goodWell),
      correction(20, 'Исправьте наречие: The team did good in the final.', 'The team did well in the final.',
        'Did is an action verb, so use well.', 'confusion_pair', P.goodWell),
      correction(20, 'Исправьте форму: Please speak quiet in the library.', 'Please speak quietly in the library.',
        'The action speak is modified by quietly.', 'construction_choice', P.adjectiveAdverb),
      correction(20, 'Исправьте форму: Lena answered polite.', 'Lena answered politely.',
        'The action answered is modified by politely.', 'construction_choice', P.adjectiveAdverb),
      correction(20, 'Исправьте смысл: We worked hardly all morning and completed every task.', 'We worked hard all morning and completed every task.',
        'Hard means with effort; hardly means almost not.', 'confusion_pair', P.hardHardly),
      correction(20, 'Исправьте смысл: I could hard hear the announcement over the noise.', 'I could hardly hear the announcement over the noise.',
        'Hardly means almost not.', 'confusion_pair', P.hardHardly),
      correction(20, 'Исправьте плоское наречие: The athlete ran fastly.', 'The athlete ran fast.',
        'Fast is already an adverb and does not take -ly.', 'confusion_pair', P.flatAdverb),
      correction(20, 'Исправьте плоское наречие: The bus arrived lately for the scheduled departure.', 'The bus arrived late for the scheduled departure.',
        'Late means after the expected time; lately means recently.', 'confusion_pair', P.flatAdverb),
    ]),
    transform: Object.freeze([
      transform(20, 'Замените GOOD наречием и перепишите: Mia sings good.', 'Mia sings well.',
        'Good changes to the adverb well after an action verb.', 'confusion_pair', P.goodWell),
      transform(20, 'Замените GOOD наречием и перепишите: The class performed good.', 'The class performed well.',
        'Performed is modified by the adverb well.', 'confusion_pair', P.goodWell),
      transform(20, 'Преобразуйте прилагательное в наречие: The driver was careful. He drove ...', 'He drove carefully.',
        'Careful changes to carefully to modify drove.', 'construction_choice', P.adjectiveAdverb),
      transform(20, 'Преобразуйте прилагательное в наречие: Her reply was calm. She replied ...', 'She replied calmly.',
        'Calm changes to calmly to modify replied.', 'construction_choice', P.adjectiveAdverb),
      transform(20, 'Используйте HARD в значении «усердно». Начните: The students worked ... и закончите: on the project. Исходное: The students put great effort into the project.',
        'The students worked hard on the project.', 'Hard means with great effort.', 'confusion_pair', P.hardHardly),
      transform(20, 'Используйте HARDLY в значении «почти не». Начните: We could ... и закончите: see the road. Исходное: We almost could not see the road.',
        'We could hardly see the road.', 'Hardly means almost not.', 'confusion_pair', P.hardHardly),
      transform(20, 'Используйте FAST без -ly. Начните: The cyclist moved ... Исходное: The cyclist moved at high speed.', 'The cyclist moved fast.',
        'Fast is a flat adverb.', 'confusion_pair', P.flatAdverb),
      transform(20, 'Используйте LATE в значении «после ожидаемого времени». Начните: The train arrived ... Исходное: The train arrived after the scheduled time.',
        'The train arrived late.', 'Late is the flat adverb for after the expected time.', 'confusion_pair', P.flatAdverb),
    ]),
  }),
});

export const ACTIVE_PARTS_OF_SPEECH_TRANSFER_PAIR_PLANS = Object.freeze({
  10: Object.freeze({
    c: Object.freeze([1, 2, 1, 2, 3, 3, 4, 4]),
    f: Object.freeze([1, 2, 1, 3, 2, 4, 3, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  11: Object.freeze({
    c: Object.freeze([1, 1, 2, 3, 3, 4, 2, 4]),
    f: Object.freeze([1, 1, 2, 3, 2, 4, 3, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  12: Object.freeze({
    c: Object.freeze([1, 2, 1, 2, 3, 3, 4, 4]),
    f: Object.freeze([1, 2, 3, 4, 1, 3, 2, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  16: Object.freeze({
    c: Object.freeze([1, 2, 1, 2, 3, 3, 4, 4]),
    f: Object.freeze([1, 2, 1, 2, 3, 3, 4, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  17: Object.freeze({
    c: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    f: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
  20: Object.freeze({
    c: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]),
    f: Object.freeze([1, 2, 2, 3, 1, 3, 4, 4]),
    correction: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
    transform: Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]),
  }),
});
