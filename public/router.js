const HIST=[];
const ROUTE_HOOKS=[];
const ui=window.EasyBoostComponents;
const api=window.EasyBoostApi;
/* Код предметного экрана приезжает чанком; источник подключает screens.js. */
let SCREEN_SOURCE=null;
/* Сколько ждём чанк молча. На быстром соединении он приходит раньше, и ученик не видит ничего
   нового: ни состояния загрузки, ни промежуточного экрана. */
const SCREEN_STATE_DELAY=100;

function cur(){const active=document.querySelector('.screen.on');return active?active.id:'scr5'}
function showScreen(id){const target=document.getElementById(id);if(!target)return;document.querySelectorAll('.screen').forEach(function(screen){screen.classList.remove('on')});target.classList.add('on');target.scrollTop=0;var menu=document.getElementById('navmenu');if(menu)menu.classList.remove('open')}
function show(id){return showScreen(id)}
function registerRouteHook(hook){ROUTE_HOOKS.push(hook)}
function registerScreenSource(source){SCREEN_SOURCE=source}
function enter(id,previous){if(id!==previous&&previous!=='scr5'&&previous!=='scr6')HIST.push(previous);showScreen(id)}
/* Экранам маршрутизатор ничего не должен: подготовку экрана делает хук, который регистрирует
   сам экран, — свои хуки чанк регистрирует, пока грузится, и они срабатывают на этом же переходе. */
function runRouteHooks(id,previous){ROUTE_HOOKS.forEach(function(hook){try{hook(id,previous)}catch(e){console.error('Route hook failed',e)}})}
/*
 * Ошибка загрузки чанка — это состояние с повторной попыткой, а не пустой экран. Формулировку
 * берём из общего словаря ошибок: без сети ученик должен прочитать про сеть, а не про экран.
 */
function screenFailed(id,after){
  ui.screenState({kind:'error',title:'Экран не загрузился',
    description:api.messageFor({code:navigator.onLine===false?'NETWORK_ERROR':'REQUEST_FAILED',status:navigator.onLine===false?0:500},'request'),
    actionLabel:'Повторить',onAction:function(){ui.clearScreenState();tab(id,after)}});
}
function tab(id,after){
  const previous=cur();
  const pending=SCREEN_SOURCE?SCREEN_SOURCE(id):null;
  if(!pending){enter(id,previous);runRouteHooks(id,previous);if(after)after();return}
  let entered=false;
  const waiting=setTimeout(function(){entered=true;enter(id,previous);
    ui.screenState({kind:'loading',title:'Открываем экран',description:'Загружаем задания'})},SCREEN_STATE_DELAY);
  pending.then(function(){
    clearTimeout(waiting);
    if(entered)ui.clearScreenState();else enter(id,previous);
    runRouteHooks(id,previous);
    if(after)after();
  },function(error){
    clearTimeout(waiting);
    console.error('Screen chunk failed',error);
    screenFailed(id,after);
  });
}
function nav(id,after){tab(id,after)}
function back(){let id=HIST.pop()||'scr1';if(id==='scr5'||id==='scr6')id='scr1';showScreen(id)}

(function buildDebugNavigation(){const menu=document.getElementById('navmenu');document.querySelectorAll('.screen').forEach(function(screen){const button=document.createElement('button');button.type='button';button.textContent=screen.id.replace('scr','')+' · '+screen.dataset.name;button.setAttribute('aria-label','Открыть экран '+(screen.dataset.name||screen.id));button.onclick=function(){HIST.length=0;tab(screen.id)};menu.appendChild(button)})})();

export {HIST,back,cur,nav,registerRouteHook,registerScreenSource,show,showScreen,tab};
