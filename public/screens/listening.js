/*
 * Экран «Аудирование» (scr4). Приезжает динамическим import() при первом переходе на него.
 *
 * Проигрыватель и его запасная озвучка остались в оболочке: их настраивает tts.js при старте,
 * и говорение пользуется ими, ни разу не открыв аудирование.
 */
import {registerRouteHook} from '../router.js';
import {lPause,lPlayListeningSet,lResume,lStop} from '../tts.js';
import '../modules/listening.js';
import '../modules/exam.js';
import {prepareVoiceTutorContextResult,registerVoiceTutorContextResult} from '../voice-tutor-loader.js';
import {
  LSLOW,L_PLAYSVG,S,SRV,TOKEN,apiIsAuthorityFailure,apiResponseOwner,currentOwnerBinding,examModule,gExamFmt,generateAiContent,invalidateLearningAuthority,lSetSlow,lSt,
  lSync,listeningModule,registerAuthorityReset,registerScreenGenerator,rEsc,rWordsHtml,save,setTxt,toast,
} from '../app.js';
import {createLearningActivityEvidence,prepareLearningActivityRecording,recordLearningActivityEvidence} from '../learning-activity-recorder.js';
import {
  interviewSetForLegacyScreen,loadInterviewCatalog,loadMatchingCatalog,loadTrueFalseCatalog,
  matchingSetForLegacyScreen,trueFalseSetForLegacyScreen,
} from '../listening-catalog-contract.js';

/* ===== LISTENING ===== */
const LISTEN={dialog:"— Hi, can I get a coffee and a croissant, please?  — Sure, that's four pounds fifty. Anything else?  — No, that's all, thanks.",
  q1:{o:['В кафе','В магазине','В библиотеке'],a:0},q2:{o:['Чай и тост','Кофе и круассан'],a:1}};
let LIS={title:'Диалог 1 · В кафе',dialog:LISTEN.dialog,q1:{q:'1. Где происходит разговор?',o:LISTEN.q1.o.slice(),a:LISTEN.q1.a},q2:{q:'2. Что заказал мужчина?',o:LISTEN.q2.o.slice(),a:LISTEN.q2.a}};
async function genListening(){
  const authority=currentOwnerBinding(),request=L_VIEW_GENERATION,generation=++L_AI_GENERATION;
  if(!authority||!lRequestCurrent(request,authority))return false;
  let d;
  try{d=await generateAiContent('listening_dialog',{}, {'X-EasyBoost-Expected-Owner':authority.username})}
  catch(error){if(apiIsAuthorityFailure(error))await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});throw error}
  if(generation!==L_AI_GENERATION||!lRequestCurrent(request,authority))return false;
  if(apiResponseOwner(d)!==authority.username){await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});return false}
  if(!d||!d.dialog||!d.q1||!d.q2)throw 0;
  LIS={title:d.title||'Новый диалог',dialog:d.dialog,q1:{q:d.q1.q||'1.',o:d.q1.o,a:d.q1.a||0},q2:{q:d.q2.q||'2.',o:d.q2.o,a:d.q2.a||0}};
  initListening();return true}
/* Состояние трёх заданий и счётчик прослушиваний живут вместе с экраном. */
let LM=null,LT=null,LI=null,LPLAYS=0,L_OWNER=null,L_CONTEXT_RESULT=null;
let L_VIEW_GENERATION=0,L_AI_GENERATION=0,L_GEN_TIMER=null;
function lSameOwner(left,right){return Boolean(left&&right&&left.username===right.username&&left.generation===right.generation)}
function lCaptureOwner(){L_OWNER=currentOwnerBinding();return L_OWNER}
function lArea(){return document.getElementById('l_area')}
function lDock(){return document.getElementById('l_action_dock')}
function lNetworkState(state,copy){var status=document.getElementById('l_network_state');if(!status)return;
  status.dataset.networkState=state||'';status.textContent=copy||'';status.hidden=!copy}
function lProgress(completed,total,label){var value=Math.max(0,Math.min(100,Math.round(Number(completed||0)/Math.max(1,Number(total)||1)*100)));
  var progress=document.querySelector('#scr4 .learning-route__progress');if(progress){progress.setAttribute('aria-label',label||'Прогресс аудирования');progress.setAttribute('aria-valuenow',String(value))}
  var bar=document.getElementById('l_bar');if(bar)bar.style.width=Math.max(2,value)+'%'}
function lTimerSemantics(running){var timer=document.getElementById('l_today');if(!timer)return;
  timer.setAttribute('role',running?'timer':'status');timer.setAttribute('aria-live',running?'off':'polite')}
function lRouteCurrent(){var screen=document.getElementById('scr4');return Boolean(screen&&(typeof screen.classList?.contains!=='function'||screen.classList.contains('on')))}
function lRequestCurrent(request,authority){return request===L_VIEW_GENERATION&&lRouteCurrent()&&lSameOwner(authority,currentOwnerBinding())}
function lSessionCurrent(session){return Boolean(session&&lRequestCurrent(session.viewGeneration,session.authority))}
function lVoiceOwnerError(error,authority){if((apiIsAuthorityFailure(error)||error?.code==='OWNER_CHANGED')&&authority)return invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation})}
function lSetDock(markup){var host=lDock();if(!host)return;host.innerHTML=markup||'';host.hidden=!markup}
function lPrimary(handler,label,disabled){return '<button class="aisy-button learning-primary" type="button" onclick="'+handler+'"'+(disabled?' disabled':'')+'>'+label+'</button>'}
function lSecondary(handler,label){return '<button class="aisy-button aisy-button--secondary" type="button" onclick="'+handler+'">'+label+'</button>'}
function lRadioAttrs(selected,index,hasSelection){return ' tabindex="'+(selected||(!hasSelection&&index===0)?'0':'-1')+'" onkeydown="lRadioKey(event,this)"'}
function lRadioKey(event,button){if(!['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End'].includes(event.key))return;
  var radios=Array.from(button.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]:not(:disabled)')||[]);if(!radios.length)return;
  var index=radios.indexOf(button),next=event.key==='Home'?0:event.key==='End'?radios.length-1:(index+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)+radios.length)%radios.length;
  event.preventDefault();radios[next].focus();radios[next].click()}
function hasActiveListeningPractice(){return Boolean(lSameOwner(L_OWNER,currentOwnerBinding())
  &&((LM&&!LM.done)||(LT&&!LT.done)||(LI&&!LI.done)||LE))}
