const TOPIC_IDS = Object.freeze([5, 6, 7, 8, 9, 18]);

function metadata(topicId, errorSkill, confusionPair = null, difficulty = 2, provenance = 'grammar-2-ticket-04') {
  if (!TOPIC_IDS.includes(Number(topicId))) throw new Error('UNKNOWN_ACTIVE_VERB_CONSTRUCTION_TOPIC');
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
    throw new Error('INVALID_ACTIVE_VERB_CONSTRUCTION_CHOICE_DIAGNOSTICS');
  }
  return tagged(topicId, {
    type: 'choice', t, o, a, e, diagnostics,
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
  passive: 'active_voice__passive_voice',
  passiveForm: 'simple_passive__continuous_passive',
  conditional: 'if_clause_pattern__result_clause_pattern',
  firstSecond: 'first_conditional__second_conditional',
  zeroSecond: 'zero_conditional__second_conditional',
  secondThird: 'second_conditional__third_conditional',
  reported: 'direct_speech__reported_speech',
  reportedQuestion: 'direct_question__reported_question',
  reportedPast: 'past_simple__past_perfect',
  willWould: 'will__would',
  modalMeaning: 'required_modal__other_modal',
  prohibition: 'must_not__do_not_have_to',
  permission: 'permission__obligation',
  canCould: 'can__could',
  verbPattern: 'gerund__to_infinitive',
  stopPattern: 'stop_doing__stop_to_do',
  bareInfinitive: 'bare_infinitive__to_infinitive',
  questionOrder: 'direct_question__indirect_question',
  subjectQuestion: 'subject_question__object_question',
  questionTag: 'positive_statement__negative_tag',
});

const legacy = (topicId, errorSkill, confusionPair = null, difficulty = 2) => (
  metadata(topicId, errorSkill, confusionPair, difficulty, 'grammar-1-migrated')
);
const repeat = (length, value) => Object.freeze(Array.from({ length }, () => value));
const optionDiagnostics = (...definitions) => Object.freeze(
  definitions.map((definition) => definition === null ? null : diagnostic(definition[0], definition[1] ?? null)),
);

export const ACTIVE_VERB_CONSTRUCTIONS_LEGACY_META = Object.freeze({
  5: Object.freeze({
    c: Object.freeze([
      legacy(5, 'construction_choice', P.passive), legacy(5, 'auxiliary'),
      legacy(5, 'construction_choice', P.passive), legacy(5, 'construction_choice', P.passive),
      legacy(5, 'confusion_pair', P.passiveForm),
    ]),
    f: repeat(5, legacy(5, 'word_or_verb_form')),
  }),
  6: Object.freeze({
    c: Object.freeze([
      legacy(6, 'construction_choice', P.conditional), legacy(6, 'agreement'),
      legacy(6, 'confusion_pair', P.secondThird), legacy(6, 'construction_choice', P.conditional),
      legacy(6, 'construction_choice', P.conditional),
    ]),
    f: repeat(5, legacy(6, 'construction_choice', P.conditional)),
  }),
  7: Object.freeze({
    c: Object.freeze([
      legacy(7, 'construction_choice', P.reported), legacy(7, 'confusion_pair', P.willWould),
      legacy(7, 'word_order', P.reportedQuestion), legacy(7, 'confusion_pair', P.reportedPast),
      legacy(7, 'construction_choice', P.reported),
    ]),
    f: repeat(5, legacy(7, 'construction_choice', P.reported)),
  }),
  8: Object.freeze({
    c: Object.freeze([
      legacy(8, 'construction_choice', P.modalMeaning), legacy(8, 'confusion_pair', P.prohibition),
      legacy(8, 'construction_choice', P.permission), legacy(8, 'confusion_pair', P.canCould),
      legacy(8, 'construction_choice', P.modalMeaning),
    ]),
    f: Object.freeze([]),
  }),
  9: Object.freeze({
    c: Object.freeze([
      legacy(9, 'confusion_pair', P.verbPattern), legacy(9, 'confusion_pair', P.verbPattern),
      legacy(9, 'confusion_pair', P.stopPattern), legacy(9, 'confusion_pair', P.bareInfinitive),
      legacy(9, 'confusion_pair', P.verbPattern),
    ]),
    f: Object.freeze([
      legacy(9, 'confusion_pair', P.verbPattern), legacy(9, 'confusion_pair', P.verbPattern),
      legacy(9, 'confusion_pair', P.verbPattern), legacy(9, 'confusion_pair', P.bareInfinitive),
      legacy(9, 'confusion_pair', P.verbPattern),
    ]),
  }),
  18: Object.freeze({
    c: Object.freeze([
      legacy(18, 'auxiliary'), legacy(18, 'word_order', P.subjectQuestion),
      legacy(18, 'negation_or_question', P.questionTag), legacy(18, 'negation_or_question', P.questionTag),
      legacy(18, 'word_order', P.questionOrder),
    ]),
    f: Object.freeze([]),
  }),
});

