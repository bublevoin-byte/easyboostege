/* Reading 2.0: lazy canonical catalog, owner-bound rotation and one full-section flow. */
import {registerRouteHook} from '../router.js';
import {prepareVoiceTutorContextResult,registerVoiceTutorContextResult} from '../voice-tutor.js';
import {
  EGE_WORDS,S,currentUser,lastWord,lastWordContext,readingModule,rEsc,rSync,rWordsHtml,
  registerScreenGenerator,save,setTxt,srsRecordVocabularyOutcome,toast,wBase,wSync,
} from '../app.js';
import {createLearningActivityEvidence,recordLearningActivityEvidence} from '../learning-activity-recorder.js';
import {
  normalizeVocabularyWord,personalVocabularyCardId,upsertReadingVocabularyCard,
} from '../vocabulary-domain.js';

const KINDS=['task10','task11','task12_18'];
const KIND_META={
  task10:{title:'Task 10',heading:'Задание 10',description:'7 текстов · 8 заголовков',activity:'headings',accent:'coral'},
  task11:{title:'Task 11',heading:'Задание 11',description:'6 пропусков · 7 фрагментов',activity:'gaps',accent:'amber'},
  task12_18:{title:'Task 12–18',heading:'Задания 12–18',description:'длинный текст · 7 вопросов · 4 варианта',activity:'questions',accent:'green'},
};
const AUTO_CHECK_COPY='Формат, ключи, количество элементов и цитаты-доказательства проверены программно. Это оригинальный учебный материал Easy Boost, не официальный вариант ФИПИ и не ручная проверка методистом.';
const TECHNICAL_SET=readingModule.adaptLegacyFallback('task10',{
  hl:['A quieter journey','A useful school habit','Helping close to home'],
  txts:[
    {t:'Students opened a book exchange shelf beside the library. Anyone can leave one book and take another, so useful stories stay in circulation.',a:1,k:'Обмен книгами стал регулярной школьной привычкой.'},
    {t:'A weekend group delivers shopping to neighbours who cannot easily leave home. Each volunteer receives a short list and a nearby address.',a:2,k:'Волонтёры помогают людям в своём районе.'},
  ],
},{title:'Техническая тренировка'});

let catalog=null;
let loadingPromise=null;
let training=null;
let full=null;
let fullTimer=null;
let notice='';
let submissionLocked=false;
let RE=null,RQ=null;

