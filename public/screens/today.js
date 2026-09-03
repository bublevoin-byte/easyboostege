import {readAdaptiveOverviewCacheSnapshot,writeAdaptiveOverviewCache} from '../adaptive-overview-cache.js';
import {
  advanceAdaptiveBreak,
  beginAdaptiveBlock,
  finishAdaptiveSession,
  resumeAdaptiveExecution,
} from '../adaptive-session-loader.js';
import {projectToday} from '../modules/today.js';
import {cur,nav,navigateTopLevel,registerRouteHook} from '../router.js';
import {
  S,
  apiCanUseOfflineFallback,
  apiGet,
  apiIsAuthorityFailure,
  apiMessage,
  apiPost,
  apiPostIdempotent,
  apiResponseOwner,
  currentDisplayName,
  currentOwnerBinding,
  invalidateLearningAuthority,
  profileModule,
  recheckLearningAccess,
  registerAuthorityReset,
  save,
  verifyLearningAccessForLaunch,
} from '../app.js';

const DEFERRED_KEY='easyboost.today.diagnostic-deferred.v1';
const TODAY_LOAD_TIMEOUT_MS=8_000;
let todayAuthority=null;
let todayToken=0;
let selectedMinutes=null;
let todayData=null;
let todayView=null;
let pendingStart=null;
let todayLoadController=null;
let startInFlight=false;
let actionNotice='';
let animationRevision=0;
let announcementRevision=0;