/* ===== LISTENING v2: задания 1, 2, 3-9 + озвучка по ролям ===== */
const L_M=[
{st:['Music helps this speaker to relax.','This speaker prefers active holidays.','This speaker enjoys cooking for the family.','This speaker spends a lot of time reading.','This speaker dreams of travelling abroad.'],
 sp:[
 {t:'After school I always put on my headphones. When I listen to my favourite songs, all my problems disappear and I feel calm again.'},
 {t:'On holidays I never stay at home. My family goes hiking in the mountains, and in summer we swim and ride bikes all day long.'},
 {t:'Every weekend I try a new recipe. My parents say my pancakes are the best, and I love making dinner for everybody on Sundays.'},
 {t:'I can spend the whole evening with a good detective story. Last month I read five books, and my room looks like a small library.'}],
 a:[0,1,2,3],
 k:['listen to songs → feel calm — музыка помогает расслабиться.','hiking, swim, ride bikes — активный отдых.','a new recipe, making dinner for everybody — готовит для семьи.','detective story, read five books — много читает.']},
{st:['The speaker finds exams stressful.','The speaker likes studying with friends.','The speaker is happy with a new school subject.','The speaker complains about too much homework.','The speaker wants to change schools.'],
 sp:[
 {t:'Before every test my hands shake and I cannot sleep well. Even when I know the material, I am still afraid of getting a bad mark.'},
 {t:'It is boring to do exercises alone. When my classmates come to my place, we explain difficult things to each other and studying becomes fun.'},
 {t:'This year we started learning economics. The lessons are so interesting that I even read extra articles at home.'},
 {t:'Teachers give us so many tasks that I sit at my desk till late evening. I have almost no time for walks or sport.'}],
 a:[0,1,2,3],
 k:['hands shake, afraid of a bad mark — экзамены вызывают стресс.','with classmates studying becomes fun — любит заниматься с друзьями.','started learning economics, so interesting — рад новому предмету.','so many tasks, no time for walks — жалуется на объём домашки.']}
];
const L_TF=[
{d:[
 {s:0,t:'Hi Kate! Are you free on Saturday? There is a new science museum in the city centre.'},
 {s:1,t:'Oh, I have heard about it! Tickets are half price for students, right?'},
 {s:0,t:'Exactly, five pounds instead of ten. My brother went last week and loved the space hall.'},
 {s:1,t:'Great. Shall we go in the morning? In the afternoon I have a piano lesson.'},
 {s:0,t:'Morning works for me. Let us meet at the bus stop at ten.'},
 {s:1,t:'Perfect. I will bring my camera — I hope taking photos is allowed there.'}],
 st:[
 {t:'The museum is in the city centre.',a:0,ev:'There is a new science museum in the city centre.',e:'Прямо сказано в первой реплике.'},
 {t:'Students pay ten pounds for a ticket.',a:1,ev:'…five pounds instead of ten.',e:'Для студентов полцены — пять фунтов, а не десять → False.'},
 {t:'The boy’s brother has already been to the museum.',a:0,ev:'My brother went last week and loved the space hall.',e:'Брат ходил на прошлой неделе → True.'},
 {t:'Kate is busy on Saturday afternoon.',a:0,ev:'In the afternoon I have a piano lesson.',e:'Днём у Кейт урок фортепиано → True.'},
 {t:'Taking photos is allowed in the museum.',a:2,ev:'I hope taking photos is allowed there.',e:'Кейт только НАДЕЕТСЯ — разрешено или нет, в диалоге не сказано → Not stated.'}]},
{d:[
 {s:1,t:'Tom, you look tired today. Is everything OK?'},
 {s:0,t:'We got a puppy two days ago, and he cries every night. I get up three or four times to calm him down.'},
 {s:1,t:'Poor you! What breed is he?'},
 {s:0,t:'A beagle. He is only two months old, but he is very clever. He already knows his name — Rex.'},
 {s:1,t:'My cat never comes when I call her. By the way, who walks him in the morning?'},
 {s:0,t:'My dad does, before work. And I walk him after school. The vet says short walks are better for puppies.'}],
 st:[
 {t:'Tom got his puppy two days ago.',a:0,ev:'We got a puppy two days ago…',e:'Прямое совпадение с репликой Тома.'},
 {t:'The puppy sleeps well at night.',a:1,ev:'…he cries every night. I get up three or four times…',e:'Щенок плачет по ночам → False.'},
 {t:'Rex is six months old.',a:1,ev:'He is only two months old…',e:'Ему два месяца, а не шесть → False.'},
 {t:'The girl’s cat comes when she calls it.',a:1,ev:'My cat never comes when I call her.',e:'Кошка никогда не приходит → False.'},
 {t:'Tom’s dad walks the puppy in the park.',a:2,ev:'My dad does, before work.',e:'Папа гуляет утром, но ГДЕ — не говорится → Not stated.'}]}
];
const L_IN=[
{d:[
 {s:1,t:'Today our guest is Alex, a young swimmer who won the regional championship. Alex, when did you start swimming?'},
 {s:0,t:'When I was six. My mum took me to the pool because I was often ill, and doctors advised sport.'},
 {s:1,t:'Do you train every day?'},
 {s:0,t:'Five times a week, early in the morning before school. On Sundays I always rest — my coach says rest is part of training.'},
 {s:1,t:'What was the hardest moment in your career?'},
 {s:0,t:'Last year I broke my arm and missed four months. I thought about leaving sport, but my team supported me.'},
 {s:1,t:'And what are your plans?'},
 {s:0,t:'I dream of the national team, but first I want to win the city cup in May.'}],
 qs:[
  {q:'Why did Alex start swimming?',o:['Doctors recommended sport','His friends invited him','He watched it on TV'],a:0,ev:'…I was often ill, and doctors advised sport.',e:'Причина — совет врачей из-за частых болезней.',voice:{id:'listening.alex-swimming.reason',revision:1}},
 {q:'How often does Alex train?',o:['Every day','Five times a week','Only at weekends'],a:1,ev:'Five times a week, early in the morning before school.',e:'Пять раз в неделю, воскресенье — отдых.'},
 {q:'What happened to Alex last year?',o:['He left his team','He broke his arm','He lost the championship'],a:1,ev:'Last year I broke my arm and missed four months.',e:'Сломал руку и пропустил четыре месяца.'},
 {q:'What does Alex want to do first?',o:['Join the national team','Win the city cup','Become a coach'],a:1,ev:'…but first I want to win the city cup in May.',e:'Сначала — кубок города, сборная — мечта на потом.'}]},
{d:[
 {s:0,t:'Our guest today is Lena, who runs a popular blog about school life. Lena, how did it all begin?'},
 {s:1,t:'Two years ago I started posting short videos with study tips. At first only my classmates watched them.'},
 {s:0,t:'And now you have thousands of followers! How much time does the blog take?'},
 {s:1,t:'About two hours a day. I film in the evening and edit videos at the weekend. My parents help me with the camera.'},
 {s:0,t:'Has the blog changed your life?'},
 {s:1,t:'Yes, I have become more confident. But my marks went down a little last term, so now I plan my time more carefully.'},
 {s:0,t:'What advice can you give to beginners?'},
 {s:1,t:'Do not copy others. Viewers feel when you are honest, and honesty works better than expensive equipment.'}],
 qs:[
 {q:'When did Lena start her blog?',o:['Two years ago','Two months ago','Last term'],a:0,ev:'Two years ago I started posting short videos…',e:'Прямо названо в начале интервью.'},
 {q:'Who helps Lena with her blog?',o:['Her classmates','Her parents','Her teachers'],a:1,ev:'My parents help me with the camera.',e:'С камерой помогают родители.'},
 {q:'What problem did the blog cause?',o:['She lost her friends','Her marks got worse','She stopped sleeping'],a:1,ev:'…my marks went down a little last term…',e:'Оценки немного снизились — пришлось планировать время.'},
 {q:'What does Lena advise beginners?',o:['To buy a good camera','To copy popular bloggers','To be honest'],a:2,ev:'…honesty works better than expensive equipment.',e:'Главный совет — честность, а не дорогая техника.'}]}
];
let L_MATCHING_CATALOG=[],L_MATCHING_CATALOG_LOAD=null,L_TRUE_FALSE_CATALOG=[],L_TRUE_FALSE_CATALOG_LOAD=null;
let L_INTERVIEW_CATALOG=[],L_INTERVIEW_CATALOG_LOAD=null;
let L_MATCHING_CATALOG_READY=false,L_TRUE_FALSE_CATALOG_READY=false,L_INTERVIEW_CATALOG_READY=false;
const L_VOICE_RESULT_SETS=[
  {id:'listening.exam.interview.alex',items:['listening.alex-swimming.reason','listening.alex-swimming.frequency','listening.alex-swimming.injury','listening.alex-swimming.first-plan']},
  {id:'listening.exam.interview.lena',items:['listening.lena-blog.started','listening.lena-blog.helpers','listening.lena-blog.problem','listening.lena-blog.advice']},
];
L_VOICE_RESULT_SETS.forEach(function(resultSet,setIndex){
  L_IN[setIndex].voice={id:resultSet.id,revision:1};
  resultSet.items.forEach(function(itemId,itemIndex){L_IN[setIndex].qs[itemIndex].voice={id:itemId,revision:1}});
});
function lAnim(){var target=lArea()?.querySelector('.listening-view');if(!target)return;
  target.classList.remove('learning-view-enter');void target.offsetWidth;target.classList.add('learning-view-enter')}
function lFocusViewHeading(){queueMicrotask(function(){var container=lArea(),heading=container?.querySelector('.learning-view-title');if(!heading)return;container.scrollTop=0;heading.tabIndex=-1;heading.focus({preventScroll:true})})}
function lHistory(){S.listeningPilotHistory=listeningModule.normalizeHistory(S.listeningPilotHistory);return S.listeningPilotHistory}
function lSelectCatalogSet(pool,format){var set=listeningModule.selectCatalogSet(pool,lHistory(),format,Date.now())||pool[0];
  S.listeningPilotHistory=listeningModule.rememberCatalogSelection(S.listeningPilotHistory,format,set);save();return set}