function area(){return document.getElementById('r_area')}
function ownerId(){
  const session=window.__sub;
  return currentUser&&session?.authenticated===true&&session?.active===true&&session.username===currentUser
    ? currentUser:null;
}
function state(){
  const owner=ownerId();
  if(!owner)return null;
  S.readingPilot=readingModule.migrateLegacyState(owner,S.readingPilot||S.read);
  return S.readingPilot;
}
function h(value){return rEsc(value)}
function formatTime(milliseconds){
  const seconds=Math.max(0,Math.floor(Number(milliseconds||0)/1000));
  return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
}
function setHeader(summary,text){
  setTxt('r_sumline',summary);setTxt('r_today',text);
  const bar=document.getElementById('r_bar');if(bar)bar.style.width='100%';
}
function statusMarkup(kind,title,copy,actions=''){
  return '<section class="reading-status reading-status--'+kind+'" role="'+(kind==='error'?'alert':'status')+'" aria-live="polite">'
    +'<span class="reading-status__mark" aria-hidden="true">'+(kind==='loading'?'<span class="reading-spinner"></span>':(kind==='error'?'!':'·'))+'</span>'
    +'<h2>'+h(title)+'</h2><p>'+h(copy)+'</p>'+actions+'</section>';
}
function renderLoading(){
  setHeader('Загружаем 60 комплектов','Каталог Reading 2.0');
  area().innerHTML='<main class="reading2"><div class="reading-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>'
    +statusMarkup('loading','Каталог загружается','Подключаем три формата и проверяем версию.')+'</main>';
}
function renderOwnerError(){
  setHeader('Доступ не подтверждён','Reading 2.0');
  area().innerHTML='<main class="reading2">'+statusMarkup('error','Нужна подтверждённая сессия','Мы не начинаем Reading без owner ID из активной серверной сессии.')+'</main>';
}
function renderCatalogError(){
  const offline=navigator.onLine===false;
  setHeader('Каталог недоступен',offline?'Нет сети':'Ошибка загрузки');
  const actions='<div class="reading-actions"><button class="reading-action reading-action--primary" type="button" data-reading-action="retry">Повторить загрузку</button>'
    +'<button class="reading-action reading-action--secondary" type="button" data-reading-action="technical">Техническая тренировка</button></div>';
  area().innerHTML='<main class="reading2">'+statusMarkup('error','Каталог не загрузился',offline?'Нет доступа к кэшу каталога. Подключитесь к сети и повторите.':'Не удалось проверить все 60 комплектов. Прогресс не изменён.',actions)+'</main>';
  bindActions();
}
function validationDetails(){
  return '<details class="reading-validation"><summary>Автоматически проверено</summary><p>'+h(AUTO_CHECK_COPY)+'</p></details>';
}
function kindStats(kind,summary){
  const item=summary.perKind[kind];
  return '<dl class="reading-kind-stats"><div><dt>Новые</dt><dd>'+item.newSets+'</dd></div><div><dt>Пройдены</dt><dd>'+item.completedSets+'</dd></div>'
    +'<div><dt>Слабые</dt><dd>'+item.weakSets+'</dd></div><div><dt>К повтору</dt><dd>'+item.dueSets+'</dd></div></dl>';
}
function hubReport(summary){
  const accuracy=KINDS.reduce((sum,kind)=>sum+summary.perKind[kind].correct,0);
  const total=KINDS.reduce((sum,kind)=>sum+summary.perKind[kind].total,0);
  const trend={up:'растёт',down:'снизилась',steady:'стабильна',insufficient:'пока мало данных'}[summary.trend];
  const weak=summary.weakestKind?KIND_META[summary.weakestKind].title:'определим после первой тренировки';
  return '<section class="reading-report" aria-labelledby="reading-report-title"><h2 id="reading-report-title">Краткий отчёт</h2><div class="reading-report__grid">'
    +'<p><strong>'+(total?Math.round(accuracy/total*100)+'%':'—')+'</strong><span>точность</span></p><p><strong>'+h(trend)+'</strong><span>недавняя динамика</span></p><p><strong>'+h(weak)+'</strong><span>слабейший формат</span></p></div></section>';
}
function renderHub(){
  stopFullTimer();training=null;RE=null;RQ=null;
  const owner=ownerId(),current=state();if(!catalog||!owner||!current)return;
  const summary=readingModule.catalogSummary(catalog,owner,current.history,Date.now());
  setHeader(summary.completedSets?('Пройдено '+summary.completedSets+' из 60 комплектов'):'60 комплектов для ротации','Каталог Reading 2.0');
  const cards=KINDS.map((kind)=>'<article class="reading-launch-card reading-launch-card--'+KIND_META[kind].accent+'"><div class="reading-launch-card__head"><span aria-hidden="true">'+(kind==='task10'?'10':kind==='task11'?'11':'12–18')+'</span><div><h2>'+KIND_META[kind].title+'</h2><p>'+KIND_META[kind].description+'</p></div></div>'+kindStats(kind,summary)
    +'<button class="reading-action reading-action--secondary" type="button" data-reading-action="training" data-kind="'+kind+'">Начать '+KIND_META[kind].title+'</button></article>').join('');
  const noticeMarkup=notice?'<p class="reading-notice" role="status" aria-live="polite">'+h(notice)+'</p>':'';notice='';
  area().innerHTML='<main class="reading2 reading-hub"><header class="reading-title"><p class="reading-kicker">ЕГЭ-2026 · раздел 2</p><h1>Каталог чтения</h1><p>60 комплектов: три точных формата и полный раздел без Premium-gate. Выбор комплекта: новый → к повтору → слабый → давний.</p></header>'+noticeMarkup
    +'<section class="reading-full-card"><div><p class="reading-kicker">ПОЛНЫЙ РАЗДЕЛ</p><h2>Полный раздел 10–18</h2><p>9 официально учитываемых заданий · 20 полей ответа · один elapsed timer</p></div><button class="reading-action reading-action--primary" type="button" data-reading-action="full-intro">Полный раздел 10–18</button></section>'
    +'<section class="reading-card-grid">'+cards+'</section>'+hubReport(summary)+validationDetails()+'</main>';
  bindActions();
}

