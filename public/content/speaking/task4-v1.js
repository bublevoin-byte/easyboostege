import {
  SPEAKING_CATALOG_ID,
  SPEAKING_TASK4_CONTRACT_VERSION,
  SPEAKING_TASK4_INSTRUCTION,
  assertSpeakingTask4Catalog,
  deepFreezeSpeakingCatalog,
} from '../../speaking-catalog-contract.js';

const ROWS = [
  ['learning-new-skills', 'Обучение новым навыкам', 'Ways to learn a new skill', 'a small group learning pottery with a tutor in a bright workshop', 'a teenager following a practical online lesson at a tidy home desk'],
  ['holiday-destinations', 'Путешествия', 'Different holiday destinations', 'young travellers exploring a historic pedestrian street', 'young travellers relaxing on a quiet natural beach'],
  ['keeping-active', 'Физическая активность', 'Ways to keep physically active', 'teenagers playing an indoor team sport in a school gym', 'a teenager jogging alone along a green riverside path'],
  ['reading-formats', 'Чтение', 'Different ways of reading', 'a student reading a printed novel in a calm library corner', 'a student reading an e-book on a tablet by a sunny window'],
  ['places-to-eat', 'Еда и общение', 'Places to enjoy a meal', 'a family preparing a colourful dinner together at home', 'a group of friends sharing a meal in a casual cafe'],
  ['city-transport', 'Транспорт', 'Ways to travel around a city', 'a student cycling safely on a protected urban cycle lane', 'students travelling together on a clean modern city bus'],
  ['shopping-choices', 'Покупки', 'Different ways of shopping', 'shoppers choosing fresh produce at an outdoor neighbourhood market', 'a young adult receiving a plain online shopping parcel at home'],
  ['spending-free-time', 'Досуг', 'Ways to spend free time', 'friends playing a board game around a living-room table', 'a teenager painting quietly at an easel in a home studio'],
  ['enjoying-music', 'Музыка', 'Ways to enjoy music', 'a small audience watching young musicians at an outdoor concert', 'a teenager listening to music with headphones in a comfortable room'],
  ['celebrating-events', 'Праздники', 'Ways to celebrate a special event', 'relatives decorating a home dining room for a celebration', 'friends enjoying lanterns at a public community festival'],
  ['helping-community', 'Волонтёрство', 'Ways to help the community', 'teenage volunteers collecting litter in a public park', 'teenage volunteers preparing supplies at an animal shelter'],
  ['healthy-mornings', 'Полезные привычки', 'Ways to start a healthy day', 'a teenager making a balanced breakfast in a bright kitchen', 'a teenager doing gentle exercise outdoors in morning light'],
  ['school-projects', 'Школьные проекты', 'Different school project activities', 'students carrying out a safe science experiment in a classroom lab', 'students building a colourful model in an art classroom'],
  ['nature-breaks', 'Отдых на природе', 'Ways to spend a holiday in nature', 'friends hiking on a marked forest trail with day packs', 'friends resting beside a calm lake at a managed campsite'],
  ['caring-for-pets', 'Домашние животные', 'Ways to care for pets', 'a teenager walking a friendly dog in a neighbourhood park', 'a teenager cleaning and arranging a home aquarium'],
  ['green-city-spaces', 'Городская природа', 'Green spaces in a city', 'families spending time in a leafy public park', 'volunteers tending vegetables in a rooftop community garden'],
  ['museum-experiences', 'Музеи', 'Ways to explore a museum', 'students studying objects in traditional glass display cases', 'students using a large interactive exhibit in a science museum'],
  ['weather-day-plans', 'Погода и досуг', 'Activities for different weather', 'teenagers skating outdoors on a snowy winter day', 'teenagers doing crafts indoors while rain falls outside'],
  ['family-activities', 'Семья', 'Ways for families to spend time together', 'a family having a relaxed picnic in a green park', 'a family baking bread together in a home kitchen'],
  ['taking-photographs', 'Фотография', 'Ways to take photographs', 'a student using a digital camera on a city photo walk', 'a student using a smartphone to photograph flowers outdoors'],
  ['keeping-in-touch', 'Общение', 'Ways to keep in touch', 'friends talking face to face at a quiet cafe table', 'friends having a video call from separate home desks'],
  ['study-environments', 'Учёба', 'Places to study effectively', 'students revising at a shared table in a modern library', 'a student revising alone at an organised bedroom desk'],
  ['outdoor-challenges', 'Активный отдых', 'Different outdoor challenges', 'young beginners climbing on a supervised outdoor wall', 'young beginners paddling kayaks on calm sheltered water'],
  ['career-exploration', 'Профориентация', 'Ways to explore a future career', 'students speaking with professionals at a careers workshop', 'a student observing a craftsperson during a supervised workplace visit'],
  ['buying-food', 'Продукты питания', 'Places to buy food', 'customers choosing local vegetables at a farmers market', 'customers using baskets in a bright neighbourhood supermarket'],
  ['travel-accommodation', 'Туризм', 'Places to stay while travelling', 'young travellers arriving at a small comfortable hotel', 'young travellers setting up tents at an organised campsite'],
  ['watching-stories', 'Культура', 'Ways to watch a story', 'an audience watching actors perform on a theatre stage', 'an audience watching a film in a modern cinema'],
  ['growing-plants', 'Садоводство', 'Ways to grow plants', 'a teenager caring for herbs in pots on a balcony', 'teenagers planting vegetables in a community garden'],
  ['creative-art', 'Творчество', 'Ways to make art', 'a young artist painting a landscape on canvas', 'a young maker shaping clay at a pottery wheel'],
  ['community-events', 'Городские события', 'Types of community events', 'families browsing handmade goods at a street fair', 'neighbours attending a practical workshop in a public library'],
  ['school-clubs', 'Школьные клубы', 'Different school clubs', 'students testing a small robot in a school technology club', 'students discussing a topic in a school debate club'],
  ['reusing-belongings', 'Ответственное потребление', 'Ways to reuse old belongings', 'volunteers repairing a small household lamp at a repair cafe', 'students turning clean packaging into a creative model'],
  ['water-activities', 'Отдых на воде', 'Ways to enjoy time on the water', 'young people learning to sail on a calm lake', 'young people swimming in supervised lanes at an outdoor pool'],
  ['winter-weekends', 'Зимний отдых', 'Ways to spend a winter weekend', 'friends cross-country skiing on a marked snowy trail', 'friends playing games beside a fireplace in a mountain cabin'],
  ['summer-evenings', 'Летний досуг', 'Ways to spend a summer evening', 'friends walking on a hill trail in warm evening light', 'friends watching an outdoor film in a public square'],
  ['meeting-new-people', 'Дружба', 'Ways to meet new people', 'teenagers getting acquainted during a team sports practice', 'teenagers talking at a friendly language exchange table'],
  ['discovering-hometown', 'Родной город', 'Ways to discover a hometown', 'visitors joining a guided walking tour of an old district', 'visitors exploring a riverside route on rental bicycles'],
  ['learning-science', 'Наука', 'Ways to learn about science', 'students observing a classroom chemistry demonstration', 'students recording plants during a supervised field study'],
  ['relaxing-mindfully', 'Отдых и самочувствие', 'Ways to relax after a busy week', 'young people doing a calm yoga session in a studio', 'young people taking a quiet walk through a forest'],
  ['creating-technology', 'Технологии', 'Ways to create with technology', 'students programming a simple project in a computer lab', 'students assembling an electronic model in a makerspace'],
  ['choosing-gifts', 'Подарки', 'Ways to choose a meaningful gift', 'a teenager making a handmade photo frame at a craft table', 'a teenager choosing a simple gift in a local shop'],
  ['sharing-meals', 'Общение за едой', 'Ways to share a meal with friends', 'friends sharing homemade food at an outdoor picnic', 'friends eating together in a welcoming restaurant'],
  ['preserving-memories', 'Семейная история', 'Ways to preserve memories', 'a family looking through a printed photo album together', 'a family viewing a digital photo slideshow on a screen'],
  ['watching-wildlife', 'Животные и природа', 'Ways to observe wildlife responsibly', 'visitors watching animals from a path in a wildlife reserve', 'birdwatchers observing birds from a wooden hide'],
  ['performing-together', 'Сценическое искусство', 'Ways to perform with other people', 'teenagers rehearsing a dance routine in a studio', 'teenagers rehearsing music together in a practice room'],
  ['first-job', 'Первый опыт работы', 'Places for a first work experience', 'a student helping arrange bread in a local bakery', 'a student shelving returned books in a public library'],
  ['school-journeys', 'Дорога в школу', 'Active ways to travel to school', 'students walking to school together on a safe pavement', 'students cycling to school on a protected route'],
  ['public-meeting-places', 'Городская среда', 'Places where a community can meet', 'neighbours talking in a pedestrian town square', 'neighbours taking part in activities at a community centre'],
  ['weekend-learning', 'Познавательный отдых', 'Ways to learn at the weekend', 'students learning about crops during a visit to a farm', 'students exploring exhibits in a city history museum'],
  ['sustainable-clothes', 'Одежда и экология', 'Ways to make clothing last longer', 'a teenager repairing a jacket with sewing tools', 'a teenager choosing clothes in a second-hand shop'],
  ['saving-water', 'Экологичные привычки', 'Ways to save water at home', 'a family collecting rainwater for garden plants', 'a teenager turning off a tap while washing dishes'],
  ['cooking-outdoors-indoors', 'Кулинария', 'Different ways to prepare food', 'friends baking pastries together in a home kitchen', 'friends preparing vegetables on a safe outdoor grill'],
  ['working-as-team', 'Командная работа', 'Ways to work as a team', 'teenagers cooperating during a basketball practice', 'teenage volunteers building a raised garden bed together'],
  ['quiet-rest', 'Восстановление сил', 'Ways to enjoy quiet rest', 'a teenager reading on a comfortable sofa', 'a teenager resting in a hammock in a shaded garden'],
  ['practising-language', 'Иностранные языки', 'Ways to practise a foreign language', 'students practising phrases with a teacher in class', 'young people having an informal conversation at a language cafe'],
  ['future-homes', 'Жильё', 'Different homes for the future', 'people relaxing in a compact modern city apartment', 'people tending plants beside an energy-efficient country house'],
  ['local-produce', 'Местные продукты', 'Ways to get local food', 'visitors buying fruit directly at a small farm shop', 'shoppers choosing locally labelled produce in a city food hall'],
  ['adventure-trips', 'Приключенческие путешествия', 'Different adventure trips', 'travellers hiking towards a mountain viewpoint', 'travellers taking a small guided boat along a rocky coast'],
  ['following-news', 'Новости', 'Ways to follow local news', 'a student reading a printed community newspaper at a table', 'a student listening to a local news podcast at home'],
  ['building-models', 'Моделирование', 'Ways to build a working model', 'students constructing a wooden bridge model in a workshop', 'students assembling a moving model from reusable parts in a classroom'],
];

