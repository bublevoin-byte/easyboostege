const TOPIC_META = Object.freeze({
  1: Object.freeze({ errorSkill: 'confusion_pair', confusionPair: 'present_simple__present_continuous' }),
  2: Object.freeze({ errorSkill: 'confusion_pair', confusionPair: 'past_simple__past_continuous' }),
  3: Object.freeze({ errorSkill: 'confusion_pair', confusionPair: 'present_perfect__past_simple' }),
  13: Object.freeze({ errorSkill: 'confusion_pair', confusionPair: 'past_perfect__past_simple' }),
  4: Object.freeze({ errorSkill: 'confusion_pair', confusionPair: 'will__be_going_to' }),
});

function metadata(topicId, errorSkill, confusionPair = null, difficulty = 2, provenance = 'grammar-2-ticket-03') {
  if (!TOPIC_META[topicId]) throw new Error('UNKNOWN_ACTIVE_TENSE_TOPIC');
  return { errorSkill, confusionPair, difficulty, provenance };
}

function tagged(topicId, item, errorSkill, confusionPair = null, difficulty = 2) {
  return { ...item, ...metadata(topicId, errorSkill, confusionPair, difficulty) };
}

function diagnostic(errorCode, confusionPair = null) {
  return Object.freeze({ errorCode, confusionPair });
}

function choice(topicId, item, errorSkill, confusionPair = null, diagnostics = null, difficulty = 2) {
  const authored = diagnostics || item.o.map((_, index) => (
    index === item.a ? null : diagnostic(errorSkill, confusionPair)
  ));
  return tagged(topicId, { ...item, diagnostics: authored }, errorSkill, confusionPair, difficulty);
}

function correction(topicId, s, ans, e, errorSkill, confusionPair = null, difficulty = 2) {
  return tagged(topicId, { type: 'correction', s, ans: Array.isArray(ans) ? ans : [ans], e }, errorSkill, confusionPair, difficulty);
}

function transform(topicId, s, ans, e, errorSkill, confusionPair = null, difficulty = 2) {
  return tagged(topicId, { type: 'transform', s, ans: Array.isArray(ans) ? ans : [ans], e }, errorSkill, confusionPair, difficulty);
}

export const ACTIVE_TENSES_META = TOPIC_META;

const P = Object.fromEntries(Object.entries(TOPIC_META).map(([topicId, value]) => [topicId, value.confusionPair]));
const legacy = (topicId, errorSkill, confusionPair = null, difficulty = 2) => (
  metadata(topicId, errorSkill, confusionPair, difficulty, 'grammar-1-migrated')
);

export const ACTIVE_TENSES_LEGACY_META = Object.freeze({
  1: Object.freeze({
    c: Object.freeze([
      legacy(1, 'agreement'), legacy(1, 'confusion_pair', P[1]), legacy(1, 'confusion_pair', P[1]),
      legacy(1, 'confusion_pair', 'stative_verb__present_continuous'), legacy(1, 'agreement'),
    ]),
    f: Object.freeze([
      legacy(1, 'agreement'), legacy(1, 'confusion_pair', P[1]), legacy(1, 'negation_or_question'),
      legacy(1, 'agreement'), legacy(1, 'confusion_pair', P[1]),
    ]),
  }),
  2: Object.freeze({
    c: Object.freeze([
      legacy(2, 'word_or_verb_form'), legacy(2, 'confusion_pair', P[2]), legacy(2, 'word_or_verb_form'),
      legacy(2, 'confusion_pair', P[2]), legacy(2, 'word_or_verb_form'),
    ]),
    f: Object.freeze([
      legacy(2, 'word_or_verb_form'), legacy(2, 'confusion_pair', P[2]), legacy(2, 'word_or_verb_form'),
      legacy(2, 'confusion_pair', P[2]), legacy(2, 'negation_or_question'),
    ]),
  }),
  3: Object.freeze({
    c: Object.freeze([
      legacy(3, 'auxiliary'), legacy(3, 'confusion_pair', P[3]), legacy(3, 'confusion_pair', P[3]),
      legacy(3, 'auxiliary'), legacy(3, 'auxiliary'),
    ]),
    f: Object.freeze([
      legacy(3, 'word_or_verb_form'), legacy(3, 'confusion_pair', P[3]), legacy(3, 'confusion_pair', P[3]),
      legacy(3, 'auxiliary'), legacy(3, 'auxiliary'),
    ]),
  }),
  13: Object.freeze({
    c: Object.freeze(Array.from({ length: 5 }, () => legacy(13, 'confusion_pair', P[13]))),
    f: Object.freeze(Array.from({ length: 5 }, () => legacy(13, 'confusion_pair', P[13]))),
  }),
  4: Object.freeze({
    c: Object.freeze([
      legacy(4, 'construction_choice', P[4]), legacy(4, 'construction_choice', P[4]),
      legacy(4, 'construction_choice', 'present_simple_schedule__will'),
      legacy(4, 'construction_choice', 'present_continuous_arrangement__will'), legacy(4, 'construction_choice', P[4]),
    ]),
    f: Object.freeze([
      legacy(4, 'word_or_verb_form', P[4]), legacy(4, 'word_or_verb_form', P[4]),
      legacy(4, 'word_or_verb_form', 'present_simple_schedule__will'), legacy(4, 'word_or_verb_form', P[4]),
      legacy(4, 'word_or_verb_form', 'present_simple_time_clause__will'),
    ]),
  }),
});

