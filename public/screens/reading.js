/*
 * Экран «Чтение» (scr7). Приезжает динамическим import() при первом переходе на него.
 *
 * Слово из текста попадает в словарь ЕГЭ, поэтому чанк работает с той же SRS-бухгалтерией
 * оболочки, что и экран слов, — и открытие чтения не тянет за собой чанк слов.
 */
import {registerRouteHook} from '../router.js';
import {prepareVoiceTutorContextResult,registerVoiceTutorContextResult} from '../voice-tutor.js';
import {
  EGE_WORDS,S,SRV,TOKEN,WBTN,examModule,gExamFmt,generateAiContent,lastWord,readingModule,rEsc,
  rSt,rSync,rWordsHtml,registerScreenGenerator,save,setTxt,toast,ui,wBase,wDeco,wSync,
} from '../app.js';

const READ_TXT="Many students take a gap year before university. They travel, work or do volunteering. It can be a valuable experience that helps them become more independent and confident.";
let RTXT=READ_TXT;
async function genReading(){
  const d=await generateAiContent('reading_text');if(!d||!d.text)throw 0;RTXT=d.text;initReading()}
/* ===== READING v2: задание 10 + задания 12-18 + словарь в SRS ===== */
const R_HL=[
{hl:['A hobby for everyone','Dangers of city life','A new way to travel','Sport at school','Eating for health'],
 txts:[
 {t:'More and more teenagers choose cycling to get to school. It is cheap, fast and green. Some cities even build special lanes for young riders.',a:2,k:'cycling to get to school, special lanes — речь о способе добираться, то есть о передвижении.'},
 {t:'Doctors say that fruit and vegetables must be on your plate every day. A balanced diet gives you energy and protects you from illnesses.',a:4,k:'balanced diet, fruit and vegetables — про здоровое питание.'},
 {t:'Football, volleyball and athletics are part of the timetable in most Russian schools. PE lessons help students stay active and make friends.',a:3,k:'PE lessons, timetable — спорт именно в школе.'},
 {t:'Collecting stamps, drawing or playing chess — there is an activity for every character. The main thing is to find what you really enjoy.',a:0,k:'an activity for every character — хобби найдётся для каждого.'}]},
{hl:['A famous discovery','Learning languages online','Weather and mood','A family tradition','Protecting nature'],
 txts:[
 {t:'Every Sunday my grandmother bakes her special apple pie, and the whole family meets at her place. This custom is more than fifty years old.',a:3,k:'custom, every Sunday, the whole family — семейная традиция.'},
 {t:'Scientists say that sunny days make people happier and more active, while long rains can cause sadness and low energy.',a:2,k:'sunny days → happier; rains → sadness — связь погоды и настроения.'},
 {t:'Volunteers clean rivers and plant trees in our region every spring. They want to keep the local forests safe for animals and people.',a:4,k:'clean rivers, plant trees, keep forests safe — защита природы.'},
 {t:'With modern apps you can practise English anywhere: on the bus, at breakfast or before sleep. Short daily lessons work better than long ones.',a:1,k:'apps, practise English anywhere — изучение языка онлайн.'}]},
{hl:['A useful invention','Holiday plans','A school project','Reading habits','City transport problems'],
 txts:[
 {t:'Teenagers read fewer paper books today, but they read a lot online: articles, blogs and e-books. The way of reading has changed, not the love for it.',a:3,k:'read online, e-books — о том, КАК читают, то есть о привычках чтения.'},
 {t:'Next summer our class is going to the sea. We have already booked the hotel and planned excursions to two ancient towns.',a:1,k:'next summer, booked the hotel — планы на каникулы.'},
 {t:'Our students made a website about the history of our town. They interviewed old residents and collected photos from family albums.',a:2,k:'students made a website, interviewed — школьный проект.'},
 {t:'Traffic jams make people in big cities lose hours every day. Experts suggest developing the metro and building more bike lanes.',a:4,k:'traffic jams, metro, bike lanes — транспортные проблемы города.'}]}
];
const R_QS=[
{tx:'Many British students take a gap year before university. During this year they travel, work or volunteer in other countries. Supporters say that a gap year helps young people become independent and understand what they really want to study. However, some parents are afraid that after a long break their children will not want to return to studying. Universities report that gap-year students usually get better marks in the first year, because they are more motivated and organised. Experts advise planning the year carefully: a person who just stays at home often wastes time and loses study habits.',
 qs:[
 {q:'What do many British students do before university?',o:['They take exams again','They take a year off','They start full-time careers','They move abroad for good'],a:1,ev:'Many British students take a gap year before university.',e:'gap year — это год перерыва между школой и университетом.',voice:{id:'reading.gap-year.before-university',revision:1}},
 {q:'What are some parents afraid of?',o:['Money problems','Danger during travel','That children will not return to study','Bad school marks'],a:2,ev:'…some parents are afraid that after a long break their children will not want to return to studying.',e:'Страх родителей — что ребёнок не захочет вернуться к учёбе.'},
 {q:'According to universities, gap-year students usually…',o:['get better first-year marks','miss more lessons','choose easier subjects','leave university earlier'],a:0,ev:'Universities report that gap-year students usually get better marks in the first year…',e:'better marks in the first year — лучшие оценки на первом курсе.'},
 {q:'What do experts advise?',o:['To stay at home','To plan the year carefully','To avoid working','To skip the gap year'],a:1,ev:'Experts advise planning the year carefully…',e:'Главный совет экспертов — тщательно планировать год.'}]},
{tx:'Some schools in Europe have banned smartphones during lessons and breaks. Teachers noticed that students talk to each other more and play active games in the yard again. Not everyone is happy, though. Many parents want to be able to contact their children at any moment. Some students say phones help them study: they use dictionaries, calculators and educational apps. Scientists offer a compromise: keep phones in special boxes during lessons and return them after classes. In schools that tried this system, test results improved and the number of conflicts between students went down.',
 qs:[
 {q:'What happened after the smartphone ban?',o:['Students became lonely','Students talk and play more','Parents visited school more often','Lessons became longer'],a:1,ev:'…students talk to each other more and play active games in the yard again.',e:'Ученики стали больше общаться вживую и играть во дворе.'},
 {q:'Why are many parents unhappy about the ban?',o:['Phones are expensive','They cannot contact their children','Children play too much','Teachers became stricter'],a:1,ev:'Many parents want to be able to contact their children at any moment.',e:'Родителям важна возможность связаться с ребёнком в любой момент.'},
 {q:'How do phones help students, according to some of them?',o:['They give study tools','They help make friends','They improve sport results','They help fall asleep'],a:0,ev:'…they use dictionaries, calculators and educational apps.',e:'Словари, калькуляторы, учебные приложения — инструменты для учёбы.'},
 {q:'What compromise do scientists suggest?',o:['Shorter lessons','No homework','Phones in boxes during lessons','Moving school online'],a:2,ev:'…keep phones in special boxes during lessons and return them after classes.',e:'Компромисс — телефоны в коробках на время уроков.'}]},
{tx:'Last year more than a million Russian teenagers took part in volunteer projects. They helped animal shelters, visited elderly people and cleaned parks. Psychologists say that volunteering makes teenagers more confident and teaches them to work in a team. It can also help with a future career: universities pay attention to social activity, and some companies prefer candidates with volunteer experience. To become a volunteer, you do not need money or special skills — only free time and the wish to help. Most projects accept school students from the age of fourteen.',
 qs:[
 {q:'What did teenagers do as volunteers?',o:['They built new houses','They helped shelters and elderly people','They taught at schools','They worked only in hospitals'],a:1,ev:'They helped animal shelters, visited elderly people and cleaned parks.',e:'Приюты, пожилые люди, парки — именно это перечислено в тексте.'},
 {q:'What do psychologists say about volunteering?',o:['It takes too much time','It builds confidence and teamwork','It is dangerous for teens','It is only for adults'],a:1,ev:'…volunteering makes teenagers more confident and teaches them to work in a team.',e:'Уверенность и командная работа — эффект волонтёрства.'},
 {q:'How can volunteering help in the future?',o:['It guarantees any job','Universities and companies value it','It pays very well','It replaces school exams'],a:1,ev:'…universities pay attention to social activity, and some companies prefer candidates with volunteer experience.',e:'Вузы и работодатели ценят волонтёрский опыт — но не «гарантируют работу».'},
 {q:'What do you need to become a volunteer?',o:['Money','Special skills','Free time and the wish to help','A special diploma'],a:2,ev:'…you do not need money or special skills — only free time and the wish to help.',e:'Нужны только свободное время и желание помогать.'}]}
];
const R_VOICE_RESULT_SETS=[
  {id:'reading.exam.questions.gap-year',items:['reading.gap-year.before-university','reading.gap-year.parents-fear','reading.gap-year.first-year-marks','reading.gap-year.expert-advice']},
  {id:'reading.exam.questions.smartphones',items:['reading.smartphones.after-ban','reading.smartphones.parent-concern','reading.smartphones.study-tools','reading.smartphones.compromise']},
  {id:'reading.exam.questions.volunteering',items:['reading.volunteering.activities','reading.volunteering.benefits','reading.volunteering.future-value','reading.volunteering.requirements']},
];
R_VOICE_RESULT_SETS.forEach(function(resultSet,setIndex){
  R_QS[setIndex].voice={id:resultSet.id,revision:1};
  resultSet.items.forEach(function(itemId,itemIndex){R_QS[setIndex].qs[itemIndex].voice={id:itemId,revision:1}});
});
const R_GAPS=[
{tx:['Our school library is more than just a room with books. Students come here ',' or to prepare for lessons. Last year the library bought new computers, ',' much faster. Teachers say that students ',' now spend more time reading than before.'],
 fr:['to do their homework in silence','which made the search for information','who visit the library regularly','that was built ten years ago'],
 a:[0,1,2],
 k:['Цель прихода → инфинитив: come here TO DO homework.','which относится к computers, а дальше есть made … faster — фраза продолжает мысль о поиске.','who — придаточное о людях; речь о студентах, которые ходят в библиотеку.']},
{tx:['The new park opened in our city last spring. People of all ages come there ',' . There is a special area for dogs, ',' without a lead. Next year the city plans to build an open-air stage ',' .'],
 fr:['to walk, run and ride bikes','where they can play freely','where concerts and festivals will take place','that sells ice cream'],
 a:[0,1,2],
 k:['Зачем приходят → инфинитив цели: TO WALK, run and ride bikes.','where + play freely without a lead — место для собак.','Сцена — место будущих концертов: where concerts … will take place.']},
{tx:['Last month a student from Britain joined our class. At first it was hard for him ',' , but soon he made friends. He says Russian winter is the coldest thing ',' . Next month our class is planning a trip to Suzdal ',' .'],
 fr:['to understand our fast speech','that he has ever experienced','to show him old Russian towns','who lives near the school'],
 a:[0,1,2],
 k:['it was hard for him + инфинитив: TO UNDERSTAND.','the coldest thing THAT he has ever experienced — классика с ever после превосходной степени.','Цель поездки → инфинитив: TO SHOW him old towns.']}
];
let RG=null;
let RH=null,RQ=null;
function rAnim(name,dur){ui.animate('r_card',name,dur)}
function initReading(){if(!S)return;rSync();rHub()}
function rHub(){var area=document.getElementById('r_area');if(!area)return;RH=null;RQ=null;
  var r=rSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  function acc(x){return x.tot?Math.round(x.ok/x.tot*100)+'%':'—'}
  var re=S.readExam||{};
  area.innerHTML=
   '<button type="button" class="sq clk cardbtn" onclick="rExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'<path class="eb5sp" style="animation-delay:2.3s" d="M120,20 Q120,23 123,23 Q120,23 120,26 Q120,23 117,23 Q120,23 120,20 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 10–18</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(re.n?('лучший результат: '+re.best+' из 11'):'все три задания подряд, на время')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rHl()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Заголовки</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задание 10 · подбери заголовок к тексту</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;background:#FFEDE4;padding:8px 12px;border-radius:14px;">'+acc(r.h)+'</span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rQs()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Полное понимание</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задания 12–18 · текст и вопросы</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#1D7F4A;background:#EAF7F0;padding:8px 12px;border-radius:14px;">'+acc(r.q)+'</span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rGp()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Пропуски</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задание 11 · верни фразы в текст</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#A56000;background:#FFF4DE;padding:8px 12px;border-radius:14px;">'+acc(r.g)+'</span></div></button>'
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#FFF4DE;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Тапни любое слово в тексте — покажем перевод и добавим его в модуль «Слова»</div></div>';
  setTxt('r_today','3 тренажёра');rGen()}