function lAttemptEvidence(format,set,startedAt){var evidence=createLearningActivityEvidence({module:'listening',
  activityId:listeningModule.activityId(format),mode:'listening_'+format,source:listeningModule.sourceOf(set),startedAt:startedAt});
  evidence.helpUsed=listeningModule.catalogAttemptIsAssisted(lHistory(),set);return evidence}
function lHelp(){return{slowPlayback:false,additionalPlaybacks:0,synthFallback:false}}
function lMarkPlaybackHelp(session,status){if(!session||!session.evidence||status==='static')return;
  session.help.synthFallback=true;session.evidence.helpUsed=true}
function lCompleteHistory(session,score,maxScore,attemptedAt){if(!session||!session.set)return;
  S.listeningPilotHistory=listeningModule.recordCatalogAttempt(lHistory(),session.set,{score:score,maxScore:maxScore,
    attemptedAt:attemptedAt||Date.now(),transcriptExposed:true,help:session.help});save()}
function lPlay(lines){var session=LM&&!LM.done?LM:(LT&&!LT.done?LT:(LI&&!LI.done?LI:null));
  if(!lSessionCurrent(session))return;LPLAYS++;
  if(session&&session.evidence){if(LSLOW){session.help.slowPlayback=true;session.evidence.helpUsed=true}
    session.help.additionalPlaybacks=Math.max(session.help.additionalPlaybacks,LPLAYS-2);
    session.evidence.hintsUsed=Math.max(0,LPLAYS-2);if(session.evidence.hintsUsed)session.evidence.helpUsed=true}
  lPlaysUi();lPlayListeningSet(session&&session.set,lines,function(status){lMarkPlaybackHelp(session,status)},
    {isCurrent:function(){return lSessionCurrent(session)}})}
function lPlaysUi(){var el=document.getElementById('l_plays');if(!el)return;
  el.textContent=LPLAYS<=2?('прослушиваний: '+LPLAYS+' из 2'):(LPLAYS+'-е — на ЕГЭ так нельзя!');
  el.dataset.state=LPLAYS<=2?'within-limit':'assisted'}
function lCtl(fn){
  return '<section class="listening-audio" data-audio-state="stopped" data-audio-source="unknown" aria-label="Проигрыватель записи">'
    +'<button id="l_playbtn" class="aisy-button aisy-button--secondary listening-audio__play" type="button" onclick="'+fn+'"><span id="l_playtx">Слушать</span><span id="l_playic">'+L_PLAYSVG+'</span></button>'
    +'<button type="button" class="aisy-button aisy-button--secondary listening-audio__stop" aria-label="Остановить воспроизведение" onclick="lStop()">■</button>'
    +'<button id="l_pausebtn" type="button" class="aisy-button aisy-button--secondary listening-audio__pause" aria-label="Приостановить воспроизведение" aria-pressed="false" disabled onclick="lTogglePause(this)">Ⅱ</button>'
    +'<button type="button" class="aisy-button aisy-button--secondary listening-audio__slow '+(LSLOW?'is-selected':'')+'" aria-pressed="'+String(LSLOW)+'" onclick="lToggleSlow(this)">0.7×</button>'
    +'<span id="l_plays" class="listening-audio__plays" data-state="within-limit">прослушиваний: 0 из 2</span>'
    +'<span id="l_audio_status" class="listening-audio__status" role="status" aria-live="polite">Остановлено</span>'
    +'<span id="l_audio_source" class="listening-audio__source">Источник определится при запуске. Готовая запись сохраняется после первого успешного использования.</span></section>'}
function lTranscript(lines,evs){
  return '<section class="listening-card listening-transcript"><h2 class="listening-kicker">Транскрипт · нажми слово для перевода</h2>'
    +lines.map(function(ln){
      var hl=(evs||[]).some(function(ev){return ev&&ln.t.indexOf(ev.replace(/^…/,'').replace(/…$/,'').replace(/\.$/,'').slice(0,25))>=0});
      return '<p class="listening-transcript__line '+(hl?'is-evidence':'')+'"><b aria-hidden="true">—</b> '+rWordsHtml(ln.t)+'</p>'}).join('')+'</section>'}
function lLoadMatchingCatalog(){
  if(L_MATCHING_CATALOG_LOAD)return L_MATCHING_CATALOG_LOAD;
  L_MATCHING_CATALOG_LOAD=loadMatchingCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetMatchingCatalog,function(error){L_MATCHING_CATALOG_LOAD=null;throw error});
  return L_MATCHING_CATALOG_LOAD}
function lSetMatchingCatalog(sets){
  L_MATCHING_CATALOG=sets.map(function(set){return set.st?set:matchingSetForLegacyScreen(set)});
  L_MATCHING_CATALOG_READY=true;
  return L_MATCHING_CATALOG}
function lLoadTrueFalseCatalog(){
  if(L_TRUE_FALSE_CATALOG_LOAD)return L_TRUE_FALSE_CATALOG_LOAD;
  L_TRUE_FALSE_CATALOG_LOAD=loadTrueFalseCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetTrueFalseCatalog,function(error){L_TRUE_FALSE_CATALOG_LOAD=null;throw error});
  return L_TRUE_FALSE_CATALOG_LOAD}
function lSetTrueFalseCatalog(sets){
  L_TRUE_FALSE_CATALOG=sets.map(function(set){return set.st?set:trueFalseSetForLegacyScreen(set)});
  L_TRUE_FALSE_CATALOG_READY=true;
  return L_TRUE_FALSE_CATALOG}
function lLoadInterviewCatalog(){
  if(L_INTERVIEW_CATALOG_LOAD)return L_INTERVIEW_CATALOG_LOAD;
  L_INTERVIEW_CATALOG_LOAD=loadInterviewCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetInterviewCatalog,function(error){L_INTERVIEW_CATALOG_LOAD=null;throw error});
  return L_INTERVIEW_CATALOG_LOAD}
function lSetInterviewCatalog(sets){
  L_INTERVIEW_CATALOG=sets.map(function(set){return set.qs?set:interviewSetForLegacyScreen(set)});
  L_INTERVIEW_CATALOG_READY=true;
  return L_INTERVIEW_CATALOG}
function lStatus(kind,title,copy){return '<section class="listening-view"><section class="listening-status listening-status--'+kind+'" role="'+(kind==='error'?'alert':'status')+'" aria-live="polite">'
  +(kind==='loading'?'<span class="listening-spinner" aria-hidden="true"></span>':'')+'<h2>'+rEsc(title)+'</h2><p>'+rEsc(copy)+'</p></section></section>'}
function initListening(){if(!S)return;var request=++L_VIEW_GENERATION,authority=currentOwnerBinding();
  void prepareLearningActivityRecording().catch(function(){});lSetDock();
  if(!authority){lNetworkState('error','Активный владелец сессии не подтверждён.');lArea().innerHTML=lStatus('error','Нужна подтверждённая сессия','Аудирование не начнётся без активного аккаунта.');return}
  lSync();lProgress(0,1,'Загрузка каталогов аудирования');
  lNetworkState(navigator.onLine===false?'offline':'loading',navigator.onLine===false?'Нет сети. Ищем сохранённые каталоги аудирования в кэше устройства.':'Проверяем каталоги и доступность записей.');
  lArea().innerHTML=lStatus('loading','Загружаем аудирование','Проверяем три канонических каталога и доступные записи.');
  Promise.all([lLoadMatchingCatalog(),lLoadTrueFalseCatalog(),lLoadInterviewCatalog()]).then(function(){
    if(!lRequestCurrent(request,authority))return;
    if(navigator.onLine===false)lNetworkState('cache-ready','Офлайн: каталоги доступны из кэша. Готовая запись работает офлайн только после первого успешного воспроизведения; иначе будет явно отмечена синтезированная помощь.');else lNetworkState();
    if(LE&&lExamResume())return;
    if(LM&&lSameOwner(LM.authority,authority)){LM.viewGeneration=L_VIEW_GENERATION;lMtRender(null,true);return}
    if(LT&&lSameOwner(LT.authority,authority)){LT.viewGeneration=L_VIEW_GENERATION;lTfRender(null,true);return}
    if(LI&&lSameOwner(LI.authority,authority)){LI.viewGeneration=L_VIEW_GENERATION;lIqRender(null,true);return}
    LM=null;LT=null;LI=null;if(!LE)lHub()
  }).catch(function(){if(!lRequestCurrent(request,authority))return;
    lNetworkState(navigator.onLine===false?'cache-required':'error',navigator.onLine===false?'Каталоги ещё не сохранены на этом устройстве: для первого открытия подключитесь к сети.':'Каталоги не загрузились. Повторите запрос.');
    lArea().innerHTML=lStatus('error','Каталог аудирования недоступен',navigator.onLine===false?'Для первого открытия нужен уже сохранённый каталог. Подключитесь к сети и повторите.':'Не удалось проверить каталоги. Прогресс не изменён.');
    lSetDock(lPrimary('initListening()','Повторить загрузку',false));
  })}