const X = (errorCode, confusionPair = null) => diagnostic(errorCode, confusionPair);
export const ACTIVE_TENSES_LEGACY_CHOICE_DIAGNOSTICS = Object.freeze({
  1: Object.freeze([
    Object.freeze([X('agreement'), null, X('confusion_pair', P[1]), X('word_or_verb_form')]),
    Object.freeze([X('confusion_pair', P[1]), null, X('agreement'), X('word_or_verb_form')]),
    Object.freeze([null, X('confusion_pair', P[1]), X('agreement'), X('word_or_verb_form')]),
    Object.freeze([null, X('confusion_pair', 'stative_verb__present_continuous'), X('agreement'), X('word_or_verb_form')]),
    Object.freeze([X('agreement'), null, X('confusion_pair', P[1]), X('word_or_verb_form')]),
  ]),
  2: Object.freeze([
    Object.freeze([X('word_or_verb_form'), null, X('confusion_pair', 'present_perfect__past_simple'), X('confusion_pair', P[2])]),
    Object.freeze([X('confusion_pair', P[2]), null, X('word_or_verb_form'), X('word_or_verb_form')]),
    Object.freeze([X('word_or_verb_form'), null, X('confusion_pair', 'present_perfect__past_simple'), X('confusion_pair', P[2])]),
    Object.freeze([X('confusion_pair', P[2]), null, X('word_or_verb_form'), X('word_or_verb_form')]),
    Object.freeze([X('word_or_verb_form'), null, X('confusion_pair', 'present_perfect__past_simple'), X('confusion_pair', P[2])]),
  ]),
  3: Object.freeze([
    Object.freeze([X('auxiliary'), null, X('auxiliary'), X('auxiliary')]),
    Object.freeze([X('word_or_verb_form'), X('confusion_pair', P[3]), null, X('word_or_verb_form')]),
    Object.freeze([X('confusion_pair', P[3]), null, X('word_or_verb_form'), X('confusion_pair', P[3])]),
    Object.freeze([X('auxiliary'), null, X('auxiliary'), X('auxiliary')]),
    Object.freeze([X('auxiliary'), X('auxiliary'), null, X('auxiliary')]),
  ]),
  13: Object.freeze([
    Object.freeze([X('auxiliary'), null, X('auxiliary'), X('auxiliary')]),
    Object.freeze([X('confusion_pair', P[13]), null, X('auxiliary'), X('word_or_verb_form')]),
    Object.freeze([X('confusion_pair', P[13]), null, X('auxiliary'), X('word_or_verb_form')]),
    Object.freeze([null, X('confusion_pair', P[13]), X('auxiliary'), X('word_or_verb_form')]),
    Object.freeze([X('auxiliary'), null, X('auxiliary'), X('auxiliary')]),
  ]),
  4: Object.freeze([
    Object.freeze([X('construction_choice'), null, X('construction_choice', P[4]), X('word_or_verb_form')]),
    Object.freeze([X('construction_choice', P[4]), null, X('construction_choice'), X('word_or_verb_form')]),
    Object.freeze([null, X('construction_choice', 'present_simple_schedule__will'), X('construction_choice'), X('word_or_verb_form')]),
    Object.freeze([X('construction_choice'), null, X('construction_choice', 'present_continuous_arrangement__will'), X('word_or_verb_form')]),
    Object.freeze([X('auxiliary'), X('construction_choice', P[4]), null, X('auxiliary')]),
  ]),
});

