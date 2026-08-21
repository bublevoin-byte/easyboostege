/*
 * Реестр экранов, код которых приезжает по требованию.
 *
 * Первая загрузка тянет только оболочку: маршрутизацию, хранилище, общие компоненты, авторизацию,
 * синхронизацию и главный экран. Код предметного экрана приезжает динамическим import() при первом
 * переходе на него — и только тогда его имена появляются на window, потому что обработчики,
 * которые их зовут, существуют лишь в разметке, отрисованной этим же экраном.
 *
 * Здесь нет «Слов», «Грамматики», «Прогресса» и «Профиля»: требования обещают их первое открытие без сети, а
 * обещание, отложенное до первого перехода, ученик, ушедший в офлайн раньше, не получит. Эти три
 * учебных экрана и профиль импортирует main.js статически — причина расписана там.
 *
 * Путь чанка написан литералом внутри import() намеренно: так его видит и сборщик, и
 * scripts/check-inline-handlers.js, который разбирает экспорты экранов статически.
 */
import {exposeGlobals} from './globals.js';
import {registerScreenSource} from './router.js';

const SCREEN_SOURCES={
  'aisy-practice':function(){return import('./screens/practice.js')},
  scr4:function(){return import('./screens/listening.js')},
  scr7:function(){return import('./screens/reading.js')},
  scr8:function(){return import('./screens/writing.js')},
  scr9:function(){return import('./screens/speaking.js')},
  scr16:function(){return import('./screens/ege-mock.js')},
};

/* Загруженный экран больше не ждёт ничего: маршрутизатор получает null и переключается сразу. */
const LOADED=new Set();
const PENDING=new Map();

function loadScreen(id){
  if(LOADED.has(id))return null;
  const source=SCREEN_SOURCES[id];
  if(!source)return null;
  let request=PENDING.get(id);
  if(request)return request;
  request=source().then(function(screen){
    LOADED.add(id);
    PENDING.delete(id);
    exposeGlobals(screen);
    return screen;
  },function(error){
    /* Неудачная попытка не запоминается: «Повторить» должно значить именно повтор запроса. */
    PENDING.delete(id);
    throw error;
  });
  PENDING.set(id,request);
  return request;
}

registerScreenSource(loadScreen);

export {loadScreen};