function lHub(){var area=lArea();if(!area)return;var resumableExam=Boolean(LE&&!LE.finished&&lSessionCurrent(LE));
  if(resumableExam)lExamPause();else{if(LE?.iv)clearInterval(LE.iv);LE=null;L_OWNER=null}
  LM=null;LT=null;LI=null;L_CONTEXT_RESULT=null;lStop();
  lTimerSemantics(false);if(navigator.onLine===false)lNetworkState('cache-ready','Офлайн: сохранённые каталоги доступны; запись доступна без сети только после первого успешного воспроизведения.');else lNetworkState();
  var r=lSt(),examMax=lExamMaxScore(),le=S.lisExam||{};
  var listeningSummary=listeningModule.summary(r);lProgress(listeningSummary.correct,listeningSummary.total||1,'Точность аудирования');
  function acc(x){return x.tot?Math.round(x.ok/x.tot*100)+'%':'—'}
  function card(fn,title,sub,chip){return '<button type="button" class="listening-card listening-launch" onclick="'+fn+'"><span><strong>'+title+'</strong><small>'+sub+'</small></span><b>'+chip+'</b></button>'}
  area.innerHTML='<section class="listening-view learning-view-enter"><header class="reading-title"><p class="listening-kicker">ЕГЭ-2026 · практика</p><h2 class="learning-view-title">Каталог аудирования</h2><p>Три канонических формата. Ответы открываются только после явной проверки.</p></header>'
    +'<section class="listening-card listening-exam-card"><h2>Экзамен · задания 1–9</h2><p>'+(le.n?('Лучший результат: '+le.best+' из '+examMax):'Три задания подряд · каждую запись можно включить дважды')+'</p></section>'
    +'<section class="listening-launch-grid">'
    +card('lMt()','Соответствия','задание 1 · кто о чём говорит',acc(r.m))
    +card('lTf()','Верно · Неверно · Не сказано','задание 2 · диалог и утверждения',acc(r.tf))
    +card('lIq()','Интервью','задания 3–9 · вопросы с выбором',acc(r.iq))+'</section>'
    +'<p class="listening-notice">Сначала прочитай вопросы, затем слушай. Готовые MP3 сохраняются после первого успешного воспроизведения; если запись недоступна, источник будет честно помечен как синтезированный.</p></section>';
  lSetDock(lPrimary(resumableExam?'lExamResume()':'lExam()',resumableExam?'Продолжить полный раздел':'Полный раздел 1–9',false));setTxt('l_today',resumableExam?'Полный раздел приостановлен':'3 тренажёра');lFocusViewHeading();lGen()}
function lAbandonExam(){if(!LE)return false;lExamPause();LE=null;return true}
function lShufM(set){return listeningModule.shuffleMatching(set)}
function lSpeakerLabel(index){return String.fromCharCode(65+index)}
function lInterviewNumber(index){return index+3}
function lMatchingPool(){
  if(L_MATCHING_CATALOG.length)return listeningModule.pool(L_MATCHING_CATALOG,[]);
  return lPool('m',L_M)}
function lTrueFalsePool(){
  if(L_TRUE_FALSE_CATALOG.length)return listeningModule.pool(L_TRUE_FALSE_CATALOG,[]);
  return lPool('tf',L_TF)}
function lInterviewPool(){
  if(L_INTERVIEW_CATALOG.length)return listeningModule.pool(L_INTERVIEW_CATALOG,[]);
  return lPool('iq',L_IN)}
function lMatchingMax(set){return Math.max(1,Number(set&&set.maxScore)||((set&&set.a&&set.a.length)||1))}
function lExamMaxScore(){
  var m=lMatchingPool()[0],tf=lTrueFalsePool()[0],iq=lInterviewPool()[0];
  return lMatchingMax(m)+(tf&&tf.st?tf.st.length:0)+(iq&&iq.qs?iq.qs.length:0)}
/* ---- задание 1: соответствия ---- */
function lMt(){if(!L_MATCHING_CATALOG_READY){var pendingView=L_VIEW_GENERATION,pendingOwner=currentOwnerBinding();lLoadMatchingCatalog().then(function(){if(lRequestCurrent(pendingView,pendingOwner))lMt()});return}
  var authority=lCaptureOwner();if(!lRequestCurrent(L_VIEW_GENERATION,authority))return;
  lAbandonExam();
  L_CONTEXT_RESULT=null;
  var set=lShufM(lSelectCatalogSet(lMatchingPool(),'matching'));
  LM={set:set,sel:set.sp.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('matching',set),authority:authority,viewGeneration:L_VIEW_GENERATION};LPLAYS=0;lMtRender(null,true)}