function emptyAnswers(kind,set){
  const length=kind==='task10'?set.task.texts.length:kind==='task11'?set.task.answers.length:set.task.questions.length;
  return Array.from({length},()=>null);
}
function selectedOptions(count,selected,alphabet=false){
  let options='<option value="">Не выбрано</option>';
  for(let index=0;index<count;index++)options+='<option value="'+index+'"'+(selected===index?' selected':'')+'>'+(alphabet?String.fromCharCode(65+index):String(index+1))+'</option>';
  return options;
}
function taskMarkup(set,answers,fullMode=false){
  const kind=set.kind,disabled=training?.result?' disabled':'';
  if(kind==='task10'){
    const headings=set.task.headings.map((heading,index)=>'<li data-reading-heading><b>'+String.fromCharCode(65+index)+'.</b> '+h(heading)+'</li>').join('');
    const rows=set.task.texts.map((text,index)=>'<article class="reading-field-card"><div class="reading-text"><strong>Текст '+h(text.id)+'</strong><p>'+rWordsHtml(text.text)+'</p></div><label>Заголовок для текста '+h(text.id)+'<select data-reading-answer data-kind="task10" data-position="'+index+'" aria-label="Ответ для текста '+h(text.id)+'"'+disabled+'>'+selectedOptions(set.task.headings.length,answers[index],true)+'</select></label></article>').join('');
    return '<section data-reading-kind="task10"><div class="reading-options"><h2>'+set.task.headings.length+' заголовков, один лишний</h2><ol>'+headings+'</ol></div>'+rows+'</section>';
  }
  if(kind==='task11'){
    const fragments=set.task.fragments.map((fragment,index)=>'<li data-reading-fragment><b>'+String.fromCharCode(65+index)+'.</b> '+h(fragment)+'</li>').join('');
    const passage=set.task.segments.map((segment,index)=>rWordsHtml(segment)+(index<answers.length?'<span class="reading-gap">['+(answers[index]===null?String(index+1):String.fromCharCode(65+answers[index]))+']</span>':'' )).join('');
    const rows=answers.map((answer,index)=>'<label class="reading-field-card">Пропуск '+String.fromCharCode(65+index)+'<select data-reading-answer data-kind="task11" data-position="'+index+'" aria-label="Ответ для пропуска '+String.fromCharCode(65+index)+'"'+disabled+'>'+selectedOptions(set.task.fragments.length,answer,true)+'</select></label>').join('');
    return '<section data-reading-kind="task11"><article class="reading-passage reading-text"><h2>Текст с '+answers.length+' пропусками</h2><p>'+passage+'</p></article><div class="reading-options"><h2>'+set.task.fragments.length+' фрагментов, один лишний</h2><ol>'+fragments+'</ol></div><div class="reading-field-grid">'+rows+'</div></section>';
  }
  const questions=set.task.questions.map((question,index)=>'<fieldset class="reading-question" data-reading-question><legend><span>'+(index+12)+'</span>'+h(question.prompt)+'</legend><div class="reading-radio-list">'+question.options.map((option,optionIndex)=>'<label><input type="radio" name="reading-'+(fullMode?'full':'training')+'-'+index+'" value="'+optionIndex+'" data-reading-answer data-kind="task12_18" data-position="'+index+'" aria-label="Задание '+(index+12)+', вариант '+(optionIndex+1)+'"'+(answers[index]===optionIndex?' checked':'')+disabled+'><span><b>'+(optionIndex+1)+'.</b> '+h(option)+'</span></label>').join('')+'</div></fieldset>').join('');
  return '<section data-reading-kind="task12_18"><article class="reading-passage reading-text"><h2>'+h(set.title)+'</h2><div>'+rWordsHtml(set.task.text).replaceAll('\n','<br><br>')+'</div></article>'+questions+'</section>';
}
function trainingProgress(){
  if(!training)return '';
  const total=training.answers.length,answered=training.answers.filter((answer)=>answer!==null).length;
  return '<p class="reading-progress" role="status" aria-live="polite"><span>'+KIND_META[training.kind].heading+'</span><strong>'+answered+' из '+total+' полей заполнено</strong></p>';
}
function renderTraining(){
  const item=training;if(!item)return;
  const technical=item.set.recordable===false;
  setHeader(KIND_META[item.kind].heading,training.answers.filter((answer)=>answer!==null).length+' / '+training.answers.length);
  const technicalNote=technical?'<p class="reading-technical" role="status"><strong>Техническая тренировка.</strong> Она не входит в 60 комплектов, не записывается в прогресс и не влияет на ротацию.</p>':'';
  area().innerHTML='<main class="reading2 reading-practice"><header class="reading-title"><p class="reading-kicker">'+(technical?'АВАРИЙНЫЙ OFFLINE FALLBACK':'ОТДЕЛЬНАЯ ТРЕНИРОВКА')+'</p><h1>'+KIND_META[item.kind].heading+'</h1><p>'+h(item.set.title)+' · '+h(item.set.cefr||'технический')+'</p></header>'+technicalNote+trainingProgress()+taskMarkup(item.set,item.answers)
    +'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button><button class="reading-action reading-action--primary" type="button" data-reading-action="submit-training"'+(item.answers.every((answer)=>answer!==null)?'':' disabled')+'>Завершить тренировку</button></div></main>';
  bindActions();
}
function answerLabel(set,index,value){
  if(value===null||value===undefined)return 'Нет ответа';
  if(set.kind==='task10')return String.fromCharCode(65+value)+'. '+set.task.headings[value];
  if(set.kind==='task11')return String.fromCharCode(65+value)+'. '+set.task.fragments[value];
  return (value+1)+'. '+set.task.questions[index].options[value];
}
function reviewMarkup(set,result,voice=null){
  return '<section class="reading-review-list" aria-label="Полный разбор">'+result.review.map((row,index)=>'<article class="reading-review reading-review--'+(row.correct?'correct':'wrong')+'" data-reading-review-row><header><span aria-hidden="true">'+(row.correct?'✓':'×')+'</span><h3>Позиция '+h(row.position)+' · '+(row.correct?'верно':'есть ошибка')+'</h3></header><dl><div><dt>Ответ ученика</dt><dd>'+h(answerLabel(set,index,row.userAnswer))+'</dd></div><div><dt>Правильный ответ</dt><dd>'+h(answerLabel(set,index,row.correctAnswer))+'</dd></div><div><dt>Цитата-доказательство</dt><dd class="reading-text">«'+rWordsHtml(row.evidence.quote)+'»</dd></div><div><dt>Объяснение</dt><dd>'+h(row.evidence.explanationRu)+'</dd></div></dl>'+(voice?voice.result.resultSlot(voice.set.qs[index],index):'')+'</article>').join('')+'</section>';
}
function renderTrainingResult(){
  const item=training,result=item?.result;if(!item||!result)return;
  const seconds=Date.now()-item.startedAt,technical=item.set.recordable===false;
  const reviewTitle=item.kind==='task10'?'разбор задания 10':item.kind==='task11'?'разбор задания 11':'разбор заданий 12–18';
  const voiceSet=technical?null:readingModule.voiceSet(item.set);
  const voiceResult=voiceSet?prepareVoiceTutorContextResult({module:'reading',set:voiceSet,selections:item.answers}):null;
  const voice=voiceResult?{set:voiceSet,result:voiceResult}:null;
  setHeader('Разбор готов',result.rawScore+' / '+result.rawMaxScore);
  const scoreCopy=technical?'<strong>Технический результат: '+result.rawScore+' из '+result.rawMaxScore+'.</strong> Официальная шкала и прогресс не применяются.':result.rawScore+' из '+result.rawMaxScore+' верных полей · '+result.officialScore+' из '+result.officialMaxScore+' первичных баллов · '+formatTime(seconds);
  area().innerHTML='<main class="reading2 reading-result"><header class="reading-title"><p class="reading-kicker">РЕЗУЛЬТАТ</p><h1>'+reviewTitle.charAt(0).toUpperCase()+reviewTitle.slice(1)+'</h1><p>'+scoreCopy+'</p></header><p class="reading-notice" role="status" aria-live="polite">Разбор открыт после сдачи: ключи и доказательства теперь видны.</p>'+reviewMarkup(item.set,result,voice)+validationDetails()
    +'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button>'+(item.set.recordable===false?'':'<button class="reading-action reading-action--primary" type="button" data-reading-action="repeat" data-kind="'+item.kind+'">Следующий комплект</button>')+'</div></main>';
  bindActions();
  if(voiceResult)registerVoiceTutorContextResult(voiceResult).catch(()=>{});
}
function trainingEvidence(set,startedAt){
  const contract=readingModule.learningContract(set),id=crypto.randomUUID();
  return createLearningActivityEvidence({id,module:'reading',activityId:contract.activityId,mode:contract.mode,source:'catalog',startedAt,metadata:{
    readingProvenance:'canonical',readingSetId:contract.setId,readingSetRevision:contract.setRevision,
    readingKind:contract.kind,readingCefr:contract.cefr,readingContentRef:contract.contentRef,
    readingAttemptId:id,readingSlice:contract.kind==='task10'?'gist':'detail',readingIndependent:true,
  }});
}
function startTraining(kind,{technical=false,preferredCefr=null,adaptiveContentRef=null}={}){
  if(!technical&&(!catalog||!KINDS.includes(kind)))return;
  const owner=ownerId(),current=state();if(!owner||!current){renderOwnerError();return}
  const pool=technical?[]:(adaptiveContentRef?catalog.sets.filter((item)=>item.kind===kind&&item.cefr===preferredCefr):catalog.sets);
  let set=technical?TECHNICAL_SET:readingModule.selectNextSet(pool,owner,current.history,kind,{now:Date.now(),preferredCefr});
  if(!set)return;
  if(adaptiveContentRef&&readingModule.learningContract(set).contentRef!==adaptiveContentRef)return false;
  if(!technical){current.history=readingModule.rememberSelection(owner,current.history,kind,set,Date.now());save()}
  const startedAt=Date.now();
  training={kind,set,answers:emptyAnswers(kind,set),startedAt,result:null,evidence:technical?null:trainingEvidence(set,startedAt)};
  RQ=kind==='task12_18'?training:null;
  renderTraining();
  return true;
}
function submitTraining(){
  if(!training||training.result||!training.answers.every((answer)=>answer!==null))return;
  const result=readingModule.scoreSet(training.set,training.answers);training.result=result;
  if(training.set.recordable!==false){
    const owner=ownerId(),current=state(),durationMs=Math.max(0,Date.now()-training.startedAt);
    const attemptId=training.evidence.id;
    current.history=readingModule.recordAttempt(owner,current.history,training.set,{attemptId,score:result.rawScore,maxScore:result.rawMaxScore,durationMs,attemptedAt:Date.now(),source:'catalog'});
    current.totals[training.kind].correct+=result.rawScore;current.totals[training.kind].total+=result.rawMaxScore;current.completedSets+=1;
    save({queueNow:true});rSync();
    recordLearningActivityEvidence(training.evidence,{score:result.rawScore,maxScore:result.rawMaxScore,durationMs}).catch(()=>{});
  }
  renderTrainingResult();
}

