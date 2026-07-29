/*
 * Экран «Говорение» (scr9). Приезжает динамическим import() при первом переходе на него.
 * Озвучку и её остановку берём у общего проигрывателя оболочки — чанк аудирования для этого
 * загружать не нужно.
 */
import {registerRouteHook} from '../router.js';
import {lPlayRaw,lStop} from '../tts.js';
import {
  S,SRV,TOKEN,WBTN,apiMessage,apiPost,apiPostBinary,examModule,generateAiContent,save,
  setTxt,spSt,spSync,speakingModule,toast,ui,wDeco,
} from '../app.js';

/* ===== SPEAKING v2: устная часть ЕГЭ, 4 задания ===== */
const SP1=[
{tx:'Libraries are changing fast. Twenty years ago they were quiet places with paper books only. Today a modern library offers computers, online courses and clubs for different hobbies. People come here not only to read, but also to meet friends, work on projects or listen to interesting lectures. Many libraries stay open late in the evening, so students often do their homework there. Scientists say that such places help people of all ages to keep learning through the whole life.'},
{tx:'Walking is the easiest kind of sport. You do not need special equipment, a gym or a trainer — only comfortable shoes. Doctors say that thirty minutes of walking a day make the heart stronger, improve sleep and even help the brain to work better. Walking with friends is also a great way to spend time together. Some schools now organise walking clubs, where students discover interesting places in their city and learn to notice the beauty around them.'}];
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
{topic:'Зимние каникулы',ph:['Фото 1: семья катается на лыжах в горах в солнечный день','Фото 2: девушка читает книгу у камина дома'],
 plan:['кратко опиши обе фотографии — что на них происходит','скажи, что общего у этих фотографий','скажи, чем они различаются','скажи, какой отдых ближе тебе, и объясни почему']},
{topic:'Еда дома и в кафе',ph:['Фото 1: мама с сыном вместе готовят ужин на кухне','Фото 2: друзья едят пиццу в кафе'],
 plan:['кратко опиши обе фотографии','скажи, что общего у фотографий','скажи, чем они различаются','скажи, что предпочитаешь ты, и объясни почему']}];