function lMtLines(){return LM.set.sp.map(function(sp,i){return {s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}})}
function lMtRender(focusSpeaker,animate){var area=lArea();if(!area||!lSessionCurrent(LM))return;var set=LM.set;
  var h='<section class="listening-view'+(animate?' learning-view-enter':'')+'"><header class="reading-title"><p class="listening-kicker">Задание 1 · соответствия</p><h2 class="learning-view-title">Кто о чём говорит</h2><p>Сначала прочитай утверждения. Одно утверждение лишнее.</p></header>'
    +'<section class="listening-card listening-statements"><h2>Утверждения</h2><ol>'+set.st.map(function(x){return '<li>'+rEsc(x)+'</li>'}).join('')+'</ol>'+lCtl('lPlay(lMtLines())')+'</section>';
  set.sp.forEach(function(_,si){var L=lSpeakerLabel(si),answer=LM.done?set.a[si]:null,correct=LM.done&&LM.sel[si]===answer;
    h+='<section class="listening-card listening-question '+(LM.done?(correct?'is-correct':'is-incorrect'):'')+'"><h2>Говорящий '+L+'</h2><div class="listening-choice-list listening-choice-list--compact" id="lmt_row_'+si+'" role="radiogroup" aria-label="Ответ для говорящего '+L+'">'
      +set.st.map(function(_,ti){var on=LM.sel[si]===ti;return '<button type="button" role="radio" aria-label="Говорящий '+L+', утверждение '+(ti+1)+'" aria-checked="'+String(on)+'"'+lRadioAttrs(on,ti,LM.sel[si]!==null)+' class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lMtPick('+si+','+ti+')"'+(LM.done?' disabled':'')+'>'+(ti+1)+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')
      +'</div><div id="lmt_res_'+si+'">'+(LM.done?'<p class="listening-answer-state"><strong>'+(correct?'Верно':'Ошибка')+'.</strong> Правильный ответ: '+(answer+1)+'. '+rEsc(set.st[answer])+'</p><p>'+rEsc(set.k[si])+'</p>':'')+'</div></section>'});
  if(LM.done)h+='<section class="listening-card listening-result" role="status"><h2>'+LM.score+' из '+LM.maxScore+'</h2><p>Лишнее утверждение: '+(LM.extra+1)+'. '+rEsc(set.st[LM.extra])+'</p></section>'+lTranscript(lMtLines(),[]);
  area.innerHTML=h+'</section>';lPlaysUi();var selected=LM.sel.filter(function(x){return x!==null}).length;
  setTxt('l_today',LM.done?'Разбор готов':selected+' / '+set.sp.length+' выбрано');lProgress(LM.done?LM.score:selected,LM.done?LM.maxScore:set.sp.length,LM.done?'Результат задания 1':'Ответы задания 1');
  lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+(LM.done?lPrimary('lMtNext()','Следующий комплект',false):lPrimary('lMtCheck()','Проверить ответы',!LM.sel.every(function(x){return x!==null})))+'</div>');
  if(Number.isInteger(focusSpeaker))queueMicrotask(function(){document.querySelector('#lmt_row_'+focusSpeaker+' [aria-checked="true"]')?.focus()});else if(animate)lFocusViewHeading()}
function lMtPick(si,ti){if(!lSessionCurrent(LM)||LM.done)return;lStop();
  LM.sel=listeningModule.selectUnique(LM.sel,si,ti);
  lMtRender(si)}
function lMtNext(){var previous=LM;if(!lSessionCurrent(previous)||!previous.done||previous.nextStarted)return false;
  previous.nextStarted=true;lMt();return true}
function lMtCheck(){if(!lSessionCurrent(LM)||LM.done||!LM.sel.every(function(x){return x!==null}))return;LM.done=true;lStop();var set=LM.set,r=lSt(),okn=0;
  set.sp.forEach(function(_,si){var ok=LM.sel[si]===set.a[si];if(ok)okn++;r.m.tot++;if(ok)r.m.ok++});
  var used={};set.a.forEach(function(x){used[x]=1});
  var extra=set.st.map(function(_,i){return i}).find(function(i){return !used[i]});
  var maxScore=lMatchingMax(set);
  r.done++;lSync();lCompleteHistory(LM,okn,maxScore);save();recordLearningActivityEvidence(LM.evidence,{score:okn,maxScore:maxScore}).catch(function(){});
  LM.score=okn;LM.maxScore=maxScore;LM.extra=extra;lMtRender(null,true);lGen()}
/* ---- задание 2: True/False/Not stated ---- */
function lTf(){if(!L_TRUE_FALSE_CATALOG_READY){var pendingView=L_VIEW_GENERATION,pendingOwner=currentOwnerBinding();lLoadTrueFalseCatalog().then(function(){if(lRequestCurrent(pendingView,pendingOwner))lTf()});return}
  var authority=lCaptureOwner();if(!lRequestCurrent(L_VIEW_GENERATION,authority))return;
  lAbandonExam();
  L_CONTEXT_RESULT=null;
  var set=lSelectCatalogSet(lTrueFalsePool(),'true_false');
  LT={set:set,sel:set.st.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('true_false',set),authority:authority,viewGeneration:L_VIEW_GENERATION};LPLAYS=0;lTfRender(null,true)}
function lTfRender(focusIndex,animate){var area=lArea();if(!area||!lSessionCurrent(LT))return;var set=LT.set,LBL=['Верно','Неверно','Не сказано'];
  var h='<section class="listening-view'+(animate?' learning-view-enter':'')+'"><header class="reading-title"><p class="listening-kicker">Задание 2</p><h2 class="learning-view-title">Верно · Неверно · Не сказано</h2><p>Прочитай утверждения, затем послушай диалог.</p></header><section class="listening-card">'+lCtl('lPlay(LT.set.d)')+'</section>';
  set.st.forEach(function(x,i){var correct=LT.done&&LT.sel[i]===x.a;
    h+='<section class="listening-card listening-question '+(LT.done?(correct?'is-correct':'is-incorrect'):'')+'"><h2>'+(i+1)+'. '+rEsc(x.t)+'</h2><div class="listening-choice-list" id="ltf_row_'+i+'" role="radiogroup" aria-label="Ответ на утверждение '+(i+1)+'">'
      +LBL.map(function(label,li){var on=LT.sel[i]===li;return '<button type="button" role="radio" aria-checked="'+String(on)+'"'+lRadioAttrs(on,li,LT.sel[i]!==null)+' class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lTfPick('+i+','+li+')"'+(LT.done?' disabled':'')+'>'+label+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')
      +'</div><div id="ltf_res_'+i+'">'+(LT.done?'<p class="listening-answer-state"><strong>'+(correct?'Верно':'Ошибка')+'.</strong> Правильный ответ: '+LBL[x.a]+'</p><p><strong>В записи:</strong> «'+rEsc(x.ev)+'» — '+rEsc(x.e)+'</p>':'')+'</div></section>'});
  if(LT.done)h+='<section class="listening-card listening-result" role="status"><h2>'+LT.score+' из '+set.st.length+'</h2><p>Разбор и транскрипт открыты после проверки.</p></section>'+lTranscript(set.d,set.st.map(function(x){return x.ev}));
  area.innerHTML=h+'</section>';lPlaysUi();var selected=LT.sel.filter(function(x){return x!==null}).length;
  setTxt('l_today',LT.done?'Разбор готов':selected+' / '+set.st.length+' отмечено');lProgress(LT.done?LT.score:selected,set.st.length,LT.done?'Результат задания 2':'Ответы задания 2');
  lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+(LT.done?lPrimary('lTfNext()','Следующий комплект',false):lPrimary('lTfCheck()','Проверить ответы',!LT.sel.every(function(x){return x!==null})))+'</div>');
  if(Number.isInteger(focusIndex))queueMicrotask(function(){document.querySelector('#ltf_row_'+focusIndex+' [aria-checked="true"]')?.focus()});else if(animate)lFocusViewHeading()}
function lTfPick(i,li){if(!lSessionCurrent(LT)||LT.done)return;lStop();LT.sel[i]=li;lTfRender(i)}
function lTfNext(){var previous=LT;if(!lSessionCurrent(previous)||!previous.done||previous.nextStarted)return false;
  previous.nextStarted=true;lTf();return true}
function lTfCheck(){if(!lSessionCurrent(LT)||LT.done||!LT.sel.every(function(x){return x!==null}))return;LT.done=true;lStop();var set=LT.set,r=lSt(),okn=0;
  set.st.forEach(function(x,i){var ok=LT.sel[i]===x.a;if(ok)okn++;r.tf.tot++;if(ok)r.tf.ok++});
  r.done++;lSync();lCompleteHistory(LT,okn,set.st.length);save();recordLearningActivityEvidence(LT.evidence,{score:okn,maxScore:set.st.length}).catch(function(){});
  LT.score=okn;lTfRender(null,true);lGen()}
/* ---- задания 3-9: интервью ---- */
function lIq(){if(!L_INTERVIEW_CATALOG_READY){var pendingView=L_VIEW_GENERATION,pendingOwner=currentOwnerBinding();lLoadInterviewCatalog().then(function(){if(lRequestCurrent(pendingView,pendingOwner))lIq()});return}
  var authority=lCaptureOwner();if(!lRequestCurrent(L_VIEW_GENERATION,authority))return;
  lAbandonExam();
  L_CONTEXT_RESULT=null;
  var set=lSelectCatalogSet(lInterviewPool(),'interview');
  LI={set:set,sel:set.qs.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('interview',set),authority:authority,viewGeneration:L_VIEW_GENERATION};LPLAYS=0;lIqRender(null,true)}
function lIqRender(focusIndex,animate){var area=lArea();if(!area||!lSessionCurrent(LI))return;var set=LI.set;
  var h='<section class="listening-view'+(animate?' learning-view-enter':'')+'"><header class="reading-title"><p class="listening-kicker">Задания 3–9</p><h2 class="learning-view-title">Интервью</h2><p>Прочитай вопросы, затем послушай интервью и выбери ответы.</p></header><section class="listening-card">'+lCtl('lPlay(LI.set.d)')+'</section>';
  set.qs.forEach(function(q,i){var correct=LI.done&&LI.sel[i]===q.a,voiceSlot=LI.done&&LI.voiceResult?LI.voiceResult.resultSlot(q,i):'';
    h+='<section class="listening-card listening-question '+(LI.done?(correct?'is-correct':'is-incorrect'):'')+'"><h2>'+lInterviewNumber(i)+'. '+rEsc(q.q)+'</h2><div class="listening-choice-list" id="liq_row_'+i+'" role="radiogroup" aria-label="Ответ на вопрос '+lInterviewNumber(i)+'">'
      +q.o.map(function(option,oi){var on=LI.sel[i]===oi;return '<button type="button" role="radio" aria-checked="'+String(on)+'"'+lRadioAttrs(on,oi,LI.sel[i]!==null)+' class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lIqPick('+i+','+oi+')"'+(LI.done?' disabled':'')+'>'+rEsc(option)+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')
      +'</div><div id="liq_res_'+i+'">'+(LI.done?'<p class="listening-answer-state"><strong>'+(correct?'Верно':'Ошибка')+'.</strong> Правильный ответ: '+rEsc(q.o[q.a])+'</p><p><strong>В записи:</strong> «'+rEsc(q.ev)+'» — '+rEsc(q.e)+'</p>'+voiceSlot:'')+'</div></section>'});
  if(LI.done)h+='<section class="listening-card listening-result" role="status"><h2>'+LI.score+' из '+set.qs.length+'</h2><p>Текстовый разбор открыт. Voice Tutor доступен только после проверки и при подтверждённом Premium.</p></section>'+lTranscript(set.d,set.qs.map(function(q){return q.ev}));
  area.innerHTML=h+'</section>';lPlaysUi();var selected=LI.sel.filter(function(x){return x!==null}).length;
  setTxt('l_today',LI.done?'Разбор готов':selected+' / '+set.qs.length+' отвечено');lProgress(LI.done?LI.score:selected,set.qs.length,LI.done?'Результат заданий 3–9':'Ответы заданий 3–9');
  lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+(LI.done?lPrimary('lIqNext()','Следующий комплект',false):lPrimary('lIqCheck()','Проверить ответы',!LI.sel.every(function(x){return x!==null})))+'</div>');
  if(Number.isInteger(focusIndex))queueMicrotask(function(){document.querySelector('#liq_row_'+focusIndex+' [aria-checked="true"]')?.focus()});else if(animate)lFocusViewHeading()}
function lIqPick(i,oi){if(!lSessionCurrent(LI)||LI.done)return;lStop();LI.sel[i]=oi;lIqRender(i)}
function lIqNext(){var previous=LI;if(!lSessionCurrent(previous)||!previous.done||previous.nextStarted)return false;
  previous.nextStarted=true;lIq();return true}
function lIqCheck(){if(!lSessionCurrent(LI)||LI.done||!LI.sel.every(function(x){return x!==null}))return;var session=LI;LI.done=true;L_CONTEXT_RESULT=session;lStop();var set=LI.set,r=lSt(),okn=0;
  var voiceResult=prepareVoiceTutorContextResult({module:'listening',set:set,selections:LI.sel});
  set.qs.forEach(function(q,i){var ok=LI.sel[i]===q.a;if(ok)okn++;r.iq.tot++;if(ok)r.iq.ok++});
  r.done++;lSync();lCompleteHistory(LI,okn,set.qs.length);save();recordLearningActivityEvidence(LI.evidence,{score:okn,maxScore:set.qs.length}).catch(function(){});
  LI.score=okn;LI.voiceResult=voiceResult;lIqRender(null,true);
  if(voiceResult)registerVoiceTutorContextResult(voiceResult,session.authority,function(){return L_CONTEXT_RESULT===session&&LI===session&&lSessionCurrent(session)&&session.done}).catch(function(error){return lVoiceOwnerError(error,session.authority)});
  lGen()}
/* ---- экзамен по аудированию: 1 + 2 + 3-9 ---- */
let LE=null;
function lExam(){var area=lArea(),authority=currentOwnerBinding();if(!area||!lRequestCurrent(L_VIEW_GENERATION,authority))return;lStop();
  var st=S.lisExam||{},maxScore=lExamMaxScore();
  lProgress(0,3,'Этапы полного раздела аудирования');
  area.innerHTML='<section class="listening-view"><header class="reading-title"><p class="listening-kicker">Как на ЕГЭ</p><h2 class="learning-view-title">Раздел «Аудирование» целиком</h2><p>Соответствия → верно/неверно/не сказано → интервью. Каждую запись можно включить только дважды, разбор откроется в конце.</p></header><section class="listening-card listening-exam-card"><h2>Максимум '+maxScore+' баллов</h2>'
    +(st.n?'<p>Попыток: '+st.n+' · последний: '+st.last+' из '+maxScore+' · лучший: '+st.best+' из '+maxScore+'</p>':'<p>Одна попытка, три этапа, единый таймер.</p>')+'</section></section>';
  lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+lPrimary('lExamStart()','Начать полный раздел',false)+'</div>');lAnim('win','.32s');lFocusViewHeading()}
function lExamStart(){
  var authority=lCaptureOwner();if(!lRequestCurrent(L_VIEW_GENERATION,authority))return;
  L_CONTEXT_RESULT=null;
  var pm=lMatchingPool(),pt=lTrueFalsePool(),pi=lInterviewPool();
  var startedAt=Date.now(),m=lShufM(lSelectCatalogSet(pm,'matching')),
      tf=lSelectCatalogSet(pt,'true_false'),iq=lSelectCatalogSet(pi,'interview');
  LE={m:m,tf:tf,iq:iq,stage:0,selM:m.a.map(function(){return null}),plays:[0,0,0],t0:startedAt,
      authority:authority,viewGeneration:L_VIEW_GENERATION,finished:false,
      help:{matching:lHelp(),true_false:lHelp(),interview:lHelp()},
      evidence:{gist:lAttemptEvidence('matching',m,startedAt),
        detail:createLearningActivityEvidence({module:'listening',activityId:listeningModule.activityId('detail'),
          mode:'listening_exam',source:listeningModule.sourceOf(tf,iq),startedAt:startedAt})}};
  LE.evidence.gist.mode='listening_exam';
  LE.evidence.detail.helpUsed=listeningModule.catalogAttemptIsAssisted(lHistory(),tf)
    ||listeningModule.catalogAttemptIsAssisted(lHistory(),iq);
  LE.selT=LE.tf.st.map(function(){return null});
  LE.selI=LE.iq.qs.map(function(){return null});
  lSetSlow(false);
  lTimerSemantics(true);
  LE.iv=setInterval(function(){if(lSessionCurrent(LE))setTxt('l_today',gExamFmt(Math.floor((Date.now()-LE.t0)/1000)))},1000);
  lExamRender(true)}
function lExamRestart(){var previous=L_CONTEXT_RESULT;if(!previous||!previous.finished||previous.restartStarted
    ||!lRequestCurrent(L_VIEW_GENERATION,previous.authority))return false;
  previous.restartStarted=true;lExamStart();return true}
function lExamPause(){if(!LE)return false;if(LE.iv)clearInterval(LE.iv);LE.iv=null;
  if(!Number.isFinite(LE.pausedAt))LE.pausedAt=Date.now();lStop();return true}
function lExamResume(){if(!LE)return false;if(!lRouteCurrent()||!lSameOwner(LE.authority,currentOwnerBinding())||!lSameOwner(L_OWNER,currentOwnerBinding())){LE=null;L_OWNER=null;return false}
  LE.viewGeneration=L_VIEW_GENERATION;
  var now=Date.now();if(Number.isFinite(LE.pausedAt)){LE.t0+=Math.max(0,now-LE.pausedAt);LE.pausedAt=null}
  lTimerSemantics(true);if(!LE.iv)LE.iv=setInterval(function(){if(lSessionCurrent(LE))setTxt('l_today',gExamFmt(Math.floor((Date.now()-LE.t0)/1000)))},1000);
  lExamRender(true);return true}
function lExamPlay(){if(!lSessionCurrent(LE)||LE.finished)return;
  if(!listeningModule.registerPlay(LE.plays,LE.stage,2)){try{toast('На ЕГЭ запись звучит только дважды')}catch(e){}return}
  var evidence=LE.stage===0?LE.evidence.gist:LE.evidence.detail;
  var help=LE.stage===0?LE.help.matching:(LE.stage===1?LE.help.true_false:LE.help.interview);
  if(LSLOW){help.slowPlayback=true;evidence.helpUsed=true}
  var set=LE.stage===0?LE.m:(LE.stage===1?LE.tf:LE.iq);
  var lines=LE.stage===0?LE.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}}):(LE.stage===1?LE.tf.d:LE.iq.d);
  lPlayListeningSet(set,lines,function(status){if(status!=='static'){help.synthFallback=true;evidence.helpUsed=true}},
    {isCurrent:function(){return lSessionCurrent(LE)&&!LE.finished}});
  var el=document.getElementById('lex_plays');
  if(el){el.textContent='прослушиваний: '+LE.plays[LE.stage]+' из 2';el.dataset.state=LE.plays[LE.stage]>=2?'limit':'within-limit'}}
