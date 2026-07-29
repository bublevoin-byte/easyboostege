/*
 * Экран «Грамматика» (scr3). Раздел 6.1 ТЗ обещает встроенные грамматические тесты без сети,
 * поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 * В оболочке остались только сводка плитки (gSync) и формат таймера, который делят экзамены
 * чтения и аудирования.
 */
import {registerRouteHook,tab} from '../router.js';
import {
  S,SRV,TOKEN,WBTN,apiPost,examModule,gExamFmt,gSync,generateAiContent,grammarModule,
  registerScreenGenerator,save,setTxt,ui,wDeco,
} from '../app.js';

const GRAM_Q=[
 {t:['She ','_____',' already finished her homework.'],o:['have','has','had','is'],a:1,e:'<b>She/he/it</b> — третье лицо, поэтому <b>has</b>.'},
 {t:['I ','_____',' this film before.'],o:['see','saw','have seen','seeing'],a:2,e:'Опыт без времени → <b>have seen</b>.'},
 {t:['They ','_____',' just arrived.'],o:['have','has','did','was'],a:0,e:'<b>They</b> → have; <b>just</b> → Present Perfect.'},
 {t:['','_____',' you ever been to London?'],o:['Did','Have','Was','Are'],a:1,e:'<b>ever</b> + опыт → <b>Have you ever been</b>.'},
 {t:['He ','_____',' not called yet.'],o:['did','has','have','is'],a:1,e:'<b>He</b> → has; <b>yet</b> → Present Perfect.'}
];
let gi=0,gScore=0,gAns=false;
let GQ=GRAM_Q.slice();
/* -- grammar fallback renderer -- */
function renderG(){gAns=false;const q=GQ[gi];
  document.getElementById('g_head').textContent='Грамматика · Вопрос '+(gi+1)+' из '+GQ.length;
  document.getElementById('g_steps').innerHTML=GQ.map((_,i)=>'<div style="flex:1;height:5px;border-radius:3px;background:'+(i<=gi?'#fff':'rgba(255,255,255,.35)')+';"></div>').join('');
  document.getElementById('g_q').innerHTML=q.t[0]+'<span style="display:inline-block;min-width:62px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">_____</span>'+q.t[2];
  const op=document.getElementById('g_opts');op.innerHTML='';
  q.o.forEach((opt,oi)=>{const d=document.createElement('div');d.setAttribute('data-i',oi);
    d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #EDEEF0;border-radius:15px;padding:14px 16px;font-weight:700;font-size:15px;color:#6A6E75;cursor:pointer;');
    d.innerHTML=opt+'<span style="width:22px;height:22px;border-radius:50%;border:2px solid #E1E3E6;"></span>';
    d.onclick=()=>pickG(oi);op.appendChild(d)});
  document.getElementById('g_exp').style.display='none';
  const nx=document.getElementById('g_next');nx.style.opacity='.45';nx.textContent='Дальше'}
