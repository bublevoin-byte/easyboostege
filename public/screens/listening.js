/*
 * Экран «Аудирование» (scr4). Приезжает динамическим import() при первом переходе на него.
 *
 * Проигрыватель и его запасная озвучка остались в оболочке: их настраивает tts.js при старте,
 * и говорение пользуется ими, ни разу не открыв аудирование.
 */
import {registerRouteHook} from '../router.js';
import {lPlayListeningSet,lStop} from '../tts.js';
import '../modules/listening.js';
import '../modules/exam.js';
import {prepareVoiceTutorContextResult,registerVoiceTutorContextResult} from '../voice-tutor-loader.js';
import {
  LSLOW,L_PLAYSVG,S,SRV,TOKEN,WBTN,currentOwnerBinding,examModule,gExamFmt,generateAiContent,lSetSlow,lSt,
  lSync,listeningModule,registerAuthorityReset,registerScreenGenerator,rWordsHtml,save,setTxt,toast,ui,wDeco,
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
  const d=await generateAiContent('listening_dialog');if(!d||!d.dialog||!d.q1||!d.q2)throw 0;
  LIS={title:d.title||'Новый диалог',dialog:d.dialog,q1:{q:d.q1.q||'1.',o:d.q1.o,a:d.q1.a||0},q2:{q:d.q2.q||'2.',o:d.q2.o,a:d.q2.a||0}};
  initListening()}
/* Состояние трёх заданий и счётчик прослушиваний живут вместе с экраном. */
let LM=null,LT=null,LI=null,LPLAYS=0,L_OWNER=null;
function lSameOwner(left,right){return Boolean(left&&right&&left.username===right.username&&left.generation===right.generation)}
function lCaptureOwner(){L_OWNER=currentOwnerBinding();return L_OWNER}
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
function lAnim(name,dur){ui.animate('l_card',name,dur)}
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
function lPlay(lines){LPLAYS++;var session=LM&&!LM.done?LM:(LT&&!LT.done?LT:(LI&&!LI.done?LI:null));
  if(session&&session.evidence){if(LSLOW){session.help.slowPlayback=true;session.evidence.helpUsed=true}
    session.help.additionalPlaybacks=Math.max(session.help.additionalPlaybacks,LPLAYS-2);
    session.evidence.hintsUsed=Math.max(0,LPLAYS-2);if(session.evidence.hintsUsed)session.evidence.helpUsed=true}
  lPlaysUi();lPlayListeningSet(session&&session.set,lines,function(status){lMarkPlaybackHelp(session,status)})}
function lPlaysUi(){var el=document.getElementById('l_plays');if(!el)return;
  el.textContent=LPLAYS<=2?('прослушиваний: '+LPLAYS+' из 2'):(LPLAYS+'-е — на ЕГЭ так нельзя!');
  el.style.color=LPLAYS<=2?'#1D7F4A':'#A56000';el.style.background=LPLAYS<=2?'#EAF7F0':'#FFF4DE'}
function lCtl(fn){
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    +'<button id="l_playbtn" class="sq" onclick="'+fn+'" style="flex:1;min-width:160px;min-height:54px;display:inline-flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,#FFA570,#F2683F);border:none;border-radius:18px;padding:0 18px;font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#fff;cursor:pointer;box-shadow:0 12px 26px rgba(242,104,63,.35),inset 0 2px 3px rgba(255,255,255,.4),inset 0 -4px 8px rgba(190,55,18,.28);">'
    +'<span id="l_playic" style="display:grid;place-items:center;width:22px;">'+L_PLAYSVG+'</span><span id="l_playtx">Слушать</span></button>'
    +'<button type="button" class="sq" aria-label="Остановить воспроизведение" onclick="lStop()" style="flex:none;width:40px;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:#fff;cursor:pointer;display:grid;place-items:center;"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="#8A8F98"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>'
    +'<button class="sq" onclick="lToggleSlow(this)" style="flex:none;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:'+(LSLOW?'#FFEDE4':'#fff')+';color:'+(LSLOW?'#E44E20':'#8A8F98')+';padding:0 13px;font-family:Manrope,sans-serif;font-weight:800;font-size:12px;cursor:pointer;">0.7×</button>'
    +'<span id="l_plays" style="flex:none;font-weight:800;font-size:11px;padding:7px 11px;border-radius:14px;color:#6A6E75;background:#F1F2F4;">прослушиваний: 0 из 2</span>'
    +'<span id="l_audio_source" role="status" aria-live="polite" style="flex-basis:100%;font-weight:700;font-size:11px;color:#A56000;">Тренировочная синтезированная озвучка</span></div>'}