function lExamCtl(){
  return '<section class="listening-audio" data-audio-state="stopped" data-audio-source="unknown" aria-label="Экзаменационный проигрыватель">'
    +'<button id="l_playbtn" class="aisy-button aisy-button--secondary listening-audio__play" type="button" onclick="lExamPlay()"><span id="l_playtx">Слушать</span><span id="l_playic">'+L_PLAYSVG+'</span></button>'
    +'<button type="button" class="aisy-button aisy-button--secondary listening-audio__stop" aria-label="Остановить воспроизведение" onclick="lStop()">■</button>'
    +'<button id="l_pausebtn" type="button" class="aisy-button aisy-button--secondary listening-audio__pause" aria-label="Приостановить воспроизведение" aria-pressed="false" disabled onclick="lTogglePause(this)">Ⅱ</button>'
    +'<span id="lex_plays" class="listening-audio__plays" data-state="'+(LE.plays[LE.stage]>=2?'limit':'within-limit')+'">прослушиваний: '+LE.plays[LE.stage]+' из 2</span>'
    +'<span id="l_audio_status" class="listening-audio__status" role="status" aria-live="polite">Остановлено</span>'
    +'<span id="l_audio_source" class="listening-audio__source">Источник определится при запуске</span></section>'}
function lExamNextBtn(ok,label,fn){
  return lPrimary(fn,label,!ok)}
