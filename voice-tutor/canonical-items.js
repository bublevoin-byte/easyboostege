import { voiceTutorModule } from './modules.js';

export function createContextVoiceTutorItem(definition) {
  const context = voiceTutorModule(definition.module)?.context;
  if (!context) return null;
  return Object.freeze({
    id: definition.id,
    revision: 1,
    module: definition.module,
    prompt: definition.prompt,
    options: Object.freeze([...definition.options]),
    reference: Object.freeze([definition.options[definition.answer]]),
    context: Object.freeze({
      kind: context.kind,
      label: context.label,
      text: definition.evidence,
    }),
    errorType: 'unsupported_choice',
    skill: Object.freeze({
      ...context.skill,
    }),
    rule: Object.freeze({
      id: context.rule.id,
      revision: 1,
      title: context.rule.title,
      explanation: definition.explanation,
      examples: Object.freeze([context.rule.example]),
    }),
    microCheck: Object.freeze({
      id: `${definition.id}.micro.v1`,
      prompt: context.microCheck.prompt,
      answers: context.microCheck.answers,
    }),
    transferTask: Object.freeze({
      id: `${definition.id}.transfer.v1`,
      prompt: context.transferTask.prompt,
      answers: context.transferTask.answers,
    }),
  });
}

const CONTEXT_SET_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'reading.exam.questions.gap-year', revision: 1, module: 'reading', items: Object.freeze([
      { id: 'reading.gap-year.before-university', prompt: 'What do many British students do before university?', options: ['They take exams again', 'They take a year off', 'They start full-time careers', 'They move abroad for good'], answer: 1, evidence: 'Many British students take a gap year before university.', explanation: 'Take a gap year означает взять год перерыва перед университетом.' },
      { id: 'reading.gap-year.parents-fear', prompt: 'What are some parents afraid of?', options: ['Money problems', 'Danger during travel', 'That children will not return to study', 'Bad school marks'], answer: 2, evidence: 'Some parents are afraid that after a long break their children will not want to return to studying.', explanation: 'Фрагмент прямо называет страх: дети не захотят вернуться к учёбе.' },
      { id: 'reading.gap-year.first-year-marks', prompt: 'According to universities, gap-year students usually…', options: ['get better first-year marks', 'miss more lessons', 'choose easier subjects', 'leave university earlier'], answer: 0, evidence: 'Universities report that gap-year students usually get better marks in the first year.', explanation: 'В тексте прямо сказано о лучших оценках на первом курсе.' },
      { id: 'reading.gap-year.expert-advice', prompt: 'What do experts advise?', options: ['To stay at home', 'To plan the year carefully', 'To avoid working', 'To skip the gap year'], answer: 1, evidence: 'Experts advise planning the year carefully.', explanation: 'Совет экспертов дословно совпадает с вариантом о тщательном планировании.' },
    ]),
  }),
  Object.freeze({
    id: 'reading.exam.questions.smartphones', revision: 1, module: 'reading', items: Object.freeze([
      { id: 'reading.smartphones.after-ban', prompt: 'What happened after the smartphone ban?', options: ['Students became lonely', 'Students talk and play more', 'Parents visited school more often', 'Lessons became longer'], answer: 1, evidence: 'Students talk to each other more and play active games in the yard again.', explanation: 'После запрета ученики стали больше разговаривать и играть.' },
      { id: 'reading.smartphones.parent-concern', prompt: 'Why are many parents unhappy about the ban?', options: ['Phones are expensive', 'They cannot contact their children', 'Children play too much', 'Teachers became stricter'], answer: 1, evidence: 'Many parents want to be able to contact their children at any moment.', explanation: 'Родителей беспокоит невозможность связаться с детьми в любой момент.' },
      { id: 'reading.smartphones.study-tools', prompt: 'How do phones help students, according to some of them?', options: ['They give study tools', 'They help make friends', 'They improve sport results', 'They help fall asleep'], answer: 0, evidence: 'They use dictionaries, calculators and educational apps.', explanation: 'Перечислены словари, калькуляторы и учебные приложения — инструменты для учёбы.' },
      { id: 'reading.smartphones.compromise', prompt: 'What compromise do scientists suggest?', options: ['Shorter lessons', 'No homework', 'Phones in boxes during lessons', 'Moving school online'], answer: 2, evidence: 'Keep phones in special boxes during lessons and return them after classes.', explanation: 'Компромисс — хранить телефоны в коробках во время уроков.' },
    ]),
  }),
  Object.freeze({
    id: 'reading.exam.questions.volunteering', revision: 1, module: 'reading', items: Object.freeze([
      { id: 'reading.volunteering.activities', prompt: 'What did teenagers do as volunteers?', options: ['They built new houses', 'They helped shelters and elderly people', 'They taught at schools', 'They worked only in hospitals'], answer: 1, evidence: 'They helped animal shelters, visited elderly people and cleaned parks.', explanation: 'Фрагмент перечисляет помощь приютам и пожилым людям.' },
      { id: 'reading.volunteering.benefits', prompt: 'What do psychologists say about volunteering?', options: ['It takes too much time', 'It builds confidence and teamwork', 'It is dangerous for teens', 'It is only for adults'], answer: 1, evidence: 'Volunteering makes teenagers more confident and teaches them to work in a team.', explanation: 'Психологи называют уверенность и командную работу.' },
      { id: 'reading.volunteering.future-value', prompt: 'How can volunteering help in the future?', options: ['It guarantees any job', 'Universities and companies value it', 'It pays very well', 'It replaces school exams'], answer: 1, evidence: 'Universities pay attention to social activity, and some companies prefer candidates with volunteer experience.', explanation: 'Вузы и работодатели ценят волонтёрский опыт.' },
      { id: 'reading.volunteering.requirements', prompt: 'What do you need to become a volunteer?', options: ['Money', 'Special skills', 'Free time and the wish to help', 'A special diploma'], answer: 2, evidence: 'You do not need money or special skills — only free time and the wish to help.', explanation: 'Нужны свободное время и желание помогать.' },
    ]),
  }),
  Object.freeze({
    id: 'listening.exam.interview.alex', revision: 1, module: 'listening', items: Object.freeze([
      { id: 'listening.alex-swimming.reason', prompt: 'Why did Alex start swimming?', options: ['Doctors recommended sport', 'His friends invited him', 'He watched it on TV'], answer: 0, evidence: 'My mum took me to the pool because I was often ill, and doctors advised sport.', explanation: 'Alex связывает начало занятий с частыми болезнями и советом врачей.' },
      { id: 'listening.alex-swimming.frequency', prompt: 'How often does Alex train?', options: ['Every day', 'Five times a week', 'Only at weekends'], answer: 1, evidence: 'Five times a week, early in the morning before school.', explanation: 'Alex прямо говорит: five times a week.' },
      { id: 'listening.alex-swimming.injury', prompt: 'What happened to Alex last year?', options: ['He left his team', 'He broke his arm', 'He lost the championship'], answer: 1, evidence: 'Last year I broke my arm and missed four months.', explanation: 'Он сломал руку и пропустил четыре месяца.' },
      { id: 'listening.alex-swimming.first-plan', prompt: 'What does Alex want to do first?', options: ['Join the national team', 'Win the city cup', 'Become a coach'], answer: 1, evidence: 'But first I want to win the city cup in May.', explanation: 'Слово first связывает ближайшую цель с кубком города.' },
    ]),
  }),
  Object.freeze({
    id: 'listening.exam.interview.lena', revision: 1, module: 'listening', items: Object.freeze([
      { id: 'listening.lena-blog.started', prompt: 'When did Lena start her blog?', options: ['Two years ago', 'Two months ago', 'Last term'], answer: 0, evidence: 'Two years ago I started posting short videos with study tips.', explanation: 'В начале ответа прямо назван срок: two years ago.' },
      { id: 'listening.lena-blog.helpers', prompt: 'Who helps Lena with her blog?', options: ['Her classmates', 'Her parents', 'Her teachers'], answer: 1, evidence: 'My parents help me with the camera.', explanation: 'С камерой помогают родители.' },
      { id: 'listening.lena-blog.problem', prompt: 'What problem did the blog cause?', options: ['She lost her friends', 'Her marks got worse', 'She stopped sleeping'], answer: 1, evidence: 'My marks went down a little last term.', explanation: 'Проблемой стало снижение оценок.' },
      { id: 'listening.lena-blog.advice', prompt: 'What does Lena advise beginners?', options: ['To buy a good camera', 'To copy popular bloggers', 'To be honest'], answer: 2, evidence: 'Do not copy others. Viewers feel when you are honest.', explanation: 'Главный совет — быть честным и не копировать других.' },
    ]),
  }),
]);