// Current-revision wording repairs for legacy items whose original contexts accept
// more than one grammatical tense. The immutable v1 projection is cloned before
// these v2-only overrides are applied.
export const ACTIVE_TENSES_LEGACY_OVERRIDES = Object.freeze({
  1: Object.freeze({
    c: Object.freeze({
      6: Object.freeze({
        t: Object.freeze(['Complete the current-state sentence in Present Simple: Even today, Nora ', ' the answer without checking her notes.']),
        e: 'The instruction requires the current stative form knows.',
      }),
    }),
    f: Object.freeze({
      2: Object.freeze({
        ans: Object.freeze(['does not like', "doesn't like"]),
      }),
    }),
  }),
  2: Object.freeze({
    f: Object.freeze({
      4: Object.freeze({
        ans: Object.freeze(['did not see', "didn't see"]),
      }),
    }),
  }),
  3: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({
        t: Object.freeze(['Complete in Present Perfect: She ', ' already finished her homework.']),
        e: 'Present Perfect with she requires has.',
      }),
      1: Object.freeze({
        t: Object.freeze(['Complete the present-experience sentence in Present Perfect: I ', ' this film before.']),
        e: 'The instruction requires Present Perfect: have seen.',
      }),
    }),
    f: Object.freeze({
      3: Object.freeze({
        ans: Object.freeze(['has not finished', "hasn't finished"]),
      }),
    }),
  }),
  4: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({
        t: Object.freeze(['Use will for this neutral opinion prediction: I think it ', ' tomorrow.']),
        o: Object.freeze(['rains', 'will rain', 'is going to rain', 'rained']),
        e: 'The instruction explicitly requires will rain.',
      }),
      1: Object.freeze({
        t: Object.freeze(['Use be going to for this prediction from visible clouds: Look at the clouds! It ', '.']),
        e: 'The instruction explicitly requires is going to rain.',
      }),
      2: Object.freeze({
        t: Object.freeze(['Use Present Simple for the fixed weekday timetable: the train ', ' at 6:30.']),
        e: 'A fixed timetable requires Present Simple: leaves.',
      }),
      3: Object.freeze({
        t: Object.freeze(['Use Present Continuous for the confirmed arrangement: We ', ' to the cinema tonight — I have the tickets.']),
        e: 'The instruction requires the confirmed arrangement form are going.',
      }),
      4: Object.freeze({
        t: Object.freeze(['Complete the promise with will: I promise I ', ' you.']),
        o: Object.freeze(['help', 'am going to help', 'will help', 'does help']),
        e: 'The instruction explicitly requires will help.',
      }),
    }),
    f: Object.freeze({
      0: Object.freeze({
        s: 'Complete the prediction with will + COME: I am sure she _____ (COME) tomorrow.',
        ans: Object.freeze(['will come']),
        e: 'The instruction explicitly requires will + the base form come.',
      }),
      1: Object.freeze({
        s: 'Complete with will + WIN: He _____ (WIN) the match tomorrow.',
        ans: Object.freeze(['will win']),
        e: 'The instruction explicitly requires will + the base form win.',
      }),
    }),
  }),
  13: Object.freeze({
    c: Object.freeze({
      2: Object.freeze({
        t: Object.freeze(['Use Past Perfect for the earlier action: By the time she called us, she ', ' her keys.']),
        e: 'The key loss happened before the later past call: had lost.',
      }),
      3: Object.freeze({
        t: Object.freeze(['Use Past Perfect for the earlier action: After he ', ' dinner, he watched TV.']),
        o: Object.freeze(['had cooked', 'cooked', 'has cooked', 'cooks']),
        e: 'The instruction explicitly requires had cooked.',
      }),
    }),
    f: Object.freeze({
      1: Object.freeze({
        s: 'Complete in Past Perfect: He was tired because he _____ (NOT SLEEP) all night before the journey.',
        ans: Object.freeze(['had not slept', "hadn't slept"]),
        e: 'The instruction explicitly requires Past Perfect for the earlier cause: had not slept.',
      }),
      2: Object.freeze({
        s: 'Complete in Past Perfect: By 2020 they _____ (BUILD) the new bridge.',
        e: 'The instruction explicitly requires the completed result by the past deadline: had built.',
      }),
      3: Object.freeze({
        s: 'By the time I went out, I _____ (FINISH) my homework.',
        ans: Object.freeze(['had finished']),
        e: 'By the time marks the completed earlier action: had finished.',
      }),
      4: Object.freeze({
        s: 'Complete in Past Perfect: She realised she _____ (FORGET) her password.',
        e: 'The instruction explicitly requires the earlier action in Past Perfect: had forgotten.',
      }),
    }),
  }),
});

export const ACTIVE_TENSES_TRANSFER_PAIR_PLANS = Object.freeze({
  13: Object.freeze({ c: Object.freeze([1, 2, 3, 4, 1, 2, 3, 4]) }),
});

