/*
 * Единственная точка входа frontend: index.html подключает только её.
 * Общая Aisy-тема подключена как обычный stylesheet в public documents и лежит в offline closure:
 * CSS import здесь нарушил бы прямой запуск нативных ES-модулей без Vite.
 *
 * Порядок импортов повторяет порядок прежних тегов <script defer>, и менять его нельзя.
 * Модули предметных экранов публикуют себя как window.EasyBoostЧто-то, а app.js читает эти имена
 * на верхнем уровне — перестановка превратит их в undefined ещё до первого экрана.
 *
 * Исключение одно и оно безопасное: tts.js выполняется раньше своего места в списке, потому что
 * app.js импортирует из него озвучку. На верхнем уровне tts.js только объявляет функции и пустой
 * кэш, ничего ни у кого не спрашивая, поэтому от переноса вперёд ничего не зависит.
 *
 * globals.js стоит первым по той же причине: он ничего не спрашивает, только объявляет функцию.
 * Четыре предметных экрана сюда не входят — они приезжают динамическим import() при первом
 * переходе. Четыре оставшихся объяснены ниже, у своих импортов.
 */
import {exposeGlobals} from './globals.js';
import './api.js';
import './auth.js';
import './owner-incarnation.js';
import './sync.js';
import './store.js';
import './components.js';
import * as router from './router.js';
import {installLearnerShell} from './aisy-shell.js';
import './learning.js';
import './modules/words.js';
import './modules/grammar.js';
import './modules/reading.js';
import './modules/listening.js';
import './modules/writing.js';
import './modules/speaking.js';
import './modules/exam.js';
import './modules/progress.js';
import './modules/profile.js';
import * as app from './app.js';
import * as voiceTutor from './voice-tutor.js';
/*
 * Четыре экрана грузятся сразу, а не чанком: без сети должны работать словарные
 * карточки, интервальное повторение, встроенные грамматические тесты и просмотр сохранённого
 * прогресса, а тикет учебных предпочтений обещает офлайн-изменение профиля. Ученик может уйти в
 * офлайн, ни разу их не открыв, — и обещание всё равно наступает.
 *
 * Кэш service worker эту роль взять не может: офлайн-гарантия, которая держится на нём,
 * перестаёт существовать там, где service worker недоступен или ещё не установился. Именно так
 * и проверяет `e2e/demo.test.js` — контекст с `serviceWorkers: 'block'`.
 *
 * Остальные пять экранов, включая пробный ЕГЭ, приезжают по требованию; открытый экран попадает в
 * runtime-cache, а exact preflight не запускает попытку до готовности form/audio. Размер оболочки
 * проверяет frontend build.
 */
import * as wordsScreen from './screens/words.js';
import * as grammarScreen from './screens/grammar.js';
import * as progressScreen from './screens/progress.js';
import * as profileScreen from './screens/profile.js';
import './privacy.js';
import * as tts from './tts.js';
import './pwa.js';

/*
 * Имена оболочки попадают на window здесь и только здесь; механизм живёт в globals.js, потому что
 * им же пользуется загрузчик экранов — имена чанка появляются при первом переходе на его экран.
 */
exposeGlobals(router);
exposeGlobals(tts);
exposeGlobals(app);
exposeGlobals(voiceTutor);
exposeGlobals(wordsScreen);
exposeGlobals(grammarScreen);
exposeGlobals(progressScreen);
exposeGlobals(profileScreen);

installLearnerShell({
  document,
  navigateTopLevel:router.navigateTopLevel,
  navigateBackToHub:router.backToHub,
  currentScreen:router.cur,
  registerRouteHook:router.registerRouteHook,
  registerBackAdapter:router.registerBackAdapter,
});