export const ACTIVE_VERB_CONSTRUCTIONS_LEGACY_CHOICE_DIAGNOSTICS = Object.freeze({
  5: Object.freeze([
    optionDiagnostics(['construction_choice', P.passive], null, ['word_or_verb_form'], ['construction_choice', P.passive]),
    optionDiagnostics(['auxiliary'], null, ['auxiliary'], ['construction_choice', P.passive]),
    optionDiagnostics(['construction_choice', P.passive], null, ['word_or_verb_form'], ['construction_choice', P.passive]),
    optionDiagnostics(['construction_choice', P.passive], null, ['word_or_verb_form'], ['construction_choice', P.passive]),
    optionDiagnostics(['confusion_pair', P.passiveForm], null, ['construction_choice', P.passive], ['word_or_verb_form']),
  ]),
  6: Object.freeze([
    optionDiagnostics(['auxiliary'], null, ['confusion_pair', P.firstSecond], ['word_or_verb_form']),
    optionDiagnostics(['agreement'], ['agreement'], null, ['word_or_verb_form']),
    optionDiagnostics(['word_or_verb_form'], null, ['construction_choice', P.conditional], ['confusion_pair', P.secondThird]),
    optionDiagnostics(null, ['construction_choice', P.conditional], ['confusion_pair', P.zeroSecond], ['word_or_verb_form']),
    optionDiagnostics(['construction_choice', P.conditional], ['confusion_pair', P.zeroSecond], null, ['word_or_verb_form']),
  ]),
  7: Object.freeze([
    optionDiagnostics(['construction_choice', P.reported], null, ['agreement'], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.willWould], null, ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['word_order', P.reportedQuestion], null, ['word_order', P.reportedQuestion], ['word_or_verb_form']),
    optionDiagnostics(['confusion_pair', P.reportedPast], ['word_or_verb_form'], null, ['word_or_verb_form']),
    optionDiagnostics(['construction_choice', P.reported], null, ['word_or_verb_form'], ['agreement']),
  ]),
  8: Object.freeze([
    optionDiagnostics(['construction_choice', P.modalMeaning], null, ['construction_choice', P.permission], ['construction_choice', P.modalMeaning]),
    optionDiagnostics(null, ['confusion_pair', P.prohibition], ['construction_choice', P.modalMeaning], ['construction_choice', P.modalMeaning]),
    optionDiagnostics(['construction_choice', P.permission], null, ['construction_choice', P.modalMeaning], ['construction_choice', P.permission]),
    optionDiagnostics(['confusion_pair', P.canCould], null, ['construction_choice', P.modalMeaning], ['construction_choice', P.permission]),
    optionDiagnostics(['construction_choice', P.modalMeaning], null, ['construction_choice', P.permission], ['construction_choice', P.modalMeaning]),
  ]),
  9: Object.freeze([
    optionDiagnostics(['word_or_verb_form'], ['confusion_pair', P.verbPattern], null, ['word_or_verb_form']),
    optionDiagnostics(['word_or_verb_form'], ['confusion_pair', P.verbPattern], null, ['word_or_verb_form']),
    optionDiagnostics(['word_or_verb_form'], null, ['confusion_pair', P.stopPattern], ['word_or_verb_form']),
    optionDiagnostics(null, ['confusion_pair', P.bareInfinitive], ['word_or_verb_form'], ['word_or_verb_form']),
    optionDiagnostics(['word_or_verb_form'], ['confusion_pair', P.verbPattern], null, ['word_or_verb_form']),
  ]),
  18: Object.freeze([
    optionDiagnostics(null, ['auxiliary'], ['agreement'], ['word_or_verb_form']),
    optionDiagnostics(null, ['word_or_verb_form'], ['auxiliary'], ['word_or_verb_form']),
    optionDiagnostics(['negation_or_question', P.questionTag], null, ['auxiliary'], ['agreement']),
    optionDiagnostics(['negation_or_question', P.questionTag], null, ['auxiliary'], ['agreement']),
    optionDiagnostics(null, ['word_order', P.questionOrder], ['agreement'], ['word_or_verb_form']),
  ]),
});

export const ACTIVE_VERB_CONSTRUCTIONS_LEGACY_OVERRIDES = Object.freeze({
  5: Object.freeze({
    c: Object.freeze({
      2: Object.freeze({ t: Object.freeze(['Use will be for a future passive prediction: The new school ', ' next year.']) }),
      3: Object.freeze({ t: Object.freeze(['Use the passive voice for the language, not its speakers: English ', ' all over the world.']) }),
      4: Object.freeze({ t: Object.freeze(['Use the passive continuous for an action in progress now: The room ', ' right now.']) }),
    }),
  }),
  6: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({ t: Object.freeze(['Complete this likely future result in the first conditional: If it rains tomorrow, we ', ' at home.']) }),
      1: Object.freeze({ t: Object.freeze(['Use the formal second conditional: If I ', ' you, I would apologise.']) }),
      2: Object.freeze({ t: Object.freeze(['Complete this unreal present result in the second conditional: She would come if you ', ' her.']) }),
      3: Object.freeze({ t: Object.freeze(['Complete the zero conditional general fact: If you heat ice, it ', '.']) }),
      4: Object.freeze({
        t: Object.freeze(['Complete the zero conditional general result: If plants do not get light, they ', '.']),
        o: Object.freeze(['will die', 'would die', 'die', 'died']),
        e: 'A general result uses Present Simple in both clauses.',
      }),
    }),
    f: Object.freeze({
      3: Object.freeze({
        s: 'If he _____ (BE) here, he would help us.', b: 'BE', ans: Object.freeze(['were']),
        e: 'Formal second conditional uses were.',
      }),
    }),
  }),
  7: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({ t: Object.freeze(['Backshift the current state reported yesterday: He said he ', ' busy.']) }),
      1: Object.freeze({ t: Object.freeze(['Backshift will after said yesterday: She said she ', ' come the next day.']) }),
      2: Object.freeze({
        t: Object.freeze(['Backshift the reported question asked yesterday: Tom asked where I ', '.']),
        o: Object.freeze(['did I live', 'lived', 'do I live', 'living']),
      }),
      3: Object.freeze({ t: Object.freeze(['Show the earlier action with Past Perfect: Mum said she ', ' the film before.']) }),
      4: Object.freeze({
        t: Object.freeze(['Backshift the reported yes/no question asked yesterday: He asked if I ', ' help.']),
        o: Object.freeze(['need', 'needed', 'will need', 'needs']),
      }),
    }),
    f: Object.freeze({
      0: Object.freeze({ s: 'Complete this later report using backshift: She said she _____ (LIVE) in Kazan.' }),
      1: Object.freeze({ s: 'Complete this later report using backshift: He told me he _____ (CALL) later.' }),
      2: Object.freeze({ s: 'Complete this later report using backshift: They said they _____ (FINISH) the project already.' }),
      3: Object.freeze({ s: 'Complete this later report using backshift: He asked what time it _____ (BE).' }),
      4: Object.freeze({
        s: 'Complete this later report using backshift: She said she _____ (CALL) later.', b: 'CALL', ans: Object.freeze(['would call']),
        e: 'Will backshifts to would in reported speech.',
      }),
    }),
  }),
  8: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({ t: Object.freeze(['Choose must for the speaker’s strong statement of this rule: You ', ' wear a helmet.']) }),
      1: Object.freeze({
        t: Object.freeze(['Choose must not for this explicit prohibition: You ', ' smoke here — it is forbidden.']),
        o: Object.freeze(['must not', 'do not have to', 'can', "shouldn't"]),
      }),
      2: Object.freeze({
        t: Object.freeze(['Choose May for polite permission: ', ' I open the window, please?']),
        o: Object.freeze(['Must', 'May', 'Should', 'Have to']),
      }),
      4: Object.freeze({
        t: Object.freeze(['Choose must for a required rule: Visitors ', ' show identification.']),
        o: Object.freeze(['can', 'must', 'may', 'might']),
        e: 'Must expresses a required rule.',
      }),
    }),
  }),
  9: Object.freeze({
    c: Object.freeze({
      2: Object.freeze({ t: Object.freeze(['Choose stop doing for an activity that ended: He stopped ', ' last year — good for him!']) }),
      4: Object.freeze({ t: Object.freeze(['Choose the to-infinitive after the adjective: It is easy ', ' mistakes.']) }),
    }),
  }),
  18: Object.freeze({
    c: Object.freeze({
      0: Object.freeze({ t: Object.freeze(['Choose the auxiliary for a present object question: Where ', ' your brother work?']) }),
      1: Object.freeze({
        t: Object.freeze(['Choose the subject-question form: Who ', ' the window yesterday?']),
        o: Object.freeze(['broke', 'did broke', 'was break', 'break']),
      }),
      3: Object.freeze({ o: Object.freeze(['does she', "doesn't she", "isn't she", "doesn't it"]) }),
      4: Object.freeze({
        t: Object.freeze(['Complete the indirect question with statement word order: I wonder where ', '.']),
        o: Object.freeze(['he lives', 'does he live', 'he live', 'he is live']),
      }),
    }),
  }),
});

