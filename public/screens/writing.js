/*
 * Экран «Письмо» (scr8). Приезжает динамическим import() при первом переходе на него.
 * Банк тем грузится оболочкой на старте и лежит в W37/W38: он нужен офлайн и не зависит от того,
 * дошёл ли ученик до письма.
 */
import {HIST,registerRouteHook,showScreen,tab} from '../router.js';
import {
  DEMO_MODE,S,SRV,TOKEN,W37,W38,apiPost,ringOff,save,setTxt,ui,writingModule,
} from '../app.js';

const WRITE={
 37:{label:'ЗАДАНИЕ 37 · ПИСЬМО ДРУГУ',range:'100–140',min:100,max:140,table:false,
   prompt:'Your friend Sam asks about your hobbies. Answer his 3 questions and ask 3 questions about his guitar lessons.'},
 38:{label:'ЗАДАНИЕ 38 · OPINION ESSAY',range:'200–250',min:200,max:250,table:true,
   prompt:'“Online learning is better than studying at school.” Опиши данные опроса, дай мнение с аргументами, контраргумент и вывод.'}
};
/* ---------- WRITING ---------- */
let curTask=38;
const SEG_ON='flex:1;border:0;font-family:inherit;text-align:center;padding:8px 0;font-weight:700;font-size:13px;color:#B54E2F;background:#fff;border-radius:11px;cursor:pointer;';
const SEG_OFF='flex:1;border:0;font-family:inherit;text-align:center;padding:8px 0;font-weight:700;font-size:13px;color:rgba(255,255,255,.92);background:transparent;cursor:pointer;';
function countWords(){const st=writingModule.wordCountStatus(document.getElementById('w_editor').innerText,curTask);
  const e=document.getElementById('w_count');e.textContent=st.count+' / '+st.range+' слов · '+st.hint;e.style.color=st.ok?'#1D7F4A':(st.state==='over'?'#B94A37':'#6A6E75')}
function renderReview(d,evaluationScope){
  const safe=ui.escapeHtml;
  const totals=writingModule.reviewTotals(d);const got=totals.got,mx=totals.max;
  document.getElementById('rv_score').textContent=got;
  document.getElementById('rv_max').textContent='из '+mx;
  document.getElementById('ai_disclaimer').textContent=ui.AI_DISCLAIMER;
  const scopeNotice=document.getElementById('rv_scope_notice');
  const scopeText=writingModule.evaluationNotice(evaluationScope);
  scopeNotice.textContent=scopeText;scopeNotice.hidden=!scopeText;
  document.getElementById('rv_ring').setAttribute('stroke-dashoffset',String(226-226*(mx?got/mx:0)));
  document.getElementById('rv_verdict').textContent=d.verdict||'Готово!';
  document.getElementById('rv_sub').textContent=d.sub||'';
  const cc=document.getElementById('rv_crit');cc.innerHTML='';
  (d.criteria||[]).forEach(c=>{const p=c.max?Math.round(c.got/c.max*100):0;const col=p>=100?'#1F9E5A':p>=60?'#E8A33C':'#E26A56';const tc=p>=100?'#1D7F4A':p>=60?'#A56000':'#B94A37';
    cc.insertAdjacentHTML('beforeend','<div style="display:flex;align-items:center;gap:12px;"><span style="flex:1;font-weight:600;font-size:13px;color:#2B2B2B;">'+safe(c.name)+'</span><div style="width:96px;height:8px;border-radius:5px;background:#F1F1F3;"><div style="width:'+p+'%;height:100%;border-radius:5px;background:'+col+';"></div></div><span style="font-weight:800;font-size:12.5px;color:'+tc+';width:30px;text-align:right;">'+safe(c.got)+'/'+safe(c.max)+'</span></div>')});
  const errs=d.errors||[];document.getElementById('rv_errhdr').textContent='РАЗБОР ОШИБОК · '+errs.length;
  const eb=document.getElementById('rv_err');eb.innerHTML='';
  errs.forEach((e,idx)=>{const warn=e.kind==='warn';
    const icon=warn?'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C77400" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>':'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9503C" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    const body=warn?safe(e.note||''):'<span style="text-decoration:line-through;color:#B94A37;">'+safe(e.wrong||'')+'</span> → <span style="color:#1D7F4A;font-weight:700;">'+safe(e.right||'')+'</span>'+(e.note?'<br>'+safe(e.note):'');
    if(idx)eb.insertAdjacentHTML('beforeend','<div style="height:1px;background:#F4F5F6;margin:13px 0;"></div>');
    eb.insertAdjacentHTML('beforeend','<div style="display:flex;gap:11px;"><span style="width:26px;height:26px;flex:none;border-radius:9px;background:'+(warn?'#FFF4DE':'#FCEEEC')+';display:grid;place-items:center;">'+icon+'</span><div style="flex:1;"><div style="font-weight:700;font-size:13.5px;color:#2B2B2B;">'+safe(e.title||'Ошибка')+'</div><div style="margin-top:4px;font-weight:500;font-size:12.5px;color:#6A6E75;line-height:1.45;">'+body+'</div></div></div>')});
}
function localReview(n,task,msg){return writingModule.localReview(n,task,msg)}
/* ===== WRITING v2: банк тем, стимулы как на ЕГЭ, шпаргалки, черновики, история ===== */
/*
 * Section 10.1: the built-in tasks come from the shared /task-bank.json, the same file the server
 * reads. One source means the identifier the client sends always means something on the server.
 * The file is part of the offline shell, so section 6.1 keeps working without a network.
 */
