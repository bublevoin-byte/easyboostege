/*
 * Экран «Прогресс» (scr10). Раздел 6.1 ТЗ обещает просмотр сохранённого прогресса без сети,
 * поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 * Числа он берёт из того же состояния, что и плитки главного экрана, — считать заново нечего.
 */
import {registerRouteHook} from '../router.js';
import {S,progressModule,setTxt,setW} from '../app.js';

const BAR_IDS={words:'pb_words',gram:'pb_gram',read:'pb_read',listen:'pb_listen',speak:'pb_speak'};
function renderProgress(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('p_streak',progressModule.streakLabel(view.streak));setTxt('p_words',view.learned);
  Object.keys(BAR_IDS).forEach(function(name){setW(BAR_IDS[name],view.modules[name])})}

registerRouteHook(function(id){if(id==='scr10')renderProgress()});

export {renderProgress};
