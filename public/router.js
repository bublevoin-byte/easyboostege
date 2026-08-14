const HIST=[];
const ROUTE_HOOKS=[];
const ui=window.EasyBoostComponents;
const api=window.EasyBoostApi;
/* Код предметного экрана приезжает чанком; источник подключает screens.js. */
let SCREEN_SOURCE=null;
let NAVIGATION_REVISION=0;
let NAVIGATION_SCREEN_STATE_REVISION=null;
/* Сколько ждём чанк молча. На быстром соединении он приходит раньше, и ученик не видит ничего
   нового: ни состояния загрузки, ни промежуточного экрана. */
const SCREEN_STATE_DELAY=100;

function cur(){const active=document.querySelector('.screen.on');return active?active.id:'scr5'}
/*
 * Подготовленный экран перестаёт быть подготовленным при любом переключении: дальше он либо станет
 * активным, либо снова уйдёт из отрисовки, и в обоих случаях недостижимая копия в дереве не нужна.
 */
function unprepare(screen){if(!screen.classList.contains('prep'))return;screen.classList.remove('prep');screen.removeAttribute('aria-hidden');screen.inert=false}
function showScreen(id){const target=document.getElementById(id);if(!target)return;document.querySelectorAll('.screen').forEach(function(screen){screen.classList.remove('on');unprepare(screen)});target.classList.add('on');target.scrollTop=0;var menu=document.getElementById('navmenu');if(menu)menu.classList.remove('open')}
/*
 * Первый показ экрана — самая дорогая его отрисовка: браузер впервые считает стили и layout всего
 * поддерева и впервые растрирует его тени, градиенты и кольца. Внутри клика вся эта работа попадает
 * в окно взаимодействия и целиком уходит в презентационную задержку — измерено трассой CDP: после
 * входа в демо графический процесс отдаёт семь растровых сбросов по 22–44 мс, пока обработчик
 * клика уже давно закончил.
 *
 * Поэтому экран, на который ученик уйдёт следующим, готовится заранее: он раскладывается и
 * растрируется под активным экраном, невидимый (класс `prep`), недостижимый для мыши, клавиатуры и
 * скринридера. К моменту клика браузеру остаётся только поменять порядок наложения.
 *
 * Подготовка ставится после первого кадра: до него важнее отрисовать тот экран, который ученик
 * видит сейчас, и подготовка не должна отодвигать его LCP.
 */
function prepareScreen(id){
  const target=document.getElementById(id);
  if(!target||target.classList.contains('on')||target.classList.contains('prep'))return;
  requestAnimationFrame(function(){setTimeout(function(){
    if(target.classList.contains('on')||target.classList.contains('prep'))return;
    target.setAttribute('aria-hidden','true');
    target.inert=true;
    target.classList.add('prep');
  },0)});
}
function clearNavigationScreenState(revision=null){if(NAVIGATION_SCREEN_STATE_REVISION==null)return false;
  if(revision!=null&&NAVIGATION_SCREEN_STATE_REVISION!==revision)return false;
  NAVIGATION_SCREEN_STATE_REVISION=null;ui.clearScreenState();return true}
function showNavigationScreenState(revision,state){if(revision!==NAVIGATION_REVISION)return false;
  clearNavigationScreenState();NAVIGATION_SCREEN_STATE_REVISION=revision;ui.screenState(state);return true}
function show(id){NAVIGATION_REVISION+=1;clearNavigationScreenState();return showScreen(id)}
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
function screenFailed(id,after,options,navigationRevision){
  showNavigationScreenState(navigationRevision,{kind:'error',title:'Экран не загрузился',
    description:api.messageFor({code:navigator.onLine===false?'NETWORK_ERROR':'REQUEST_FAILED',status:navigator.onLine===false?0:500},'request'),
    actionLabel:'Повторить',onAction:function(){clearNavigationScreenState(navigationRevision);tab(id,after,options)}});
}
function tab(id,after,options={}){
  const navigationRevision=++NAVIGATION_REVISION;
  clearNavigationScreenState();
  const previous=cur();
  const canCommit=function(){try{return navigationRevision===NAVIGATION_REVISION
    &&options.signal?.aborted!==true
    &&(typeof options.beforeCommit!=='function'||options.beforeCommit()===true)}catch(_){return false}};
  let canceled=false;
  const cancel=function(){if(canceled)return;canceled=true;clearNavigationScreenState(navigationRevision);
    try{if(typeof options.onCancel==='function')options.onCancel()}catch(_){}};
  const cancelNavigation=function(){if(navigationRevision===NAVIGATION_REVISION)NAVIGATION_REVISION+=1;cancel()};
  if(options.signal?.aborted){cancelNavigation();return false}
  if(typeof options.signal?.addEventListener==='function')options.signal.addEventListener('abort',cancelNavigation,{once:true});
  const pending=SCREEN_SOURCE?SCREEN_SOURCE(id):null;
  if(!pending){if(!canCommit()){cancel();return false}enter(id,previous);runRouteHooks(id,previous);if(after)after(canCommit);return true}
  const waiting=setTimeout(function(){if(!canCommit()){cancel();return}
    showNavigationScreenState(navigationRevision,{kind:'loading',title:'Открываем экран',description:'Загружаем задания'})},SCREEN_STATE_DELAY);
  pending.then(function(){
    clearTimeout(waiting);
    if(!canCommit()){cancel();return}
    clearNavigationScreenState(navigationRevision);enter(id,previous);
    runRouteHooks(id,previous);
    if(after)after(canCommit);
  },function(error){
    clearTimeout(waiting);
    if(!canCommit()){cancel();return}
    clearNavigationScreenState(navigationRevision);
    console.error('Screen chunk failed',error);
    screenFailed(id,after,options,navigationRevision);
  });
  return{cancel:cancelNavigation,isCurrent:canCommit}
}
function nav(id,after,options){return tab(id,after,options)}
function back(){NAVIGATION_REVISION+=1;clearNavigationScreenState();const previous=cur();let id=HIST.pop()||'scr1';if(id==='scr5'||id==='scr6')id='scr1';showScreen(id);runRouteHooks(id,previous)}

(function buildDebugNavigation(){const menu=document.getElementById('navmenu');document.querySelectorAll('.screen').forEach(function(screen){const button=document.createElement('button');button.type='button';button.textContent=screen.id.replace('scr','')+' · '+screen.dataset.name;button.setAttribute('aria-label','Открыть экран '+(screen.dataset.name||screen.id));button.onclick=function(){HIST.length=0;tab(screen.id)};menu.appendChild(button)})})();

export {HIST,back,cur,nav,prepareScreen,registerRouteHook,registerScreenSource,show,showScreen,tab};