function renderFullIntro(){
  setHeader('Полный раздел 10–18','9 заданий · 20 полей');
  area().innerHTML='<main class="reading2"><header class="reading-title"><p class="reading-kicker">УЧЕБНОЕ ВОСПРОИЗВЕДЕНИЕ РАЗДЕЛА</p><h1>Полный раздел 10–18</h1><p>Один канонический комплект каждого формата. Ответы и разбор откроются только после финальной сдачи.</p></header><section class="reading-intro-grid"><article><strong>9</strong><span>заданий с номерами 10–18</span></article><article><strong>20</strong><span>полей ответа: 7 + 6 + 7</span></article><article><strong>12</strong><span>максимум первичных баллов: 3 + 2 + 7</span></article></section><p class="reading-time-note"><strong>Рекомендация ФИПИ — 30 минут.</strong> Это ориентир внутри всей письменной части: Reading не завершается автоматически.</p>'+validationDetails()+'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button><button class="reading-action reading-action--primary" type="button" data-reading-action="start-full">Начать полный раздел</button></div></main>';
  bindActions();
}
function elapsedFull(){return full?Math.max(0,full.attempt.durationMs+(full.resumedAt?Date.now()-full.resumedAt:0)):0}
function stopFullTimer(){if(fullTimer){clearInterval(fullTimer);fullTimer=null}}
function startFullTimer(){
  stopFullTimer();if(!full||full.result)return;
  fullTimer=setInterval(()=>{const timer=document.getElementById('reading-full-timer');if(timer)timer.textContent=formatTime(elapsedFull());if(full)persistFull()},1000);
}
function pauseFull(){
  if(!full||full.result)return;
  full.attempt.durationMs=elapsedFull();full.resumedAt=0;persistFull();stopFullTimer();
}
function persistFull(){
  if(!full||full.result||!state())return;
  S.readingPilotDraft=readingModule.serializeFullAttempt({...full.attempt,durationMs:elapsedFull()});save();
}
function overviewMarkup(){
  let offset=0;
  return '<nav class="reading-overview" aria-label="Обзор 20 полей ответа"><h2>Обзор полей</h2>'+KINDS.map((kind)=>{const values=full.attempt.answers[kind];const start=offset;offset+=values.length;return '<section><h3>'+KIND_META[kind].title+'</h3><div>'+values.map((answer,index)=>'<button type="button" data-reading-overview-field data-reading-action="jump-full" data-kind="'+kind+'" data-position="'+index+'" aria-label="'+KIND_META[kind].title+', поле '+(index+1)+': '+(answer===null?'не заполнено':'заполнено')+'" class="'+(answer===null?'is-empty':'is-answered')+'">'+(start+index+1)+'<span>'+(answer===null?'пусто':'есть')+'</span></button>').join('')+'</div></section>'}).join('')+'</nav>';
}
function fullNav(){
  const index=KINDS.indexOf(full.attempt.currentKind);
  return '<div class="reading-section-nav">'+(index>0?'<button class="reading-action reading-action--secondary" type="button" data-reading-action="full-kind" data-kind="'+KINDS[index-1]+'">Назад: '+KIND_META[KINDS[index-1]].title+'</button>':'<span></span>')+(index<KINDS.length-1?'<button class="reading-action reading-action--primary" type="button" data-reading-action="full-kind" data-kind="'+KINDS[index+1]+'">Дальше: '+KIND_META[KINDS[index+1]].title+'</button>':'<button class="reading-action reading-action--primary" type="button" data-reading-action="submit-full">Сдать раздел</button>')+'</div>';
}
function blankDialog(){
  const answered=KINDS.reduce((sum,kind)=>sum+full.attempt.answers[kind].filter((answer)=>answer!==null).length,0);
  return '<div class="reading-dialog-backdrop" data-reading-dialog hidden><section class="reading-dialog" role="dialog" aria-modal="true" aria-labelledby="reading-blank-title"><h2 id="reading-blank-title">В ответах есть пропуски</h2><p>Заполнено '+answered+' из 20 полей. После сдачи ответы нельзя изменить.</p><div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="cancel-submit">Вернуться к ответам</button><button class="reading-action reading-action--danger" type="button" data-reading-action="confirm-submit">Сдать с пропусками</button></div></section></div>';
}
function renderFullAttempt(restored=false){
  if(!full)return;
  full.resumedAt=full.resumedAt||Date.now();
  const kind=full.attempt.currentKind,set=full.attempt.section.sets[kind],answers=full.attempt.answers[kind];
  const answered=KINDS.reduce((sum,key)=>sum+full.attempt.answers[key].filter((answer)=>answer!==null).length,0);
  setHeader(KIND_META[kind].heading,answered+' / 20 полей');
  const restoredMarkup=restored?'<p class="reading-notice" role="status" aria-live="polite">Незавершённая попытка восстановлена</p>':'';
  const persistentSubmit=kind==='task12_18'?'':'<button class="reading-action reading-action--quiet reading-submit-wide" type="button" data-reading-action="submit-full">Сдать раздел</button>';
  area().innerHTML='<main class="reading2 reading-full"><header class="reading-full-head"><div><p class="reading-kicker">ПОЛНЫЙ РАЗДЕЛ · '+KIND_META[kind].title+'</p><h1>'+KIND_META[kind].heading+'</h1><p>Ответы сохраняются автоматически. Ключи и разбор до сдачи скрыты.</p></div><div><span>ФИПИ: ориентир 30:00</span><strong id="reading-full-timer" role="timer" aria-label="Затраченное время">'+formatTime(elapsedFull())+'</strong><small>Без автозавершения</small></div></header>'+restoredMarkup+'<div class="reading-workspace">'+overviewMarkup()+'<section class="reading-full-task">'+taskMarkup(set,answers,true)+fullNav()+persistentSubmit+'</section></div>'+blankDialog()+'</main>';
  bindActions();startFullTimer();
  if(full.attempt.currentPosition){queueMicrotask(()=>focusPosition(full.attempt.currentKind,full.attempt.currentPosition))}
}
function startFullAttempt(){
  const owner=ownerId(),current=state();if(!catalog||!owner||!current)return;
  const selected=readingModule.selectFullSection(catalog,owner,current.history,{now:Date.now()});current.history=selected.history;
  const now=Date.now();
  const attempt={id:'reading-full-'+(crypto.randomUUID?crypto.randomUUID():now),ownerId:owner,section:{catalogId:selected.catalogId,catalogRevision:selected.catalogRevision,sets:selected.sets},answers:Object.fromEntries(KINDS.map((kind)=>[kind,emptyAnswers(kind,selected.sets[kind])])),currentKind:'task10',currentPosition:0,startedAt:now,durationMs:0};
  full={attempt,resumedAt:now,result:null};RE=full;persistFull();renderFullAttempt();
}
function focusPosition(kind,position){
  const field=area()?.querySelector('[data-reading-kind="'+kind+'"] [data-reading-answer][data-position="'+position+'"]');
  if(field){field.focus();field.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}
}
function switchFullKind(kind,position=0){
  if(!full||!KINDS.includes(kind))return;
  full.attempt.currentKind=kind;full.attempt.currentPosition=Math.max(0,Math.min(6,Number(position)||0));persistFull();renderFullAttempt();
}
function requestFullSubmit(){
  if(!full||full.result)return;
  const hidden=readingModule.scoreFullSection(full.attempt.section,full.attempt.answers,{submitted:false});
  if(hidden.answeredFields<20){const dialog=area().querySelector('[data-reading-dialog]');dialog.hidden=false;dialog.querySelector('button').focus();return}
  confirmFullSubmit();
}
function closeSubmitDialog(){const dialog=area()?.querySelector('[data-reading-dialog]');if(dialog){dialog.hidden=true;area().querySelector('[data-reading-action="submit-full"]')?.focus()}}
function confirmFullSubmit(){
  if(!full||full.result||submissionLocked)return;submissionLocked=true;stopFullTimer();
  const owner=ownerId(),current=state(),durationMs=elapsedFull();
  try{
    const submitted=readingModule.submitFullAttempt(owner,current.history,full.attempt,full.attempt.answers,{durationMs,submittedAt:Date.now(),source:'catalog'});
    current.history=submitted.history;full.attempt.durationMs=durationMs;full.resumedAt=0;full.result=submitted.result;delete S.readingPilotDraft;
    if(!submitted.duplicate){
      KINDS.forEach((kind)=>{current.totals[kind].correct+=submitted.result.perKind[kind].rawScore;current.totals[kind].total+=submitted.result.perKind[kind].rawMaxScore});current.completedSets+=3;
    }
    save({queueNow:true});rSync();
    let evidenceWrite=Promise.resolve();
    submitted.result.evidenceSlices.forEach((slice)=>{
      const id=crypto.randomUUID(),gist=slice.slice==='gist',set=gist?full.attempt.section.sets.task10:null;
      const contract=gist?readingModule.learningContract(set):null;
      const detailSets=slice.sets||[];
      const metadata=gist?{
        readingProvenance:'canonical',readingSetId:contract.setId,readingSetRevision:contract.setRevision,
        readingKind:contract.kind,readingCefr:contract.cefr,readingContentRef:contract.contentRef,
        readingAttemptId:full.attempt.id,readingSlice:'gist',readingIndependent:slice.independent===true,
      }:{
        readingProvenance:'canonical',readingSetRevision:full.attempt.section.catalogRevision,
        readingKind:'full_detail',readingCefr:'mixed',readingContentRef:'builtin:reading:full:detail:v1',
        readingSetRefs:detailSets.map((item)=>item.id+'@'+item.revision).join('|'),
        readingAttemptId:full.attempt.id,readingSlice:'detail',readingIndependent:slice.independent===true,
      };
      const evidence=createLearningActivityEvidence({id,module:'reading',activityId:slice.activityId,
        mode:gist?'reading_headings':'reading_detail',source:'catalog',startedAt:full.attempt.startedAt,metadata});
      evidenceWrite=evidenceWrite.then(()=>recordLearningActivityEvidence(evidence,{
        score:slice.score,maxScore:slice.maxScore,durationMs:slice.durationMs,
      })).catch(()=>false);
    });
    renderFullResult();
  }finally{submissionLocked=false}
}
function renderFullResult(){
  const result=full?.result;if(!result)return;
  const voice=Object.fromEntries(KINDS.map((kind)=>{const set=readingModule.voiceSet(full.attempt.section.sets[kind]);return [kind,{set,result:prepareVoiceTutorContextResult({module:'reading',set,selections:full.attempt.answers[kind]})}]}));
  setHeader('Полный раздел завершён',result.officialScore+' / 12');
  const perKind=KINDS.map((kind)=>'<li><span>'+KIND_META[kind].title+'</span><strong>'+result.perKind[kind].officialScore+' / '+result.perKind[kind].officialMaxScore+' балла · '+result.perKind[kind].rawScore+' / '+result.perKind[kind].rawMaxScore+' полей</strong></li>').join('');
  const reviews=KINDS.map((kind)=>reviewMarkup(full.attempt.section.sets[kind],result.perKind[kind],voice[kind])).join('');
  area().innerHTML='<main class="reading2 reading-result"><header class="reading-title"><p class="reading-kicker">РЕЗУЛЬТАТ УЧЕБНОГО РАЗДЕЛА</p><h1>Результат полного раздела</h1><p><strong>'+result.officialScore+' из 12 первичных баллов</strong> · '+result.rawScore+' из 20 верных полей · '+formatTime(result.durationMs)+'</p><small>Это учебное воспроизведение шкалы раздела, не прогноз итогового тестового балла ЕГЭ.</small></header><ul class="reading-score-list">'+perKind+'</ul><p class="reading-notice" role="status" aria-live="polite">Разбор всех 20 полей открыт после финальной сдачи.</p>'+reviews+validationDetails()+'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button><button class="reading-action reading-action--primary" type="button" data-reading-action="full-intro">Новый полный раздел</button></div></main>';
  bindActions();KINDS.forEach((kind)=>{if(voice[kind].result)registerVoiceTutorContextResult(voice[kind].result).catch(()=>{})});
}
function restoreDraft(){
  if(!S.readingPilotDraft)return false;
  const restored=readingModule.restoreFullAttempt(S.readingPilotDraft,catalog,ownerId());
  if(!restored.ok){delete S.readingPilotDraft;save();notice='Сохранённая попытка устарела или принадлежит другому аккаунту. Она удалена; начните новый раздел.';return false}
  full={attempt:restored.attempt,resumedAt:Date.now(),result:null};RE=full;renderFullAttempt(true);return true;
}
async function initReading(force=false){
  document.getElementById('frame')?.classList.add('reading-expanded');
  if(!ownerId()){renderOwnerError();return}
  if(full&&!full.result){full.resumedAt=Date.now();renderFullAttempt();return}
  if(catalog&&!force){renderHub();return}
  renderLoading();
  if(force)catalog=null;
  if(!loadingPromise)loadingPromise=readingModule.loadPilotCatalog().then((loaded)=>{catalog=readingModule.validateCatalog(loaded);return catalog}).finally(()=>{loadingPromise=null});
  try{await loadingPromise;if(!restoreDraft())renderHub()}catch(_){catalog=null;renderCatalogError()}
}
function bindActions(){
  const host=area();if(!host)return;
  host.querySelectorAll('[data-reading-action]').forEach((button)=>button.addEventListener('click',()=>{
    const action=button.dataset.readingAction,kind=button.dataset.kind,position=Number(button.dataset.position)||0;
    if(action==='retry')initReading(true);else if(action==='technical')startTraining('task10',{technical:true});else if(action==='training'||action==='repeat')startTraining(kind);
    else if(action==='hub')renderHub();else if(action==='submit-training')submitTraining();else if(action==='full-intro')renderFullIntro();else if(action==='start-full')startFullAttempt();
    else if(action==='full-kind'||action==='jump-full')switchFullKind(kind,position);else if(action==='submit-full')requestFullSubmit();else if(action==='cancel-submit')closeSubmitDialog();else if(action==='confirm-submit')confirmFullSubmit();
  }));
  host.querySelectorAll('[data-reading-answer]').forEach((field)=>field.addEventListener('change',()=>{
    const kind=field.dataset.kind,index=Number(field.dataset.position),value=field.value===''?null:Number(field.value);
    if(full&&!full.result){
      if(kind==='task10'||kind==='task11')full.attempt.answers[kind]=readingModule.selectUnique(full.attempt.answers[kind],index,value);else full.attempt.answers[kind][index]=value;
      full.attempt.currentKind=kind;full.attempt.currentPosition=index;persistFull();renderFullAttempt();
    }
    else if(training&&!training.result){if(kind==='task10'||kind==='task11')training.answers=readingModule.selectUnique(training.answers,index,value);else training.answers[index]=value;renderTraining()}
  }));
}