function ownerAuthority(){
  const binding=currentOwnerBinding();
  if(!binding)return null;
  const generation=window.EasyBoostSync?.ownerBoundGeneration?.(binding.username);
  return Number.isSafeInteger(generation)&&generation===binding.generation
    ?{owner:binding.username,ownerGeneration:generation}:null;
}
function sameOwner(left,right){return Boolean(left&&right&&left.owner===right.owner&&left.ownerGeneration===right.ownerGeneration)}
function beginTodayView(){todayLoadController?.abort();todayLoadController=null;const authority=ownerAuthority();todayToken+=1;todayAuthority=authority?{...authority}:null;return authority?Object.freeze({...authority,token:todayToken}):null}
function todayAuthorityCurrent(authority){return Boolean(authority&&authority.token===todayToken&&sameOwner(authority,todayAuthority)&&sameOwner(authority,ownerAuthority()))}
function commitToday(authority,commit){if(!todayAuthorityCurrent(authority))return false;commit();return true}
function expectedOwnerHeaders(authority){return{headers:{'X-EasyBoost-Expected-Owner':authority.owner}}}
function expectedOwnerHeader(authority){return{'X-EasyBoost-Expected-Owner':authority.owner}}
function deferredStorageKey(authority){return DEFERRED_KEY+':'+encodeURIComponent(authority.owner)+':g'+authority.ownerGeneration}
function diagnosticDeferred(authority){try{return sessionStorage.getItem(deferredStorageKey(authority))==='true'}catch(_){return false}}
function idempotencyKey(){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'
  ?globalThis.crypto.randomUUID():'today-session-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}

function ownerChangedError(){return Object.assign(new Error('Today owner changed'),{code:'OWNER_CHANGED',status:409})}
async function ownedRequest(request,authority,{optional=false}={}){
  if(!todayAuthorityCurrent(authority))throw ownerChangedError();
  try{
    const payload=await request();
    if(apiResponseOwner(payload)!==authority.owner||!todayAuthorityCurrent(authority))throw ownerChangedError();
    return payload;
  }catch(error){if(optional&&Number(error?.status)===404)return null;throw error}
}
function ownedGet(path,authority,{optional=false,signal}={}){
  const requestOptions=expectedOwnerHeaders(authority);if(signal)requestOptions.signal=signal;
  return ownedRequest(function(){return apiGet(path,requestOptions)},authority,{optional});
}
function ownedPost(path,body,authority){
  return ownedRequest(function(){return apiPost(path,body,expectedOwnerHeader(authority))},authority);
}
function ownedPostIdempotent(path,body,key,authority){
  return ownedRequest(function(){return apiPostIdempotent(path,body,key,expectedOwnerHeader(authority))},authority);
}

function text(id,value){const node=document.getElementById(id);if(node)node.textContent=value==null?'':String(value)}
function announce(message){
  const live=document.getElementById('today-live');if(!live)return;
  const revision=++announcementRevision;live.textContent='';
  requestAnimationFrame(function(){if(live.isConnected&&revision===announcementRevision)live.textContent=message})
}
function transitionHero(status,busy=false){
  const hero=document.getElementById('today-hero');const ready=document.getElementById('today-ready');
  if(!hero||!ready)return false;
  const changed=hero.dataset.state!==status;
  hero.dataset.state=status;ready.dataset.state=status;hero.setAttribute('aria-busy',String(busy));
  if(status==='loading')hero.dataset.skeleton='';else delete hero.dataset.skeleton;
  if(changed){hero.classList.remove('is-settling');const revision=++animationRevision;
    requestAnimationFrame(function(){if(hero.isConnected&&hero.dataset.state===status&&revision===animationRevision)hero.classList.add('is-settling')})}
  return changed
}
function configurePrimary({label,kind='',disabled=false,busy=false}){
  const primary=document.getElementById('today-primary');if(!primary)return;
  primary.textContent=label;primary.dataset.action=kind;primary.disabled=disabled;
  if(busy)primary.setAttribute('aria-busy','true');else primary.removeAttribute('aria-busy')
}
function currentInput(status='ready',extra={}){return{
  status,
  now:Date.now(),
  timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  displayName:currentDisplayName,
  selectedMinutes,
  preferences:S?.learnerPreferences,
  localProgress:S,
  overview:todayData?.overview||null,
  session:todayData?.session||null,
  execution:todayData?.execution||null,
  diagnostic:todayData?.diagnostic||null,
  diagnosticDeferred:todayAuthority?diagnosticDeferred(todayAuthority):false,
  source:todayData?.source||'online',
  ...extra,
}}

function renderState(status,description=''){
  const view=projectToday(currentInput(status));todayView=view;
  const state=document.getElementById('today-state');const content=document.getElementById('today-content');
  const support=document.getElementById('today-support');if(!state||!content||!support)return;
  const loading=status==='loading';const changed=transitionHero(status,loading);
  state.hidden=false;content.hidden=true;support.hidden=true;
  text('today-title',view.greeting);text('today-context',view.context);
  text('today-state-title',view.state.title);text('today-state-message',description||view.state.message);
  const pulse=state.querySelector('.today-state__pulse');if(pulse)pulse.hidden=status!=='loading';
  actionNotice='';text('today-action-notice','');
  configurePrimary({
    label:loading?'Собираем маршрут':view.state.recovery.label,
    kind:loading?'':view.state.recovery.kind,
    disabled:loading,
    busy:loading,
  });
  if(changed)announce(description||view.state.title+'. '+view.state.message)
}

function persistDuration(minutes){
  if(minutes===10||!S)return;
  const current=profileModule.studyPreferences(S.learnerPreferences);
  const next=profileModule.createStudyPreferences(current.schoolGrade,minutes);
  if(!next)return;
  S.learnerPreferences=next;save({queueNow:true});
}
function selectDuration(minutes,{focus=false}={}){
  if(startInFlight)return;
  selectedMinutes=minutes;persistDuration(minutes);renderReady();
  if(focus)document.querySelector(`#today-duration-options [data-minutes="${minutes}"]`)?.focus();
}
function durationKeydown(event){
  const choices=todayView?.duration?.choices||[];const current=Number(event.currentTarget.dataset.minutes);const index=choices.indexOf(current);
  let next=null;
  if(['ArrowRight','ArrowDown'].includes(event.key))next=choices[(index+1)%choices.length];
  if(['ArrowLeft','ArrowUp'].includes(event.key))next=choices[(index-1+choices.length)%choices.length];
  if(event.key==='Home')next=choices[0];if(event.key==='End')next=choices.at(-1);
  if(next==null)return;event.preventDefault();selectDuration(next,{focus:true});
}
function renderDurations(view){
  const root=document.getElementById('today-duration-options');if(!root)return;
  const signature=view.duration.choices.join(',');
  if(root.dataset.choices!==signature){root.dataset.choices=signature;root.replaceChildren(...view.duration.choices.map(function(minutes){
    const button=document.createElement('button');button.type='button';button.className='today-duration__option';button.setAttribute('role','radio');
    button.setAttribute('aria-label',minutes+' минут');button.dataset.minutes=String(minutes);
    const value=document.createElement('strong');value.textContent=String(minutes);
    const unit=document.createElement('span');unit.textContent='мин';button.append(value,unit);
    button.addEventListener('click',function(){selectDuration(minutes)});button.addEventListener('keydown',durationKeydown);return button;
  }))}
  Array.from(root.children).forEach(function(button){const selected=Number(button.dataset.minutes)===view.duration.selected;button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1;button.disabled=startInFlight});
  text('today-duration-help',view.duration.help);
}
function rhythmLabel(view){return view.rhythm.streakDays>0?view.rhythm.streakDays+' дн. подряд':'Начало ритма'}
function rhythmDetail(view){const today=view.rhythm.todayMinutes+' мин сегодня';return view.rhythm.weeklyTargetMinutes>0?today+' · цель '+view.rhythm.weeklyTargetMinutes+' мин/нед.':today}
function renderRoute(view){
  const route=document.getElementById('today-route');const list=document.getElementById('today-route-steps');
  if(!route||!list)return;
  text('today-route-label',view.route.label);route.setAttribute('aria-label',view.route.label);
  list.replaceChildren(...view.route.steps.map(function(step){
    const item=document.createElement('li');item.className='today-route__step';item.dataset.state=step.state;
    if(step.state==='current')item.setAttribute('aria-current','step');
    const marker=document.createElement('span');marker.className='today-route__marker';marker.setAttribute('aria-hidden','true');marker.textContent=step.state==='complete'?'✓':String(step.position);
    const label=document.createElement('strong');label.textContent=step.label;
    const detail=document.createElement('small');detail.textContent=step.detail;
    item.append(marker,label,detail);return item
  }))
}

function renderReady(){
  if(!todayData)return;
  const view=projectToday(currentInput());todayView=view;
  if(view.status!=='ready'){renderState(view.status);return}
  const state=document.getElementById('today-state');const content=document.getElementById('today-content');const support=document.getElementById('today-support');if(!state||!content||!support)return;
  const presentation=view.source==='offline'?'offline':view.recommendation.action.kind==='continue-adaptive-session'?'resume':'ready';
  const changed=transitionHero(presentation,startInFlight);
  state.hidden=true;content.hidden=false;support.hidden=false;
  text('today-title',view.greeting);text('today-context',view.context);
  text('today-recommendation-title',view.recommendation.title);
  text('today-recommendation-reason',view.recommendation.reason);
  text('today-recommendation-outcome',view.recommendation.outcome);
  text('today-estimate',view.recommendation.estimatedMinutes?view.recommendation.estimatedMinutes+' мин':'по плану');
  renderDurations(view);
  renderRoute(view);
  configurePrimary({label:view.recommendation.ctaLabel,kind:'recommendation',disabled:startInFlight,busy:startInFlight});
  text('today-action-notice',actionNotice);
  text('today-rhythm',rhythmLabel(view));text('today-rhythm-detail',rhythmDetail(view));text('today-countdown',view.countdown.label);
  const source=document.getElementById('today-source-note');if(source){source.hidden=view.source!=='offline';source.textContent=view.source==='offline'
    ?'Показана сохранённая копия. Новое занятие не запустится без сети; быстрая практика доступна.':''}
  const diagnostic=document.getElementById('today-diagnostic');if(diagnostic){diagnostic.hidden=!view.diagnostic.visible;diagnostic.dataset.state=view.diagnostic.state;
    text('today-diagnostic-title',view.diagnostic.title);text('today-diagnostic-copy',view.diagnostic.copy);
  }
  if(changed)announce((presentation==='offline'
    ?'Нет сети. Показана сохранённая копия. '
    :presentation==='resume'?'Можно продолжить занятие. ':'Маршрут на сегодня готов. ')+view.recommendation.title)
}

function fallbackOverview(){return{
  goal:null,profile:{needsDiagnostic:false,evidenceCount:0},plan:null,
  retention:{rediagnostic:{due:false}},access:{capabilities:{adaptivePlan:false}},
}}
async function loadToday(){
  const authority=beginTodayView();pendingStart=null;startInFlight=false;actionNotice='';todayData=null;
  if(!authority){renderState('access');return}
  if(!sameOwner(authority,todayAuthority))return;
  const preferred=profileModule.studyPreferences(S?.learnerPreferences).preferredSessionMinutes;
  selectedMinutes=Number.isInteger(preferred)&&preferred>=15&&preferred<=120&&preferred%5===0?preferred:20;
  renderState('loading');
  if(window.__sub?.features?.adaptive_learning!==true){
    commitToday(authority,function(){todayData={overview:fallbackOverview(),session:null,execution:null,diagnostic:null,source:'online'};renderReady()});return;
  }
  const controller=new AbortController();todayLoadController=controller;let timedOut=false;let timeout;
  const deadline=new Promise(function(_resolve,reject){timeout=setTimeout(function(){
    timedOut=true;controller.abort();reject(Object.assign(new Error('Today load timed out'),{code:'REQUEST_TIMEOUT'}));
  },TODAY_LOAD_TIMEOUT_MS)});
  try{
    const [overview,current,diagnostic]=await Promise.race([Promise.all([
      ownedGet('/api/v1/adaptive-learning/overview',authority,{signal:controller.signal}),
      ownedGet('/api/v1/adaptive-learning/sessions/current',authority,{optional:true,signal:controller.signal}),
      ownedGet('/api/v1/adaptive-learning/diagnostics/current',authority,{optional:true,signal:controller.signal}),
    ]),deadline]);
    if(!todayAuthorityCurrent(authority))return;
    await writeAdaptiveOverviewCache(localStorage,authority.owner,overview,Date.now(),authority.ownerGeneration);
    commitToday(authority,function(){todayData={
      overview,session:current?.session||null,execution:current?.execution||null,
      diagnostic,source:'online',
    };renderReady()});
  }catch(error){
    if(!todayAuthorityCurrent(authority))return;
    if(timedOut){renderState('error','Загрузка заняла слишком много времени. Повторите попытку.');return}
    if(apiIsAuthorityFailure(error)){await invalidateLearningAuthority(authority);return}
    if(apiCanUseOfflineFallback(error)){
      const cached=readAdaptiveOverviewCacheSnapshot(localStorage,authority.owner,Date.now(),authority.ownerGeneration);
      if(cached){commitToday(authority,function(){todayData={overview:cached.payload,session:null,execution:null,diagnostic:null,source:'offline'};renderReady()});return}
      renderState('offline');return;
    }
    if([402,403].includes(Number(error?.status))){await recheckLearningAccess();return}
    renderState('error',apiMessage(error,'request'));
  }finally{clearTimeout(timeout);if(todayLoadController===controller)todayLoadController=null}
}

function openQuickPractice(){nav('scr2',function(canCommit){if(canCommit()&&typeof window.wStartPractice==='function')window.wStartPractice()})}
function openPlan(){nav('scr10',function(canCommit){if(!canCommit())return;requestAnimationFrame(function(){const target=document.getElementById('adaptive_goal_form');if(!target||target.closest('[hidden]'))return;target.querySelector('input,button')?.focus();target.scrollIntoView({block:'start'})})})}
async function launchCurrentSession(session,execution,authority){
  if(!session||!execution)return nav('scr10');
  await resumeAdaptiveExecution();
  if(!todayAuthorityCurrent(authority))return false;
  if(execution.readyToFinish){await finishAdaptiveSession(session,execution);await loadToday();return true}
  const block=(session.blocks||[]).find(function(item){return item.id===execution.currentBlockId});
  if(!block)return nav('scr10');
  if(block.kind==='break'){await advanceAdaptiveBreak(session,block,execution);await loadToday();return true}
  return beginAdaptiveBlock(session,block,execution);
}
async function launchAdaptive(minutes,authority){
  if(!await verifyLearningAccessForLaunch()||!todayAuthorityCurrent(authority))return false;
  if(todayData.session)return launchCurrentSession(todayData.session,todayData.execution,authority);
  if(!pendingStart||pendingStart.minutes!==minutes){
    const preview=await ownedPost('/api/v1/adaptive-learning/sessions/preview',{durationMinutes:minutes},authority);
    pendingStart={minutes,preview:preview.preview,key:idempotencyKey()};
  }
  const created=await ownedPostIdempotent('/api/v1/adaptive-learning/sessions',{
    durationMinutes:pendingStart.minutes,previewFingerprint:pendingStart.preview.previewFingerprint,
  },pendingStart.key,authority);
  const current=await ownedGet('/api/v1/adaptive-learning/sessions/current',authority);
  pendingStart=null;
  todayData.session=current.session||created.session;todayData.execution=current.execution||created.execution;
  return launchCurrentSession(todayData.session,todayData.execution,authority);
}
async function runPrimary(){
  if(startInFlight)return;
  const primary=document.getElementById('today-primary');const recovery=primary?.dataset.action;
  if(recovery!=='recommendation'){
    if(recovery==='retry')void loadToday();
    else if(recovery==='quick-practice')openQuickPractice();
    else if(recovery==='open-plan')openPlan();
    else if(recovery==='open-profile')navigateTopLevel('scr11');
    return
  }
  const action=todayView?.recommendation?.action;if(!action)return;
  if(action.kind==='quick-practice'){openQuickPractice();return}
  const authority=Object.freeze({...todayAuthority,token:todayToken});if(!todayAuthorityCurrent(authority))return;
  startInFlight=true;actionNotice='Открываем занятие…';renderReady();announce(actionNotice);
  try{await launchAdaptive(action.adaptiveMinutes,authority)}catch(error){
    if(!todayAuthorityCurrent(authority))return;
    if(apiIsAuthorityFailure(error)){await invalidateLearningAuthority(authority);return}
    actionNotice=apiMessage(error,'request');announce(actionNotice);
  }finally{if(todayAuthorityCurrent(authority)){startInFlight=false;renderReady()}}
}

function bindToday(){
  const primary=document.getElementById('today-primary');if(!primary||primary.dataset.bound)return;primary.dataset.bound='true';
  primary.addEventListener('click',runPrimary);
}

bindToday();
function resetToday(){todayLoadController?.abort();todayLoadController=null;todayToken+=1;todayAuthority=null;todayData=null;todayView=null;pendingStart=null;startInFlight=false;actionNotice='';selectedMinutes=null}
registerAuthorityReset(function(authority){if(!sameOwner(authority,todayAuthority))return;resetToday();renderState('access')});
registerRouteHook(function(id,previous){if(id==='scr1'){void loadToday();return}if(previous==='scr1')resetToday()});
if(cur()==='scr1')void loadToday();
