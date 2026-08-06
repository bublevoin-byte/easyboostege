/*
 * Экран «Говорение» (scr9). Приезжает динамическим import() при первом переходе на него.
 * Озвучку и её остановку берём у общего проигрывателя оболочки — чанк аудирования для этого
 * загружать не нужно.
 */
import {registerRouteHook} from '../router.js';
import {lPlayRaw,lStop} from '../tts.js';
import {
  S,SRV,TOKEN,WBTN,apiGet,apiMessage,apiPost,apiPostBinary,generateAiContent,save,
  setTxt,spSt,spSync,speakingModule,toast,ui,wDeco,
} from '../app.js';
import {adaptiveRuntimeSnapshot,completeAdaptiveServerAttempt,openAdaptivePlan} from '../adaptive-session-runtime.js';
import {adaptiveSpeakingTask} from '../adaptive-speaking-tasks.js';
import {voiceTutorButton} from '../voice-tutor.js';
import {createSpeakingTask1BrowserFlow} from '../speaking-task1-runtime.js';
import {createSpeakingTask2BrowserFlow} from '../speaking-task2-runtime.js';
import {createSpeakingTask3BrowserFlow} from '../speaking-task3-runtime.js';
import {createSpeakingTask4BrowserFlow} from '../speaking-task4-runtime.js';
import {createSpeakingFullBrowserFlow} from '../speaking-full-runtime.js';
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
const ADAPTIVE_SP2=adaptiveSpeakingTask('builtin:speaking:task:2:v1').assignment;
const ADAPTIVE_SP4=adaptiveSpeakingTask('builtin:speaking:task:4:v1').assignment;
const SP2=[
{...ADAPTIVE_SP2,
 exq:['When does the course start?','How much does the course cost?','How many lessons a day are there?','Where will the students live?']},
{ad:'New Fitness Club «Energy» is open in your district! Modern gym, swimming pool and yoga classes for teenagers.',
 points:['opening hours','monthly fee','age requirements','personal trainer availability'],
 exq:['What are the opening hours?','How much is a monthly membership?','How old should I be to join the club?','Can I train with a personal trainer?']}];
const SP3=[
{topic:'Хобби и свободное время',qs:['What do you usually do in your free time?','Why do teenagers need hobbies?','What new hobby would you like to try and why?','Do you prefer spending free time alone or with friends? Why?','What can a hobby teach a person?']},
{topic:'Школьная жизнь',qs:['What is your favourite school subject and why?','How much time do you usually spend on homework?','What would you like to change in your school?','Why is it important to get a good education?','What are you going to do after leaving school?']}];
const SP4=[
{...ADAPTIVE_SP4},
{topic:'Еда дома и в кафе',ph:['Фото 1: мама с сыном вместе готовят ужин на кухне','Фото 2: друзья едят пиццу в кафе'],
 plan:['кратко опиши обе фотографии','скажи, что общего у фотографий','скажи, чем они различаются','скажи, что предпочитаешь ты, и объясни почему']}];
const SP_CONF={1:speakingModule.config(1),2:speakingModule.config(2),3:speakingModule.config(3),4:speakingModule.config(4)};
const SP_SHEET={
1:'<b>Как читать вслух на 1 балл:</b><br>— Во время подготовки прочитай текст про себя и отметь трудные слова.<br>— Читай по смысловым кусочкам, с паузами на запятых и точках.<br>— Не глотай окончания <i>-s</i> и <i>-ed</i>: he work<b>s</b>, play<b>ed</b>.<br>— Вопросы читай с восходящей интонацией, утверждения — с нисходящей.<br>— Лучше чуть медленнее, но чётко: ошибки в словах = потеря балла.',
2:'<b>Как задавать прямые вопросы:</b><br>Каждый пункт превращай в ПРЯМОЙ вопрос:<br>— цена → <i>How much does it cost?</i><br>— даты → <i>When does the course start?</i><br>— место → <i>Where is the club located?</i><br>— возможность → <i>Can I…? / Is it possible to…?</i><br><b>Ловушки:</b> «What about the price?» — НЕ вопрос, балл не дадут. Вопрос «зачитыванием пункта» (price?) — тоже. Нужен полный вопрос с вспомогательным глаголом.',
3:'<b>Как отвечать на вопросы интервью:</b><br>— Отвечай развёрнуто: 2-3 предложения, а не «Yes, I do».<br>— Формула: прямой ответ → причина → пример. <i>I usually read in my free time. It helps me to relax. For example, last week I finished a great detective story.</i><br>— Не молчи: если нужно время, начни с <i>Well, let me think…</i><br>— Следи за временем вопроса: «What did you do…» → отвечай в прошедшем.',
4:'<b>Скелет монолога (2,5–3 минуты):</b><br>1. Вступление: <i>I have found two photos for our project about…</i><br>2. Описание: <i>In the first photo we can see… In the second photo there is…</i><br>3. Общее: <i>Both photos show… / What these photos have in common is…</i><br>4. Различия: <i>The main difference is that… while…</i><br>5. Мнение: <i>As for me, I prefer… because…</i><br>6. Финал: <i>That is all I wanted to say.</i><br><b>Ловушка:</b> пропустил пункт плана — минус баллы за решение задачи.'};
let SP=null,SP_rec=null,SP_chunks=[],SP_tm=null,SP_sheet=false,SP_TASK1_FLOW=null,SP_TASK2_FLOW=null,SP_TASK3_FLOW=null,SP_TASK4_FLOW=null;
function spAnim(n,d){ui.animate('s9_card',n,d)}
function spMime(){return speakingModule.preferredMimeType(window.MediaRecorder)}
function spFmt(s){return speakingModule.formatTime(s)}
function spStopAll(){clearInterval(SP_tm);SP_tm=null;
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  try{lStop()}catch(e){}}
function spReleaseRecording(){if(SP&&SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}if(SP){SP.url=null;SP.blob=null}SP_chunks=[]}
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
function launchAdaptiveSpeakingLock(lock){var task=lock&&adaptiveSpeakingTask(lock.contentRef);return Boolean(task&&launchSpeakingTask(task.taskNumber,lock.contentRef))}
function initSpeaking(){if(!S)return;var lock=adaptiveSpeakingLock();spStopAll();spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP=null;spSync();if(lock&&launchAdaptiveSpeakingLock(lock))return;spHub()}
function spHub(){var area=document.getElementById('s9_area');if(!area)return;
  var lock=adaptiveSpeakingLock();if(lock&&launchAdaptiveSpeakingLock(lock))return;
  var r=spSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var exCard='<button type="button" class="sq clk" onclick="spExam()" style="'+ga()+'position:relative;overflow:hidden;width:100%;border:0;text-align:left;font:inherit;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · устная часть</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(S.speakingFullSessionId?'есть незавершённая сессия · максимум 20':'4 задания подряд · максимум 20 · оценка позже')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  area.innerHTML=exCard+[1,2,3,4].map(function(t){var c=SP_CONF[t];
    return '<button type="button" class="clayCard sq clk" onclick="spOpen('+t+')" style="'+ga()+'width:100%;border:0;text-align:left;font:inherit;padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">'+c.name+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">'+c.sub+'</div></div>'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;background:#FFEDE4;padding:8px 12px;border-radius:14px;">'+(r['t'+t].n||'—')+'</span></div></button>'}).join('')
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#FBE9EF;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#D4537E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Сначала подготовка по таймеру, потом запись — тайминги как на настоящем экзамене</div></div>';
  setTxt('s9_today','4 задания');spGen()}
