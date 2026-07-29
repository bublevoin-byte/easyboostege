const HIST=[];
const ROUTE_HOOKS=[];

function cur(){const active=document.querySelector('.screen.on');return active?active.id:'scr5'}
function showScreen(id){const target=document.getElementById(id);if(!target)return;document.querySelectorAll('.screen').forEach(function(screen){screen.classList.remove('on')});target.classList.add('on');target.scrollTop=0;var menu=document.getElementById('navmenu');if(menu)menu.classList.remove('open')}
function show(id){return showScreen(id)}
function registerRouteHook(hook){ROUTE_HOOKS.push(hook)}
/* Экранам маршрутизатор ничего не должен: подготовку экрана делает хук, который регистрирует app.js. */
function tab(id){const previous=cur();if(id!==previous&&previous!=='scr5'&&previous!=='scr6')HIST.push(previous);showScreen(id);ROUTE_HOOKS.forEach(function(hook){try{hook(id,previous)}catch(e){console.error('Route hook failed',e)}})}
function nav(id){tab(id)}
function back(){let id=HIST.pop()||'scr1';if(id==='scr5'||id==='scr6')id='scr1';showScreen(id)}

(function buildDebugNavigation(){const menu=document.getElementById('navmenu');document.querySelectorAll('.screen').forEach(function(screen){const button=document.createElement('button');button.type='button';button.textContent=screen.id.replace('scr','')+' · '+screen.dataset.name;button.setAttribute('aria-label','Открыть экран '+(screen.dataset.name||screen.id));button.onclick=function(){HIST.length=0;tab(screen.id)};menu.appendChild(button)})})();

export {HIST,back,cur,nav,registerRouteHook,show,showScreen,tab};