function lTranscript(lines,evs){
  return '<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">ТРАНСКРИПТ · тапни слово для перевода</span>'
    +lines.map(function(ln){
      var hl=(evs||[]).some(function(ev){return ev&&ln.t.indexOf(ev.replace(/^…/,'').replace(/…$/,'').replace(/\.$/,'').slice(0,25))>=0});
      return '<div style="margin-top:8px;font-weight:500;font-size:13px;line-height:1.6;color:#2B2B2B;'+(hl?'background:#FFF4DE;border-radius:8px;padding:5px 8px;':'')+'">'
        +'<b style="color:'+(ln.s?'#3E93A8':'#F2683F')+';">—</b> '+rWordsHtml(ln.t)+'</div>'}).join('')+'</div>'}
function lLoadMatchingCatalog(){
  if(L_MATCHING_CATALOG_LOAD)return L_MATCHING_CATALOG_LOAD;
  L_MATCHING_CATALOG_LOAD=loadMatchingCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetMatchingCatalog);
  return L_MATCHING_CATALOG_LOAD}
function lSetMatchingCatalog(sets){
  L_MATCHING_CATALOG=sets.map(function(set){return set.st?set:matchingSetForLegacyScreen(set)});
  L_MATCHING_CATALOG_READY=true;
  return L_MATCHING_CATALOG}
function lLoadTrueFalseCatalog(){
  if(L_TRUE_FALSE_CATALOG_LOAD)return L_TRUE_FALSE_CATALOG_LOAD;
  L_TRUE_FALSE_CATALOG_LOAD=loadTrueFalseCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetTrueFalseCatalog);
  return L_TRUE_FALSE_CATALOG_LOAD}
function lSetTrueFalseCatalog(sets){
  L_TRUE_FALSE_CATALOG=sets.map(function(set){return set.st?set:trueFalseSetForLegacyScreen(set)});
  L_TRUE_FALSE_CATALOG_READY=true;
  return L_TRUE_FALSE_CATALOG}
function lLoadInterviewCatalog(){
  if(L_INTERVIEW_CATALOG_LOAD)return L_INTERVIEW_CATALOG_LOAD;
  L_INTERVIEW_CATALOG_LOAD=loadInterviewCatalog(function(){return import('../listening-pilot-v1.js')})
    .then(lSetInterviewCatalog);
  return L_INTERVIEW_CATALOG_LOAD}
function lSetInterviewCatalog(sets){
  L_INTERVIEW_CATALOG=sets.map(function(set){return set.qs?set:interviewSetForLegacyScreen(set)});
  L_INTERVIEW_CATALOG_READY=true;
  return L_INTERVIEW_CATALOG}