/* перемешивание вариантов с пересчётом ответов */
function rShufHl(set){return readingModule.shuffleHeadings(set)}
function rShufGp(set){return readingModule.shuffleGaps(set)}
/* ---- Задание 10: заголовки ---- */
function rHl(){S.readIdxH=(S.readIdxH||0);var pool=rPool('h',R_HL);var set=rShufHl(pool[S.readIdxH%pool.length]);S.readIdxH++;
  RH={set:set,sel:[null,null,null,null],done:false};rHlRender()}
function rHlRender(){var area=document.getElementById('r_area');var set=RH.set;
  var L='ABCDE';
  var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 10 · ЗАГОЛОВКИ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Подбери заголовок к каждому тексту. Один заголовок лишний.</div>'
    +set.hl.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+x+'</div>'}).join('')+'</div>';
  set.txts.forEach(function(tx,ti){
    h+='<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;">'
      +'<div style="font-weight:500;font-size:13.5px;line-height:1.6;color:#2B2B2B;">'+rWordsHtml(tx.t)+'</div>'
      +'<div style="margin-top:11px;display:flex;gap:8px;" id="rhl_row_'+ti+'">'
      +set.hl.map(function(_,hi){var on=RH.sel[ti]===hi;
        return '<button onclick="rHlPick('+ti+','+hi+')" style="flex:1;height:38px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[hi]+'</button>'}).join('')
      +'</div><div id="rhl_res_'+ti+'"></div></div>'});
  var all=RH.sel.every(function(x){return x!==null});
  h+='<div style="margin-bottom:8px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="rHlCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button></div>';
  area.innerHTML=h;setTxt('r_today',RH.sel.filter(function(x){return x!==null}).length+' / 4 выбрано')}
function rHlPick(ti,hi){if(RH.done)return;
  RH.sel=readingModule.selectUnique(RH.sel,ti,hi);
  rHlRender()}
function rHlCheck(){if(RH.done)return;RH.done=true;var set=RH.set,L='ABCDE',r=rSt(),okn=0;
  set.txts.forEach(function(tx,ti){var ok=RH.sel[ti]===tx.a;if(ok)okn++;
    r.h.tot++;if(ok)r.h.ok++;
    var el=document.getElementById('rhl_res_'+ti);
    if(el)el.innerHTML='<div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильный ответ ')+L[tx.a]+'. '+set.hl[tx.a]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Ключ:</b> '+tx.k+'</div></div>';
    var row=document.getElementById('rhl_row_'+ti);if(row)row.style.pointerEvents='none'});
  var used={};set.txts.forEach(function(t){used[t.a]=1});
  var extra=[0,1,2,3,4].find(function(i){return !used[i]});
  r.texts++;rSync();save();
  var area=document.getElementById('r_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===4?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из 4</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишний заголовок: '+'ABCDE'[extra]+'. '+RH.set.hl[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="rHl()">Ещё подход</button></div>';
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};rGen()}
/* ---- Задания 12-18: полное понимание ---- */
function rQs(){S.readIdxQ=(S.readIdxQ||0);var pool=rPool('q',R_QS);var set=pool[S.readIdxQ%pool.length];S.readIdxQ++;
  RQ={set:set,i:-1,ok:0,showTx:false,ans:set.qs.map(function(){return null}),voiceRegistered:false};rQsRender()}
function rQsRender(){var area=document.getElementById('r_area');var set=RQ.set;
  if(RQ.i<0){
    area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 12–18 · ТЕКСТ</span>'
      +'<div style="font-weight:500;font-size:14px;line-height:1.7;color:#2B2B2B;margin-top:12px;">'+rWordsHtml(set.tx)+'</div></div>'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="RQ.i=0;rQsRender()">К вопросам</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button>';
    rAnim('win','.32s');setTxt('r_today','читаем текст');return}
  var q=set.qs[RQ.i];
  if(!q){var r=rSt();r.texts++;rSync();save();var voiceSlots='';
    var voiceResult=prepareVoiceTutorContextResult({module:'reading',set:set,selections:RQ.ans});
    set.qs.forEach(function(item,i){if(voiceResult)voiceSlots+=voiceResult.resultSlot(item,i)});
    area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">'+(RQ.ok===set.qs.length?'🏆':(RQ.ok>=2?'💪':'📚'))+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">'+RQ.ok+' из '+set.qs.length+'</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Точность в этом тренажёре: '+(rSt().q.tot?Math.round(rSt().q.ok/rSt().q.tot*100):0)+'%</div>'+voiceSlots+'</div>'
      +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rQs()">Ещё текст</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">К чтению</button></div>';
    if(voiceResult&&!RQ.voiceRegistered){RQ.voiceRegistered=true;registerVoiceTutorContextResult(voiceResult).catch(function(){})}
    rAnim('win','.32s');return}
  area.innerHTML=(RQ.showTx?('<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;"><div style="font-weight:500;font-size:13px;line-height:1.65;color:#2B2B2B;">'+rWordsHtml(set.tx)+'</div></div>'):'')
    +'<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(RQ.i+1)+' ИЗ '+set.qs.length+'</span>'
    +'<button type="button" class="clk iconbtn" onclick="RQ.showTx=!RQ.showTx;rQsRender()" style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;cursor:pointer;">'+(RQ.showTx?'СКРЫТЬ ТЕКСТ':'ТЕКСТ')+'</button></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16.5px;color:#2B2B2B;line-height:1.45;margin-top:12px;">'+q.q+'</div></div>'
    +'<div style="display:flex;flex-direction:column;gap:10px;">'
    +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'text-align:left;" onclick="rQsPick(this,'+i+')">'+o+'</button>'}).join('')+'</div>';
  rAnim('win','.32s');setTxt('r_today',(RQ.i+1)+' / '+set.qs.length)}