function spPool(t){var ai=(S&&S.spkAi&&S.spkAi['p'+t])||[];return speakingModule.pool([SP1,SP2,SP3,SP4][t-1],ai)}
function spSet(t){var k='spIdx'+t;S[k]=(S[k]||0);return speakingModule.select(spPool(t),S[k])}
function spNextSet(t){if((SP&&SP.adaptiveContentRef)||adaptiveSpeakingLock()){try{toast('В персональном занятии закреплён точный вариант задания')}catch(_){}return false}S['spIdx'+t]=(S['spIdx'+t]||0)+1;save();return true}
async function spOpen(t){var lock=adaptiveSpeakingLock();if(lock)return launchAdaptiveSpeakingLock(lock);spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP_sheet=false;
  if(t===1){var area=document.getElementById('s9_area');if(area)area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает текст…</div>';
    SP_TASK1_FLOW=createSpeakingTask1BrowserFlow({api:{post:function(path,body){return apiPost(path,body)}}});
    try{var session=await SP_TASK1_FLOW.loadAssignment();var serverSet=speakingModule.serverTask1Set(session);if(!serverSet||!SP_TASK1_CATALOG_KEYS.has(serverSet.id+'@'+serverSet.revision))throw new Error('SPEAKING_TASK1_RESPONSE_INVALID');
      SP={t:1,set:serverSet,session:session,phase:'intro',qi:0,url:null,mic:null};spRender();return true}
    catch(error){spDisposeTask1Flow();SP=null;try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===2){var task2Area=document.getElementById('s9_area');if(task2Area)task2Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает объявление…</div>';
    SP_TASK2_FLOW=createSpeakingTask2BrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}}});
    try{var task2Session=null;
      if(S.speakingTask2SessionId){try{task2Session=await SP_TASK2_FLOW.restoreSession(S.speakingTask2SessionId)}catch(error){
        if(!task2RecoveryPointerInvalid(error))throw error;delete S.speakingTask2SessionId;save()}}
      if(!task2Session||task2Session.status==='completed')task2Session=await SP_TASK2_FLOW.loadAssignment();
      var serverTask2=speakingModule.serverTask2Set(task2Session);
      if(!serverTask2||!SP_TASK2_CATALOG_KEYS.has(serverTask2.id+'@'+serverTask2.revision))throw new Error('SPEAKING_TASK2_RESPONSE_INVALID');
      S.speakingTask2SessionId=task2Session.id;save();
      SP={t:2,set:serverTask2,session:task2Session,phase:task2Session.status==='assigned'?'intro':'question',qi:task2Session.currentQuestion-1,url:null,mic:null};spRender();return true}
    catch(error){spDisposeTask2Flow();SP=null;if(task2RecoveryPointerInvalid(error)){delete S.speakingTask2SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===3){var task3Area=document.getElementById('s9_area');if(task3Area)task3Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает интервью…</div>';
    SP_TASK3_FLOW=createSpeakingTask3BrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}}});
    try{var task3Session=null;
      if(S.speakingTask3SessionId){try{task3Session=await SP_TASK3_FLOW.restoreSession(S.speakingTask3SessionId)}catch(error){
        if(!task3RecoveryPointerInvalid(error))throw error;delete S.speakingTask3SessionId;save()}}
      if(!task3Session||task3Session.status==='completed')task3Session=await SP_TASK3_FLOW.loadAssignment();
      var serverTask3=speakingModule.serverTask3Set(task3Session);
      if(!serverTask3||!SP_TASK3_CATALOG_KEYS.has(serverTask3.id+'@'+serverTask3.revision))throw new Error('SPEAKING_TASK3_RESPONSE_INVALID');
      S.speakingTask3SessionId=task3Session.id;save();
      SP={t:3,set:serverTask3,session:task3Session,phase:task3Session.status==='assigned'?'intro':'question',qi:task3Session.currentQuestion-1,url:null,mic:null};spRender();return true}
    catch(error){spDisposeTask3Flow();SP=null;if(task3RecoveryPointerInvalid(error)){delete S.speakingTask3SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===4){var task4Area=document.getElementById('s9_area');if(task4Area)task4Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает фотопроект и загружает изображения…</div>';
    var task4Flow=createSpeakingTask4BrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}}});SP_TASK4_FLOW=task4Flow;
    try{var task4Session=null;
      if(S.speakingTask4SessionId){try{task4Session=await task4Flow.restoreSession(S.speakingTask4SessionId);if(SP_TASK4_FLOW!==task4Flow)return false}catch(error){
        if(!task4RecoveryPointerInvalid(error))throw error;delete S.speakingTask4SessionId;save()}}
      if(!task4Session||task4Session.status==='completed'){task4Session=await task4Flow.loadAssignment();if(SP_TASK4_FLOW!==task4Flow)return false}
      var serverTask4=speakingModule.serverTask4Set(task4Session);
      if(!serverTask4||!SPEAKING_TASK4_CATALOG.tasks.some(function(task){return task.id===serverTask4.id&&task.revision===serverTask4.revision}))throw new Error('SPEAKING_TASK4_RESPONSE_INVALID');
      await task4Flow.prepareAssets();if(SP_TASK4_FLOW!==task4Flow)return false;
      S.speakingTask4SessionId=task4Session.id;save();
      SP={t:4,set:serverTask4,session:task4Session,phase:'intro',qi:0,url:null,mic:null,assetReady:true};spRender();return true}
    catch(error){if(SP_TASK4_FLOW!==task4Flow)return false;spDisposeTask4Flow();SP=null;if(task4RecoveryPointerInvalid(error)){delete S.speakingTask4SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  SP={t:t,set:spSet(t),phase:'intro',qi:0,url:null};spRender();return true}
function launchSpeakingTask(taskNumber,contentRef){
  var task=adaptiveSpeakingTask(contentRef);if(!task||task.taskNumber!==taskNumber)return false;
  var set=taskNumber===2?{...task.assignment,exq:SP2[0].exq}:task.assignment;
  spReleaseRecording();SP={t:taskNumber,set:set,phase:'intro',qi:0,url:null,adaptiveContentRef:contentRef};SP_sheet=false;spRender();return true}
function spRestartAdaptive(){if(!SP||!SP.adaptiveContentRef||SP.evaluating)return false;var taskNumber=SP.t,contentRef=SP.adaptiveContentRef;spStopAll();return launchSpeakingTask(taskNumber,contentRef)}
function spBtn(label,fn,solid){return '<button type="button" class="sq" style="'+WBTN+(solid?'background:linear-gradient(135deg,#FFA570,#F2683F);color:#fff;border:none;box-shadow:0 12px 24px rgba(242,104,63,.32);':'color:#B54E2F;')+'" onclick="'+fn+'">'+label+'</button>'}
function spTimerChip(){return '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;">'
  +'<span id="s9_timer" style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;">'+spFmt(SP.left)+'</span></div>'
  +'<div style="margin-top:8px;height:7px;border-radius:5px;background:#F1EDE7;"><div id="s9_tbar" style="width:100%;height:100%;border-radius:5px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'}
function spTick(total,onEnd){clearInterval(SP_tm);
  SP_tm=setInterval(function(){if(!SP){clearInterval(SP_tm);return}
    SP.left--;setTxt('s9_timer',spFmt(SP.left));
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SP.left/total*100))+'%';
    setTxt('s9_today',spFmt(SP.left));
    if(SP.left<=0){clearInterval(SP_tm);onEnd()}},1000)}