function rHub(){renderHub()}
function rHl(){return startTraining('task10')}
function rGp(){return startTraining('task11')}
function rQs(){return startTraining('task12_18')}
function launchReadingPractice(kind,cefr,contentRef){
  const parsed=readingModule.parseAdaptiveContentRef(contentRef);
  if(!parsed||parsed.kind!==kind||parsed.cefr!==cefr)return false;
  return startTraining(kind,{preferredCefr:cefr,adaptiveContentRef:contentRef})===true;
}
function rExam(){renderFullIntro()}
function rExamStart(){startFullAttempt()}

/* Existing word-saving seam: context remains owner data and never enters the Reading catalog. */
function r_add(status){
  if(!lastWord||!['learn','know'].includes(status)||!S)return;
  const word=normalizeVocabularyWord(lastWord),id=personalVocabularyCardId(word);if(!id)return;
  const previousStatus=S.wstatus&&S.wstatus[word];let translation=(document.getElementById('r_tr')?.textContent||'').replace(' · офлайн-словарь','').trim();
  if(!translation||translation.includes('перевод')||translation.includes('офлайн, слова нет')||translation.length>240)translation='';
  const pronunciation=(document.getElementById('r_ipa')?.textContent||'').trim();
  const known=EGE_WORDS.find((item)=>wBase(item.w)===word&&(item.provenance==='core'||(!item.provenance&&Number(item.t)!==0)));
  const contextText=lastWordContext||String(document.getElementById('r_card')?.textContent||'').trim().slice(0,600);
  const activeSets=training?.set?[training.set]:(full?.attempt?.section?.sets?KINDS.map((kind)=>full.attempt.section.sets[kind]):[]);
  const context=readingModule.sourceContextFromSets(activeSets,contextText);if(!context)return;
  S.personalWords=upsertReadingVocabularyCard(S.personalWords||[],{word,translation:translation||null,pronunciation:pronunciation||known?.ipa||null,partOfSpeech:known?.p||null,level:known?.level||null,context});S.personalWordTombstones=(Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[]).filter((value)=>value!==id);S.wstatus=S.wstatus||{};S.wstatus[word]=previousStatus==='know'?'know':status;
  if(status==='know'&&previousStatus!=='know')srsRecordVocabularyOutcome(word,{mode:'russian_reveal',outcome:'knew',now:Date.now()});
  toast(status==='know'?'Отмечено как знакомое · самооценка':'Личная карточка добавлена в «Слова»');save();const pop=document.getElementById('r_pop');if(pop)pop.style.display='none';wSync();
}

registerRouteHook((id)=>{
  const frame=document.getElementById('frame');
  if(id==='scr7')initReading();else{frame?.classList.remove('reading-expanded');pauseFull()}
});
registerScreenGenerator('scr7',()=>initReading(true));

export {RE,RQ,initReading,launchReadingPractice,rExam,rExamStart,rGp,rHl,rHub,rQs,r_add};