function rQsPick(btn,i){var q=RQ.set.qs[RQ.i];if(!q||btn.dataset.done)return;
  RQ.ans[RQ.i]=i;
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var ok=i===q.a,r=rSt();r.q.tot++;if(ok){r.q.ok++;RQ.ok++}
  if(ok){ui.markAnswer(btn,'correct');rAnim('wpop','.35s');
    setTimeout(function(){RQ.i++;rSync();save();rQsRender()},650)}
  else{ui.markAnswer(btn,'wrong');
    all.forEach(function(b,bi){if(bi===q.a)ui.markAnswer(b,'correct')});
    rAnim('wshake','.42s');
    setTimeout(function(){rQsExplain(q)},900)}}
function rQsExplain(q){var area=document.getElementById('r_area');
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">РАЗБОР ОШИБКИ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#1D7F4A;margin-top:12px;">'+q.o[q.a]+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.6;margin-top:10px;background:#F2F8F4;border-left:3px solid #1F9E5A;border-radius:0 14px 14px 0;padding:11px 14px;"><b>В тексте:</b> «'+q.ev+'»</div>'
    +'<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;margin-top:10px;background:#FDF3EC;border-left:3px solid #F2683F;border-radius:0 14px 14px 0;padding:11px 14px;"><b>Почему:</b> '+q.e+'</div></div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="RQ.i++;rSync();save();rQsRender()">Понятно, дальше</button>';
  rAnim('wflip','.5s')}
