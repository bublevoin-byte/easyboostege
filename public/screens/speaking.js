/*
 * Экран «Говорение» (scr9). Приезжает динамическим import() при первом переходе на него.
 * Озвучку и её остановку берём у общего проигрывателя оболочки — чанк аудирования для этого
 * загружать не нужно.
 */
import {registerRouteHook} from '../router.js';
import {presentPublicPlan} from '../commercial-copy.js';
import {lPlayRaw,lStop} from '../tts.js';
import {
  S,SRV,TOKEN,apiGet,apiMessage,apiPost,apiPostBinary,apiPut,generateAiContent,save,
  setTxt,spSt,spSync,speakingModule,toast,ui,wDeco,
} from '../app.js';
import {adaptiveRuntimeSnapshot,completeAdaptiveServerAttempt,openAdaptivePlan} from '../adaptive-session-runtime.js';
import {adaptiveSpeakingTask} from '../adaptive-speaking-tasks.js';
import '../modules/speaking.js';
import {voiceTutorButton} from '../voice-tutor-loader.js';
import {createSpeakingTask1BrowserFlow} from '../speaking-task1-runtime.js';
import {createSpeakingTask2BrowserFlow} from '../speaking-task2-runtime.js';
import {createSpeakingTask3BrowserFlow} from '../speaking-task3-runtime.js';
import {createSpeakingTask4BrowserFlow} from '../speaking-task4-runtime.js';
import {createSpeakingFullBrowserFlow} from '../speaking-full-runtime.js';
import {convertRecordingToPcm16Wav} from '../speaking-pronunciation-audio.js';
import {SPEAKING_TASK1_CATALOG} from '../content/speaking/task1-v1.js';
import {SPEAKING_TASK2_CATALOG} from '../content/speaking/task2-v1.js';
import {SPEAKING_TASK3_CATALOG} from '../content/speaking/task3-v1.js';
import {SPEAKING_TASK4_CATALOG} from '../content/speaking/task4-v1.js';
import {SPEAKING_TASK4_PHOTO_MANIFEST} from '../assets/speaking/task4-v1/manifest.js';