function lExamRender(animate){var area=lArea();if(!area||!lSessionCurrent(LE)||LE.finished)return;
  var h='<section class="listening-view'+(animate?' learning-view-enter':'')+'"><header class="reading-title"><p class="listening-kicker">Экзамен · '+(LE.stage+1)+' из 3</p><h2 class="learning-view-title">'+(LE.stage===0?'Соответствия':LE.stage===1?'Верно · Неверно · Не сказано':'Интервью')+'</h2><p>Ответы и транскрипты откроются только после завершения всех трёх этапов.</p></header>';
  if(LE.stage===0){var set=LE.m;
    h+='<section class="listening-card listening-statements"><h2>Утверждения</h2><ol>'+set.st.map(function(x){return '<li>'+rEsc(x)+'</li>'}).join('')+'</ol>'+lExamCtl()+'</section>';
    set.sp.forEach(function(_,si){var L=lSpeakerLabel(si);h+='<section class="listening-card listening-question"><h2>Говорящий '+L+'</h2><div class="listening-choice-list listening-choice-list--compact" role="radiogroup" aria-label="Ответ для говорящего '+L+'">'
      +set.st.map(function(_,ti){var on=LE.selM[si]===ti;return '<button type="button" role="radio" aria-label="Говорящий '+L+', утверждение '+(ti+1)+'" aria-checked="'+String(on)+'"'+lRadioAttrs(on,ti,LE.selM[si]!==null)+' data-exam-field="selM-'+si+'-'+ti+'" class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lStop();LE.selM['+si+']='+ti+';LE.focus=\'selM-'+si+'-'+ti+'\';lExamDedup(\'selM\','+si+','+ti+');lExamRender()">'+(ti+1)+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')+'</div></section>'});
    lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+lExamNextBtn(LE.selM.every(function(x){return x!==null}),'Дальше: этап 2','lStop();LE.stage=1;LE.focus=null;lExamRender(true)')+'</div>');
  }else if(LE.stage===1){var set=LE.tf,LBL=['Верно','Неверно','Не сказано'];
    h+='<section class="listening-card">'+lExamCtl()+'</section>';
    set.st.forEach(function(x,i){h+='<section class="listening-card listening-question"><h2>'+(i+1)+'. '+rEsc(x.t)+'</h2><div class="listening-choice-list" role="radiogroup" aria-label="Ответ на утверждение '+(i+1)+'">'
      +LBL.map(function(label,li){var on=LE.selT[i]===li;return '<button type="button" role="radio" aria-checked="'+String(on)+'"'+lRadioAttrs(on,li,LE.selT[i]!==null)+' data-exam-field="selT-'+i+'-'+li+'" class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lStop();LE.selT['+i+']='+li+';LE.focus=\'selT-'+i+'-'+li+'\';lExamRender()">'+label+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')+'</div></section>'});
    lSetDock('<div class="listening-dock-actions">'+lSecondary('lStop();LE.stage=0;LE.focus=null;lExamRender(true)','Назад: этап 1')+lExamNextBtn(LE.selT.every(function(x){return x!==null}),'Дальше: этап 3','lStop();LE.stage=2;LE.focus=null;lExamRender(true)')+'</div>');
  }else{var set=LE.iq;
    h+='<section class="listening-card">'+lExamCtl()+'</section>';
    set.qs.forEach(function(q,i){h+='<section class="listening-card listening-question"><h2>'+lInterviewNumber(i)+'. '+rEsc(q.q)+'</h2><div class="listening-choice-list" role="radiogroup" aria-label="Ответ на вопрос '+lInterviewNumber(i)+'">'
      +q.o.map(function(option,oi){var on=LE.selI[i]===oi;return '<button type="button" role="radio" aria-checked="'+String(on)+'"'+lRadioAttrs(on,oi,LE.selI[i]!==null)+' data-exam-field="selI-'+i+'-'+oi+'" class="aisy-choice listening-choice '+(on?'is-selected':'')+'" onclick="lStop();LE.selI['+i+']='+oi+';LE.focus=\'selI-'+i+'-'+oi+'\';lExamRender()">'+rEsc(option)+(on?'<small>Выбрано</small>':'')+'</button>'}).join('')+'</div></section>'});
    lSetDock('<div class="listening-dock-actions">'+lSecondary('lStop();LE.stage=1;LE.focus=null;lExamRender(true)','Назад: этап 2')+lExamNextBtn(LE.selI.every(function(x){return x!==null}),'Завершить экзамен','lExamFinish()')+'</div>');
  }
  area.innerHTML=h+'</section>';var stageAnswers=LE.stage===0?LE.selM:(LE.stage===1?LE.selT:LE.selI);
  lProgress(LE.stage+stageAnswers.filter(function(value){return value!==null}).length/Math.max(1,stageAnswers.length),3,'Этапы полного раздела аудирования');
  var focus=LE.focus;if(focus)queueMicrotask(function(){document.querySelector('[data-exam-field="'+focus+'"]')?.focus()});else if(animate)lFocusViewHeading()}
function lExamDedup(field,idx,val){LE[field]=listeningModule.selectUnique(LE[field],idx,val)}
function lTogglePause(button){return button?.getAttribute('aria-pressed')==='true'?lResume():lPause()}
function lExamFinish(){if(!lSessionCurrent(LE)||LE.finished||![LE.selM,LE.selT,LE.selI].every(function(values){return values.every(function(x){return x!==null})}))return;
  var session=LE;session.finished=true;L_CONTEXT_RESULT=session;clearInterval(session.iv);lStop();
  var endedAt=Date.now(),sec=examModule.elapsedSeconds(session.t0,endedAt),r=lSt(),LBL=['Верно','Неверно','Не сказано'];
  var matchingMax=lMatchingMax(session.m),trueFalseMax=session.tf.st.length,interviewMax=session.iq.qs.length;
  var voiceResult=prepareVoiceTutorContextResult({module:'listening',set:session.iq,selections:session.selI});
  var okM=0;session.m.a.forEach(function(a,si){r.m.tot++;if(session.selM[si]===a){okM++;r.m.ok++}});
  var okT=0;session.tf.st.forEach(function(x,i){r.tf.tot++;if(session.selT[i]===x.a){okT++;r.tf.ok++}});
  var okI=0;session.iq.qs.forEach(function(q,i){r.iq.tot++;if(session.selI[i]===q.a){okI++;r.iq.ok++}});
  var total=okM+okT+okI;
  lCompleteHistory({set:session.m,help:session.help.matching},okM,matchingMax,endedAt);
  lCompleteHistory({set:session.tf,help:session.help.true_false},okT,trueFalseMax,endedAt);
  lCompleteHistory({set:session.iq,help:session.help.interview},okI,interviewMax,endedAt);
  listeningModule.examEvidenceSlices({matching:okM,matchingMax:matchingMax,trueFalse:okT,
    trueFalseMax:trueFalseMax,interview:okI,interviewMax:interviewMax},Math.max(0,endedAt-session.t0))
    .forEach(function(slice){var evidence=slice.activityId===listeningModule.activityId('matching')?session.evidence.gist:session.evidence.detail;
      recordLearningActivityEvidence(evidence,{score:slice.score,maxScore:slice.maxScore,durationMs:slice.durationMs}).catch(function(){})});
  S.lisExam=examModule.record(S.lisExam,total);
  var rows='';
  session.m.a.forEach(function(a,si){if(session.selM[si]!==a)
    rows+='<article class="listening-card listening-question is-incorrect"><h2>Ошибка · говорящий '+lSpeakerLabel(si)+'</h2><p>Правильный ответ: '+(a+1)+'. '+rEsc(session.m.st[a])+'</p><p>'+rEsc(session.m.k[si])+'</p></article>'});
  session.tf.st.forEach(function(x,i){if(session.selT[i]!==x.a)
    rows+='<article class="listening-card listening-question is-incorrect"><h2>Ошибка · утверждение '+(i+1)+'</h2><p>Правильный ответ: '+LBL[x.a]+'</p><p>«'+rEsc(x.ev)+'» — '+rEsc(x.e)+'</p></article>'});
  session.iq.qs.forEach(function(q,i){if(session.selI[i]!==q.a){var voiceSlot='';
    if(voiceResult)voiceSlot=voiceResult.resultSlot(q,i);
    rows+='<article class="listening-card listening-question is-incorrect"><h2>Ошибка · вопрос '+lInterviewNumber(i)+'</h2><p>Правильный ответ: '+rEsc(q.o[q.a])+'</p><p>«'+rEsc(q.ev)+'» — '+rEsc(q.e)+'</p>'+voiceSlot+'</article>'}});
  var tr1=lTranscript(session.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}}),[]);
  var tr2=lTranscript(session.tf.d,session.tf.st.map(function(x){return x.ev}));
  var tr3=lTranscript(session.iq.d,session.iq.qs.map(function(q){return q.ev}));
  LE=null;r.done++;lSync();save();
  var parts=[['Соответствия',okM,matchingMax],['Верно/неверно',okT,trueFalseMax],['Интервью',okI,interviewMax]];
  var max=examModule.maxScore(parts),weak=examModule.weakestSection(parts);
  lTimerSemantics(false);setTxt('l_today','Результат: '+total+' из '+max);
  var area=lArea(),resultView=L_VIEW_GENERATION;
  area.innerHTML='<section class="listening-view"><header class="reading-title"><p class="listening-kicker">Результат экзамена</p><h2 class="learning-view-title">'+total+' из '+max+'</h2><p>Время: '+gExamFmt(sec)+' · '+rEsc(examModule.sectionLine(parts))+'</p></header>'
    +(total<max?'<p class="listening-notice listening-notice--warning">Слабое место: '+weak.label.toLowerCase()+' — потренируй отдельно.</p>':'<p class="listening-notice">Верно по всем трём форматам.</p>')
    +(rows||'<section class="listening-card listening-question is-correct"><h2>Верно</h2><p>Ошибок нет.</p></section>')+tr1+tr2+tr3+'</section>';
  lProgress(total,max,'Результат полного раздела аудирования');
  lSetDock('<div class="listening-dock-actions">'+lSecondary('lHub()','К каталогу')+lPrimary('lExamRestart()','Новая попытка',false)+'</div>');
  if(voiceResult)registerVoiceTutorContextResult(voiceResult,session.authority,function(){return L_CONTEXT_RESULT===session&&lRequestCurrent(resultView,session.authority)&&!LE}).catch(function(error){return lVoiceOwnerError(error,session.authority)});
  lAnim('win','.32s');lFocusViewHeading();lGen()}
/* ---- фоновая ИИ-генерация комплектов аудирования ---- */
function lPool(kind,base){var ai=(S&&S.lisAi&&S.lisAi[kind])||[];
  if(kind==='iq')ai=ai.filter(function(set){return set&&set.voice&&set.qs&&set.qs.every(function(q){return q.voice})});
  return listeningModule.pool(base,ai)}
var L_GEN=false,L_GEN_RUN=0;
async function lGen(){
  if(L_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var authority=currentOwnerBinding(),request=L_VIEW_GENERATION,generation=++L_AI_GENERATION;
  if(!authority||!lRequestCurrent(request,authority))return;
  S.lisAi=S.lisAi||{m:[],tf:[],iq:[]};
  var kind=null;
  if(lMatchingPool().length<5)kind='m';
  else if(lTrueFalsePool().length<5)kind='tf';
  else if(lInterviewPool().length<5)kind='iq';
  if(!kind)return;L_GEN=true;var run=++L_GEN_RUN;
  try{
    var d,item=null;
    async function generate(operation){
      var payload=await generateAiContent(operation,{}, {'X-EasyBoost-Expected-Owner':authority.username});
      if(generation!==L_AI_GENERATION||!lRequestCurrent(request,authority))return null;
      if(apiResponseOwner(payload)!==authority.username){await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});return null}
      return payload;
    }
    if(kind==='m'){
      d=await generate('listening_matching');
      if(d&&Array.isArray(d.st)&&d.st.length===5&&Array.isArray(d.sp)&&d.sp.length===4
        &&Array.isArray(d.a)&&d.a.length===4&&d.a.every(function(x){return x>=0&&x<5})&&new Set(d.a.map(Number)).size===4
        &&Array.isArray(d.k)&&d.k.length===4&&d.sp.every(function(s){return s&&s.t})){
        item={st:d.st.map(String),sp:d.sp.map(function(s){return{t:String(s.t)}}),a:d.a.map(Number),k:d.k.map(String)}}
    }else if(kind==='tf'){
      d=await generate('listening_true_false');
      if(d&&Array.isArray(d.d)&&d.d.length>=5&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.st)&&d.st.length===5
        &&d.st.every(function(x){return x&&x.t&&x.a>=0&&x.a<3&&x.ev&&x.e})
        &&d.st.some(function(x){return +x.a===2})){
        item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),st:d.st.map(function(x){return{t:String(x.t),a:+x.a,ev:String(x.ev),e:String(x.e)}})}}
    }else{
      d=await generate('listening_interview');
      if(d&&Array.isArray(d.d)&&d.d.length>=6&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.qs)&&d.qs.length===4
        &&d.qs.every(function(q){return q&&q.q&&Array.isArray(q.o)&&q.o.length===3&&q.a>=0&&q.a<3&&q.ev&&q.e})){
        var voice=d.voice_tutor,hasVoice=voice&&voice.set_id&&voice.revision===1&&Array.isArray(voice.item_ids)&&voice.item_ids.length===4;
        if(hasVoice)item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),voice:{id:String(voice.set_id),revision:1},qs:d.qs.map(function(q,i){return{q:String(q.q),o:q.o.map(String),a:+q.a,ev:String(q.ev),e:String(q.e),voice:{id:String(voice.item_ids[i]),revision:1}}})}}
    }
    if(item&&generation===L_AI_GENERATION&&lRequestCurrent(request,authority)){S.lisAi[kind]=(S.lisAi[kind]||[]).concat([item]);save()}
  }catch(error){if(apiIsAuthorityFailure(error))await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation})}
  if(run!==L_GEN_RUN)return;L_GEN=false;
  try{var need=lMatchingPool().length<5||lTrueFalsePool().length<5||lInterviewPool().length<5;
    if(need&&generation===L_AI_GENERATION&&lRequestCurrent(request,authority)){clearTimeout(L_GEN_TIMER);L_GEN_TIMER=setTimeout(lGen,4000)}}catch(e){}}