function initListening(){if(!S)return;void prepareLearningActivityRecording().catch(()=>{});lSync();Promise.all([
  lLoadMatchingCatalog(),lLoadTrueFalseCatalog(),lLoadInterviewCatalog(),
]).then(function(){if(LE&&lExamResume())return;if(!LM&&!LT&&!LI&&!LE)lHub()})}
function lHub(){var area=document.getElementById('l_area');if(!area)return;LM=null;LT=null;LI=null;L_OWNER=null;lStop();
  var r=lSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var examMax=lExamMaxScore();
  function acc(x){return x.tot?Math.round(x.ok/x.tot*100)+'%':'—'}
  function card(fn,title,sub,chip,color,bg){
    return '<button type="button" class="clayCard sq clk cardbtn" onclick="'+fn+'" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">'+title+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">'+sub+'</div></div>'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:'+color+';background:'+bg+';padding:8px 12px;border-radius:14px;">'+chip+'</span></div></button>'}
  var le=S.lisExam||{};
  var exCard='<button type="button" class="sq clk cardbtn" onclick="lExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
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
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 1–9</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(le.n?('лучший результат: '+le.best+' из '+examMax):'три задания подряд · запись дважды')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  area.innerHTML=exCard
    +card('lMt()','Соответствия','задание 1 · кто о чём говорит',acc(r.m),'#E44E20','#FFEDE4')
   +card('lTf()','Верно · Неверно · Не сказано','задание 2 · диалог и утверждения',acc(r.tf),'#C77400','#FFF4DE')
   +card('lIq()','Интервью','задания 3–9 · вопросы с выбором',acc(r.iq),'#1F8A50','#EAF7F0')
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#E3F1F5;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#3E93A8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Сначала прочитай вопросы, потом слушай — как на экзамене. Запись можно включить дважды</div></div>';
  setTxt('l_today','3 тренажёра');lGen()}
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
function lMt(){if(!L_MATCHING_CATALOG_READY){lLoadMatchingCatalog().then(function(){lMt()});return}
  var set=lShufM(lSelectCatalogSet(lMatchingPool(),'matching'));
  lCaptureOwner();
  LM={set:set,sel:set.sp.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('matching',set)};LPLAYS=0;lMtRender()}
function lMtLines(){return LM.set.sp.map(function(sp,i){return {s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}})}
function lMtRender(){var area=document.getElementById('l_area');var set=LM.set;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 1 · СООТВЕТСТВИЯ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай утверждения, послушай шесть говорящих и подбери соответствия. Одно утверждение лишнее.</div>'
    +set.st.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+(i+1)+'.</b> '+x+'</div>'}).join('')
    +lCtl('lPlay(lMtLines())')+'</div>';
  set.sp.forEach(function(_,si){var L=lSpeakerLabel(si);
    h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;">'
      +'<div style="display:flex;align-items:center;gap:8px;">'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:82px;">Говорящий '+L+'</span>'
      +'<div style="flex:1;display:flex;gap:7px;" id="lmt_row_'+si+'">'
      +set.st.map(function(_,ti){var on=LM.sel[si]===ti;
        return '<button onclick="lMtPick('+si+','+ti+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+(ti+1)+'</button>'}).join('')
      +'</div></div><div id="lmt_res_'+si+'"></div></div>'});
  var all=LM.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lMtCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LM.sel.filter(function(x){return x!==null}).length+' / '+set.sp.length+' выбрано')}
function lMtPick(si,ti){if(LM.done)return;
  LM.sel=listeningModule.selectUnique(LM.sel,si,ti);
  lMtRender()}