/* Показ листа с подсказками: переменную модуля разметка присвоить не может. */
function spToggleSheet(){SP_sheet=!SP_sheet;spRender()}
function spRender(){var area=document.getElementById('s9_area');if(!area||!SP)return;
  var t=SP.t,c=SP_CONF[t],set=SP.set;
  if(officialTask2Active()&&SP.phase==='question'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 4</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;margin-top:10px;">Продолжить с вопроса '+(SP.qi+1)+' из 4</div>'
      +spTaskBody()
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов':'Сигнал тихий · подвинь микрофон ближе'):'После восстановления снова проверь микрофон')+'</div></div>'
      +spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>'
      +spBtn('Записать вопрос '+(SP.qi+1),'spRec()',true)+'<div style="height:10px;"></div>'+spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Запись вопроса '+(SP.qi+1)+' готова</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только безопасные метаданные.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать вопрос '+(SP.qi+1),'spPlayTask2Question('+(SP.qi+1)+')',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Как получился прямой вопрос?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать вопрос','spRec()');
    spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">4 отдельные записи завершены</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Сервер сохранил только длительность, локальное прослушивание и самооценку каждой позиции. Автоматическая оценка появится после подключения и методической проверки в следующих этапах.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(2)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='question'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 5</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;margin-top:10px;">Продолжить с вопроса '+(SP.qi+1)+' из 5</div>'
      +'<div lang="en" style="font-weight:600;font-size:12px;color:#777163;line-height:1.5;margin-top:8px;">'+ui.escapeHtml(SP.set.instruction)+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:9px;">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов':'Сигнал тихий · подвинь микрофон ближе'):'После восстановления снова проверь микрофон')+'</div></div>'
      +spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>'
      +spBtn('Записать ответ '+(SP.qi+1),'spRec()',true)+'<div style="height:10px;"></div>'+spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_prompt'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#317485;background:#E3F1F5;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 5</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:10px;">Сначала прозвучит вопрос</div>'
      +'<div lang="en" style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:9px;">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:8px;">Запись и 40-секундный таймер начнутся после окончания вопроса.</div></div>';
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Ответ '+(SP.qi+1)+' записан</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только безопасные метаданные.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать ответ '+(SP.qi+1),'spPlayTask3Answer('+(SP.qi+1)+')',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Получился полный ответ из 2–3 предложений?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать ответ','spRec()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">5 отдельных записей завершены</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Сервер сохранил только длительность, локальное прослушивание и самооценку каждого ответа. Автоматическая оценка появится после подключения и методической проверки в следующих этапах.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(3)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Монолог записан</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только длительность, проверка микрофона, факт локального прослушивания и самооценка.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать монолог','spPlay()',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Получилось раскрыть все четыре пункта плана?</div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать монолог','spRec()');
    spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Тренировка задания 4 завершена</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Запись осталась только в браузере. Автоматическая оценка появится после подключения и методической проверки следующих этапов.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(4)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  /* ---- интро ---- */
  if(SP.phase==='intro'){
    var body='';
    if(t===1)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Прочитай назначенный сервером текст вслух. Подготовка — '+spFmt(c.prep)+', чтение — до '+spFmt(c.rec)+'.</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>';
    if(t===2)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Изучи назначенное сервером объявление и задай <b>4 прямых вопроса</b> по пунктам. Подготовка — '+spFmt(c.prep)+', на каждый вопрос — 20 секунд.</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>';
    if(t===3)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Интервью на тему «'+ui.escapeHtml(set.topic)+'». Услышишь 5 вопросов — на каждый отвечай 2–3 предложениями, до 40 секунд. Подготовки нет, как на экзамене.</div>'
      +(officialTask3Active()?'<div lang="en" style="margin-top:10px;padding:11px 13px;border-radius:13px;background:#FAF6F1;font-weight:700;font-size:12.5px;color:#4A453E;line-height:1.55;">'+ui.escapeHtml(set.instruction)+'</div>':'')
      +(officialTask3Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
        +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед первым вопросом проверь разрешение и уровень микрофона')+'</div>':'');
    if(t===4)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Подготовь проектное высказывание по двум фотографиям и четырём пунктам плана. Подготовка — '+spFmt(c.prep)+', монолог — до '+spFmt(c.rec)+'.</div>'
      +(officialTask4Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:#EAF7F0;color:#1D7F4A;font-weight:700;font-size:12px;">Фотопара полностью загружена и декодирована до запуска таймера.</div>':'')
      +(officialTask4Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
        +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>':'');
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+c.sub.toUpperCase()+'</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:10px;">'+c.name+'</div>'
      +'<div style="margin-top:8px;">'+body+'</div>'
      +(officialTask4Active()?spTaskBody():'')
      +'<div style="margin-top:11px;display:flex;gap:8px;">'
      +(SP.adaptiveContentRef||officialTask4Active()?'':'<button type="button" class="clk sq iconbtn" onclick="'+(t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)')+'" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Другой вариант</button>')
      +(officialTask3Active()||officialTask4Active()?'':'<button type="button" class="clk sq iconbtn" onclick="spToggleSheet()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(SP_sheet?'Скрыть шпаргалку':'Шпаргалка')+'</button>')+'</div>'
      +(SP_sheet&&!officialTask3Active()&&!officialTask4Active()?'<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.65;">'+SP_SHEET[t]+'</div>':'')
      +'</div>'
      +((t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())?spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>':'')
      +spBtn(c.prep?'Начать подготовку':'Начать интервью','spPrep()',true)
      +'<div style="height:10px;"></div>'
      +spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');setTxt('s9_today',c.name);return}
  /* ---- подготовка ---- */
  if(SP.phase==='prep'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ПОДГОТОВКА</span>'
      +spTaskBody()
      +spTimerChip()+'</div>'
      +spBtn('Готово — к записи','spRec()',true)
      +'<div style="height:10px;"></div>'
      +spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  /* ---- запись ---- */
  if(SP.phase==='rec'){
    var head=SP.t===3
      ?'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+(SP.qi+1)+' из 5</div>'
       +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+SP.set.qs[SP.qi]+'</div>'
       +(officialTask3Active()?'':'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Озвучить вопрос</button></div>')
      :spTaskBody();
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">● ИДЁТ ЗАПИСЬ</span>'
      +head+spTimerChip()+'</div>'
      +(SP.t===3&&SP.qi<4?spBtn('Следующий вопрос →','spNextQ()',true)+'<div style="height:10px;"></div>':'')
      +spBtn(SP.t===3&&SP.qi>=4?'Завершить интервью':'Стоп — закончить запись','spFinish()',SP.t===3)
      ;
    return}
  /* ---- результат ---- */
  if(SP.phase==='done'){var r=spSt();
    var extra='';
    if(t===1)extra='<div class="clayCard" role="status" aria-live="polite" style="padding:14px 16px;margin-top:12px;background:#FFF4DE;color:#6E5422;font-weight:700;font-size:12.5px;line-height:1.55;">Оценка произношения пока не подключена. Здесь нет фонетического балла: запись остаётся в браузере, а сервер получает только метаданные тренировки.</div>'
      +'<div style="height:10px;"></div>'+spBtn('🔊 Эталон диктора','spEtalon()');
    if(t===2)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ОБРАЗЦЫ ВОПРОСОВ</div>'
      +set.points.map(function(p,i){return '<div style="margin-top:8px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;"><b>'+(i+1)+'. '+p+':</b><br><i>'+set.exq[i]+'</i></div>'}).join('')+'</div>';
    if(t===4)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ПРОВЕРЬ СЕБЯ</div>'
      +set.plan.map(function(p,i){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'?</div>'}).join('')+'</div>';
    if(t===3)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ВОПРОСЫ ИНТЕРВЬЮ</div>'
      +set.qs.map(function(q,i){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+q+'</div>'}).join('')+'</div>';
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">🎙️</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Запись готова!</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай себя со стороны и сверься со шпаргалкой.<br>Тренировок в этом задании: '+r['t'+t].n+'</div></div>'
      +'<div style="height:12px;"></div>'
      +(SP.url?spBtn('▶ Послушать свою запись','spPlay()',true):'<div style="text-align:center;font-weight:600;font-size:12.5px;color:#A83226;">Запись не получилась — проверь доступ к микрофону</div>')
      +(SP.blob&&t>1?'<div style="height:10px;"></div><button type="button" class="sq" onclick="spEval(this)" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#6FC2B0,#1F9E5A)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(31,158,90,.3);">✨ Оценить с ИИ по критериям</button>':'')
      +(SP.blob?'<div style="height:10px;"></div>'+spBtn('Удалить запись','spDeleteRecording()'):'')
      +(SP.blob&&t===1&&!SP.task1Completed?'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Как ощущалось чтение?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Нужно повторить</button>'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>':'')
      +(t===1&&SP.task1Completed?'<div role="status" aria-live="polite" style="margin-top:12px;padding:10px 12px;border-radius:13px;background:#EAF7F0;color:#1D7F4A;font-weight:800;font-size:12px;">Безопасная история тренировки сохранена.</div>':'')
      +(SP.t>1?'<div style="height:10px;"></div>'+spBtn('Образец ответа от ИИ','spSample(this)'):'')
      +'<div id="sp_evalbox"></div>'
      +extra
      +(SP.adaptiveContentRef
        ?'<div style="height:10px;"></div><div style="text-align:center;font-weight:700;font-size:12.5px;color:#777163;line-height:1.5;">В персональном занятии закреплено это задание. Оцени ответ или перезапиши тот же вариант.</div><div style="height:10px;"></div><button id="adaptive_speaking_retry" class="sq" style="'+WBTN+'" onclick="spRestartAdaptive()">Записать этот вариант ещё раз</button>'
        :'<div style="height:10px;"></div>'+spBtn('Ещё раз',t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)')
          +'<div style="height:10px;"></div>'+spBtn('К заданиям','spStopAll();initSpeaking()'));
    spAnim('win','.32s');setTxt('s9_today',SP_CONF[t].name);return}}
function spTaskBody(){var t=SP.t,set=SP.set;
  if(t===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+ui.escapeHtml(set.tx)+'</div>';
  if(t===2)return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+ui.escapeHtml(set.ad)+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:'+(officialTask2Active()&&i===SP.qi?'#A83226':'#C2421B')+';">'+(i+1)+'. '+ui.escapeHtml(p)+'</div>'}).join('');
  if(t===4&&officialTask4Active()){var photoAsset=task4PhotoAsset(set.photoPair.src);return '<div lang="en" style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">'+ui.escapeHtml(set.projectTitle)+'</div>'
    +'<figure style="margin:12px 0 0;max-width:920px;">'
    +'<img loading="lazy" decoding="async" src="'+ui.escapeHtml(set.photoPair.src)+'" alt="'+ui.escapeHtml(set.photoPair.alt)+'" width="'+(photoAsset?photoAsset.width:1536)+'" height="'+(photoAsset?photoAsset.height:1024)+'" style="display:block;width:100%;height:auto;border-radius:16px;background:#F4EFE9;">'
    +'<figcaption style="margin-top:7px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">Две оригинальные фотографии для сравнения: слева и справа.</figcaption></figure>'
    +'<div lang="en" style="margin-top:10px;font-weight:600;font-size:12px;color:#777163;line-height:1.5;">'+ui.escapeHtml(set.instruction)+'</div>'
    +'<div style="margin-top:9px;font-weight:700;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div lang="en" style="margin-top:5px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">'+(i+1)+'. '+ui.escapeHtml(p)+'</div>'}).join('')}
  if(t===4)return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('');
  return ''}
async function spMicCheck(btn){if(!SP||!((SP.t===1&&SP_TASK1_FLOW)||officialTask2Active()||officialTask3Active()||officialTask4Active()))return false;if(btn)btn.disabled=true;
  try{SP.mic=await (SP.t===1?SP_TASK1_FLOW:(officialTask2Active()?SP_TASK2_FLOW:(officialTask3Active()?SP_TASK3_FLOW:SP_TASK4_FLOW))).checkMicrophone();spRender();return true}
  catch(error){SP.mic=null;try{toast(error&&error.code==='MICROPHONE_PERMISSION_DENIED'?'Нет доступа к микрофону. Разреши его в настройках браузера.':'Микрофон не готов. Проверь подключение и попробуй снова.')}catch(_){}spRender();return false}}
function spPrep(){var c=SP_CONF[SP.t];
  if((SP.t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())&&!SP.mic){try{toast('Сначала проверь микрофон — официальный таймер ещё не запущен.')}catch(_){}return}
  if(officialTask4Active()&&!SP.assetReady){try{toast('Дождись полной загрузки фотопары — таймер ещё не запущен.')}catch(_){}return}
  if(!c.prep)return spRec();
  SP.phase='prep';SP.left=c.prep;spRender();
  spTick(c.prep,function(){spRec()})}
async function spRec(){var c=SP_CONF[SP.t];
  clearInterval(SP_tm);
  spReleaseRecording();
  if(SP.t===1&&SP_TASK1_FLOW){try{await SP_TASK1_FLOW.startRecording();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return}
    catch(error){SP.phase='intro';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись. Проверь разрешение на микрофон.')}catch(_){}return}}
  if(officialTask2Active()){try{await SP_TASK2_FLOW.startQuestion();SP.phase='rec';SP.qi=SP.session.currentQuestion-1;SP.left=c.per;spRender();spTick(c.per,function(){spFinish()});return}
    catch(error){SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись вопроса.')}catch(_){}return}}
  if(officialTask3Active()){var task3SessionId=SP.session.id;SP.qi=SP.session.currentQuestion-1;var task3Question=SP.set.qs[SP.qi];SP.phase='task3_prompt';spRender();
    try{await Promise.resolve(lPlayRaw([{s:1,t:task3Question}]))}catch(_){}
    if(!SP||!SP_TASK3_FLOW||SP.session.id!==task3SessionId||SP.session.currentQuestion-1!==SP.qi)return false;
    try{await SP_TASK3_FLOW.startAnswer();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись ответа.')}catch(_){}return}}
  if(officialTask4Active()){try{await SP_TASK4_FLOW.startRecording();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){SP.phase='intro';spRender();try{toast(error&&error.code==='SPEAKING_TASK4_ASSET_NOT_READY'?'Дождись полной загрузки фотопары.':(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись монолога.'))}catch(_){}return false}}
  try{
    var st=await navigator.mediaDevices.getUserMedia({audio:true});
    var mime=spMime();
    SP_rec=mime?new MediaRecorder(st,{mimeType:mime}):new MediaRecorder(st);SP_chunks=[];
    SP_rec.ondataavailable=function(e){SP_chunks.push(e.data)};
    SP_rec.onstop=function(){var tp=SP_rec.mimeType||(SP_chunks[0]&&SP_chunks[0].type)||'';
      var bl=tp?new Blob(SP_chunks,{type:tp}):new Blob(SP_chunks);SP.blob=bl;SP.url=URL.createObjectURL(bl);st.getTracks().forEach(function(x){x.stop()});
      if(SP.phase==='done')spRender()};
    SP_rec.start();
  }catch(e){SP.url=null;SP.phase='intro';spRender();try{toast('Нет доступа к микрофону. Разреши доступ в настройках браузера и попробуй снова.')}catch(_){}return}
  SP.phase='rec';SP.left=c.rec;SP.qi=0;spRender();
  if(SP.t===3){try{lPlayRaw([{s:1,t:SP.set.qs[0]}])}catch(e){}}
  spTick(c.rec,function(){SP.t===3?spNextQ():spFinish()})}
function spNextQ(){if(!SP)return;
  if(SP.qi>=4){spFinish();return}
  SP.qi++;SP.left=SP_CONF[3].rec;spRender();
  try{lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])}catch(e){}
  spTick(SP_CONF[3].rec,function(){SP.qi>=4?spFinish():spNextQ()})}
async function spFinish(){if(!SP)return;clearInterval(SP_tm);try{lStop()}catch(e){}
  if(officialTask2Active()){try{var task2Recording=await SP_TASK2_FLOW.stopQuestion();SP.blob=task2Recording.blob;SP.url=task2Recording.url;SP.phase='task2_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return}
  if(officialTask3Active()){try{var task3Recording=await SP_TASK3_FLOW.stopAnswer();SP.blob=task3Recording.blob;SP.url=task3Recording.url;SP.phase='task3_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return}
  if(officialTask4Active()){try{var task4Recording=await SP_TASK4_FLOW.stopRecording();SP.blob=task4Recording.blob;SP.url=task4Recording.url;SP.phase='task4_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase='intro'}spRender();return}
  var r=spSt();r['t'+SP.t].n++;if(!SP.adaptiveContentRef)spNextSet(SP.t);
  SP.phase='done';
  if(SP.t===1&&SP_TASK1_FLOW){try{var localRecording=await SP_TASK1_FLOW.stopRecording();SP.blob=localRecording.blob;SP.url=localRecording.url}
    catch(error){SP.blob=null;SP.url=null}spSync();save();spRender();return}
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  spSync();save();spRender()}
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
async function spCompleteTask1(selfRating,btn){if(!SP||SP.t!==1||!SP_TASK1_FLOW||SP.task1Completed)return false;if(btn)btn.disabled=true;
  try{SP.completedSession=await SP_TASK1_FLOW.complete(selfRating);SP.task1Completed=true;spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spPlayTask2Question(questionNumber){if(!SP||SP.t!==2||!SP_TASK2_FLOW)return false;
  try{await SP_TASK2_FLOW.playQuestion(questionNumber);return true}catch(error){try{toast('Локальная запись этого вопроса недоступна.')}catch(_){}return false}}
async function spCompleteTask2Question(selfRating,btn){if(!SP||SP.t!==2||!SP_TASK2_FLOW||SP.task2Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK2_FLOW.completeQuestion(selfRating);SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task2Completed=true;SP.phase='task2_complete';delete S.speakingTask2SessionId;var r=spSt();r.t2.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spPlayTask3Answer(questionNumber){if(!SP||SP.t!==3||!SP_TASK3_FLOW)return false;
  try{await SP_TASK3_FLOW.playAnswer(questionNumber);return true}catch(error){try{toast('Локальная запись этого ответа недоступна.')}catch(_){}return false}}
async function spCompleteTask3Answer(selfRating,btn){if(!SP||SP.t!==3||!SP_TASK3_FLOW||SP.task3Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK3_FLOW.completeAnswer(selfRating);SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task3Completed=true;SP.phase='task3_complete';delete S.speakingTask3SessionId;var r=spSt();r.t3.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spCompleteTask4(selfRating,btn){if(!SP||SP.t!==4||!SP_TASK4_FLOW||SP.task4Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK4_FLOW.complete(selfRating);SP.task4Completed=true;SP.phase='task4_complete';
    delete S.speakingTask4SessionId;var r=spSt();r.t4.n++;spSync();save();spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function spEtalon(){if(!SP||SP.t!==1)return;
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  var parts=speakingModule.sentences(SP.set.tx).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 2: расшифровка и оценка ИИ ---- */
async function spSTT(blob){
  var j=await apiPostBinary('/api/v1/stt',blob,blob.type||'application/octet-stream');
  return j.text||''}
function spAssignment(t,set){return speakingModule.assignment(t,set)}
async function spEval(btn){
  if(!SP||!SP.blob)return;
  if(officialTask2Active()||officialTask3Active()||officialTask4Active())return;
  var adaptiveRetry=document.getElementById('adaptive_speaking_retry');SP.evaluating=true;if(adaptiveRetry)adaptiveRetry.disabled=true;
  if(btn){if(btn.dataset.busy)return;btn.dataset.busy=1;btn.textContent='Расшифровываю запись…';btn.style.pointerEvents='none'}
  try{
    var tr=await spSTT(SP.blob);
    if(!speakingModule.isTranscriptUsable(tr))throw new Error('речь не распознана — говори громче и ближе к микрофону');
    if(btn)btn.textContent='Оцениваю по критериям…';
    var response=await apiPost('/api/v1/ai/evaluate-speaking',{taskType:SP.t,transcript:tr,assignment:spAssignment(SP.t,SP.set)},true);
    var d=response.review;
    if(!d||typeof d.got==='undefined')throw new Error('ИИ вернул неожиданный ответ, попробуй ещё раз');
    var score=speakingModule.clampScore(d,SP.t);d.got=score.got;d.max=score.max;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:SP.t,g:d.got,m:d.max,ts:Date.now()});
    spSync();save();
    if(btn){btn.style.display='none'}
    spShowEval(d,tr,response.voiceTutor);
    completeAdaptiveServerAttempt('speaking',response.attemptId).then(function(result){if(result)showAdaptiveSpeakingReturn()}).catch(function(error){
      try{toast('Оценка сохранена, но план пока не обновлён: '+apiMessage(error,'request'))}catch(_){}});
  }catch(e){
    if(SP)SP.evaluating=false;if(adaptiveRetry)adaptiveRetry.disabled=false;
    if(btn){btn.textContent='✨ Оценить с ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'stt'))}catch(_){}}}
function spShowEval(d,tr,voiceTutor){var box=document.getElementById('sp_evalbox');if(!box)return;
  /* всё, что пришло от модели или STT, попадает в DOM только экранированным */
  var safe=ui.escapeHtml;
  var pct=d.got/(d.max||1);
  var col=pct>=0.7?'#1F8A50':(pct>=0.4?'#C77400':'#C0392B');
  var h='<div class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-top:12px;animation:wflip .5s cubic-bezier(.25,.75,.35,1) both;">'
    +'<div style="text-align:center;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:30px;color:'+col+';">'+d.got+' из '+d.max+'</div>'
    +(speakingModule.isExperimentalTask(SP.t)?'<div class="ai-disclaimer" style="margin-top:6px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">'+ui.escapeHtml(ui.AI_DISCLAIMER)+'</div>':'')
    +'<div style="font-weight:700;font-size:13.5px;color:#2B2B2B;margin-top:4px;">'+safe(d.verdict||'')+'</div></div>';
  if(Array.isArray(d.criteria)&&d.criteria.length)
    h+='<div style="margin-top:12px;">'+d.criteria.map(function(c){
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #F4EFE9;font-weight:600;font-size:12.5px;color:#4A453E;"><span>'+safe(c.name)+'</span><b style="flex:none;color:'+((+c.got||0)>=(+c.max||1)?'#1F8A50':'#C77400')+';">'+safe(c.got)+' / '+safe(c.max)+'</b></div>'}).join('')+'</div>';
  if(Array.isArray(d.good)&&d.good.length)
    h+='<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ЧТО ПОЛУЧИЛОСЬ</div>'
      +d.good.map(function(g){return '<div style="margin-top:5px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">• '+safe(g)+'</div>'}).join('')+'</div>';
  if(Array.isArray(d.fix)&&d.fix.length)
    h+='<div style="margin-top:10px;background:#FDF3EC;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#C2421B;">НАД ЧЕМ ПОРАБОТАТЬ</div>'
      +d.fix.map(function(f){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">'
        +(f.wrong?'<s style="color:#A83226;">'+safe(f.wrong)+'</s> → ':'')+(f.right?'<b style="color:#1D7F4A;">'+safe(f.right)+'</b><br>':'')+safe(f.note||'')+'</div>'}).join('')+'</div>';
  h+='<div style="margin-top:10px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">ИИ проверил текст ответа. Произношение, интонация, паузы и беглость не оценивались.</div>';
  h+='<details style="margin-top:12px;"><summary style="font-weight:700;font-size:12px;color:#777163;cursor:pointer;">Расшифровка твоей речи</summary>'
    +'<div style="margin-top:8px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">'+safe(tr)+'</div><button class="sq" onclick="spFlagTranscript()" style="margin-top:8px;border:0;background:#F4EFE9;padding:7px 10px;border-radius:10px;font-weight:700;font-size:11px;">Расшифровка неточная</button></details>'
    +(voiceTutor&&d.got<d.max?voiceTutorButton(voiceTutor):'')
    +'</div>';
  box.innerHTML=h;
  try{box.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}}
function showAdaptiveSpeakingReturn(){var box=document.getElementById('sp_evalbox');if(!box||document.getElementById('adaptive_speaking_return'))return;var retry=document.getElementById('adaptive_speaking_retry');if(retry)retry.style.display='none';var button=document.createElement('button');button.id='adaptive_speaking_return';button.type='button';button.className='sq';button.textContent='Вернуться к персональному плану';button.setAttribute('style','width:100%;margin-top:12px;border:0;border-radius:14px;padding:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;cursor:pointer;');button.addEventListener('click',openAdaptivePlan);box.appendChild(button)}
function spFlagTranscript(){S.sttFeedback=(S.sttFeedback||0)+1;save();try{toast('Спасибо, отметка сохранена')}catch(e){}}
async function spSample(btn){
  if(!SP)return;var t=SP.t,set=SP.set;
  if(officialTask2Active()||officialTask3Active()||officialTask4Active())return;
  if(btn){if(btn.dataset.busy)return;btn.dataset.busy=1;btn.textContent='Готовлю образец…';btn.style.pointerEvents='none'}
  try{
    var response=await apiPost('/api/v1/ai/generate-speaking-sample',{taskType:t,assignment:spAssignment(t,set)},true);
    var d=response.data;if(!d||!d.text)throw new Error('не получилось');
    SP.sample=String(d.text);
    var box=document.getElementById('sp_evalbox');
    if(box)box.insertAdjacentHTML('afterbegin','<div class="clayCard" style="padding:16px;margin-top:12px;animation:win .35s both;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
      +'<span style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ОБРАЗЕЦ ОТ ИИ</span>'
      +'<button type="button" class="clk sq iconbtn" onclick="spVoiceSample()" style="display:inline-flex;align-items:center;gap:6px;background:#E3F1F5;border-radius:12px;padding:7px 12px;font-weight:800;font-size:11px;color:#317485;cursor:pointer;">🔊 Озвучить</button></div>'
      +'<div style="margin-top:9px;font-weight:500;font-size:13px;color:#2B2B2B;line-height:1.65;">'+ui.escapeHtml(SP.sample)+'</div></div>');
    if(btn){btn.style.display='none'}
  }catch(e){
    if(btn){btn.textContent='Образец ответа от ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'ai'))}catch(_){}}}
function spVoiceSample(){if(!SP||!SP.sample)return;
  var parts=speakingModule.sentences(SP.sample).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 3: экзамен устной части целиком ---- */
let SPE=null,SPE_FLOW=null,SPE_TM=null,SPE_STARTING=false,SPE_PROMPT_SEQUENCE=0;
function speFullDispose(){clearInterval(SPE_TM);SPE_TM=null;SPE_STARTING=false;SPE_PROMPT_SEQUENCE++;try{lStop()}catch(_){}if(SPE_FLOW){SPE_FLOW.dispose();SPE_FLOW=null}SPE=null}
function speFullPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_FULL_CATALOG_REVISION_MISMATCH'}
function spExam(){var area=document.getElementById('s9_area');if(!area)return;spStopAll();SP=null;
  var lock=adaptiveSpeakingLock();if(lock){launchAdaptiveSpeakingLock(lock);return}
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Устная часть целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Чтение → 4 прямых вопроса → 5 ответов интервью → монолог. Сервер закрепляет один вариант и ведёт по официальным таймерам. Аудио остаётся только на этом устройстве.</div>'
    +'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Максимум: 20 баллов · Оценка пока недоступна</div>'
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn(S.speakingFullSessionId?'Продолжить экзамен':'Начать экзамен','speStart()',true)
    +spBtn('← К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s')}
async function speStart(){return speFullStart()}
async function speFullStart(){var area=document.getElementById('s9_area');if(!area)return false;speFullDispose();
  area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер закрепляет полный вариант…</div>';
  SPE_FLOW=createSpeakingFullBrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}}});
  try{var session=null;
    if(S.speakingFullSessionId){try{session=await SPE_FLOW.restoreSession(S.speakingFullSessionId)}catch(error){
      if(!speFullPointerInvalid(error))throw error;delete S.speakingFullSessionId;save()}}
    if(!session||session.status==='submitted')session=await SPE_FLOW.loadAssignment();
    S.speakingFullSessionId=session.id;save();SPE=SPE_FLOW.state();
    if(session.task&&session.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    SPE=SPE_FLOW.state();speRender();return true
  }catch(error){speFullDispose();try{toast(apiMessage(error,'request'))}catch(_){}spExam();return false}}
async function speFullMicCheck(btn){if(!SPE_FLOW)return false;if(btn)btn.disabled=true;try{await SPE_FLOW.checkMicrophone();SPE=SPE_FLOW.state();speRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}SPE=SPE_FLOW.state();speRender();return false}}
async function speFullBeginStage(){if(!SPE_FLOW)return false;var current=SPE_FLOW.state().session;
  if(current.task.taskType===3&&current.phase==='ready')return speFullStartRecording();
  try{await SPE_FLOW.beginStage();SPE=SPE_FLOW.state();
    if(SPE.session.phase==='recording')return speFullStartRecording();speRender();return true}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullStartRecording(){if(!SPE_FLOW||SPE_STARTING)return false;SPE_STARTING=true;try{
    var promptSequence=++SPE_PROMPT_SEQUENCE,before=SPE_FLOW.state(),beforeSession=before.session;
    var beforePosition=beforeSession.current?{taskType:beforeSession.current.taskType,responseNumber:beforeSession.current.responseNumber,phase:beforeSession.phase}:null;
    if(beforeSession.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    if(beforeSession.task.taskType===3&&beforeSession.phase!=='recording'){
      var question=beforeSession.task.questions[beforeSession.current.responseNumber-1];
      try{await Promise.resolve(lPlayRaw([{s:1,t:question}]))}catch(_){}
      if(!SPE_FLOW||promptSequence!==SPE_PROMPT_SEQUENCE)return false;var afterPrompt=SPE_FLOW.state().session;
      if(afterPrompt.id!==beforeSession.id||afterPrompt.phase!==beforePosition.phase
        ||afterPrompt.current.taskType!==beforePosition.taskType
        ||afterPrompt.current.responseNumber!==beforePosition.responseNumber)return false}
    await SPE_FLOW.startRecording();SPE=SPE_FLOW.state();
    speRender();return true
  }catch(error){SPE=SPE_FLOW?SPE_FLOW.state():null;try{toast(apiMessage(error,'request'))}catch(_){}if(SPE)speRender();return false}
  finally{SPE_STARTING=false}}
async function speFullStopRecording(){if(!SPE_FLOW)return false;try{await SPE_FLOW.stopRecording();SPE=SPE_FLOW.state();speRender();return true}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullComplete(status,issue){if(!SPE_FLOW)return false;try{
    SPE_PROMPT_SEQUENCE++;try{lStop()}catch(_){}
    while(['ready','preparing'].includes(SPE_FLOW.state().session.phase))await SPE_FLOW.beginStage();
    await SPE_FLOW.completeResponse(status,issue||null);SPE=SPE_FLOW.state();
    if(SPE.session.task&&SPE.session.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    SPE=SPE_FLOW.state();speRender();return true
  }catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullTimeout(){if(!SPE_FLOW||!SPE)return;var state=SPE_FLOW.state();
  if(state.session.phase==='preparing'){await speFullStartRecording();return}
  if(state.session.phase==='recording'){
    if(state.isRecording)await SPE_FLOW.stopRecording();
    state=SPE_FLOW.state();await speFullComplete(state.recording?'completed':'technical_issue',state.recording?null:'recording_failed')}}
function speFullArmTimer(){clearInterval(SPE_TM);SPE_TM=null;if(!SPE||!SPE.session.current||!SPE.session.current.stageDeadlineAt)return;
  var update=function(){if(!SPE_FLOW)return;var current=SPE_FLOW.state().session.current;if(!current||!current.stageDeadlineAt)return;
    var left=Math.max(0,Math.ceil((new Date(current.stageDeadlineAt).getTime()-Date.now())/1000));setTxt('s9_timer',spFmt(left));
    setTxt('s9_today','задание '+current.taskType+' · ответ '+current.responseNumber+' · '+spFmt(left));
    if(left<=0){clearInterval(SPE_TM);SPE_TM=null;void speFullTimeout()}};
  update();if(SPE_TM===null)SPE_TM=setInterval(update,1000)}
function speTaskBody(){var task=SPE.session.task,pos=SPE.session.current,safe=ui.escapeHtml;if(!task||!pos)return '';
  if(task.taskType===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+safe(task.text)+'</div>';
  if(task.taskType===2){var preparing=SPE.session.phase==='preparing';var supportBody=preparing
    ?task.supports.map(function(support,index){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(index+1)+'. '+safe(support)+'</div>'}).join('')
    :'<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+safe(task.supports[pos.responseNumber-1])+'</div>';
    return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+safe(task.advertisement)+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">'+(preparing?'Подготовь четыре прямых вопроса:':'Задай прямой вопрос о пункте '+pos.responseNumber+':')+'</div>'+supportBody}
  if(task.taskType===3){if(SPE.session.phase==='ready')return '<div role="status" style="margin-top:10px;padding:12px;border-radius:14px;background:#E3F1F5;color:#317485;font-weight:700;font-size:13px;line-height:1.5;">Вопрос прозвучит после запуска. Отдельного времени на подготовку нет; затем начнутся запись и 40 секунд ответа.</div>';
    var question=task.questions[pos.responseNumber-1];return '<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+pos.responseNumber+' из 5</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+safe(question)+'</div>'
    }
  return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Проект: '+safe(task.projectTitle)+'</div>'
    +'<img src="'+safe(task.photoPair.src)+'" alt="'+safe(task.photoPair.alt)+'" style="display:block;width:100%;height:auto;margin-top:10px;border-radius:16px;">'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +task.plan.map(function(point,index){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(index+1)+'. '+safe(point)+'</div>'}).join('')}
function speFullProgress(){return SPE.session.progress.map(function(item){return '<span style="font-weight:800;font-size:11px;color:'+(item.completedResponses===item.responseCount?'#1D7F4A':'#777163')+';background:'+(item.completedResponses===item.responseCount?'#EAF7F0':'#F4EFE9')+';padding:6px 9px;border-radius:12px;">'+item.taskType+': '+item.completedResponses+'/'+item.responseCount+'</span>'}).join('')}
function speFullControls(){var state=SPE,session=state.session,phase=session.phase;
  if(phase==='ready_to_submit')return spBtn('Сдать устную часть','speFullSubmit()',true);
  var mic='<button type="button" class="sq" onclick="speFullMicCheck(this)" style="'+WBTN+'min-height:44px;color:#317485;">'+(state.micCheck==='passed'?'✓ Микрофон готов':'Проверить микрофон')+'</button>';
  var skip='<div style="height:10px;"></div>'+spBtn('Пропустить ответ','speFullComplete(\'skipped\')');
  if(phase==='ready')return mic+'<div style="height:10px;"></div>'+spBtn(session.task.preparationSeconds&&session.current.responseNumber===1?'Начать подготовку':'Начать запись','speFullBeginStage()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Не могу записать','speFullComplete(\'technical_issue\',\'recording_failed\')');
  if(phase==='preparing')return mic+'<div style="height:10px;"></div>'+spBtn('Готово — к записи','speFullStartRecording()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\')');
  if(state.recording)return '<div role="status" style="font-weight:800;font-size:13px;color:#1D7F4A;margin-bottom:10px;">Ответ записан локально · '+state.recording.durationSeconds+' сек.</div>'
    +spBtn('Сохранить ответ','speFullComplete(\'completed\')',true)+'<div style="height:10px;"></div>'+spBtn('Перезаписать','speFullStartRecording()')+skip;
  if(state.isRecording)return spBtn('Стоп — закончить запись','speFullStopRecording()',true);
  return (state.recordingLostOnRestore?'<div role="alert" style="font-weight:700;font-size:12.5px;color:#A83226;margin-bottom:10px;">После перезагрузки локальная запись недоступна. Начни её заново или отметь проблему.</div>':'')
    +mic+'<div style="height:10px;"></div>'+spBtn('Начать запись','speFullStartRecording()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\')')}
function speRender(){var area=document.getElementById('s9_area');if(!area||!SPE)return;var session=SPE.session;
  if(session.status==='submitted'){speFullFinal(session.submission);return}
  var current=session.current,phase=session.phase,chip=phase==='preparing'?'ПОДГОТОВКА':phase==='recording'?'● ЗАПИСЬ':'ГОТОВО';
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · '+(current?current.taskType:4)+' ИЗ 4</span>'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">'+chip+'</span></div>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">'+speFullProgress()+'</div>'+speTaskBody()
    +(current&&current.stageDeadlineAt?'<div id="s9_timer" aria-live="polite" style="text-align:center;font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;margin-top:12px;">—</div>':'')
    +'</div><div style="display:flex;flex-direction:column;gap:0;">'+speFullControls()+'</div>';
  setTxt('s9_today',current?'задание '+current.taskType+' · ответ '+current.responseNumber:'готово к сдаче');speFullArmTimer()}
async function speFullSubmit(){if(!SPE_FLOW)return false;try{var idempotencyKey=globalThis.crypto.randomUUID();
    var result=await SPE_FLOW.submit(idempotencyKey);delete S.speakingFullSessionId;save();speFullFinal(result);return true
  }catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullPlay(taskType,responseNumber){if(!SPE_FLOW)return false;try{return await SPE_FLOW.playRecording(taskType,responseNumber)}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function speFullFinal(result){var area=document.getElementById('s9_area');if(!area||!result)return;clearInterval(SPE_TM);SPE_TM=null;
  var recordings=SPE_FLOW?SPE_FLOW.state().localRecordings:[];
  var plan=result.improvementPlan||{available:false,message:'План улучшения пока недоступен.'};
  var rows=result.taskResults.map(function(item){var local=recordings.filter(function(recording){return recording.taskType===item.taskType});return '<div style="padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
    +'<div style="display:flex;justify-content:space-between;gap:10px;font-weight:700;font-size:13px;color:#2B2B2B;"><span>'+SP_CONF[item.taskType].name+'</span><span>'+item.recordingStatus+' · '+Math.round(item.usedSeconds)+' сек. · максимум '+item.maximumScore+'</span></div>'
    +local.map(function(recording){return '<button type="button" class="sq" onclick="speFullPlay('+recording.taskType+','+recording.responseNumber+')" style="min-width:44px;min-height:44px;margin-top:7px;border:0;border-radius:12px;background:#E3F1F5;color:#317485;font-weight:800;">▶ Ответ '+recording.responseNumber+'</button>'}).join('')+'</div>'}).join('');
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">✓</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">Устная часть сдана</div>'
    +'<div style="font-weight:800;font-size:15px;color:#4A453E;margin-top:7px;">Максимум: 20 баллов</div>'
    +'<div style="font-weight:700;font-size:13px;color:#A56000;margin-top:5px;">Оценка пока недоступна</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;line-height:1.5;margin-top:5px;">Записи не отправлялись на сервер. Локальное прослушивание доступно только до ухода с этой страницы.</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div><div role="status" style="margin-top:12px;padding:11px 13px;border-radius:14px;background:#FFF4DE;color:#8A641A;font-weight:700;font-size:12.5px;">План улучшения пока недоступен. '+ui.escapeHtml(plan.message||'')+'</div></div><div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn('Новый вариант','speStart()',true)+spBtn('К заданиям','initSpeaking()')+'</div>';setTxt('s9_today','сдано · максимум 20');spAnim('win','.32s')}
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
    if(SP){spStopAll();SP=null}spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();
    speFullDispose()}});
registerRouteHook(function(id){if(id==='scr9')initSpeaking()});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  SP,SPE,
  initSpeaking,spCompleteTask1,spCompleteTask2Question,spCompleteTask3Answer,spCompleteTask4,spDeleteRecording,spEtalon,spEval,spExam,spFinish,spFlagTranscript,spMicCheck,spNextQ,
  launchSpeakingTask,spNextSet,spOpen,spPlay,spPlayTask2Question,spPlayTask3Answer,spPrep,spRec,spRestartAdaptive,spSample,spStopAll,spToggleSheet,spVoiceSample,
  speFullBeginStage,speFullComplete,speFullMicCheck,speFullPlay,speFullStartRecording,speFullStopRecording,speFullSubmit,speStart,
};
