import {
  ACTIVE_TENSES_BANK,
  ACTIVE_TENSES_LEGACY_CHOICE_DIAGNOSTICS,
  ACTIVE_TENSES_LEGACY_META,
  ACTIVE_TENSES_LEGACY_OVERRIDES,
  ACTIVE_TENSES_TRANSFER_PAIR_PLANS,
} from './grammar-tenses-content.js';
import {
  ACTIVE_VERB_CONSTRUCTIONS_BANK,
  ACTIVE_VERB_CONSTRUCTIONS_LEGACY_CHOICE_DIAGNOSTICS,
  ACTIVE_VERB_CONSTRUCTIONS_LEGACY_META,
  ACTIVE_VERB_CONSTRUCTIONS_LEGACY_OVERRIDES,
  ACTIVE_VERB_CONSTRUCTIONS_TRANSFER_PAIR_PLANS,
} from './grammar-verb-constructions-content.js';

// Authored Grammar 1.0 content migrated into the versioned Grammar 2.0 registry.
export const GRAMMAR_CATALOG_CONTENT = {
  "version": "grammar-core-v1",
  "revision": 1,
  "groups": [
    {
      "n": "Времена",
      "ids": [
        1,
        2,
        3,
        13,
        4
      ]
    },
    {
      "n": "Глагол",
      "ids": [
        5,
        6,
        7,
        8,
        9,
        18
      ]
    },
    {
      "n": "Части речи",
      "ids": [
        10,
        11,
        12,
        16,
        17,
        20
      ]
    },
    {
      "n": "Служебные слова",
      "ids": [
        14,
        15,
        19
      ]
    }
  ],
  "topics": {
    "1": {
      "n": "Present Simple и Continuous",
      "th": "<b>Present Simple</b> — регулярные действия, факты: V / V+s (he, she, it).<br>Маркеры: every day, usually, often, never.<br><b>Present Continuous</b> — действие прямо сейчас: am/is/are + V-ing.<br>Маркеры: now, at the moment, Look!, Listen!<br><b>Ловушка ЕГЭ:</b> глаголы состояния (know, like, want, hear, believe) не используются в Continuous."
    },
    "2": {
      "n": "Past Simple и Continuous",
      "th": "<b>Past Simple</b> — завершённое действие в прошлом: V2 / did + V.<br>Маркеры: yesterday, last week, in 2020, ago.<br><b>Past Continuous</b> — процесс в момент прошлого: was/were + V-ing.<br>Маркеры: while, at 5 pm yesterday, when (фон действия).<br><b>Ловушка:</b> длинное действие — Continuous, короткое ворвавшееся — Simple: I <b>was cooking</b> when he <b>came</b>."
    },
    "3": {
      "n": "Present Perfect и Past Simple",
      "th": "<b>Present Perfect</b> — результат к настоящему: have/has + V3.<br>Маркеры: already, just, yet, ever, never, since, for.<br><b>Past Simple</b> — факт в конкретном прошлом: yesterday, last year, in 2019.<br><b>Правило выбора:</b> есть точное время в прошлом → Past Simple. Важен результат сейчас → Present Perfect."
    },
    "4": {
      "n": "Будущее время",
      "th": "<b>will + V</b> — предсказание, спонтанное решение, обещание.<br><b>be going to</b> — намерение или очевидное будущее (Look at the clouds!).<br><b>Present Continuous</b> — личная договорённость (We are flying on Friday).<br><b>Present Simple</b> — расписания: The train <b>leaves</b> at 6.<br><b>Ловушка:</b> после if/when о будущем — настоящее время!"
    },
    "5": {
      "n": "Пассивный залог",
      "th": "<b>Passive</b> = be (в нужном времени) + V3.<br>is/are + V3 — регулярно; was/were + V3 — прошлое;<br>will be + V3 — будущее; is being + V3 — прямо сейчас;<br>has been + V3 — результат.<br><b>Ловушка ЕГЭ:</b> в заданиях 19–24 если подлежащее само не делает действие — это пассив: The bridge <b>was built</b>."
    },
    "6": {
      "n": "Условные предложения",
      "th": "<b>0 тип</b> (факты): If + Present, Present. If you heat ice, it melts.<br><b>1 тип</b> (реально): If + Present, will + V. If it rains, we will stay.<br><b>2 тип</b> (нереально сейчас): If + Past, would + V. If I were you…<br><b>3 тип</b> (нереально в прошлом): If + had V3, would have V3.<br><b>Ловушка:</b> после if НЕ ставим will."
    },
    "7": {
      "n": "Косвенная речь",
      "th": "Сдвиг времён после said/told/asked:<br>Present Simple → Past Simple; Present Perfect / Past Simple → Past Perfect;<br>will → would, can → could, may → might.<br>Вопросы: he asked <b>if</b>… / he asked <b>where I lived</b> (прямой порядок слов!).<br><b>Ловушка:</b> в косвенном вопросе нет do/does/did."
    },
    "8": {
      "n": "Модальные глаголы",
      "th": "<b>must</b> — обязан (сам считаю); <b>have to</b> — вынужден (обстоятельства);<br><b>mustn't</b> — запрещено; <b>don't have to</b> — не обязательно;<br><b>should</b> — совет; <b>can/could</b> — умение, возможность;<br><b>may/might</b> — разрешение, вероятность.<br><b>Ловушка:</b> после модальных — инфинитив без to (кроме have to, ought to)."
    },
    "9": {
      "n": "Инфинитив и герундий",
      "th": "<b>Герундий (V-ing)</b> после: enjoy, avoid, mind, suggest, finish, stop, look forward to, предлогов.<br><b>Инфинитив с to</b> после: want, decide, hope, plan, promise, it is easy…<br><b>Без to</b> после: let, make, модальных.<br><b>Ловушка:</b> stop doing — перестать делать; stop to do — остановиться, чтобы сделать."
    },
    "10": {
      "n": "Степени сравнения",
      "th": "Короткие прилагательные: -er / the -est (big → bigger → the biggest).<br>Длинные: more / the most interesting.<br><b>Исключения:</b> good → better → best; bad → worse → worst; far → further; little → less; many/much → more → most.<br><b>Конструкции:</b> as … as, than.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD в сравнении — это better/best."
    },
    "11": {
      "n": "Местоимения",
      "th": "<b>Притяжательные:</b> my/your/his/her/its/our/their + сущ.; без сущ. — mine, yours, hers, theirs.<br><b>Возвратные:</b> myself, himself, herself, itself, ourselves, themselves.<br><b>some/any:</b> some — утверждение, any — вопрос и отрицание.<br><b>Ловушка:</b> its (его) без апострофа; it's = it is."
    },
    "12": {
      "n": "Числительные",
      "th": "<b>Порядковые:</b> the first, second, third, дальше -th: fifth (!), ninth (!), twelfth (!), twentieth.<br>Даты: on the fifth of May.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово TWO/FIVE часто нужно превратить в second/fifth (этаж, место, день рождения).<br>hundreds/thousands <b>of</b> people, но two hundred people."
    },
    "13": {
      "n": "Past Perfect",
      "th": "<b>Past Perfect</b> = had + V3 — действие, которое случилось <b>раньше</b> другого действия в прошлом.<br>Маркеры: by the time, before, after, already (к моменту прошлого).<br>Пример: When we arrived, the film <b>had started</b> — фильм начался ДО нашего прихода.<br><b>Ловушка:</b> если действия идут просто по порядку, Past Perfect не нужен — оба в Past Simple."
    },
    "14": {
      "n": "Артикли",
      "th": "<b>a/an</b> — один из многих, впервые упомянутый: I saw <b>a</b> cat.<br><b>the</b> — конкретный, известный или единственный: <b>the</b> sun, the cat from our yard, превосходная степень (the best).<br><b>Без артикля:</b> имена, большинство стран, языки, приёмы пищи (have breakfast), go to school.<br><b>Ловушка:</b> the USA, the UK — c the; play <b>the</b> piano, но play football."
    },
    "15": {
      "n": "Предлоги",
      "th": "<b>Время:</b> at 5, at night · on Monday, on the 5th of May · in June, in 2020, in the morning.<br><b>Место:</b> at school, at home · in the room, in Moscow · on the wall.<br><b>Устойчивые:</b> depend <b>on</b>, good <b>at</b>, afraid <b>of</b>, interested <b>in</b>, listen <b>to</b>, wait <b>for</b>.<br><b>Ловушка:</b> in the morning, но at night; on TV, on the Internet."
    },
    "16": {
      "n": "Множественное число",
      "th": "Обычно +s/es. <b>Исключения — учи наизусть:</b> man → men, woman → women, child → children, foot → feet, tooth → teeth, mouse → mice, person → people, sheep → sheep.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово CHILD/MAN в скобках почти всегда просит форму множественного числа: children, men. People — уже множественное: people <b>are</b>."
    },
    "17": {
      "n": "Прилагательные -ing и -ed",
      "th": "<b>-ing</b> — сам предмет вызывает чувство: The film is <b>boring</b> (фильм скучный).<br><b>-ed</b> — человек испытывает чувство: I am <b>bored</b> (мне скучно).<br>Пары: interesting/interested, exciting/excited, tiring/tired, surprising/surprised.<br><b>Приём:</b> спроси «кто испытывает чувство?» Если человек — ставь -ed."
    },
    "18": {
      "n": "Вопросы и порядок слов",
      "th": "Вопрос: <b>вопросительное слово + вспомогательный + подлежащее + глагол</b>: Where <b>does she</b> live?<br>Вопрос к подлежащему — БЕЗ do/does/did: Who <b>broke</b> the window?<br><b>Разделительный вопрос:</b> утверждение + отрицательный хвост: You like tea, <b>don't you</b>?<br><b>Ловушка:</b> в косвенном вопросе прямой порядок слов: I wonder where she <b>lives</b>."
    },
    "19": {
      "n": "Союзы и связки",
      "th": "<b>because</b> + причина · <b>so</b> + следствие · <b>although</b> (хотя) + контраст.<br><b>however</b> — однако (после точки, с запятой).<br><b>despite / in spite of</b> + существительное или V-ing, НЕ предложение!<br><b>Ловушка ЕГЭ:</b> despite the rain (сущ.), но although it rained (целое предложение)."
    },
    "20": {
      "n": "Наречия",
      "th": "Наречие = прилагательное + <b>-ly</b>: slow → slowly, easy → easily, happy → happily.<br><b>Исключения:</b> good → <b>well</b>; fast → fast; hard → hard.<br><b>hardly</b> — «почти не», а не «тяжело»: I could hardly hear.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD после глагола действия превращается в well: sings well."
    }
  },
  "bank": {
    "1": {
      "c": [
        {
          "t": [
            "She ",
            " to school every day."
          ],
          "o": [
            "go",
            "goes",
            "is going",
            "went"
          ],
          "a": 1,
          "e": "every day → Present Simple, she → V+s."
        },
        {
          "t": [
            "Look! It ",
            " ."
          ],
          "o": [
            "rains",
            "is raining",
            "rain",
            "rained"
          ],
          "a": 1,
          "e": "Look! → действие сейчас → Continuous."
        },
        {
          "t": [
            "Water ",
            " at 100 degrees."
          ],
          "o": [
            "boils",
            "is boiling",
            "boil",
            "boiled"
          ],
          "a": 0,
          "e": "Факт природы → Present Simple."
        },
        {
          "t": [
            "I ",
            " you well now."
          ],
          "o": [
            "hear",
            "am hearing",
            "hears",
            "heard"
          ],
          "a": 0,
          "e": "hear — глагол состояния, без Continuous."
        },
        {
          "t": [
            "He usually ",
            " up at seven."
          ],
          "o": [
            "get",
            "gets",
            "is getting",
            "got"
          ],
          "a": 1,
          "e": "usually → Simple, he → gets."
        }
      ],
      "f": [
        {
          "s": "My brother _____ (WATCH) TV every evening.",
          "b": "WATCH",
          "ans": [
            "watches"
          ],
          "e": "every evening → Present Simple, 3-е лицо → watches."
        },
        {
          "s": "Listen! Somebody _____ (SING).",
          "b": "SING",
          "ans": [
            "is singing"
          ],
          "e": "Listen! → прямо сейчас → is singing."
        },
        {
          "s": "She _____ (NOT LIKE) loud music.",
          "b": "NOT LIKE",
          "ans": [
            "does not like",
            "doesnt like"
          ],
          "e": "Отрицание в Present Simple → does not like."
        },
        {
          "s": "We _____ (STUDY) English twice a week.",
          "b": "STUDY",
          "ans": [
            "study"
          ],
          "e": "Регулярность → Present Simple, we → study."
        },
        {
          "s": "Right now they _____ (PLAY) chess.",
          "b": "PLAY",
          "ans": [
            "are playing"
          ],
          "e": "right now → are playing."
        }
      ]
    },
    "2": {
      "c": [
        {
          "t": [
            "I ",
            " him yesterday."
          ],
          "o": [
            "see",
            "saw",
            "have seen",
            "was seeing"
          ],
          "a": 1,
          "e": "yesterday → Past Simple."
        },
        {
          "t": [
            "While I ",
            " dinner, the phone rang."
          ],
          "o": [
            "cooked",
            "was cooking",
            "cook",
            "am cooking"
          ],
          "a": 1,
          "e": "while → процесс → Past Continuous."
        },
        {
          "t": [
            "They ",
            " to Moscow in 2020."
          ],
          "o": [
            "move",
            "moved",
            "have moved",
            "were moving"
          ],
          "a": 1,
          "e": "in 2020 → Past Simple."
        },
        {
          "t": [
            "When she came in, he ",
            " TV."
          ],
          "o": [
            "watched",
            "was watching",
            "watches",
            "has watched"
          ],
          "a": 1,
          "e": "Фоновый процесс → was watching."
        },
        {
          "t": [
            "Columbus ",
            " America in 1492."
          ],
          "o": [
            "discovers",
            "discovered",
            "has discovered",
            "was discovering"
          ],
          "a": 1,
          "e": "Дата в прошлом → Past Simple."
        }
      ],
      "f": [
        {
          "s": "She _____ (BUY) a new dress last week.",
          "b": "BUY",
          "ans": [
            "bought"
          ],
          "e": "last week → Past Simple: buy → bought."
        },
        {
          "s": "At 5 pm yesterday we _____ (PLAY) football.",
          "b": "PLAY",
          "ans": [
            "were playing"
          ],
          "e": "Момент-процесс → were playing."
        },
        {
          "s": "He _____ (COME) home late last night.",
          "b": "COME",
          "ans": [
            "came"
          ],
          "e": "last night → came."
        },
        {
          "s": "While mum _____ (COOK), dad set the table.",
          "b": "COOK",
          "ans": [
            "was cooking"
          ],
          "e": "while → was cooking."
        },
        {
          "s": "I _____ (NOT SEE) him at school yesterday.",
          "b": "NOT SEE",
          "ans": [
            "did not see",
            "didnt see"
          ],
          "e": "Отрицание в Past Simple → did not see."
        }
      ]
    },
    "3": {
      "c": [
        {
          "t": [
            "She ",
            " already finished her homework."
          ],
          "o": [
            "have",
            "has",
            "had",
            "is"
          ],
          "a": 1,
          "e": "she → has; already → Present Perfect."
        },
        {
          "t": [
            "I ",
            " this film before."
          ],
          "o": [
            "see",
            "saw",
            "have seen",
            "seeing"
          ],
          "a": 2,
          "e": "Опыт без даты → have seen."
        },
        {
          "t": [
            "He ",
            " to London last year."
          ],
          "o": [
            "has gone",
            "went",
            "goes",
            "has been"
          ],
          "a": 1,
          "e": "last year → Past Simple."
        },
        {
          "t": [
            "",
            " you ever been to Paris?"
          ],
          "o": [
            "Did",
            "Have",
            "Was",
            "Are"
          ],
          "a": 1,
          "e": "ever → Have you ever been."
        },
        {
          "t": [
            "We ",
            " friends since 2015."
          ],
          "o": [
            "are",
            "were",
            "have been",
            "had been"
          ],
          "a": 2,
          "e": "since → Present Perfect."
        }
      ],
      "f": [
        {
          "s": "I _____ (KNOW) her for ten years.",
          "b": "KNOW",
          "ans": [
            "have known"
          ],
          "e": "for + период до сейчас → have known."
        },
        {
          "s": "They _____ (JUST ARRIVE) — meet them!",
          "b": "JUST ARRIVE",
          "ans": [
            "have just arrived"
          ],
          "e": "just → have just arrived."
        },
        {
          "s": "She _____ (VISIT) Rome in 2019.",
          "b": "VISIT",
          "ans": [
            "visited"
          ],
          "e": "in 2019 → visited."
        },
        {
          "s": "He _____ (NOT FINISH) the report yet.",
          "b": "NOT FINISH",
          "ans": [
            "has not finished",
            "hasnt finished"
          ],
          "e": "yet → Present Perfect: has not finished."
        },
        {
          "s": "We _____ (BE) here since morning.",
          "b": "BE",
          "ans": [
            "have been"
          ],
          "e": "since → have been."
        }
      ]
    },
    "4": {
      "c": [
        {
          "t": [
            "I think it ",
            " tomorrow."
          ],
          "o": [
            "rains",
            "will rain",
            "is raining",
            "rained"
          ],
          "a": 1,
          "e": "Предсказание с I think → will."
        },
        {
          "t": [
            "Look at the clouds! It ",
            " ."
          ],
          "o": [
            "will rain",
            "is going to rain",
            "rains",
            "rained"
          ],
          "a": 1,
          "e": "Очевидно по признакам → be going to."
        },
        {
          "t": [
            "The train ",
            " at 6:30."
          ],
          "o": [
            "leaves",
            "will leave",
            "is leaving",
            "left"
          ],
          "a": 0,
          "e": "Расписание → Present Simple."
        },
        {
          "t": [
            "We ",
            " to the cinema tonight — I have the tickets."
          ],
          "o": [
            "go",
            "are going",
            "will go",
            "went"
          ],
          "a": 1,
          "e": "Договорённость → Present Continuous."
        },
        {
          "t": [
            "I promise I ",
            " you."
          ],
          "o": [
            "help",
            "am helping",
            "will help",
            "helped"
          ],
          "a": 2,
          "e": "Обещание → will."
        }
      ],
      "f": [
        {
          "s": "I am sure she _____ (COME) tomorrow.",
          "b": "COME",
          "ans": [
            "will come"
          ],
          "e": "Уверенность о будущем → will come."
        },
        {
          "s": "I hope he _____ (WIN) the match.",
          "b": "WIN",
          "ans": [
            "will win"
          ],
          "e": "hope → will win."
        },
        {
          "s": "The lesson _____ (START) at nine on Mondays.",
          "b": "START",
          "ans": [
            "starts"
          ],
          "e": "Расписание → starts."
        },
        {
          "s": "Wait, I _____ (HELP) you with the bags.",
          "b": "HELP",
          "ans": [
            "will help"
          ],
          "e": "Спонтанное решение → will help."
        },
        {
          "s": "We will go out when the rain _____ (STOP).",
          "b": "STOP",
          "ans": [
            "stops"
          ],
          "e": "После when о будущем — Present Simple."
        }
      ]
    },
    "5": {
      "c": [
        {
          "t": [
            "This book ",
            " in 1997."
          ],
          "o": [
            "wrote",
            "was written",
            "is written",
            "has written"
          ],
          "a": 1,
          "e": "Книга не сама пишет → пассив прошлого."
        },
        {
          "t": [
            "Letters ",
            " every day."
          ],
          "o": [
            "deliver",
            "are delivered",
            "delivered",
            "are delivering"
          ],
          "a": 1,
          "e": "Регулярный пассив → are delivered."
        },
        {
          "t": [
            "The new school ",
            " next year."
          ],
          "o": [
            "will build",
            "will be built",
            "is built",
            "builds"
          ],
          "a": 1,
          "e": "Будущий пассив → will be built."
        },
        {
          "t": [
            "English ",
            " all over the world."
          ],
          "o": [
            "speaks",
            "is spoken",
            "spoke",
            "is speaking"
          ],
          "a": 1,
          "e": "Пассив: is spoken."
        },
        {
          "t": [
            "The room ",
            " right now."
          ],
          "o": [
            "is cleaned",
            "is being cleaned",
            "cleans",
            "was cleaned"
          ],
          "a": 1,
          "e": "Процесс сейчас в пассиве → is being cleaned."
        }
      ],
      "f": [
        {
          "s": "The bridge _____ (BUILD) in 1932.",
          "b": "BUILD",
          "ans": [
            "was built"
          ],
          "e": "Пассив прошлого → was built."
        },
        {
          "s": "Rice _____ (GROW) in China.",
          "b": "GROW",
          "ans": [
            "is grown"
          ],
          "e": "Факт-пассив → is grown."
        },
        {
          "s": "The letter _____ (SEND) tomorrow.",
          "b": "SEND",
          "ans": [
            "will be sent"
          ],
          "e": "Будущее в пассиве → will be sent."
        },
        {
          "s": "This song _____ (WRITE) by The Beatles.",
          "b": "WRITE",
          "ans": [
            "was written"
          ],
          "e": "by → пассив: was written."
        },
        {
          "s": "Dinner _____ (COOK) at the moment.",
          "b": "COOK",
          "ans": [
            "is being cooked"
          ],
          "e": "at the moment + пассив → is being cooked."
        }
      ]
    },
    "6": {
      "c": [
        {
          "t": [
            "If it rains, we ",
            " at home."
          ],
          "o": [
            "stay",
            "will stay",
            "would stay",
            "stayed"
          ],
          "a": 1,
          "e": "1 тип: If + Present, will."
        },
        {
          "t": [
            "If I ",
            " you, I would apologise."
          ],
          "o": [
            "am",
            "was",
            "were",
            "be"
          ],
          "a": 2,
          "e": "2 тип: If I were you."
        },
        {
          "t": [
            "She would come if you ",
            " her."
          ],
          "o": [
            "invite",
            "invited",
            "will invite",
            "had invited"
          ],
          "a": 1,
          "e": "2 тип: If + Past Simple."
        },
        {
          "t": [
            "If you heat ice, it ",
            " ."
          ],
          "o": [
            "melts",
            "will melt",
            "would melt",
            "melted"
          ],
          "a": 0,
          "e": "0 тип — факт: Present + Present."
        },
        {
          "t": [
            "If I had known, I ",
            " you."
          ],
          "o": [
            "would tell",
            "told",
            "would have told",
            "will tell"
          ],
          "a": 2,
          "e": "3 тип: would have + V3."
        }
      ],
      "f": [
        {
          "s": "If he _____ (HAVE) time, he will call you.",
          "b": "HAVE",
          "ans": [
            "has"
          ],
          "e": "1 тип: после if — Present Simple."
        },
        {
          "s": "If I _____ (BE) you, I would wait.",
          "b": "BE",
          "ans": [
            "were"
          ],
          "e": "2 тип: were для всех лиц."
        },
        {
          "s": "We will go out if the rain _____ (STOP).",
          "b": "STOP",
          "ans": [
            "stops"
          ],
          "e": "После if НЕ будет will → stops."
        },
        {
          "s": "If she studied harder, she _____ (PASS) her exams.",
          "b": "PASS",
          "ans": [
            "would pass"
          ],
          "e": "2 тип: would + V."
        },
        {
          "s": "If they _____ (LEAVE) earlier, they would have caught the train.",
          "b": "LEAVE",
          "ans": [
            "had left"
          ],
          "e": "3 тип: If + had V3."
        }
      ]
    },
    "7": {
      "c": [
        {
          "t": [
            "He said he ",
            " busy."
          ],
          "o": [
            "is",
            "was",
            "were",
            "be"
          ],
          "a": 1,
          "e": "Косвенная речь: сказал, что занят СЕЙЧАС для того момента — is сдвигается в was."
        },
        {
          "t": [
            "She said she ",
            " come the next day."
          ],
          "o": [
            "will",
            "would",
            "can",
            "shall"
          ],
          "a": 1,
          "e": "Косвенная речь: will всегда сдвигается в would."
        },
        {
          "t": [
            "Tom asked where I ",
            " ."
          ],
          "o": [
            "live",
            "lived",
            "do live",
            "living"
          ],
          "a": 1,
          "e": "Косвенный вопрос: прямой порядок, сдвиг → lived."
        },
        {
          "t": [
            "Mum said she ",
            " the film before."
          ],
          "o": [
            "saw",
            "has seen",
            "had seen",
            "sees"
          ],
          "a": 2,
          "e": "Она видела фильм ЕЩЁ РАНЬШЕ этого разговора — действие до прошлого → Past Perfect: had seen."
        },
        {
          "t": [
            "He asked if I ",
            " help."
          ],
          "o": [
            "need",
            "needed",
            "will need",
            "am needing"
          ],
          "a": 1,
          "e": "Косвенный вопрос: время сдвигается назад (need → needed), порядок слов прямой."
        }
      ],
      "f": [
        {
          "s": "She said she _____ (LIVE) in Kazan.",
          "b": "LIVE",
          "ans": [
            "lived"
          ],
          "e": "Косвенная речь: живёт (lives) → жила для того момента (lived)."
        },
        {
          "s": "He told me he _____ (CALL) later.",
          "b": "CALL",
          "ans": [
            "would call"
          ],
          "e": "Косвенная речь: will call → would call (обещание, переданное позже)."
        },
        {
          "s": "They said they _____ (FINISH) the project already.",
          "b": "FINISH",
          "ans": [
            "had finished"
          ],
          "e": "Закончили ЕЩЁ ДО того, как сказали → Past Perfect: had finished."
        },
        {
          "s": "He asked what time it _____ (BE).",
          "b": "BE",
          "ans": [
            "was"
          ],
          "e": "Косвенный вопрос → was."
        },
        {
          "s": "She said she _____ (CAN) not come.",
          "b": "CAN",
          "ans": [
            "could"
          ],
          "e": "can → could."
        }
      ]
    },
    "8": {
      "c": [
        {
          "t": [
            "You ",
            " wear a helmet — it is the law."
          ],
          "o": [
            "can",
            "must",
            "may",
            "might"
          ],
          "a": 1,
          "e": "Обязанность → must."
        },
        {
          "t": [
            "You ",
            " smoke here — it is forbidden."
          ],
          "o": [
            "must not",
            "do not have to",
            "may",
            "need"
          ],
          "a": 0,
          "e": "Запрет → must not."
        },
        {
          "t": [
            "",
            " I open the window, please?"
          ],
          "o": [
            "Must",
            "May",
            "Should",
            "Have"
          ],
          "a": 1,
          "e": "Просьба о разрешении → May I…"
        },
        {
          "t": [
            "He ",
            " swim when he was five."
          ],
          "o": [
            "can",
            "could",
            "may",
            "must"
          ],
          "a": 1,
          "e": "Умение в прошлом → could."
        },
        {
          "t": [
            "You look tired — you ",
            " rest."
          ],
          "o": [
            "must not",
            "should",
            "may not",
            "could not"
          ],
          "a": 1,
          "e": "Совет → should."
        }
      ],
      "c2": [
        {
          "t": [
            "You ",
            " pay — the museum is free today."
          ],
          "o": [
            "must not",
            "do not have to",
            "can not",
            "should"
          ],
          "a": 1,
          "e": "Нет необходимости → do not have to (must not = запрет!)."
        },
        {
          "t": [
            "She ",
            " be at home — the lights are on."
          ],
          "o": [
            "must",
            "has to",
            "should",
            "need"
          ],
          "a": 0,
          "e": "Логический вывод → must be."
        },
        {
          "t": [
            "I ",
            " get up early yesterday."
          ],
          "o": [
            "must",
            "had to",
            "should",
            "may"
          ],
          "a": 1,
          "e": "Вынужденность в прошлом → had to."
        },
        {
          "t": [
            "",
            " you help me with this bag?"
          ],
          "o": [
            "Must",
            "Could",
            "Should",
            "May"
          ],
          "a": 1,
          "e": "Вежливая просьба → Could you…"
        },
        {
          "t": [
            "It ",
            " rain later — take an umbrella."
          ],
          "o": [
            "must",
            "might",
            "has to",
            "should"
          ],
          "a": 1,
          "e": "Вероятность → might."
        }
      ]
    },
    "9": {
      "c": [
        {
          "t": [
            "I enjoy ",
            " detective stories."
          ],
          "o": [
            "read",
            "to read",
            "reading",
            "reads"
          ],
          "a": 2,
          "e": "enjoy + V-ing."
        },
        {
          "t": [
            "She wants ",
            " a doctor."
          ],
          "o": [
            "become",
            "becoming",
            "to become",
            "becomes"
          ],
          "a": 2,
          "e": "want + to V."
        },
        {
          "t": [
            "He stopped ",
            " last year — good for him!"
          ],
          "o": [
            "smoke",
            "smoking",
            "to smoke",
            "smoked"
          ],
          "a": 1,
          "e": "stop doing = бросить."
        },
        {
          "t": [
            "Let me ",
            " you."
          ],
          "o": [
            "help",
            "to help",
            "helping",
            "helped"
          ],
          "a": 0,
          "e": "let + инфинитив без to."
        },
        {
          "t": [
            "It is easy ",
            " mistakes."
          ],
          "o": [
            "make",
            "making",
            "to make",
            "made"
          ],
          "a": 2,
          "e": "It is easy + to V."
        }
      ],
      "f": [
        {
          "s": "Avoid _____ (MAKE) noise after ten.",
          "b": "MAKE",
          "ans": [
            "making"
          ],
          "e": "avoid + V-ing."
        },
        {
          "s": "They decided _____ (STAY) at home.",
          "b": "STAY",
          "ans": [
            "to stay"
          ],
          "e": "decide + to V."
        },
        {
          "s": "I look forward to _____ (SEE) you.",
          "b": "SEE",
          "ans": [
            "seeing"
          ],
          "e": "look forward to + V-ing."
        },
        {
          "s": "He made me _____ (LAUGH).",
          "b": "LAUGH",
          "ans": [
            "laugh"
          ],
          "e": "make + инфинитив без to."
        },
        {
          "s": "She suggested _____ (GO) for a walk.",
          "b": "GO",
          "ans": [
            "going"
          ],
          "e": "suggest + V-ing."
        }
      ]
    },
    "10": {
      "c": [
        {
          "t": [
            "This task is ",
            " than that one."
          ],
          "o": [
            "easy",
            "easier",
            "the easiest",
            "more easy"
          ],
          "a": 1,
          "e": "Сравнение коротких: -er + than."
        },
        {
          "t": [
            "It is the ",
            " film I have ever seen."
          ],
          "o": [
            "good",
            "better",
            "best",
            "goodest"
          ],
          "a": 2,
          "e": "good → better → the best."
        },
        {
          "t": [
            "My car is ",
            " expensive than yours."
          ],
          "o": [
            "more",
            "most",
            "much",
            "many"
          ],
          "a": 0,
          "e": "Длинное прилагательное → more + adj."
        },
        {
          "t": [
            "The weather is getting ",
            " ."
          ],
          "o": [
            "bad",
            "worse",
            "the worst",
            "badly"
          ],
          "a": 1,
          "e": "bad → worse."
        },
        {
          "t": [
            "He is as ",
            " as his brother."
          ],
          "o": [
            "tall",
            "taller",
            "the tallest",
            "more tall"
          ],
          "a": 0,
          "e": "as + положительная степень + as."
        }
      ],
      "f": [
        {
          "s": "February is the _____ (SHORT) month of the year.",
          "b": "SHORT",
          "ans": [
            "shortest"
          ],
          "e": "Превосходная: the shortest."
        },
        {
          "s": "This road is _____ (BAD) than ours.",
          "b": "BAD",
          "ans": [
            "worse"
          ],
          "e": "bad → worse."
        },
        {
          "s": "It was the _____ (INTERESTING) trip in my life.",
          "b": "INTERESTING",
          "ans": [
            "most interesting"
          ],
          "e": "Длинное → the most interesting."
        },
        {
          "s": "Winters here are _____ (COLD) than at home.",
          "b": "COLD",
          "ans": [
            "colder"
          ],
          "e": "Короткое → colder."
        },
        {
          "s": "She sings much _____ (GOOD) than me.",
          "b": "GOOD",
          "ans": [
            "better"
          ],
          "e": "good → better."
        }
      ]
    },
    "11": {
      "c": [
        {
          "t": [
            "This is ",
            " book, not yours."
          ],
          "o": [
            "my",
            "mine",
            "me",
            "myself"
          ],
          "a": 0,
          "e": "Перед сущ. → my."
        },
        {
          "t": [
            "The red bag is ",
            " ."
          ],
          "o": [
            "her",
            "hers",
            "she",
            "herself"
          ],
          "a": 1,
          "e": "Без сущ. → hers."
        },
        {
          "t": [
            "I fixed the bike ",
            " ."
          ],
          "o": [
            "me",
            "my",
            "myself",
            "mine"
          ],
          "a": 2,
          "e": "Сам → myself."
        },
        {
          "t": [
            "There is ",
            " milk in the fridge."
          ],
          "o": [
            "some",
            "any",
            "no one",
            "every"
          ],
          "a": 0,
          "e": "Утверждение → some."
        },
        {
          "t": [
            "Is there ",
            " juice left?"
          ],
          "o": [
            "some",
            "any",
            "none",
            "a"
          ],
          "a": 1,
          "e": "Вопрос → any."
        }
      ],
      "f": [
        {
          "s": "Look at _____ (SHE) new dress!",
          "b": "SHE",
          "ans": [
            "her"
          ],
          "e": "Перед сущ. → her."
        },
        {
          "s": "These toys are _____ (THEY).",
          "b": "THEY",
          "ans": [
            "theirs"
          ],
          "e": "Без сущ. → theirs."
        },
        {
          "s": "We enjoyed _____ (WE) at the party.",
          "b": "WE",
          "ans": [
            "ourselves"
          ],
          "e": "enjoy oneself → ourselves."
        },
        {
          "s": "The cat licked _____ (IT) paw.",
          "b": "IT",
          "ans": [
            "its"
          ],
          "e": "Притяжательное its — без апострофа."
        },
        {
          "s": "He cut _____ (HE) while cooking.",
          "b": "HE",
          "ans": [
            "himself"
          ],
          "e": "Возвратное → himself."
        }
      ]
    },
    "12": {
      "c": [
        {
          "t": [
            "My birthday is on the ",
            " of May."
          ],
          "o": [
            "five",
            "fifth",
            "fifty",
            "fiveth"
          ],
          "a": 1,
          "e": "Дата → порядковое: the fifth."
        },
        {
          "t": [
            "There are ",
            " months in a year."
          ],
          "o": [
            "twelve",
            "twelfth",
            "twelves",
            "twelfths"
          ],
          "a": 0,
          "e": "Количество → twelve."
        },
        {
          "t": [
            "He came ",
            " in the race."
          ],
          "o": [
            "first",
            "one",
            "once",
            "firstly"
          ],
          "a": 0,
          "e": "Место в гонке → first."
        },
        {
          "t": [
            "Open your books at page ",
            " ."
          ],
          "o": [
            "three",
            "third",
            "thirds",
            "thirdly"
          ],
          "a": 0,
          "e": "После сущ. (page 3) → количественное."
        },
        {
          "t": [
            "",
            " of people visited the fair."
          ],
          "o": [
            "Hundred",
            "Hundreds",
            "The hundred",
            "Hundredth"
          ],
          "a": 1,
          "e": "Hundreds of people (неточное число)."
        }
      ],
      "f": [
        {
          "s": "Today is her _____ (TWELVE) birthday.",
          "b": "TWELVE",
          "ans": [
            "twelfth"
          ],
          "e": "12th → twelfth (без e!)."
        },
        {
          "s": "He finished _____ (TWO) in the marathon.",
          "b": "TWO",
          "ans": [
            "second"
          ],
          "e": "Место → second."
        },
        {
          "s": "It is my _____ (ONE) visit to Moscow.",
          "b": "ONE",
          "ans": [
            "first"
          ],
          "e": "one → first."
        },
        {
          "s": "The _____ (FIVE) lesson starts at one o'clock.",
          "b": "FIVE",
          "ans": [
            "fifth"
          ],
          "e": "five → fifth (f!)."
        },
        {
          "s": "Our office is on the _____ (TWENTY) floor.",
          "b": "TWENTY",
          "ans": [
            "twentieth"
          ],
          "e": "twenty → twentieth."
        }
      ]
    },
    "13": {
      "c": [
        {
          "t": [
            "When I came, they ",
            " already left."
          ],
          "o": [
            "have",
            "had",
            "has",
            "were"
          ],
          "a": 1,
          "e": "Они ушли ДО того, как я пришёл — действие раньше прошлого → had left."
        },
        {
          "t": [
            "By the time the bus arrived, we ",
            " for an hour."
          ],
          "o": [
            "waited",
            "had waited",
            "have waited",
            "wait"
          ],
          "a": 1,
          "e": "by the time → ждали ДО прибытия → Past Perfect: had waited."
        },
        {
          "t": [
            "She was sad because she ",
            " her keys."
          ],
          "o": [
            "lost",
            "had lost",
            "has lost",
            "loses"
          ],
          "a": 1,
          "e": "Сначала потеряла ключи, ПОТОМ грустила → более раннее действие → had lost."
        },
        {
          "t": [
            "After he ",
            " dinner, he watched TV."
          ],
          "o": [
            "had cooked",
            "has cooked",
            "cooks",
            "is cooking"
          ],
          "a": 0,
          "e": "after + действие, которое было первым → had cooked."
        },
        {
          "t": [
            "I ",
            " never seen the sea before that trip."
          ],
          "o": [
            "have",
            "had",
            "was",
            "did"
          ],
          "a": 1,
          "e": "Опыт ДО момента в прошлом (before that trip) → had never seen."
        }
      ],
      "f": [
        {
          "s": "When we got to the station, the train _____ (ALREADY LEAVE).",
          "b": "ALREADY LEAVE",
          "ans": [
            "had already left"
          ],
          "e": "Поезд ушёл ДО нашего прихода → had already left."
        },
        {
          "s": "He was tired because he _____ (NOT SLEEP) all night.",
          "b": "NOT SLEEP",
          "ans": [
            "had not slept",
            "hadnt slept"
          ],
          "e": "Не спал ДО того, как устал → had not slept."
        },
        {
          "s": "By 2020 they _____ (BUILD) the new bridge.",
          "b": "BUILD",
          "ans": [
            "had built"
          ],
          "e": "by 2020 — к моменту в прошлом → had built."
        },
        {
          "s": "After I _____ (FINISH) my homework, I went out.",
          "b": "FINISH",
          "ans": [
            "had finished"
          ],
          "e": "after + первое из двух действий → had finished."
        },
        {
          "s": "She realised she _____ (FORGET) her password.",
          "b": "FORGET",
          "ans": [
            "had forgotten"
          ],
          "e": "Забыла РАНЬШЕ, чем поняла → had forgotten."
        }
      ]
    },
    "14": {
      "c": [
        {
          "t": [
            "I have ",
            " idea!"
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 1,
          "e": "idea начинается с гласного звука → an idea."
        },
        {
          "t": [
            "",
            " sun rises in the east."
          ],
          "o": [
            "A",
            "An",
            "The",
            "—"
          ],
          "a": 2,
          "e": "Солнце единственное в своём роде → the sun."
        },
        {
          "t": [
            "She plays ",
            " piano very well."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 2,
          "e": "Музыкальные инструменты → play the piano."
        },
        {
          "t": [
            "We usually have ",
            " breakfast at eight."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 3,
          "e": "Приёмы пищи без артикля: have breakfast."
        },
        {
          "t": [
            "He lives in ",
            " USA."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 2,
          "e": "Страны из нескольких слов → the USA."
        }
      ],
      "c2": [
        {
          "t": [
            "It was ",
            " best day of my life."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 2,
          "e": "Превосходная степень всегда с the: the best."
        },
        {
          "t": [
            "My dad is ",
            " engineer."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 1,
          "e": "Профессия — с a/an; engineer начинается с гласного → an."
        },
        {
          "t": [
            "We went to ",
            " cinema last night."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 2,
          "e": "go to the cinema — устойчиво с the."
        },
        {
          "t": [
            "",
            " children learn languages faster than adults."
          ],
          "o": [
            "A",
            "An",
            "The",
            "—"
          ],
          "a": 3,
          "e": "Обобщение во множественном числе — без артикля."
        },
        {
          "t": [
            "Pass me ",
            " salt, please."
          ],
          "o": [
            "a",
            "an",
            "the",
            "—"
          ],
          "a": 2,
          "e": "Конкретная соль на этом столе → the salt."
        }
      ]
    },
    "15": {
      "c": [
        {
          "t": [
            "The lesson starts ",
            " nine."
          ],
          "o": [
            "at",
            "on",
            "in",
            "to"
          ],
          "a": 0,
          "e": "Точное время → at nine."
        },
        {
          "t": [
            "My birthday is ",
            " June."
          ],
          "o": [
            "at",
            "on",
            "in",
            "of"
          ],
          "a": 2,
          "e": "Месяц → in June."
        },
        {
          "t": [
            "We met ",
            " Monday."
          ],
          "o": [
            "at",
            "on",
            "in",
            "by"
          ],
          "a": 1,
          "e": "День недели → on Monday."
        },
        {
          "t": [
            "She is good ",
            " maths."
          ],
          "o": [
            "in",
            "at",
            "on",
            "of"
          ],
          "a": 1,
          "e": "Устойчиво: good at."
        },
        {
          "t": [
            "It depends ",
            " the weather."
          ],
          "o": [
            "of",
            "from",
            "on",
            "at"
          ],
          "a": 2,
          "e": "Устойчиво: depend on (не from!)."
        }
      ],
      "c2": [
        {
          "t": [
            "I am interested ",
            " history."
          ],
          "o": [
            "at",
            "in",
            "on",
            "of"
          ],
          "a": 1,
          "e": "interested in."
        },
        {
          "t": [
            "Do not be afraid ",
            " mistakes."
          ],
          "o": [
            "of",
            "at",
            "from",
            "by"
          ],
          "a": 0,
          "e": "afraid of."
        },
        {
          "t": [
            "We waited ",
            " the bus for ages."
          ],
          "o": [
            "at",
            "on",
            "for",
            "to"
          ],
          "a": 2,
          "e": "wait for."
        },
        {
          "t": [
            "He listens ",
            " music every day."
          ],
          "o": [
            "at",
            "to",
            "on",
            "for"
          ],
          "a": 1,
          "e": "listen to."
        },
        {
          "t": [
            "I read about it ",
            " the Internet."
          ],
          "o": [
            "in",
            "at",
            "on",
            "by"
          ],
          "a": 2,
          "e": "on the Internet, on TV."
        }
      ]
    },
    "16": {
      "c": [
        {
          "t": [
            "There are five ",
            " in the room."
          ],
          "o": [
            "mans",
            "men",
            "man",
            "mens"
          ],
          "a": 1,
          "e": "man → men (без s!)."
        },
        {
          "t": [
            "The ",
            " are playing outside."
          ],
          "o": [
            "childs",
            "children",
            "child",
            "childrens"
          ],
          "a": 1,
          "e": "child → children."
        },
        {
          "t": [
            "My ",
            " hurt after the long walk."
          ],
          "o": [
            "foots",
            "feet",
            "foot",
            "feets"
          ],
          "a": 1,
          "e": "foot → feet."
        },
        {
          "t": [
            "Some ",
            " think differently."
          ],
          "o": [
            "persons",
            "people",
            "peoples",
            "person"
          ],
          "a": 1,
          "e": "person → people."
        },
        {
          "t": [
            "A few ",
            " are grazing in the field."
          ],
          "o": [
            "sheeps",
            "sheep",
            "shep",
            "sheepes"
          ],
          "a": 1,
          "e": "sheep не меняется: one sheep — two sheep."
        }
      ],
      "f": [
        {
          "s": "Three _____ (WOMAN) were waiting at the door.",
          "b": "WOMAN",
          "ans": [
            "women"
          ],
          "e": "woman → women."
        },
        {
          "s": "All the _____ (CHILD) love this game.",
          "b": "CHILD",
          "ans": [
            "children"
          ],
          "e": "child → children."
        },
        {
          "s": "My _____ (TOOTH) hurt after too many sweets.",
          "b": "TOOTH",
          "ans": [
            "teeth"
          ],
          "e": "tooth → teeth."
        },
        {
          "s": "Hundreds of _____ (PERSON) came to the concert.",
          "b": "PERSON",
          "ans": [
            "people"
          ],
          "e": "person → people."
        },
        {
          "s": "Two white _____ (MOUSE) live in the cage.",
          "b": "MOUSE",
          "ans": [
            "mice"
          ],
          "e": "mouse → mice."
        }
      ]
    },
    "17": {
      "c": [
        {
          "t": [
            "The journey was long and very ",
            " ."
          ],
          "o": [
            "tired",
            "tiring",
            "tire",
            "tiredly"
          ],
          "a": 1,
          "e": "Поездка сама утомляет → tiring."
        },
        {
          "t": [
            "I am ",
            " in space and planets."
          ],
          "o": [
            "interesting",
            "interested",
            "interest",
            "interestly"
          ],
          "a": 1,
          "e": "Человек испытывает интерес → interested."
        },
        {
          "t": [
            "The news was really ",
            " ."
          ],
          "o": [
            "surprised",
            "surprising",
            "surprise",
            "surprisingly"
          ],
          "a": 1,
          "e": "Новость вызывает удивление → surprising."
        },
        {
          "t": [
            "We were ",
            " by the result."
          ],
          "o": [
            "amazing",
            "amazed",
            "amaze",
            "amazedly"
          ],
          "a": 1,
          "e": "Мы испытали чувство → amazed."
        },
        {
          "t": [
            "This game is so ",
            " !"
          ],
          "o": [
            "excited",
            "exciting",
            "excite",
            "excitedly"
          ],
          "a": 1,
          "e": "Игра вызывает восторг → exciting."
        }
      ],
      "f": [
        {
          "s": "The lecture was really _____ (BORE).",
          "b": "BORE",
          "ans": [
            "boring"
          ],
          "e": "Лекция сама наводит скуку → boring."
        },
        {
          "s": "She was _____ (EXCITE) about the trip.",
          "b": "EXCITE",
          "ans": [
            "excited"
          ],
          "e": "Она испытывает чувство → excited."
        },
        {
          "s": "His answer was quite _____ (SURPRISE).",
          "b": "SURPRISE",
          "ans": [
            "surprising"
          ],
          "e": "Ответ вызывает удивление → surprising."
        },
        {
          "s": "I feel _____ (TIRE) after training.",
          "b": "TIRE",
          "ans": [
            "tired"
          ],
          "e": "Я испытываю усталость → tired."
        },
        {
          "s": "The book is very _____ (INTEREST).",
          "b": "INTEREST",
          "ans": [
            "interesting"
          ],
          "e": "Книга вызывает интерес → interesting."
        }
      ]
    },
    "18": {
      "c": [
        {
          "t": [
            "Where ",
            " your brother work?"
          ],
          "o": [
            "does",
            "is",
            "do",
            "did"
          ],
          "a": 0,
          "e": "He/she → вспомогательный does: Where does he work?"
        },
        {
          "t": [
            "Who ",
            " the window yesterday?"
          ],
          "o": [
            "broke",
            "did break",
            "breaks",
            "break"
          ],
          "a": 0,
          "e": "Вопрос к подлежащему (КТО разбил?) — без did: Who broke…"
        },
        {
          "t": [
            "You are coming with us, ",
            " ?"
          ],
          "o": [
            "are you",
            "aren't you",
            "do you",
            "isn't it"
          ],
          "a": 1,
          "e": "Утверждение с are → хвост aren't you?"
        },
        {
          "t": [
            "She speaks French, ",
            " ?"
          ],
          "o": [
            "does she",
            "doesn't she",
            "isn't she",
            "hasn't she"
          ],
          "a": 1,
          "e": "speaks (Present Simple) → doesn't she?"
        },
        {
          "t": [
            "I wonder where he ",
            " ."
          ],
          "o": [
            "lives",
            "does live",
            "live",
            "is live"
          ],
          "a": 0,
          "e": "Косвенный вопрос — прямой порядок слов: where he lives."
        }
      ],
      "c2": [
        {
          "t": [
            "",
            " you ever tried sushi?"
          ],
          "o": [
            "Did",
            "Have",
            "Do",
            "Was"
          ],
          "a": 1,
          "e": "ever + опыт → Have you ever tried…"
        },
        {
          "t": [
            "He can swim, ",
            " ?"
          ],
          "o": [
            "can he",
            "can't he",
            "does he",
            "isn't he"
          ],
          "a": 1,
          "e": "can → хвост can't he?"
        },
        {
          "t": [
            "Tell me what time it ",
            " ."
          ],
          "o": [
            "is",
            "does",
            "be",
            "was being"
          ],
          "a": 0,
          "e": "Косвенный вопрос: what time it is (без do)."
        },
        {
          "t": [
            "",
            " did you get home? — Late at night."
          ],
          "o": [
            "When",
            "Where",
            "Who",
            "Which"
          ],
          "a": 0,
          "e": "Ответ про время → When."
        },
        {
          "t": [
            "They went home early, ",
            " ?"
          ],
          "o": [
            "did they",
            "didn't they",
            "do they",
            "weren't they"
          ],
          "a": 1,
          "e": "went → didn't they?"
        }
      ]
    },
    "19": {
      "c": [
        {
          "t": [
            "We stayed at home ",
            " it was raining."
          ],
          "o": [
            "so",
            "because",
            "despite",
            "however"
          ],
          "a": 1,
          "e": "Причина → because."
        },
        {
          "t": [
            "We went for a walk ",
            " the cold."
          ],
          "o": [
            "although",
            "because",
            "despite",
            "so"
          ],
          "a": 2,
          "e": "Дальше существительное (the cold) → despite."
        },
        {
          "t": [
            "",
            " he was tired, he kept working."
          ],
          "o": [
            "Despite",
            "Although",
            "So",
            "Because"
          ],
          "a": 1,
          "e": "Дальше целое предложение → Although."
        },
        {
          "t": [
            "She was ill, ",
            " she came to school."
          ],
          "o": [
            "so",
            "because",
            "but",
            "despite"
          ],
          "a": 2,
          "e": "Контраст двух фактов → but."
        },
        {
          "t": [
            "I overslept, ",
            " I was late."
          ],
          "o": [
            "because",
            "so",
            "although",
            "despite"
          ],
          "a": 1,
          "e": "Следствие → so (проспал, ПОЭТОМУ опоздал)."
        }
      ],
      "c2": [
        {
          "t": [
            "",
            " the traffic, we arrived on time."
          ],
          "o": [
            "Although",
            "Despite",
            "Because",
            "However"
          ],
          "a": 1,
          "e": "Дальше существительное → Despite the traffic."
        },
        {
          "t": [
            "He passed the exam ",
            " he had hardly studied."
          ],
          "o": [
            "despite",
            "although",
            "so",
            "because of"
          ],
          "a": 1,
          "e": "Дальше предложение → although."
        },
        {
          "t": [
            "The film was long. ",
            " , it was great."
          ],
          "o": [
            "Despite",
            "However",
            "Although",
            "Because"
          ],
          "a": 1,
          "e": "Новое предложение + запятая → However."
        },
        {
          "t": [
            "Take an umbrella ",
            " it rains."
          ],
          "o": [
            "in case",
            "despite",
            "so",
            "although"
          ],
          "a": 0,
          "e": "На случай, если пойдёт дождь → in case."
        },
        {
          "t": [
            "I like tea ",
            " my brother prefers coffee."
          ],
          "o": [
            "while",
            "despite",
            "so",
            "because"
          ],
          "a": 0,
          "e": "Сопоставление двух фактов → while."
        }
      ]
    },
    "20": {
      "c": [
        {
          "t": [
            "She sings very ",
            " ."
          ],
          "o": [
            "good",
            "well",
            "goodly",
            "best"
          ],
          "a": 1,
          "e": "После глагола действия — наречие: good → well."
        },
        {
          "t": [
            "He drives too ",
            " ."
          ],
          "o": [
            "fast",
            "fastly",
            "fastest",
            "fasten"
          ],
          "a": 0,
          "e": "fast — исключение: наречие тоже fast."
        },
        {
          "t": [
            "Speak ",
            " , please."
          ],
          "o": [
            "slow",
            "slowly",
            "slowest",
            "slowness"
          ],
          "a": 1,
          "e": "Как говорить? → наречие slowly."
        },
        {
          "t": [
            "I could ",
            " hear him."
          ],
          "o": [
            "hard",
            "hardly",
            "harder",
            "hardness"
          ],
          "a": 1,
          "e": "hardly = почти не. I could hardly hear — почти не слышал."
        },
        {
          "t": [
            "They worked ",
            " all day."
          ],
          "o": [
            "hard",
            "hardly",
            "hardful",
            "hardy"
          ],
          "a": 0,
          "e": "hard = усердно (hardly — ловушка, «почти не»)."
        }
      ],
      "f": [
        {
          "s": "She smiled _____ (HAPPY).",
          "b": "HAPPY",
          "ans": [
            "happily"
          ],
          "e": "happy → happily (y → ily)."
        },
        {
          "s": "He answered all the questions _____ (CORRECT).",
          "b": "CORRECT",
          "ans": [
            "correctly"
          ],
          "e": "Как ответил? → correctly."
        },
        {
          "s": "Please listen _____ (CAREFUL).",
          "b": "CAREFUL",
          "ans": [
            "carefully"
          ],
          "e": "careful → carefully (две l)."
        },
        {
          "s": "My granny cooks really _____ (GOOD).",
          "b": "GOOD",
          "ans": [
            "well"
          ],
          "e": "good → well (исключение!)."
        },
        {
          "s": "It was raining _____ (HEAVY).",
          "b": "HEAVY",
          "ans": [
            "heavily"
          ],
          "e": "heavy → heavily."
        }
      ]
    }
  },
  "exams": [
    {
      "tx": [
        "Last summer Kate and her brother ",
        " to St Petersburg. It was their ",
        " visit to the city. The Hermitage ",
        " in 1764. Kate thought the real palaces were much ",
        " than in photos. Now she ",
        " a new trip together with ",
        " best friend."
      ],
      "gaps": [
        {
          "b": "GO",
          "ans": [
            "went"
          ],
          "e": "last summer → Past Simple: went.",
          "t": 2,
          "voice": {
            "id": "grammar.past-simple.last-summer",
            "revision": 1
          }
        },
        {
          "b": "ONE",
          "ans": [
            "first"
          ],
          "e": "Порядковое: one → first.",
          "t": 12
        },
        {
          "b": "FOUND",
          "ans": [
            "was founded"
          ],
          "e": "Музей основали → пассив прошлого: was founded.",
          "t": 5
        },
        {
          "b": "BEAUTIFUL",
          "ans": [
            "more beautiful"
          ],
          "e": "Длинное прилагательное → more beautiful.",
          "t": 10
        },
        {
          "b": "PLAN",
          "ans": [
            "is planning"
          ],
          "e": "now → Present Continuous: is planning.",
          "t": 1
        },
        {
          "b": "SHE",
          "ans": [
            "her"
          ],
          "e": "Перед сущ. → притяжательное her.",
          "t": 11
        }
      ]
    },
    {
      "tx": [
        "Tom is fond of science. Every week he ",
        " a robotics club. Yesterday, while he ",
        " on his robot, his teacher said that the results ",
        " impressive. If Tom ",
        " the city contest, he will go to the national final. It will be the ",
        " competition in his life. Tom believes that in the future robots ",
        " everywhere."
      ],
      "gaps": [
        {
          "b": "ATTEND",
          "ans": [
            "attends"
          ],
          "e": "every week → Present Simple, he → attends.",
          "t": 1
        },
        {
          "b": "WORK",
          "ans": [
            "was working"
          ],
          "e": "while → Past Continuous: was working.",
          "t": 2
        },
        {
          "b": "BE",
          "ans": [
            "were"
          ],
          "e": "Косвенная речь: сдвиг are → were.",
          "t": 7
        },
        {
          "b": "WIN",
          "ans": [
            "wins"
          ],
          "e": "1 тип условия: после if — Present Simple.",
          "t": 6
        },
        {
          "b": "THREE",
          "ans": [
            "third"
          ],
          "e": "three → third.",
          "t": 12
        },
        {
          "b": "USE",
          "ans": [
            "will be used"
          ],
          "e": "Будущее в пассиве → will be used.",
          "t": 5,
          "voice": {
            "id": "grammar.future-passive.will-be-used",
            "revision": 1
          }
        }
      ]
    },
    {
      "tx": [
        "My granny lives in the country. Her house ",
        " by my great-grandfather. It is much ",
        " than our flat. When I visited her last month, she ",
        " jam. She said she ",
        " me a jar. Granny keeps three cats, and each of ",
        " has ",
        " own bowl."
      ],
      "gaps": [
        {
          "b": "BUILD",
          "ans": [
            "was built"
          ],
          "e": "Дом построили → пассив: was built.",
          "t": 5
        },
        {
          "b": "OLD",
          "ans": [
            "older"
          ],
          "e": "Сравнение: older than.",
          "t": 10
        },
        {
          "b": "MAKE",
          "ans": [
            "was making"
          ],
          "e": "Процесс в момент прошлого → was making.",
          "t": 2
        },
        {
          "b": "GIVE",
          "ans": [
            "would give"
          ],
          "e": "Косвенная речь: will give → would give.",
          "t": 7
        },
        {
          "b": "THEY",
          "ans": [
            "them"
          ],
          "e": "each of them.",
          "t": 11
        },
        {
          "b": "IT",
          "ans": [
            "its"
          ],
          "e": "Притяжательное its (без апострофа).",
          "t": 11
        }
      ]
    }
  ]
};

// Grammar 2.0 keeps every legacy choice/input item intact. Ticket-owned content
// packages add active levels through this single catalog merge boundary.
export const GRAMMAR_CATALOG_V1_CONTENT = structuredClone(GRAMMAR_CATALOG_CONTENT);
GRAMMAR_CATALOG_CONTENT.version = 'grammar-core-v2';
GRAMMAR_CATALOG_CONTENT.revision = 2;

function applyActiveTopicBank({ bank, legacyMeta, legacyChoiceDiagnostics, legacyOverrides, pairPlans }) {
for (const [topicId, additions] of Object.entries(bank)) {
  const legacy = GRAMMAR_CATALOG_CONTENT.bank[topicId];
  const metadata = legacyMeta[topicId];
  const overrides = legacyOverrides[topicId] || {};
  legacy.c = legacy.c.map((item, index) => ({
    ...item,
    ...(overrides.c?.[index] || {}),
    ...metadata.c[index],
    diagnostics: legacyChoiceDiagnostics[topicId][index],
  })).concat(additions.c);
  legacy.f = (legacy.f || []).map((item, index) => ({ ...item, ...(overrides.f?.[index] || {}), ...metadata.f[index] })).concat(additions.f);
  legacy.correction = [...additions.correction];
  legacy.transform = [...additions.transform];
  for (const kind of ['c', 'f', 'correction', 'transform']) {
    const explicitPairPlan = pairPlans[topicId]?.[kind] || null;
    const pairCounts = new Map();
    const pairIds = new Map();
    legacy[kind] = legacy[kind].map((item, itemIndex) => {
      if (explicitPairPlan) return { ...item, transferPair: `grammar-v2:${topicId}:${kind}:${explicitPairPlan[itemIndex]}` };
      const weakness = `${item.errorSkill}:${item.confusionPair || '-'}`;
      const count = pairCounts.get(weakness) || 0;
      pairCounts.set(weakness, count + 1);
      const pairKey = `${weakness}:${Math.floor(count / 2)}`;
      if (!pairIds.has(pairKey)) pairIds.set(pairKey, pairIds.size + 1);
      return { ...item, transferPair: `grammar-v2:${topicId}:${kind}:${pairIds.get(pairKey)}` };
    });
    if (explicitPairPlan && (explicitPairPlan.length !== legacy[kind].length
      || [...new Set(explicitPairPlan)].some((pairId) => explicitPairPlan.filter((candidate) => candidate === pairId).length !== 2))) {
      throw new Error(`INVALID_EXPLICIT_ACTIVE_GRAMMAR_PAIR_PLAN:${topicId}.${kind}`);
    }
    if (!explicitPairPlan && [...pairCounts.values()].some((count) => count % 2 !== 0)) {
      throw new Error(`INVALID_ACTIVE_GRAMMAR_PAIR_PLAN:${topicId}.${kind}`);
    }
  }
}
}

applyActiveTopicBank({
  bank: ACTIVE_TENSES_BANK,
  legacyMeta: ACTIVE_TENSES_LEGACY_META,
  legacyChoiceDiagnostics: ACTIVE_TENSES_LEGACY_CHOICE_DIAGNOSTICS,
  legacyOverrides: ACTIVE_TENSES_LEGACY_OVERRIDES,
  pairPlans: ACTIVE_TENSES_TRANSFER_PAIR_PLANS,
});
applyActiveTopicBank({
  bank: ACTIVE_VERB_CONSTRUCTIONS_BANK,
  legacyMeta: ACTIVE_VERB_CONSTRUCTIONS_LEGACY_META,
  legacyChoiceDiagnostics: ACTIVE_VERB_CONSTRUCTIONS_LEGACY_CHOICE_DIAGNOSTICS,
  legacyOverrides: ACTIVE_VERB_CONSTRUCTIONS_LEGACY_OVERRIDES,
  pairPlans: ACTIVE_VERB_CONSTRUCTIONS_TRANSFER_PAIR_PLANS,
});