let W_SHEET=false,_wrBound=false;

function wrPool(t){var ai=(S&&S.writeAi&&S.writeAi['t'+t])||[];return writingModule.pool(t===37?W37:W38,ai)}
function wrIdx(t){return (t===37?(S.wIdx37||0):(S.wIdx38||0))}
function wrCur(){return writingModule.current(wrPool(curTask),wrIdx(curTask))}
function wrKey(){return writingModule.draftKey(curTask,wrIdx(curTask))}
function wrNext(){if(curTask===37)S.wIdx37=(S.wIdx37||0)+1;else S.wIdx38=(S.wIdx38||0)+1;
  W_SHEET=false;save();setTask(curTask);wrGen()}
function wrSheet(){W_SHEET=!W_SHEET;setTask(curTask)}
function wrHistHtml(){var ws=(S.works||[]).slice(-3).reverse();
  if(!ws.length)return '<div style="margin-top:12px;">'
    +ui.stateMarkup({kind:'empty',title:'Проверенных работ пока нет',
      description:'Напиши ответ и нажми «Проверить» — разбор появится здесь'})+'</div>';
  return '<div style="margin-top:12px;border-top:1px solid #F4EFE9;padding-top:10px;">'
    +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#6F695E;">ПОСЛЕДНИЕ РАБОТЫ</div>'
    +ws.map(function(w){var d=new Date(w.ts);
      return '<div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:600;font-size:12px;color:#4A453E;">'
        +'<span>Задание '+w.t+' · '+('0'+d.getDate()).slice(-2)+'.'+('0'+(d.getMonth()+1)).slice(-2)+'</span>'
        +'<span style="font-weight:800;color:'+(w.g/w.m>=0.7?'#1D7F4A':(w.g/w.m>=0.4?'#A56000':'#A83226'))+';">'+w.g+' из '+w.m+'</span></div>'}).join('')+'</div>'}