/* ---- Задание 11: пропуски ---- */
function rGp(){S.readIdxG=(S.readIdxG||0);var pool=rPool('g',R_GAPS);var set=rShufGp(pool[S.readIdxG%pool.length]);S.readIdxG++;
  RG={set:set,sel:[null,null,null],done:false};rGpRender()}
function rGpRender(){var area=document.getElementById('r_area');var set=RG.set,L='ABCD';
  var txt='';
  set.tx.forEach(function(seg,i){txt+=rWordsHtml(seg);
    if(i<3){var s=RG.sel[i];
      txt+=' <b style="color:#B54E2F;">('+(i+1)+')</b>&nbsp;<span style="display:inline-block;min-width:54px;border-bottom:2.5px dashed #F2683F;text-align:center;font-weight:800;color:#C2421B;">'+(s!==null?L[s]:'&nbsp;')+'</span> '}});
  var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 11 · ПРОПУСКИ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Верни фразы на свои места. Одна фраза лишняя.</div>'
    +'<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+txt+'</div></div>'
    +'<div class="clayCard" style="padding:14px 16px;margin-bottom:12px;">'
    +set.fr.map(function(f,i){return '<div style="margin-top:6px;font-weight:700;font-size:12.5px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+f+'</div>'}).join('')+'</div>';
  [0,1,2].forEach(function(gi){
    h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;">'
      +'<div style="display:flex;align-items:center;gap:8px;">'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:56px;">Пропуск '+(gi+1)+'</span>'
      +'<div style="flex:1;display:flex;gap:8px;" id="rgp_row_'+gi+'">'
      +set.fr.map(function(_,fi){var on=RG.sel[gi]===fi;
        return '<button onclick="rGpPick('+gi+','+fi+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[fi]+'</button>'}).join('')
      +'</div></div><div id="rgp_res_'+gi+'"></div></div>'});
  var all=RG.sel.every(function(x){return x!==null});
  h+='<div style="margin-bottom:8px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="rGpCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button></div>';
  area.innerHTML=h;setTxt('r_today',RG.sel.filter(function(x){return x!==null}).length+' / 3 выбрано')}
function rGpPick(gi,fi){if(RG.done)return;
  RG.sel=readingModule.selectUnique(RG.sel,gi,fi);
  rGpRender()}
function rGpCheck(){if(RG.done)return;RG.done=true;var set=RG.set,L='ABCD',r=rSt(),okn=0;
  [0,1,2].forEach(function(gi){var ok=RG.sel[gi]===set.a[gi];if(ok)okn++;
    r.g.tot++;if(ok)r.g.ok++;
    var el=document.getElementById('rgp_res_'+gi);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно ')+L[set.a[gi]]+'. '+set.fr[set.a[gi]]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Почему:</b> '+set.k[gi]+'</div></div>';
    var row=document.getElementById('rgp_row_'+gi);if(row)row.style.pointerEvents='none'});
  var used={};set.a.forEach(function(x){used[x]=1});
  var extra=[0,1,2,3].find(function(i){return !used[i]});
  r.texts++;rSync();save();
  var area=document.getElementById('r_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===3?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из 3</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишняя фраза: '+L[extra]+'. '+set.fr[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="rGp()">Ещё подход</button></div>';
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};rGen()}
/* ---- слово из текста → в модуль Слова ---- */
function r_add(st){if(!lastWord)return;
  S.wstatus=S.wstatus||{};S.wstatus[lastWord]=st;
  if(st==='learn'){
    var tr=(document.getElementById('r_tr')||{}).textContent||'';
    if(tr&&tr.indexOf('перевод')<0&&tr.indexOf('офлайн, слова нет')<0&&tr.length<60){
      var have=EGE_WORDS.some(function(x){return wBase(x.w)===lastWord});
      if(!have){var it={w:lastWord,p:'n',t:0,tr:tr.replace(' · офлайн-словарь','').trim(),ex:''};
        EGE_WORDS.push(it);S.aiWords=(S.aiWords||[]).concat([it]);
        try{toast('Добавлено в «Слова» ✓')}catch(e){}}
      else{try{toast('Это слово уже в изучении')}catch(e){}}}}
  save();var p=document.getElementById('r_pop');if(p)p.style.display='none';
  try{wSync()}catch(e){}}
/* ---- экзамен по чтению: 10 + 11 + 12-18 ---- */
let RE=null;
function rExam(){var area=document.getElementById('r_area');if(!area)return;
  var st=S.readExam||{};
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Раздел «Чтение» целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Заголовки → пропуски → текст с вопросами. Никаких подсказок до конца, идёт таймер. Максимум 11 баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из 11 · лучший: '+st.best+' из 11</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">← К чтению</button></div>';
  rAnim('win','.32s')}
function rExamStart(){
  var ph=rPool('h',R_HL),pg=rPool('g',R_GAPS),pq=rPool('q',R_QS);
  S.reIdx=(S.reIdx||0);
  RE={h:rShufHl(ph[S.reIdx%ph.length]),g:rShufGp(pg[S.reIdx%pg.length]),q:pq[S.reIdx%pq.length],
      selH:[null,null,null,null],selG:[null,null,null],ansQ:[],stage:0,t0:Date.now()};
  S.reIdx++;
  RE.iv=setInterval(function(){if(RE)setTxt('r_today',gExamFmt(Math.floor((Date.now()-RE.t0)/1000)))},1000);
  rExamRender()}
function rExamBtnRow(ok,label,fn){
  return '<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:4px;'+(ok?'':'opacity:.45;pointer-events:none;')+'" onclick="'+fn+'">'+label+'</button>'}
function rExamRender(){var area=document.getElementById('r_area');if(!area||!RE)return;var L='ABCDE';
  if(RE.stage===0){var set=RE.h;
    var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 1 ИЗ 3 · ЗАГОЛОВКИ</span>'
      +set.hl.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+x+'</div>'}).join('')+'</div>';
    set.txts.forEach(function(tx,ti){
      h+='<div class="clayCard" style="padding:14px 16px;margin-bottom:11px;">'
        +'<div style="font-weight:500;font-size:13px;line-height:1.6;color:#2B2B2B;">'+rEsc(tx.t)+'</div>'
        +'<div style="margin-top:10px;display:flex;gap:8px;">'
        +set.hl.map(function(_,hi){var on=RE.selH[ti]===hi;
          return '<button onclick="RE.selH['+ti+']='+hi+';rExamDedup(\'selH\','+ti+','+hi+');rExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[hi]+'</button>'}).join('')+'</div></div>'});
    h+=rExamBtnRow(RE.selH.every(function(x){return x!==null}),'Дальше → пропуски','RE.stage=1;rExamRender()');
    area.innerHTML=h;return}
  if(RE.stage===1){var set=RE.g;
    var txt='';set.tx.forEach(function(seg,i){txt+=rEsc(seg);
      if(i<3){var s=RE.selG[i];txt+=' <b style="color:#B54E2F;">('+(i+1)+')</b>&nbsp;<span style="display:inline-block;min-width:50px;border-bottom:2.5px dashed #F2683F;text-align:center;font-weight:800;color:#C2421B;">'+(s!==null?'ABCD'[s]:'&nbsp;')+'</span> '}});
    var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 2 ИЗ 3 · ПРОПУСКИ</span>'
      +'<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+txt+'</div>'
      +set.fr.map(function(f,i){return '<div style="margin-top:6px;font-weight:700;font-size:12.5px;color:#2B2B2B;"><b style="color:#B54E2F;">'+'ABCD'[i]+'.</b> '+rEsc(f)+'</div>'}).join('')+'</div>';
    [0,1,2].forEach(function(gi){
      h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;">'
        +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:56px;">Пропуск '+(gi+1)+'</span>'
        +'<div style="flex:1;display:flex;gap:8px;">'
        +set.fr.map(function(_,fi){var on=RE.selG[gi]===fi;
          return '<button onclick="RE.selG['+gi+']='+fi+';rExamDedup(\'selG\','+gi+','+fi+');rExamRender()" style="flex:1;height:34px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:12.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+'ABCD'[fi]+'</button>'}).join('')+'</div></div>'});
    h+=rExamBtnRow(RE.selG.every(function(x){return x!==null}),'Дальше → текст','RE.stage=2;rExamRender()');
    area.innerHTML=h;return}
  var set=RE.q,qi=RE.ansQ.length;
  if(qi>=set.qs.length){rExamFinish();return}
  var q=set.qs[qi];
  area.innerHTML='<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;"><div style="font-weight:500;font-size:13px;line-height:1.65;color:#2B2B2B;">'+rEsc(set.tx)+'</div></div>'
    +'<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 3 ИЗ 3 · ВОПРОС '+(qi+1)+' ИЗ '+set.qs.length+'</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#2B2B2B;line-height:1.45;margin-top:12px;">'+rEsc(q.q)+'</div></div>'
    +'<div style="display:flex;flex-direction:column;gap:10px;">'
    +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'text-align:left;" onclick="RE.ansQ.push('+i+');rExamRender()">'+rEsc(o)+'</button>'}).join('')+'</div>'}
function rExamDedup(field,idx,val){RE[field]=readingModule.selectUnique(RE[field],idx,val)}
function rExamFinish(){if(!RE)return;clearInterval(RE.iv);
  var sec=examModule.elapsedSeconds(RE.t0,Date.now()),L='ABCDE',r=rSt();
  var voiceResult=prepareVoiceTutorContextResult({module:'reading',set:RE.q,selections:RE.ansQ});
  var okH=0;RE.h.txts.forEach(function(tx,ti){r.h.tot++;if(RE.selH[ti]===tx.a){okH++;r.h.ok++}});
  var okG=0;[0,1,2].forEach(function(gi){r.g.tot++;if(RE.selG[gi]===RE.g.a[gi]){okG++;r.g.ok++}});
  var okQ=0;RE.q.qs.forEach(function(q,i){r.q.tot++;if(RE.ansQ[i]===q.a){okQ++;r.q.ok++}});
  var total=okH+okG+okQ;
  S.readExam=examModule.record(S.readExam,total);
  var rows='';
  RE.h.txts.forEach(function(tx,ti){if(RE.selH[ti]!==tx.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Заголовки · текст '+(ti+1)+' → '+L[tx.a]+'. '+rEsc(RE.h.hl[tx.a])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+tx.k+'</div></div>'});
  [0,1,2].forEach(function(gi){if(RE.selG[gi]!==RE.g.a[gi])
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Пропуск '+(gi+1)+' → '+'ABCD'[RE.g.a[gi]]+'. '+rEsc(RE.g.fr[RE.g.a[gi]])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+RE.g.k[gi]+'</div></div>'});
  RE.q.qs.forEach(function(q,i){if(RE.ansQ[i]!==q.a){var voiceSlot='';
    if(voiceResult)voiceSlot=voiceResult.resultSlot(q,i);
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Вопрос '+(i+1)+' → '+rEsc(q.o[q.a])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+rEsc(q.ev)+'»</div>'+voiceSlot+'</div>'}});
  RE=null;rSync();save();
  var parts=[['Заголовки',okH,4],['Пропуски',okG,3],['Вопросы',okQ,4]];
  var max=examModule.maxScore(parts),weak=examModule.weakestSection(parts);
  var area=document.getElementById('r_area');
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(total,max)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+total+' из '+max+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+' · '+examModule.sectionLine(parts)+'</div>'
    +(total<max?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+weak.label.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div>'+(rows?'<div style="margin-top:12px;">'+rows+'</div>':'')+'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rExamStart()">Ещё раз</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">К чтению</button></div>';
  if(voiceResult)registerVoiceTutorContextResult(voiceResult).catch(function(){});
  rAnim('win','.32s');rGen()}
/* ---- фоновая ИИ-генерация комплектов чтения ---- */
function rPool(kind,base){var ai=(S&&S.readAi&&S.readAi[kind])||[];
  if(kind==='q')ai=ai.filter(function(set){return set&&set.voice&&set.qs&&set.qs.every(function(q){return q.voice})});
  return readingModule.pool(base,ai)}
var R_GEN=false;
async function rGen(){
  if(R_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.readAi=S.readAi||{h:[],q:[],g:[]};
  var kind=null;
  if(rPool('h',R_HL).length<6)kind='h';
  else if(rPool('q',R_QS).length<6)kind='q';
  else if(rPool('g',R_GAPS).length<6)kind='g';
  if(!kind)return;R_GEN=true;
  try{
    var d,item=null;
    if(kind==='h'){
      d=await generateAiContent('reading_headings');
      if(d&&Array.isArray(d.hl)&&d.hl.length===5&&Array.isArray(d.txts)&&d.txts.length===4
        &&d.txts.every(function(t){return t&&t.t&&t.a>=0&&t.a<5&&t.k})
        &&new Set(d.txts.map(function(t){return +t.a})).size===4){
        item={hl:d.hl.map(String),txts:d.txts.map(function(t){return{t:String(t.t),a:+t.a,k:String(t.k)}})}}
    }else if(kind==='q'){
      d=await generateAiContent('reading_questions');
      if(d&&d.tx&&Array.isArray(d.qs)&&d.qs.length===4
        &&d.qs.every(function(q){return q&&q.q&&Array.isArray(q.o)&&q.o.length===4&&q.a>=0&&q.a<4&&q.ev&&q.e})){
        var voice=d.voice_tutor,hasVoice=voice&&voice.set_id&&voice.revision===1&&Array.isArray(voice.item_ids)&&voice.item_ids.length===4;
        if(hasVoice)item={tx:String(d.tx),voice:{id:String(voice.set_id),revision:1},qs:d.qs.map(function(q,i){return{q:String(q.q),o:q.o.map(String),a:+q.a,ev:String(q.ev),e:String(q.e),voice:{id:String(voice.item_ids[i]),revision:1}}})}}
    }else{
      d=await generateAiContent('reading_gaps');
      if(d&&Array.isArray(d.tx)&&d.tx.length===4&&Array.isArray(d.fr)&&d.fr.length===4
        &&Array.isArray(d.a)&&d.a.length===3&&d.a.every(function(x){return x>=0&&x<4})
        &&new Set(d.a.map(Number)).size===3&&Array.isArray(d.k)&&d.k.length===3){
        item={tx:d.tx.map(String),fr:d.fr.map(String),a:d.a.map(Number),k:d.k.map(String)}}
    }
    if(item){S.readAi[kind]=(S.readAi[kind]||[]).concat([item]);save()}
  }catch(e){}
  R_GEN=false;
  /* если ещё есть чем пополнить — продолжим в фоне */
  try{var need=rPool('h',R_HL).length<6||rPool('q',R_QS).length<6||rPool('g',R_GAPS).length<6;
    if(need)setTimeout(rGen,4000)}catch(e){}}
registerRouteHook(function(id){if(id==='scr7')initReading()});
/* Экзамен по чтению не должен тикать в фоне после ухода с экрана. */
registerRouteHook(function(id){if(RE&&RE.iv){clearInterval(RE.iv);RE=null}});
registerScreenGenerator('scr7',genReading);

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  RE,RQ,r_add,
  rExam,rExamDedup,rExamRender,rExamStart,rGp,rGpCheck,rGpPick,rHl,rHlCheck,rHlPick,rHub,
  rQs,rQsPick,rQsRender,
};
