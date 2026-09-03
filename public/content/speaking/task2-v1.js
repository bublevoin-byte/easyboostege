import {
  SPEAKING_CATALOG_ID,
  SPEAKING_TASK2_CONTRACT_VERSION,
  SPEAKING_TASK2_INSTRUCTION,
  assertSpeakingTask2Catalog,
  deepFreezeSpeakingCatalog,
} from '../../speaking-catalog-contract.js';

const ROWS = [
  ['weekend-pottery', 'Творческие курсы', 'Shape and decorate your own ceramic piece at the new Riverside Pottery Weekend. Friendly tutors welcome complete beginners.', ['course dates', 'participation fee', 'number of students in a group', 'tools provided']],
  ['indoor-climbing', 'Спорт и досуг', 'Discover indoor climbing with North Wall Club. Our instructors offer safe introductory sessions for teenagers who want a new challenge.', ['club location', 'minimum age', 'equipment rental', 'trial lesson availability']],
  ['young-film-camp', 'Кино и творчество', 'Make a short film with other young creators at Bright Frame Camp. Participants explore acting, camera work and editing in one practical programme.', ['camp length', 'application deadline', 'editing software used', 'final screening']],
  ['world-cooking-studio', 'Еда и культуры мира', 'Cook dishes from different countries at Globe Kitchen Studio. Each class combines a practical recipe with a short story about its culture.', ['lesson schedule', 'cost per class', 'vegetarian options', 'ingredients included']],
  ['harbour-book-fair', 'Книги и чтение', 'Meet independent publishers and discover unusual books at the Harbour Book Fair. Visitors can attend talks and browse themed stalls throughout the event.', ['opening hours', 'entrance price', 'author talks programme', 'student discount']],
  ['sunrise-photo-walk', 'Фотография', 'Learn to photograph the city in early morning light on the Sunrise Photo Walk. A local photographer will guide a small group through quiet streets.', ['meeting point', 'walk duration', 'camera requirements', 'bad-weather policy']],
  ['harbour-language-cafe', 'Иностранные языки', 'Practise conversational English at the Harbour Language Cafe. Relaxed themed tables help learners speak with volunteers and other students.', ['meeting days', 'required language level', 'booking method', 'refreshments available']],
  ['lake-sailing-school', 'Водный спорт', 'Learn the basics of sailing at Clear Lake School. Qualified coaches run practical sessions on stable training boats for young beginners.', ['course start date', 'age range', 'swimming ability required', 'life jackets provided']],
  ['weekend-coding-lab', 'Технологии', 'Build a simple mobile game at the Weekend Coding Lab. Mentors guide school students through design, programming and a final demonstration.', ['programming language', 'laptop requirement', 'group size', 'certificate']],
  ['street-dance-course', 'Танцы', 'Try energetic street dance classes at Motion Yard. The beginner course focuses on rhythm, coordination and a short group routine.', ['class timetable', 'monthly fee', 'clothing recommendations', 'first lesson free']],
  ['museum-after-dark', 'Музеи и история', 'Explore the City Museum after normal closing time. The special evening includes guided rooms, live demonstrations and creative activities.', ['event date', 'ticket price', 'tour language', 'photography rules']],
  ['forest-eco-lodge', 'Путешествия и экология', 'Stay close to nature at Pine Trail Eco Lodge. Guests can explore forest paths and join simple activities about local wildlife.', ['room price', 'distance from station', 'breakfast included', 'bike hire']],
  ['organic-farm-volunteers', 'Волонтёрство', 'Spend a week helping at Green Field Organic Farm. Volunteers work with the garden team and learn how seasonal food is grown.', ['volunteer dates', 'daily duties', 'accommodation', 'minimum stay']],
  ['school-robotics-lab', 'Робототехника', 'Design and test a small robot in the School Robotics Lab holiday programme. Teams solve practical challenges with support from engineering students.', ['programme length', 'previous experience needed', 'materials fee', 'competition day']],
  ['coastal-cycle-tour', 'Активные путешествия', 'See quiet beaches and fishing villages on the Coastal Cycle Tour. A guide leads riders along a scenic route away from busy roads.', ['route distance', 'bicycle rental', 'lunch arrangements', 'fitness level']],
  ['youth-theatre-course', 'Театр', 'Join Stage Door Youth Theatre and create a performance from first rehearsal to opening night. The course welcomes curious young actors.', ['audition process', 'rehearsal days', 'course fee', 'performance venue']],
  ['art-kit-library', 'Искусство и ресурсы', 'Borrow quality art materials from the new Art Kit Library. Members can try drawing, painting and printing equipment without buying a full set.', ['membership price', 'loan period', 'deposit required', 'available materials']],
  ['island-science-camp', 'Наука и природа', 'Investigate shore life and weather at Island Science Camp. Students collect observations outdoors and turn them into a group project.', ['camp dates', 'travel arrangements', 'required clothing', 'project presentation']],
  ['summer-music-festival', 'Музыка и события', 'Enjoy new bands and local performers at Meadow Summer Music Festival. Several small stages offer music throughout the afternoon and evening.', ['festival location', 'ticket categories', 'food stalls', 'last performance time']],
  ['exam-study-centre', 'Учёба', 'Prepare for important school exams at Focus Study Centre. Small-group sessions combine subject practice with planning and revision techniques.', ['subjects offered', 'course schedule', 'group size', 'progress reports']],
  ['animal-care-workshop', 'Животные', 'Learn responsible everyday animal care at the Community Pet Workshop. Experienced staff demonstrate safe routines using friendly trained animals.', ['workshop date', 'animals included', 'parent attendance', 'booking deadline']],
  ['heritage-railway-trip', 'Транспорт и история', 'Travel through the countryside on the restored Valley Heritage Railway. The journey includes station exhibits and a short stop in a historic town.', ['departure time', 'journey duration', 'return ticket price', 'wheelchair access']],
  ['teen-sports-clinic', 'Спорт и здоровье', 'Improve your technique at the Teen Sports Clinic. Coaches lead focused sessions for school players in a supportive training environment.', ['sports covered', 'coach qualifications', 'session length', 'medical form']],
  ['river-canoe-day', 'Водные путешествия', 'Paddle along a calm river with the River Canoe Day team. Guides introduce basic strokes before the group begins its relaxed journey.', ['starting place', 'total price', 'maximum group size', 'waterproof storage']],
  ['hilltop-astronomy', 'Астрономия', 'Observe planets and distant objects during the Hilltop Astronomy Weekend. Talks and practical telescope sessions are planned for curious beginners.', ['weekend dates', 'overnight accommodation', 'telescope access', 'cloudy-weather activities']],
  ['artisan-bread-class', 'Кулинария', 'Bake several kinds of bread at the Artisan Bread Masterclass. The tutor explains mixing, shaping and safe use of a home oven.', ['class duration', 'ingredient list', 'take-home products', 'allergy information']],
  ['old-town-quest', 'Городские игры', 'Solve clues and discover hidden details during the Old Town Quest. Teams follow a walking route and complete observation challenges together.', ['quest starting time', 'team size', 'route accessibility', 'prize details']],
  ['ridge-youth-hostel', 'Туризм', 'Plan an affordable mountain break at Ridge Youth Hostel. The hostel is a practical base for marked walking routes and outdoor activities.', ['bed price', 'check-in time', 'kitchen facilities', 'guided hikes']],
  ['open-community-choir', 'Музыка', 'Sing with neighbours in the Open Community Choir. Weekly rehearsals explore modern and traditional songs without competitive auditions.', ['rehearsal venue', 'membership fee', 'music-reading ability', 'concert frequency']],
  ['balcony-gardening', 'Садоводство', 'Turn a small outdoor space into a productive garden with the Balcony Gardening Course. Practical lessons cover containers, soil and seasonal care.', ['course dates', 'plants supplied', 'lesson format', 'follow-up support']],
  ['wetland-wildlife-centre', 'Природа и экология', 'Visit the new Wetland Wildlife Centre and learn how birds, insects and plants share this habitat. Observation areas are designed for quiet exploration.', ['centre opening days', 'guided walk times', 'binocular hire', 'family ticket']],
  ['young-design-school', 'Дизайн', 'Create a portfolio piece at Young Design School. Students experiment with colour, layout and model-making in a project-based course.', ['entry age', 'portfolio requirement', 'weekly timetable', 'software access']],
  ['harbour-skating-rink', 'Зимний спорт', 'Practise skating at the covered Harbour Ice Rink. Public sessions and beginner lessons are available in a bright modern arena.', ['public session times', 'skate rental price', 'helmet policy', 'locker availability']],
  ['confident-speakers-club', 'Публичные выступления', 'Build confidence at the Young Speakers Club. Members prepare short talks, practise clear delivery and give each other constructive feedback.', ['meeting frequency', 'membership age', 'topics chosen', 'online participation']],
  ['summer-city-internship', 'Профориентация', 'Explore working life through the Summer City Internship programme. Local organisations offer supervised projects for motivated school students.', ['application requirements', 'placement length', 'working hours', 'travel expenses']],
  ['clean-coast-day', 'Экологическое волонтёрство', 'Join Clean Coast Day and help collect litter while researchers record what reaches the beach. Volunteers receive a safety briefing before work begins.', ['meeting location', 'event duration', 'gloves provided', 'registration process']],
  ['lantern-board-game-cafe', 'Игры и общение', 'Try strategy and party games at Lantern Board Game Cafe. Game guides can recommend a title and explain the rules to new players.', ['table booking', 'hourly charge', 'games for two players', 'food ordering']],
  ['teen-swimming-course', 'Плавание', 'Develop confident swimming skills in the Teen Pool Course. Qualified instructors teach technique and water safety in level-based groups.', ['level assessment', 'lesson days', 'course price', 'missed lesson policy']],
  ['responsible-travel-show', 'Путешествия', 'Plan thoughtful journeys at the Responsible Travel Show. Exhibitors present rail routes, local stays and low-impact outdoor experiences.', ['show dates', 'venue transport', 'talk reservation', 'student admission']],
  ['makers-craft-market', 'Ремёсла', 'Meet local makers at the Riverside Craft Market. Stalls feature handmade objects, demonstrations and small activities for visitors.', ['market hours', 'cashless payment', 'workshop schedule', 'seller applications']],
  ['family-photo-archive', 'История и технологии', 'Learn to organise old photographs at the Family Digital Archive session. Staff demonstrate scanning, file naming and safe backup choices.', ['session date', 'photos to bring', 'scanner use', 'privacy guidance']],
  ['outdoor-first-aid', 'Безопасность', 'Learn practical emergency responses on the Outdoor First Aid Course. Realistic exercises focus on calm decisions while professional help is on its way.', ['course length', 'certificate validity', 'physical activities', 'minimum age']],
  ['neighbourhood-makerspace', 'Технологии и творчество', 'Turn an idea into a simple prototype at the Neighbourhood Makerspace. Members share tools for wood, electronics and digital fabrication.', ['membership plans', 'safety training', 'machine booking', 'mentor support']],
  ['orchard-farm-shop', 'Местные продукты', 'Discover seasonal produce at Orchard Farm Shop. The shop sells food from nearby growers and hosts occasional tasting events.', ['shop location', 'weekend opening', 'delivery service', 'tasting dates']],
  ['improvised-jazz-workshop', 'Музыка', 'Explore musical improvisation at the Young Jazz Workshop. Players learn to listen, respond and build a short ensemble performance.', ['instruments accepted', 'skill level', 'workshop fee', 'final recording']],
  ['canal-evening-cruise', 'Речные путешествия', 'See the city lights from the Canal Evening Cruise. A guide shares short stories as the boat passes bridges and historic buildings.', ['departure pier', 'cruise duration', 'indoor seating', 'cancellation rules']],
  ['repair-and-recycle-hub', 'Экология и ремонт', 'Give household items another chance at the Repair and Recycle Hub. Volunteers help visitors diagnose simple faults and sort unusable materials.', ['items accepted', 'appointment needed', 'repair charge', 'data removal service']],
  ['station-youth-hostel', 'Молодёжные путешествия', 'Stay near the main transport links at Station Youth Hostel. Shared spaces make it easy for young travellers to plan local trips together.', ['age restrictions', 'room types', 'quiet hours', 'luggage storage']],
  ['coastal-writing-camp', 'Письмо и литература', 'Develop a short story at the Coastal Creative Writing Camp. Daily workshops combine guided exercises, reading and independent writing time.', ['camp dates', 'writing language', 'feedback sessions', 'accommodation cost']],
  ['future-careers-day', 'Образование и карьера', 'Meet people from different professions at Future Careers Day. Visitors can join short talks and practical sessions about routes into work.', ['event timetable', 'companies attending', 'question sessions', 'proof of attendance']],
  ['hidden-gardens-tour', 'Городская природа', 'Explore small green spaces on the Hidden Gardens Walking Tour. A local guide explains how residents create habitats in busy neighbourhoods.', ['tour start point', 'walking distance', 'accessible route option', 'recommended clothing']],
  ['modern-ceramics-show', 'Искусство', 'See functional and experimental work at the Modern Ceramics Exhibition. The programme also includes artist conversations and live demonstrations.', ['gallery address', 'exhibition end date', 'talk tickets', 'school group visits']],
  ['weekend-hiking-club', 'Пешие походы', 'Discover new local trails with the Weekend Hiking Club. Volunteer leaders plan routes that help young walkers build experience gradually.', ['next route', 'membership cost', 'transport sharing', 'emergency contact']],
  ['harbour-history-talks', 'История города', 'Hear researchers tell surprising stories at the Harbour History Lecture Series. Each evening focuses on a different period of local life.', ['lecture dates', 'speaker list', 'advance booking', 'recordings available']],
  ['bay-kayaking-centre', 'Водный спорт', 'Learn to paddle safely at Bay Kayaking Centre. Sheltered-water sessions help beginners practise control before joining a short coastal route.', ['lesson times', 'course package price', 'changing facilities', 'weather decision']],
  ['city-chess-academy', 'Интеллектуальные игры', 'Improve strategic thinking at City Chess Academy. Students study positions, play timed games and review their decisions with a coach.', ['class levels', 'lesson frequency', 'tournament entry', 'online practice']],
  ['stop-motion-studio', 'Анимация', 'Create a short stop-motion scene at Pocket Animation Studio. Participants build simple characters, plan shots and edit their sequence.', ['workshop duration', 'phone or camera needed', 'group project option', 'finished file format']],
  ['snow-weekend', 'Зимние путешествия', 'Try several winter activities during the Snow Valley Weekend. Instructors introduce safe techniques before each supervised outdoor session.', ['weekend programme', 'equipment sizes', 'meal plan', 'insurance requirement']],
  ['regional-debate-cup', 'Дебаты', 'Take part in the Regional Student Debate Cup. Teams discuss prepared motions and receive structured feedback after each round.', ['team registration', 'motion topics', 'round length', 'judging criteria']],
  ['food-photo-course', 'Фотография и еда', 'Learn to create clear and attractive food images at the Tabletop Photography Course. Practical tasks use simple lighting and everyday dishes.', ['course venue', 'camera settings covered', 'props supplied', 'portfolio review']],
];