const SP_CONF={1:speakingModule.config(1),2:speakingModule.config(2),3:speakingModule.config(3),4:speakingModule.config(4)};
const SP_SHEET={
1:'<b>Как читать вслух на 1 балл:</b><br>— Во время подготовки прочитай текст про себя и отметь трудные слова.<br>— Читай по смысловым кусочкам, с паузами на запятых и точках.<br>— Не глотай окончания <i>-s</i> и <i>-ed</i>: he work<b>s</b>, play<b>ed</b>.<br>— Вопросы читай с восходящей интонацией, утверждения — с нисходящей.<br>— Лучше чуть медленнее, но чётко: ошибки в словах = потеря балла.',
2:'<b>Как задавать прямые вопросы:</b><br>Каждый пункт превращай в ПРЯМОЙ вопрос:<br>— цена → <i>How much does it cost?</i><br>— даты → <i>When does the course start?</i><br>— место → <i>Where is the club located?</i><br>— возможность → <i>Can I…? / Is it possible to…?</i><br><b>Ловушки:</b> «What about the price?» — НЕ вопрос, балл не дадут. Вопрос «зачитыванием пункта» (price?) — тоже. Нужен полный вопрос с вспомогательным глаголом.',
3:'<b>Как отвечать на вопросы интервью:</b><br>— Отвечай развёрнуто: 2-3 предложения, а не «Yes, I do».<br>— Формула: прямой ответ → причина → пример. <i>I usually read in my free time. It helps me to relax. For example, last week I finished a great detective story.</i><br>— Не молчи: если нужно время, начни с <i>Well, let me think…</i><br>— Следи за временем вопроса: «What did you do…» → отвечай в прошедшем.',
4:'<b>Скелет монолога (2,5–3 минуты):</b><br>1. Вступление: <i>I have found two photos for our project about…</i><br>2. Описание: <i>In the first photo we can see… In the second photo there is…</i><br>3. Общее: <i>Both photos show… / What these photos have in common is…</i><br>4. Различия: <i>The main difference is that… while…</i><br>5. Мнение: <i>As for me, I prefer… because…</i><br>6. Финал: <i>That is all I wanted to say.</i><br><b>Ловушка:</b> пропустил пункт плана — минус баллы за решение задачи.'};
let SP=null,SP_rec=null,SP_chunks=[],SP_tm=null,SP_sheet=false;
function spAnim(n,d){ui.animate('s9_card',n,d)}
function spMime(){return speakingModule.preferredMimeType(window.MediaRecorder)}
function spFmt(s){return speakingModule.formatTime(s)}
function spStopAll(){clearInterval(SP_tm);SP_tm=null;
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  try{lStop()}catch(e){}}
function spReleaseRecording(){if(SP&&SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}if(SP){SP.url=null;SP.blob=null}SP_chunks=[]}
function initSpeaking(){if(!S)return;spStopAll();spReleaseRecording();SP=null;spSync();spHub()}
function spHub(){var area=document.getElementById('s9_area');if(!area)return;
  var r=spSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var se=S.spkExam||{};
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
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(se.n?('лучший результат: '+se.best+' из '+speakingModule.EXAM_MAX):'4 задания подряд, оценка ИИ')+'</div></div>'
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
function spNextSet(t){S['spIdx'+t]=(S['spIdx'+t]||0)+1;save()}
function spOpen(t){spReleaseRecording();SP={t:t,set:spSet(t),phase:'intro',qi:0,url:null};SP_sheet=false;spRender()}
function spBtn(label,fn,solid){return '<button class="sq" style="'+WBTN+(solid?'background:linear-gradient(135deg,#FFA570,#F2683F);color:#fff;border:none;box-shadow:0 12px 24px rgba(242,104,63,.32);':'color:#B54E2F;')+'" onclick="'+fn+'">'+label+'</button>'}
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
  /* ---- интро ---- */
  if(SP.phase==='intro'){
    var body='';
    if(t===1)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Прочитай текст вслух. Подготовка — '+spFmt(c.prep)+', чтение — до '+spFmt(c.rec)+'.</div>';
    if(t===2)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Изучи объявление и задай <b>4 прямых вопроса</b> по пунктам. Подготовка — '+spFmt(c.prep)+', на каждый вопрос — 20 секунд.</div>';
    if(t===3)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Интервью на тему «'+set.topic+'». Услышишь 5 вопросов — на каждый отвечай развёрнуто, до 40 секунд. Подготовки нет, как на экзамене.</div>';
    if(t===4)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Голосовое сообщение другу: сравни две фотографии по плану. Подготовка — '+spFmt(c.prep)+', монолог — до '+spFmt(c.rec)+'.</div>';
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+c.sub.toUpperCase()+'</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:10px;">'+c.name+'</div>'
      +'<div style="margin-top:8px;">'+body+'</div>'
      +'<div style="margin-top:11px;display:flex;gap:8px;">'
      +'<button type="button" class="clk sq iconbtn" onclick="spNextSet(SP.t);spOpen(SP.t)" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Другой вариант</button>'
      +'<button type="button" class="clk sq iconbtn" onclick="spToggleSheet()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(SP_sheet?'Скрыть шпаргалку':'Шпаргалка')+'</button></div>'
      +(SP_sheet?'<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.65;">'+SP_SHEET[t]+'</div>':'')
      +'</div>'
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
       +'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Озвучить вопрос</button></div>'
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
    if(t===1)extra='<div style="height:10px;"></div>'+spBtn('🔊 Эталон диктора','spEtalon()');
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
      +(SP.blob?'<div style="height:10px;"></div><button class="sq" onclick="spEval(this)" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#6FC2B0,#1F9E5A)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(31,158,90,.3);">✨ Оценить с ИИ по критериям</button>':'')
      +(SP.blob?'<div style="height:10px;"></div>'+spBtn('Удалить запись','spDeleteRecording()'):'')
      +(SP.t>1?'<div style="height:10px;"></div>'+spBtn('Образец ответа от ИИ','spSample(this)'):'')
      +'<div id="sp_evalbox"></div>'
      +extra
      +'<div style="height:10px;"></div>'+spBtn('Ещё раз','spNextSet(SP.t);spOpen(SP.t)')
      +'<div style="height:10px;"></div>'+spBtn('К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');setTxt('s9_today',SP_CONF[t].name);return}}
