import './theme.js';

/*
 * Единственная точка входа frontend: index.html подключает только её.
 * Общая Aisy-тема подключена как обычный stylesheet в public documents и лежит в offline closure:
 * CSS import здесь нарушил бы прямой запуск нативных ES-модулей без Vite.
 *
 * Порядок общих domain-модулей менять нельзя: app.js читает Words, Grammar и Profile на верхнем
 * уровне. Тяжёлые предметные реализации получают тот же public contract через lazy proxy/loader.
 *
 * Исключение одно и оно безопасное: tts.js выполняется раньше своего места в списке, потому что
 * app.js импортирует из него озвучку. На верхнем уровне tts.js только объявляет функции и пустой
 * кэш, ничего ни у кого не спрашивая, поэтому от переноса вперёд ничего не зависит.
 *
 * globals.js стоит первым по той же причине: он ничего не спрашивает, только объявляет функцию.
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
import {installAsyaLauncher} from './asya-launcher.js';
import './learning.js';
import './modules/words.js';
import './modules/grammar.js';
import './modules/profile.js';
import * as app from './app.js';
import * as voiceTutor from './voice-tutor-loader.js';
/*
 * Сегодня, Слова и Грамматика нужны до первого перехода. Practice, ЕГЭ, Прогресс и Профиль
 * загружаются по маршруту, но входят в проверяемый install-closure service worker: это сохраняет
 * первое офлайн-открытие после установки PWA, не заставляя каждую сессию разбирать их JavaScript.
 * Глубокие предметные экраны и exact-пробник остаются runtime-cached только после явного открытия.
 */
import * as wordsScreen from './screens/words.js';
import * as grammarScreen from './screens/grammar.js';
import * as todayScreen from './screens/today.js';
import './privacy-loader.js';
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
exposeGlobals(todayScreen);

installLearnerShell({
  document,
  navigateTopLevel:router.navigateTopLevel,
  navigateBackToHub:router.backToHub,
  currentScreen:router.cur,
  registerRouteHook:router.registerRouteHook,
  registerBackAdapter:router.registerBackAdapter,
});

installAsyaLauncher({
  document,
  currentScreen:router.cur,
  registerRouteHook:router.registerRouteHook,
});