const W_SHEET37='<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">КАК ПИСАТЬ ПИСЬМО · ПОШАГОВО</div>'
 +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.7;margin-top:8px;">'
 +'Письмо собирается как конструктор из 7 частей — иди по шагам:<br><br>'
 +'<b>1. Поздоровайся.</b> На отдельной строке: <i>Dear Emily,</i><br><br>'
 +'<b>2. Поблагодари за письмо</b> (1-2 предложения): <i>Thanks a lot for your email! It was great to hear from you again.</i><br><br>'
 +'<b>3. Ответь на все 3 вопроса друга.</b> Перечитай письмо сверху — в нём три вопроса со знаком «?». На каждый ответь 1-2 предложениями. Пропустишь вопрос — потеряешь баллы.<br><br>'
 +'<b>4. Задай свои 3 вопроса</b> о том, что выделено в задании жирным. Например, о новой квартире: <i>By the way, what is your new flat like? How many rooms are there? Is it far from your school?</i><br><br>'
 +'<b>5. Объясни, почему заканчиваешь:</b> <i>Anyway, I have to go now — it is time for my English lesson.</i><br><br>'
 +'<b>6. Пожелай на прощание:</b> <i>Hope to hear from you soon!</i><br><br>'
 +'<b>7. Подпишись.</b> На отдельной строке <i>Best wishes,</i> и ниже только имя без точки: <i>Anya</i><br><br>'
 +'<b>Перед отправкой проверь:</b> 100–140 слов · ровно три «?» в твоих вопросах · без адреса и даты — в электронном письме они не нужны.</div>';
const W_SHEET38='<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">КАК ПИСАТЬ ПРОЕКТ · ПОШАГОВО</div>'
 +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.7;margin-top:8px;">'
 +'Это сочинение по данным опроса из таблицы. Ровно <b>5 абзацев</b>, у каждого своя задача:<br><br>'
 +'<b>1. Вступление — зачем этот проект:</b> <i>I am currently working on a project on why teenagers do sport. I have found a table with the results of a survey, and I would like to comment on the data.</i><br><br>'
 +'<b>2. Назови 2-3 цифры из таблицы своими словами:</b> <i>According to the data, almost half of the teenagers (45%) do sport to keep fit.</i> Дословно переписывать строки таблицы нельзя!<br><br>'
 +'<b>3. Сравни 1-2 показателя:</b> <i>Keeping fit is almost twice as popular as meeting friends — 45% against 25%.</i><br><br>'
 +'<b>4. Назови проблему по теме и предложи решение:</b> <i>However, many teenagers give up sport because of school workload. A possible solution is short workouts at home.</i><br><br>'
 +'<b>5. Вывод + твоё мнение:</b> <i>In conclusion, I strongly believe that sport plays an important role in teenagers\u0027 lives.</i><br><br>'
 +'<b>Перед отправкой проверь:</b> 200–250 слов · мнение только во вступлении и выводе · пять абзацев на месте.</div>';