function spTaskBody(){var t=SP.t,set=SP.set;
  if(t===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+set.tx+'</div>';
  if(t===2)return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+set.ad+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(i+1)+'. '+p+'</div>'}).join('');
  if(t===4)return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('');
  return ''}
function spPrep(){var c=SP_CONF[SP.t];
  if(!c.prep){spRec();return}
  SP.phase='prep';SP.left=c.prep;spRender();
  spTick(c.prep,function(){spRec()})}
async function spRec(){var c=SP_CONF[SP.t];
  clearInterval(SP_tm);
  spReleaseRecording();
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
function spFinish(){if(!SP)return;clearInterval(SP_tm);try{lStop()}catch(e){}
  var r=spSt();r['t'+SP.t].n++;spNextSet(SP.t);
  SP.phase='done';
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  spSync();save();spRender()}
var SP_audio=null;
function spPlay(){if(!SP||!SP.url)return;
  try{lStop()}catch(e){}
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  SP_audio=new Audio(SP.url);
  SP_audio.onerror=function(){try{toast('Не удалось воспроизвести запись — попробуй записать ещё раз')}catch(e){}};
  SP_audio.play().catch(function(){try{toast('Браузер не дал воспроизвести — нажми ещё раз')}catch(e){}})}
function spDeleteRecording(){if(!SP)return;if(SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}SP.url=null;SP.blob=null;SP_chunks=[];spRender();try{toast('Запись удалена')}catch(e){}}
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
    spShowEval(d,tr);
  }catch(e){
    if(btn){btn.textContent='✨ Оценить с ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'stt'))}catch(_){}}}
function spShowEval(d,tr){var box=document.getElementById('sp_evalbox');if(!box)return;
  /* всё, что пришло от модели или STT, попадает в DOM только экранированным */
  var safe=ui.escapeHtml;
  var pct=d.got/(d.max||1);
  var col=pct>=0.7?'#1F8A50':(pct>=0.4?'#C77400':'#C0392B');
  var h='<div class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-top:12px;animation:wflip .5s cubic-bezier(.25,.75,.35,1) both;">'
    +'<div style="text-align:center;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:30px;color:'+col+';">'+d.got+' из '+d.max+'</div>'
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
  h+='<div class="ai-disclaimer" style="margin-top:8px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">'+ui.escapeHtml(ui.AI_DISCLAIMER)+'</div>';
  h+='<details style="margin-top:12px;"><summary style="font-weight:700;font-size:12px;color:#777163;cursor:pointer;">Расшифровка твоей речи</summary>'
    +'<div style="margin-top:8px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">'+safe(tr)+'</div><button class="sq" onclick="spFlagTranscript()" style="margin-top:8px;border:0;background:#F4EFE9;padding:7px 10px;border-radius:10px;font-weight:700;font-size:11px;">Расшифровка неточная</button></details>'
    +'</div>';
  box.innerHTML=h;
  try{box.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}}
function spFlagTranscript(){S.sttFeedback=(S.sttFeedback||0)+1;save();try{toast('Спасибо, отметка сохранена')}catch(e){}}
async function spSample(btn){
  if(!SP)return;var t=SP.t,set=SP.set;
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
let SPE=null;
function spExam(){var area=document.getElementById('s9_area');if(!area)return;spStopAll();SP=null;
  var st=S.spkExam||{};
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Устная часть целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Чтение → вопросы → интервью → монолог, всё подряд с экзаменационными таймерами и без шпаргалок. Задания переключаются сами. В конце ИИ оценит каждую запись — максимум 20 баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из '+speakingModule.EXAM_MAX+' · лучший: '+st.best+' из '+speakingModule.EXAM_MAX+'</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn('Начать экзамен','speStart()',true)
    +spBtn('← К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s')}
function speStart(){
  S.spExIdx=(S.spExIdx||0);
  var sets={};speakingModule.TASKS.forEach(function(t){sets[t]=speakingModule.select(spPool(t),S.spExIdx)});
  S.spExIdx++;save();
  SPE={stage:1,sets:sets,blobs:{},qi:0,t0:Date.now(),tm:null};
  speStage()}
function speStage(){var c=SP_CONF[SPE.stage];
  if(c.prep){SPE.phase='prep';SPE.left=c.prep;speRender();
    speTick(c.prep,function(){speRec()})}
  else speRec()}
async function speRec(){var c=SP_CONF[SPE.stage];
  clearInterval(SPE.tm);
  try{
    var st=await navigator.mediaDevices.getUserMedia({audio:true});
    var mime=spMime();
    SPE.stream=st;SPE.chunks=[];SPE.rec=mime?new MediaRecorder(st,{mimeType:mime}):new MediaRecorder(st);
    SPE.rec.ondataavailable=function(e){SPE.chunks.push(e.data)};
    SPE.rec.start();
  }catch(e){SPE.rec=null;try{toast('Нет доступа к микрофону — задание будет без записи')}catch(_){}}
  SPE.phase='rec';SPE.left=c.rec;SPE.qi=0;speRender();
  if(SPE.stage===3){try{lPlayRaw([{s:1,t:SPE.sets[3].qs[0]}])}catch(e){}}
  speTick(c.rec,function(){SPE.stage===3?speNextQ():speEndStage()})}
function speNextQ(){if(!SPE)return;
  if(SPE.qi>=4){speEndStage();return}
  SPE.qi++;SPE.left=SP_CONF[3].rec;speRender();
  try{lPlayRaw([{s:1,t:SPE.sets[3].qs[SPE.qi]}])}catch(e){}
  speTick(SP_CONF[3].rec,function(){SPE.qi>=4?speEndStage():speNextQ()})}
function speEndStage(){if(!SPE)return;clearInterval(SPE.tm);try{lStop()}catch(e){}
  var done=function(){if(!SPE)return;
    if(SPE.stage<4){SPE.stage++;speStage()}else speFinish()};
  if(SPE.rec&&SPE.rec.state!=='inactive'){
    var stg=SPE.stage;
    SPE.rec.onstop=function(){if(!SPE)return;
      var tp=(SPE.rec&&SPE.rec.mimeType)||(SPE.chunks[0]&&SPE.chunks[0].type)||'';
      SPE.blobs[stg]=tp?new Blob(SPE.chunks,{type:tp}):new Blob(SPE.chunks);
      try{SPE.stream.getTracks().forEach(function(x){x.stop()})}catch(e){}
      done()};
    try{SPE.rec.stop()}catch(e){done()}}
  else done()}
function speTick(total,onEnd){clearInterval(SPE.tm);
  SPE.tm=setInterval(function(){if(!SPE){return}
    SPE.left--;setTxt('s9_timer',spFmt(SPE.left));
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SPE.left/total*100))+'%';
    setTxt('s9_today','задание '+SPE.stage+' · '+spFmt(SPE.left));
    if(SPE.left<=0){clearInterval(SPE.tm);onEnd()}},1000)}
function speTaskBody(){var t=SPE.stage,set=SPE.sets[t];
  if(t===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+set.tx+'</div>';
  if(t===2)return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+set.ad+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(i+1)+'. '+p+'</div>'}).join('');
  if(t===3)return '<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+(SPE.qi+1)+' из 5</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+set.qs[SPE.qi]+'</div>'
    +'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SPE.sets[3].qs[SPE.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Повторить вопрос</button></div>';
  return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('')}