export const ACTIVE_VERB_CONSTRUCTIONS_BANK = Object.freeze({
  5: Object.freeze({
    c: Object.freeze([
      choice(5, ['Use the missing passive auxiliary: Parcels ', ' before noon every day.'], ['send', 'are sent', 'sent', 'are sending'], 1,
        'Present Simple passive is are sent.', 'auxiliary', null, 2,
        optionDiagnostics(['auxiliary'], null, ['auxiliary'], ['construction_choice', P.passive])),
      choice(5, ['Use passive voice because French receives the action: French ', ' in parts of Canada.'], ['speaks', 'is spoken', 'spoke', 'is speaking'], 1,
        'The language does not perform the action, so use is spoken.', 'construction_choice', P.passive, 2,
        optionDiagnostics(['construction_choice', P.passive], null, ['word_or_verb_form'], ['construction_choice', P.passive])),
      choice(5, ['Use passive continuous for the action in progress at noon yesterday: The hall ', ' at noon yesterday.'], ['was decorated', 'was being decorated', 'was decorating', 'is decorated'], 1,
        'The action was in progress, so use was being decorated.', 'confusion_pair', P.passiveForm, 3,
        optionDiagnostics(['confusion_pair', P.passiveForm], null, ['construction_choice', P.passive], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(5, 'The final results _____ (ANNOUNCE) tomorrow.', 'ANNOUNCE', 'will be announced',
        'Future passive is will be + V3.', 'word_or_verb_form'),
      input(5, 'The museum _____ (VISIT) by thousands of tourists every year.', 'VISIT', 'is visited',
        'The singular subject museum takes is visited.', 'word_or_verb_form'),
      input(5, 'At nine last night, the road _____ (REPAIR), so traffic was diverted.', 'REPAIR', 'was being repaired',
        'An action in progress at a past moment uses was being repaired.', 'word_or_verb_form', null, 3),
    ]),
    correction: Object.freeze([
      correction(5, 'Исправьте залог, начав с Coffee: People grow coffee commercially in this region.', 'Coffee is grown commercially in this region.',
        'Coffee receives the action, so the passive is required.', 'construction_choice', P.passive),
      correction(5, 'Исправьте залог, начав с The final report: Maya wrote the final report.', 'The final report was written by Maya.',
        'The report receives the action, so use was written.', 'construction_choice', P.passive),
      correction(5, 'Добавьте вспомогательный глагол: The windows cleaned every Friday.', 'The windows are cleaned every Friday.',
        'Present Simple passive requires are + V3.', 'auxiliary'),
      correction(5, 'Исправьте пассив: The bridge will built next year.', 'The bridge will be built next year.',
        'Future passive requires will be + V3.', 'auxiliary'),
      correction(5, 'Исправьте согласование: The documents is checked every morning.', 'The documents are checked every morning.',
        'The plural subject documents requires are.', 'agreement'),
      correction(5, 'Исправьте согласование: The equipment are tested before use.', 'The equipment is tested before use.',
        'Equipment is uncountable and takes is.', 'agreement'),
      correction(5, 'Исправьте вид пассива для действия прямо сейчас: The floor is polished right now.', 'The floor is being polished right now.',
        'Right now requires the continuous passive.', 'confusion_pair', P.passiveForm),
      correction(5, 'Исправьте вид пассива для процесса в тот момент: At noon, the stage was decorated.', 'At noon, the stage was being decorated.',
        'The action was in progress at noon.', 'confusion_pair', P.passiveForm),
    ]),
    transform: Object.freeze([
      transform(5, 'Преобразуйте в пассив, начав с The emails: Staff send the emails every morning.', [
        'The emails are sent every morning.', 'The emails are sent by staff every morning.', 'The emails are sent every morning by staff.',
        'The emails are sent by the staff every morning.', 'The emails are sent every morning by the staff.',
      ],
        'Present Simple passive is are sent.', 'construction_choice', P.passive),
      transform(5, 'Преобразуйте в пассив, начав с The castle: Workers built the castle in 1880.', [
        'The castle was built in 1880.', 'The castle was built by workers in 1880.', 'The castle was built in 1880 by workers.',
        'The castle was built by the workers in 1880.', 'The castle was built in 1880 by the workers.',
      ],
        'Past Simple passive is was built.', 'construction_choice', P.passive),
      transform(5, 'Преобразуйте в будущее пассивное: They will publish the results tomorrow.', [
        'The results will be published tomorrow.', 'The results will be published by them tomorrow.', 'The results will be published tomorrow by them.',
        'Tomorrow, the results will be published.', 'Tomorrow the results will be published.',
        'Tomorrow, the results will be published by them.', 'Tomorrow the results will be published by them.',
      ],
        'Future passive is will be published.', 'auxiliary'),
      transform(5, 'Преобразуйте в будущее пассивное: They will repair the lift.', ['The lift will be repaired.', 'The lift will be repaired by them.'],
        'Future passive is will be repaired.', 'auxiliary'),
      transform(5, 'Поставьте пассивное предложение в вопрос: The room was cleaned yesterday.', 'Was the room cleaned yesterday?',
        'Move was before the subject.', 'negation_or_question'),
      transform(5, 'Поставьте пассивное предложение в вопрос: The letters were delivered yesterday.', 'Were the letters delivered yesterday?',
        'Move were before the subject.', 'negation_or_question'),
      transform(5, 'Передайте процесс прямо сейчас в пассиве: They are interviewing the candidates now.', [
        'The candidates are being interviewed now.', 'The candidates are being interviewed by them now.', 'The candidates are being interviewed now by them.',
        'Now, the candidates are being interviewed.', 'Now the candidates are being interviewed.',
        'Now, the candidates are being interviewed by them.', 'Now the candidates are being interviewed by them.',
      ],
        'A current process uses are being interviewed.', 'confusion_pair', P.passiveForm),
      transform(5, 'Передайте процесс в тот момент вчера в пассиве: They were repairing the road at noon.', [
        'The road was being repaired at noon.', 'The road was being repaired by them at noon.', 'The road was being repaired at noon by them.',
        'At noon, the road was being repaired.', 'At noon the road was being repaired.',
        'At noon, the road was being repaired by them.', 'At noon the road was being repaired by them.',
      ],
        'A past process uses was being repaired.', 'confusion_pair', P.passiveForm),
    ]),
  }),
  6: Object.freeze({
    c: Object.freeze([
      choice(6, ['Complete the first conditional: If the bus is late, we ', ' a taxi.'], ['take', 'will take', 'would take', 'took'], 1,
        'A real future result uses will take.', 'construction_choice', P.conditional, 2,
        optionDiagnostics(['auxiliary'], null, ['confusion_pair', P.firstSecond], ['word_or_verb_form'])),
      choice(6, ['Use the formal second conditional: If I ', ' taller, I would play basketball.'], ['am', 'was', 'were', 'be'], 2,
        'Formal unreal condition uses were.', 'agreement', null, 2,
        optionDiagnostics(['agreement'], ['agreement'], null, ['word_or_verb_form'])),
      choice(6, ['Complete the third conditional: If Leo had checked the map, he ', ' lost.'], ["wouldn't get", "wouldn't have got", "won't get", "didn't get"], 1,
        'An unreal past result uses would not have got.', 'confusion_pair', P.secondThird, 3,
        optionDiagnostics(['confusion_pair', P.secondThird], null, ['construction_choice', P.conditional], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(6, 'If water _____ (REACH) 100°C, it boils.', 'REACH', 'reaches',
        'A scientific fact uses the zero conditional.', 'construction_choice', P.conditional),
      input(6, 'If metal _____ (GET) hot, it expands.', 'GET', 'gets',
        'A general fact uses Present Simple in both clauses.', 'construction_choice', P.conditional),
      input(6, 'If Nora _____ (SET) an alarm, she would not have missed the flight.', 'SET', 'had set',
        'The unreal past condition uses had + V3.', 'construction_choice', P.conditional, 3),
    ]),
    correction: Object.freeze([
      correction(6, 'Исправьте first conditional: If it will rain, we will stay inside.', 'If it rains, we will stay inside.',
        'After if, use Present Simple for a real future condition.', 'construction_choice', P.conditional),
      correction(6, 'Исправьте zero conditional: If you will mix blue and yellow, you get green.', 'If you mix blue and yellow, you get green.',
        'A general fact uses Present Simple in both clauses.', 'construction_choice', P.conditional),
      correction(6, 'Исправьте согласование: If I was you, I would apologise.', 'If I were you, I would apologise.',
        'Formal second conditional uses were with I.', 'agreement'),
      correction(6, 'Исправьте формальный second conditional: If he was here, he would help us.', 'If he were here, he would help us.',
        'Formal second conditional uses were.', 'agreement'),
      correction(6, 'Исправьте смешение типов: If she knew the answer yesterday, she would have told us.', 'If she had known the answer yesterday, she would have told us.',
        'An unreal past condition requires had known.', 'confusion_pair', P.secondThird),
      correction(6, 'Исправьте смешение типов: If they had left now, they would arrive earlier.', 'If they left now, they would arrive earlier.',
        'An unreal present condition uses Past Simple, not Past Perfect.', 'confusion_pair', P.secondThird),
      correction(6, 'Исправьте отрицание в результате: If I had known, I would not told him.', 'If I had known, I would not have told him.',
        'Third conditional negative result is would not have + V3.', 'negation_or_question'),
      correction(6, 'Исправьте отрицание в результате: If she had called, I would not answered her.', 'If she had called, I would not have answered her.',
        'Third conditional negative result is would not have + V3.', 'negation_or_question'),
    ]),
    transform: Object.freeze([
      transform(6, 'Соедините в first conditional с помощью if: It may snow. We will cancel the trip.', ['If it snows, we will cancel the trip.', 'We will cancel the trip if it snows.'],
        'Use Present Simple after if and will in the result.', 'construction_choice', P.conditional),
      transform(6, 'Соедините в first conditional с помощью if: It may rain. We will stay home.', ['If it rains, we will stay home.', 'We will stay home if it rains.'],
        'Use Present Simple after if and will in the result.', 'construction_choice', P.conditional),
      transform(6, 'Сделайте нереальным настоящее: I do not know her number, so I cannot call her.', [
        'If I knew her number, I could call her.', 'If I knew her number, I would be able to call her.',
        'I could call her if I knew her number.', 'I would be able to call her if I knew her number.',
      ],
        'The unreal present condition uses Past Simple.', 'confusion_pair', P.secondThird),
      transform(6, 'Сделайте нереальным прошлое: We missed the bus, so we were late.', [
        "If we hadn't missed the bus, we wouldn't have been late.", "If we hadn't missed the bus, we would not have been late.",
        "If we had not missed the bus, we wouldn't have been late.", 'If we had not missed the bus, we would not have been late.',
        "We wouldn't have been late if we hadn't missed the bus.", "We wouldn't have been late if we had not missed the bus.",
        "We would not have been late if we hadn't missed the bus.", 'We would not have been late if we had not missed the bus.',
      ],
        'The unreal past uses had not + V3 and would not have + V3.', 'confusion_pair', P.secondThird),
      transform(6, 'Поставьте first conditional в отрицание результата: If she calls, I will answer.', ["If she calls, I won't answer.", 'If she calls, I will not answer.'],
        'Negate will in the result clause.', 'negation_or_question'),
      transform(6, 'Поставьте first conditional в отрицание результата: If they arrive, we will leave.', ["If they arrive, we won't leave.", 'If they arrive, we will not leave.'],
        'Negate will in the result clause.', 'negation_or_question'),
      transform(6, 'Раскройте формы third conditional: If he (STUDY), he (PASS) the exam.', 'If he had studied, he would have passed the exam.',
        'Use had + V3 and would have + V3.', 'auxiliary'),
      transform(6, 'Раскройте отрицательные формы third conditional: If they (NOT LEAVE) late, they (NOT MISS) the train.', [
        "If they hadn't left late, they wouldn't have missed the train.", "If they hadn't left late, they would not have missed the train.",
        "If they had not left late, they wouldn't have missed the train.", 'If they had not left late, they would not have missed the train.',
      ],
        'Both clauses need the third-conditional auxiliaries.', 'auxiliary'),
    ]),
  }),
  7: Object.freeze({
    c: Object.freeze([
      choice(7, ['Backshift will after said: Olga said she ', ' email me the next day.'], ['will', 'would', 'can', 'had'], 1,
        'Will normally backshifts to would.', 'confusion_pair', P.willWould, 2,
        optionDiagnostics(['confusion_pair', P.willWould], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(7, ['Use statement order in the reported question: He asked where the station ', '.'], ['was', 'was it', 'did the station be', 'being'], 0,
        'A reported question uses where the station was.', 'word_order', P.reportedQuestion, 2,
        optionDiagnostics(null, ['word_order', P.reportedQuestion], ['word_order', P.reportedQuestion], ['word_or_verb_form'])),
      choice(7, ['Show the earlier action in reported speech: Mia said she ', ' the key before lunch.'], ['lost', 'has lost', 'had lost', 'loses'], 2,
        'The earlier past action backshifts to Past Perfect.', 'confusion_pair', P.reportedPast, 3,
        optionDiagnostics(['confusion_pair', P.reportedPast], ['word_or_verb_form'], null, ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(7, 'Complete this later report using backshift: Ben said he _____ (NOT LIKE) the film.', 'NOT LIKE', ["didn't like", 'did not like'],
        'The present statement backshifts to Past Simple.', 'construction_choice', P.reported),
      input(7, 'Complete this later report using backshift: Lena said she _____ (VISIT) Rome the year before.', 'VISIT', 'had visited',
        'An earlier past action backshifts to Past Perfect.', 'construction_choice', P.reported),
      input(7, 'Complete this later report using backshift: The teacher asked why I _____ (BE) late.', 'BE', 'was',
        'The reported question uses statement order and backshift.', 'construction_choice', P.reported),
    ]),
    correction: Object.freeze([
      correction(7, 'Исправьте backshift: He said, “I am tired.” → He said he is tired.', 'He said he was tired.',
        'The reported past context backshifts am to was.', 'construction_choice', P.reported),
      correction(7, 'Исправьте backshift: She said, “I am busy.” → She said she is busy.', 'She said she was busy.',
        'The reported past context backshifts am to was.', 'construction_choice', P.reported),
      correction(7, 'Исправьте will: Tom said he will call the next day.', 'Tom said he would call the next day.',
        'Will backshifts to would.', 'confusion_pair', P.willWould),
      correction(7, 'Исправьте will: Anna promised that she will return the following week.', 'Anna promised that she would return the following week.',
        'The future-in-the-past form is would return.', 'confusion_pair', P.willWould),
      correction(7, 'Исправьте порядок слов: He asked where did I live.', 'He asked where I lived.',
        'Reported questions use statement word order.', 'word_order', P.reportedQuestion),
      correction(7, 'Исправьте порядок слов: She asked what was I doing.', 'She asked what I was doing.',
        'Put the subject before the verb in a reported question.', 'word_order', P.reportedQuestion),
      correction(7, 'Исправьте косвенный вопрос: He asked did I need help.', ['He asked if I needed help.', 'He asked whether I needed help.'],
        'A yes/no reported question uses if or whether and statement order.', 'negation_or_question'),
      correction(7, 'Исправьте косвенный вопрос: She asked that I was ready.', ['She asked if I was ready.', 'She asked whether I was ready.'],
        'Use if or whether for a reported yes/no question.', 'negation_or_question'),
    ]),
    transform: Object.freeze([
      transform(7, 'Report later using backshift: Maya said, “I live in Omsk.”', ['Maya said she lived in Omsk.', 'Maya said that she lived in Omsk.'],
        'Present Simple backshifts to Past Simple.', 'construction_choice', P.reported),
      transform(7, 'Report later using backshift: Leo said, “I work from home.”', ['Leo said he worked from home.', 'Leo said that he worked from home.'],
        'Present Simple backshifts to Past Simple.', 'construction_choice', P.reported),
      transform(7, 'Report later using backshift: Nina said, “I will call tomorrow.”', [
        'Nina said she would call the next day.', 'Nina said that she would call the next day.',
        'Nina said she would call the following day.', 'Nina said that she would call the following day.',
      ],
        'Will becomes would and tomorrow becomes the next or following day.', 'confusion_pair', P.willWould),
      transform(7, 'Report later using backshift: Dan said, “I will finish the work tonight.”', ['Dan said he would finish the work that night.', 'Dan said that he would finish the work that night.'],
        'Will and tonight shift in reported speech.', 'confusion_pair', P.willWould, 3),
      transform(7, 'Report the question later using backshift: “Where do you work?” she asked me.', 'She asked me where I worked.',
        'Use statement order without do.', 'word_order', P.reportedQuestion),
      transform(7, 'Report the question later using backshift: “Why are you laughing?” he asked me.', 'He asked me why I was laughing.',
        'Use statement order in the reported question.', 'word_order', P.reportedQuestion),
      transform(7, 'Report the yes/no question later using backshift: “Are you ready?” she asked me.', ['She asked me if I was ready.', 'She asked me whether I was ready.'],
        'Use if or whether for a yes/no reported question.', 'negation_or_question'),
      transform(7, 'Report the yes/no question later using backshift: “Did you see the sign?” he asked me.', ['He asked me if I had seen the sign.', 'He asked me whether I had seen the sign.'],
        'Use if or whether and backshift Past Simple to Past Perfect.', 'negation_or_question', null, 3),
    ]),
  }),
  8: Object.freeze({
    c: Object.freeze([
      choice(8, ['Choose lack of necessity, not prohibition: You ', ' bring food; lunch is provided.'], ["mustn't", "don't have to", "can't", "shouldn't"], 1,
        'Do not have to means there is no necessity.', 'confusion_pair', P.prohibition, 2,
        optionDiagnostics(['confusion_pair', P.prohibition], null, ['construction_choice', P.modalMeaning], ['construction_choice', P.modalMeaning])),
      choice(8, ['Choose polite permission: ', ' I borrow your charger, please?'], ['Must', 'May', 'Have to', 'Should'], 1,
        'May I is a polite request for permission.', 'construction_choice', P.permission, 2,
        optionDiagnostics(['construction_choice', P.permission], null, ['construction_choice', P.permission], ['construction_choice', P.modalMeaning])),
      choice(8, ['Choose past general ability: At six, Ava ', ' read short books.'], ['can', 'could', 'must', 'may'], 1,
        'Could expresses general ability in the past.', 'confusion_pair', P.canCould, 2,
        optionDiagnostics(['confusion_pair', P.canCould], null, ['construction_choice', P.modalMeaning], ['construction_choice', P.permission])),
    ]),
    f: Object.freeze([
      input(8, 'You _____ (NOT HAVE TO) print the ticket; the digital copy is accepted.', 'NOT HAVE TO', ["don't have to", 'do not have to'],
        'The action is optional, so use do not have to.', 'confusion_pair', P.prohibition),
      input(8, 'Visitors _____ (MUST NOT) touch the paintings.', 'MUST NOT', ["mustn't", 'must not'],
        'A strict prohibition uses must not.', 'confusion_pair', P.prohibition),
      input(8, '_____ (MAY) I use this seat, please?', 'MAY', 'May',
        'May I asks for polite permission.', 'construction_choice', P.permission),
      input(8, 'When he was four, Max _____ (CAN) count to one hundred.', 'CAN', 'could',
        'Past general ability uses could.', 'confusion_pair', P.canCould),
      input(8, 'You _____ (SHOULD) back up the file before updating.', 'SHOULD', 'should',
        'Should gives advice.', 'construction_choice', P.modalMeaning),
      input(8, 'Students _____ (MAY) use dictionaries during this task.', 'MAY', 'may',
        'May grants permission.', 'construction_choice', P.permission),
      input(8, 'You _____ (SHOULD NOT) share your password.', 'SHOULD NOT', ["shouldn't", 'should not'],
        'Should not gives advice against an action.', 'construction_choice', P.modalMeaning),
      input(8, 'She _____ (NOT CAN) attend yesterday because she was ill.', 'NOT CAN', ["couldn't", 'could not'],
        'Past inability uses could not.', 'confusion_pair', P.canCould),
    ]),
    correction: Object.freeze([
      correction(8, 'Исправьте значение: You must not pay; admission is free.', ["You don't have to pay; admission is free.", 'You do not have to pay; admission is free.'],
        'Free admission means no necessity, not prohibition.', 'confusion_pair', P.prohibition),
      correction(8, 'Исправьте значение запрета: You do not have to enter; staff only.', [
        "You mustn't enter; staff only.", 'You must not enter; staff only.',
        "You can't enter; staff only.", 'You cannot enter; staff only.',
      ],
        'Staff only expresses prohibition; must not or cannot is valid.', 'confusion_pair', P.prohibition),
      correction(8, 'Уберите to после модального: She can to swim.', 'She can swim.',
        'A modal verb takes the bare infinitive.', 'auxiliary'),
      correction(8, 'Уберите окончание после модального: He musts leave now.', 'He must leave now.',
        'Modal verbs do not take third-person -s.', 'auxiliary'),
      correction(8, 'Исправьте форму прошлого: Yesterday I must finish the report.', 'Yesterday I had to finish the report.',
        'Past external necessity uses had to.', 'word_or_verb_form'),
      correction(8, 'Исправьте форму прошлого: Last week she must work late.', 'Last week she had to work late.',
        'Past external necessity uses had to.', 'word_or_verb_form'),
      correction(8, 'Исправьте вопрос: Do I may leave early?', 'May I leave early?',
        'A modal itself moves before the subject.', 'negation_or_question'),
      correction(8, 'Исправьте вопрос: Does she can drive?', 'Can she drive?',
        'A modal itself moves before the subject; do not use does.', 'negation_or_question'),
    ]),
    transform: Object.freeze([
      transform(8, 'Передайте отсутствие необходимости с do not have to: It is not necessary for you to book.', ["You don't have to book.", 'You do not have to book.'],
        'No necessity is do not have to.', 'confusion_pair', P.prohibition),
      transform(8, 'Передайте запрет с must not: Parking here is forbidden.', ["You mustn't park here.", 'You must not park here.'],
        'A prohibition is must not.', 'confusion_pair', P.prohibition),
      transform(8, 'Дайте совет с should: It is a good idea to rest.', 'You should rest.',
        'Should expresses advice.', 'construction_choice', P.modalMeaning),
      transform(8, 'Дайте совет с should: It is a good idea to save a copy.', 'You should save a copy.',
        'Should expresses advice.', 'construction_choice', P.modalMeaning),
      transform(8, 'Поставьте в вопрос: I may open the window.', 'May I open the window?',
        'Move may before the subject.', 'negation_or_question'),
      transform(8, 'Поставьте в вопрос: He can swim.', 'Can he swim?',
        'Move can before the subject.', 'negation_or_question'),
      transform(8, 'Передайте прошлую необходимость: I must work late yesterday.', 'I had to work late yesterday.',
        'Had to is the past form for necessity.', 'word_or_verb_form'),
      transform(8, 'Передайте прошлую необходимость: She must work late yesterday.', 'She had to work late yesterday.',
        'Had to is the past form for necessity.', 'word_or_verb_form'),
    ]),
  }),
  9: Object.freeze({
    c: Object.freeze([
      choice(9, ['We decided ', ' the earlier train.'], ['take', 'taking', 'to take', 'took'], 2,
        'Decide is followed by the to-infinitive.', 'confusion_pair', P.verbPattern, 2,
        optionDiagnostics(['word_or_verb_form'], ['confusion_pair', P.verbPattern], null, ['word_or_verb_form'])),
      choice(9, [
        'Choose stop to do for a purpose, not an activity already in progress: On the long drive, we stopped ',
        ' some coffee before we had taken the first sip, then continued the drive.',
      ], ['drinking', 'to drink', 'drink', 'drank'], 1,
        'We paused another action in order to drink.', 'confusion_pair', P.stopPattern, 2,
        optionDiagnostics(['confusion_pair', P.stopPattern], null, ['word_or_verb_form'], ['word_or_verb_form'])),
      choice(9, ['The coach made us ', ' the exercise again.'], ['to repeat', 'repeating', 'repeat', 'repeated'], 2,
        'Make + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive, 2,
        optionDiagnostics(['confusion_pair', P.bareInfinitive], ['word_or_verb_form'], null, ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(9, 'I hope _____ (SEE) you again soon.', 'SEE', 'to see',
        'Hope is followed by the to-infinitive.', 'confusion_pair', P.verbPattern),
      input(9, 'She finished _____ (WRITE) the report before lunch.', 'WRITE', 'writing',
        'Finish is followed by a gerund.', 'confusion_pair', P.verbPattern),
      input(9, 'My parents let me _____ (CHOOSE) the course.', 'CHOOSE', 'choose',
        'Let + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive),
    ]),
    correction: Object.freeze([
      correction(9, 'Исправьте форму после enjoy: I enjoy to read before bed.', 'I enjoy reading before bed.',
        'Enjoy is followed by a gerund.', 'confusion_pair', P.verbPattern),
      correction(9, 'Исправьте форму после decide: We decided staying home.', 'We decided to stay home.',
        'Decide is followed by the to-infinitive.', 'confusion_pair', P.verbPattern),
      correction(9, 'Исправьте значение: He stopped to smoke last year and has not smoked since.', 'He stopped smoking last year and has not smoked since.',
        'Stop doing means end the activity.', 'confusion_pair', P.stopPattern),
      correction(9, 'Исправьте значение, передав цель остановки: We stopped talking to ask for directions.', 'We stopped to ask for directions.',
        'Stop to do means pause in order to do something else.', 'confusion_pair', P.stopPattern),
      correction(9, 'Исправьте форму после make: The joke made me to laugh.', 'The joke made me laugh.',
        'Make + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive),
      correction(9, 'Исправьте форму после let: Let her to explain.', 'Let her explain.',
        'Let + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive),
      correction(9, 'Исправьте форму после look forward to: I look forward to meet you.', 'I look forward to meeting you.',
        'To is a preposition here and is followed by a gerund.', 'word_or_verb_form'),
      correction(9, 'Исправьте форму после предлога: She left without to say goodbye.', 'She left without saying goodbye.',
        'A preposition is followed by a gerund.', 'word_or_verb_form'),
    ]),
    transform: Object.freeze([
      transform(9, 'Объедините с enjoy: I read detective stories. I enjoy it.', 'I enjoy reading detective stories.',
        'Enjoy is followed by a gerund.', 'confusion_pair', P.verbPattern),
      transform(9, 'Объедините с decide: We will leave early. We decided this.', 'We decided to leave early.',
        'Decide is followed by the to-infinitive.', 'confusion_pair', P.verbPattern),
      transform(9, 'Передайте прекращение привычки с stop: He no longer eats sweets.',
        ['He stopped eating sweets.', 'He has stopped eating sweets.'],
        'Stop doing means discontinue an activity.', 'confusion_pair', P.stopPattern),
      transform(9, 'Передайте цель остановки с stop: We paused the car because we wanted to rest.', 'We stopped to rest.',
        'Stop to do expresses the purpose of the pause.', 'confusion_pair', P.stopPattern),
      transform(9, 'Перепишите с make: The teacher forced us to rewrite the essay.', 'The teacher made us rewrite the essay.',
        'Make + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive),
      transform(9, 'Перепишите с let: Mum allowed me to stay up late.', 'Mum let me stay up late.',
        'Let + object takes the bare infinitive.', 'confusion_pair', P.bareInfinitive),
      transform(9, 'Раскройте форму после suggest: She suggested (TAKE) a break.', 'She suggested taking a break.',
        'Suggest is followed by a gerund.', 'word_or_verb_form'),
      transform(9, 'Раскройте форму после promise: He promised (CALL) after class.', 'He promised to call after class.',
        'Promise is followed by the to-infinitive.', 'word_or_verb_form'),
    ]),
  }),
  18: Object.freeze({
    c: Object.freeze([
      choice(18, ['Choose the auxiliary for a present object question: What ', ' Lena usually cook?'], ['does', 'is', 'do', 'did'], 0,
        'Present Simple with Lena requires does.', 'auxiliary', null, 2,
        optionDiagnostics(null, ['auxiliary'], ['agreement'], ['word_or_verb_form'])),
      choice(18, ['Choose the subject-question form: Who ', ' this message last night?'], ['sent', 'did sent', 'was send', 'send'], 0,
        'A subject question does not use did.', 'word_order', P.subjectQuestion, 2,
        optionDiagnostics(null, ['word_or_verb_form'], ['auxiliary'], ['word_or_verb_form'])),
      choice(18, ['Use statement order in the indirect question: Could you tell me where the library ', '?'], ['is', 'is it', 'are', 'it is'], 0,
        'The indirect question uses where the library is.', 'word_order', P.questionOrder, 2,
        optionDiagnostics(null, ['word_order', P.questionOrder], ['agreement'], ['word_or_verb_form'])),
    ]),
    f: Object.freeze([
      input(18, 'Where _____ (YOUR PARENTS / LIVE)?', 'LIVE', 'do your parents live',
        'Present Simple question order is do + subject + base verb.', 'auxiliary'),
      input(18, 'Who _____ (CALL) you after class yesterday?', 'CALL', 'called',
        'A subject question uses the lexical verb without did.', 'auxiliary'),
      input(18, 'You have finished, _____ you?', 'HAVE', "haven't",
        'A positive Present Perfect statement takes a negative tag.', 'negation_or_question', P.questionTag),
      input(18, 'She cannot drive, _____ she?', 'CAN', 'can',
        'A negative statement takes a positive tag.', 'negation_or_question', P.questionTag),
      input(18, 'I wonder where he _____ (WORK).', 'WORK', 'works',
        'An indirect question uses statement order.', 'word_order', P.questionOrder),
      input(18, 'Could you tell me what time the shop _____ (OPEN)?', 'OPEN', 'opens',
        'The embedded clause uses statement order.', 'word_order', P.questionOrder),
      input(18, 'Who _____ (SEND) this message last night?', 'SEND', 'sent',
        'A subject question uses the lexical verb without did.', 'auxiliary'),
      input(18, 'Why _____ (SHE / LEAVE) early every day?', 'LEAVE', 'does she leave',
        'Present Simple object question uses does + subject + base verb.', 'auxiliary'),
    ]),
    correction: Object.freeze([
      correction(18, 'Исправьте вопрос: Where your sister works?', 'Where does your sister work?',
        'Present Simple object questions need does.', 'auxiliary'),
      correction(18, 'Исправьте вопрос: What he buy yesterday?', 'What did he buy yesterday?',
        'A Past Simple object question requires did.', 'auxiliary'),
      correction(18, 'Исправьте вопрос к подлежащему: Who did break the glass?', 'Who broke the glass?',
        'A subject question does not use did.', 'word_order', P.subjectQuestion),
      correction(18, 'Исправьте вопрос к подлежащему: Who does live next door?', 'Who lives next door?',
        'A subject question uses the lexical verb directly.', 'word_order', P.subjectQuestion),
      correction(18, 'Исправьте хвост: She is ready, does not she?', ["She is ready, isn't she?", 'She is ready, is she not?'],
        'The tag repeats be and changes polarity.', 'negation_or_question', P.questionTag),
      correction(18, 'Исправьте хвост: They went home, do not they?', ["They went home, didn't they?", 'They went home, did they not?'],
        'A positive Past Simple statement takes did not in the tag.', 'negation_or_question', P.questionTag),
      correction(18, 'Исправьте косвенный вопрос: I wonder where does he live.', 'I wonder where he lives.',
        'An indirect question uses statement order.', 'word_order', P.questionOrder),
      correction(18, 'Исправьте косвенный вопрос: Could you tell me when will the film start?', 'Could you tell me when the film will start?',
        'Put the subject before will in the embedded clause.', 'word_order', P.questionOrder),
    ]),
    transform: Object.freeze([
      transform(18, 'Составьте вопрос к дополнению: Lena reads science fiction. — What ...?', 'What does Lena read?',
        'Use does + subject + base verb.', 'auxiliary'),
      transform(18, 'Составьте вопрос в Past Simple: They arrived at six. — When ...?', 'When did they arrive?',
        'Use did + subject + base verb.', 'auxiliary'),
      transform(18, 'Задайте вопрос к подлежащему: Someone opened the door.', 'Who opened the door?',
        'A subject question does not use did.', 'word_order', P.subjectQuestion),
      transform(18, 'Задайте вопрос к подлежащему: Someone helps Maya every day.', 'Who helps Maya every day?',
        'The subject question keeps third-person -s.', 'word_order', P.subjectQuestion),
      transform(18, 'Добавьте question tag: You can swim, ...', ["You can swim, can't you?", 'You can swim, can you not?'],
        'A positive statement takes a negative tag.', 'negation_or_question', P.questionTag),
      transform(18, 'Добавьте question tag: She is not late, ...', ["She isn't late, is she?", 'She is not late, is she?'],
        'A negative statement takes a positive tag.', 'negation_or_question', P.questionTag),
      transform(18, 'Сделайте вопрос косвенным, начав с I wonder: Where does Tom work?', 'I wonder where Tom works.',
        'The embedded clause uses statement order.', 'word_order', P.questionOrder),
      transform(18, 'Сделайте вопрос косвенным, начав с Could you tell me: When will the train arrive?', 'Could you tell me when the train will arrive?',
        'The embedded clause keeps subject before will.', 'word_order', P.questionOrder),
    ]),
  }),
});

const eightPairPlan = Object.freeze([1, 2, 3, 4, 1, 2, 3, 4]);
const sequentialPairPlan = Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]);
export const ACTIVE_VERB_CONSTRUCTIONS_TRANSFER_PAIR_PLANS = Object.freeze({
  5: Object.freeze({ c: Object.freeze([1, 2, 1, 3, 4, 2, 3, 4]), f: Object.freeze([1, 2, 3, 1, 4, 3, 2, 4]), correction: sequentialPairPlan, transform: sequentialPairPlan }),
  6: Object.freeze({ c: Object.freeze([1, 2, 3, 4, 4, 1, 2, 3]), f: Object.freeze([1, 2, 1, 2, 3, 4, 4, 3]), correction: sequentialPairPlan, transform: sequentialPairPlan }),
  7: Object.freeze({ c: eightPairPlan, f: Object.freeze([1, 2, 3, 4, 2, 1, 3, 4]), correction: sequentialPairPlan, transform: sequentialPairPlan }),
  8: Object.freeze({ c: eightPairPlan, f: Object.freeze([1, 1, 2, 3, 4, 2, 4, 3]), correction: sequentialPairPlan, transform: sequentialPairPlan }),
  9: Object.freeze({ c: eightPairPlan, f: eightPairPlan, correction: sequentialPairPlan, transform: sequentialPairPlan }),
  18: Object.freeze({ c: Object.freeze([1, 2, 3, 3, 4, 1, 2, 4]), f: Object.freeze([1, 2, 3, 3, 4, 4, 2, 1]), correction: sequentialPairPlan, transform: sequentialPairPlan }),
});