const BASE_ITEMS = {
  'grammar.past-simple.last-summer': Object.freeze({
    id: 'grammar.past-simple.last-summer', revision: 1, module: 'grammar',
    prompt: 'Last summer Kate and her brother _____ to St Petersburg. (GO)',
    reference: Object.freeze(['went']), errorType: 'incorrect_form',
    skill: Object.freeze({ id: 'ege.grammar.past_simple', label: 'Past Simple: неправильные глаголы' }),
    rule: Object.freeze({ id: 'grammar.past-simple.v1', revision: 1, title: 'Past Simple с маркером законченного прошлого', explanation: 'После last summer нужен Past Simple. У неправильного глагола go форма прошедшего времени — went.', examples: Object.freeze(['I went to school yesterday.', 'We bought the tickets last week.']) }),
    microCheck: Object.freeze({ id: 'grammar.past-simple.micro.v1', prompt: 'Yesterday my sister _____ to the library. (GO)', answers: Object.freeze(['went']) }),
    transferTask: Object.freeze({ id: 'grammar.past-simple.transfer.v1', prompt: 'Last week we _____ new books for class. (BUY)', answers: Object.freeze(['bought']) }),
  }),
  'vocabulary.relationship.meaning': Object.freeze({
    id: 'vocabulary.relationship.meaning', revision: 1, module: 'vocabulary',
    prompt: 'Выбери точное значение слова relationship.', reference: Object.freeze(['отношения']), errorType: 'incorrect_meaning',
    skill: Object.freeze({ id: 'ege.vocabulary.meaning_in_context', label: 'Значение слова в контексте' }),
    rule: Object.freeze({ id: 'vocabulary.relationship.v1', revision: 1, title: 'Relationship — отношения или связь', explanation: 'Relationship называет отношения или связь между людьми и понятиями; это не отдельный родственник.', examples: Object.freeze(['They have a close relationship.', 'There is a clear relationship between sleep and memory.']) }),
    microCheck: Object.freeze({ id: 'vocabulary.relationship.micro.v1', prompt: 'Как перевести relationship в сочетании a close relationship?', answers: Object.freeze(['отношения', 'близкие отношения']) }),
    transferTask: Object.freeze({ id: 'vocabulary.relationship.transfer.v1', prompt: 'Complete: Trust is important in every _____.', answers: Object.freeze(['relationship']) }),
  }),
};

const CONTEXT_ITEMS = Object.fromEntries(CONTEXT_SET_DEFINITIONS.flatMap((set) => (
  set.items.map((item) => [item.id, createContextVoiceTutorItem({ ...item, module: set.module })])
)));
const ITEMS = Object.freeze({ ...BASE_ITEMS, ...CONTEXT_ITEMS });
const RESULT_SETS = Object.freeze(Object.fromEntries(CONTEXT_SET_DEFINITIONS.map((set) => [set.id, Object.freeze({
  id: set.id,
  revision: set.revision,
  module: set.module,
  items: Object.freeze(set.items.map((item) => item.id)),
})])));

export function getCanonicalVoiceTutorItem(itemId) {
  return ITEMS[String(itemId || '')] || null;
}

export function getCanonicalVoiceTutorResultSet(setId) {
  return RESULT_SETS[String(setId || '')] || null;
}