/* — перерисовка карточки задания — */
function setTask(n){curTask=n;var d=WRITE[n],tp=wrCur();
  var s37=document.getElementById('w_seg37'),s38=document.getElementById('w_seg38');
  if(s37)s37.setAttribute('style',n===37?SEG_ON:SEG_OFF);
  if(s38)s38.setAttribute('style',n===38?SEG_ON:SEG_OFF);
  setTxt('w_tasklabel',n===37?'ЗАДАНИЕ 37 · ПИСЬМО ДРУГУ':'ЗАДАНИЕ 38 · ПРОЕКТ С ДАННЫМИ');
  var th=document.getElementById('w_tablehint');if(th)th.style.display='none';
  var p=document.getElementById('w_prompt');
  if(p){var h='';
    if(n===37){
      h+='<div style="background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">From: '+tp.from+'<br>'+tp.stim+'</div>'
        +'<div style="margin-top:9px;font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.5;">Напиши ответ (100–140 слов): ответь на 3 вопроса '+tp.from+' и задай <b>3 вопроса</b> about <b>'+tp.ask+'</b>.</div>';
    }else{
      h+='<div style="font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.5;">Imagine you are doing a project «<b>'+tp.topic+'</b>». You have found some data (see the table). Comment on the data and give your opinion (200–250 слов).</div>'
        +'<div style="margin-top:9px;background:#FAF6F1;border-radius:14px;padding:6px 13px;">'
        +tp.rows.map(function(r){return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #F0E9E0;font-weight:600;font-size:12.5px;color:#4A453E;"><span>'+r[0]+'</span><b style="color:#C2421B;">'+r[1]+'%</b></div>'}).join('')+'</div>';
    }
    h+='<div style="margin-top:11px;display:flex;gap:8px;">'
      +'<button type="button" class="clk sq iconbtn" onclick="wrNext()" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Новая тема</button>'
      +'<button type="button" class="clk sq iconbtn" onclick="wrSheet()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(W_SHEET?'Скрыть шпаргалку':'Шпаргалка')+'</button></div>';
    if(W_SHEET)h+='<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;">'+(n===37?W_SHEET37:W_SHEET38)+'</div>';
    h+=wrHistHtml();
    p.innerHTML=h;
  }
  /* черновик */
  var ed=document.getElementById('w_editor');
  if(ed){S.drafts=S.drafts||{};ed.innerText=S.drafts[wrKey()]||'';
    if(!_wrBound){_wrBound=true;
      ed.addEventListener('input',function(){S.drafts=S.drafts||{};S.drafts[wrKey()]=ed.innerText;save()})}}
  countWords()}
/* — проверка ИИ: актуальные критерии + контекст темы + история — */
async function checkWriting(){
  var t=(document.getElementById('w_editor').innerText||'').trim();
  var n=writingModule.countWords(t);
  if(n<10){alert('Напиши хотя бы несколько предложений.');return}
  tab('scr13');var task=curTask,tp=wrCur();
  if(DEMO_MODE){renderReview(localReview(n,task,'демо-режим'));showScreen('scr12');HIST.push('scr8');return}
  if(!tp||!tp.id){renderReview(localReview(n,task,'задание не определено'));showScreen('scr12');HIST.push('scr8');return}
  try{
    var payload=writingModule.buildPayload(task,tp,t);
    var response=await apiPost('/api/v1/ai/evaluate-writing',payload,true);
    var d=response&&response.review;
    if(!d||!d.criteria)throw new Error('bad');
    wrStore(d,n,task);
    renderReview(d,response.evaluationScope);S.essays=(S.essays||0)+1;save();showScreen('scr12');HIST.push('scr8');
  }catch(e){renderReview(localReview(n,task,e.message));showScreen('scr12');HIST.push('scr8')}}
function wrStore(d,n,task){
  S.works=writingModule.appendWork(S.works,{t:task,g:+d.overall_got||0,m:+d.overall_max||writingModule.limits(task).maxScore,n:n,ts:Date.now()});
  var sum=writingModule.summary(S.works),avg=sum.average;
  S.prog=S.prog||{};S.prog.write=avg;
  setTxt('sub_write','работ: '+sum.count+' · средний '+avg+'%');
  try{setTxt('m_write',avg);ringOff('ring_write',113.1,avg)}catch(e){}}
/* — фоновая ИИ-генерация тем — */
var WR_GEN=false;
async function wrGen(){
  if(WR_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.writeAi=S.writeAi||{t37:[],t38:[]};
  var kind=null;
  if(wrPool(37).length<6)kind=37;else if(wrPool(38).length<6)kind=38;
  if(!kind)return;WR_GEN=true;
  try{
    /* Раздел 10.1: сервер сначала отдаёт задание из общего банка и платит за генерацию,
       только если для этого ученика в банке ничего нового не осталось. */
    var r=await apiPost('/api/v1/tasks/next',{operation:kind===37?'writing_task_37':'writing_task_38'},true);
    var item=writingModule.normalizeGenerated(kind,r&&r.task,r&&(r.externalId||r.taskId));
    if(item&&!wrPool(kind).some(function(x){return x.id===item.id})){S.writeAi['t'+kind].push(item);save()}
  }catch(e){}
  WR_GEN=false;
  try{if(wrPool(37).length<6||wrPool(38).length<6)setTimeout(wrGen,4000)}catch(e){}}
/* — запуск генерации при входе, синк плитки при старте — */
registerRouteHook(function(id){if(id==='scr8'){setTask(curTask);wrGen()}});
/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {checkWriting,countWords,setTask,wrNext,wrSheet};