function lMtCheck(){if(LM.done)return;LM.done=true;lStop();var set=LM.set,r=lSt(),okn=0;
  set.sp.forEach(function(_,si){var L=lSpeakerLabel(si),ok=LM.sel[si]===set.a[si];if(ok)okn++;
    r.m.tot++;if(ok)r.m.ok++;
    var el=document.getElementById('lmt_res_'+si);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно ')+(set.a[si]+1)+'. '+set.st[set.a[si]]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Ключ:</b> '+set.k[si]+'</div></div>';
    var row=document.getElementById('lmt_row_'+si);if(row)row.style.pointerEvents='none'});
  var used={};set.a.forEach(function(x){used[x]=1});
  var extra=set.st.map(function(_,i){return i}).find(function(i){return !used[i]});
  var maxScore=lMatchingMax(set);
  r.done++;lSync();lCompleteHistory(LM,okn,maxScore);save();recordLearningActivityEvidence(LM.evidence,{score:okn,maxScore:maxScore}).catch(function(){});
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===maxScore?'🏆':(okn>=Math.ceil(maxScore/2)?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из '+maxScore+'</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишнее утверждение: '+(extra+1)+'. '+set.st[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lMt()">Ещё подход</button></div>'
    +lTranscript(lMtLines(),[]);
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- задание 2: True/False/Not stated ---- */
function lTf(){if(!L_TRUE_FALSE_CATALOG_READY){lLoadTrueFalseCatalog().then(function(){lTf()});return}
  var set=lSelectCatalogSet(lTrueFalsePool(),'true_false');
  lCaptureOwner();
  LT={set:set,sel:set.st.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('true_false',set)};LPLAYS=0;lTfRender()}
function lTfRender(){var area=document.getElementById('l_area');var set=LT.set;
  var LBL=['Верно','Неверно','Не сказано'];
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 2 · ВЕРНО / НЕВЕРНО / НЕ СКАЗАНО</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай утверждения, послушай диалог и реши: верно, неверно или об этом не говорилось.</div>'
    +lCtl('lPlay(LT.set.d)')+'</div>';
  set.st.forEach(function(x,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+x.t+'</div>'
      +'<div style="margin-top:9px;display:flex;gap:7px;" id="ltf_row_'+i+'">'
      +LBL.map(function(l,li){var on=LT.sel[i]===li;
        return '<button onclick="lTfPick('+i+','+li+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:11.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+l+'</button>'}).join('')
      +'</div><div id="ltf_res_'+i+'"></div></div>'});
  var all=LT.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lTfCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LT.sel.filter(function(x){return x!==null}).length+' / '+set.st.length+' отмечено')}
function lTfPick(i,li){if(LT.done)return;LT.sel[i]=li;lTfRender()}
function lTfCheck(){if(LT.done)return;LT.done=true;lStop();var set=LT.set,r=lSt(),okn=0;
  var LBL=['Верно','Неверно','Не сказано'];
  set.st.forEach(function(x,i){var ok=LT.sel[i]===x.a;if(ok)okn++;
    r.tf.tot++;if(ok)r.tf.ok++;
    var el=document.getElementById('ltf_res_'+i);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно: ')+LBL[x.a]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>В записи:</b> «'+x.ev+'» — '+x.e+'</div></div>';
    var row=document.getElementById('ltf_row_'+i);if(row)row.style.pointerEvents='none'});
  r.done++;lSync();lCompleteHistory(LT,okn,set.st.length);save();recordLearningActivityEvidence(LT.evidence,{score:okn,maxScore:set.st.length}).catch(function(){});
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===set.st.length?'🏆':(okn>=3?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из '+set.st.length+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lTf()">Ещё подход</button></div>'
    +lTranscript(set.d,set.st.map(function(x){return x.ev}));
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- задания 3-9: интервью ---- */
function lIq(){if(!L_INTERVIEW_CATALOG_READY){lLoadInterviewCatalog().then(function(){lIq()});return}
  var set=lSelectCatalogSet(lInterviewPool(),'interview');
  lCaptureOwner();
  LI={set:set,sel:set.qs.map(function(){return null}),done:false,help:lHelp(),evidence:lAttemptEvidence('interview',set)};LPLAYS=0;lIqRender()}
function lIqRender(){var area=document.getElementById('l_area');var set=LI.set;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 3–9 · ИНТЕРВЬЮ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай вопросы, послушай интервью и выбери ответы.</div>'
    +lCtl('lPlay(LI.set.d)')+'</div>';
  set.qs.forEach(function(q,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+lInterviewNumber(i)+'. '+q.q+'</div>'
      +'<div style="margin-top:9px;display:flex;flex-direction:column;gap:7px;" id="liq_row_'+i+'">'
      +q.o.map(function(o,oi){var on=LI.sel[i]===oi;
        return '<button onclick="lIqPick('+i+','+oi+')" style="text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:700;font-size:12.5px;color:'+(on?'#E44E20':'#5b5f66')+';cursor:pointer;">'+o+'</button>'}).join('')
      +'</div><div id="liq_res_'+i+'"></div></div>'});
  var all=LI.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lIqCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LI.sel.filter(function(x){return x!==null}).length+' / '+set.qs.length+' отвечено')}
function lIqPick(i,oi){if(LI.done)return;LI.sel[i]=oi;lIqRender()}
function lIqCheck(){if(LI.done)return;LI.done=true;lStop();var set=LI.set,r=lSt(),okn=0;
  var voiceResult=prepareVoiceTutorContextResult({module:'listening',set:set,selections:LI.sel});
  set.qs.forEach(function(q,i){var ok=LI.sel[i]===q.a;if(ok)okn++;
    r.iq.tot++;if(ok)r.iq.ok++;
    var el=document.getElementById('liq_res_'+i);
    var voiceSlot=voiceResult?voiceResult.resultSlot(q,i):'';
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно':'Правильно: '+q.o[q.a])+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>В записи:</b> «'+q.ev+'» — '+q.e+'</div>'+voiceSlot+'</div>';
    var row=document.getElementById('liq_row_'+i);if(row)row.style.pointerEvents='none'});
  r.done++;lSync();lCompleteHistory(LI,okn,set.qs.length);save();recordLearningActivityEvidence(LI.evidence,{score:okn,maxScore:set.qs.length}).catch(function(){});
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===set.qs.length?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из '+set.qs.length+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lIq()">Ещё подход</button></div>'
    +lTranscript(set.d,set.qs.map(function(q){return q.ev}));
  area.insertBefore(d,area.firstChild);
  if(voiceResult)registerVoiceTutorContextResult(voiceResult).catch(function(){});
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- экзамен по аудированию: 1 + 2 + 3-9 ---- */
let LE=null;
function lExam(){var area=document.getElementById('l_area');if(!area)return;lStop();
  var st=S.lisExam||{},maxScore=lExamMaxScore();
  area.innerHTML='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Раздел «Аудирование» целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Соответствия → верно/неверно/не сказано → интервью. Каждую запись можно включить только дважды, разбор — в конце. Максимум '+maxScore+' баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из '+maxScore+' · лучший: '+st.best+' из '+maxScore+'</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="lExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="lHub()">← К аудированию</button></div>';
  lAnim('win','.32s')}
function lExamStart(){
  var pm=lMatchingPool(),pt=lTrueFalsePool(),pi=lInterviewPool();
  var startedAt=Date.now(),m=lShufM(lSelectCatalogSet(pm,'matching')),
      tf=lSelectCatalogSet(pt,'true_false'),iq=lSelectCatalogSet(pi,'interview');
  lCaptureOwner();
  LE={m:m,tf:tf,iq:iq,stage:0,selM:m.a.map(function(){return null}),plays:[0,0,0],t0:startedAt,
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
  LE.iv=setInterval(function(){if(LE)setTxt('l_today',gExamFmt(Math.floor((Date.now()-LE.t0)/1000)))},1000);
  lExamRender()}
function lExamPause(){if(!LE)return false;if(LE.iv)clearInterval(LE.iv);LE.iv=null;
  if(!Number.isFinite(LE.pausedAt))LE.pausedAt=Date.now();lStop();return true}
function lExamResume(){if(!LE)return false;if(!lSameOwner(L_OWNER,currentOwnerBinding())){LE=null;L_OWNER=null;return false}
  var now=Date.now();if(Number.isFinite(LE.pausedAt)){LE.t0+=Math.max(0,now-LE.pausedAt);LE.pausedAt=null}
  if(!LE.iv)LE.iv=setInterval(function(){if(LE)setTxt('l_today',gExamFmt(Math.floor((Date.now()-LE.t0)/1000)))},1000);
  lExamRender();return true}
function lExamPlay(){if(!LE)return;
  if(!listeningModule.registerPlay(LE.plays,LE.stage,2)){try{toast('На ЕГЭ запись звучит только дважды')}catch(e){}return}
  var evidence=LE.stage===0?LE.evidence.gist:LE.evidence.detail;
  var help=LE.stage===0?LE.help.matching:(LE.stage===1?LE.help.true_false:LE.help.interview);
  if(LSLOW){help.slowPlayback=true;evidence.helpUsed=true}
  var set=LE.stage===0?LE.m:(LE.stage===1?LE.tf:LE.iq);
  var lines=LE.stage===0?LE.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}}):(LE.stage===1?LE.tf.d:LE.iq.d);
  lPlayListeningSet(set,lines,function(status){if(status!=='static'){help.synthFallback=true;evidence.helpUsed=true}});
  var el=document.getElementById('lex_plays');
  if(el){el.textContent='прослушиваний: '+LE.plays[LE.stage]+' из 2';
    el.style.color=LE.plays[LE.stage]>=2?'#A56000':'#1D7F4A';el.style.background=LE.plays[LE.stage]>=2?'#FFF4DE':'#EAF7F0'}}
function lExamCtl(){
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    +'<button id="l_playbtn" class="sq" onclick="lExamPlay()" style="flex:1;min-width:160px;min-height:54px;display:inline-flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,#FFA570,#F2683F);border:none;border-radius:18px;padding:0 18px;font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#fff;cursor:pointer;box-shadow:0 12px 26px rgba(242,104,63,.35),inset 0 2px 3px rgba(255,255,255,.4),inset 0 -4px 8px rgba(190,55,18,.28);">'
    +'<span id="l_playic" style="display:grid;place-items:center;width:22px;">'+L_PLAYSVG+'</span><span id="l_playtx">Слушать</span></button>'
    +'<button type="button" class="sq" aria-label="Остановить воспроизведение" onclick="lStop()" style="flex:none;width:40px;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:#fff;cursor:pointer;display:grid;place-items:center;"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="#8A8F98"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>'
    +'<span id="lex_plays" style="flex:none;font-weight:800;font-size:11px;padding:7px 11px;border-radius:14px;color:'+(LE.plays[LE.stage]>=2?'#C77400':'#1F8A50')+';background:'+(LE.plays[LE.stage]>=2?'#FFF4DE':'#EAF7F0')+';">прослушиваний: '+LE.plays[LE.stage]+' из 2</span>'
    +'<span id="l_audio_source" role="status" aria-live="polite" style="flex-basis:100%;font-weight:700;font-size:11px;color:#A56000;">Тренировочная синтезированная озвучка</span></div>'}
function lExamNextBtn(ok,label,fn){
  return '<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:4px;'+(ok?'':'opacity:.45;pointer-events:none;')+'" onclick="'+fn+'">'+label+'</button>'}
function lExamRender(){var area=document.getElementById('l_area');if(!area||!LE)return;
  if(LE.stage===0){var set=LE.m;
    var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 1 ИЗ 3 · СООТВЕТСТВИЯ</span>'
      +set.st.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+(i+1)+'.</b> '+x+'</div>'}).join('')
      +lExamCtl()+'</div>';
    set.sp.forEach(function(_,si){var L=lSpeakerLabel(si);
      h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;">'
        +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:82px;">Говорящий '+L+'</span>'
        +'<div style="flex:1;display:flex;gap:7px;">'
        +set.st.map(function(_,ti){var on=LE.selM[si]===ti;
          return '<button aria-label="Говорящий '+L+', утверждение '+(ti+1)+'" onclick="LE.selM['+si+']='+ti+';lExamDedup(\'selM\','+si+','+ti+');lExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+(ti+1)+'</button>'}).join('')+'</div></div>'});
    h+=lExamNextBtn(LE.selM.every(function(x){return x!==null}),'Дальше → верно/неверно','lStop();LE.stage=1;lExamRender()');
    area.innerHTML=h;return}
  if(LE.stage===1){var set=LE.tf,LBL=['Верно','Неверно','Не сказано'];
    var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 2 ИЗ 3 · ВЕРНО / НЕВЕРНО / НЕ СКАЗАНО</span>'
      +lExamCtl()+'</div>';
    set.st.forEach(function(x,i){
      h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
        +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+x.t+'</div>'
        +'<div style="margin-top:9px;display:flex;gap:7px;">'
        +LBL.map(function(l,li){var on=LE.selT[i]===li;
          return '<button onclick="LE.selT['+i+']='+li+';lExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:11.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+l+'</button>'}).join('')+'</div></div>'});
    h+=lExamNextBtn(LE.selT.every(function(x){return x!==null}),'Дальше → интервью','lStop();LE.stage=2;lExamRender()');
    area.innerHTML=h;return}
  var set=LE.iq;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 3 ИЗ 3 · ИНТЕРВЬЮ</span>'
    +lExamCtl()+'</div>';
  set.qs.forEach(function(q,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+lInterviewNumber(i)+'. '+q.q+'</div>'
      +'<div style="margin-top:9px;display:flex;flex-direction:column;gap:7px;">'
      +q.o.map(function(o,oi){var on=LE.selI[i]===oi;
        return '<button onclick="LE.selI['+i+']='+oi+';lExamRender()" style="text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:700;font-size:12.5px;color:'+(on?'#E44E20':'#5b5f66')+';cursor:pointer;">'+o+'</button>'}).join('')+'</div></div>'});
  h+=lExamNextBtn(LE.selI.every(function(x){return x!==null}),'Завершить','lExamFinish()');
  area.innerHTML=h}
function lExamDedup(field,idx,val){LE[field]=listeningModule.selectUnique(LE[field],idx,val)}
function lExamFinish(){if(!LE)return;clearInterval(LE.iv);lStop();
  var endedAt=Date.now(),sec=examModule.elapsedSeconds(LE.t0,endedAt),r=lSt(),LBL=['Верно','Неверно','Не сказано'];
  var matchingMax=lMatchingMax(LE.m),trueFalseMax=LE.tf.st.length,interviewMax=LE.iq.qs.length;
  var voiceResult=prepareVoiceTutorContextResult({module:'listening',set:LE.iq,selections:LE.selI});
  var okM=0;LE.m.a.forEach(function(a,si){r.m.tot++;if(LE.selM[si]===a){okM++;r.m.ok++}});
  var okT=0;LE.tf.st.forEach(function(x,i){r.tf.tot++;if(LE.selT[i]===x.a){okT++;r.tf.ok++}});
  var okI=0;LE.iq.qs.forEach(function(q,i){r.iq.tot++;if(LE.selI[i]===q.a){okI++;r.iq.ok++}});
  var total=okM+okT+okI;
  lCompleteHistory({set:LE.m,help:LE.help.matching},okM,matchingMax,endedAt);
  lCompleteHistory({set:LE.tf,help:LE.help.true_false},okT,trueFalseMax,endedAt);
  lCompleteHistory({set:LE.iq,help:LE.help.interview},okI,interviewMax,endedAt);
  listeningModule.examEvidenceSlices({matching:okM,matchingMax:matchingMax,trueFalse:okT,
    trueFalseMax:trueFalseMax,interview:okI,interviewMax:interviewMax},Math.max(0,endedAt-LE.t0))
    .forEach(function(slice){var evidence=slice.activityId===listeningModule.activityId('matching')?LE.evidence.gist:LE.evidence.detail;
      recordLearningActivityEvidence(evidence,{score:slice.score,maxScore:slice.maxScore,durationMs:slice.durationMs}).catch(function(){})});
  S.lisExam=examModule.record(S.lisExam,total);
  var rows='';
  LE.m.a.forEach(function(a,si){if(LE.selM[si]!==a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Говорящий '+lSpeakerLabel(si)+' → '+(a+1)+'. '+LE.m.st[a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+LE.m.k[si]+'</div></div>'});
  LE.tf.st.forEach(function(x,i){if(LE.selT[i]!==x.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Утверждение '+(i+1)+' → '+LBL[x.a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+x.ev+'» — '+x.e+'</div></div>'});
  LE.iq.qs.forEach(function(q,i){if(LE.selI[i]!==q.a){var voiceSlot='';
    if(voiceResult)voiceSlot=voiceResult.resultSlot(q,i);
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Вопрос '+lInterviewNumber(i)+' → '+q.o[q.a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+q.ev+'» — '+q.e+'</div>'+voiceSlot+'</div>'}});
  var tr1=lTranscript(LE.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+lSpeakerLabel(i)+'. '+sp.t}}),[]);
  var tr2=lTranscript(LE.tf.d,LE.tf.st.map(function(x){return x.ev}));
  var tr3=lTranscript(LE.iq.d,LE.iq.qs.map(function(q){return q.ev}));
  LE=null;r.done++;lSync();save();
  var parts=[['Соответствия',okM,matchingMax],['Верно/неверно',okT,trueFalseMax],['Интервью',okI,interviewMax]];
  var max=examModule.maxScore(parts),weak=examModule.weakestSection(parts);
  var area=document.getElementById('l_area');
  area.innerHTML='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(total,max)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+total+' из '+max+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+' · '+examModule.sectionLine(parts)+'</div>'
    +(total<max?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+weak.label.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div>'+(rows?'<div style="margin-top:12px;">'+rows+'</div>':'')+'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="lExamStart()">Ещё раз</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="lHub()">К аудированию</button></div>'
    +tr1+tr2+tr3;
  if(voiceResult)registerVoiceTutorContextResult(voiceResult).catch(function(){});
  lAnim('win','.32s');lGen()}
/* ---- фоновая ИИ-генерация комплектов аудирования ---- */
function lPool(kind,base){var ai=(S&&S.lisAi&&S.lisAi[kind])||[];
  if(kind==='iq')ai=ai.filter(function(set){return set&&set.voice&&set.qs&&set.qs.every(function(q){return q.voice})});
  return listeningModule.pool(base,ai)}
var L_GEN=false;
async function lGen(){
  if(L_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.lisAi=S.lisAi||{m:[],tf:[],iq:[]};
  var kind=null;
  if(lMatchingPool().length<5)kind='m';
  else if(lTrueFalsePool().length<5)kind='tf';
  else if(lInterviewPool().length<5)kind='iq';
  if(!kind)return;L_GEN=true;
  try{
    var d,item=null;
    if(kind==='m'){
      d=await generateAiContent('listening_matching');
      if(d&&Array.isArray(d.st)&&d.st.length===5&&Array.isArray(d.sp)&&d.sp.length===4
        &&Array.isArray(d.a)&&d.a.length===4&&d.a.every(function(x){return x>=0&&x<5})&&new Set(d.a.map(Number)).size===4
        &&Array.isArray(d.k)&&d.k.length===4&&d.sp.every(function(s){return s&&s.t})){
        item={st:d.st.map(String),sp:d.sp.map(function(s){return{t:String(s.t)}}),a:d.a.map(Number),k:d.k.map(String)}}
    }else if(kind==='tf'){
      d=await generateAiContent('listening_true_false');
      if(d&&Array.isArray(d.d)&&d.d.length>=5&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.st)&&d.st.length===5
        &&d.st.every(function(x){return x&&x.t&&x.a>=0&&x.a<3&&x.ev&&x.e})
        &&d.st.some(function(x){return +x.a===2})){
        item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),st:d.st.map(function(x){return{t:String(x.t),a:+x.a,ev:String(x.ev),e:String(x.e)}})}}
    }else{
      d=await generateAiContent('listening_interview');
      if(d&&Array.isArray(d.d)&&d.d.length>=6&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.qs)&&d.qs.length===4
        &&d.qs.every(function(q){return q&&q.q&&Array.isArray(q.o)&&q.o.length===3&&q.a>=0&&q.a<3&&q.ev&&q.e})){
        var voice=d.voice_tutor,hasVoice=voice&&voice.set_id&&voice.revision===1&&Array.isArray(voice.item_ids)&&voice.item_ids.length===4;
        if(hasVoice)item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),voice:{id:String(voice.set_id),revision:1},qs:d.qs.map(function(q,i){return{q:String(q.q),o:q.o.map(String),a:+q.a,ev:String(q.ev),e:String(q.e),voice:{id:String(voice.item_ids[i]),revision:1}}})}}
    }
    if(item){S.lisAi[kind]=(S.lisAi[kind]||[]).concat([item]);save()}
  }catch(e){}
  L_GEN=false;
  try{var need=lMatchingPool().length<5||lTrueFalsePool().length<5||lInterviewPool().length<5;
    if(need)setTimeout(lGen,4000)}catch(e){}}
registerRouteHook(function(id){if(id==='scr4')initListening()});
/* Экзамен по аудированию не должен тикать в фоне после ухода с экрана. */
registerRouteHook(function(id){if(id!=='scr4')lExamPause()});
registerScreenGenerator('scr4',genListening);
registerAuthorityReset(function(authority){
  if(!L_OWNER||authority?.owner!==L_OWNER.username||authority?.ownerGeneration!==L_OWNER.generation)return;
  if(LE?.iv)clearInterval(LE.iv);lStop();LM=null;LT=null;LI=null;LE=null;L_OWNER=null;LPLAYS=0;
});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  LE,LI,LT,
  hasActiveListeningPractice,
  lExam,lExamDedup,lExamFinish,lExamPlay,lExamRender,lExamStart,lHub,lIq,lIqCheck,lIqPick,
  lMt,lMtCheck,lMtLines,lMtPick,lPlay,lTf,lTfCheck,lTfPick,
};