function cefrFor(index) {
  if (index < 12) return 'B1';
  if (index < 48) return 'B2';
  return 'B2+/C1';
}

function taskFromRow([slug, topic, advertisement, supports], index) {
  return {
    id: `${SPEAKING_CATALOG_ID}.task2.${slug}`,
    revision: 1,
    taskType: 2,
    cefr: cefrFor(index),
    topic,
    preparationSeconds: 60,
    questionSeconds: 20,
    maxScore: 4,
    instruction: SPEAKING_TASK2_INSTRUCTION,
    advertisement,
    supports,
    rubric: { questionCount: 4, perQuestionMaxScore: 1, directQuestionRequired: true },
    provenance: {
      kind: 'original', author: 'Easy Boost', createdAt: '2026-08-06', reviewStatus: 'automatically_checked',
    },
  };
}

export const SPEAKING_TASK2_CATALOG = deepFreezeSpeakingCatalog(assertSpeakingTask2Catalog({
  id: SPEAKING_CATALOG_ID,
  revision: 1,
  contractVersion: SPEAKING_TASK2_CONTRACT_VERSION,
  format: {
    exam: 'ege-english-2026', source: 'fipi-ege-2026', sourceRevision: '2026-08-06',
    taskType: 2, preparationSeconds: 60, questionSeconds: 20, questionCount: 4, maxScore: 4,
  },
  tasks: ROWS.map(taskFromRow),
}));