function speRender(){var area=document.getElementById('s9_area');if(!area||!SPE)return;
  var c=SP_CONF[SPE.stage];
  var chip=SPE.phase==='prep'
    ?'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ПОДГОТОВКА</span>'
    :'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">● ЗАПИСЬ</span>';
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · '+SPE.stage+' ИЗ 4 · '+SP_CONF[SPE.stage].name.toUpperCase()+'</span>'+chip+'</div>'
    +speTaskBody()
    +'<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;">'
    +'<span id="s9_timer" style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;">'+spFmt(SPE.left)+'</span></div>'
    +'<div style="margin-top:8px;height:7px;border-radius:5px;background:#F1EDE7;"><div id="s9_tbar" style="width:100%;height:100%;border-radius:5px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'
    +'</div>'
    +(SPE.phase==='prep'
      ?spBtn('Готово — к записи','clearInterval(SPE.tm);speRec()',true)
      :(SPE.stage===3&&SPE.qi<4?spBtn('Следующий вопрос →','clearInterval(SPE.tm);speNextQ()',true):spBtn(SPE.stage<4?'Стоп — дальше':'Завершить экзамен','clearInterval(SPE.tm);speEndStage()',true)))}
async function speFinish(){if(!SPE)return;clearInterval(SPE.tm);try{lStop()}catch(e){}
  var sec=Math.floor((Date.now()-SPE.t0)/1000);
  var area=document.getElementById('s9_area');
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
    +'<div style="font-size:42px;">🎧</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Экзамен записан!</div>'
    +'<div id="spe_prog" style="font-weight:600;font-size:13px;color:#777163;margin-top:6px;">Начинаю проверку…</div>'
    +'<div style="margin-top:12px;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;border:3px solid #F1EDE7;border-top-color:#F2683F;animation:lspin .8s linear infinite;"></span></div></div>';
  var results={};
  for(var t=1;t<=4;t++){
    setTxt('spe_prog','Оцениваю задание '+t+' из 4…');
    var d=null,bl=SPE.blobs[t];
    if(bl){try{
      var tr=await spSTT(bl);
      if(speakingModule.isTranscriptUsable(tr)){
        var response=await apiPost('/api/v1/ai/evaluate-speaking',{taskType:t,transcript:tr,assignment:spAssignment(t,SPE.sets[t])},true);
        var p=response.review;
        if(p&&typeof p.got!=='undefined')d={got:speakingModule.clampScore(p,t).got,verdict:String(p.verdict||''),fix:Array.isArray(p.fix)?p.fix:[]}}
    }catch(e){}}
    if(!d)d={got:0,verdict:bl?'не удалось оценить запись':'записи нет',fix:[]};
    results[t]=d;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:t,g:d.got,m:SP_CONF[t].max,ts:Date.now()});
  }
  var got=speakingModule.examTotal(results);
  S.spkExam=examModule.record(S.spkExam,got);
  var r=spSt();r.t1.n++;r.t2.n++;r.t3.n++;r.t4.n++;
  spSync();save();
  var weak=speakingModule.weakestTask(results);
  var rows=[1,2,3,4].map(function(t){var d=results[t];
    return '<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="display:flex;justify-content:space-between;gap:10px;font-weight:700;font-size:13px;color:#2B2B2B;"><span>'+SP_CONF[t].name+'</span><b style="flex:none;color:'+(d.got/SP_CONF[t].max>=0.7?'#1F8A50':(d.got>0?'#C77400':'#C0392B'))+';">'+d.got+' / '+SP_CONF[t].max+'</b></div>'
      +(d.verdict?'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+d.verdict+'</div>':'')
      +(d.fix||[]).map(function(f){return '<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;">'+(f.wrong?'<s style="color:#A83226;">'+f.wrong+'</s> → ':'')+(f.right?'<b style="color:#1D7F4A;">'+f.right+'</b> ':'')+(f.note||'')+'</div>'}).join('')
      +'</div>'}).join('');
  SPE=null;
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(got,speakingModule.EXAM_MAX,speakingModule.BADGES)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:26px;color:#2B2B2B;margin-top:8px;">'+got+' из '+speakingModule.EXAM_MAX+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+spFmt(sec)+'</div>'
    +(got<speakingModule.EXAM_MAX?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+SP_CONF[weak].name.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div><div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn('Ещё раз','speStart()',true)
    +spBtn('К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s');spGen()}
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
    if(SP){spStopAll();SP=null}
    if(SPE){clearInterval(SPE.tm);try{if(SPE.rec&&SPE.rec.state!=='inactive')SPE.rec.stop()}catch(e){}try{SPE.stream&&SPE.stream.getTracks().forEach(function(x){x.stop()})}catch(e){}SPE=null}}});
registerRouteHook(function(id){if(id==='scr9')initSpeaking()});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  SP,SPE,
  initSpeaking,spDeleteRecording,spEtalon,spEval,spExam,spFinish,spFlagTranscript,spNextQ,
  spNextSet,spOpen,spPlay,spPrep,spRec,spSample,spStopAll,spToggleSheet,spVoiceSample,
  speEndStage,speNextQ,speRec,speStart,
};