/* ===== SPEAKING v2: устная часть ЕГЭ, 4 задания ===== */
const SP1=[
{tx:'Libraries are changing fast. Twenty years ago they were quiet places with paper books only. Today a modern library offers computers, online courses and clubs for different hobbies. People come here not only to read, but also to meet friends, work on projects or listen to interesting lectures. Many libraries stay open late in the evening, so students often do their homework there. Scientists say that such places help people of all ages to keep learning through the whole life.'},
{tx:'Walking is the easiest kind of sport. You do not need special equipment, a gym or a trainer — only comfortable shoes. Doctors say that thirty minutes of walking a day make the heart stronger, improve sleep and even help the brain to work better. Walking with friends is also a great way to spend time together. Some schools now organise walking clubs, where students discover interesting places in their city and learn to notice the beauty around them.'}];
const SP_TASK1_CATALOG_KEYS=new Set(SPEAKING_TASK1_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
const SP_TASK2_CATALOG_KEYS=new Set(SPEAKING_TASK2_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
const SP_TASK3_CATALOG_KEYS=new Set(SPEAKING_TASK3_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
const SP2=[
{ad:'Language Summer Camp «Sunny Hills». English every day with native speakers, sports and new friends! Join us this summer!',
 points:['dates of the course','price','number of lessons a day','accommodation'],
 exq:['When does the course start?','How much does the course cost?','How many lessons a day are there?','Where will the students live?']},
{ad:'New Fitness Club «Energy» is open in your district! Modern gym, swimming pool and yoga classes for teenagers.',
 points:['opening hours','monthly fee','age requirements','personal trainer availability'],
 exq:['What are the opening hours?','How much is a monthly membership?','How old should I be to join the club?','Can I train with a personal trainer?']}];
const SP3=[
{topic:'Хобби и свободное время',qs:['What do you usually do in your free time?','Why do teenagers need hobbies?','What new hobby would you like to try and why?','Do you prefer spending free time alone or with friends? Why?','What can a hobby teach a person?']},
{topic:'Школьная жизнь',qs:['What is your favourite school subject and why?','How much time do you usually spend on homework?','What would you like to change in your school?','Why is it important to get a good education?','What are you going to do after leaving school?']}];
const SP4=[
{topic:'Зимние каникулы',
 ph:['Фото 1: семья катается на лыжах в горах в солнечный день','Фото 2: девушка читает книгу у камина дома'],
 plan:['кратко опиши обе фотографии — что на них происходит','скажи, что общего у этих фотографий','скажи, чем они различаются','скажи, какой отдых ближе тебе, и объясни почему']},
{topic:'Еда дома и в кафе',ph:['Фото 1: мама с сыном вместе готовят ужин на кухне','Фото 2: друзья едят пиццу в кафе'],
 plan:['кратко опиши обе фотографии','скажи, что общего у фотографий','скажи, чем они различаются','скажи, что предпочитаешь ты, и объясни почему']}];
const SP_CONF={1:speakingModule.config(1),2:speakingModule.config(2),3:speakingModule.config(3),4:speakingModule.config(4)};
const SP_SHEET={
1:'<b>Как читать вслух на 1 балл:</b><br>— Во время подготовки прочитай текст про себя и отметь трудные слова.<br>— Читай по смысловым кусочкам, с паузами на запятых и точках.<br>— Не глотай окончания <i>-s</i> и <i>-ed</i>: he work<b>s</b>, play<b>ed</b>.<br>— Вопросы читай с восходящей интонацией, утверждения — с нисходящей.<br>— Лучше чуть медленнее, но чётко: ошибки в словах = потеря балла.',
2:'<b>Как задавать прямые вопросы:</b><br>Каждый пункт превращай в ПРЯМОЙ вопрос:<br>— цена → <i>How much does it cost?</i><br>— даты → <i>When does the course start?</i><br>— место → <i>Where is the club located?</i><br>— возможность → <i>Can I…? / Is it possible to…?</i><br><b>Ловушки:</b> «What about the price?» — НЕ вопрос, балл не дадут. Вопрос «зачитыванием пункта» (price?) — тоже. Нужен полный вопрос с вспомогательным глаголом.',
3:'<b>Как отвечать на вопросы интервью:</b><br>— Отвечай развёрнуто: 2-3 предложения, а не «Yes, I do».<br>— Формула: прямой ответ → причина → пример. <i>I usually read in my free time. It helps me to relax. For example, last week I finished a great detective story.</i><br>— Не молчи: если нужно время, начни с <i>Well, let me think…</i><br>— Следи за временем вопроса: «What did you do…» → отвечай в прошедшем.',
4:'<b>Скелет монолога (2,5–3 минуты):</b><br>1. Вступление: <i>I have found two photos for our project about…</i><br>2. Описание: <i>In the first photo we can see… In the second photo there is…</i><br>3. Общее: <i>Both photos show… / What these photos have in common is…</i><br>4. Различия: <i>The main difference is that… while…</i><br>5. Мнение: <i>As for me, I prefer… because…</i><br>6. Финал: <i>That is all I wanted to say.</i><br><b>Ловушка:</b> пропустил пункт плана — минус баллы за решение задачи.'};
let SP=null,SP_rec=null,SP_chunks=[],SP_tm=null,SP_sheet=false,SP_TASK1_FLOW=null,SP_TASK2_FLOW=null,SP_TASK3_FLOW=null,SP_TASK4_FLOW=null;
let SP_ACCENT=null,SP_ACCENT_SETUP=null,SP_CALIBRATION_CONSENT=null,SP_TARGETED_PRACTICE=null;
let SP_VIEW_EPOCH=0;
let SP_VIEW_CONTENT_ROOT=null;
let SP_SETTINGS_BUSY=false,SP_SETTINGS_TOKEN=0;
let SP_COMMIT_BUSY=false,SP_COMMIT_TOKEN=0,SP_COMMIT_LOCK=null;
let SP_EVALUATION_BUSY=false,SP_EVALUATION_TOKEN=0,SP_EVALUATION_LOCK=null;
function spRoute(){return document.getElementById('scr9')}
function spUiState(){
  if(SPE&&SPE.session){if(SPE.isRecording)return 'recording';if(SPE.session.phase==='preparing')return 'preparing';if(SPE.session.phase==='ready_to_submit')return 'ready-to-submit';if(SPE.recording)return 'playback';return SPE.session.phase||'ready'}
  if(!SP)return 'ready';if(SP.evaluating)return 'processing';
  var states={intro:'permission',prep:'preparing',rec:'recording',done:'playback',question:'permission',task2_prompt:'connecting',task2_review:'playback',task2_complete:'ready-to-evaluate',task3_prompt:'connecting',task3_review:'playback',task3_complete:'ready-to-evaluate',task4_review:'playback',task4_complete:'ready-to-evaluate'};
  return states[SP.phase]||SP.phase||'ready'}
function spNormalizeView(forcedState){
  var area=document.getElementById('s9_area');if(!area||typeof area.querySelectorAll!=='function')return;
  var route=spRoute();var state=forcedState||spUiState();if(route){route.dataset.speakingState=state;var routeMain=route.querySelector('.speaking-route');if(routeMain)routeMain.dataset.speakingState=state}area.dataset.speakingState=state;
  area.querySelectorAll('.clayCard').forEach(function(card){card.classList.add('speaking-card')});
  area.querySelectorAll('button.sq').forEach(function(button){
    if(!button.matches('.speaking-choice,.speaking-rating-choice,.speaking-card-action,.speaking-inline-action,.speaking-media-action'))button.classList.add('speaking-control');
    var action=button.getAttribute('onclick')||'';
    if(/(?:sp|speFull)MicCheck/u.test(action)){
      button.dataset.speakingAction='microphone-check';button.setAttribute('aria-pressed',String(Boolean((SP&&SP.mic)||(SPE&&SPE.micCheck==='passed'))));button.setAttribute('aria-describedby','speaking_mic_status')}
    if(/(?:spRec|speFullStartRecording)/u.test(action))button.dataset.speakingAction='record';
    if(/(?:spFinish|speFullStopRecording)/u.test(action))button.dataset.speakingAction='stop-recording';
  });
  var dock=document.getElementById('speaking_action_dock');if(!dock||typeof area.children==='undefined')return;
  var contentRoot=Array.from(area.children).find(function(child){return !(child.matches&&child.matches('button.speaking-action'))&&!(child.classList&&child.classList.contains('speaking-action-stack'))})||null;
  var freshRender=contentRoot!==SP_VIEW_CONTENT_ROOT;
  var areaActions=Array.from(area.querySelectorAll('button.speaking-action'));
  var dockActions=Array.from(dock.querySelectorAll('.speaking-action-stack > button.speaking-action'));
  var frame=route&&route.closest('#frame');
  if(!freshRender&&!areaActions.length){if(frame)frame.dataset.speakingDockActive=String(Boolean(dockActions.length));spFocusViewBoundary(area,route);return}
  var actions=areaActions.length?areaActions:(freshRender?[]:dockActions);
  dock.replaceChildren();
  var stack=document.createElement('div');stack.className='speaking-action-stack';
  actions.forEach(function(action){stack.append(action)});
  var primaries=Array.from(stack.querySelectorAll('.speaking-action--primary'));
  primaries.forEach(function(button,index){button.removeAttribute('id');button.classList.toggle(SP_CANONICAL_PRIMARY_CLASS,index===0)});if(primaries[0])primaries[0].id='s9_primary_action';
  primaries.slice(1).forEach(function(button){button.classList.remove('speaking-action--primary');button.classList.add('speaking-action--secondary','aisy-button--secondary')});
  var hasDockActions=Boolean(stack.children.length);if(hasDockActions){dock.append(stack);dock.hidden=false}else dock.hidden=true;SP_VIEW_CONTENT_ROOT=contentRoot;if(frame)frame.dataset.speakingDockActive=String(hasDockActions);
  spFocusViewBoundary(area,route);
}
function spFocusViewBoundary(area,route){if(!route||!route.classList.contains('on'))return;var active=document.activeElement;var overlay=active&&active.closest&&active.closest('#asya-assistant:not([hidden]),#voiceTutorSheet.open');if(overlay)return;var activeInRoute=Boolean(active&&route.contains(active));var activeInvalid=activeInRoute&&Boolean(active.disabled||active.hidden||active.getAttribute&&active.getAttribute('aria-hidden')==='true'||active.closest&&active.closest('[hidden]'));if(activeInRoute&&!activeInvalid)return;if(!activeInRoute&&active&&active!==document.body&&active!==document.documentElement)return;var focusTarget=area.querySelector('[data-speaking-focus],#s9_card,[role="alert"],[role="status"]');if(focusTarget){focusTarget.tabIndex=-1;try{focusTarget.focus({preventScroll:true})}catch(_){focusTarget.focus()}}}
function spSetSettingsBusy(busy){SP_SETTINGS_BUSY=Boolean(busy);var area=document.getElementById('s9_area');if(!area)return;if(area.setAttribute)area.setAttribute('aria-busy',String(SP_SETTINGS_BUSY));area.querySelectorAll('[data-speaking-setting]').forEach(function(control){control.disabled=SP_SETTINGS_BUSY})}
function spCaptureRouteOperation(kind,token){var route=spRoute(),lock={kind:kind,token:token,route:route,routeBusy:null,controls:[]};if(!route)return lock;if(typeof route.getAttribute==='function')lock.routeBusy=route.getAttribute('aria-busy');if(typeof route.setAttribute==='function')route.setAttribute('aria-busy','true');if(typeof route.querySelectorAll==='function')route.querySelectorAll('button').forEach(function(control){var dataset=control.dataset||{};lock.controls.push({control:control,disabled:Boolean(control.disabled),ariaDisabled:typeof control.getAttribute==='function'?control.getAttribute('aria-disabled'):null,ariaBusy:typeof control.getAttribute==='function'?control.getAttribute('aria-busy'):null,busyData:dataset.busy,operationData:dataset.spOperationLock});control.disabled=true;if(typeof control.setAttribute==='function')control.setAttribute('aria-disabled','true');if(control.dataset)control.dataset.spOperationLock=kind+':'+token});return lock}
function spClearRouteOperation(lock){if(!lock)return;lock.controls.forEach(function(snapshot){var control=snapshot.control;if(!control)return;control.disabled=snapshot.disabled;if(typeof control.setAttribute==='function'&&typeof control.removeAttribute==='function'){if(snapshot.ariaDisabled===null)control.removeAttribute('aria-disabled');else control.setAttribute('aria-disabled',snapshot.ariaDisabled);if(snapshot.ariaBusy===null)control.removeAttribute('aria-busy');else control.setAttribute('aria-busy',snapshot.ariaBusy)}if(control.dataset){if(typeof snapshot.busyData==='undefined')delete control.dataset.busy;else control.dataset.busy=snapshot.busyData;if(typeof snapshot.operationData==='undefined')delete control.dataset.spOperationLock;else control.dataset.spOperationLock=snapshot.operationData}});var route=lock.route;if(route&&typeof route.setAttribute==='function'&&typeof route.removeAttribute==='function'){if(lock.routeBusy===null)route.removeAttribute('aria-busy');else route.setAttribute('aria-busy',lock.routeBusy)}}
function spClearCommitOperation(lock){spClearRouteOperation(lock);var status=document.getElementById('speaking_commit_status');if(status)status.remove()}
function spClearActiveRouteOperations(){spClearCommitOperation(SP_COMMIT_LOCK);spClearRouteOperation(SP_EVALUATION_LOCK);SP_COMMIT_LOCK=null;SP_EVALUATION_LOCK=null;SP_COMMIT_BUSY=false;SP_EVALUATION_BUSY=false}
function spBeginCommit(){if(SP_COMMIT_BUSY||SP_EVALUATION_BUSY)return null;SP_COMMIT_BUSY=true;var token=++SP_COMMIT_TOKEN;SP_COMMIT_LOCK=spCaptureRouteOperation('commit',token);var area=document.getElementById('s9_area');if(area&&typeof document.createElement==='function'&&typeof area.append==='function'){var status=document.createElement('div');status.id='speaking_commit_status';status.className='speaking-state';status.dataset.state='processing';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Сохраняем ответ…';area.append(status)}spNormalizeView('processing');return token}
function spCommitCurrent(token,view){return token===SP_COMMIT_TOKEN&&SP===view}
function spEndCommit(token){if(token!==SP_COMMIT_TOKEN)return;SP_COMMIT_BUSY=false;spClearCommitOperation(SP_COMMIT_LOCK);SP_COMMIT_LOCK=null}
function spBeginEvaluation(view,btn){if(SP_EVALUATION_BUSY||SP_COMMIT_BUSY)return null;SP_EVALUATION_BUSY=true;var token=++SP_EVALUATION_TOKEN;SP_EVALUATION_LOCK=spCaptureRouteOperation('evaluation',token);if(btn){btn.dataset.busy='1';btn.setAttribute('aria-busy','true')}var box=document.getElementById('sp_evalbox');if(box)box.innerHTML='<div class="speaking-state" data-state="processing" role="status" aria-live="polite" aria-atomic="true"><strong>Готовим автоматическую оценку</strong><span>Не закрывай экран, пока записи привязываются к этой тренировке.</span></div>';spNormalizeView('processing');return token}
function spEvaluationCurrent(token,view,sessionId){return token===SP_EVALUATION_TOKEN&&SP_EVALUATION_BUSY&&SP===view&&String(SP&&SP.session&&SP.session.id)===String(sessionId)}
function spReleaseEvaluation(token){if(token!==SP_EVALUATION_TOKEN)return;SP_EVALUATION_BUSY=false;spClearRouteOperation(SP_EVALUATION_LOCK);SP_EVALUATION_LOCK=null}
function spPromoteForwardAction(){var dock=document.getElementById('speaking_action_dock');if(!dock)return;var forward=dock.querySelector('[data-speaking-forward]:not([hidden])');if(!forward)return;dock.querySelectorAll('button.speaking-action').forEach(function(control){control.removeAttribute('id');control.classList.remove('speaking-action--primary',SP_CANONICAL_PRIMARY_CLASS);control.classList.add('speaking-action--secondary','aisy-button--secondary')});forward.classList.remove('speaking-action--secondary','aisy-button--secondary');forward.classList.add('speaking-action--primary',SP_CANONICAL_PRIMARY_CLASS);forward.id='s9_primary_action'}
function spFinishEvaluationView(btn){if(btn){btn.hidden=true;btn.removeAttribute('aria-busy');delete btn.dataset.busy}spPromoteForwardAction();var box=document.getElementById('sp_evalbox');var result=box&&typeof box.querySelector==='function'?(box.querySelector('[role="alert"],[role="status"]')||box):null;if(result&&typeof result.focus==='function'){result.tabIndex=-1;try{result.focus({preventScroll:true})}catch(_){result.focus()}}}
function spAnim(n,d){spNormalizeView();ui.animate('s9_card',n,d)}
function spMime(){return speakingModule.preferredMimeType(window.MediaRecorder)}
function spFmt(s){return speakingModule.formatTime(s)}
function spStopAll(){clearInterval(SP_tm);SP_tm=null;
  spClearActiveRouteOperations();SP_COMMIT_TOKEN++;SP_EVALUATION_TOKEN++;
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  try{lStop()}catch(e){}}
function spReleaseRecording(){if(SP&&SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}if(SP){SP.url=null;SP.blob=null;SP.pronunciationUploadCache=null}SP_chunks=[]}
function spDisposeTask1Flow(){if(SP_TASK1_FLOW){SP_TASK1_FLOW.dispose();SP_TASK1_FLOW=null}}
function spDisposeTask2Flow(){if(SP_TASK2_FLOW){SP_TASK2_FLOW.dispose();SP_TASK2_FLOW=null}}
function spDisposeTask3Flow(){if(SP_TASK3_FLOW){SP_TASK3_FLOW.dispose();SP_TASK3_FLOW=null}}
function spDisposeTask4Flow(){if(SP_TASK4_FLOW){SP_TASK4_FLOW.dispose();SP_TASK4_FLOW=null}}
function officialTask2Active(){return Boolean(SP&&SP.t===2&&SP_TASK2_FLOW)}
function officialTask3Active(){return Boolean(SP&&SP.t===3&&SP_TASK3_FLOW)}
function officialTask4Active(){return Boolean(SP&&SP.t===4&&SP_TASK4_FLOW)}
function task4PhotoAsset(src){return SPEAKING_TASK4_PHOTO_MANIFEST.assets.find(function(asset){return asset.src===src})||null}
function task2RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK2_CATALOG_REVISION_MISMATCH'}
function task3RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK3_CATALOG_REVISION_MISMATCH'}
function task4RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK4_CATALOG_REVISION_MISMATCH'}
function adaptiveSpeakingLock(){try{var active=adaptiveRuntimeSnapshot().active;return active&&active.module==='speaking'?active:null}catch(_){return null}}
function launchAdaptiveSpeakingLock(lock){if(!lock)return false;var descriptor=adaptiveSpeakingTask(lock.contentRef);if(!descriptor)return false;void spOpen(descriptor.taskNumber,{adaptiveLock:lock});return true}
function initSpeaking(){if(!S)return;var lock=adaptiveSpeakingLock();spStopAll();spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();speFullDispose();SP=null;spSync();if(lock){launchAdaptiveSpeakingLock(lock);return}
  var epoch=++SP_VIEW_EPOCH;var area=document.getElementById('s9_area');if(area)area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Загружаем профиль произношения…</div>';spNormalizeView('loading');
  Promise.all([apiGet('/api/v1/speaking/accent-profile'),apiGet('/api/v1/speaking/calibration-consent')]).then(function(results){
    if(epoch!==SP_VIEW_EPOCH)return;
    SP_ACCENT=results[0]&&results[0].profile||null;SP_ACCENT_SETUP=results[0]&&results[0].calibration||null;SP_CALIBRATION_CONSENT=results[1]&&results[1].consent||null;
    if(SP_ACCENT)spHub();else spAccentSetup()}).catch(function(error){if(epoch!==SP_VIEW_EPOCH)return;if(area)area.innerHTML='<div class="clayCard speaking-state" data-state="network-error" role="alert">Не удалось загрузить профиль произношения. Проверь сеть и повтори.</div>'+spBtn('Повторить','initSpeaking()',true);spNormalizeView('retry');try{toast(apiMessage(error,'request'))}catch(_){}})}
function spAccentSetup(){var area=document.getElementById('s9_area');if(!area)return;SP_VIEW_EPOCH++;SP_SETTINGS_BUSY=false;if(area.setAttribute)area.setAttribute('aria-busy','false');
  var calibrationChoice=!SP_ACCENT
    ?'<button type="button" class="sq speaking-choice" data-speaking-setting onclick="spAccentStartUnknown()"><span>'+(SP_ACCENT_SETUP?'Продолжить короткую двойную калибровку':'Не знаю — короткая двойная калибровка')+'</span><span class="speaking-chip">en-GB + en-US</span></button>'
      +'<div class="speaking-note speaking-note--info">Для варианта «Не знаю» одна и та же короткая запись проверяется в en-GB и en-US один раз. Затем приложение предлагает профиль; оно не выбирает больший балл заново на каждой попытке.</div>'
    :'<div class="speaking-note speaking-note--info">Изменение применяется только к новым тренировкам. Уже начатая тренировка сохраняет прежний профиль.</div>';
  var currentLocale=SP_ACCENT&&SP_ACCENT.locale||'';
  area.innerHTML='<div class="speaking-view"><section id="s9_card" class="speaking-sheet speaking-sheet--roomy speaking-stack" data-speaking-focus>'
    +'<h2 class="speaking-heading">Какой вариант произношения будем тренировать?</h2>'
    +'<p class="speaking-copy speaking-copy--muted">ЕГЭ допускает обе нормы. Выбор закрепляется за новой тренировкой и не меняет уже сохранённые оценки.</p>'
    +'<div class="speaking-choice-group" role="group" aria-label="Вариант английского произношения">'
    +'<button type="button" class="sq speaking-choice" data-speaking-setting data-selected="'+String(currentLocale==='en-GB')+'" aria-pressed="'+String(currentLocale==='en-GB')+'" onclick="spChooseAccent(\'en-GB\')"><span>Британский</span><span class="speaking-chip">en-GB'+(currentLocale==='en-GB'?' · выбран':'')+'</span></button>'
    +'<button type="button" class="sq speaking-choice" data-speaking-setting data-selected="'+String(currentLocale==='en-US')+'" aria-pressed="'+String(currentLocale==='en-US')+'" onclick="spChooseAccent(\'en-US\')"><span>Американский</span><span class="speaking-chip">en-US'+(currentLocale==='en-US'?' · выбран':'')+'</span></button>'
    +calibrationChoice+'</div></section>'
    +(SP_ACCENT?'<div class="speaking-action-stack">'+spBtn('Назад без изменений','spHub()',false)+'</div>':'')+'</div>';setTxt('s9_today','настройка произношения');spNormalizeView('accent-required')}
async function spChooseAccent(locale){if(!['en-GB','en-US'].includes(locale)||SP_SETTINGS_BUSY)return false;var epoch=SP_VIEW_EPOCH,token=++SP_SETTINGS_TOKEN;spSetSettingsBusy(true);try{var result=await apiPut('/api/v1/speaking/accent-profile',{locale:locale});if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH||!spRoute()?.classList.contains('on'))return false;SP_ACCENT=result.profile;SP_ACCENT_SETUP=null;spHub();return true}catch(error){if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{if(token===SP_SETTINGS_TOKEN)spSetSettingsBusy(false)}}
async function spAccentStartUnknown(){if(SP_SETTINGS_BUSY)return false;var epoch=SP_VIEW_EPOCH,token=++SP_SETTINGS_TOKEN;spSetSettingsBusy(true);try{var setup=SP_ACCENT_SETUP||await apiPost('/api/v1/speaking/accent-profile/calibration',{});if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH||!spRoute()?.classList.contains('on'))return false;SP_ACCENT_SETUP=setup;var opened=await spOpen(1);if(opened&&SP){SP.accentCalibration=setup;toast('Прочитай короткий текст один раз. После записи сравним en-GB и en-US.')}return opened}catch(error){if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{if(token===SP_SETTINGS_TOKEN)spSetSettingsBusy(false)}}
function spCalibrationConsentSetup(){var area=document.getElementById('s9_area');if(!area)return;SP_VIEW_EPOCH++;SP_SETTINGS_BUSY=false;if(area.setAttribute)area.setAttribute('aria-busy','false');var current=SP_CALIBRATION_CONSENT;
  var currentAge=current&&current.age_group==='minor'?'minor':'adult';var guardianChecked=Boolean(current&&current.guardian_confirmed);
  area.innerHTML='<div class="speaking-view"><section id="s9_card" class="speaking-sheet speaking-sheet--roomy speaking-stack" data-speaking-focus><h2 class="speaking-heading">Добровольная калибровка точности</h2>'
    +'<p class="speaking-copy speaking-copy--muted">Это отдельное согласие на временное хранение анонимной записи для двух независимых экспертных оценок. Отказ не ограничивает обучение или подписку. Сырой звук удаляется после согласованной двойной оценки, отзыва или не позднее 180 дней.</p>'
    +'<label class="speaking-field">Возрастная группа<select id="sp_cal_age" class="speaking-select" data-speaking-setting><option value="adult"'+(currentAge==='adult'?' selected':'')+'>18 лет или старше</option><option value="minor"'+(currentAge==='minor'?' selected':'')+'>Младше 18 лет</option></select></label>'
    +'<label class="speaking-check-row"><input id="sp_cal_guardian" type="checkbox" data-speaking-setting aria-label="Подтверждение законного представителя"'+(guardianChecked?' checked':'')+'><span>Законный представитель подтвердил передачу записи внешнему сервису и экспертам.</span></label></section>'
    +'<div class="speaking-action-stack">'+spBtn(current&&current.granted?'Сохранить изменения согласия':'Дать добровольное согласие','spSaveCalibrationConsent(true)',true)
    +(current&&current.granted?spBtn('Отозвать согласие и удалить сырой звук','spSaveCalibrationConsent(false)',false):'')
    +spBtn('Назад без изменений','spHub()',false)+'</div></div>';area.querySelectorAll('.speaking-action').forEach(function(button){button.dataset.speakingSetting=''});spNormalizeView('privacy-consent')}
async function spSaveCalibrationConsent(granted){if(SP_SETTINGS_BUSY)return false;var epoch=SP_VIEW_EPOCH,token=++SP_SETTINGS_TOKEN;var age=document.getElementById('sp_cal_age');var guardian=document.getElementById('sp_cal_guardian');var ageGroup=age?age.value:(SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.age_group)||'adult';var guardianConfirmed=Boolean(guardian&&guardian.checked);if(!granted&&SP_CALIBRATION_CONSENT){ageGroup=SP_CALIBRATION_CONSENT.age_group;guardianConfirmed=Boolean(SP_CALIBRATION_CONSENT.guardian_confirmed)}spSetSettingsBusy(true);
  try{var consent=await apiPut('/api/v1/speaking/calibration-consent',{granted:Boolean(granted),ageGroup:ageGroup,guardianConfirmed:guardianConfirmed});if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH||!spRoute()?.classList.contains('on'))return false;SP_CALIBRATION_CONSENT=consent;spHub();toast(granted?'Согласие сохранено. Его можно отозвать в любой момент.':'Согласие отозвано; незавершённые сырые записи удалены.');return true}catch(error){if(token!==SP_SETTINGS_TOKEN||epoch!==SP_VIEW_EPOCH)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{if(token===SP_SETTINGS_TOKEN)spSetSettingsBusy(false)}}
async function spLoadPronunciationStatus(){var box=document.getElementById('speaking_pronunciation_status');if(!box)return;
  var epoch=SP_VIEW_EPOCH;try{var payload=await apiGet('/api/v1/speaking/pronunciation-assessments/status');var view=speakingModule.pronunciationStatusView(payload);if(epoch!==SP_VIEW_EPOCH||document.getElementById('speaking_pronunciation_status')!==box)return;
    if(view.available&&view.remainingSeconds>0){box.dataset.state='ready';box.innerHTML='<b>Оценка произношения доступна</b><br><span>Осталось '+spFmt(view.remainingSeconds)+' из '+spFmt(view.limitSeconds)+' в этом месяце · '+presentPublicPlan({tier:view.tier}).label+'. Локальная запись и прослушивание не расходуют лимит.</span>';return}
    if(view.available){box.dataset.state='quota';box.innerHTML='<b>Лимит автоматической оценки исчерпан</b><br><span>Локальная запись и прослушивание остаются доступны и не расходуют лимит.</span>';return}
    box.dataset.state='provider-unavailable';box.innerHTML='<b>Оценка произношения пока недоступна</b><br><span>Можно записывать и прослушивать ответы локально — это не расходует лимит.</span>'}
  catch(_){if(epoch!==SP_VIEW_EPOCH||document.getElementById('speaking_pronunciation_status')!==box)return;box.dataset.state='network-error';box.innerHTML='<b>Оценка произношения пока недоступна</b><br><span>Не удалось проверить сервис и остаток лимита. Локальная запись и прослушивание не расходуют лимит.</span>'}}
function spLearningList(title,items){if(!items||!items.length)return '';return '<div class="speaking-learning-list"><b class="speaking-learning-list__title">'+ui.escapeHtml(title)+':</b><ul class="speaking-learning-list__items">'+items.map(function(item){return '<li>'+ui.escapeHtml(item)+'</li>'}).join('')+'</ul></div>'}
function spIssueDynamics(item){var labels={improved:'улучшение',declined:'снижение',stable:'без изменений',insufficient_data:'данных для сравнения пока мало'};var detail=item.previousAccuracy==null||item.currentAccuracy==null?'':' · '+item.previousAccuracy+'→'+item.currentAccuracy+(item.delta==null?'':' ('+(item.delta>0?'+':'')+item.delta+')');return item.label+(item.accentLocale?' · '+item.accentLocale:'')+' · '+item.count+' раз'+(item.averageAccuracy==null?'':' · среднее '+item.averageAccuracy+'/100')+' · '+(labels[item.direction]||labels.insufficient_data)+detail}
function spSpeakingSkillLabel(skillId){var labels={'ege.speaking.reading_aloud':'Чтение вслух','ege.speaking.direct_questions':'Прямые вопросы','ege.speaking.interview_completeness':'Полнота ответов в интервью','ege.speaking.monologue_content':'Содержание монолога','ege.speaking.monologue_organization':'Организация монолога','ege.speaking.spoken_grammar':'Грамматика устной речи','ege.speaking.spoken_lexis':'Лексика устной речи','ege.speaking.fluency':'Беглость речи','ege.speaking.pronunciation_words':'Произношение слов','ege.speaking.pronunciation_phonemes':'Произношение звуков','ege.speaking.signal_quality':'Качество записи'};return labels[skillId]||'Навык говорения'}
function spSpeakingTargetFocus(focus){if(!focus)return '';if(focus.kind==='word')return 'слово «'+focus.value+'»';if(focus.kind==='phoneme')return 'фонема /'+focus.value+'/ в слове «'+focus.anchorWord+'»';return ''}
function spVoiceTutorOptions(voice){if(!voice||!voice.attemptSummary)return null;if(voice.attemptSummary.attemptId===voice.attemptId){var base={profile:{entitlements:{voice_tutor:true}},source:'speaking',attemptId:voice.attemptId,revision:voice.revision};if(voice.criterion)return Object.assign(base,{criterionChoices:[{index:voice.criterion.index,label:voice.criterion.label}]});if(voice.pronunciationError)return Object.assign(base,{pronunciationError:{ref:voice.pronunciationError.ref,label:voice.pronunciationError.label}})}return null}
function spLearningReportMarkup(report){var safe=ui.escapeHtml,current=report&&report.currentAttempt,access=report&&report.access;if(!report||!access)return '';
  var header='<div class="speaking-learning-report__header"><b class="speaking-learning-report__title">Личный прогресс Speaking</b><span class="speaking-learning-report__badge">'+safe(presentPublicPlan({tier:access.tier}).label)+(report.activeAccentLocale?' · '+safe(report.activeAccentLocale):'')+' · '+Math.round(access.remainingSeconds/60)+' мин</span></div>';
  var next=report.nextStep?'<div class="speaking-learning-next"><b>Следующий шаг:</b> '+safe(report.nextStep.label)+'</div>':'';
  var timeline=(report.attemptTimeline||[]).slice(-10).map(function(item){return 'Попытка '+item.attemptId+' · задание '+item.taskType+' · '+(item.status==='scored'?(item.score+' / '+item.maxScore):'нужна новая запись')+(item.masteryEligible?'':' · не меняет освоение')});
  var history=spLearningList('История попыток',timeline);
  SP_TARGETED_PRACTICE=null;
  if(!current)return '<div class="clayCard speaking-learning-report">'+header+'<div class="speaking-learning-report__empty">После первой оценки здесь появятся критерии и слабые места.</div>'+next+history+'</div>';
  var technical=current.status!=='scored';var summary=technical
    ?'<div class="speaking-learning-alert"><b>Оценку нельзя считать надёжной.</b><br>'+safe(current.verdict||'Нужна новая запись.')+'</div>'
    :'<div class="speaking-learning-report__score">Последняя оценка: '+current.score+' из '+current.maxScore+(current.accentLocale?' · '+safe(current.accentLocale):'')+'</div><div class="speaking-learning-report__verdict">'+safe(current.verdict||'')+'</div>';
  var transcript=current.transcript?'<details class="speaking-learning-transcript"><summary>Расшифровка последней попытки</summary><div class="speaking-learning-transcript__copy">'+safe(current.transcript)+'</div></details>':'';
  var criteria=(current.criteria||[]).map(function(item){return '<div class="speaking-learning-criterion"><span>'+safe(item.name)+'</span><b>'+item.score+' / '+item.maxScore+'</b></div>'}).join('');
  var signal=current.signal||{};var pause=signal.pauseAnalysis||{};var pauseText=pause.available?('лишних '+pause.unexpectedBreakCount+', пропущенных '+pause.missingBreakCount):(pause.reason==='locale_not_supported'?'анализ недоступен для выбранного варианта английского':'отдельный показатель провайдером не поддерживается');var signalText=technical?'Качество сигнала: '+safe(signal.quality||'не определено'):'Беглость: '+(signal.fluencyScore==null?'нет отдельного показателя':Math.round(signal.fluencyScore)+'/100')+' · полнота: '+(signal.completenessScore==null?'нет отдельного показателя':Math.round(signal.completenessScore)+'/100')+' · паузы: '+pauseText;
  var words=(current.wordIssues||[]).map(function(item){var phonemes=(item.phonemes||[]).map(function(p){return p.label+(p.accuracyScore==null?'':' '+Math.round(p.accuracyScore)+'/100')}).join(', ');var hasTime=typeof item.offsetSeconds==='number'&&Number.isFinite(item.offsetSeconds)&&typeof item.durationSeconds==='number'&&Number.isFinite(item.durationSeconds);var stamp='';if(hasTime){var fmt=function(value){var minutes=Math.floor(value/60);var seconds=(value-minutes*60).toFixed(1).padStart(4,'0');return minutes+':'+seconds};stamp=' · '+(item.itemIndex?'Ответ '+item.itemIndex+' · ':'')+fmt(item.offsetSeconds)+'–'+fmt(item.offsetSeconds+item.durationSeconds)}return item.word+(item.accuracyScore==null?'':' · '+Math.round(item.accuracyScore)+'/100')+stamp+(phonemes?' · '+phonemes:'')});
  var fixes=(current.improvements||[]).map(function(item){return item.wrong+' → '+item.right+(item.note?' · '+item.note:'')});
  var premium='';if(report.premium){var target=report.premium.targetedPractice;var voice=report.premium.voiceTutor;var voiceOptions=spVoiceTutorOptions(voice);var voiceReady=Boolean(voiceOptions);SP_TARGETED_PRACTICE=target||null;
    var comparison=report.premium.comparison;var allocation=(report.premium.timeAllocationRecommendation||[]).map(function(item){return item.label+(item.accentLocale?' · '+item.accentLocale:'')+' — '+item.percentage+'% учебного времени'});
    var repeatedWords=(report.premium.wordDynamics||[]).slice(0,5).map(function(item){return spIssueDynamics(item)});
    var repeatedPhonemes=(report.premium.phonemeDynamics||[]).slice(0,5).map(function(item){return spIssueDynamics(item)});
    var criterionDynamics=(report.premium.criterionDynamics||[]).slice(0,8).map(function(item){var point=(item.points||[]).slice(-1)[0];return spSpeakingSkillLabel(item.skillId)+(item.accentLocale?' · '+item.accentLocale:'')+(point?' · '+point.score+'/'+point.maxScore:'')+' · '+(item.points||[]).length+' проверок'});
    var fluencyDynamics=(report.premium.fluencyDynamics||[]).slice(-5).map(function(item){return 'Попытка '+item.attemptId+(item.accentLocale?' · '+item.accentLocale:'')+' · беглость '+(item.fluencyScore==null?'нет данных':Math.round(item.fluencyScore)+'/100')+' · полнота '+(item.completenessScore==null?'нет данных':Math.round(item.completenessScore)+'/100')});
    var pauseDynamics=(report.premium.pauseDynamics||[]).slice(-5).map(function(item){return 'Попытка '+item.attemptId+(item.accentLocale?' · '+item.accentLocale:'')+' · '+(item.available?('лишних пауз '+item.unexpectedBreakCount+', пропущенных '+item.missingBreakCount):'отдельная метрика пауз недоступна')});
    var personal=report.premium.personalSummary||{};var personalSummary=['Надёжных попыток: '+(personal.reliableAttemptCount||0)+(personal.currentReliableAccentLocale?' · '+personal.currentReliableAccentLocale:''),'Приоритетов на занятие: '+(personal.priorityCount||0),'Целей без подходящего серверного материала: '+(personal.unavailableTargetCount||0)];
    var unavailable=(report.premium.unavailableTargets||[]).slice(0,5).map(function(item){return item.label+' · пока нет другого серверного задания с этой точной целью'});
    var outcomes=(report.premium.targetOutcomes||[]).slice(-5).map(function(item){var focus=spSpeakingTargetFocus(item.focus);return spSpeakingSkillLabel(item.skillId)+(focus?' · '+focus:'')+' · '+(item.status==='resolved'?'цель закрыта':(item.status==='still_needs_work'?'нужно повторить':'результат не подтверждён'))});
    premium='<div class="speaking-learning-report__premium"><b>Надёжная динамика:</b> '+report.premium.trend.length+' попыток'+(comparison&&comparison.scoreDelta!=null?' · '+(comparison.scoreDelta>=0?'+':'')+comparison.scoreDelta+' п.п. к заданию того же типа, уровня и '+safe(comparison.accentLocale||'акцента'):'')+'</div>'
      +spLearningList('Динамика критериев',criterionDynamics)+spLearningList('Повторяющиеся слова',repeatedWords)+spLearningList('Фонемная динамика',repeatedPhonemes)+spLearningList('Беглость и полнота',fluencyDynamics)+spLearningList('Паузы',pauseDynamics)+spLearningList('Персональный итог',personalSummary)+spLearningList('Результаты целевых проверок',outcomes)+spLearningList('Цели, для которых пока нет другого материала',unavailable)+spLearningList('Рекомендация на 60 минут',allocation)
      +(target?'<button type="button" class="sq speaking-learning-target" onclick="spStartTargetedPractice()">Целевая тренировка · другое серверное задание</button>':'')
      +(voiceReady?voiceTutorButton(voiceOptions):'')}
  return '<div class="clayCard speaking-learning-report">'+header+summary+transcript+(criteria?'<div class="speaking-learning-report__criteria">'+criteria+'</div>':'')+'<div class="speaking-learning-report__signal">'+signalText+'</div>'+spLearningList('Что получилось',current.strengths||[])+spLearningList('Что исправить',fixes)+spLearningList('Проблемные слова и фонемы',words)+next+history+premium+'</div>'}
function spStartTargetedPractice(){var target=SP_TARGETED_PRACTICE;if(!target)return false;return spOpen(target.taskType,{targetedPractice:target})}
async function spLoadLearningReport(){var box=document.getElementById('speaking_learning_report');if(!box)return;var epoch=SP_VIEW_EPOCH;try{var report=await apiGet('/api/v1/speaking/learning-report');if(epoch===SP_VIEW_EPOCH&&document.getElementById('speaking_learning_report')===box){box.innerHTML=spLearningReportMarkup(report);spNormalizeView()}}catch(_){if(epoch===SP_VIEW_EPOCH&&document.getElementById('speaking_learning_report')===box)box.innerHTML=''}}
function spHub(){var area=document.getElementById('s9_area');if(!area)return;SP_VIEW_EPOCH++;SP_SETTINGS_BUSY=false;if(area.setAttribute)area.setAttribute('aria-busy','false');
  var lock=adaptiveSpeakingLock();if(lock){launchAdaptiveSpeakingLock(lock);return}
  var r=spSt();var accentLabel=SP_ACCENT&&SP_ACCENT.locale==='en-US'?'Американский · en-US':'Британский · en-GB';
  var calibrationGranted=Boolean(SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.granted);
  var accentCard='<section class="speaking-sheet speaking-sheet--compact speaking-row speaking-row--between speaking-row--wrap"><div class="speaking-row__grow"><h3 class="speaking-subheading">Профиль произношения</h3><p class="speaking-meta">'+ui.escapeHtml(accentLabel)+' · действует для новых тренировок</p></div><button type="button" class="sq speaking-inline-action speaking-setting-action" onclick="spAccentSetup()">Изменить</button></section>';
  var calibrationCard='<button type="button" class="sq speaking-card-action speaking-row speaking-row--between speaking-row--wrap" onclick="spCalibrationConsentSetup()"><span class="speaking-row__grow"><span class="speaking-subheading">Добровольная калибровка точности</span><span class="speaking-meta">'+(calibrationGranted?'Согласие дано · можно отозвать':'Не включена · обучение доступно полностью')+'</span></span><span class="speaking-chip speaking-setting-status '+(calibrationGranted?'speaking-chip--success':'')+'">'+(calibrationGranted?'Включена':'Не включена')+'</span></button>';
  var examCard='<button type="button" class="sq speaking-card-action speaking-exam-card speaking-row speaking-row--between" aria-label="Экзамен · устная часть" onclick="spExam()"><span class="speaking-row__grow"><span class="speaking-kicker">Экзамен</span><span class="speaking-subheading">Устная часть</span><span class="speaking-meta">'+(S.speakingFullSessionId?'Есть незавершённая сессия · максимум 20':'4 задания подряд · максимум 20 · примерная оценка после сдачи')+'</span></span><span class="speaking-exam-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></button>';
  var taskCards=[1,2,3,4].map(function(t){var c=SP_CONF[t];return '<button type="button" class="sq speaking-card-action speaking-row speaking-row--between" onclick="spOpen('+t+')"><span class="speaking-row__grow"><span class="speaking-subheading">'+c.name+'</span><span class="speaking-meta">'+c.sub+'</span></span><span class="speaking-chip speaking-chip--primary">'+(r['t'+t].n||'—')+'</span></button>'}).join('');
  area.innerHTML='<div class="speaking-view"><header id="s9_card" class="speaking-view-intro" data-speaking-focus><h2 class="speaking-heading">Тренировка и экзамен</h2><p class="speaking-copy speaking-copy--muted">Выбери отдельное задание или пройди устную часть целиком.</p></header>'+accentCard+calibrationCard+examCard+'<div id="speaking_pronunciation_status" class="speaking-state" data-state="loading" role="status" aria-live="polite" aria-atomic="true"><strong>Проверяем доступность оценки произношения…</strong><span>Локальная запись и прослушивание не расходуют лимит.</span></div><div id="speaking_learning_report" role="status" aria-live="polite"></div><div class="speaking-stack">'+taskCards+'</div><aside class="speaking-note speaking-note--info speaking-row"><span class="speaking-note-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></span><span>Сначала подготовка по таймеру, потом запись — тайминги как на настоящем экзамене</span></aside></div>';
  setTxt('s9_today','4 задания');spNormalizeView('hub');spLoadPronunciationStatus();spLoadLearningReport();spGen()}
function spPool(t){var ai=(S&&S.spkAi&&S.spkAi['p'+t])||[];return speakingModule.pool([SP1,SP2,SP3,SP4][t-1],ai)}
function spSet(t){var k='spIdx'+t;S[k]=(S[k]||0);return speakingModule.select(spPool(t),S[k])}
function spNextSet(t){if((SP&&SP.adaptiveContentRef)||adaptiveSpeakingLock()){try{toast('В персональном занятии закреплён точный вариант задания')}catch(_){}return false}S['spIdx'+t]=(S['spIdx'+t]||0)+1;save();return true}
async function spOpen(t,options){var epoch=++SP_VIEW_EPOCH;var adaptiveLock=options&&options.adaptiveLock||null;var targetedPractice=options&&options.targetedPractice||null;var lock=adaptiveSpeakingLock();if(lock&&!adaptiveLock)return launchAdaptiveSpeakingLock(lock);var adaptiveContentRef=adaptiveLock&&adaptiveLock.contentRef||null;var freshAssignment=Boolean(adaptiveContentRef||targetedPractice);var targetedBody=targetedPractice?{targetedPractice:{sourceAttemptId:targetedPractice.sourceAttemptId,reportRevision:targetedPractice.reportRevision,accentLocale:targetedPractice.accentLocale||null,skillId:targetedPractice.skillId,contentRef:targetedPractice.contentRef}}:null;function assignmentPost(path,body){var assignmentPath='/api/v1/speaking/task-'+t+'/sessions';if(targetedBody&&path===assignmentPath)return apiPost(path,targetedBody);return apiPost(path,body)}spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP_sheet=false;
  if(t===1){var area=document.getElementById('s9_area');if(area)area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Сервер подбирает текст…</div>';spNormalizeView('loading');
    var task1Flow=createSpeakingTask1BrowserFlow({api:{post:function(path,body){if(targetedBody&&path==='/api/v1/speaking/task-1/sessions')return apiPost(path,targetedBody);return apiPost(path,SP_ACCENT_SETUP&&!SP_ACCENT?{calibrationSetupId:SP_ACCENT_SETUP.id}:body)}}});SP_TASK1_FLOW=task1Flow;
    try{var session=await task1Flow.loadAssignment();if(epoch!==SP_VIEW_EPOCH||SP_TASK1_FLOW!==task1Flow)return false;var serverSet=speakingModule.serverTask1Set(session);if(!serverSet||!SP_TASK1_CATALOG_KEYS.has(serverSet.id+'@'+serverSet.revision))throw new Error('SPEAKING_TASK1_RESPONSE_INVALID');
      SP={t:1,set:serverSet,session:session,phase:'intro',qi:0,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){if(epoch!==SP_VIEW_EPOCH||SP_TASK1_FLOW!==task1Flow)return false;spDisposeTask1Flow();SP=null;try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===2){var task2Area=document.getElementById('s9_area');if(task2Area)task2Area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Сервер подбирает объявление…</div>';spNormalizeView('loading');
    var task2Flow=createSpeakingTask2BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});SP_TASK2_FLOW=task2Flow;
    try{var task2Session=null;
      if(!freshAssignment&&S.speakingTask2SessionId){try{task2Session=await task2Flow.restoreSession(S.speakingTask2SessionId);if(epoch!==SP_VIEW_EPOCH||SP_TASK2_FLOW!==task2Flow)return false}catch(error){
        if(!task2RecoveryPointerInvalid(error))throw error;delete S.speakingTask2SessionId;save()}}
      if(!task2Session||task2Session.status==='completed'){task2Session=await task2Flow.loadAssignment();if(epoch!==SP_VIEW_EPOCH||SP_TASK2_FLOW!==task2Flow)return false}
      var serverTask2=speakingModule.serverTask2Set(task2Session);
      if(!serverTask2||!SP_TASK2_CATALOG_KEYS.has(serverTask2.id+'@'+serverTask2.revision))throw new Error('SPEAKING_TASK2_RESPONSE_INVALID');
      if(!adaptiveContentRef){S.speakingTask2SessionId=task2Session.id;save()}
      SP={t:2,set:serverTask2,session:task2Session,phase:task2Session.status==='assigned'?'intro':'question',qi:task2Session.currentQuestion-1,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){if(epoch!==SP_VIEW_EPOCH||SP_TASK2_FLOW!==task2Flow)return false;spDisposeTask2Flow();SP=null;if(task2RecoveryPointerInvalid(error)){delete S.speakingTask2SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===3){var task3Area=document.getElementById('s9_area');if(task3Area)task3Area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Сервер подбирает интервью…</div>';spNormalizeView('loading');
    var task3Flow=createSpeakingTask3BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});SP_TASK3_FLOW=task3Flow;
    try{var task3Session=null;
      if(!freshAssignment&&S.speakingTask3SessionId){try{task3Session=await task3Flow.restoreSession(S.speakingTask3SessionId);if(epoch!==SP_VIEW_EPOCH||SP_TASK3_FLOW!==task3Flow)return false}catch(error){
        if(!task3RecoveryPointerInvalid(error))throw error;delete S.speakingTask3SessionId;save()}}
      if(!task3Session||task3Session.status==='completed'){task3Session=await task3Flow.loadAssignment();if(epoch!==SP_VIEW_EPOCH||SP_TASK3_FLOW!==task3Flow)return false}
      var serverTask3=speakingModule.serverTask3Set(task3Session);
      if(!serverTask3||!SP_TASK3_CATALOG_KEYS.has(serverTask3.id+'@'+serverTask3.revision))throw new Error('SPEAKING_TASK3_RESPONSE_INVALID');
      if(!adaptiveContentRef){S.speakingTask3SessionId=task3Session.id;save()}
      SP={t:3,set:serverTask3,session:task3Session,phase:task3Session.status==='assigned'?'intro':'question',qi:task3Session.currentQuestion-1,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){if(epoch!==SP_VIEW_EPOCH||SP_TASK3_FLOW!==task3Flow)return false;spDisposeTask3Flow();SP=null;if(task3RecoveryPointerInvalid(error)){delete S.speakingTask3SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===4){var task4Area=document.getElementById('s9_area');if(task4Area)task4Area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Сервер подбирает фотопроект и загружает изображения…</div>';spNormalizeView('loading');
    var task4Flow=createSpeakingTask4BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});SP_TASK4_FLOW=task4Flow;
    try{var task4Session=null;
      if(!freshAssignment&&S.speakingTask4SessionId){try{task4Session=await task4Flow.restoreSession(S.speakingTask4SessionId);if(epoch!==SP_VIEW_EPOCH||SP_TASK4_FLOW!==task4Flow)return false}catch(error){
        if(!task4RecoveryPointerInvalid(error))throw error;delete S.speakingTask4SessionId;save()}}
      if(!task4Session||task4Session.status==='completed'){task4Session=await task4Flow.loadAssignment();if(epoch!==SP_VIEW_EPOCH||SP_TASK4_FLOW!==task4Flow)return false}
      var serverTask4=speakingModule.serverTask4Set(task4Session);
      if(!serverTask4||!SPEAKING_TASK4_CATALOG.tasks.some(function(task){return task.id===serverTask4.id&&task.revision===serverTask4.revision}))throw new Error('SPEAKING_TASK4_RESPONSE_INVALID');
      await task4Flow.prepareAssets();if(epoch!==SP_VIEW_EPOCH||SP_TASK4_FLOW!==task4Flow)return false;
      if(!adaptiveContentRef){S.speakingTask4SessionId=task4Session.id;save()}
      SP={t:4,set:serverTask4,session:task4Session,phase:'intro',qi:0,url:null,mic:null,assetReady:true,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){if(epoch!==SP_VIEW_EPOCH||SP_TASK4_FLOW!==task4Flow)return false;spDisposeTask4Flow();SP=null;if(task4RecoveryPointerInvalid(error)){delete S.speakingTask4SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  SP={t:t,set:spSet(t),phase:'intro',qi:0,url:null};spRender();return true}
function launchSpeakingTask(taskNumber,contentRef){
  var descriptor=adaptiveSpeakingTask(contentRef);if(!descriptor||descriptor.taskNumber!==Number(taskNumber))return false;
  return launchAdaptiveSpeakingLock({contentRef:contentRef})}
function spRestartAdaptive(){if(!SP||!SP.adaptiveContentRef||SP.evaluating)return false;var taskNumber=SP.t,contentRef=SP.adaptiveContentRef;spStopAll();return launchSpeakingTask(taskNumber,contentRef)}
const SP_PRIMARY_BUTTON_OPEN='<button type="button" id="s9_primary_action" class="sq aisy-button speaking-action speaking-action--primary speaking-primary">';
const SP_MICROPHONE_BUTTON_OPEN='<button type="button" data-speaking-control="microphone" aria-label="Проверить микрофон" aria-pressed="false">';
const SP_CANONICAL_PRIMARY_CLASS='speaking-'+'primary';
function spBtn(label,fn,solid){var primary=Boolean(solid);var action=/spMicCheck|speFullMicCheck/u.test(fn)?'microphone-check':(/spRec|speFullStartRecording/u.test(fn)?'record':(/spFinish|speFullStopRecording/u.test(fn)?'stop-recording':(/spEval|speFullEvaluate/u.test(fn)?'evaluate':'navigate')));var pressed=action==='microphone-check'?String(Boolean((SP&&SP.mic)||(SPE&&SPE.micCheck==='passed'))):null;var classes='sq aisy-button speaking-action speaking-action--'+(primary?'primary '+SP_CANONICAL_PRIMARY_CLASS:'secondary aisy-button--secondary');var open=primary?SP_PRIMARY_BUTTON_OPEN:'<button type="button" class="'+classes+'">';if(action==='microphone-check')open=SP_MICROPHONE_BUTTON_OPEN.replace('aria-pressed="false"','aria-pressed="'+pressed+'"').replace('>',' id="'+(primary?'s9_primary_action':'speaking_mic_action')+'" class="'+classes+'" aria-describedby="speaking_mic_status">');open=open.replace('>',' data-speaking-action="'+action+'" onclick="'+fn+'">');return open+label+'</button>'}
function spTimerChip(){var value=spFmt(SP.left);return '<div class="speaking-timer" role="timer" aria-live="off" aria-label="Осталось '+value+'">'
  +'<span id="s9_timer">'+value+'</span></div>'
  +'<div class="speaking-timer__track" aria-hidden="true"><div id="s9_tbar" class="speaking-timer__value"></div></div>'}
function spMicStatusMarkup(fallback){var state='unchecked',message=fallback||'Перед таймером проверь разрешение и уровень микрофона',role='status';if(SP&&SP.mic){state=SP.mic.status==='passed'?'ready':'quiet';message=SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'}else if(SP&&SP.micError){state=SP.micError.code==='MICROPHONE_PERMISSION_DENIED'?'permission-denied':'error';role='alert';message=state==='permission-denied'?'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и повтори проверку.':'Микрофон не готов. Проверь подключение и повтори проверку.'}return '<div id="speaking_mic_status" class="speaking-state speaking-mic-status" data-speaking-state="permission" data-state="'+state+'" role="'+role+'" aria-live="polite" aria-atomic="true">'+message+'</div>'}
function spTick(total,onEnd){clearInterval(SP_tm);
  SP_tm=setInterval(function(){if(!SP){clearInterval(SP_tm);return}
    SP.left--;var timerValue=spFmt(SP.left);setTxt('s9_timer',timerValue);var timer=document.getElementById('s9_timer');var timerRoot=timer&&timer.closest('[role="timer"]');if(timerRoot)timerRoot.setAttribute('aria-label','Осталось '+timerValue);
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SP.left/total*100))+'%';
    if(SP.left<=0){clearInterval(SP_tm);onEnd()}},1000)}
/* Показ листа с подсказками: переменную модуля разметка присвоить не может. */
async function spToggleSheet(){if(!SP)return false;if(!SP_sheet&&SP.session&&SP.session.id){try{await apiPost('/api/v1/speaking/task-'+SP.t+'/sessions/'+SP.session.id+'/assistance',{})}catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}SP_sheet=!SP_sheet;spRender();return true}
function spPaperCard(kicker,title,body,options){options=options||{};var role=options.role?' role="'+options.role+'"':'';var live=options.live?' aria-live="'+options.live+'"':'';var classes='speaking-sheet speaking-sheet--roomy speaking-stack'+(options.center?' speaking-sheet--center':'');return '<section id="s9_card" class="'+classes+'" data-speaking-focus'+role+live+'>'+wDeco()+(kicker?'<span class="speaking-chip '+(options.chipClass||'')+'">'+kicker+'</span>':'')+'<h2 class="speaking-heading">'+title+'</h2>'+body+'</section>'}
function spRecordedCard(title,copy,complete){return spPaperCard('',title,'<span class="speaking-result-mark speaking-result-mark--'+(complete?'complete':'recorded')+'" aria-hidden="true"></span><p class="speaking-copy speaking-copy--muted">'+copy+'</p>',{center:true,role:complete?'status':'',live:complete?'polite':''})}
function spRatingCard(prompt,handler,labels){labels=labels||['Повторить','Нормально','Уверенно'];return '<section class="speaking-sheet speaking-sheet--compact speaking-stack"><h3 class="speaking-subheading">'+prompt+'</h3><div class="speaking-rating-grid" role="group" aria-label="Самооценка ответа"><button type="button" class="sq speaking-rating-choice" data-rating="weak" data-speaking-commit onclick="'+handler+'(\'weak\',this)">'+labels[0]+'</button><button type="button" class="sq speaking-rating-choice" data-rating="steady" data-speaking-commit onclick="'+handler+'(\'steady\',this)">'+labels[1]+'</button><button type="button" class="sq speaking-rating-choice" data-rating="strong" data-speaking-commit onclick="'+handler+'(\'strong\',this)">'+labels[2]+'</button></div></section>'}
function spActionMarkup(items){return '<div class="speaking-action-stack">'+items.filter(Boolean).join('')+'</div>'}
function spCompletionView(title,copy,taskNumber){return '<div class="speaking-view">'+spRecordedCard(title,copy,true)+spActionMarkup([spBtn('Оценить по критериям ЕГЭ','spEval(this)',true),spBtn('Новая тренировка','spOpen('+taskNumber+')',false).replace('<button','<button data-speaking-forward'),spBtn('К заданиям','initSpeaking()',false)])+'<div id="sp_evalbox"></div></div>'}
function spRender(){var area=document.getElementById('s9_area');if(!area||!SP)return;var t=SP.t,c=SP_CONF[t],set=SP.set;
  if(officialTask2Active()&&SP.phase==='question'){area.innerHTML='<div class="speaking-view">'+spPaperCard('ВОПРОС '+(SP.qi+1)+' ИЗ 4','Продолжить с вопроса '+(SP.qi+1)+' из 4',spTaskBody()+spMicStatusMarkup('После восстановления снова проверь микрофон'))+spActionMarkup([spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic),spBtn('Записать вопрос '+(SP.qi+1),'spRec()',true),spBtn('К заданиям','spStopAll();initSpeaking()',false)])+'</div>';spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_review'){area.innerHTML='<div class="speaking-view">'+spRecordedCard('Запись вопроса '+(SP.qi+1)+' готова','До нажатия «Оценить» запись остаётся на устройстве. Для оценки она будет явно отправлена внешнему speech-провайдеру; исходный звук не сохраняется.')+spActionMarkup([spBtn('Послушать вопрос '+(SP.qi+1),'spPlayTask2Question('+(SP.qi+1)+')',false)])+spRatingCard('Как получился прямой вопрос?','spCompleteTask2Question')+spActionMarkup([spBtn('Перезаписать вопрос','spRec()',false)])+'</div>';spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_complete'){area.innerHTML=spCompletionView('4 отдельные записи завершены','Все четыре локальные записи готовы. По твоей команде они будут отправлены в защищённый контур оценки и связаны только с этой тренировкой.',2);spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='question'){var questionBody=spTargetFocusBanner()+'<p class="speaking-meta" lang="en">'+ui.escapeHtml(SP.set.instruction)+'</p><p class="speaking-prompt" lang="en">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</p>'+spMicStatusMarkup('После восстановления снова проверь микрофон');area.innerHTML='<div class="speaking-view">'+spPaperCard('ВОПРОС '+(SP.qi+1)+' ИЗ 5','Продолжить с вопроса '+(SP.qi+1)+' из 5',questionBody)+spActionMarkup([spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic),spBtn('Записать ответ '+(SP.qi+1),'spRec()',true),spBtn('К заданиям','spStopAll();initSpeaking()',false)])+'</div>';spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_prompt'){area.innerHTML='<div class="speaking-view">'+spPaperCard('ВОПРОС '+(SP.qi+1)+' ИЗ 5','Сначала прозвучит вопрос','<p class="speaking-prompt" lang="en">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</p><p class="speaking-copy speaking-copy--muted">Запись и 40-секундный таймер начнутся после окончания вопроса.</p>',{center:true,role:'status',live:'polite',chipClass:'speaking-chip--primary'})+'</div>';spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_review'){area.innerHTML='<div class="speaking-view">'+spRecordedCard('Ответ '+(SP.qi+1)+' записан','До нажатия «Оценить» запись остаётся на устройстве. Для оценки она будет явно отправлена внешнему speech-провайдеру; исходный звук не сохраняется.')+spActionMarkup([spBtn('Послушать ответ '+(SP.qi+1),'spPlayTask3Answer('+(SP.qi+1)+')',false)])+spRatingCard('Получился полный ответ из 2–3 предложений?','spCompleteTask3Answer')+spActionMarkup([spBtn('Перезаписать ответ','spRec()',false)])+'</div>';spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_complete'){area.innerHTML=spCompletionView('5 отдельных записей завершены','Все пять локальных записей готовы. По твоей команде они будут отправлены в защищённый контур оценки и связаны с точными вопросами интервью.',3);spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_review'){area.innerHTML='<div class="speaking-view">'+spRecordedCard('Монолог записан','До нажатия «Оценить» запись остаётся на устройстве. Для оценки она будет явно отправлена внешнему speech-провайдеру; исходный звук не сохраняется.')+spActionMarkup([spBtn('Послушать монолог','spPlay()',false)])+spRatingCard('Получилось раскрыть все четыре пункта плана?','spCompleteTask4')+spActionMarkup([spBtn('Перезаписать монолог','spRec()',false)])+'</div>';spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_complete'){area.innerHTML=spCompletionView('Тренировка задания 4 завершена','Локальная запись готова. По твоей команде она будет отправлена в защищённый контур и проверена по трём критериям задания 4.',4);spAnim('win','.32s');return}
  if(SP.phase==='intro'){var body='';if(t===1)body='<p class="speaking-copy">Прочитай назначенный сервером текст вслух. Подготовка — '+spFmt(c.prep)+', чтение — до '+spFmt(c.rec)+'.</p>'+spMicStatusMarkup();if(t===2)body='<p class="speaking-copy">Изучи назначенное сервером объявление и задай <b>4 прямых вопроса</b> по пунктам. Подготовка — '+spFmt(c.prep)+', на каждый вопрос — 20 секунд.</p>'+spMicStatusMarkup();if(t===3)body='<p class="speaking-copy">Интервью на тему «'+ui.escapeHtml(set.topic)+'». Услышишь 5 вопросов — на каждый отвечай 2–3 предложениями, до 40 секунд. Подготовки нет, как на экзамене.</p>'+(officialTask3Active()?'<p class="speaking-note" lang="en">'+ui.escapeHtml(set.instruction)+'</p>'+spMicStatusMarkup('Перед первым вопросом проверь разрешение и уровень микрофона'):'');if(t===4)body='<p class="speaking-copy">Подготовь проектное высказывание по двум фотографиям и четырём пунктам плана. Подготовка — '+spFmt(c.prep)+', монолог — до '+spFmt(c.rec)+'.</p>'+(officialTask4Active()?'<div class="speaking-note speaking-note--success" role="status" aria-live="polite">Фотопара полностью загружена и декодирована до запуска таймера.</div>'+spMicStatusMarkup():'');var cardActions='<div class="speaking-row speaking-row--wrap">'+(SP.adaptiveContentRef||officialTask4Active()?'':'<button type="button" class="sq speaking-inline-action" onclick="'+(t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)')+'">Другой вариант</button>')+(SP.adaptiveContentRef||officialTask3Active()||officialTask4Active()?'':'<button type="button" class="sq speaking-inline-action" onclick="spToggleSheet()">'+(SP_sheet?'Скрыть шпаргалку':'Шпаргалка')+'</button>')+'</div>';var sheet=SP_sheet&&!officialTask3Active()&&!officialTask4Active()?'<aside class="speaking-note speaking-note--success">'+SP_SHEET[t]+'</aside>':'';area.innerHTML='<div class="speaking-view">'+spPaperCard(c.sub.toUpperCase(),c.name,body+(officialTask4Active()?spTaskBody():'')+cardActions+sheet)+spActionMarkup([(t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())?spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic):'',spBtn(c.prep?'Начать подготовку':'Начать интервью','spPrep()',true),spBtn('К заданиям','spStopAll();initSpeaking()',false)])+'</div>';spAnim('win','.32s');setTxt('s9_today',c.name);return}
  if(SP.phase==='prep'){area.innerHTML='<div class="speaking-view">'+spPaperCard('ПОДГОТОВКА','Подготовь ответ',spTaskBody()+spTimerChip(),{chipClass:'speaking-chip--warning'})+spActionMarkup([spBtn('Готово — к записи','spRec()',true),spBtn('К заданиям','spStopAll();initSpeaking()',false)])+'</div>';spAnim('win','.32s');return}
  if(SP.phase==='rec'){var head=SP.t===3?'<p class="speaking-meta">Вопрос '+(SP.qi+1)+' из 5</p><p class="speaking-prompt" lang="en">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</p>'+(officialTask3Active()?'':'<button type="button" class="sq speaking-media-action" onclick="lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])">Озвучить вопрос</button>'):spTaskBody();var finishLabel=officialTask3Active()?'Стоп — закончить ответ':(SP.t===3&&SP.qi>=4?'Завершить интервью':'Стоп — закончить запись');area.innerHTML='<div class="speaking-view">'+spPaperCard('ИДЁТ ЗАПИСЬ','Ответ записывается','<div class="speaking-state" data-state="recording" role="status" aria-live="assertive">Микрофон включён</div>'+head+spTimerChip(),{chipClass:'speaking-chip--primary'})+spActionMarkup([SP.t===3&&SP.qi<4&&!officialTask3Active()?spBtn('Следующий вопрос','spNextQ()',true):'',spBtn(finishLabel,'spFinish()',true)])+'</div>';spNormalizeView('recording');return}
  if(SP.phase==='done'){var r=spSt();var assessmentAction=SP.accentCalibration?'spAccentFinishUnknown(this)':'spEval(this)';var assessmentLabel=SP.accentCalibration?'Определить вариант произношения':'Оценить по критериям ЕГЭ';var extra='';if(t===1)extra=spActionMarkup([spBtn('Эталон диктора','spEtalon()',false)]);if(t===2)extra='<section class="speaking-sheet speaking-sheet--compact speaking-stack"><h3 class="speaking-subheading">Образцы вопросов</h3>'+set.points.map(function(p,i){return '<p class="speaking-copy"><b>'+(i+1)+'. '+ui.escapeHtml(p)+':</b><br><i>'+ui.escapeHtml(set.exq[i])+'</i></p>'}).join('')+'</section>';if(t===4)extra='<section class="speaking-sheet speaking-sheet--compact speaking-stack"><h3 class="speaking-subheading">Проверь себя</h3><ol class="speaking-list">'+set.plan.map(function(p){return '<li>'+ui.escapeHtml(p)+'?</li>'}).join('')+'</ol></section>';if(t===3)extra='<section class="speaking-sheet speaking-sheet--compact speaking-stack"><h3 class="speaking-subheading">Вопросы интервью</h3><ol class="speaking-list">'+set.qs.map(function(q){return '<li>'+ui.escapeHtml(q)+'</li>'}).join('')+'</ol></section>';var recordActions=[SP.url?spBtn('Послушать свою запись','spPlay()',false):'<div class="speaking-state" data-state="error" role="alert">Запись не получилась — проверь доступ к микрофону</div>',SP.blob&&(SP.accentCalibration||t!==1||SP.task1Completed)?spBtn(assessmentLabel,assessmentAction,true):'',SP.blob?spBtn('Удалить запись','spDeleteRecording()',false):'',SP.t>1&&!SP.adaptiveContentRef?spBtn('Образец ответа от ИИ','spSample(this)',false):''];var rating=SP.blob&&t===1&&!SP.task1Completed?spRatingCard('Как ощущалось чтение?','spCompleteTask1',['Нужно повторить','Нормально','Уверенно']):'';var saved=t===1&&SP.task1Completed?'<div class="speaking-state" data-state="success" role="status" aria-live="polite">Безопасная история тренировки сохранена.</div>':'';var returnActions=SP.adaptiveContentRef?'<p class="speaking-meta speaking-center">В персональном занятии закреплено это задание. Оцени ответ или перезапиши тот же вариант.</p>'+spActionMarkup([spBtn('Записать этот вариант ещё раз','spRestartAdaptive()',false).replace('<button','<button id="adaptive_speaking_retry" data-speaking-forward')]):spActionMarkup([spBtn('Ещё раз',t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)',false).replace('<button','<button data-speaking-forward'),spBtn('К заданиям','spStopAll();initSpeaking()',false)]);area.innerHTML='<div class="speaking-view">'+spRecordedCard('Запись готова!','Послушай себя со стороны и сверься со шпаргалкой. Тренировок в этом задании: '+r['t'+t].n)+spActionMarkup(recordActions)+rating+saved+'<div id="sp_evalbox"></div>'+extra+returnActions+'</div>';spAnim('win','.32s');setTxt('s9_today',SP_CONF[t].name);return}}
function spTargetFocusBanner(){var target=SP&&SP.session&&SP.session.targetedPractice;if(!target)return '';var focus=target.focus;var detail=focus?(focus.kind==='phoneme'?'/'+focus.value+'/ · '+focus.anchorWord:focus.value):target.label;return '<div class="speaking-note speaking-note--success" role="status"><b>Цель этой проверки:</b> '+ui.escapeHtml(detail||target.label)+'</div>'}
function spTaskBody(){var t=SP.t,set=SP.set,focus=spTargetFocusBanner();if(t===1)return focus+'<p class="speaking-reading" lang="en">'+ui.escapeHtml(set.tx)+'</p>';if(t===2)return focus+'<blockquote class="speaking-note speaking-quote">'+ui.escapeHtml(set.ad)+'</blockquote><h3 class="speaking-subheading">Задай прямые вопросы о:</h3><ol class="speaking-task-list">'+set.points.map(function(p,i){return '<li '+(officialTask2Active()&&i===SP.qi?'data-current="true"':'')+'>'+ui.escapeHtml(p)+'</li>'}).join('')+'</ol>';if(t===4&&officialTask4Active()){var photoAsset=task4PhotoAsset(set.photoPair.src);return focus+'<h3 class="speaking-subheading" lang="en">'+ui.escapeHtml(set.projectTitle)+'</h3><figure class="speaking-photo-pair"><img loading="lazy" decoding="async" src="'+ui.escapeHtml(set.photoPair.src)+'" alt="'+ui.escapeHtml(set.photoPair.alt)+'" width="'+(photoAsset?photoAsset.width:1536)+'" height="'+(photoAsset?photoAsset.height:1024)+'"><figcaption class="speaking-meta">Две оригинальные фотографии для сравнения: слева и справа.</figcaption></figure><p class="speaking-meta" lang="en">'+ui.escapeHtml(set.instruction)+'</p><h3 class="speaking-subheading">План</h3><ol class="speaking-task-list" lang="en">'+set.plan.map(function(p){return '<li>'+ui.escapeHtml(p)+'</li>'}).join('')+'</ol>'}if(t===4)return focus+'<h3 class="speaking-subheading">Тема: '+ui.escapeHtml(set.topic)+'</h3>'+set.ph.map(function(p){return '<blockquote class="speaking-note speaking-quote">'+ui.escapeHtml(p)+'</blockquote>'}).join('')+'<h3 class="speaking-subheading">План</h3><ol class="speaking-task-list">'+set.plan.map(function(p){return '<li>'+ui.escapeHtml(p)+'</li>'}).join('')+'</ol>';return focus}
async function spMicCheck(btn){if(!SP||!((SP.t===1&&SP_TASK1_FLOW)||officialTask2Active()||officialTask3Active()||officialTask4Active()))return false;if(btn)btn.disabled=true;
  var view=SP;var flow=SP.t===1?SP_TASK1_FLOW:(officialTask2Active()?SP_TASK2_FLOW:(officialTask3Active()?SP_TASK3_FLOW:SP_TASK4_FLOW));
  try{var mic=await flow.checkMicrophone();if(SP!==view)return false;SP.mic=mic;SP.micError=null;spRender();return true}
  catch(error){if(SP!==view)return false;SP.mic=null;SP.micError={code:String(error&&error.code||'MICROPHONE_UNAVAILABLE')};try{toast(error&&error.code==='MICROPHONE_PERMISSION_DENIED'?'Нет доступа к микрофону. Разреши его в настройках браузера.':'Микрофон не готов. Проверь подключение и попробуй снова.')}catch(_){}spRender();return false}}
function spPrep(){var c=SP_CONF[SP.t];
  if((SP.t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())&&!SP.mic){try{toast('Сначала проверь микрофон — официальный таймер ещё не запущен.')}catch(_){}return}
  if(officialTask4Active()&&!SP.assetReady){try{toast('Дождись полной загрузки фотопары — таймер ещё не запущен.')}catch(_){}return}
  if(!c.prep)return spRec();
  SP.phase='prep';SP.left=c.prep;spRender();
  spTick(c.prep,function(){spRec()})}
async function spRec(){if(!SP)return false;var view=SP,c=SP_CONF[SP.t];
  clearInterval(SP_tm);
  spReleaseRecording();
  if(SP.t===1&&SP_TASK1_FLOW){var task1Flow=SP_TASK1_FLOW;try{await task1Flow.startRecording();if(SP!==view||SP_TASK1_FLOW!==task1Flow)return false;SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){if(SP!==view||SP_TASK1_FLOW!==task1Flow)return false;SP.phase='intro';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись. Проверь разрешение на микрофон.')}catch(_){}return false}}
  if(officialTask2Active()){var task2Flow=SP_TASK2_FLOW;try{await task2Flow.startQuestion();if(SP!==view||SP_TASK2_FLOW!==task2Flow)return false;SP.phase='rec';SP.qi=SP.session.currentQuestion-1;SP.left=c.per;spRender();spTick(c.per,function(){spFinish()});return true}
    catch(error){if(SP!==view||SP_TASK2_FLOW!==task2Flow)return false;SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись вопроса.')}catch(_){}return false}}
  if(officialTask3Active()){var task3SessionId=SP.session.id;SP.qi=SP.session.currentQuestion-1;var task3Question=SP.set.qs[SP.qi];SP.phase='task3_prompt';spRender();
    try{await Promise.resolve(lPlayRaw([{s:1,t:task3Question}]))}catch(_){}
    if(!SP||!SP_TASK3_FLOW||SP.session.id!==task3SessionId||SP.session.currentQuestion-1!==SP.qi)return false;
    var task3Flow=SP_TASK3_FLOW;try{await task3Flow.startAnswer();if(SP!==view||SP_TASK3_FLOW!==task3Flow)return false;SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){if(SP!==view||SP_TASK3_FLOW!==task3Flow)return false;SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись ответа.')}catch(_){}return false}}
  if(officialTask4Active()){var task4Flow=SP_TASK4_FLOW;try{await task4Flow.startRecording();if(SP!==view||SP_TASK4_FLOW!==task4Flow)return false;SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){if(SP!==view||SP_TASK4_FLOW!==task4Flow)return false;SP.phase='intro';spRender();try{toast(error&&error.code==='SPEAKING_TASK4_ASSET_NOT_READY'?'Дождись полной загрузки фотопары.':(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись монолога.'))}catch(_){}return false}}
  try{
    var st=await navigator.mediaDevices.getUserMedia({audio:true});if(SP!==view){st.getTracks().forEach(function(track){track.stop()});return false}
    var mime=spMime();
    SP_rec=mime?new MediaRecorder(st,{mimeType:mime}):new MediaRecorder(st);SP_chunks=[];
    SP_rec.ondataavailable=function(e){SP_chunks.push(e.data)};
    var recorder=SP_rec;SP_rec.onstop=function(){var tp=recorder.mimeType||(SP_chunks[0]&&SP_chunks[0].type)||'';
      var bl=tp?new Blob(SP_chunks,{type:tp}):new Blob(SP_chunks);st.getTracks().forEach(function(x){x.stop()});if(SP!==view||SP_rec!==recorder)return;SP.blob=bl;SP.url=URL.createObjectURL(bl);
      if(SP.phase==='done')spRender()};
    SP_rec.start();
  }catch(e){if(SP!==view)return false;SP.url=null;SP.micError={code:String(e&&e.name==='NotAllowedError'?'MICROPHONE_PERMISSION_DENIED':'MICROPHONE_UNAVAILABLE')};SP.phase='intro';spRender();try{toast('Нет доступа к микрофону. Разреши доступ в настройках браузера и попробуй снова.')}catch(_){}return false}
  SP.phase='rec';SP.left=c.rec;SP.qi=0;spRender();
  if(SP.t===3){try{lPlayRaw([{s:1,t:SP.set.qs[0]}])}catch(e){}}
  spTick(c.rec,function(){SP.t===3?spNextQ():spFinish()})}
function spNextQ(){if(!SP)return;
  if(SP.qi>=4){spFinish();return}
  SP.qi++;SP.left=SP_CONF[3].rec;spRender();
  try{lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])}catch(e){}
  spTick(SP_CONF[3].rec,function(){SP.qi>=4?spFinish():spNextQ()})}
async function spFinish(){if(!SP)return false;var view=SP;clearInterval(SP_tm);try{lStop()}catch(e){}
  if(officialTask2Active()){var task2Flow=SP_TASK2_FLOW;try{var task2Recording=await task2Flow.stopQuestion();if(SP!==view||SP_TASK2_FLOW!==task2Flow)return false;SP.blob=task2Recording.blob;SP.url=task2Recording.url;SP.phase='task2_review'}
    catch(error){if(SP!==view||SP_TASK2_FLOW!==task2Flow)return false;SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return true}
  if(officialTask3Active()){var task3Flow=SP_TASK3_FLOW;try{var task3Recording=await task3Flow.stopAnswer();if(SP!==view||SP_TASK3_FLOW!==task3Flow)return false;SP.blob=task3Recording.blob;SP.url=task3Recording.url;SP.phase='task3_review'}
    catch(error){if(SP!==view||SP_TASK3_FLOW!==task3Flow)return false;SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return true}
  if(officialTask4Active()){var task4Flow=SP_TASK4_FLOW;try{var task4Recording=await task4Flow.stopRecording();if(SP!==view||SP_TASK4_FLOW!==task4Flow)return false;SP.blob=task4Recording.blob;SP.url=task4Recording.url;SP.phase='task4_review'}
    catch(error){if(SP!==view||SP_TASK4_FLOW!==task4Flow)return false;SP.blob=null;SP.url=null;SP.phase='intro'}spRender();return true}
  if(SP.t===1&&SP_TASK1_FLOW){var task1Flow=SP_TASK1_FLOW;try{var localRecording=await task1Flow.stopRecording();if(SP!==view||SP_TASK1_FLOW!==task1Flow)return false;SP.blob=localRecording.blob;SP.url=localRecording.url}
    catch(error){if(SP!==view||SP_TASK1_FLOW!==task1Flow)return false;SP.blob=null;SP.url=null}var task1State=spSt();task1State.t1.n++;if(!SP.adaptiveContentRef)spNextSet(1);SP.phase='done';spSync();save();spRender();return true}
  var r=spSt();r['t'+SP.t].n++;if(!SP.adaptiveContentRef)spNextSet(SP.t);SP.phase='done';
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  spSync();save();spRender();return true}
var SP_audio=null;
async function spPlay(){if(!SP||!SP.url)return;
  if(officialTask2Active())return spPlayTask2Question(SP.qi+1);
  if(officialTask3Active())return spPlayTask3Answer(SP.qi+1);
  if(officialTask4Active()){try{await SP_TASK4_FLOW.playRecording();SP.played=true;return true}catch(error){try{toast('Локальная запись монолога недоступна.')}catch(_){}return false}}
  if(SP.t===1&&SP_TASK1_FLOW){try{await SP_TASK1_FLOW.playRecording();SP.played=true;return}catch(error){try{toast('Не удалось воспроизвести запись — попробуй ещё раз')}catch(_){}return}}
  try{lStop()}catch(e){}
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  SP_audio=new Audio(SP.url);
  SP_audio.onerror=function(){try{toast('Не удалось воспроизвести запись — попробуй записать ещё раз')}catch(e){}};
  SP_audio.play().catch(function(){try{toast('Браузер не дал воспроизвести — нажми ещё раз')}catch(e){}})}
function spDeleteRecording(){if(!SP)return;if(SP.t===1&&SP_TASK1_FLOW)SP_TASK1_FLOW.dispose();else if(SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}SP.url=null;SP.blob=null;SP_chunks=[];spRender();try{toast('Запись удалена')}catch(e){}}
async function spCompleteTask1(selfRating,btn){if(!SP||SP.t!==1||!SP_TASK1_FLOW||SP.task1Completed)return false;var view=SP,flow=SP_TASK1_FLOW,token=spBeginCommit();if(token===null)return false;
  try{var completed=await flow.complete(selfRating);if(!spCommitCurrent(token,view)||SP_TASK1_FLOW!==flow)return false;SP.completedSession=completed;SP.task1Completed=true;spRender();return true}
  catch(error){if(!spCommitCurrent(token,view)||SP_TASK1_FLOW!==flow)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{spEndCommit(token)}}
async function spPlayTask2Question(questionNumber){if(!SP||SP.t!==2||!SP_TASK2_FLOW)return false;
  try{await SP_TASK2_FLOW.playQuestion(questionNumber);return true}catch(error){try{toast('Локальная запись этого вопроса недоступна.')}catch(_){}return false}}
async function spCompleteTask2Question(selfRating,btn){if(!SP||SP.t!==2||!SP_TASK2_FLOW||SP.task2Completed)return false;var view=SP,flow=SP_TASK2_FLOW,token=spBeginCommit();if(token===null)return false;try{var session=await flow.completeQuestion(selfRating);if(!spCommitCurrent(token,view)||SP_TASK2_FLOW!==flow)return false;SP.session=session;SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task2Completed=true;SP.phase='task2_complete';delete S.speakingTask2SessionId;var r=spSt();r.t2.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(!spCommitCurrent(token,view)||SP_TASK2_FLOW!==flow)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{spEndCommit(token)}}
async function spPlayTask3Answer(questionNumber){if(!SP||SP.t!==3||!SP_TASK3_FLOW)return false;
  try{await SP_TASK3_FLOW.playAnswer(questionNumber);return true}catch(error){try{toast('Локальная запись этого ответа недоступна.')}catch(_){}return false}}
async function spCompleteTask3Answer(selfRating,btn){if(!SP||SP.t!==3||!SP_TASK3_FLOW||SP.task3Completed)return false;var view=SP,flow=SP_TASK3_FLOW,token=spBeginCommit();if(token===null)return false;try{var session=await flow.completeAnswer(selfRating);if(!spCommitCurrent(token,view)||SP_TASK3_FLOW!==flow)return false;SP.session=session;SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task3Completed=true;SP.phase='task3_complete';delete S.speakingTask3SessionId;var r=spSt();r.t3.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(!spCommitCurrent(token,view)||SP_TASK3_FLOW!==flow)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{spEndCommit(token)}}
async function spCompleteTask4(selfRating,btn){if(!SP||SP.t!==4||!SP_TASK4_FLOW||SP.task4Completed)return false;var view=SP,flow=SP_TASK4_FLOW,token=spBeginCommit();if(token===null)return false;try{var session=await flow.complete(selfRating);if(!spCommitCurrent(token,view)||SP_TASK4_FLOW!==flow)return false;SP.session=session;SP.task4Completed=true;SP.phase='task4_complete';
    delete S.speakingTask4SessionId;var r=spSt();r.t4.n++;spSync();save();spRender();return true}
  catch(error){if(!spCommitCurrent(token,view)||SP_TASK4_FLOW!==flow)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}finally{spEndCommit(token)}}
function spEtalon(){if(!SP||SP.t!==1)return;
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  var parts=speakingModule.sentences(SP.set.tx).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 2: серверная оценка по owner-bound assessment references ---- */
function spAssignment(t,set){return speakingModule.assignment(t,set)}
function spOfficialRecordings(){
  if(!SP||!SP.session||!SP.session.id)return null;
  if(SP.t===1&&SP_TASK1_FLOW&&SP.blob)return [{blob:SP.blob,itemNumber:null}];
  if(SP.t===2&&SP_TASK2_FLOW)return SP_TASK2_FLOW.assessmentRecordings().map(function(item){return {blob:item.blob,itemNumber:item.positionNumber}});
  if(SP.t===3&&SP_TASK3_FLOW)return SP_TASK3_FLOW.assessmentRecordings().map(function(item){return {blob:item.blob,itemNumber:item.positionNumber}});
  if(SP.t===4&&SP_TASK4_FLOW&&SP.blob)return [{blob:SP.blob,itemNumber:null}];
  return null}
async function spUploadPronunciation(taskType,sessionId,recording,idempotencyKey,locale){
  if(!window.crypto||typeof window.crypto.randomUUID!=='function')throw new Error('безопасный ключ загрузки недоступен — обнови браузер');
  var wav=await convertRecordingToPcm16Wav(recording.blob);
  var speechLocale=locale||(SP&&SP.session&&SP.session.accentProfile&&SP.session.accentProfile.locale)||(SP_ACCENT&&SP_ACCENT.locale)||'en-GB';
  var headers={
    'Idempotency-Key':idempotencyKey||window.crypto.randomUUID(),
    'X-Speech-Locale':speechLocale,
    'X-Audio-Duration-Seconds':String(wav.durationSeconds)
  };
  if(recording.itemNumber!=null)headers['X-Speaking-Item']=String(recording.itemNumber);
  var result=await apiPostBinary('/api/v1/speaking/task-'+taskType+'/sessions/'+sessionId+'/pronunciation-assessment',wav.blob,'audio/wav',headers);
  if(!result||!result.billing||!result.billing.assessmentId||result.assessment&&result.assessment.status!=='success'){
    var unavailable=new Error('автоматическая оценка записи сейчас недоступна — попробуй позже');unavailable.code='SPEAKING_PRONUNCIATION_UNAVAILABLE';throw unavailable}
  return {key:headers['Idempotency-Key'],transcript:result.assessment&&result.assessment.transcript||'',wavBlob:wav.blob,locale:speechLocale}}
async function spAccentFinishUnknown(btn){
  if(!SP||SP.t!==1||!SP.blob||!SP.session||!SP.accentCalibration)return false;
  var view=SP,epoch=SP_VIEW_EPOCH,sessionId=SP.session.id,calibration=SP.accentCalibration,recording={blob:SP.blob,itemNumber:null};
  if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.textContent='Сравниваю en-GB и en-US…'}
  try{
    var cache=view.accentCalibrationUploadCache;
    if(!cache){cache={enGB:{key:window.crypto.randomUUID(),result:null},enUS:{key:window.crypto.randomUUID(),result:null}};view.accentCalibrationUploadCache=cache}
    if(!cache.enGB.result)cache.enGB.result=await spUploadPronunciation(1,sessionId,recording,cache.enGB.key,'en-GB');
    if(SP!==view||epoch!==SP_VIEW_EPOCH||String(view.session&&view.session.id)!==String(sessionId))return false;
    if(!cache.enUS.result)cache.enUS.result=await spUploadPronunciation(1,sessionId,recording,cache.enUS.key,'en-US');
    if(SP!==view||epoch!==SP_VIEW_EPOCH||String(view.session&&view.session.id)!==String(sessionId))return false;
    var result=await apiPost('/api/v1/speaking/accent-profile/calibration/'+encodeURIComponent(calibration.id)+'/complete',{
      enGbAssessmentKey:cache.enGB.result.key,enUsAssessmentKey:cache.enUS.result.key
    });
    if(SP!==view||epoch!==SP_VIEW_EPOCH||String(view.session&&view.session.id)!==String(sessionId))return false;
    SP_ACCENT=result.profile;SP_ACCENT_SETUP=null;view.accentCalibration=null;
    spHub();toast('Профиль '+result.profile.locale+' предложен и сохранён. Его можно изменить в любой момент.');return true
  }catch(error){if(SP!==view||epoch!==SP_VIEW_EPOCH)return false;if(btn&&btn.isConnected){btn.disabled=false;btn.textContent='Повторить определение варианта';delete btn.dataset.busy}try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spContributeCalibration(btn){
  if(!SP||!SP.calibrationCandidate||!SP_CALIBRATION_CONSENT||!SP_CALIBRATION_CONSENT.granted)return false;
  var view=SP,epoch=SP_VIEW_EPOCH,candidate=SP.calibrationCandidate;
  if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.textContent='Передаю анонимную запись…'}
  try{await apiPostBinary('/api/v1/speaking/calibration-samples',candidate.wavBlob,'audio/wav',{'X-Speaking-Assessment-Key':candidate.key});view.calibrationCandidate=null;if(SP!==view||epoch!==SP_VIEW_EPOCH)return true;if(btn&&btn.isConnected)btn.textContent='Запись передана для двойной проверки';toast('Спасибо. Эксперты не увидят имя или VK ID, а сырой звук будет удалён по правилам хранения.');return true}
  catch(error){if(SP!==view||epoch!==SP_VIEW_EPOCH)return false;if(btn&&btn.isConnected){btn.disabled=false;btn.textContent='Повторить передачу для калибровки';delete btn.dataset.busy}try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spEval(btn){
  if(!SP||SP_EVALUATION_BUSY)return false;
  if(SP.t===1&&SP_TASK1_FLOW&&!SP.task1Completed)return false;
  var officialRecordings=spOfficialRecordings();
  if(!officialRecordings&&!SP.blob)return false;
  var evaluationView=SP,evaluationSessionId=SP.session&&SP.session.id,evaluationTask=SP.t;
  var evaluationToken=spBeginEvaluation(evaluationView,btn);if(evaluationToken===null)return false;
  SP.evaluating=true;SP.evaluationError=null;if(btn)btn.textContent=officialRecordings?'Готовлю аудио…':'Расшифровываю запись…';
  try{
    var tr='',evaluationRequest,uploaded=[];
    if(officialRecordings){
      var uploadCache=evaluationView.pronunciationUploadCache;
      if(!uploadCache||uploadCache.sessionId!==evaluationSessionId||uploadCache.taskType!==evaluationTask||uploadCache.items.length!==officialRecordings.length){
        uploadCache={sessionId:evaluationSessionId,taskType:evaluationTask,items:officialRecordings.map(function(){return {key:window.crypto.randomUUID(),result:null}})};
        evaluationView.pronunciationUploadCache=uploadCache}
      for(var recordingIndex=0;recordingIndex<officialRecordings.length;recordingIndex++){
        if(btn)btn.textContent='Проверяю запись '+(recordingIndex+1)+' из '+officialRecordings.length+'…';
        var cachedUpload=uploadCache.items[recordingIndex];
        if(!cachedUpload.result)cachedUpload.result=await spUploadPronunciation(evaluationTask,evaluationSessionId,officialRecordings[recordingIndex],cachedUpload.key);
        if(!spEvaluationCurrent(evaluationToken,evaluationView,evaluationSessionId))return false;
        uploaded.push(cachedUpload.result)}
      tr=uploaded.map(function(item){return item.transcript}).filter(Boolean).join('\n');
      evaluationRequest={taskType:evaluationTask,sessionId:evaluationSessionId};
      if(evaluationTask===2||evaluationTask===3)evaluationRequest.pronunciationAssessmentKeys=uploaded.map(function(item){return item.key});
      else evaluationRequest.pronunciationAssessmentKey=uploaded[0].key
    }else{throw new Error('серверная запись не найдена — начни тренировку заново')}
    if(btn)btn.textContent='Оцениваю по критериям…';
    var response=await apiPost('/api/v1/ai/evaluate-speaking',evaluationRequest,true);
    if(!spEvaluationCurrent(evaluationToken,evaluationView,evaluationSessionId))return false;
    var d=response.review;
    if(!d||typeof d.got==='undefined')throw new Error('ИИ вернул неожиданный ответ, попробуй ещё раз');
    if(d.status==='needs_retry'){
      evaluationView.pronunciationUploadCache=null;evaluationView.evaluating=false;spShowEval(d,tr,null);spNormalizeView('needs-retry');spFinishEvaluationView(btn);return false}
    var score=speakingModule.clampScore(d,evaluationTask);d.got=score.got;d.max=score.max;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:evaluationTask,g:d.got,m:d.max,ts:Date.now()});
    evaluationView.calibrationCandidate=SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.granted&&uploaded.length===1&&(evaluationTask===1||evaluationTask===4)
      ?{key:uploaded[0].key,wavBlob:uploaded[0].wavBlob}:null;
    spSync();save();
    var freshVoiceTutor=null;
    try{
      var freshVoiceReport=await apiGet('/api/v1/speaking/learning-report');
      if(!spEvaluationCurrent(evaluationToken,evaluationView,evaluationSessionId))return false;
      var freshVoicePointer=freshVoiceReport&&freshVoiceReport.premium&&freshVoiceReport.premium.voiceTutor;
      var freshVoiceOptions=spVoiceTutorOptions(freshVoicePointer);
      if(freshVoiceOptions&&String(freshVoicePointer.attemptId)===String(response.attemptId))freshVoiceTutor=freshVoiceOptions
    }catch(_){}
    evaluationView.evaluating=false;spShowEval(d,tr,freshVoiceTutor);spNormalizeView('complete');spFinishEvaluationView(btn);
    completeAdaptiveServerAttempt('speaking',response.attemptId).then(function(result){if(result&&SP===evaluationView&&String(SP.session&&SP.session.id)===String(evaluationSessionId))showAdaptiveSpeakingReturn()}).catch(function(error){
      if(SP!==evaluationView)return;try{toast('Оценка сохранена, но план пока не обновлён: '+apiMessage(error,'request'))}catch(_){}});return true;
  }catch(e){
    if(!spEvaluationCurrent(evaluationToken,evaluationView,evaluationSessionId))return false;evaluationView.evaluating=false;evaluationView.evaluationError={code:String(e&&e.code||''),status:Number(e&&e.status||0),message:apiMessage(e,'stt')};
    var evaluationErrorState=spEvaluationErrorState(e);spShowEvalError(e);spNormalizeView(evaluationErrorState);if(evaluationErrorState==='quota')spFinishEvaluationView(btn);else if(btn){btn.textContent='Повторить оценку';btn.removeAttribute('aria-busy');delete btn.dataset.busy}
    try{toast(apiMessage(e,'stt'))}catch(_){}return false
  }finally{spReleaseEvaluation(evaluationToken)}}
function spEvaluationErrorState(error){if(Number(error&&error.status)===429)return 'quota';if(Number(error&&error.status)===503)return 'provider-unavailable';if(String(error&&error.code).includes('NETWORK'))return 'network-error';return 'retry'}
function spShowEvalError(error){var box=document.getElementById('sp_evalbox');if(!box)return;var state=spEvaluationErrorState(error);var title=state==='quota'?'Лимит автоматической оценки исчерпан':state==='provider-unavailable'?'Сервис оценки сейчас недоступен':state==='network-error'?'Нет связи для отправки записи':'Не удалось завершить оценку';var action=state==='quota'?'Локальная запись и прослушивание по-прежнему доступны.':state==='provider-unavailable'?'Запись остаётся локальной. Попробуй позже.':'Проверь соединение и нажми «Повторить оценку» — ключ этой попытки будет использован повторно.';box.innerHTML='<div class="speaking-state" data-state="'+state+'" role="alert" aria-live="assertive"><strong>'+title+'</strong><span>'+action+'</span></div>'}
function spShowEval(d,tr,voiceTutor){var box=document.getElementById('sp_evalbox');if(!box)return;
  /* всё, что пришло от модели или STT, попадает в DOM только экранированным */
  var safe=ui.escapeHtml;
  if(d.status==='needs_retry'){
    box.innerHTML='<div class="clayCard speaking-state speaking-evaluation-card speaking-evaluation-card--retry" data-state="needs-retry" role="status" aria-live="polite">'
      +'<div class="speaking-evaluation-card__title">Нужна ещё одна запись</div>'
      +'<div class="speaking-evaluation-card__copy">'+safe(d.verdict||'Запись или расшифровка недостаточно надёжна для честного балла. Попробуй записать ответ ещё раз.')+'</div>'
      +'<div class="speaking-evaluation-card__evidence">Ноль не поставлен: автоматическая система не уверена в доказательствах.</div></div>';return}
  var pct=d.got/(d.max||1);
  var scoreBand=pct>=0.7?'strong':(pct>=0.4?'developing':'weak');
  var h='<div class="clayCard speaking-state speaking-evaluation-card" data-state="success" role="status" aria-live="polite" aria-atomic="true">'
    +'<div class="speaking-evaluation-card__header">'
    +'<div class="speaking-evaluation-score" data-score-band="'+scoreBand+'">'+d.got+' из '+d.max+'</div>'
    +(speakingModule.isExperimentalTask(SP.t)||SP.t===1||SP.t===2?'<div class="ai-disclaimer speaking-evaluation-card__disclaimer">'+ui.escapeHtml(ui.AI_DISCLAIMER)+'</div>':'')
    +'<div class="speaking-evaluation-card__verdict">'+safe(d.verdict||'')+'</div></div>';
  if(Array.isArray(d.criteria)&&d.criteria.length)
    h+='<div class="speaking-evaluation-criteria">'+d.criteria.map(function(c){
      return '<div class="speaking-evaluation-criterion"><span>'+safe(c.name)+'</span><b data-score-band="'+((+c.got||0)>=(+c.max||1)?'strong':'developing')+'">'+safe(c.got)+' / '+safe(c.max)+'</b></div>'}).join('')+'</div>';
  if(Array.isArray(d.good)&&d.good.length)
    h+='<div class="speaking-insight speaking-insight--success">'
      +'<div class="speaking-insight__label">ЧТО ПОЛУЧИЛОСЬ</div>'
      +d.good.map(function(g){return '<div class="speaking-insight__item">• '+safe(g)+'</div>'}).join('')+'</div>';
  if(Array.isArray(d.fix)&&d.fix.length)
    h+='<div class="speaking-insight speaking-insight--improve">'
      +'<div class="speaking-insight__label">НАД ЧЕМ ПОРАБОТАТЬ</div>'
      +d.fix.map(function(f){return '<div class="speaking-insight__item">'
        +(f.wrong?'<s class="speaking-insight__wrong">'+safe(f.wrong)+'</s> → ':'')+(f.right?'<b class="speaking-insight__right">'+safe(f.right)+'</b><br>':'')+safe(f.note||'')+'</div>'}).join('')+'</div>';
  var evidenceNote=SP.t===1
    ?'Автоматическая оценка учла распознанный текст, полноту чтения, беглость распознавания и отмеченные системой грубые ошибки в словах. Интонация и отдельные фонемы в балл не входили.'
    :'Автоматическая оценка учла распознанное содержание ответа и отмеченные системой грубые ошибки в словах. Интонация, отдельные фонемы и естественность пауз в балл не входили.';
  h+='<div class="speaking-evaluation-card__evidence">'+safe(evidenceNote)+'</div>';
  if(SP.calibrationCandidate)h+='<div class="speaking-evaluation-calibration"><b>Добровольная калибровка точности</b><br>Можно отдельно передать эту запись для двух независимых слепых оценок. Имя и VK ID экспертам не показываются.<button type="button" class="sq speaking-support-action speaking-support-action--info" onclick="spContributeCalibration(this)">Передать анонимную запись</button></div>';
  h+='<details class="speaking-evaluation-transcript"><summary>Расшифровка твоей речи</summary>'
    +'<div class="speaking-evaluation-transcript__copy">'+safe(tr)+'</div><button class="sq speaking-support-action speaking-support-action--muted" onclick="spFlagTranscript()">Расшифровка неточная</button></details>'
    +(voiceTutor?voiceTutorButton(voiceTutor):'')
    +'</div>';
  box.innerHTML=h;
  try{var reducedMotion=globalThis.matchMedia&&globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;box.scrollIntoView({behavior:reducedMotion?'auto':'smooth',block:'start'})}catch(e){}}
function showAdaptiveSpeakingReturn(){var box=document.getElementById('sp_evalbox');if(!box||document.getElementById('adaptive_speaking_return'))return;var button=document.getElementById('adaptive_speaking_retry');if(button){button.removeAttribute('onclick')}else{button=document.createElement('button');button.type='button';button.className='sq aisy-button speaking-action speaking-action--primary '+SP_CANONICAL_PRIMARY_CLASS;button.dataset.speakingForward='';box.appendChild(button)}button.hidden=false;button.id='adaptive_speaking_return';button.textContent='Вернуться к персональному плану';button.addEventListener('click',openAdaptivePlan,{once:true});spNormalizeView();spPromoteForwardAction()}
function spFlagTranscript(){S.sttFeedback=(S.sttFeedback||0)+1;save();try{toast('Спасибо, отметка сохранена')}catch(e){}}
async function spSample(btn){
  if(!SP)return false;var view=SP,epoch=SP_VIEW_EPOCH,t=view.t,set=view.set,box=document.getElementById('sp_evalbox');
  if(officialTask2Active()||officialTask3Active()||officialTask4Active())return;
  if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.setAttribute('aria-busy','true');btn.textContent='Готовлю образец…'}
  try{
    var response=await apiPost('/api/v1/ai/generate-speaking-sample',{taskType:t,assignment:spAssignment(t,set)},true);
    if(SP!==view||SP_VIEW_EPOCH!==epoch||document.getElementById('sp_evalbox')!==box||(btn&&btn.isConnected===false))return false;
    var d=response.data;if(!d||!d.text)throw new Error('не получилось');
    SP.sample=String(d.text);
    if(box)box.insertAdjacentHTML('afterbegin','<div class="clayCard speaking-sample-card">'
      +'<div class="speaking-sample-card__header">'
      +'<span class="speaking-sample-card__label">ОБРАЗЕЦ ОТ ИИ</span>'
      +'<button type="button" class="clk sq iconbtn speaking-support-action speaking-support-action--info speaking-sample-card__voice" onclick="spVoiceSample()">Озвучить</button></div>'
      +'<div class="speaking-sample-card__copy">'+ui.escapeHtml(SP.sample)+'</div></div>');
    if(btn){btn.hidden=true;btn.removeAttribute('aria-busy');delete btn.dataset.busy}spNormalizeView();return true
  }catch(e){
    if(SP!==view||SP_VIEW_EPOCH!==epoch||document.getElementById('sp_evalbox')!==box||(btn&&btn.isConnected===false))return false;
    if(btn){btn.disabled=false;btn.textContent='Образец ответа от ИИ · повторить';btn.removeAttribute('aria-busy');delete btn.dataset.busy}
    try{toast(apiMessage(e,'ai'))}catch(_){}return false}}
function spVoiceSample(){if(!SP||!SP.sample)return;
  var parts=speakingModule.sentences(SP.sample).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 3: экзамен устной части целиком ---- */
let SPE=null,SPE_FLOW=null,SPE_TM=null,SPE_PROMPT_SEQUENCE=0,SPE_FULL_RESULT=null,SPE_FULL_UPLOAD_CACHE=null,SPE_FULL_SUBMIT_KEY=null,SPE_FULL_SUBMITTING=false,SPE_FULL_STAGE_ACTION=null,SPE_FULL_STAGE_SEQUENCE=0,SPE_FULL_TIMEOUT_PENDING=null,SPE_FULL_EVALUATION_ACTION=null,SPE_FULL_EVALUATION_SEQUENCE=0,SPE_FULL_ASSESSMENT_READY=false,SPE_MIC_ERROR=null,SPE_RESTORED_WITHOUT_AUDIO=false;
function speFullDispose(){clearInterval(SPE_TM);SPE_TM=null;SPE_FULL_SUBMITTING=false;SPE_FULL_SUBMIT_KEY=null;var stageLock=SPE_FULL_STAGE_ACTION,assessmentLock=SPE_FULL_EVALUATION_ACTION;SPE_FULL_STAGE_SEQUENCE++;SPE_FULL_STAGE_ACTION=null;SPE_FULL_TIMEOUT_PENDING=null;speFullClearStageBusy(stageLock);SPE_FULL_EVALUATION_SEQUENCE++;SPE_FULL_EVALUATION_ACTION=null;speFullClearEvaluationBusy(assessmentLock);SPE_FULL_ASSESSMENT_READY=false;SPE_PROMPT_SEQUENCE++;SPE_MIC_ERROR=null;SPE_RESTORED_WITHOUT_AUDIO=false;try{lStop()}catch(_){}if(SPE_FLOW){SPE_FLOW.dispose();SPE_FLOW=null}SPE=null;SPE_FULL_RESULT=null;SPE_FULL_UPLOAD_CACHE=null}
function speFullRestoreLostAudio(session){return Boolean(session&&session.status!=='submitted'&&(session.phase==='recording'||(session.progress||[]).some(function(task){return (task.responses||[]).some(function(response){return response.status==='completed'})})))}
function speFullPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_FULL_CATALOG_REVISION_MISMATCH'}
function speFullStageMessage(action){var messages={begin:['Подготавливаем этап','Сервер запускает официальный таймер.'],start:['Запускаем запись','Проверяем текущий ответ и включаем микрофон.'],stop:['Завершаем запись','Фиксируем локальную запись этого ответа.'],complete:['Сохраняем ответ','Сервер переводит экзамен к следующему ответу.'],timeout:['Время закончилось','Завершаем текущий ответ по официальному таймеру.']};return messages[action]||messages.complete}
function speFullSetStageBusy(lock,btn){var area=document.getElementById('s9_area'),route=spRoute();if(!area||!route)return;if(typeof area.setAttribute==='function')area.setAttribute('aria-busy','true');if(typeof route.querySelectorAll==='function')route.querySelectorAll('button.speaking-action').forEach(function(control){control.disabled=true;if(typeof control.setAttribute==='function')control.setAttribute('aria-disabled','true');if(control.dataset)control.dataset.speFullStageLock=String(lock.id)});if(btn){btn.disabled=true;if(typeof btn.setAttribute==='function'){btn.setAttribute('aria-disabled','true');btn.setAttribute('aria-busy','true')}if(btn.dataset)btn.dataset.speFullStageLock=String(lock.id)}var host=document.getElementById('s9_card')||area;var status=document.getElementById('spe_full_action_status');if(!status&&typeof document.createElement==='function'&&host&&typeof host.append==='function'){status=document.createElement('div');status.id='spe_full_action_status';status.className='speaking-state speaking-full-action-status';if(typeof status.setAttribute==='function'){status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true')}host.append(status)}var message=speFullStageMessage(lock.action);if(status){if(status.dataset)status.dataset.state='processing';status.innerHTML='<strong>'+message[0]+'</strong><span>'+message[1]+'</span>'}spNormalizeView('processing')}
function speFullAcquireStage(action,btn,sharedLock){if(sharedLock)return SPE_FULL_STAGE_ACTION===sharedLock?{lock:sharedLock,owner:false}:null;if(!SPE_FLOW||SPE_FULL_STAGE_ACTION)return null;var state=SPE_FLOW.state(),session=state&&state.session;if(!session)return null;var lock={id:++SPE_FULL_STAGE_SEQUENCE,action:action,flow:SPE_FLOW,sessionId:String(session.id)};SPE_FULL_STAGE_ACTION=lock;speFullSetStageBusy(lock,btn);return {lock:lock,owner:true}}
function speFullStageCurrent(lock,flow){if(!lock||SPE_FULL_STAGE_ACTION!==lock||SPE_FLOW!==flow||lock.flow!==flow)return false;try{return String(flow.state().session.id)===lock.sessionId}catch(_){return false}}
function speFullStageSnapshot(session){var current=session&&session.current;if(!session||!current)return null;return {sessionId:String(session.id),taskType:Number(current.taskType),responseNumber:Number(current.responseNumber),phase:String(session.phase),stageDeadlineAt:String(current.stageDeadlineAt||'')}}
function speFullStageMatches(snapshot){if(!snapshot||!SPE_FLOW)return false;try{var current=speFullStageSnapshot(SPE_FLOW.state().session);return Boolean(current&&current.sessionId===snapshot.sessionId&&current.taskType===snapshot.taskType&&current.responseNumber===snapshot.responseNumber&&current.phase===snapshot.phase&&current.stageDeadlineAt===snapshot.stageDeadlineAt)}catch(_){return false}}
function speFullClearStageBusy(lock){var area=document.getElementById('s9_area'),route=spRoute();if(area&&typeof area.removeAttribute==='function')area.removeAttribute('aria-busy');if(route&&lock&&typeof route.querySelectorAll==='function')route.querySelectorAll('[data-spe-full-stage-lock="'+lock.id+'"]').forEach(function(control){control.disabled=false;if(typeof control.removeAttribute==='function'){control.removeAttribute('aria-disabled');control.removeAttribute('aria-busy')}if(control.dataset)delete control.dataset.speFullStageLock});var status=document.getElementById('spe_full_action_status');if(status&&typeof status.remove==='function')status.remove()}
function speFullReleaseStage(lock){if(!lock||SPE_FULL_STAGE_ACTION!==lock)return;SPE_FULL_STAGE_ACTION=null;speFullClearStageBusy(lock);spNormalizeView();var expiredStage=SPE_FULL_TIMEOUT_PENDING;SPE_FULL_TIMEOUT_PENDING=null;if(expiredStage&&speFullStageMatches(expiredStage))void speFullTimeout(expiredStage)}
function speFullAcquireEvaluation(btn,flow,result){if(!btn||SPE_FULL_EVALUATION_ACTION)return null;var state=flow&&flow.state(),session=state&&state.session;if(!session)return null;var lock={id:++SPE_FULL_EVALUATION_SEQUENCE,flow:flow,result:result,sessionId:String(session.id)};SPE_FULL_EVALUATION_ACTION=lock;var route=spRoute(),area=document.getElementById('s9_area');if(route&&typeof route.setAttribute==='function')route.setAttribute('aria-busy','true');if(area&&typeof area.setAttribute==='function')area.setAttribute('aria-busy','true');if(route&&typeof route.querySelectorAll==='function')route.querySelectorAll('button').forEach(function(control){if(control.dataset){control.dataset.speFullEvaluationLock=String(lock.id);control.dataset.speFullEvaluationWasDisabled=String(control.disabled);control.dataset.speFullEvaluationWasAriaDisabled=String(typeof control.getAttribute==='function'&&control.getAttribute('aria-disabled')==='true')}control.disabled=true;if(typeof control.setAttribute==='function')control.setAttribute('aria-disabled','true')});if(typeof btn.setAttribute==='function')btn.setAttribute('aria-busy','true');spNormalizeView('processing');return lock}
function speFullClearEvaluationBusy(lock){var route=spRoute(),area=document.getElementById('s9_area');if(route&&!SPE_FULL_STAGE_ACTION&&typeof route.removeAttribute==='function')route.removeAttribute('aria-busy');if(area&&!SPE_FULL_STAGE_ACTION&&typeof area.removeAttribute==='function')area.removeAttribute('aria-busy');if(!route||!lock||typeof route.querySelectorAll!=='function')return;route.querySelectorAll('[data-spe-full-evaluation-lock="'+lock.id+'"]').forEach(function(control){var data=control.dataset||{},keepDisabled=data.speFullEvaluationKeepDisabled==='true',wasDisabled=data.speFullEvaluationWasDisabled==='true',wasAriaDisabled=data.speFullEvaluationWasAriaDisabled==='true';control.disabled=keepDisabled||wasDisabled;if((keepDisabled||wasAriaDisabled)&&typeof control.setAttribute==='function')control.setAttribute('aria-disabled','true');else if(typeof control.removeAttribute==='function')control.removeAttribute('aria-disabled');if(typeof control.removeAttribute==='function')control.removeAttribute('aria-busy');if(control.dataset){delete control.dataset.speFullEvaluationLock;delete control.dataset.speFullEvaluationWasDisabled;delete control.dataset.speFullEvaluationWasAriaDisabled;delete control.dataset.speFullEvaluationKeepDisabled}})}
function speFullReleaseEvaluation(lock){if(!lock||SPE_FULL_EVALUATION_ACTION!==lock)return;SPE_FULL_EVALUATION_ACTION=null;speFullClearEvaluationBusy(lock);spNormalizeView()}
function spExam(){var area=document.getElementById('s9_area');if(!area)return;SP_VIEW_EPOCH++;spStopAll();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP=null;
  var lock=adaptiveSpeakingLock();if(lock){launchAdaptiveSpeakingLock(lock);return}
  area.innerHTML='<section id="s9_card" class="clayCard speaking-sheet speaking-sheet--roomy speaking-stack speaking-full-intro" aria-labelledby="spe_full_intro_title">'
    +'<p class="speaking-kicker">КАК НА ЕГЭ</p>'
    +'<h2 id="spe_full_intro_title" class="speaking-heading">Устная часть целиком</h2>'
    +'<p class="speaking-copy">Чтение → 4 прямых вопроса → 5 ответов интервью → монолог. Сервер закрепляет один вариант и ведёт по официальным таймерам. До отдельного запуска оценки аудио остаётся только на устройстве; при оценке записи явно отправляются внешнему speech-провайдеру и не сохраняются как исходный звук.</p>'
    +'<p class="speaking-meta speaking-meta--strong">Максимум: 20 баллов · после сдачи доступна примерная автоматическая оценка</p>'
    +'</section>'
    +'<div class="speaking-action-stack">'
    +spBtn(S.speakingFullSessionId?'Продолжить экзамен':'Начать экзамен','speStart()',true)
    +spBtn('К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s')}
async function speStart(){return speFullStart()}
async function speFullStart(){var area=document.getElementById('s9_area');if(!area)return false;var epoch=++SP_VIEW_EPOCH;speFullDispose();
  area.innerHTML='<div class="clayCard speaking-state" data-state="loading" role="status" aria-live="polite">Сервер закрепляет полный вариант…</div>';spNormalizeView('loading');
  var flow=createSpeakingFullBrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}},prepareAssessmentRecording:spePrepareAssessmentRecording});SPE_FLOW=flow;
  try{var session=null;
    if(S.speakingFullSessionId){try{session=await flow.restoreSession(S.speakingFullSessionId);if(epoch!==SP_VIEW_EPOCH||SPE_FLOW!==flow)return false;SPE_RESTORED_WITHOUT_AUDIO=speFullRestoreLostAudio(session)}catch(error){
      if(!speFullPointerInvalid(error))throw error;delete S.speakingFullSessionId;save()}}
    if(!session||session.status==='submitted'){session=await flow.loadAssignment();if(epoch!==SP_VIEW_EPOCH||SPE_FLOW!==flow)return false}
    S.speakingFullSessionId=session.id;save();SPE=flow.state();
    if(session.task&&session.task.taskType===4){await flow.prepareCurrentAssets();if(epoch!==SP_VIEW_EPOCH||SPE_FLOW!==flow)return false}
    SPE=flow.state();speRender();return true
  }catch(error){if(epoch!==SP_VIEW_EPOCH||SPE_FLOW!==flow)return false;speFullDispose();try{toast(apiMessage(error,'request'))}catch(_){}spExam();return false}}
async function speFullMicCheck(btn){if(!SPE_FLOW)return false;if(btn)btn.disabled=true;var flow=SPE_FLOW;try{await flow.checkMicrophone();if(SPE_FLOW!==flow)return false;SPE_MIC_ERROR=null;SPE=flow.state();speRender();return true}
  catch(error){if(SPE_FLOW!==flow)return false;SPE_MIC_ERROR={code:String(error&&error.code||'MICROPHONE_UNAVAILABLE')};if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}SPE=flow.state();speRender();return false}}
async function speFullBeginStage(btn,sharedLock){if(!SPE_FLOW)return false;var acquired=speFullAcquireStage('begin',btn,sharedLock);if(!acquired)return false;var lock=acquired.lock,flow=lock.flow;
  try{if(!speFullStageCurrent(lock,flow))return false;var current=flow.state().session;
    if(current.task.taskType===3&&current.phase==='ready')return await speFullStartRecording(null,lock);
    await flow.beginStage();if(!speFullStageCurrent(lock,flow))return false;SPE=flow.state();
    if(SPE.session.phase==='recording')return await speFullStartRecording(null,lock);speRender();return true}
  catch(error){if(!speFullStageCurrent(lock,flow))return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}
  finally{if(acquired.owner)speFullReleaseStage(lock)}}
async function speFullStartRecording(btn,sharedLock){if(!SPE_FLOW)return false;var acquired=speFullAcquireStage('start',btn,sharedLock);if(!acquired)return false;var lock=acquired.lock,flow=lock.flow;try{
    if(!speFullStageCurrent(lock,flow))return false;var promptSequence=++SPE_PROMPT_SEQUENCE,before=flow.state(),beforeSession=before.session;
    var beforePosition=beforeSession.current?{taskType:beforeSession.current.taskType,responseNumber:beforeSession.current.responseNumber,phase:beforeSession.phase}:null;
    if(beforeSession.task.taskType===4){await flow.prepareCurrentAssets();if(!speFullStageCurrent(lock,flow))return false}
    if(beforeSession.task.taskType===3&&beforeSession.phase!=='recording'){
      var question=beforeSession.task.questions[beforeSession.current.responseNumber-1];
      try{await Promise.resolve(lPlayRaw([{s:1,t:question}]))}catch(_){}
      if(!speFullStageCurrent(lock,flow)||promptSequence!==SPE_PROMPT_SEQUENCE)return false;var afterPrompt=flow.state().session;
      if(afterPrompt.id!==beforeSession.id||afterPrompt.phase!==beforePosition.phase
        ||afterPrompt.current.taskType!==beforePosition.taskType
        ||afterPrompt.current.responseNumber!==beforePosition.responseNumber)return false}
    if(!speFullStageCurrent(lock,flow))return false;await flow.startRecording();if(!speFullStageCurrent(lock,flow))return false;SPE=flow.state();
    speRender();return true
  }catch(error){if(!speFullStageCurrent(lock,flow))return false;SPE=flow.state();try{toast(apiMessage(error,'request'))}catch(_){}if(SPE)speRender();return false}
  finally{if(acquired.owner)speFullReleaseStage(lock)}}
async function speFullStopRecording(btn,sharedLock){if(!SPE_FLOW)return false;var acquired=speFullAcquireStage('stop',btn,sharedLock);if(!acquired)return false;var lock=acquired.lock,flow=lock.flow;try{if(!speFullStageCurrent(lock,flow))return false;await flow.stopRecording();if(!speFullStageCurrent(lock,flow))return false;SPE=flow.state();speRender();return true}
  catch(error){if(!speFullStageCurrent(lock,flow))return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}
  finally{if(acquired.owner)speFullReleaseStage(lock)}}
async function speFullComplete(status,issue,btn,sharedLock){if(!SPE_FLOW)return false;var acquired=speFullAcquireStage('complete',btn,sharedLock);if(!acquired)return false;var lock=acquired.lock,flow=lock.flow;try{
    SPE_PROMPT_SEQUENCE++;try{lStop()}catch(_){}
    while(['ready','preparing'].includes(flow.state().session.phase)){if(!speFullStageCurrent(lock,flow))return false;await flow.beginStage();if(!speFullStageCurrent(lock,flow))return false}
    await flow.completeResponse(status,issue||null);if(!speFullStageCurrent(lock,flow))return false;SPE=flow.state();
    if(SPE.session.task&&SPE.session.task.taskType===4){await flow.prepareCurrentAssets();if(!speFullStageCurrent(lock,flow))return false}
    SPE=flow.state();speRender();return true
  }catch(error){if(!speFullStageCurrent(lock,flow))return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}
  finally{if(acquired.owner)speFullReleaseStage(lock)}}
async function speFullTimeout(expiredStage){if(!SPE_FLOW||!SPE)return false;var snapshot=expiredStage||speFullStageSnapshot(SPE_FLOW.state().session);if(!speFullStageMatches(snapshot))return false;if(SPE_FULL_STAGE_ACTION){SPE_FULL_TIMEOUT_PENDING=snapshot;return false}var acquired=speFullAcquireStage('timeout',null,null);if(!acquired)return false;SPE_FULL_TIMEOUT_PENDING=null;var lock=acquired.lock,flow=lock.flow;try{if(!speFullStageCurrent(lock,flow)||!speFullStageMatches(snapshot))return false;var state=flow.state();
    if(state.session.phase==='preparing')return await speFullStartRecording(null,lock);
    if(state.session.phase==='recording'){
      if(state.isRecording){var stopped=await speFullStopRecording(null,lock);if(!stopped||!speFullStageCurrent(lock,flow))return false}
      state=flow.state();return await speFullComplete(state.recording?'completed':'technical_issue',state.recording?null:'recording_failed',null,lock)}return false
  }finally{if(acquired.owner)speFullReleaseStage(lock)}}
function speFullArmTimer(){clearInterval(SPE_TM);SPE_TM=null;if(!SPE||!SPE.session.current||!SPE.session.current.stageDeadlineAt)return;
  var expired=false;var update=function(){if(!SPE_FLOW)return;var flowState=SPE_FLOW.state(),current=flowState.session.current;if(!current||!current.stageDeadlineAt)return;
    var left=Math.max(0,Math.ceil((new Date(current.stageDeadlineAt).getTime()-Date.now())/1000)),value=spFmt(left);setTxt('s9_timer',value);var timer=document.getElementById('s9_timer');if(timer&&typeof timer.setAttribute==='function')timer.setAttribute('aria-label','Оставшееся время: '+value);
    if(left<=0){expired=true;clearInterval(SPE_TM);SPE_TM=null;void speFullTimeout(speFullStageSnapshot(flowState.session))}};
  update();if(!expired&&SPE_TM===null)SPE_TM=setInterval(update,1000)}
function speTaskBody(){var task=SPE.session.task,pos=SPE.session.current,safe=ui.escapeHtml;if(!task||!pos)return '';
  if(task.taskType===1)return '<section class="speaking-stack speaking-full-task" aria-labelledby="spe_full_task_heading"><h3 id="spe_full_task_heading" class="aisy-sr-only">Текст для чтения</h3><p class="speaking-copy speaking-full-reading">'+safe(task.text)+'</p></section>';
  if(task.taskType===2){var preparing=SPE.session.phase==='preparing';var supportBody=preparing
    ?'<ol class="speaking-list speaking-full-supports">'+task.supports.map(function(support){return '<li>'+safe(support)+'</li>'}).join('')+'</ol>'
    :'<p class="speaking-full-support">'+safe(task.supports[pos.responseNumber-1])+'</p>';
    return '<section class="speaking-stack speaking-full-task" aria-labelledby="spe_full_task_heading"><p class="speaking-note speaking-quote">'+safe(task.advertisement)+'</p>'
    +'<h3 id="spe_full_task_heading" class="speaking-subheading">'+(preparing?'Подготовь четыре прямых вопроса:':'Задай прямой вопрос о пункте '+pos.responseNumber+':')+'</h3>'+supportBody+'</section>'}
  if(task.taskType===3){if(SPE.session.phase==='ready')return '<div class="speaking-note speaking-note--info speaking-full-task" role="status">Вопрос прозвучит после запуска. Отдельного времени на подготовку нет; затем начнутся запись и 40 секунд ответа.</div>';
    var question=task.questions[pos.responseNumber-1];return '<section class="speaking-stack speaking-stack--tight speaking-full-task" aria-labelledby="spe_full_task_heading"><p class="speaking-meta">Вопрос '+pos.responseNumber+' из 5</p>'
    +'<h3 id="spe_full_task_heading" class="speaking-subheading">'+safe(question)+'</h3></section>'
    }
  return '<section class="speaking-stack speaking-full-task" aria-labelledby="spe_full_task_heading"><h3 id="spe_full_task_heading" class="speaking-subheading">Проект: '+safe(task.projectTitle)+'</h3>'
    +'<img class="speaking-full-photo" src="'+safe(task.photoPair.src)+'" alt="'+safe(task.photoPair.alt)+'">'
    +'<p class="speaking-meta speaking-meta--strong">План:</p><ol class="speaking-list speaking-full-plan">'
    +task.plan.map(function(point){return '<li>'+safe(point)+'</li>'}).join('')+'</ol></section>'}
function speFullProgress(){return SPE.session.progress.map(function(item){var complete=item.completedResponses===item.responseCount;return '<span class="speaking-chip speaking-full-progress__item '+(complete?'speaking-chip--success':'')+'" data-state="'+(complete?'complete':'pending')+'">'+item.taskType+': '+item.completedResponses+'/'+item.responseCount+'</span>'}).join('')}
function speFullMicStatus(){var ready=SPE&&SPE.micCheck==='passed';var state=ready?'ready':(SPE_MIC_ERROR&&SPE_MIC_ERROR.code==='MICROPHONE_PERMISSION_DENIED'?'permission-denied':(SPE_MIC_ERROR?'error':'unchecked'));var role=SPE_MIC_ERROR?'alert':'status';var message=ready?'Микрофон готов для текущего ответа.':state==='permission-denied'?'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера и повтори проверку.':state==='error'?'Микрофон не готов. Проверь подключение и повтори проверку.':'Перед записью проверь микрофон.';return '<div id="speaking_mic_status" class="speaking-state speaking-mic-status" data-state="'+state+'" role="'+role+'" aria-live="polite">'+message+'</div>'}
function speFullNamedButton(label,action,primary){return spBtn(label,action,primary).replace('<button ','<button aria-label="'+ui.escapeHtml(label)+'" ')}
function speFullControls(){var state=SPE,session=state.session,phase=session.phase;
  if(phase==='ready_to_submit')return spBtn('Сдать устную часть','speFullSubmit(this)',true);
  var micLabel=state.micCheck==='passed'?'✓ Микрофон готов':'Проверить микрофон';var mic=spBtn(micLabel,'speFullMicCheck(this)',state.micCheck!=='passed').replace('aria-label="Проверить микрофон"','aria-label="'+micLabel+'"');
  var skip=spBtn('Пропустить ответ','speFullComplete(\'skipped\',null,this)');
  if(phase==='ready'){var beginLabel=session.task.preparationSeconds&&session.current.responseNumber===1?'Начать подготовку':'Начать запись';return mic+speFullNamedButton(beginLabel,'speFullBeginStage(this)',true)
    +skip+spBtn('Не могу записать','speFullComplete(\'technical_issue\',\'recording_failed\',this)');
  }if(phase==='preparing')return mic+speFullNamedButton('Готово — к записи','speFullStartRecording(this)',true)
    +skip+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\',this)');
  if(state.recording)return '<div class="speaking-state speaking-full-recording-ready" data-state="playback" role="status">Ответ записан локально · '+state.recording.durationSeconds+' сек.</div>'
    +spBtn('Сохранить ответ','speFullComplete(\'completed\',null,this)',true)+spBtn('Перезаписать','speFullStartRecording(this)')+skip;
  if(state.isRecording)return spBtn('Стоп — закончить запись','speFullStopRecording(this)',true);
  return (state.recordingLostOnRestore?'<div class="speaking-state speaking-full-recording-lost" data-state="error" role="alert">После перезагрузки локальная запись недоступна. Начни её заново или отметь проблему.</div>':'')
    +mic+speFullNamedButton('Начать запись','speFullStartRecording(this)',true)
    +skip+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\',this)')}
function speRender(){var area=document.getElementById('s9_area');if(!area||!SPE)return;var session=SPE.session;
  if(session.status==='submitted'){speFullFinal(session.submission);return}
  var current=session.current,phase=session.phase,chip=phase==='preparing'?'ПОДГОТОВКА':phase==='recording'?'ЗАПИСЬ':'ГОТОВО';
  area.innerHTML='<section id="s9_card" class="clayCard speaking-sheet speaking-stack speaking-full-session" aria-labelledby="spe_full_session_title">'
    +'<div class="speaking-row speaking-row--between speaking-row--wrap speaking-full-stage-header">'
    +'<h2 id="spe_full_session_title" class="speaking-kicker">ЭКЗАМЕН · '+(current?current.taskType:4)+' ИЗ 4</h2>'
    +'<span class="speaking-state" data-state="'+(phase==='recording'?'recording':(phase==='preparing'?'preparing':'ready'))+'" role="status" aria-live="polite">'+chip+'</span></div>'
    +'<div class="speaking-full-progress" aria-label="Прогресс по заданиям">'+speFullProgress()+'</div>'
    +(SPE_RESTORED_WITHOUT_AUDIO?'<div class="speaking-state speaking-full-restore-warning" data-state="warning" role="status" aria-live="polite"><strong>Сессия восстановлена без локального аудио.</strong><span>Предыдущие записи не сохранялись и недоступны для автоматической оценки. Можно честно закончить экзамен, но для полного авторазбора понадобится новый вариант.</span></div>':'')+speTaskBody()+speFullMicStatus()
    +(current&&current.stageDeadlineAt?'<div id="s9_timer" class="speaking-timer speaking-full-timer" role="timer" aria-label="Оставшееся время: —" aria-live="off">—</div>':'')
    +'</section><div class="speaking-action-stack">'+speFullControls()+'</div>';
  setTxt('s9_today',current?'задание '+current.taskType+' · ответ '+current.responseNumber:'готово к сдаче');if(SPE_FULL_STAGE_ACTION)speFullSetStageBusy(SPE_FULL_STAGE_ACTION,null);else spNormalizeView(phase==='recording'?'recording':phase);speFullArmTimer()}
function speFullSubmissionStatus(){var area=document.getElementById('s9_area');if(!area)return null;var status=document.getElementById('spe_full_submission_status');if(status)return status;status=document.createElement('div');status.id='spe_full_submission_status';status.className='speaking-state';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');area.append(status);return status}
async function speFullSubmit(btn){if(!SPE_FLOW||SPE_FULL_SUBMITTING)return false;var flow=SPE_FLOW,sessionId=flow.state().session.id;var idempotencyKey=SPE_FULL_SUBMIT_KEY||globalThis.crypto.randomUUID();SPE_FULL_SUBMIT_KEY=idempotencyKey;SPE_FULL_SUBMITTING=true;
  var status=speFullSubmissionStatus();if(status){status.dataset.state='processing';status.setAttribute('role','status');status.innerHTML='<b>Сдаём устную часть</b><span>Сервер фиксирует один итог этой экзаменационной сессии. Не закрывай экран.</span>'}
  if(btn){btn.dataset.busy='1';btn.disabled=true;btn.setAttribute('aria-busy','true');btn.textContent='Сдаю устную часть…'}spNormalizeView('processing');
  try{var result=await flow.submit(idempotencyKey);if(SPE_FLOW!==flow||String(flow.state().session.id)!==String(sessionId))return false;SPE_FULL_SUBMITTING=false;SPE_FULL_SUBMIT_KEY=null;SPE_FULL_RESULT=result;delete S.speakingFullSessionId;save();speFullFinal(result);return true
  }catch(error){if(SPE_FLOW!==flow)return false;SPE_FULL_SUBMITTING=false;if(btn){btn.disabled=false;btn.textContent='Повторить сдачу';btn.removeAttribute('aria-busy');delete btn.dataset.busy}var state=spEvaluationErrorState(error);if(status&&document.getElementById('spe_full_submission_status')===status){status.dataset.state=state;status.setAttribute('role','alert');status.innerHTML='<b>Сдача пока не подтверждена</b><span>Проверь соединение и повтори. Используется тот же ключ отправки, поэтому второй итог не появится.</span>'}spNormalizeView(state);try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullPlay(taskType,responseNumber){if(!SPE_FLOW)return false;var flow=SPE_FLOW;try{var played=await flow.playRecording(taskType,responseNumber);return SPE_FLOW===flow&&played}
  catch(error){if(SPE_FLOW!==flow)return false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function speFullExpectedAssessmentSeconds(result,recordings){var completed=new Set((result.taskResults||[]).filter(function(item){return item.recordingStatus==='completed'}).map(function(item){return item.taskType}));return recordings.filter(function(item){return completed.has(item.taskType)}).reduce(function(total,item){return total+Math.ceil(item.durationSeconds)},0)}
function speFullAssessmentRecordingReadiness(result,recordings){var counts={1:1,2:4,3:5,4:1},completedTasks=(result&&result.taskResults||[]).filter(function(item){return item.recordingStatus==='completed'}).map(function(item){return Number(item.taskType)}),items=Array.isArray(recordings)?recordings:[];if(!completedTasks.length)return {ready:false,expectedSeconds:0,reason:'no-completed-recordings'};var ready=completedTasks.every(function(taskType){var expectedCount=counts[taskType],taskRecordings=items.filter(function(item){return Number(item.taskType)===taskType}).sort(function(a,b){return Number(a.responseNumber)-Number(b.responseNumber)});return Boolean(expectedCount&&taskRecordings.length===expectedCount&&taskRecordings.every(function(item,index){return Number(item.responseNumber)===index+1&&item.blob&&Number.isFinite(Number(item.durationSeconds))&&Number(item.durationSeconds)>0&&/^[0-9a-f]{64}$/u.test(String(item.sha256||''))}))});var expectedSeconds=ready?items.filter(function(item){return completedTasks.includes(Number(item.taskType))}).reduce(function(total,item){return total+Math.ceil(Number(item.durationSeconds))},0):0;return {ready:ready,expectedSeconds:expectedSeconds,reason:ready?null:'recording-quality-unavailable'}}
async function spePrepareAssessmentRecording(recording){if(!globalThis.crypto||!globalThis.crypto.subtle)throw new Error('безопасная привязка записи недоступна — обнови браузер');var wav=await convertRecordingToPcm16Wav(recording.blob);var bytes=await wav.blob.arrayBuffer();var digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);var sha256=Array.from(new Uint8Array(digest)).map(function(value){return value.toString(16).padStart(2,'0')}).join('');return {blob:wav.blob,durationSeconds:wav.durationSeconds,sha256:sha256}}
function speFullAssessmentButton(){return document.querySelector('[data-speaking-assessment-action="evaluate"]')}
function speFullSetAssessmentReady(button,ready,checking){SPE_FULL_ASSESSMENT_READY=Boolean(ready);if(!button)return;button.disabled=!ready;if(button.dataset)button.dataset.assessmentReady=ready?'true':'false';if(ready&&typeof button.removeAttribute==='function')button.removeAttribute('aria-disabled');else if(!ready&&typeof button.setAttribute==='function')button.setAttribute('aria-disabled','true');if(checking&&typeof button.setAttribute==='function')button.setAttribute('aria-busy','true');else if(!checking&&typeof button.removeAttribute==='function')button.removeAttribute('aria-busy')}
function speFullAssessmentRetryMarkup(){return '<button type="button" class="sq aisy-button aisy-button--secondary speaking-inline-action speaking-full-status-retry" onclick="speFullRetryAssessmentStatus(this)">Повторить проверку доступности</button>'}
function speFullRetireAssessmentAction(button){speFullSetAssessmentReady(button,false,false);if(button){button.hidden=true;if(typeof button.removeAttribute==='function')button.removeAttribute('aria-busy')}spPromoteForwardAction()}
async function speFullRetryAssessmentStatus(btn){if(!SPE_FLOW||!SPE_FULL_RESULT||SPE_RESTORED_WITHOUT_AUDIO)return false;var result=SPE_FULL_RESULT;if(btn){btn.disabled=true;if(typeof btn.setAttribute==='function'){btn.setAttribute('aria-disabled','true');btn.setAttribute('aria-busy','true')}}return speFullLoadAssessmentStatus(result)}
async function speFullLoadAssessmentStatus(result){var box=document.getElementById('spe_full_assessment_status'),button=speFullAssessmentButton();speFullSetAssessmentReady(button,false,true);if(SPE_RESTORED_WITHOUT_AUDIO||!box||!button||!SPE_FLOW||result.assessment&&result.assessment.available){speFullSetAssessmentReady(button,false,false);return false}var flow=SPE_FLOW,viewResult=SPE_FULL_RESULT,recordings=flow.assessmentRecordings(),recordingReadiness=speFullAssessmentRecordingReadiness(result,recordings);if(!recordingReadiness.ready){if(box.classList&&typeof box.classList.add==='function')box.classList.add('speaking-state');if(typeof box.removeAttribute==='function')box.removeAttribute('aria-busy');if(box.dataset)box.dataset.state='quality';box.innerHTML='<b>Автоматическая оценка записей недоступна.</b><span>Не удалось безопасно подготовить полный комплект локальных записей. Прослушивание остаётся доступно до ухода с этой страницы; для полного авторазбора начни новый вариант.</span>';speFullRetireAssessmentAction(button);return false}var expected=recordingReadiness.expectedSeconds;if(typeof box.setAttribute==='function')box.setAttribute('aria-busy','true');
  try{var payload=await apiGet('/api/v1/speaking/pronunciation-assessments/status');if(SPE_RESTORED_WITHOUT_AUDIO||SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult||document.getElementById('spe_full_assessment_status')!==box||speFullAssessmentButton()!==button)return false;var quota=payload&&payload.quota||{};var provider=payload&&payload.provider||{};if(box.classList&&typeof box.classList.add==='function')box.classList.add('speaking-state');if(typeof box.removeAttribute==='function')box.removeAttribute('aria-busy');
    if(provider.available&&Number(quota.remainingSeconds||0)>=expected){box.dataset.state='ready';box.innerHTML='<b>До отправки:</b><span>ожидаемое списание до '+spFmt(expected)+' · осталось '+spFmt(Number(quota.remainingSeconds||0))+'. Локальное прослушивание лимит не расходует. Записи обработает внешний сервис Azure Speech; обычный исходный звук не сохраняется.</span>';speFullSetAssessmentReady(button,true,false);return true}
    if(provider.available){box.dataset.state='quota';box.innerHTML='<b>Для полного авторазбора не хватает лимита.</b><span>Локальные записи и прослушивание остаются доступны.</span>';speFullRetireAssessmentAction(button);return false}
    box.dataset.state='provider-unavailable';box.innerHTML='<b>Автоматическая оценка сейчас недоступна.</b><span>Записи остаются локально до ухода с экрана.</span>'+speFullAssessmentRetryMarkup();speFullSetAssessmentReady(button,false,false);return false}
  catch(_){if(SPE_RESTORED_WITHOUT_AUDIO||SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult||document.getElementById('spe_full_assessment_status')!==box||speFullAssessmentButton()!==button)return false;if(box.classList&&typeof box.classList.add==='function')box.classList.add('speaking-state');if(typeof box.removeAttribute==='function')box.removeAttribute('aria-busy');if(box.dataset)box.dataset.state='network-error';box.innerHTML='<b>Не удалось проверить лимит.</b><span>Проверь соединение и повтори перед отправкой записей.</span>'+speFullAssessmentRetryMarkup();speFullSetAssessmentReady(button,false,false);return false}}
async function spUploadFullPronunciation(sessionId,recording,cacheItem,locale){var headers={
    'Idempotency-Key':cacheItem.key,'X-Speech-Locale':locale,'X-Audio-Duration-Seconds':String(recording.durationSeconds),
    'X-Speaking-Task':String(recording.taskType)};
  if(recording.taskType===2||recording.taskType===3)headers['X-Speaking-Item']=String(recording.responseNumber);
  var result=await apiPostBinary('/api/v1/speaking/full-sessions/'+sessionId+'/pronunciation-assessment',recording.blob,'audio/wav',headers);
  if(!result||!result.billing||!result.billing.assessmentId||result.assessment&&result.assessment.status!=='success'){var unavailable=new Error('автоматическая оценка записи сейчас недоступна — попробуй позже');unavailable.code='SPEAKING_PRONUNCIATION_UNAVAILABLE';throw unavailable}
  return {key:cacheItem.key}}
async function speFullEvaluate(btn){if(!SPE_FLOW||!SPE_FULL_RESULT||SPE_RESTORED_WITHOUT_AUDIO||!SPE_FULL_ASSESSMENT_READY||!btn||btn.dataset.busy||btn.dataset.assessmentReady!=='true')return false;var flow=SPE_FLOW,viewResult=SPE_FULL_RESULT,assessmentLock=speFullAcquireEvaluation(btn,flow,viewResult);if(!assessmentLock)return false;btn.dataset.busy=1;btn.textContent='Проверяю лимит и записи…';spNormalizeView('processing');
  try{var flowState=flow.state(),session=flowState.session,result=viewResult,recordings=flow.assessmentRecordings();var sessionId=session.id;var completedTasks=(result.taskResults||[]).filter(function(item){return item.recordingStatus==='completed'}).map(function(item){return item.taskType});var counts={1:1,2:4,3:5,4:1};
    if(completedTasks.some(function(taskType){return recordings.filter(function(item){return item.taskType===taskType&&item.sha256}).length!==counts[taskType]}))throw new Error('часть локальных записей не удалось безопасно привязать при сдаче — общий балл нельзя рассчитать надёжно');
    var locale=session.accentProfile&&session.accentProfile.locale||(SP_ACCENT&&SP_ACCENT.locale)||'en-GB';
    if(!SPE_FULL_UPLOAD_CACHE||SPE_FULL_UPLOAD_CACHE.sessionId!==session.id)SPE_FULL_UPLOAD_CACHE={sessionId:session.id,items:{}};
    var attemptIds=[];
    for(var taskIndex=0;taskIndex<completedTasks.length;taskIndex++){var taskType=completedTasks[taskIndex];var taskRecordings=recordings.filter(function(item){return item.taskType===taskType}).sort(function(a,b){return a.responseNumber-b.responseNumber});var keys=[];
      for(var recordingIndex=0;recordingIndex<taskRecordings.length;recordingIndex++){var recording=taskRecordings[recordingIndex];var cacheKey=taskType+':'+recording.responseNumber;var cacheItem=SPE_FULL_UPLOAD_CACHE.items[cacheKey];if(!cacheItem){cacheItem={key:window.crypto.randomUUID(),result:null};SPE_FULL_UPLOAD_CACHE.items[cacheKey]=cacheItem}
        if(btn)btn.textContent='Проверяю задание '+taskType+' · запись '+(recordingIndex+1)+' из '+taskRecordings.length+'…';if(!cacheItem.result)cacheItem.result=await spUploadFullPronunciation(session.id,recording,cacheItem,locale);if(SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult||String(flow.state().session.id)!==String(sessionId))return false;keys.push(cacheItem.result.key)}
      var request={taskType:taskType,sessionMode:'full_section',sessionId:session.id};if(taskType===2||taskType===3)request.pronunciationAssessmentKeys=keys;else request.pronunciationAssessmentKey=keys[0];
      if(btn)btn.textContent='Рассчитываю примерный результат задания '+taskType+'…';var evaluated=await apiPost('/api/v1/ai/evaluate-speaking',request,true);if(SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult||String(flow.state().session.id)!==String(sessionId))return false;if(!evaluated||!Number.isSafeInteger(Number(evaluated.attemptId)))throw new Error('сервер не вернул сохранённую попытку');attemptIds.push(Number(evaluated.attemptId))}
    if(btn)btn.textContent='Собираю общий результат…';var fullResult=await apiPost('/api/v1/speaking/full-sessions/'+session.id+'/evaluation',{attemptIds:attemptIds});if(SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult||String(flow.state().session.id)!==String(sessionId))return false;SPE_FULL_RESULT=fullResult;speFullReleaseEvaluation(assessmentLock);speFullFinal(fullResult);return true
  }catch(error){if(SPE_FLOW!==flow||SPE_FULL_RESULT!==viewResult)return false;var state=spEvaluationErrorState(error),terminalQuota=state==='quota',providerUnavailable=state==='provider-unavailable',knownUnavailable=terminalQuota||providerUnavailable;SPE_FULL_ASSESSMENT_READY=!knownUnavailable;if(btn){btn.dataset.assessmentReady=knownUnavailable?'false':'true';btn.textContent='Повторить автоматическую оценку';if(knownUnavailable){btn.dataset.speFullEvaluationKeepDisabled='true';btn.setAttribute('aria-disabled','true')}delete btn.dataset.busy}var status=document.getElementById('spe_full_assessment_status');if(status){status.classList.add('speaking-state');status.dataset.state=state;status.innerHTML='<b>'+(terminalQuota?'Лимит автоматической оценки исчерпан':providerUnavailable?'Сервис оценки сейчас недоступен':'Не удалось завершить автоматическую оценку')+'</b><span>Локальные записи пока доступны. Повтор не создаст новую оценку для уже отправленного аудио.</span>'+(providerUnavailable?speFullAssessmentRetryMarkup():'');if(terminalQuota)speFullRetireAssessmentAction(btn)}spNormalizeView(state);try{toast(apiMessage(error,'request'))}catch(_){}return false}
  finally{speFullReleaseEvaluation(assessmentLock)}}
function speFullFinal(result){var area=document.getElementById('s9_area');if(!area||!result)return;clearInterval(SPE_TM);SPE_TM=null;SPE_FULL_RESULT=result;
  SPE_FULL_ASSESSMENT_READY=false;
  var recordings=SPE_FLOW?SPE_FLOW.state().localRecordings:[];
  var plan=result.improvementPlan||{available:false,message:'План улучшения пока недоступен.'};
  var rows=result.taskResults.map(function(item){var local=recordings.filter(function(recording){return recording.taskType===item.taskType});return '<section class="speaking-full-result-row" aria-labelledby="spe_full_result_task_'+item.taskType+'">'
    +'<div class="speaking-full-result-row__summary"><h3 id="spe_full_result_task_'+item.taskType+'" class="speaking-subheading">'+SP_CONF[item.taskType].name+'</h3><span class="speaking-meta speaking-meta--strong">'+(item.earnedScore==null?'—':item.earnedScore)+' / '+item.maximumScore+' · '+ui.escapeHtml(item.recordingStatus)+' · '+Math.round(item.usedSeconds)+' сек.</span></div>'
    +(item.recordingQuality?'<p class="speaking-meta">Качество записи: '+ui.escapeHtml(item.recordingQuality)+'</p>':'')
    +(local.length?'<div class="speaking-row speaking-row--wrap speaking-full-playback-list">'+local.map(function(recording){return '<button type="button" class="sq speaking-media-action speaking-full-playback" onclick="speFullPlay('+recording.taskType+','+recording.responseNumber+')">Ответ '+recording.responseNumber+'</button>'}).join('')+'</div>':'')+'</section>'}).join('');
  var assessed=result.assessment&&result.assessment.status;var score=Number.isInteger(result.earnedScore)?'<p class="speaking-score">Примерный результат: '+result.earnedScore+' из 20</p>':'<p class="speaking-score speaking-score--pending">Примерная автоматическая оценка запускается отдельно</p>';
  var planMarkup=plan.available?'<div class="speaking-note speaking-note--success speaking-full-plan-result" role="status"><b>Общий план:</b><ul class="speaking-list">'+(plan.items||[]).map(function(item){return '<li>'+ui.escapeHtml(item)+'</li>'}).join('')+'</ul></div>':'<div class="speaking-note speaking-note--warning speaking-full-plan-result" role="status">'+ui.escapeHtml(plan.message||'План появится после примерной оценки.')+'</div>';
  var evaluationButton=spBtn('Получить примерную автоматическую оценку','speFullEvaluate(this)',true).replace(' data-speaking-action="evaluate"',' disabled aria-disabled="true" aria-busy="true" data-speaking-assessment-action="evaluate" data-assessment-ready="false" data-speaking-action="evaluate"');
  var assessmentAction=assessed?'':(SPE_RESTORED_WITHOUT_AUDIO?'<div id="spe_full_assessment_status" class="speaking-state speaking-full-assessment-status" data-state="warning" role="status" aria-live="polite"><b>Автоматическая оценка после перезагрузки недоступна.</b><span>Предыдущие локальные записи не сохранялись. Начни новый вариант, чтобы получить полный авторазбор.</span></div>':'<div id="spe_full_assessment_status" class="speaking-state speaking-full-assessment-status" data-state="processing" role="status" aria-live="polite" aria-busy="true"><b>Перед отправкой:</b><span>проверяем ожидаемое списание и остаток лимита. Записи обработает внешний сервис Azure Speech; обычный исходный звук не сохраняется.</span></div>'+evaluationButton);
  area.innerHTML='<section id="s9_card" class="clayCard speaking-sheet speaking-sheet--roomy speaking-stack speaking-full-result" aria-labelledby="spe_full_result_title">'
    +'<header class="speaking-stack speaking-stack--tight speaking-center"><span class="speaking-result-mark speaking-result-mark--complete" aria-hidden="true"></span><h2 id="spe_full_result_title" class="speaking-heading speaking-heading--result">Устная часть сдана</h2>'
    +score+'<p class="speaking-meta">'+(assessed?ui.escapeHtml(result.assessment.warning||'Результат тренировочный и примерный.'):'Локальное прослушивание доступно только до ухода с этой страницы.')+'</p></header>'
    +'<div class="speaking-full-results">'+rows+'</div>'+planMarkup+'</section><div class="speaking-action-stack">'+assessmentAction
    +spBtn('Новый вариант','speStart()',true).replace('<button','<button data-speaking-forward')+spBtn('К заданиям','initSpeaking()')+'</div>';setTxt('s9_today',Number.isInteger(result.earnedScore)?('примерно '+result.earnedScore+' из 20'):'сдано · максимум 20');spAnim('win','.32s');if(!assessed&&!SPE_RESTORED_WITHOUT_AUDIO)void speFullLoadAssessmentStatus(result)}
/* ---- фоновая ИИ-генерация комплектов говорения ---- */
var SPGEN=false;
async function spGen(){
  if(SPGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.spkAi=S.spkAi||{p1:[],p2:[],p3:[],p4:[]};
  var kind=null;
  for(var t=1;t<=4;t++){if(spPool(t).length<5){kind=t;break}}
  if(!kind)return;SPGEN=true;
  try{
    var d=await generateAiContent('speaking_task_'+kind);
    var item=speakingModule.normalizeGenerated(kind,d);
    if(item){S.spkAi['p'+kind]=(S.spkAi['p'+kind]||[]).concat([item]);save()}
  }catch(e){}
  SPGEN=false;
  try{var need=false;for(var t=1;t<=4;t++)if(spPool(t).length<5){need=true;break}
    if(need)setTimeout(spGen,4000)}catch(e){}}
/* уборка при уходе с экрана + синк */
registerRouteHook(function(id){
  if(id!=='scr9'){
    SP_VIEW_EPOCH++;
    var frame=document.getElementById('frame');if(frame)delete frame.dataset.speakingDockActive;
    if(SP){spStopAll();SP=null}spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();
    speFullDispose()}});
registerRouteHook(function(id){if(id==='scr9')initSpeaking()});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  SP,SPE,
  initSpeaking,spAccentFinishUnknown,spAccentSetup,spAccentStartUnknown,spCalibrationConsentSetup,spChooseAccent,spCompleteTask1,spCompleteTask2Question,spCompleteTask3Answer,spCompleteTask4,spContributeCalibration,spDeleteRecording,spEtalon,spEval,spExam,spFinish,spFlagTranscript,spMicCheck,spNextQ,spSaveCalibrationConsent,
  launchSpeakingTask,spHub,spNextSet,spOpen,spPlay,spPlayTask2Question,spPlayTask3Answer,spPrep,spRec,spRestartAdaptive,spSample,spStartTargetedPractice,spStopAll,spToggleSheet,spVoiceSample,
  speFullBeginStage,speFullComplete,speFullEvaluate,speFullMicCheck,speFullPlay,speFullRetryAssessmentStatus,speFullStartRecording,speFullStopRecording,speFullSubmit,speStart,
};