export const ACTIVE_TENSES_BANK = Object.freeze({
  1: Object.freeze({
    c: Object.freeze([
      choice(1, {
        type: 'choice', t: ['Why ', ' at the warning light right now?'],
        o: ['do you look', 'are you looking', 'you look', 'you are looking'], a: 1,
        e: 'Вопрос о действии прямо сейчас: are you looking.',
      }, 'confusion_pair', P[1], [
        diagnostic('confusion_pair', P[1]), null,
        diagnostic('word_order'), diagnostic('word_order'),
      ]),
      choice(1, {
        type: 'choice', t: ['Even today, Nora ', ' the answer without checking her notes.'],
        o: ['is knowing', 'knows', 'know', 'knew'], a: 1,
        e: 'Know — stative verb; with Nora in Present Simple the form is knows.',
      }, 'confusion_pair', 'stative_verb__present_continuous', [
        diagnostic('confusion_pair', 'stative_verb__present_continuous'), null,
        diagnostic('agreement'), diagnostic('word_or_verb_form'),
      ]),
      choice(1, {
        type: 'choice', t: ['Why ', ' the warning label right now?'],
        o: ['do they read', 'are they reading', 'they read', 'they are reading'], a: 1,
        e: 'Right now requires Present Continuous and question word order: are they reading.',
      }, 'confusion_pair', P[1], [
        diagnostic('confusion_pair', P[1]), null,
        diagnostic('word_order'), diagnostic('word_order'),
      ]),
    ]),
    f: Object.freeze([
      tagged(1, {
        type: 'input', s: 'Our teacher usually _____ (GIVE) us a short quiz on Fridays.', b: 'GIVE',
        ans: ['gives'], e: 'Usually и Fridays показывают регулярность; teacher требует gives.',
      }, 'agreement'),
      tagged(1, {
        type: 'input', s: 'My older brother often _____ (WASH) the car on Sundays.', b: 'WASH',
        ans: ['washes'], e: 'Often и Sundays требуют Present Simple; brother — washes.',
      }, 'agreement'),
      tagged(1, {
        type: 'input', s: '_____ your cousins _____ (WAIT) outside right now?', b: 'WAIT',
        ans: ['are your cousins waiting'], e: 'Вопрос о текущем действии: are + subject + waiting.',
      }, 'negation_or_question'),
    ]),
    correction: Object.freeze([
      correction(1, 'Исправьте ошибку: She go to school by bus every day.', 'She goes to school by bus every day.', 'В Present Simple после she нужен глагол с -s.', 'agreement'),
      correction(1, 'Исправьте ошибку: Look! The children play in the fountain.', 'Look! The children are playing in the fountain.', 'Look! указывает на действие сейчас: are playing.', 'confusion_pair', P[1]),
      correction(1, 'Исправьте ошибку: I am knowing the answer now.', 'I know the answer now.', 'Know — глагол состояния; он не употребляется в Continuous.', 'confusion_pair', 'stative_verb__present_continuous'),
      correction(1, 'Исправьте ошибку: Does he works at the library?', 'Does he work at the library?', 'После does используется начальная форма work.', 'negation_or_question'),
      correction(1, 'Исправьте ошибку: We is not waiting for anyone.', ['We are not waiting for anyone.', "We aren't waiting for anyone."], 'С подлежащим we нужен вспомогательный глагол are.', 'agreement'),
      correction(1, "Исправьте отрицание: My parents doesn't watch the news every evening.", ["My parents don't watch the news every evening.", 'My parents do not watch the news every evening.'], 'С parents нужен вспомогательный глагол do, а не does.', 'negation_or_question'),
      correction(1, 'Исправьте время действия, которое происходит прямо сейчас: The dog sleeps on the sofa now.', 'The dog is sleeping on the sofa now.', 'Now и происходящее действие требуют Present Continuous.', 'confusion_pair', P[1]),
      correction(1, 'Исправьте stative verb: We are believing your explanation.', 'We believe your explanation.', 'Believe в значении мнения — stative verb и требует Present Simple.', 'confusion_pair', 'stative_verb__present_continuous'),
    ]),
    transform: Object.freeze([
      transform(1, 'Поставьте предложение в отрицательную форму: She works on Saturdays.', ["She doesn't work on Saturdays.", 'She does not work on Saturdays.'], 'Present Simple: does not + начальная форма work.', 'negation_or_question'),
      transform(1, 'Задайте общий вопрос: Tom is reading an article now.', 'Is Tom reading an article now?', 'В Present Continuous is ставится перед подлежащим.', 'word_order'),
      transform(1, 'Раскройте обе формы: Every winter we (VISIT) Spain, but this week we (STAY) in Italy.', 'Every winter we visit Spain, but this week we are staying in Italy.', 'Регулярность требует Present Simple, временная ситуация — Present Continuous.', 'confusion_pair', P[1]),
      transform(1, 'Замените on Mondays на usually: Kate goes to the gym on Mondays.', ['Kate usually goes to the gym.', 'Usually, Kate goes to the gym.'], 'Usually ставится перед смысловым глаголом в Present Simple.', 'word_order'),
      transform(1, 'Задайте специальный вопрос к месту: Mia studies in the kitchen.', 'Where does Mia study?', 'Where + does + подлежащее + начальная форма глагола.', 'word_order'),
      transform(1, 'Добавьте now и передайте действие в Present Continuous: The mechanic repairs my bike.', ['The mechanic is repairing my bike now.', 'Now the mechanic is repairing my bike.', 'The mechanic is now repairing my bike.'], 'Явно требуются now и форма is repairing.', 'confusion_pair', P[1]),
      transform(1, 'Поставьте предложение в отрицательную форму: They are waiting outside.', ["They aren't waiting outside.", 'They are not waiting outside.'], 'Present Continuous negative: are not + V-ing.', 'negation_or_question'),
      transform(1, 'Поставьте usually перед смысловым глаголом: Ben reads before bed.', 'Ben usually reads before bed.', 'Usually ставится перед смысловым глаголом reads.', 'word_order'),
    ]),
  }),
  2: Object.freeze({
    c: Object.freeze([
      choice(2, {
        type: 'choice', t: ['Choose Past Simple for the short completed event: While the guide was speaking, one tourist ', ' asleep.'],
        o: ['falls', 'fell', 'was falling', 'has fallen'], a: 1,
        e: 'Короткое завершённое событие на фоне процесса: fell.',
      }, 'confusion_pair', P[2], [
        diagnostic('word_or_verb_form'), null,
        diagnostic('confusion_pair', P[2]), diagnostic('word_or_verb_form'),
      ]),
      choice(2, {
        type: 'choice', t: ['The expedition ', ' the coast in 2018.'],
        o: ['reaches', 'reached', 'has reached', 'was reaching'], a: 1,
        e: 'A finished event at the stated past time requires reached.',
      }, 'word_or_verb_form', null, [
        diagnostic('word_or_verb_form'), null,
        diagnostic('confusion_pair', 'present_perfect__past_simple'), diagnostic('confusion_pair', P[2]),
      ]),
      choice(2, {
        type: 'choice', t: ['Choose Past Simple for the single interruption: While the teacher was writing, the bell ', '.'],
        o: ['rings', 'rang', 'was ringing', 'has rung'], a: 1,
        e: 'The short completed event on the background is rang.',
      }, 'confusion_pair', P[2], [
        diagnostic('word_or_verb_form'), null,
        diagnostic('confusion_pair', P[2]), diagnostic('word_or_verb_form'),
      ]),
    ]),
    f: Object.freeze([
      tagged(2, {
        type: 'input', s: 'Show the action in progress at nine last night: I _____ (PREPARE) for the test.', b: 'PREPARE',
        ans: ['was preparing'], e: 'Точный момент в прошлом описывает процесс: was preparing.',
      }, 'confusion_pair', P[2]),
      tagged(2, {
        type: 'input', s: 'Show the action in progress at six yesterday evening: the team _____ (REHEARSE) on stage.', b: 'REHEARSE',
        ans: ['was rehearsing'], e: 'A process at a precise past moment requires was rehearsing.',
      }, 'confusion_pair', P[2]),
      tagged(2, {
        type: 'input', s: '_____ Maya _____ (CALL) you after the lesson yesterday?', b: 'CALL',
        ans: ['did Maya call'], e: 'Past Simple question: did + subject + base form call.',
      }, 'negation_or_question'),
    ]),
    correction: Object.freeze([
      correction(2, 'Исправьте время одного завершённого наблюдения: I was seeing the signal flash once at the station yesterday.', 'I saw the signal flash once at the station yesterday.', 'Once и завершённое наблюдение требуют Past Simple.', 'confusion_pair', P[2]),
      correction(2, 'Исправьте время фонового действия: They played chess when the lights suddenly went out.', 'They were playing chess when the lights suddenly went out.', 'Уже шедший процесс — Past Continuous; внезапное событие — Past Simple.', 'confusion_pair', P[2]),
      correction(2, 'Исправьте ошибку: Did she went home early?', 'Did she go home early?', 'После did используется начальная форма go.', 'negation_or_question'),
      correction(2, 'Исправьте ошибку: We was walking along the river.', 'We were walking along the river.', 'С we нужен вспомогательный глагол were.', 'agreement'),
      correction(2, 'Исправьте время параллельного процесса: At that moment, while I cooked, my sister was setting the table.', 'At that moment, while I was cooking, my sister was setting the table.', 'Два процесса, шедшие одновременно в тот момент, выражаются Past Continuous.', 'confusion_pair', P[2]),
      correction(2, 'Исправьте ошибку: They was waiting when I arrived.', 'They were waiting when I arrived.', 'С подлежащим they в Past Continuous используется were.', 'agreement'),
      correction(2, 'Исправьте время фонового процесса: I wrote notes when the lecturer entered.', 'I was writing notes when the lecturer entered.', 'The ongoing background action requires Past Continuous.', 'confusion_pair', P[2]),
      correction(2, 'Исправьте вопрос: Did Leo finished the report yesterday?', 'Did Leo finish the report yesterday?', 'After did, use the base form finish.', 'negation_or_question'),
    ]),
    transform: Object.freeze([
      transform(2, 'Сделайте первое действие фоновым процессом, а второе — коротким событием. Начните с I и соедините действия с when: I watched TV. The phone rang.', 'I was watching TV when the phone rang.', 'Фоновое действие — was watching, короткое событие — rang.', 'confusion_pair', P[2]),
      transform(2, 'Поставьте предложение в вопросительную форму: They visited the museum yesterday.', 'Did they visit the museum yesterday?', 'Past Simple question: did + начальная форма.', 'negation_or_question'),
      transform(2, 'Поставьте предложение в отрицательную форму: Leo finished the report.', ["Leo didn't finish the report.", 'Leo did not finish the report.'], 'Past Simple negative: did not finish.', 'negation_or_question'),
      transform(2, 'Раскройте обе формы: While Anna (DRIVE), she (SEE) a deer.', 'While Anna was driving, she saw a deer.', 'Процесс — was driving; короткое событие — saw.', 'confusion_pair', P[2]),
      transform(2, 'Опишите процесс в указанный момент: I read the book. (at 8 pm yesterday)', ['I was reading the book at 8 pm yesterday.', 'At 8 pm yesterday, I was reading the book.'], 'Действие в конкретный момент прошлого требует Past Continuous.', 'confusion_pair', P[2]),
      transform(2, 'Задайте вопрос к объекту действия: Max was fixing the door at noon.', 'What was Max fixing at noon?', 'What asks about the object: What + was + subject + V-ing.', 'negation_or_question'),
      transform(2, 'Покажите фоновый процесс в Past Continuous: The guests waited when the host arrived.', 'The guests were waiting when the host arrived.', 'The ongoing background action requires were waiting.', 'confusion_pair', P[2]),
      transform(2, 'Задайте общий вопрос: Nora was reading at nine.', 'Was Nora reading at nine?', 'Past Continuous question: was + subject + V-ing.', 'negation_or_question'),
    ]),
  }),
  3: Object.freeze({
    c: Object.freeze([
      choice(3, {
        type: 'choice', t: ['I ', ' this laptop in 2024.'],
        o: ['have bought', 'bought', 'buy', 'am buying'], a: 1,
        e: 'Указан завершённый момент in 2024, поэтому Past Simple.',
      }, 'confusion_pair', P[3], [
        diagnostic('confusion_pair', P[3]), null,
        diagnostic('word_or_verb_form'), diagnostic('word_or_verb_form'),
      ]),
      choice(3, {
        type: 'choice', t: ['We ', ' neighbours since 2020.'],
        o: ['are', 'were', 'have been', 'had been'], a: 2,
        e: 'Since 2020 connects the state to now: have been.',
      }, 'auxiliary'),
      choice(3, {
        type: 'choice', t: ['Mia ', ' the message last night.'],
        o: ['has read', 'read', 'reads', 'is reading'], a: 1,
        e: 'Last night is a finished past time, so use Past Simple read.',
      }, 'confusion_pair', P[3], [
        diagnostic('confusion_pair', P[3]), null,
        diagnostic('word_or_verb_form'), diagnostic('word_or_verb_form'),
      ]),
    ]),
    f: Object.freeze([
      tagged(3, {
        type: 'input', s: 'We _____ (NOT FINISH) the project yet.', b: 'NOT FINISH',
        ans: ['have not finished', "haven't finished"], e: 'Yet связывает незавершённый результат с настоящим.',
      }, 'auxiliary'),
      tagged(3, {
        type: 'input', s: 'She has _____ (WRITE) three emails so far.', b: 'WRITE',
        ans: ['written'], e: 'After has, the third form written is required.',
      }, 'word_or_verb_form'),
      tagged(3, {
        type: 'input', s: '_____ you ever _____ (TRY) snowboarding?', b: 'TRY',
        ans: ['have you ever tried'], e: 'Experience question: have + subject + ever + V3.',
      }, 'auxiliary'),
    ]),
    correction: Object.freeze([
      correction(3, 'Исправьте ошибку: I have met her yesterday.', 'I met her yesterday.', 'Yesterday требует Past Simple.', 'confusion_pair', P[3]),
      correction(3, 'Исправьте ошибку: Until now, she never visited London.', 'Until now, she has never visited London.', 'Until now связывает жизненный опыт с настоящим и требует Present Perfect.', 'confusion_pair', P[3]),
      correction(3, 'Исправьте третью форму: Have you ever saw this film?', 'Have you ever seen this film?', 'После have в Present Perfect нужна третья форма seen.', 'word_or_verb_form'),
      correction(3, 'Исправьте ошибку: He has finished the course last June.', 'He finished the course last June.', 'Last June — конкретное прошлое, значит Past Simple.', 'confusion_pair', P[3]),
      correction(3, 'Исправьте ошибку: We have knew each other for ten years.', 'We have known each other for ten years.', 'После have нужна третья форма known.', 'word_or_verb_form'),
      correction(3, 'Исправьте время после so far: So far, my keys disappeared twice this month.', 'So far, my keys have disappeared twice this month.', 'So far и незавершённый текущий месяц требуют Present Perfect.', 'confusion_pair', P[3]),
      correction(3, 'Исправьте вспомогательный глагол: She have already sent the form.', 'She has already sent the form.', 'With she, Present Perfect uses has.', 'auxiliary'),
      correction(3, "Исправьте отрицание: They hasn't finished the task yet.", ["They haven't finished the task yet.", 'They have not finished the task yet.'], 'With they, Present Perfect uses have not.', 'auxiliary'),
    ]),
    transform: Object.freeze([
      transform(3, 'Перепишите в Present Perfect Simple (не Continuous), добавив since 2021: We live in Omsk.', ['We have lived in Omsk since 2021.', 'Since 2021, we have lived in Omsk.'], 'Явно заданный Present Perfect Simple использует have lived.', 'confusion_pair', P[3]),
      transform(3, 'Задайте вопрос об опыте с ever: you / ride / a horse', 'Have you ever ridden a horse?', 'Present Perfect: have + подлежащее + V3.', 'auxiliary'),
      transform(3, 'Добавьте yesterday и выберите время: I have sent the parcel.', ['I sent the parcel yesterday.', 'Yesterday, I sent the parcel.'], 'Конкретное прошлое переводит действие в Past Simple.', 'confusion_pair', P[3]),
      transform(3, 'Раскройте форму: This is the first time I (TRY) kayaking.', 'This is the first time I have tried kayaking.', 'После this is the first time используется Present Perfect.', 'word_or_verb_form'),
      transform(3, 'Перепишите, используя Present Perfect для текущего результата: Nina lost her glasses and still cannot find them.', 'Nina has lost her glasses and still cannot find them.', 'Явно заданный Present Perfect подчёркивает результат сейчас: has lost.', 'confusion_pair', P[3]),
      transform(3, 'Преобразуйте в отрицание с yet: They completed the task.', ["They haven't completed the task yet.", 'They have not completed the task yet.', "They haven't yet completed the task.", 'They have not yet completed the task.'], 'Yet в отрицании требует Present Perfect.', 'auxiliary'),
      transform(3, 'Добавьте last week и используйте Past Simple: I have visited the gallery.', ['I visited the gallery last week.', 'Last week, I visited the gallery.'], 'A finished past time requires Past Simple.', 'confusion_pair', P[3]),
      transform(3, 'Раскройте третью форму: She has (WRITE) the report.', 'She has written the report.', 'Present Perfect requires the third form written.', 'word_or_verb_form'),
    ]),
  }),
  13: Object.freeze({
    c: Object.freeze([
      choice(13, {
        type: 'choice', t: ['Use Past Perfect for the earlier completed action: By the time the ambulance arrived, the patient ', ' consciousness.'],
        o: ['lost', 'had lost', 'has lost', 'was losing'], a: 1,
        e: 'Потеря сознания произошла раньше прибытия: had lost.',
      }, 'confusion_pair', P[13], [
        diagnostic('confusion_pair', P[13]), null,
        diagnostic('auxiliary'), diagnostic('word_or_verb_form'),
      ]),
      choice(13, {
        type: 'choice', t: ['Use Past Perfect for the earlier completed action: Before the doors opened, the audience ', ' their seats.'],
        o: ['found', 'had found', 'has found', 'finds'], a: 1,
        e: 'The audience found the seats before the later past opening: had found.',
      }, 'confusion_pair', P[13], [
        diagnostic('confusion_pair', P[13]), null,
        diagnostic('auxiliary'), diagnostic('word_or_verb_form'),
      ]),
      choice(13, {
        type: 'choice', t: ['Use Past Perfect for the earlier completed action: By the time I checked, the file ', '.'],
        o: ['disappeared', 'had disappeared', 'has disappeared', 'disappears'], a: 1,
        e: 'The disappearance happened before the later past check: had disappeared.',
      }, 'confusion_pair', P[13], [
        diagnostic('confusion_pair', P[13]), null,
        diagnostic('auxiliary'), diagnostic('word_or_verb_form'),
      ]),
    ]),
    f: Object.freeze([
      tagged(13, {
        type: 'input', s: 'By the time we continued our journey, we _____ (CHECK) the map carefully.', b: 'CHECK',
        ans: ['had checked'], e: 'By the time задаёт завершённую проверку раньше продолжения пути: had checked.',
      }, 'confusion_pair', P[13]),
      tagged(13, {
        type: 'input', s: 'Complete in Past Perfect: Before the guests arrived, we _____ (SET) the table.', b: 'SET',
        ans: ['had set'], e: 'The requested Past Perfect marks the completed earlier action: had set.',
      }, 'confusion_pair', P[13]),
      tagged(13, {
        type: 'input', s: 'By the time the shop opened, the staff _____ (CHECK) every shelf.', b: 'CHECK',
        ans: ['had checked'], e: 'The check was completed before the opening: had checked.',
      }, 'confusion_pair', P[13]),
    ]),
    correction: Object.freeze([
      correction(13, 'Исправьте ошибку: By the time I arrived, the lesson already started.', 'By the time I arrived, the lesson had already started.', 'By the time показывает, что урок начался раньше прибытия.', 'confusion_pair', P[13]),
      correction(13, 'Исправьте ошибку: She had went home before the storm began.', 'She had gone home before the storm began.', 'После had используется третья форма gone.', 'word_or_verb_form'),
      correction(13, 'Исправьте время действия, завершённого к отъезду: By the time they left, they did not eat anything.', ["By the time they left, they hadn't eaten anything.", 'By the time they left, they had not eaten anything.'], 'By the time требует had not eaten для более раннего незавершённого действия.', 'confusion_pair', P[13]),
      correction(13, 'Исправьте ошибку: By 2019 he finished three courses.', 'By 2019 he had finished three courses.', 'By 2019 задаёт результат к моменту прошлого.', 'confusion_pair', P[13]),
      correction(13, 'Исправьте время второго последовательного действия в завершённом рассказе: After the guests had left, we had washed the dishes.', 'After the guests had left, we washed the dishes.', 'После более раннего had left следующее событие рассказа выражается Past Simple.', 'confusion_pair', P[13]),
      correction(13, 'Исправьте ошибку: Had she saw the message before the meeting?', 'Had she seen the message before the meeting?', 'В вопросе Past Perfect после had нужна форма seen.', 'word_or_verb_form'),
      correction(13, 'Исправьте вспомогательный глагол: They has finished before noon.', 'They had finished before noon.', 'Past Perfect uses had with every subject.', 'auxiliary'),
      correction(13, "Исправьте вспомогательный глагол: We hasn't eaten before the trip.", "We hadn't eaten before the trip.", 'Past Perfect uses had, including in the negative form had not.', 'auxiliary'),
    ]),
    transform: Object.freeze([
      transform(13, 'Начните с The shop и соедините с before, используя Past Perfect для закрытия: The shop closed. We reached it.', 'The shop had closed before we reached it.', 'Заданное начало и Past Perfect фиксируют единственную целевую конструкцию.', 'confusion_pair', P[13]),
      transform(13, 'Раскройте обе формы: When Dad (COME), we already (EAT) dinner.', 'When Dad came, we had already eaten dinner.', 'Позднее событие — came, более раннее — had eaten.', 'confusion_pair', P[13]),
      transform(13, 'Поставьте в вопросительную форму: She had read the email before lunch.', 'Had she read the email before lunch?', 'Had переносится перед подлежащим.', 'negation_or_question'),
      transform(13, 'Поставьте в отрицательную форму: I had visited that city before.', ["I hadn't visited that city before.", 'I had not visited that city before.'], 'Past Perfect negative: had not + V3.', 'negation_or_question'),
      transform(13, 'Передайте завершённость к 6 часам вчера: The team completed the work.', ['The team had completed the work by six o’clock yesterday.', 'By six o’clock yesterday, the team had completed the work.'], 'By six o’clock yesterday задаёт результат к моменту прошлого.', 'confusion_pair', P[13]),
      transform(13, 'Расставьте события по времени, используя Past Perfect для более раннего: He turned on the computer after he (PLUG) it in.', 'He turned on the computer after he had plugged it in.', 'Явно заданное более раннее подключение выражается had plugged.', 'confusion_pair', P[13]),
      transform(13, 'Преобразуйте в отрицание: They had written the note before lunch.', ["They hadn't written the note before lunch.", 'They had not written the note before lunch.'], 'Past Perfect negative: had not + V3.', 'negation_or_question'),
      transform(13, 'Преобразуйте в вопрос: Nora had left before six.', 'Had Nora left before six?', 'Past Perfect question: had + subject + V3.', 'negation_or_question'),
    ]),
  }),
  4: Object.freeze({
    c: Object.freeze([
      choice(4, {
        type: 'choice', t: ['Use be going to for this prediction from visible evidence: Look at those black clouds! It ', ' rain.'],
        o: ['will', 'is going to', 'is', 'does'], a: 1,
        e: 'Видимое доказательство требует be going to.',
      }, 'construction_choice', P[4], [
        diagnostic('construction_choice', P[4]), null,
        diagnostic('auxiliary'), diagnostic('auxiliary'),
      ]),
      choice(4, {
        type: 'choice', t: ['Use Present Simple for the published schedule: the ferry ', ' at noon.'],
        o: ['leaves', 'will leave', 'is leaving', 'left'], a: 0,
        e: 'A published schedule uses Present Simple: leaves.',
      }, 'construction_choice', 'present_simple_schedule__will', [
        null, diagnostic('construction_choice', 'present_simple_schedule__will'),
        diagnostic('construction_choice'), diagnostic('word_or_verb_form'),
      ]),
      choice(4, {
        type: 'choice', t: ['Use Present Continuous for the confirmed appointment: We ', ' the designer tomorrow at four.'],
        o: ['meet', 'are meeting', 'will meet', 'met'], a: 1,
        e: 'A confirmed personal arrangement uses Present Continuous.',
      }, 'construction_choice', 'present_continuous_arrangement__will', [
        diagnostic('construction_choice'), null,
        diagnostic('construction_choice', 'present_continuous_arrangement__will'), diagnostic('word_or_verb_form'),
      ]),
    ]),
    f: Object.freeze([
      tagged(4, {
        type: 'input', s: 'Complete the fixed timetable in Present Simple: The school bus _____ (LEAVE) at 7:30 tomorrow.', b: 'LEAVE',
        ans: ['leaves'], e: 'Расписание выражается Present Simple: leaves.',
      }, 'word_or_verb_form', 'present_simple_schedule__will'),
      tagged(4, {
        type: 'input', s: 'Complete with will + HELP: I promise I _____ (HELP) you after class.', b: 'HELP',
        ans: ['will help'], e: 'The instruction explicitly requires will + help.',
      }, 'word_or_verb_form', P[4]),
      tagged(4, {
        type: 'input', s: 'As soon as she _____ (ARRIVE), we will begin.', b: 'ARRIVE',
        ans: ['arrives'], e: 'After as soon as in a future time clause, use Present Simple.',
      }, 'word_or_verb_form', 'present_simple_time_clause__will'),
    ]),
    correction: Object.freeze([
      correction(4, 'Исправьте форму после will: I think people will to live on Mars one day.', 'I think people will live on Mars one day.', 'После will используется инфинитив без to.', 'auxiliary'),
      correction(4, 'Перепишите прогноз по видимому доказательству, используя be going to: Look! That glass will fall.', 'Look! That glass is going to fall.', 'Явно заданный be going to оформляет прогноз по видимому доказательству.', 'construction_choice', P[4]),
      correction(4, 'Исправьте ошибку: When she will arrive, we will start dinner.', 'When she arrives, we will start dinner.', 'После when о будущем используется Present Simple.', 'word_or_verb_form', 'present_simple_time_clause__will'),
      correction(4, 'Перепишите расписание в Present Simple: According to the timetable, the train will leave at six tomorrow.', 'According to the timetable, the train leaves at six tomorrow.', 'Явно заданное расписание выражается Present Simple.', 'construction_choice', 'present_simple_schedule__will'),
      correction(4, 'Перепишите второе расписание в Present Simple: According to the programme, the workshop will begin at ten.', 'According to the programme, the workshop begins at ten.', 'Явно заданное расписание выражается Present Simple.', 'construction_choice', 'present_simple_schedule__will'),
      correction(4, 'Перепишите обещание с will: I promise I am calling you tonight.', 'I promise I will call you tonight.', 'Явно заданное обещание выражается will + начальная форма.', 'construction_choice', P[4]),
      correction(4, 'Исправьте форму после will: She will arrives before lunch.', 'She will arrive before lunch.', 'After will, use the base form arrive.', 'auxiliary'),
      correction(4, 'Исправьте future time clause: As soon as he will finish, he will call us.', 'As soon as he finishes, he will call us.', 'After as soon as, use Present Simple for future time.', 'word_or_verb_form', 'present_simple_time_clause__will'),
    ]),
    transform: Object.freeze([
      transform(4, 'Выразите спонтанное решение: The phone is ringing. I / answer it.', ["The phone is ringing. I'll answer it.", 'The phone is ringing. I will answer it.'], 'Спонтанное решение выражается will.', 'construction_choice', P[4]),
      transform(4, 'Выразите намерение с going to: We / repaint / the kitchen this weekend.', ['We are going to repaint the kitchen this weekend.', 'This weekend, we are going to repaint the kitchen.'], 'Заранее принятое намерение выражается be going to.', 'construction_choice', P[4]),
      transform(4, 'Выразите договорённость: I / meet / Lena at five tomorrow.', ['I am meeting Lena at five tomorrow.', "I'm meeting Lena at five tomorrow.", 'At five tomorrow, I am meeting Lena.', "At five tomorrow, I'm meeting Lena."], 'Личная договорённость выражается Present Continuous.', 'construction_choice', 'present_continuous_arrangement__will'),
      transform(4, 'Выразите подтверждённую договорённость: We / meet / the guide at ten tomorrow.', 'We are meeting the guide at ten tomorrow.', 'A confirmed arrangement uses Present Continuous.', 'construction_choice', 'present_continuous_arrangement__will'),
      transform(4, 'Раскройте формы: If it (RAIN) tomorrow, we (STAY) at home.', 'If it rains tomorrow, we will stay at home.', 'После if — Present Simple; в главной части — will.', 'word_or_verb_form', 'present_simple_time_clause__will'),
      transform(4, 'Поставьте обещание в отрицательную форму: I will forget your birthday.', ["I won't forget your birthday.", 'I will not forget your birthday.'], 'Отрицание будущего обещания: will not / won’t.', 'auxiliary'),
      transform(4, 'Раскройте future time clause: When the lesson (END), I will call you.', 'When the lesson ends, I will call you.', 'After when, future time is expressed with Present Simple.', 'word_or_verb_form', 'present_simple_time_clause__will'),
      transform(4, 'Поставьте обещание в вопросительную форму: You will help me.', 'Will you help me?', 'Question with will: will + subject + base form.', 'auxiliary'),
    ]),
  }),
});