function pickG(oi){if(gAns)return;gAns=true;const q=GQ[gi];
  [...document.getElementById('g_opts').children].forEach(d=>{const i=+d.getAttribute('data-i');
    if(i===q.a){d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#EAF7F0;border:1.5px solid #1F9E5A;border-radius:15px;padding:14px 16px;font-weight:800;font-size:15px;color:#1D7F4A;');d.querySelector('span').setAttribute('style','width:24px;height:24px;border-radius:50%;background:#1F9E5A;display:grid;place-items:center;');d.querySelector('span').innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>'}
    else if(i===oi){d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#FCEEEC;border:1.5px solid #E26A56;border-radius:15px;padding:14px 16px;font-weight:700;font-size:15px;color:#B94A37;');d.querySelector('span').setAttribute('style','width:24px;height:24px;border-radius:50%;background:#E26A56;display:grid;place-items:center;');d.querySelector('span').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'}
    else d.style.opacity='.55'});
  if(oi===q.a)gScore++;
  const ex=document.getElementById('g_exp');ex.style.display='flex';
  ex.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1F9E5A" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><div style="font-weight:600;font-size:12.5px;color:#1F7A47;line-height:1.4;">'+(oi===q.a?'Верно! ':'Правильный ответ: <b>'+q.o[q.a]+'</b>. ')+q.e+'</div>';
  const nx=document.getElementById('g_next');nx.style.opacity='1';nx.textContent=(gi<GQ.length-1?'Дальше':'Завершить')}
function nextG(){if(!gAns)return;if(gi<GQ.length-1){gi++;renderG()}else{alert('Результат: '+gScore+' из '+GQ.length+' 🎯');tab('scr1')}}
async function genGrammar(){
  const d=await generateAiContent('grammar_quiz');if(!Array.isArray(d)||!d.length)throw 0;
  GQ=d.filter(x=>x.options&&x.options.length>=2).map(x=>({t:[x.before||'',' _____ ',x.after||''],o:x.options,a:x.answer||0,e:x.explain||''}));
  if(!GQ.length){GQ=GRAM_Q.slice();throw 0}initGrammar()}
/* ===== GRAMMAR v2: карта тем ЕГЭ + теория + 2 уровня практики ===== */
const G_GROUPS=[{n:'Времена',ids:[1,2,3,13,4]},{n:'Глагол',ids:[5,6,7,8,9,18]},{n:'Части речи',ids:[10,11,12,16,17,20]},{n:'Служебные слова',ids:[14,15,19]}];
const G_TOPICS={
1:{n:'Present Simple и Continuous',th:'<b>Present Simple</b> — регулярные действия, факты: V / V+s (he, she, it).<br>Маркеры: every day, usually, often, never.<br><b>Present Continuous</b> — действие прямо сейчас: am/is/are + V-ing.<br>Маркеры: now, at the moment, Look!, Listen!<br><b>Ловушка ЕГЭ:</b> глаголы состояния (know, like, want, hear, believe) не используются в Continuous.'},
2:{n:'Past Simple и Continuous',th:'<b>Past Simple</b> — завершённое действие в прошлом: V2 / did + V.<br>Маркеры: yesterday, last week, in 2020, ago.<br><b>Past Continuous</b> — процесс в момент прошлого: was/were + V-ing.<br>Маркеры: while, at 5 pm yesterday, when (фон действия).<br><b>Ловушка:</b> длинное действие — Continuous, короткое ворвавшееся — Simple: I <b>was cooking</b> when he <b>came</b>.'},
3:{n:'Present Perfect и Past Simple',th:'<b>Present Perfect</b> — результат к настоящему: have/has + V3.<br>Маркеры: already, just, yet, ever, never, since, for.<br><b>Past Simple</b> — факт в конкретном прошлом: yesterday, last year, in 2019.<br><b>Правило выбора:</b> есть точное время в прошлом → Past Simple. Важен результат сейчас → Present Perfect.'},
4:{n:'Будущее время',th:'<b>will + V</b> — предсказание, спонтанное решение, обещание.<br><b>be going to</b> — намерение или очевидное будущее (Look at the clouds!).<br><b>Present Continuous</b> — личная договорённость (We are flying on Friday).<br><b>Present Simple</b> — расписания: The train <b>leaves</b> at 6.<br><b>Ловушка:</b> после if/when о будущем — настоящее время!'},
5:{n:'Пассивный залог',th:'<b>Passive</b> = be (в нужном времени) + V3.<br>is/are + V3 — регулярно; was/were + V3 — прошлое;<br>will be + V3 — будущее; is being + V3 — прямо сейчас;<br>has been + V3 — результат.<br><b>Ловушка ЕГЭ:</b> в заданиях 19–24 если подлежащее само не делает действие — это пассив: The bridge <b>was built</b>.'},
6:{n:'Условные предложения',th:'<b>0 тип</b> (факты): If + Present, Present. If you heat ice, it melts.<br><b>1 тип</b> (реально): If + Present, will + V. If it rains, we will stay.<br><b>2 тип</b> (нереально сейчас): If + Past, would + V. If I were you…<br><b>3 тип</b> (нереально в прошлом): If + had V3, would have V3.<br><b>Ловушка:</b> после if НЕ ставим will.'},
7:{n:'Косвенная речь',th:'Сдвиг времён после said/told/asked:<br>Present Simple → Past Simple; Present Perfect / Past Simple → Past Perfect;<br>will → would, can → could, may → might.<br>Вопросы: he asked <b>if</b>… / he asked <b>where I lived</b> (прямой порядок слов!).<br><b>Ловушка:</b> в косвенном вопросе нет do/does/did.'},
8:{n:'Модальные глаголы',th:'<b>must</b> — обязан (сам считаю); <b>have to</b> — вынужден (обстоятельства);<br><b>mustn\'t</b> — запрещено; <b>don\'t have to</b> — не обязательно;<br><b>should</b> — совет; <b>can/could</b> — умение, возможность;<br><b>may/might</b> — разрешение, вероятность.<br><b>Ловушка:</b> после модальных — инфинитив без to (кроме have to, ought to).'},
9:{n:'Инфинитив и герундий',th:'<b>Герундий (V-ing)</b> после: enjoy, avoid, mind, suggest, finish, stop, look forward to, предлогов.<br><b>Инфинитив с to</b> после: want, decide, hope, plan, promise, it is easy…<br><b>Без to</b> после: let, make, модальных.<br><b>Ловушка:</b> stop doing — перестать делать; stop to do — остановиться, чтобы сделать.'},
10:{n:'Степени сравнения',th:'Короткие прилагательные: -er / the -est (big → bigger → the biggest).<br>Длинные: more / the most interesting.<br><b>Исключения:</b> good → better → best; bad → worse → worst; far → further; little → less; many/much → more → most.<br><b>Конструкции:</b> as … as, than.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD в сравнении — это better/best.'},
11:{n:'Местоимения',th:'<b>Притяжательные:</b> my/your/his/her/its/our/their + сущ.; без сущ. — mine, yours, hers, theirs.<br><b>Возвратные:</b> myself, himself, herself, itself, ourselves, themselves.<br><b>some/any:</b> some — утверждение, any — вопрос и отрицание.<br><b>Ловушка:</b> its (его) без апострофа; it\'s = it is.'},
12:{n:'Числительные',th:'<b>Порядковые:</b> the first, second, third, дальше -th: fifth (!), ninth (!), twelfth (!), twentieth.<br>Даты: on the fifth of May.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово TWO/FIVE часто нужно превратить в second/fifth (этаж, место, день рождения).<br>hundreds/thousands <b>of</b> people, но two hundred people.'},
13:{n:"Past Perfect",th:"<b>Past Perfect</b> = had + V3 — действие, которое случилось <b>раньше</b> другого действия в прошлом.<br>Маркеры: by the time, before, after, already (к моменту прошлого).<br>Пример: When we arrived, the film <b>had started</b> — фильм начался ДО нашего прихода.<br><b>Ловушка:</b> если действия идут просто по порядку, Past Perfect не нужен — оба в Past Simple."},
14:{n:"Артикли",th:"<b>a/an</b> — один из многих, впервые упомянутый: I saw <b>a</b> cat.<br><b>the</b> — конкретный, известный или единственный: <b>the</b> sun, the cat from our yard, превосходная степень (the best).<br><b>Без артикля:</b> имена, большинство стран, языки, приёмы пищи (have breakfast), go to school.<br><b>Ловушка:</b> the USA, the UK — c the; play <b>the</b> piano, но play football."},
15:{n:"Предлоги",th:"<b>Время:</b> at 5, at night · on Monday, on the 5th of May · in June, in 2020, in the morning.<br><b>Место:</b> at school, at home · in the room, in Moscow · on the wall.<br><b>Устойчивые:</b> depend <b>on</b>, good <b>at</b>, afraid <b>of</b>, interested <b>in</b>, listen <b>to</b>, wait <b>for</b>.<br><b>Ловушка:</b> in the morning, но at night; on TV, on the Internet."},
16:{n:"Множественное число",th:"Обычно +s/es. <b>Исключения — учи наизусть:</b> man → men, woman → women, child → children, foot → feet, tooth → teeth, mouse → mice, person → people, sheep → sheep.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово CHILD/MAN в скобках почти всегда просит форму множественного числа: children, men. People — уже множественное: people <b>are</b>."},
17:{n:"Прилагательные -ing и -ed",th:"<b>-ing</b> — сам предмет вызывает чувство: The film is <b>boring</b> (фильм скучный).<br><b>-ed</b> — человек испытывает чувство: I am <b>bored</b> (мне скучно).<br>Пары: interesting/interested, exciting/excited, tiring/tired, surprising/surprised.<br><b>Приём:</b> спроси «кто испытывает чувство?» Если человек — ставь -ed."},
18:{n:"Вопросы и порядок слов",th:"Вопрос: <b>вопросительное слово + вспомогательный + подлежащее + глагол</b>: Where <b>does she</b> live?<br>Вопрос к подлежащему — БЕЗ do/does/did: Who <b>broke</b> the window?<br><b>Разделительный вопрос:</b> утверждение + отрицательный хвост: You like tea, <b>don\u0027t you</b>?<br><b>Ловушка:</b> в косвенном вопросе прямой порядок слов: I wonder where she <b>lives</b>."},
19:{n:"Союзы и связки",th:"<b>because</b> + причина · <b>so</b> + следствие · <b>although</b> (хотя) + контраст.<br><b>however</b> — однако (после точки, с запятой).<br><b>despite / in spite of</b> + существительное или V-ing, НЕ предложение!<br><b>Ловушка ЕГЭ:</b> despite the rain (сущ.), но although it rained (целое предложение)."},
20:{n:"Наречия",th:"Наречие = прилагательное + <b>-ly</b>: slow → slowly, easy → easily, happy → happily.<br><b>Исключения:</b> good → <b>well</b>; fast → fast; hard → hard.<br><b>hardly</b> — «почти не», а не «тяжело»: I could hardly hear.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD после глагола действия превращается в well: sings well."}
};
const G_BANK={
1:{c:[
 {t:['She ',' to school every day.'],o:['go','goes','is going','went'],a:1,e:'every day → Present Simple, she → V+s.'},
 {t:['Look! It ',' .'],o:['rains','is raining','rain','rained'],a:1,e:'Look! → действие сейчас → Continuous.'},
 {t:['Water ',' at 100 degrees.'],o:['boils','is boiling','boil','boiled'],a:0,e:'Факт природы → Present Simple.'},
 {t:['I ',' you well now.'],o:['hear','am hearing','hears','heard'],a:0,e:'hear — глагол состояния, без Continuous.'},
 {t:['He usually ',' up at seven.'],o:['get','gets','is getting','got'],a:1,e:'usually → Simple, he → gets.'}],
f:[
 {s:'My brother _____ (WATCH) TV every evening.',b:'WATCH',ans:['watches'],e:'every evening → Present Simple, 3-е лицо → watches.'},
 {s:'Listen! Somebody _____ (SING).',b:'SING',ans:['is singing'],e:'Listen! → прямо сейчас → is singing.'},
 {s:'She _____ (NOT LIKE) loud music.',b:'NOT LIKE',ans:['does not like','doesnt like'],e:'Отрицание в Present Simple → does not like.'},
 {s:'We _____ (STUDY) English twice a week.',b:'STUDY',ans:['study'],e:'Регулярность → Present Simple, we → study.'},
 {s:'Right now they _____ (PLAY) chess.',b:'PLAY',ans:['are playing'],e:'right now → are playing.'}]},
2:{c:[
 {t:['I ',' him yesterday.'],o:['see','saw','have seen','was seeing'],a:1,e:'yesterday → Past Simple.'},
 {t:['While I ',' dinner, the phone rang.'],o:['cooked','was cooking','cook','am cooking'],a:1,e:'while → процесс → Past Continuous.'},
 {t:['They ',' to Moscow in 2020.'],o:['move','moved','have moved','were moving'],a:1,e:'in 2020 → Past Simple.'},
 {t:['When she came in, he ',' TV.'],o:['watched','was watching','watches','has watched'],a:1,e:'Фоновый процесс → was watching.'},
 {t:['Columbus ',' America in 1492.'],o:['discovers','discovered','has discovered','was discovering'],a:1,e:'Дата в прошлом → Past Simple.'}],
f:[
 {s:'She _____ (BUY) a new dress last week.',b:'BUY',ans:['bought'],e:'last week → Past Simple: buy → bought.'},
 {s:'At 5 pm yesterday we _____ (PLAY) football.',b:'PLAY',ans:['were playing'],e:'Момент-процесс → were playing.'},
 {s:'He _____ (COME) home late last night.',b:'COME',ans:['came'],e:'last night → came.'},
 {s:'While mum _____ (COOK), dad set the table.',b:'COOK',ans:['was cooking'],e:'while → was cooking.'},
 {s:'I _____ (NOT SEE) him at school yesterday.',b:'NOT SEE',ans:['did not see','didnt see'],e:'Отрицание в Past Simple → did not see.'}]},
3:{c:[
 {t:['She ',' already finished her homework.'],o:['have','has','had','is'],a:1,e:'she → has; already → Present Perfect.'},
 {t:['I ',' this film before.'],o:['see','saw','have seen','seeing'],a:2,e:'Опыт без даты → have seen.'},
 {t:['He ',' to London last year.'],o:['has gone','went','goes','has been'],a:1,e:'last year → Past Simple.'},
 {t:['',' you ever been to Paris?'],o:['Did','Have','Was','Are'],a:1,e:'ever → Have you ever been.'},
 {t:['We ',' friends since 2015.'],o:['are','were','have been','had been'],a:2,e:'since → Present Perfect.'}],
f:[
 {s:'I _____ (KNOW) her for ten years.',b:'KNOW',ans:['have known'],e:'for + период до сейчас → have known.'},
 {s:'They _____ (JUST ARRIVE) — meet them!',b:'JUST ARRIVE',ans:['have just arrived'],e:'just → have just arrived.'},
 {s:'She _____ (VISIT) Rome in 2019.',b:'VISIT',ans:['visited'],e:'in 2019 → visited.'},
 {s:'He _____ (NOT FINISH) the report yet.',b:'NOT FINISH',ans:['has not finished','hasnt finished'],e:'yet → Present Perfect: has not finished.'},
 {s:'We _____ (BE) here since morning.',b:'BE',ans:['have been'],e:'since → have been.'}]},
4:{c:[
 {t:['I think it ',' tomorrow.'],o:['rains','will rain','is raining','rained'],a:1,e:'Предсказание с I think → will.'},
 {t:['Look at the clouds! It ',' .'],o:['will rain','is going to rain','rains','rained'],a:1,e:'Очевидно по признакам → be going to.'},
 {t:['The train ',' at 6:30.'],o:['leaves','will leave','is leaving','left'],a:0,e:'Расписание → Present Simple.'},
 {t:['We ',' to the cinema tonight — I have the tickets.'],o:['go','are going','will go','went'],a:1,e:'Договорённость → Present Continuous.'},
 {t:['I promise I ',' you.'],o:['help','am helping','will help','helped'],a:2,e:'Обещание → will.'}],
f:[
 {s:'I am sure she _____ (COME) tomorrow.',b:'COME',ans:['will come'],e:'Уверенность о будущем → will come.'},
 {s:'I hope he _____ (WIN) the match.',b:'WIN',ans:['will win'],e:'hope → will win.'},
 {s:'The lesson _____ (START) at nine on Mondays.',b:'START',ans:['starts'],e:'Расписание → starts.'},
 {s:'Wait, I _____ (HELP) you with the bags.',b:'HELP',ans:['will help'],e:'Спонтанное решение → will help.'},
 {s:'We will go out when the rain _____ (STOP).',b:'STOP',ans:['stops'],e:'После when о будущем — Present Simple.'}]},
5:{c:[
 {t:['This book ',' in 1997.'],o:['wrote','was written','is written','has written'],a:1,e:'Книга не сама пишет → пассив прошлого.'},
 {t:['Letters ',' every day.'],o:['deliver','are delivered','delivered','are delivering'],a:1,e:'Регулярный пассив → are delivered.'},
 {t:['The new school ',' next year.'],o:['will build','will be built','is built','builds'],a:1,e:'Будущий пассив → will be built.'},
 {t:['English ',' all over the world.'],o:['speaks','is spoken','spoke','is speaking'],a:1,e:'Пассив: is spoken.'},
 {t:['The room ',' right now.'],o:['is cleaned','is being cleaned','cleans','was cleaned'],a:1,e:'Процесс сейчас в пассиве → is being cleaned.'}],
f:[
 {s:'The bridge _____ (BUILD) in 1932.',b:'BUILD',ans:['was built'],e:'Пассив прошлого → was built.'},
 {s:'Rice _____ (GROW) in China.',b:'GROW',ans:['is grown'],e:'Факт-пассив → is grown.'},
 {s:'The letter _____ (SEND) tomorrow.',b:'SEND',ans:['will be sent'],e:'Будущее в пассиве → will be sent.'},
 {s:'This song _____ (WRITE) by The Beatles.',b:'WRITE',ans:['was written'],e:'by → пассив: was written.'},
 {s:'Dinner _____ (COOK) at the moment.',b:'COOK',ans:['is being cooked'],e:'at the moment + пассив → is being cooked.'}]},
6:{c:[
 {t:['If it rains, we ',' at home.'],o:['stay','will stay','would stay','stayed'],a:1,e:'1 тип: If + Present, will.'},
 {t:['If I ',' you, I would apologise.'],o:['am','was','were','be'],a:2,e:'2 тип: If I were you.'},
 {t:['She would come if you ',' her.'],o:['invite','invited','will invite','had invited'],a:1,e:'2 тип: If + Past Simple.'},
 {t:['If you heat ice, it ',' .'],o:['melts','will melt','would melt','melted'],a:0,e:'0 тип — факт: Present + Present.'},
 {t:['If I had known, I ',' you.'],o:['would tell','told','would have told','will tell'],a:2,e:'3 тип: would have + V3.'}],
f:[
 {s:'If he _____ (HAVE) time, he will call you.',b:'HAVE',ans:['has'],e:'1 тип: после if — Present Simple.'},
 {s:'If I _____ (BE) you, I would wait.',b:'BE',ans:['were'],e:'2 тип: were для всех лиц.'},
 {s:'We will go out if the rain _____ (STOP).',b:'STOP',ans:['stops'],e:'После if НЕ будет will → stops.'},
 {s:'If she studied harder, she _____ (PASS) her exams.',b:'PASS',ans:['would pass'],e:'2 тип: would + V.'},
 {s:'If they _____ (LEAVE) earlier, they would have caught the train.',b:'LEAVE',ans:['had left'],e:'3 тип: If + had V3.'}]},
7:{c:[
 {t:['He said he ',' busy.'],o:['is','was','were','be'],a:1,e:'Косвенная речь: сказал, что занят СЕЙЧАС для того момента — is сдвигается в was.'},
 {t:['She said she ',' come the next day.'],o:['will','would','can','shall'],a:1,e:'Косвенная речь: will всегда сдвигается в would.'},
 {t:['Tom asked where I ',' .'],o:['live','lived','do live','living'],a:1,e:'Косвенный вопрос: прямой порядок, сдвиг → lived.'},
 {t:['Mum said she ',' the film before.'],o:['saw','has seen','had seen','sees'],a:2,e:'Она видела фильм ЕЩЁ РАНЬШЕ этого разговора — действие до прошлого → Past Perfect: had seen.'},
 {t:['He asked if I ',' help.'],o:['need','needed','will need','am needing'],a:1,e:'Косвенный вопрос: время сдвигается назад (need → needed), порядок слов прямой.'}],
f:[
 {s:'She said she _____ (LIVE) in Kazan.',b:'LIVE',ans:['lived'],e:'Косвенная речь: живёт (lives) → жила для того момента (lived).'},
 {s:'He told me he _____ (CALL) later.',b:'CALL',ans:['would call'],e:'Косвенная речь: will call → would call (обещание, переданное позже).'},
 {s:'They said they _____ (FINISH) the project already.',b:'FINISH',ans:['had finished'],e:'Закончили ЕЩЁ ДО того, как сказали → Past Perfect: had finished.'},
 {s:'He asked what time it _____ (BE).',b:'BE',ans:['was'],e:'Косвенный вопрос → was.'},
 {s:'She said she _____ (CAN) not come.',b:'CAN',ans:['could'],e:'can → could.'}]},
8:{c:[
 {t:['You ',' wear a helmet — it is the law.'],o:['can','must','may','might'],a:1,e:'Обязанность → must.'},
 {t:['You ',' smoke here — it is forbidden.'],o:['must not','do not have to','may','need'],a:0,e:'Запрет → must not.'},
 {t:['',' I open the window, please?'],o:['Must','May','Should','Have'],a:1,e:'Просьба о разрешении → May I…'},
 {t:['He ',' swim when he was five.'],o:['can','could','may','must'],a:1,e:'Умение в прошлом → could.'},
 {t:['You look tired — you ',' rest.'],o:['must not','should','may not','could not'],a:1,e:'Совет → should.'}],
c2:[
 {t:['You ',' pay — the museum is free today.'],o:['must not','do not have to','can not','should'],a:1,e:'Нет необходимости → do not have to (must not = запрет!).'},
 {t:['She ',' be at home — the lights are on.'],o:['must','has to','should','need'],a:0,e:'Логический вывод → must be.'},
 {t:['I ',' get up early yesterday.'],o:['must','had to','should','may'],a:1,e:'Вынужденность в прошлом → had to.'},
 {t:['',' you help me with this bag?'],o:['Must','Could','Should','May'],a:1,e:'Вежливая просьба → Could you…'},
 {t:['It ',' rain later — take an umbrella.'],o:['must','might','has to','should'],a:1,e:'Вероятность → might.'}]},
9:{c:[
 {t:['I enjoy ',' detective stories.'],o:['read','to read','reading','reads'],a:2,e:'enjoy + V-ing.'},
 {t:['She wants ',' a doctor.'],o:['become','becoming','to become','becomes'],a:2,e:'want + to V.'},
 {t:['He stopped ',' last year — good for him!'],o:['smoke','smoking','to smoke','smoked'],a:1,e:'stop doing = бросить.'},
 {t:['Let me ',' you.'],o:['help','to help','helping','helped'],a:0,e:'let + инфинитив без to.'},
 {t:['It is easy ',' mistakes.'],o:['make','making','to make','made'],a:2,e:'It is easy + to V.'}],
f:[
 {s:'Avoid _____ (MAKE) noise after ten.',b:'MAKE',ans:['making'],e:'avoid + V-ing.'},
 {s:'They decided _____ (STAY) at home.',b:'STAY',ans:['to stay'],e:'decide + to V.'},
 {s:'I look forward to _____ (SEE) you.',b:'SEE',ans:['seeing'],e:'look forward to + V-ing.'},
 {s:'He made me _____ (LAUGH).',b:'LAUGH',ans:['laugh'],e:'make + инфинитив без to.'},
 {s:'She suggested _____ (GO) for a walk.',b:'GO',ans:['going'],e:'suggest + V-ing.'}]},
10:{c:[
 {t:['This task is ',' than that one.'],o:['easy','easier','the easiest','more easy'],a:1,e:'Сравнение коротких: -er + than.'},
 {t:['It is the ',' film I have ever seen.'],o:['good','better','best','goodest'],a:2,e:'good → better → the best.'},
 {t:['My car is ',' expensive than yours.'],o:['more','most','much','many'],a:0,e:'Длинное прилагательное → more + adj.'},
 {t:['The weather is getting ',' .'],o:['bad','worse','the worst','badly'],a:1,e:'bad → worse.'},
 {t:['He is as ',' as his brother.'],o:['tall','taller','the tallest','more tall'],a:0,e:'as + положительная степень + as.'}],
f:[
 {s:'February is the _____ (SHORT) month of the year.',b:'SHORT',ans:['shortest'],e:'Превосходная: the shortest.'},
 {s:'This road is _____ (BAD) than ours.',b:'BAD',ans:['worse'],e:'bad → worse.'},
 {s:'It was the _____ (INTERESTING) trip in my life.',b:'INTERESTING',ans:['most interesting'],e:'Длинное → the most interesting.'},
 {s:'Winters here are _____ (COLD) than at home.',b:'COLD',ans:['colder'],e:'Короткое → colder.'},
 {s:'She sings much _____ (GOOD) than me.',b:'GOOD',ans:['better'],e:'good → better.'}]},
11:{c:[
 {t:['This is ',' book, not yours.'],o:['my','mine','me','myself'],a:0,e:'Перед сущ. → my.'},
 {t:['The red bag is ',' .'],o:['her','hers','she','herself'],a:1,e:'Без сущ. → hers.'},
 {t:['I fixed the bike ',' .'],o:['me','my','myself','mine'],a:2,e:'Сам → myself.'},
 {t:['There is ',' milk in the fridge.'],o:['some','any','no one','every'],a:0,e:'Утверждение → some.'},
 {t:['Is there ',' juice left?'],o:['some','any','none','a'],a:1,e:'Вопрос → any.'}],
f:[
 {s:'Look at _____ (SHE) new dress!',b:'SHE',ans:['her'],e:'Перед сущ. → her.'},
 {s:'These toys are _____ (THEY).',b:'THEY',ans:['theirs'],e:'Без сущ. → theirs.'},
 {s:'We enjoyed _____ (WE) at the party.',b:'WE',ans:['ourselves'],e:'enjoy oneself → ourselves.'},
 {s:'The cat licked _____ (IT) paw.',b:'IT',ans:['its'],e:'Притяжательное its — без апострофа.'},
 {s:'He cut _____ (HE) while cooking.',b:'HE',ans:['himself'],e:'Возвратное → himself.'}]},
12:{c:[
 {t:['My birthday is on the ',' of May.'],o:['five','fifth','fifty','fiveth'],a:1,e:'Дата → порядковое: the fifth.'},
 {t:['There are ',' months in a year.'],o:['twelve','twelfth','twelves','twelfths'],a:0,e:'Количество → twelve.'},
 {t:['He came ',' in the race.'],o:['first','one','once','firstly'],a:0,e:'Место в гонке → first.'},
 {t:['Open your books at page ',' .'],o:['three','third','thirds','thirdly'],a:0,e:'После сущ. (page 3) → количественное.'},
 {t:['',' of people visited the fair.'],o:['Hundred','Hundreds','The hundred','Hundredth'],a:1,e:'Hundreds of people (неточное число).'}],
f:[
 {s:'Today is her _____ (TWELVE) birthday.',b:'TWELVE',ans:['twelfth'],e:'12th → twelfth (без e!).'},
 {s:'He finished _____ (TWO) in the marathon.',b:'TWO',ans:['second'],e:'Место → second.'},
 {s:'It is my _____ (ONE) visit to Moscow.',b:'ONE',ans:['first'],e:'one → first.'},
 {s:'The _____ (FIVE) lesson starts at one o\'clock.',b:'FIVE',ans:['fifth'],e:'five → fifth (f!).'},
 {s:'Our office is on the _____ (TWENTY) floor.',b:'TWENTY',ans:['twentieth'],e:'twenty → twentieth.'}]},
13:{c:[
 {t:["When I came, they "," already left."],o:["have","had","has","were"],a:1,e:"Они ушли ДО того, как я пришёл — действие раньше прошлого → had left."},
 {t:["By the time the bus arrived, we "," for an hour."],o:["waited","had waited","have waited","wait"],a:1,e:"by the time → ждали ДО прибытия → Past Perfect: had waited."},
 {t:["She was sad because she "," her keys."],o:["lost","had lost","has lost","loses"],a:1,e:"Сначала потеряла ключи, ПОТОМ грустила → более раннее действие → had lost."},
 {t:["After he "," dinner, he watched TV."],o:["had cooked","has cooked","cooks","is cooking"],a:0,e:"after + действие, которое было первым → had cooked."},
 {t:["I "," never seen the sea before that trip."],o:["have","had","was","did"],a:1,e:"Опыт ДО момента в прошлом (before that trip) → had never seen."}],
f:[
 {s:"When we got to the station, the train _____ (ALREADY LEAVE).",b:"ALREADY LEAVE",ans:["had already left"],e:"Поезд ушёл ДО нашего прихода → had already left."},
 {s:"He was tired because he _____ (NOT SLEEP) all night.",b:"NOT SLEEP",ans:["had not slept","hadnt slept"],e:"Не спал ДО того, как устал → had not slept."},
 {s:"By 2020 they _____ (BUILD) the new bridge.",b:"BUILD",ans:["had built"],e:"by 2020 — к моменту в прошлом → had built."},
 {s:"After I _____ (FINISH) my homework, I went out.",b:"FINISH",ans:["had finished"],e:"after + первое из двух действий → had finished."},
 {s:"She realised she _____ (FORGET) her password.",b:"FORGET",ans:["had forgotten"],e:"Забыла РАНЬШЕ, чем поняла → had forgotten."}]},
14:{c:[
 {t:["I have "," idea!"],o:["a","an","the","—"],a:1,e:"idea начинается с гласного звука → an idea."},
 {t:[""," sun rises in the east."],o:["A","An","The","—"],a:2,e:"Солнце единственное в своём роде → the sun."},
 {t:["She plays "," piano very well."],o:["a","an","the","—"],a:2,e:"Музыкальные инструменты → play the piano."},
 {t:["We usually have "," breakfast at eight."],o:["a","an","the","—"],a:3,e:"Приёмы пищи без артикля: have breakfast."},
 {t:["He lives in "," USA."],o:["a","an","the","—"],a:2,e:"Страны из нескольких слов → the USA."}],
c2:[
 {t:["It was "," best day of my life."],o:["a","an","the","—"],a:2,e:"Превосходная степень всегда с the: the best."},
 {t:["My dad is "," engineer."],o:["a","an","the","—"],a:1,e:"Профессия — с a/an; engineer начинается с гласного → an."},
 {t:["We went to "," cinema last night."],o:["a","an","the","—"],a:2,e:"go to the cinema — устойчиво с the."},
 {t:[""," children learn languages faster than adults."],o:["A","An","The","—"],a:3,e:"Обобщение во множественном числе — без артикля."},
 {t:["Pass me "," salt, please."],o:["a","an","the","—"],a:2,e:"Конкретная соль на этом столе → the salt."}]},
15:{c:[
 {t:["The lesson starts "," nine."],o:["at","on","in","to"],a:0,e:"Точное время → at nine."},
 {t:["My birthday is "," June."],o:["at","on","in","of"],a:2,e:"Месяц → in June."},
 {t:["We met "," Monday."],o:["at","on","in","by"],a:1,e:"День недели → on Monday."},
 {t:["She is good "," maths."],o:["in","at","on","of"],a:1,e:"Устойчиво: good at."},
 {t:["It depends "," the weather."],o:["of","from","on","at"],a:2,e:"Устойчиво: depend on (не from!)."}],
c2:[
 {t:["I am interested "," history."],o:["at","in","on","of"],a:1,e:"interested in."},
 {t:["Do not be afraid "," mistakes."],o:["of","at","from","by"],a:0,e:"afraid of."},
 {t:["We waited "," the bus for ages."],o:["at","on","for","to"],a:2,e:"wait for."},
 {t:["He listens "," music every day."],o:["at","to","on","for"],a:1,e:"listen to."},
 {t:["I read about it "," the Internet."],o:["in","at","on","by"],a:2,e:"on the Internet, on TV."}]},
16:{c:[
 {t:["There are five "," in the room."],o:["mans","men","man","mens"],a:1,e:"man → men (без s!)."},
 {t:["The "," are playing outside."],o:["childs","children","child","childrens"],a:1,e:"child → children."},
 {t:["My "," hurt after the long walk."],o:["foots","feet","foot","feets"],a:1,e:"foot → feet."},
 {t:["Some "," think differently."],o:["persons","people","peoples","person"],a:1,e:"person → people."},
 {t:["A few "," are grazing in the field."],o:["sheeps","sheep","shep","sheepes"],a:1,e:"sheep не меняется: one sheep — two sheep."}],
f:[
 {s:"Three _____ (WOMAN) were waiting at the door.",b:"WOMAN",ans:["women"],e:"woman → women."},
 {s:"All the _____ (CHILD) love this game.",b:"CHILD",ans:["children"],e:"child → children."},
 {s:"My _____ (TOOTH) hurt after too many sweets.",b:"TOOTH",ans:["teeth"],e:"tooth → teeth."},
 {s:"Hundreds of _____ (PERSON) came to the concert.",b:"PERSON",ans:["people"],e:"person → people."},
 {s:"Two white _____ (MOUSE) live in the cage.",b:"MOUSE",ans:["mice"],e:"mouse → mice."}]},
17:{c:[
 {t:["The journey was long and very "," ."],o:["tired","tiring","tire","tiredly"],a:1,e:"Поездка сама утомляет → tiring."},
 {t:["I am "," in space and planets."],o:["interesting","interested","interest","interestly"],a:1,e:"Человек испытывает интерес → interested."},
 {t:["The news was really "," ."],o:["surprised","surprising","surprise","surprisingly"],a:1,e:"Новость вызывает удивление → surprising."},
 {t:["We were "," by the result."],o:["amazing","amazed","amaze","amazedly"],a:1,e:"Мы испытали чувство → amazed."},
 {t:["This game is so "," !"],o:["excited","exciting","excite","excitedly"],a:1,e:"Игра вызывает восторг → exciting."}],
f:[
 {s:"The lecture was really _____ (BORE).",b:"BORE",ans:["boring"],e:"Лекция сама наводит скуку → boring."},
 {s:"She was _____ (EXCITE) about the trip.",b:"EXCITE",ans:["excited"],e:"Она испытывает чувство → excited."},
 {s:"His answer was quite _____ (SURPRISE).",b:"SURPRISE",ans:["surprising"],e:"Ответ вызывает удивление → surprising."},
 {s:"I feel _____ (TIRE) after training.",b:"TIRE",ans:["tired"],e:"Я испытываю усталость → tired."},
 {s:"The book is very _____ (INTEREST).",b:"INTEREST",ans:["interesting"],e:"Книга вызывает интерес → interesting."}]},
18:{c:[
 {t:["Where "," your brother work?"],o:["does","is","do","did"],a:0,e:"He/she → вспомогательный does: Where does he work?"},
 {t:["Who "," the window yesterday?"],o:["broke","did break","breaks","break"],a:0,e:"Вопрос к подлежащему (КТО разбил?) — без did: Who broke…"},
 {t:["You are coming with us, "," ?"],o:["are you","aren\u0027t you","do you","isn\u0027t it"],a:1,e:"Утверждение с are → хвост aren\u0027t you?"},
 {t:["She speaks French, "," ?"],o:["does she","doesn\u0027t she","isn\u0027t she","hasn\u0027t she"],a:1,e:"speaks (Present Simple) → doesn\u0027t she?"},
 {t:["I wonder where he "," ."],o:["lives","does live","live","is live"],a:0,e:"Косвенный вопрос — прямой порядок слов: where he lives."}],
c2:[
 {t:[""," you ever tried sushi?"],o:["Did","Have","Do","Was"],a:1,e:"ever + опыт → Have you ever tried…"},
 {t:["He can swim, "," ?"],o:["can he","can\u0027t he","does he","isn\u0027t he"],a:1,e:"can → хвост can\u0027t he?"},
 {t:["Tell me what time it "," ."],o:["is","does","be","was being"],a:0,e:"Косвенный вопрос: what time it is (без do)."},
 {t:[""," did you get home? — Late at night."],o:["When","Where","Who","Which"],a:0,e:"Ответ про время → When."},
 {t:["They went home early, "," ?"],o:["did they","didn\u0027t they","do they","weren\u0027t they"],a:1,e:"went → didn\u0027t they?"}]},
19:{c:[
 {t:["We stayed at home "," it was raining."],o:["so","because","despite","however"],a:1,e:"Причина → because."},
 {t:["We went for a walk "," the cold."],o:["although","because","despite","so"],a:2,e:"Дальше существительное (the cold) → despite."},
 {t:[""," he was tired, he kept working."],o:["Despite","Although","So","Because"],a:1,e:"Дальше целое предложение → Although."},
 {t:["She was ill, "," she came to school."],o:["so","because","but","despite"],a:2,e:"Контраст двух фактов → but."},
 {t:["I overslept, "," I was late."],o:["because","so","although","despite"],a:1,e:"Следствие → so (проспал, ПОЭТОМУ опоздал)."}],
c2:[
 {t:[""," the traffic, we arrived on time."],o:["Although","Despite","Because","However"],a:1,e:"Дальше существительное → Despite the traffic."},
 {t:["He passed the exam "," he had hardly studied."],o:["despite","although","so","because of"],a:1,e:"Дальше предложение → although."},
 {t:["The film was long. "," , it was great."],o:["Despite","However","Although","Because"],a:1,e:"Новое предложение + запятая → However."},
 {t:["Take an umbrella "," it rains."],o:["in case","despite","so","although"],a:0,e:"На случай, если пойдёт дождь → in case."},
 {t:["I like tea "," my brother prefers coffee."],o:["while","despite","so","because"],a:0,e:"Сопоставление двух фактов → while."}]},
20:{c:[
 {t:["She sings very "," ."],o:["good","well","goodly","best"],a:1,e:"После глагола действия — наречие: good → well."},
 {t:["He drives too "," ."],o:["fast","fastly","fastest","fasten"],a:0,e:"fast — исключение: наречие тоже fast."},
 {t:["Speak "," , please."],o:["slow","slowly","slowest","slowness"],a:1,e:"Как говорить? → наречие slowly."},
 {t:["I could "," hear him."],o:["hard","hardly","harder","hardness"],a:1,e:"hardly = почти не. I could hardly hear — почти не слышал."},
 {t:["They worked "," all day."],o:["hard","hardly","hardful","hardy"],a:0,e:"hard = усердно (hardly — ловушка, «почти не»)."}],
f:[
 {s:"She smiled _____ (HAPPY).",b:"HAPPY",ans:["happily"],e:"happy → happily (y → ily)."},
 {s:"He answered all the questions _____ (CORRECT).",b:"CORRECT",ans:["correctly"],e:"Как ответил? → correctly."},
 {s:"Please listen _____ (CAREFUL).",b:"CAREFUL",ans:["carefully"],e:"careful → carefully (две l)."},
 {s:"My granny cooks really _____ (GOOD).",b:"GOOD",ans:["well"],e:"good → well (исключение!)."},
 {s:"It was raining _____ (HEAVY).",b:"HEAVY",ans:["heavily"],e:"heavy → heavily."}]}
};
const G_RINT=[7,16,35];
/* --- состояние: S.gram = {tid:{st,ok,err,sr,rs,due}} --- */
let GS=null;
function gRec(t){S.gram=S.gram||{};return S.gram[t]||(S.gram[t]={st:0,ok:0,err:0,sr:0})}
function gAnim(name,dur){ui.animate('g_card',name,dur)}
function gStatusChip(st,isDue){
  if(st===2&&isDue)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ПОРА ПОВТОРИТЬ</span>';
  if(st===2)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАКРЕПЛЕНА</span>';
  if(st===1)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ИЗУЧАЕТСЯ</span>';
  return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">НЕ НАЧАТА</span>'}
function initGrammar(){if(!S)return;gSync();gMap()}
/* Обработчик разметки не может присвоить переменную модуля, поэтому сброс темы — функция. */
function gToThemes(){GS=null;initGrammar()}
function gMap(){var area=document.getElementById('g_area');if(!area)return;
  var due=gDue();
  var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.05)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var h='';
  var e19=S.exam19||{};
  h+='<button type="button" class="sq clk cardbtn" onclick="gExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
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
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 19–24</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(e19.n?('лучший результат: '+e19.best+' из 6'):'текст с пропусками, без подсказок')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  if(due.length)h+='<button type="button" class="sq clk cardbtn" onclick="gReview()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:linear-gradient(135deg,#FFA570,#F2683F);box-shadow:0 14px 28px rgba(242,104,63,.32),inset 0 2px 4px rgba(255,255,255,.45),inset 0 -6px 14px rgba(190,55,18,.25);">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Пора повторить</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.85);margin-top:2px;">'+due.length+' '+(due.length===1?'тема ждёт':(due.length<5?'темы ждут':'тем ждут'))+' проверки памяти</div></div>'
    +'<span style="flex:none;background:rgba(255,255,255,.96);border-radius:14px;padding:9px 14px;font-weight:800;font-size:12.5px;color:#C2421B;">Начать</span></div></button>';
  G_GROUPS.forEach(function(gr){
    h+='<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:12px;letter-spacing:1.8px;color:#6F695E;margin:6px 2px 10px;">'+gr.n.toUpperCase()+'</div>';
    gr.ids.forEach(function(t){var r=gRec(t),tp=G_TOPICS[t];
      var isDue=r.st===2&&r.due&&r.due<=Date.now();
      var pct=r.st===2?100:Math.min(99,Math.round(r.sr/4*100));
      h+='<button type="button" class="clayCard sq clk cardbtn" onclick="gOpen('+t+')" style="'+ga()+'padding:14px 16px;margin-bottom:11px;cursor:pointer;">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
        +'<div style="font-weight:800;font-size:14.5px;color:#2B2B2B;">'+tp.n+'</div>'+gStatusChip(r.st,isDue)+'</div>'
        +'<div style="margin-top:10px;height:6px;border-radius:4px;background:#F1EDE7;"><div style="width:'+pct+'%;height:100%;border-radius:4px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'
        +(r.ok+r.err>0?'<div style="margin-top:7px;font-weight:600;font-size:11px;color:#777163;">верно '+r.ok+' · ошибок '+r.err+'</div>':'')
        +'</button>'});
  });
  area.innerHTML=h;setTxt('g_today','20 тем'+(due.length?' · '+due.length+' на повторение':''))}
function gOpen(t){gTheory(t,true)}
function gTheory(t,fromMap){var area=document.getElementById('g_area');if(!area)return;var tp=G_TOPICS[t];
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'
    +wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ПРАВИЛО</span>'
    +gStatusChip(gRec(t).st)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">'+tp.n+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:10px;">'+tp.th+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="'+(fromMap?('gStart('+t+')'):'gResume()')+'">'+(fromMap?'Начать практику':'Продолжить практику')+'</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">← К темам</button></div>';
  gAnim('win','.32s')}
function gShuffle(a){return grammarModule.shuffled(a)}
function gBankEff(t){var b=G_BANK[t]||{};var ai=(S&&S.gramAi&&S.gramAi[t])||[];
  return grammarModule.effectiveBank(b,ai)}
function gLvl2(t){return grammarModule.levelTwo(gBankEff(t),t)}
function gDue(){return grammarModule.dueTopics(S.gram)}
function gStart(t){var e=gBankEff(t),r=gRec(t);
  var queue=grammarModule.buildTopicQueue(e,t,r);
  GS={t:t,queue:queue,i:0,ok:0,done:0};
  gRenderQ();gGen(t)}
function gResume(){if(GS)gRenderQ();else gMap()}
function gReview(){var due=gDue();if(!due.length){gMap();return}
  var items=[];
  due.forEach(function(t){items=items.concat(gShuffle(gLvl2(t)).slice(0,2))});
  GS={mode:'rev',revT:due.slice(),queue:gShuffle(items),i:0,ok:0,done:0,errT:{}};
  gRenderQ()}
function gProgressLine(){setTxt('g_today',(GS.done)+' / '+GS.queue.length+' в подходе')}
function gRenderQ(){var area=document.getElementById('g_area');if(!area||!GS)return;gProgressLine();
  var it=GS.queue[GS.i];
  if(!it){gFinish();return}
  var t=it.t||GS.t,tp=G_TOPICS[t];
  var head='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+(GS.mode==='rev'?'ПОВТОРЕНИЕ':(it.k==='c'?'УРОВЕНЬ 1 · ВЫБОР':'УРОВЕНЬ 2 · КАК НА ЕГЭ'))+'</span>'
    +'<button type="button" class="clk iconbtn" onclick="gTheory('+t+')" style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;cursor:pointer;">ПРАВИЛО</button></div>';
  if(it.k==='c'||it.k==='c2'){var q=it.q;
    area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+tp.n+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;line-height:1.5;margin-top:8px;">'
      +q.t[0]+'<span style="display:inline-block;min-width:64px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>'+q.t[1]+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'" onclick="gPick(this,'+i+')">'+o+'</button>'}).join('')+'</div>';
  }else{var q=it.q;
    area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+tp.n+' · впиши форму слова</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.55;margin-top:8px;">'
      +q.s.replace('_____','<span style="display:inline-block;min-width:70px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>')+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +'<input id="g_inp" aria-label="Форма слова '+q.b+'" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="Форма слова '+q.b+'" '
      +'style="width:100%;box-sizing:border-box;height:52px;border:1px solid #F0EAE2;border-radius:18px;padding:0 16px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);" onkeydown="if(event.key===\'Enter\')gSubmit()">'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gSubmit()">Проверить</button>'}
  gAnim('win','.32s')}
function gNorm(v){return grammarModule.normalizeAnswer(v)}
function gExplain(it,userWrong){var q=it.q,t=it.t||GS.t;
  var right=it.k==='f'?q.ans[0]:q.o[q.a];
  var sent=it.k==='f'
    ? q.s.replace('_____','<b style="color:#1D7F4A;">'+right+'</b>').replace(/\((?:[A-Z ]+)\)/,'')
    : q.t[0]+'<b style="color:#1D7F4A;">'+right+'</b>'+q.t[1];
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">РАЗБОР ОШИБКИ</span></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:22px;color:#1D7F4A;margin-top:14px;text-align:center;">'+right+'</div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.6;margin-top:10px;text-align:center;font-style:italic;">'+sent+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:12px;background:#FDF3EC;border-left:3px solid #F2683F;border-radius:0 14px 14px 0;padding:11px 14px;"><b>Почему:</b> '+(q.e||'')+'</div>'
    +'<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:12px 14px;">'
    +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ПРАВИЛО · '+G_TOPICS[t].n.toUpperCase()+'</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.6;margin-top:6px;">'+G_TOPICS[t].th+'</div></div>'
    +'<div style="font-weight:600;font-size:11.5px;color:#75705F;margin-top:10px;text-align:center;">Вопрос вернётся в конце подхода</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gAfterExplain()">Понятно, дальше</button></div>';
  gAnim('wflip','.5s')}
function gAfterExplain(){GS.i++;gSync();save();gRenderQ()}
function gAnswer(ok,it){grammarModule.applyAnswer(gRec(it.t||GS.t),GS,it,ok)}
function gPick(btn,i){var it=GS.queue[GS.i];if(!it||btn.dataset.done)return;var q=it.q;
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var ok=i===q.a;
  gAnswer(ok,it);
  if(ok){ui.markAnswer(btn,'correct');gAnim('wpop','.35s');
    setTimeout(function(){GS.i++;gSync();save();gRenderQ()},600)}
  else{ui.markAnswer(btn,'wrong');
    all.forEach(function(b,bi){if(bi===q.a)ui.markAnswer(b,'correct')});
    gAnim('wshake','.42s');
    setTimeout(function(){gExplain(it)},900)}}
function gSubmit(){var it=GS.queue[GS.i];if(!it)return;var inp=document.getElementById('g_inp');if(!inp||inp.dataset.done)return;
  var q=it.q,val=gNorm(inp.value);
  var ok=q.ans.some(function(a){return gNorm(a)===val});
  inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  gAnswer(ok,it);
  if(ok){gAnim('wpop','.35s');setTimeout(function(){GS.i++;gSync();save();gRenderQ()},600)}
  else{inp.value=q.ans[0];gAnim('wshake','.42s');setTimeout(function(){gExplain(it)},900)}}
function gFinish(){if(GS&&GS.mode==='rev'){gFinishRev();return}
  var area=document.getElementById('g_area');var r=gRec(GS.t),tp=G_TOPICS[GS.t];
  var closed=r.st===2;
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:24px;">'+wDeco()
    +'<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14px 0;">'
    +'<div style="font-size:44px;">'+(closed?'🏆':'💪')+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:10px;">'+(closed?'Тема закреплена!':'Подход завершён')+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">'+tp.n+'<br>Верно: '+GS.ok+' из '+GS.done+(closed?'':'<br>Для закрепления — 4 верных ответа уровня 2 подряд')+'</div></div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +(closed?'':'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gStart('+GS.t+')">Ещё подход</button>')
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gToThemes()">К темам</button></div>';
  gAnim('win','.32s');gSync();save()}
function gFinishRev(){var area=document.getElementById('g_area');var rows='';
  GS.revT.forEach(function(t){var r=gRec(t);var bad=GS.errT[t];
    if(bad){r.st=1;r.sr=0;r.due=0}
    else{r.rs=Math.min(2,(r.rs||0)+1);r.due=Date.now()+G_RINT[r.rs]*86400000}
    rows+='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="font-weight:700;font-size:13.5px;color:#2B2B2B;">'+G_TOPICS[t].n+'</div>'
      +(bad?'<span style="flex:none;font-weight:800;font-size:10px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">СНОВА В РАБОТЕ</span>'
           :'<span style="flex:none;font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЧЕРЕЗ '+G_RINT[r.rs]+' ДН.</span>')
      +'</div>'});
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">🧠</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">Повторение завершено</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Верно: '+GS.ok+' из '+GS.done+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gToThemes()">К темам</button></div>';
  GS=null;gSync();save();gAnim('win','.32s')}
/* ===== ЭКЗАМЕН: задания 19–24 (текст с 6 пропусками) ===== */
const G_EXAMS=[
{tx:['Last summer Kate and her brother ',' to St Petersburg. It was their ',' visit to the city. The Hermitage ',' in 1764. Kate thought the real palaces were much ',' than in photos. Now she ',' a new trip together with ',' best friend.'],
 gaps:[{b:'GO',ans:['went'],e:'last summer → Past Simple: went.',t:2},
  {b:'ONE',ans:['first'],e:'Порядковое: one → first.',t:12},
  {b:'FOUND',ans:['was founded'],e:'Музей основали → пассив прошлого: was founded.',t:5},
  {b:'BEAUTIFUL',ans:['more beautiful'],e:'Длинное прилагательное → more beautiful.',t:10},
  {b:'PLAN',ans:['is planning'],e:'now → Present Continuous: is planning.',t:1},
  {b:'SHE',ans:['her'],e:'Перед сущ. → притяжательное her.',t:11}]},
{tx:['Tom is fond of science. Every week he ',' a robotics club. Yesterday, while he ',' on his robot, his teacher said that the results ',' impressive. If Tom ',' the city contest, he will go to the national final. It will be the ',' competition in his life. Tom believes that in the future robots ',' everywhere.'],
 gaps:[{b:'ATTEND',ans:['attends'],e:'every week → Present Simple, he → attends.',t:1},
  {b:'WORK',ans:['was working'],e:'while → Past Continuous: was working.',t:2},
  {b:'BE',ans:['were'],e:'Косвенная речь: сдвиг are → were.',t:7},
  {b:'WIN',ans:['wins'],e:'1 тип условия: после if — Present Simple.',t:6},
  {b:'THREE',ans:['third'],e:'three → third.',t:12},
  {b:'USE',ans:['will be used'],e:'Будущее в пассиве → will be used.',t:5}]},
{tx:['My granny lives in the country. Her house ',' by my great-grandfather. It is much ',' than our flat. When I visited her last month, she ',' jam. She said she ',' me a jar. Granny keeps three cats, and each of ',' has ',' own bowl.'],
 gaps:[{b:'BUILD',ans:['was built'],e:'Дом построили → пассив: was built.',t:5},
  {b:'OLD',ans:['older'],e:'Сравнение: older than.',t:10},
  {b:'MAKE',ans:['was making'],e:'Процесс в момент прошлого → was making.',t:2},
  {b:'GIVE',ans:['would give'],e:'Косвенная речь: will give → would give.',t:7},
  {b:'THEY',ans:['them'],e:'each of them.',t:11},
  {b:'IT',ans:['its'],e:'Притяжательное its (без апострофа).',t:11}]}
];
let EX=null;
function gExamPool(){var ai=(S&&S.examAi)||[];return G_EXAMS.concat(ai)}
function gExam(){var area=document.getElementById('g_area');if(!area)return;
  var st=S.exam19||{};
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Задания 19–24</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Связный текст с шестью пропусками. Впиши правильную форму слов, данных ЗАГЛАВНЫМИ буквами — без вариантов ответа, как на настоящем экзамене. Идёт таймер.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний результат: '+st.last+' из 6 · лучший: '+st.best+' из 6</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">← К темам</button></div>';
  gAnim('win','.32s');gExamGen()}
function gExamStart(){var pool=gExamPool();
  S.examIdx=(S.examIdx||0);var ex=pool[S.examIdx%pool.length];S.examIdx++;
  if(EX&&EX.iv)clearInterval(EX.iv);
  EX={ex:ex,t0:Date.now(),iv:setInterval(function(){setTxt('g_today',gExamFmt(Math.floor((Date.now()-EX.t0)/1000)))},1000)};
  var area=document.getElementById('g_area');
  var txt='';
  ex.tx.forEach(function(seg,i){txt+=seg;
    if(i<6)txt+='<b style="color:#B54E2F;">'+(19+i)+'</b>&nbsp;<span style="display:inline-block;min-width:56px;border-bottom:2.5px dashed #F2683F;"></span>&nbsp;<b style="color:#777163;font-size:12px;">('+ex.gaps[i].b+')</b> '});
  var inputs=ex.gaps.map(function(g,i){
    return '<div style="display:flex;align-items:center;gap:10px;">'
      +'<span style="flex:none;width:64px;font-weight:800;font-size:12.5px;color:#B54E2F;">'+(19+i)+' · '+g.b+'</span>'
      +'<input id="g_ex_'+i+'" aria-label="Пропуск '+(19+i)+', форма слова '+g.b+'" autocapitalize="none" autocomplete="off" spellcheck="false" style="flex:1;box-sizing:border-box;height:46px;border:1px solid #F0EAE2;border-radius:15px;padding:0 13px;font-family:Manrope,sans-serif;font-weight:700;font-size:14px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);"></div>'}).join('');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 19–24</span></div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.7;margin-top:12px;">'+txt+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:9px;">'+inputs
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:3px;" onclick="gExamCheck()">Проверить</button></div>';
  gAnim('win','.32s')}
function gExamCheck(){if(!EX)return;var ex=EX.ex;
  clearInterval(EX.iv);var sec=examModule.elapsedSeconds(EX.t0,Date.now());
  var score=0,rows='',bank=[];
  ex.gaps.forEach(function(g,i){var inp=document.getElementById('g_ex_'+i);var val=gNorm(inp?inp.value:'');
    var ok=g.ans.some(function(a){return gNorm(a)===val});
    if(ok)score++;
    else{if(g.t){var r=gRec(g.t);r.err++;if(r.st===2)r.due=Date.now()}
      bank.push({module:'grammar',itemKey:'grammar_19_24:'+String(g.b).toLowerCase(),errorType:'incorrect_form',details:{expected:String(g.ans[0])}})}
    rows+='<div style="padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<span style="font-weight:800;font-size:13px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(19+i)+' · '+g.b+' → '+g.ans[0]+'</span>'
      +(ok?'<span style="font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:4px 9px;border-radius:20px;">ВЕРНО</span>'
          :'<span style="font-weight:800;font-size:10px;color:#A83226;background:#FDEDEA;padding:4px 9px;border-radius:20px;">'+((document.getElementById('g_ex_'+i)||{}).value||'—')+'</span>')
      +'</div>'
      +(ok?'':'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:4px;">'+g.e+'</div>')
      +'</div>'});
  S.exam19=examModule.record(S.exam19,score);
  if(typeof SRV!=='undefined'&&SRV&&TOKEN&&typeof crypto!=='undefined'&&crypto.randomUUID){
    apiPost('/api/v1/module-attempts',examModule.attempt(crypto.randomUUID(),{module:'exam',activity:'grammar_19_24',score:score,maxScore:6,durationMs:sec*1000})).catch(function(){})}
  if(bank.length&&typeof SRV!=='undefined'&&SRV&&TOKEN){apiPost('/api/v1/error-bank',{errors:bank}).catch(function(){})}
  EX=null;save();gSync();
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(score,6)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+score+' из 6</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+(score<6?' · слабые темы отмечены к повторению':'')+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gExamStart()">Ещё текст</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">К темам</button></div>';
  gAnim('win','.32s');gExamGen()}
/* фоновая генерация новых экзаменационных текстов */
var G_EXGEN=false;
async function gExamGen(){
  if(G_EXGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  if(gExamPool().length>=8)return;G_EXGEN=true;
  try{
    var d=await generateAiContent('grammar_exam_19_24');
    if(d&&Array.isArray(d.tx)&&d.tx.length===7&&Array.isArray(d.gaps)&&d.gaps.length===6
       &&d.gaps.every(function(g){return g&&g.b&&Array.isArray(g.ans)&&g.ans.length})){
      var ex={tx:d.tx.map(String),gaps:d.gaps.map(function(g){return{b:String(g.b),ans:g.ans.map(String),e:String(g.e||''),t:+g.t||0}})};
      S.examAi=(S.examAi||[]).concat([ex]);save()}
  }catch(e){}
  G_EXGEN=false}
/* фоновая ИИ-догенерация заданий по теме */
var G_GEN=false;
async function gGen(t){
  if(G_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var ai=(S.gramAi&&S.gramAi[t])||[];
  if(ai.length>=15)return;G_GEN=true;
  try{
    var tp=G_TOPICS[t];
    var d=await generateAiContent('grammar_topic_set',{topicId:t,topic:tp.n});var add=[];
    if(d&&Array.isArray(d.c))d.c.forEach(function(q){if(q&&Array.isArray(q.t)&&q.t.length>=2&&Array.isArray(q.o)&&q.o.length===4&&+q.a>=0&&+q.a<4)add.push({k:'c',q:{t:[String(q.t[0]),String(q.t[1])],o:q.o.map(String),a:+q.a,e:String(q.e||'')}})});
    if(d&&Array.isArray(d.f))d.f.forEach(function(q){if(q&&q.s&&String(q.s).indexOf('_____')>=0&&Array.isArray(q.ans)&&q.ans.length)add.push({k:'f',q:{s:String(q.s),b:String(q.b||''),ans:q.ans.map(String),e:String(q.e||'')}})});
    if(add.length){S.gramAi=S.gramAi||{};S.gramAi[t]=((S.gramAi[t])||[]).concat(add);save()}
  }catch(e){}
  G_GEN=false}
registerRouteHook(function(id){if(id==='scr3')initGrammar()});
/* Экзамен по грамматике не должен тикать в фоне после ухода с экрана. */
registerRouteHook(function(id){if(EX&&EX.iv){clearInterval(EX.iv);EX=null}if(id==='scr3')GS=null});
registerScreenGenerator('scr3',genGrammar);

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  gAfterExplain,gExam,gExamCheck,gExamStart,gMap,gOpen,gPick,gResume,gReview,gStart,gSubmit,
  gTheory,gToThemes,
};
