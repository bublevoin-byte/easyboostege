/*
 * Единственная точка входа frontend: index.html подключает только её.
 *
 * Порядок импортов повторяет порядок прежних тегов <script defer>, и менять его нельзя.
 * Модули предметных экранов публикуют себя как window.EasyBoostЧто-то, а app.js читает эти имена
 * на верхнем уровне — перестановка превратит их в undefined ещё до первого экрана.
 *
 * Исключение одно и оно безопасное: tts.js выполняется раньше своего места в списке, потому что
 * app.js импортирует из него озвучку. На верхнем уровне tts.js только объявляет функции и пустой
 * кэш, ничего ни у кого не спрашивая, поэтому от переноса вперёд ничего не зависит.
 */
import './api.js';
import './auth.js';
import './sync.js';
import './store.js';
import './components.js';
import * as router from './router.js';
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
import './privacy.js';
import * as tts from './tts.js';
import './pwa.js';

/*
 * Инлайновые обработчики разметки и e2e-сценарии ищут имена на window. Раньше они попадали туда
 * побочным эффектом: объявление функции в классическом скрипте создаёт свойство глобального
 * объекта. Модуль так не умеет, поэтому раскладываем имена сами — и только те, что модуль объявил
 * экспортом. Список сверяется автоматически: scripts/check-inline-handlers.js.
 *
 * Свойство делается геттером, а не копией значения: LE, RE, SP и остальное состояние экранов
 * переприсваивается по ходу работы, и обработчик обязан видеть текущее значение, а не то,
 * что лежало в переменной на момент загрузки.
 */
function exposeGlobals(namespace) {
  for (const name of Object.keys(namespace)) {
    Object.defineProperty(window, name, {
      get() { return namespace[name]; },
      configurable: true,
      enumerable: true,
    });
  }
}

exposeGlobals(router);
exposeGlobals(tts);
exposeGlobals(app);