function cefrFor(index) {
  if (index < 12) return 'B1';
  if (index < 48) return 'B2';
  return 'B2+/C1';
}

function planFor(projectTitle) {
  return [
    `briefly describe both photographs and explain why they illustrate the project “${projectTitle}”`,
    'compare the most important difference between the situations shown in the two photographs',
    'mention one or two advantages of each option represented in the photographs',
    'say which option you would choose for yourself and support your opinion with a clear reason',
  ];
}

function taskFromRow([slug, topic, projectTitle, leftAlt, rightAlt], index) {
  return {
    id: `${SPEAKING_CATALOG_ID}.task4.${slug}`,
    revision: 1,
    taskType: 4,
    cefr: cefrFor(index),
    topic,
    projectTitle,
    preparationSeconds: 150,
    responseSeconds: 180,
    maxScore: 10,
    instruction: SPEAKING_TASK4_INSTRUCTION,
    photoPair: {
      assetId: `speaking-task4-photo-pair.${slug}.v1`,
      src: `/assets/speaking/task4-v1/${slug}.png`,
      alt: `Two photographs for the project “${projectTitle}”. ${leftAlt}; ${rightAlt}.`,
      panels: [
        { number: 1, alt: `Photo 1: ${leftAlt}.` },
        { number: 2, alt: `Photo 2: ${rightAlt}.` },
      ],
    },
    plan: planFor(projectTitle),
    rubric: {
      content: { maxScore: 4 },
      organisation: { maxScore: 3 },
      language: { maxScore: 3 },
      zeroContentMeansZero: true,
    },
    provenance: {
      kind: 'original', author: 'Easy Boost', createdAt: '2026-08-06', reviewStatus: 'automatically_checked',
    },
  };
}

export const SPEAKING_TASK4_CATALOG = deepFreezeSpeakingCatalog(assertSpeakingTask4Catalog({
  id: SPEAKING_CATALOG_ID,
  revision: 1,
  contractVersion: SPEAKING_TASK4_CONTRACT_VERSION,
  format: {
    exam: 'ege-english-2026', source: 'fipi-ege-2026', sourceRevision: '2026-08-06',
    taskType: 4, preparationSeconds: 150, responseSeconds: 180, photoCount: 2,
    planPointCount: 4, maxScore: 10,
  },
  tasks: ROWS.map(taskFromRow),
}));