registerRouteHook(function(id){if(id==='scr4')initListening();else{
  L_VIEW_GENERATION++;L_AI_GENERATION++;L_GEN_RUN++;L_GEN=false;clearTimeout(L_GEN_TIMER);L_GEN_TIMER=null;lExamPause();lSetDock();lNetworkState();
}});
registerScreenGenerator('scr4',genListening);
registerAuthorityReset(function(authority){
  L_VIEW_GENERATION++;L_AI_GENERATION++;L_GEN_RUN++;L_GEN=false;clearTimeout(L_GEN_TIMER);L_GEN_TIMER=null;
  if(!L_OWNER||authority?.owner!==L_OWNER.username||authority?.ownerGeneration!==L_OWNER.generation)return;
  if(LE?.iv)clearInterval(LE.iv);lStop();LM=null;LT=null;LI=null;LE=null;L_OWNER=null;L_CONTEXT_RESULT=null;LPLAYS=0;lSetDock();lNetworkState();
});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  LE,LI,LT,
  hasActiveListeningPractice,initListening,
  lExam,lExamDedup,lExamFinish,lExamPlay,lExamRender,lExamRestart,lExamResume,lExamStart,lHub,lIq,lIqCheck,lIqNext,lIqPick,
  lMt,lMtCheck,lMtLines,lMtNext,lMtPick,lPlay,lRadioKey,lTf,lTfCheck,lTfNext,lTfPick,
  lTogglePause,
};
