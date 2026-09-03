/* Reading 2.0: lazy canonical catalog, owner-bound rotation and one full-section flow. */
import {registerRouteHook} from '../router.js';
import '../modules/reading.js';
import {prepareVoiceTutorContextResult,registerVoiceTutorContextResult} from '../voice-tutor-loader.js';
import {
  EGE_WORDS,S,apiGet,apiIsAuthorityFailure,apiResponseOwner,closeReadingWordPopover,currentOwnerBinding,invalidateLearningAuthority,readingDictionarySelection,readingModule,rEsc,rSync,rWordsHtml,
  registerAuthorityReset,registerScreenGenerator,save,setTxt,srsRecordVocabularyOutcome,toast,verifyLearningAccessForLaunch,wBase,wSync,
} from '../app.js';
import {createLearningActivityEvidence,prepareLearningActivityRecording,recordLearningActivityEvidence} from '../learning-activity-recorder.js';
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
let reportRequestId=0;
let reportWrite=Promise.resolve();
let launchPending=null;
let readingViewGeneration=0;
let readingContentGeneration=0;
let dialogReturnFocus=null;
let dialogReturnParent=null;
let RE=null,RQ=null;

function area(){return document.getElementById('r_area')}
function dock(){return document.getElementById('r_action_dock')}
function focusViewHeading(){queueMicrotask(()=>{const container=area(),heading=container?.querySelector('.learning-view-title');if(!heading)return;container.scrollTop=0;heading.tabIndex=-1;heading.focus({preventScroll:true})})}
function setNetworkState(state='',copy=''){
  const status=document.getElementById('r_network_state');if(!status)return;
  status.dataset.networkState=state;status.textContent=copy;status.hidden=!copy;
}
function sameOwner(left,right){return Boolean(left&&right&&left.username===right.username&&left.generation===right.generation)}
function ownerBinding(){return currentOwnerBinding()}
function ownerId(){return ownerBinding()?.username||null}
function readingRouteCurrent(){const screen=document.getElementById('scr7');return Boolean(screen&&(typeof screen.classList?.contains!=='function'||screen.classList.contains('on')))}
function readingRequestCurrent(request,authority){
  return request===readingViewGeneration&&readingRouteCurrent()&&sameOwner(authority,ownerBinding());
}
function setDock(markup=''){
  const host=dock();if(!host)return;
  host.inert=false;host.innerHTML=markup;host.hidden=!markup;
}
function readingPrimary(action,label,attributes=''){
  return '<button class="aisy-button learning-primary" type="button" data-reading-action="'+action+'" '+attributes+'>'+h(label)+'</button>';
}
function hasActiveReadingPractice(){
  const owner=ownerBinding();
  return Boolean(owner&&((training&&sameOwner(training.authority,owner)&&!training.result)
    ||(full&&sameOwner(full.authority,owner)&&!full.result)));
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
function setHeader(summary,text,completed=0,total=1,progressLabel='Прогресс чтения'){
  setTxt('r_sumline',summary);setTxt('r_today',text);
  const value=Math.max(0,Math.min(100,Math.round(Number(completed||0)/Math.max(1,Number(total)||1)*100)));
  const progress=document.querySelector('#scr7 .learning-route__progress');
  if(progress){progress.setAttribute('aria-label',progressLabel);progress.setAttribute('aria-valuenow',String(value))}
  const bar=document.getElementById('r_bar');if(bar)bar.style.width=Math.max(2,value)+'%';
}
function statusMarkup(kind,title,copy,actions=''){
  return '<section class="reading-status reading-status--'+kind+'" role="'+(kind==='error'?'alert':'status')+'" aria-live="polite">'
    +'<span class="reading-status__mark" aria-hidden="true">'+(kind==='loading'?'<span class="reading-spinner"></span>':(kind==='error'?'!':'·'))+'</span>'
    +'<h2>'+h(title)+'</h2><p>'+h(copy)+'</p>'+actions+'</section>';
}
function renderLoading(){
  readingContentGeneration++;
  setDock();
  const offline=navigator.onLine===false;
  setNetworkState(offline?'offline':'loading',offline?'Нет сети. Ищем ранее сохранённый каталог Reading в кэше устройства.':'Проверяем свежую версию каталога Reading.');
  setHeader('Загружаем 60 комплектов','Каталог Reading 2.0',0,1,'Загрузка каталога Reading');
  area().innerHTML='<section class="reading2"><div class="reading-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>'
    +statusMarkup('loading','Каталог загружается','Подключаем три формата и проверяем версию.')+'</section>';
}
function renderOwnerError(){
  readingContentGeneration++;
  setDock();
  setNetworkState('error','Активный владелец сессии не подтверждён.');
  setHeader('Доступ не подтверждён','Reading 2.0',0,1,'Доступ к Reading');
  area().innerHTML='<section class="reading2">'+statusMarkup('error','Нужна подтверждённая сессия','Мы не начинаем Reading без owner ID из активной серверной сессии.')+'</section>';
}
function renderCatalogError(){
  readingContentGeneration++;
  const offline=navigator.onLine===false;
  setNetworkState(offline?'cache-required':'error',offline?'Каталог ещё не сохранён на этом устройстве: для первого открытия подключитесь к сети.':'Каталог не загрузился. Повторите запрос.');
  setHeader('Каталог недоступен',offline?'Нет сети':'Ошибка загрузки',0,1,'Доступность каталога Reading');
  const actions='<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="technical">Техническая тренировка</button></div>';
  area().innerHTML='<section class="reading2">'+statusMarkup('error','Каталог не загрузился',offline?'Нет доступа к кэшу каталога. Подключитесь к сети и повторите.':'Не удалось проверить все 60 комплектов. Прогресс не изменён.',actions)+'</section>';
  setDock(readingPrimary('retry','Повторить загрузку'));
  bindActions();
}
function validationDetails(){
  return '<details class="reading-validation"><summary>Автоматически проверено</summary><p>'+h(AUTO_CHECK_COPY)+'</p><p>Официальная рамка: задание 10 — 7 из 8 соответствий, максимум 3 балла; задание 11 — 6 из 7, максимум 2; задания 12–18 — 7 вопросов по 4 варианта, максимум 7. Весь раздел: 12 первичных баллов и 20 полей ответа. Рекомендация ФИПИ — 30 минут внутри письменной части, без отдельного принудительного cutoff. Формат 2026 года не изменён относительно 2025 года по сохранённой сверке первичных источников.</p></details>';
}
function kindStats(kind,summary){
  const item=summary.perKind[kind];
  return '<dl class="reading-kind-stats"><div><dt>Новые</dt><dd>'+item.newSets+'</dd></div><div><dt>Пройдены</dt><dd>'+item.completedSets+'</dd></div>'
    +'<div><dt>Слабые</dt><dd>'+item.weakSets+'</dd></div><div><dt>К повтору</dt><dd>'+item.dueSets+'</dd></div></dl>';
}
function reportConfidence(value){return {insufficient:'данных недостаточно',low:'низкая',medium:'средняя',high:'высокая'}[value]||'данных недостаточно'}
function reportTrend(value){return {up:'растёт',down:'снизилась',steady:'стабильна',insufficient_evidence:'пока недостаточно данных'}[value]||'пока недостаточно данных'}
function reportLoadingMarkup(){
  return '<section class="reading-report reading-report--loading" role="status" aria-live="polite"><h2>Обновляем отчёт</h2><p>Собираем только сохранённые завершённые попытки Reading.</p></section>';
}
function baseReportMarkup(report){
  const base=report.base,accuracy=base.accuracy;
  const weakest=base.weakestSkill?base.weakestSkill.label:'определим после тренировок обоих навыков';
  const recent=base.recentAttempts.length?'<div class="reading-report-table-wrap"><table class="reading-report-table"><caption>Последние сохранённые попытки</caption><thead><tr><th scope="col">Тренировка</th><th scope="col">Результат</th><th scope="col">Время</th><th scope="col">Условия</th></tr></thead><tbody>'+base.recentAttempts.map((attempt)=>'<tr><th scope="row">'+h(attempt.label)+'</th><td>'+attempt.score+' / '+attempt.maxScore+' · '+attempt.accuracyPercent+'%</td><td>'+attempt.durationMinutes+' мин</td><td>'+(attempt.independent?'самостоятельно':'с поддержкой')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="reading-report-empty">Пока недостаточно данных: завершите первую тренировку, и здесь появится сохранённый результат.</p>';
  return '<section class="reading-report" aria-labelledby="reading-report-title"><div class="reading-report-head"><div><h2 id="reading-report-title">Краткий отчёт</h2><p>Базовая сводка по '+report.evidence.includedAttempts+' завершённым попыткам: '+report.evidence.independentAttempts+' самостоятельных, '+report.evidence.assistedAttempts+' с поддержкой.</p></div></div><div class="reading-report__grid">'
    +'<p><strong>'+(accuracy?accuracy.percent+'%':'—')+'</strong><span>точность · '+(accuracy?accuracy.correct+' / '+accuracy.total:'пока недостаточно данных')+'</span></p>'
    +'<p><strong>'+h(reportTrend(base.recentTrend.state))+'</strong><span>недавняя динамика · '+base.recentTrend.recentSampleSize+' + '+base.recentTrend.previousSampleSize+' попытки</span></p>'
    +'<p><strong>'+h(weakest)+'</strong><span>слабейший навык · уверенность '+h(reportConfidence(base.weakestSkill?.confidence))+'</span></p></div>'+recent
    +'<p class="reading-report-recommendation"><strong>Что дальше.</strong> '+h(base.recommendation.text)+'</p></section>';
}
function performanceRows(rows,key,label){
  if(!rows.length)return '<p class="reading-report-empty">Недостаточно данных для этой разбивки.</p>';
  return '<div class="reading-report-table-wrap"><table class="reading-report-table"><thead><tr><th scope="col">'+h(label)+'</th><th scope="col">Точность</th><th scope="col">Выборка</th><th scope="col">Уверенность</th></tr></thead><tbody>'+rows.map((row)=>'<tr><th scope="row">'+h(String(row[key]).replaceAll('-',' '))+'</th><td>'+row.correct+' / '+row.total+' · '+row.percent+'%</td><td>'+row.sampleSize+'</td><td>'+h(reportConfidence(row.confidence))+'</td></tr>').join('')+'</tbody></table></div>';
}
function expandedReportMarkup(report){
  const expanded=report.expanded;
  const skills=expanded.skills.map((skill)=>'<article><h3>'+h(skill.label)+'</h3><p><strong>'+(skill.percent==null?'—':skill.percent+'%')+'</strong> · '+skill.correct+' / '+skill.total+' · '+skill.sampleSize+' наблюдений</p><progress max="100" value="'+(skill.percent||0)+'" aria-label="'+h(skill.label)+': '+(skill.percent==null?'нет данных':skill.percent+' процентов')+'"></progress><small>Уверенность: '+h(reportConfidence(skill.confidence))+'</small></article>').join('');
  const pace=expanded.pace.state==='available'?'<p><strong>'+expanded.pace.averageSecondsPerField+' сек.</strong> в среднем на поле · выборка '+expanded.pace.sampleSize+'. Полных разделов: '+expanded.pace.fullSectionSampleSize+(expanded.pace.fullSectionAverageMinutes==null?'':', среднее '+expanded.pace.fullSectionAverageMinutes+' мин')+'.</p>':'<p>Недостаточно данных о темпе: нужны как минимум две попытки с фактическим временем.</p>';
  const repeats=expanded.repeatErrors.state==='available'?'<ul class="reading-report-list">'+expanded.repeatErrors.sets.map((set)=>'<li><strong>'+h(set.title)+'</strong><span>'+set.errorAttempts+' попытки с ошибками из '+set.sampleSize+' · '+set.accuracyPercent+'%</span></li>').join('')+'</ul>':'<p>Недостаточно данных о повторных ошибках: вывод появляется только после двух ошибок в одном каноническом комплекте.</p>';
  const comparison=expanded.comparison.state==='available'?'<p>Последние '+expanded.comparison.recentSampleSize+': '+expanded.comparison.recentAccuracyPercent+'%; предыдущие '+expanded.comparison.previousSampleSize+': '+expanded.comparison.previousAccuracyPercent+'%. Изменение '+(expanded.comparison.deltaPercentagePoints>0?'+':'')+expanded.comparison.deltaPercentagePoints+' п. п.; уверенность '+h(reportConfidence(expanded.comparison.confidence))+'.</p>':'<p>Недостаточно данных для сравнения: нужны минимум четыре завершённые попытки.</p>';
  const allocation=expanded.recommendation.timeAllocation.length?'<ul class="reading-report-list">'+expanded.recommendation.timeAllocation.map((item)=>'<li><strong>'+h(item.label)+'</strong><span>'+item.minutesPer30+' из 30 минут следующего занятия</span></li>').join('')+'</ul>':'';
  return '<section class="reading-report reading-expanded-report" aria-labelledby="reading-expanded-report-title"><div class="reading-report-head"><div><p class="reading-kicker">PREMIUM · ТОЛЬКО ДОПОЛНЕНИЕ</p><h2 id="reading-expanded-report-title">Расширенный персональный отчёт</h2><p>Детерминированная сводка без runtime-ИИ.</p></div><button class="reading-report-action" type="button" data-reading-action="retry-report">Обновить расширенный отчёт</button></div>'
    +'<div class="reading-skill-report">'+skills+'</div><section><h3>Темы</h3>'+performanceRows(expanded.topics,'topic','Тема')+'</section><section><h3>Уровни CEFR банка</h3>'+performanceRows(expanded.cefr,'cefr','Маркировка банка')+'</section>'
    +'<section><h3>Темп</h3>'+pace+'<small>30 минут — рекомендация ФИПИ внутри письменной части, не принудительный cutoff.</small></section><section><h3>Повторные ошибки</h3>'+repeats+'</section><section><h3>Сравнение недавних попыток</h3>'+comparison+'</section><section><h3>Рекомендация по времени</h3><p>'+h(expanded.recommendation.text)+'</p>'+allocation+'</section><p class="reading-report-disclosure">'+h(expanded.disclosure)+'</p></section>';
}
function premiumExplanation(){
  return '<aside class="reading-premium-note"><strong>Premium добавляет только</strong> голосовой разбор ошибок и расширенный персональный отчёт. Все 60 комплектов, три тренировки, полный раздел, текстовый доказательный разбор, слова и личный план уже доступны с обычной активной подпиской.</aside>';
}
function reportErrorMarkup({premium=false,changed=false}={}){
  const title=changed?'Доступ к расширенному отчёту изменился':'Не удалось обновить отчёт';
  const copy=changed?'Сервер больше не подтверждает Premium. Базовый Reading и полный текстовый разбор остаются доступны.':'Повторите загрузку. '+(premium?'Статус Premium не изменён: ошибка сети не считается отсутствием подписки.':'Базовый Reading остаётся доступен.');
  return '<section class="reading-report reading-report--error" role="status" aria-live="polite"><h2>'+h(title)+'</h2><p>'+h(copy)+'</p><button class="reading-report-action" type="button" data-reading-action="retry-report">Повторить загрузку отчёта</button></section>';
}
function bindReportActions(){
  area()?.querySelectorAll('[data-reading-action="retry-report"]').forEach((button)=>button.addEventListener('click',()=>loadReadingReport()));
}
function setReportMarkup(markup){const shell=area()?.querySelector('.reading-report-shell');if(shell){shell.innerHTML=markup;bindReportActions()}}
function clearPremiumProjection(){
  if(window.__sub?.entitlements)window.__sub={...window.__sub,entitlements:{...window.__sub.entitlements,voice_tutor:false}};
}
function clearSubscriptionProjection(){
  if(window.__sub)window.__sub={...window.__sub,active:false,entitlements:{...window.__sub.entitlements,voice_tutor:false}};
}
async function loadReadingReport(){
  const requestId=++reportRequestId,request=readingViewGeneration,authority=ownerBinding();
  const premium=window.__sub?.entitlements?.voice_tutor===true;
  if(!authority||!readingRequestCurrent(request,authority))return;
  const options={headers:{'X-EasyBoost-Expected-Owner':authority.username}};
  setReportMarkup(reportLoadingMarkup());
  try{
    await reportWrite.catch(()=>false);
    if(requestId!==reportRequestId||!readingRequestCurrent(request,authority))return;
    const report=await apiGet('/api/v1/reading/report?scope='+(premium?'expanded':'base'),options);
    if(apiResponseOwner(report)!==authority.username){
      await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});return;
    }
    if(requestId!==reportRequestId||!readingRequestCurrent(request,authority)||!area()?.querySelector('.reading-report-shell'))return;
    setReportMarkup(baseReportMarkup(report)+(report.expanded?expandedReportMarkup(report):premiumExplanation()));
  }catch(error){
    if(requestId!==reportRequestId||!readingRequestCurrent(request,authority)||!area()?.querySelector('.reading-report-shell'))return;
    if(apiIsAuthorityFailure(error)){await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});return}
    if(error?.code==='READING_PREMIUM_REQUIRED'){
      clearPremiumProjection();
      try{
        const base=await apiGet('/api/v1/reading/report?scope=base',options);
        if(apiResponseOwner(base)!==authority.username){await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});return}
        if(requestId===reportRequestId&&readingRequestCurrent(request,authority))setReportMarkup(baseReportMarkup(base)+reportErrorMarkup({changed:true}));
      }catch(fallbackError){
        if(apiIsAuthorityFailure(fallbackError))await invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation});
        else if(requestId===reportRequestId&&readingRequestCurrent(request,authority))setReportMarkup(reportErrorMarkup({changed:true}));
      }
      return;
    }
    if(error?.code==='SUBSCRIPTION_REQUIRED'){
      clearSubscriptionProjection();
      setReportMarkup('<section class="reading-report reading-report--error" role="alert" aria-live="polite"><h2>Доступ к отчёту изменился</h2><p>Сервер больше не подтверждает активную подписку. Ранее показанные данные отчёта удалены; проверьте статус доступа в профиле.</p></section>');
      return;
    }
    setReportMarkup(reportErrorMarkup({premium}));
  }
}
function renderHub(){
  readingContentGeneration++;
  stopFullTimer();training=null;RE=null;RQ=null;
  const owner=ownerId(),current=state();if(!catalog||!owner||!current)return;
  const summary=readingModule.catalogSummary(catalog,owner,current.history,Date.now());
  if(navigator.onLine===false)setNetworkState('cache-ready','Офлайн: сохранённый каталог Reading доступен на этом устройстве; новые результаты останутся в очереди владельца до подключения.');
  else setNetworkState();
  setHeader(summary.completedSets?('Пройдено '+summary.completedSets+' из 60 комплектов'):'60 комплектов для ротации','Каталог Reading 2.0',summary.completedSets,60,'Пройденные комплекты Reading');
  const cards=KINDS.map((kind)=>'<article class="reading-launch-card reading-launch-card--'+KIND_META[kind].accent+'"><div class="reading-launch-card__head"><span aria-hidden="true">'+(kind==='task10'?'10':kind==='task11'?'11':'12–18')+'</span><div><h2>'+KIND_META[kind].title+'</h2><p>'+KIND_META[kind].description+'</p></div></div>'+kindStats(kind,summary)
    +'<button class="reading-action reading-action--secondary" type="button" data-reading-action="training" data-kind="'+kind+'">Начать '+KIND_META[kind].title+'</button></article>').join('');
  const noticeMarkup=notice?'<p class="reading-notice" role="status" aria-live="polite">'+h(notice)+'</p>':'';notice='';
  area().innerHTML='<section class="reading2 reading-hub learning-view-enter"><header class="reading-title"><p class="reading-kicker">ЕГЭ-2026 · раздел 2</p><h2 class="learning-view-title">Каталог чтения</h2><p>60 комплектов: три точных формата и полный раздел без Premium-gate. Выбор комплекта: новый → к повтору → слабый → давний.</p></header>'+noticeMarkup
    +'<section class="reading-full-card"><div><p class="reading-kicker">ПОЛНЫЙ РАЗДЕЛ</p><h2>Полный раздел 10–18</h2><p>9 официально учитываемых заданий · 20 полей ответа · один elapsed timer</p></div></section>'
    +'<section class="reading-card-grid">'+cards+'</section><section class="reading-report-shell" aria-live="polite">'+reportLoadingMarkup()+'</section>'+validationDetails()+'</section>';
  setDock(readingPrimary('full-intro','Полный раздел 10–18'));
  bindActions();focusViewHeading();void loadReadingReport();
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
    const rows=set.task.texts.map((text,index)=>'<article class="reading-field-card"><div class="reading-text"><strong>Текст '+h(text.id)+'</strong><p>'+rWordsHtml(text.text)+'</p></div><label>Заголовок для текста '+h(text.id)+'<select class="'+(answers[index]===null?'':'is-selected')+'" data-reading-answer data-kind="task10" data-position="'+index+'" aria-label="Ответ для текста '+h(text.id)+'"'+disabled+'>'+selectedOptions(set.task.headings.length,answers[index],true)+'</select></label></article>').join('');
    return '<section data-reading-kind="task10"><div class="reading-options"><h2>'+set.task.headings.length+' заголовков, один лишний</h2><ol>'+headings+'</ol></div>'+rows+'</section>';
  }
  if(kind==='task11'){
    const fragments=set.task.fragments.map((fragment,index)=>'<li data-reading-fragment><b>'+String.fromCharCode(65+index)+'.</b> '+h(fragment)+'</li>').join('');
    const passage=set.task.segments.map((segment,index)=>rWordsHtml(segment)+(index<answers.length?'<span class="reading-gap">['+(answers[index]===null?String(index+1):String.fromCharCode(65+answers[index]))+']</span>':'' )).join('');
    const rows=answers.map((answer,index)=>'<label class="reading-field-card">Пропуск '+String.fromCharCode(65+index)+'<select class="'+(answer===null?'':'is-selected')+'" data-reading-answer data-kind="task11" data-position="'+index+'" aria-label="Ответ для пропуска '+String.fromCharCode(65+index)+'"'+disabled+'>'+selectedOptions(set.task.fragments.length,answer,true)+'</select></label>').join('');
    return '<section data-reading-kind="task11"><article class="reading-passage reading-text"><h2>Текст с '+answers.length+' пропусками</h2><p>'+passage+'</p></article><div class="reading-options"><h2>'+set.task.fragments.length+' фрагментов, один лишний</h2><ol>'+fragments+'</ol></div><div class="reading-field-grid">'+rows+'</div></section>';
  }
  const questions=set.task.questions.map((question,index)=>'<fieldset class="reading-question" data-reading-question><legend><span>'+(index+12)+'</span>'+h(question.prompt)+'</legend><div class="reading-radio-list" role="radiogroup" aria-label="Ответ на задание '+(index+12)+'">'+question.options.map((option,optionIndex)=>{const selected=answers[index]===optionIndex;return '<label class="aisy-choice '+(selected?'is-selected':'')+'"><input type="radio" name="reading-'+(fullMode?'full':'training')+'-'+index+'" value="'+optionIndex+'" data-reading-answer data-kind="task12_18" data-position="'+index+'" aria-label="Задание '+(index+12)+', вариант '+(optionIndex+1)+'" aria-checked="'+selected+'"'+(selected?' checked':'')+disabled+'><span><b>'+(optionIndex+1)+'.</b> '+h(option)+(selected?'<small>Выбрано</small>':'')+'</span></label>'}).join('')+'</div></fieldset>').join('');
  return '<section data-reading-kind="task12_18"><article class="reading-passage reading-text"><h2>'+h(set.title)+'</h2><div>'+rWordsHtml(set.task.text).replaceAll('\n','<br><br>')+'</div></article>'+questions+'</section>';
}
function trainingProgress(){
  if(!training)return '';
  const total=training.answers.length,answered=training.answers.filter((answer)=>answer!==null).length;
  return '<p class="reading-progress" role="status" aria-live="polite"><span>'+KIND_META[training.kind].heading+'</span><strong>'+answered+' из '+total+' полей заполнено</strong></p>';
}
function renderTraining(focusPositionIndex=null,animate=false){
  const item=training;if(!item)return;
  readingContentGeneration++;
  const technical=item.set.recordable===false;
  const answered=training.answers.filter((answer)=>answer!==null).length;
  setHeader(KIND_META[item.kind].heading,answered+' / '+training.answers.length,answered,training.answers.length,'Заполненные поля Reading');
  const technicalNote=technical?'<p class="reading-technical" role="status"><strong>Техническая тренировка.</strong> Она не входит в 60 комплектов, не записывается в прогресс и не влияет на ротацию.</p>':'';
  area().innerHTML='<section class="reading2 reading-practice'+(animate?' learning-view-enter':'')+'"><header class="reading-title"><p class="reading-kicker">'+(technical?'АВАРИЙНЫЙ OFFLINE FALLBACK':'ОТДЕЛЬНАЯ ТРЕНИРОВКА')+'</p><h2 class="learning-view-title">'+KIND_META[item.kind].heading+'</h2><p>'+h(item.set.title)+' · '+h(item.set.cefr||'технический')+'</p></header>'+technicalNote+trainingProgress()+taskMarkup(item.set,item.answers)
    +'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button></div></section>';
  setDock(readingPrimary('submit-training','Проверить ответы',item.answers.every((answer)=>answer!==null)?'':'disabled'));
  bindActions();
  if(Number.isInteger(focusPositionIndex))queueMicrotask(()=>focusPosition(item.kind,focusPositionIndex));
  else if(animate)focusViewHeading();
}
function answerLabel(set,index,value){
  if(value===null||value===undefined)return 'Нет ответа';
  if(set.kind==='task10')return String.fromCharCode(65+value)+'. '+set.task.headings[value];
  if(set.kind==='task11')return String.fromCharCode(65+value)+'. '+set.task.fragments[value];
  return (value+1)+'. '+set.task.questions[index].options[value];
}
function reviewMarkup(set,result,voice=null){
  return '<section class="reading-review-list" aria-label="Полный разбор">'+result.review.map((row,index)=>'<article class="reading-review reading-review--'+(row.correct?'correct':'wrong')+' '+(row.correct?'is-correct':'is-incorrect')+'" data-reading-review-row><header><span aria-hidden="true">'+(row.correct?'✓':'×')+'</span><h3>Позиция '+h(row.position)+' · '+(row.correct?'Верно':'Ошибка')+'</h3></header><dl><div><dt>Ответ ученика</dt><dd>'+h(answerLabel(set,index,row.userAnswer))+'</dd></div><div><dt>Правильный ответ</dt><dd>'+h(answerLabel(set,index,row.correctAnswer))+'</dd></div><div><dt>Цитата-доказательство</dt><dd class="reading-text">«'+rWordsHtml(row.evidence.quote)+'»</dd></div><div><dt>Объяснение</dt><dd>'+h(row.evidence.explanationRu)+'</dd></div></dl>'+(voice?voice.result.resultSlot(voice.set.qs[index],index):'')+'</article>').join('')+'</section>';
}
function renderTrainingResult(){
  const item=training,result=item?.result;if(!item||!result)return;
  const resultView=readingViewGeneration,resultContent=++readingContentGeneration,resultAuthority=item.authority;
  const seconds=Date.now()-item.startedAt,technical=item.set.recordable===false;
  const reviewTitle=item.kind==='task10'?'разбор задания 10':item.kind==='task11'?'разбор задания 11':'разбор заданий 12–18';
  const voiceSet=technical?null:readingModule.voiceSet(item.set);
  const voiceResult=voiceSet?prepareVoiceTutorContextResult({module:'reading',set:voiceSet,selections:item.answers}):null;
  const voice=voiceResult?{set:voiceSet,result:voiceResult}:null;
  setHeader('Разбор готов',result.rawScore+' / '+result.rawMaxScore,result.rawScore,result.rawMaxScore,'Результат Reading');
  const scoreCopy=technical?'<strong>Технический результат: '+result.rawScore+' из '+result.rawMaxScore+'.</strong> Официальная шкала и прогресс не применяются.':result.rawScore+' из '+result.rawMaxScore+' верных полей · '+result.officialScore+' из '+result.officialMaxScore+' первичных баллов · '+formatTime(seconds);
  area().innerHTML='<section class="reading2 reading-result learning-view-enter"><header class="reading-title"><p class="reading-kicker">РЕЗУЛЬТАТ</p><h2 class="learning-view-title">'+reviewTitle.charAt(0).toUpperCase()+reviewTitle.slice(1)+'</h2><p>'+scoreCopy+'</p></header><p class="reading-notice" role="status" aria-live="polite">Разбор открыт после сдачи: ключи и доказательства теперь видны.</p>'+reviewMarkup(item.set,result,voice)+validationDetails()
    +'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button></div></section>';
  setDock(item.set.recordable===false?'':readingPrimary('repeat','Следующий комплект','data-kind="'+item.kind+'"'));
  bindActions();focusViewHeading();
  if(voiceResult)registerVoiceTutorContextResult(voiceResult,resultAuthority,()=>readingContentGeneration===resultContent&&readingRequestCurrent(resultView,resultAuthority)&&training===item&&item.result===result).catch((error)=>handleVoiceOwnerError(error,resultAuthority));
}
function handleVoiceOwnerError(error,authority){if((apiIsAuthorityFailure(error)||error?.code==='OWNER_CHANGED')&&authority)return invalidateLearningAuthority({owner:authority.username,ownerGeneration:authority.generation})}
function trainingEvidence(set,startedAt){
  const contract=readingModule.learningContract(set),id=crypto.randomUUID();
  return createLearningActivityEvidence({id,module:'reading',activityId:contract.activityId,mode:contract.mode,source:'catalog',startedAt,metadata:{
    readingProvenance:'canonical',readingSetId:contract.setId,readingSetRevision:contract.setRevision,
    readingKind:contract.kind,readingCefr:contract.cefr,readingContentRef:contract.contentRef,
    readingAttemptId:id,readingSlice:contract.kind==='task10'?'gist':'detail',readingIndependent:true,
  }});
}
async function startTraining(kind,{technical=false,preferredCefr=null,adaptiveContentRef=null,signal=null,authorityCurrent=null}={}){
  if(launchPending)return false;
  const launch={authority:ownerBinding(),viewGeneration:readingViewGeneration};launchPending=launch;
  try{
    const authority=launch.authority,request=launch.viewGeneration;
    const authorized=()=>!signal?.aborted&&readingRequestCurrent(request,authority)
      &&(typeof authorityCurrent!=='function'||authorityCurrent()===true);
    if(!authorized())return false;
    if(!await verifyLearningAccessForLaunch({signal}))return false;
    if(!authorized())return false;
    if(!technical&&(!catalog||!KINDS.includes(kind)))return false;
    const owner=authority?.username,current=state();if(!authority||!owner||!current){renderOwnerError();return false}
    const pool=technical?[]:(adaptiveContentRef?catalog.sets.filter((item)=>item.kind===kind&&item.cefr===preferredCefr):catalog.sets);
    const set=technical?TECHNICAL_SET:readingModule.selectNextSet(pool,owner,current.history,kind,{now:Date.now(),preferredCefr});
    if(!set)return false;
    if(adaptiveContentRef&&readingModule.learningContract(set).contentRef!==adaptiveContentRef)return false;
    if(!authorized())return false;
    if(!technical){current.history=readingModule.rememberSelection(owner,current.history,kind,set,Date.now());save()}
    const startedAt=Date.now();
    training={owner,authority,kind,set,answers:emptyAnswers(kind,set),startedAt,result:null,evidence:technical?null:trainingEvidence(set,startedAt)};
    RQ=kind==='task12_18'?training:null;
    if(!authorized()){training=null;RQ=null;return false}renderTraining(null,true);
    return true;
  }finally{if(launchPending===launch)launchPending=null}
}
function submitTraining(){
  if(!training||training.result||!training.answers.every((answer)=>answer!==null))return;
  const authority=ownerBinding();if(!sameOwner(training.authority,authority))return;
  const result=readingModule.scoreSet(training.set,training.answers);training.result=result;
  if(training.set.recordable!==false){
    const owner=training.authority.username,current=state(),durationMs=Math.max(0,Date.now()-training.startedAt);if(!current)return;
    const attemptId=training.evidence.id;
    current.history=readingModule.recordAttempt(owner,current.history,training.set,{attemptId,score:result.rawScore,maxScore:result.rawMaxScore,durationMs,attemptedAt:Date.now(),source:'catalog'});
    current.totals[training.kind].correct+=result.rawScore;current.totals[training.kind].total+=result.rawMaxScore;current.completedSets+=1;
    save({queueNow:true});rSync();
    reportWrite=recordLearningActivityEvidence(training.evidence,{score:result.rawScore,maxScore:result.rawMaxScore,durationMs}).catch(()=>false);
  }
  renderTrainingResult();
}

function renderFullIntro(){
  readingContentGeneration++;
  setHeader('Полный раздел 10–18','9 заданий · 20 полей',0,20,'Заполненные поля полного раздела Reading');
  area().innerHTML='<section class="reading2 learning-view-enter"><header class="reading-title"><p class="reading-kicker">УЧЕБНОЕ ВОСПРОИЗВЕДЕНИЕ РАЗДЕЛА</p><h2 class="learning-view-title">Полный раздел 10–18</h2><p>Один канонический комплект каждого формата. Ответы и разбор откроются только после финальной сдачи.</p></header><section class="reading-intro-grid"><article><strong>9</strong><span>заданий с номерами 10–18</span></article><article><strong>20</strong><span>полей ответа: 7 + 6 + 7</span></article><article><strong>12</strong><span>максимум первичных баллов: 3 + 2 + 7</span></article></section><p class="reading-time-note"><strong>Рекомендация ФИПИ — 30 минут.</strong> Это ориентир внутри всей письменной части: Reading не завершается автоматически.</p>'+validationDetails()+'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button></div></section>';
  setDock(readingPrimary('start-full','Начать полный раздел'));
  bindActions();focusViewHeading();
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
  return '<div class="reading-section-nav">'+(index>0?'<button class="reading-action reading-action--secondary" type="button" data-reading-action="full-kind" data-kind="'+KINDS[index-1]+'">Назад: '+KIND_META[KINDS[index-1]].title+'</button>':'<span></span>')
    +(index<KINDS.length-1?readingPrimary('full-kind','Дальше: '+KIND_META[KINDS[index+1]].title,'data-kind="'+KINDS[index+1]+'"'):readingPrimary('submit-full','Сдать раздел'))+'</div>';
}
function blankDialog(){
  const answered=KINDS.reduce((sum,kind)=>sum+full.attempt.answers[kind].filter((answer)=>answer!==null).length,0);
  return '<div class="reading-dialog-backdrop" data-reading-dialog hidden><section class="reading-dialog" role="dialog" aria-modal="true" aria-labelledby="reading-blank-title" aria-describedby="reading-blank-copy"><h2 id="reading-blank-title">В ответах есть пропуски</h2><p id="reading-blank-copy">Заполнено '+answered+' из 20 полей. После сдачи ответы нельзя изменить.</p><div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="cancel-submit">Вернуться к ответам</button><button class="reading-action reading-action--danger" type="button" data-reading-action="confirm-submit">Сдать с пропусками</button></div></section></div>';
}
function renderFullAttempt(restored=false,animate=false){
  if(!full)return;
  readingContentGeneration++;
  full.resumedAt=full.resumedAt||Date.now();
  const kind=full.attempt.currentKind,set=full.attempt.section.sets[kind],answers=full.attempt.answers[kind];
  const answered=KINDS.reduce((sum,key)=>sum+full.attempt.answers[key].filter((answer)=>answer!==null).length,0);
  setHeader(KIND_META[kind].heading,answered+' / 20 полей',answered,20,'Заполненные поля полного раздела Reading');
  const restoredMarkup=restored?'<p class="reading-notice" role="status" aria-live="polite">Незавершённая попытка восстановлена</p>':'';
  area().innerHTML='<section class="reading2 reading-full'+(animate?' learning-view-enter':'')+'"><header class="reading-full-head"><div><p class="reading-kicker">ПОЛНЫЙ РАЗДЕЛ · '+KIND_META[kind].title+'</p><h2 class="learning-view-title">'+KIND_META[kind].heading+'</h2><p>Ответы сохраняются автоматически. Ключи и разбор до сдачи скрыты.</p></div><div><span>ФИПИ: ориентир 30:00</span><strong id="reading-full-timer" role="timer" aria-label="Затраченное время">'+formatTime(elapsedFull())+'</strong><small>Без автозавершения</small></div></header>'+restoredMarkup+'<div class="reading-workspace">'+overviewMarkup()+'<section class="reading-full-task">'+taskMarkup(set,answers,true)+'</section></div>'+blankDialog()+'</section>';
  setDock(fullNav());
  bindActions();startFullTimer();
  if(Number.isInteger(full.attempt.currentPosition))queueMicrotask(()=>focusPosition(full.attempt.currentKind,full.attempt.currentPosition));
}
async function startFullAttempt(){
  if(launchPending)return false;
  const launch={authority:ownerBinding(),viewGeneration:readingViewGeneration};launchPending=launch;
  try{
    const authority=launch.authority,request=launch.viewGeneration;
    if(!authority||!readingRequestCurrent(request,authority))return false;
    if(!await verifyLearningAccessForLaunch())return false;
    if(!readingRequestCurrent(request,authority))return false;
    const owner=authority.username,current=state();if(!catalog||!current)return false;
    const selected=readingModule.selectFullSection(catalog,owner,current.history,{now:Date.now()});current.history=selected.history;
    const now=Date.now();
    const attempt={id:'reading-full-'+(crypto.randomUUID?crypto.randomUUID():now),ownerId:owner,section:{catalogId:selected.catalogId,catalogRevision:selected.catalogRevision,sets:selected.sets},answers:Object.fromEntries(KINDS.map((kind)=>[kind,emptyAnswers(kind,selected.sets[kind])])),currentKind:'task10',currentPosition:0,startedAt:now,durationMs:0};
    full={authority,attempt,resumedAt:now,result:null};RE=full;persistFull();renderFullAttempt(false,true);return true;
  }finally{if(launchPending===launch)launchPending=null}
}
function focusPosition(kind,position){
  const root=area()?.querySelector('[data-reading-kind="'+kind+'"]');
  const selected=full?.attempt?.answers?.[kind]?.[position]??training?.answers?.[position];
  const field=(kind==='task12_18'&&selected!==null&&selected!==undefined
    ?root?.querySelector('[data-reading-answer][data-position="'+position+'"][value="'+selected+'"]')
    :null)||root?.querySelector('[data-reading-answer][data-position="'+position+'"]');
  if(field){field.focus();field.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}
}
function switchFullKind(kind,position=0){
  if(!full||!KINDS.includes(kind))return;
  full.attempt.currentKind=kind;full.attempt.currentPosition=Math.max(0,Math.min(6,Number(position)||0));persistFull();renderFullAttempt(false,true);
}
function requestFullSubmit(){
  if(!full||full.result)return;
  const hidden=readingModule.scoreFullSection(full.attempt.section,full.attempt.answers,{submitted:false});
  if(hidden.answeredFields<20){
    const dialog=area().querySelector('[data-reading-dialog]');dialogReturnFocus=document.activeElement;dialog.hidden=false;
    dialogReturnParent=dialog.parentElement;const route=document.querySelector('#scr7 .learning-route');route?.append(dialog);
    Array.from((route||dialog.parentElement).children).forEach((child)=>{if(child!==dialog)child.inert=true});
    dialog.querySelector('button').focus();return;
  }
  confirmFullSubmit();
}
function closeSubmitDialog(restoreFocus=true){
  const dialog=document.querySelector('#scr7 [data-reading-dialog]');if(!dialog||dialog.hidden!==false)return;
  dialog.hidden=true;Array.from(dialog.parentElement.children).forEach((child)=>{if(child!==dialog)child.inert=false});
  if(dialogReturnParent?.isConnected)dialogReturnParent.append(dialog);dialogReturnParent=null;
  if(dock())dock().inert=false;
  const fallback=dock()?.querySelector('[data-reading-action="submit-full"]');
  if(restoreFocus)(dialogReturnFocus?.isConnected?dialogReturnFocus:fallback)?.focus();dialogReturnFocus=null;
}
function handleBlankDialogKey(event){
  const dialog=event.currentTarget;if(dialog.hidden)return;
  if(event.key==='Escape'){event.preventDefault();closeSubmitDialog();return}
  if(event.key!=='Tab')return;
  const controls=Array.from(dialog.querySelectorAll('button:not(:disabled)'));if(!controls.length)return;
  const first=controls[0],last=controls[controls.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
function confirmFullSubmit(){
  if(!full||full.result||submissionLocked)return;
  const submitDialog=document.querySelector('#scr7 [data-reading-dialog]');if(submitDialog?.hidden===false)closeSubmitDialog();
  submissionLocked=true;stopFullTimer();
  const authority=ownerBinding();
  try{
    if(!sameOwner(full.authority,authority))return;
    const owner=full.authority.username,current=state(),durationMs=elapsedFull();if(!current)return;
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
    reportWrite=evidenceWrite;
    renderFullResult();
  }finally{submissionLocked=false}
}
function renderFullResult(){
  const result=full?.result;if(!result)return;
  const resultAttempt=full,resultView=readingViewGeneration,resultContent=++readingContentGeneration,resultAuthority=resultAttempt.authority;
  const voice=Object.fromEntries(KINDS.map((kind)=>{const set=readingModule.voiceSet(full.attempt.section.sets[kind]);return [kind,{set,result:prepareVoiceTutorContextResult({module:'reading',set,selections:full.attempt.answers[kind]})}]}));
  setHeader('Полный раздел завершён',result.officialScore+' / 12',result.officialScore,12,'Результат полного раздела Reading');
  const perKind=KINDS.map((kind)=>'<li><span>'+KIND_META[kind].title+'</span><strong>'+result.perKind[kind].officialScore+' / '+result.perKind[kind].officialMaxScore+' балла · '+result.perKind[kind].rawScore+' / '+result.perKind[kind].rawMaxScore+' полей</strong></li>').join('');
  const reviews=KINDS.map((kind)=>reviewMarkup(full.attempt.section.sets[kind],result.perKind[kind],voice[kind])).join('');
  area().innerHTML='<section class="reading2 reading-result learning-view-enter"><header class="reading-title"><p class="reading-kicker">РЕЗУЛЬТАТ УЧЕБНОГО РАЗДЕЛА</p><h2 class="learning-view-title">Результат полного раздела</h2><p><strong>'+result.officialScore+' из 12 первичных баллов</strong> · '+result.rawScore+' из 20 верных полей · '+formatTime(result.durationMs)+'</p><small>Это учебное воспроизведение шкалы раздела, не прогноз итогового тестового балла ЕГЭ.</small></header><ul class="reading-score-list">'+perKind+'</ul><p class="reading-notice" role="status" aria-live="polite">Разбор всех 20 полей открыт после финальной сдачи.</p>'+reviews+validationDetails()+'<div class="reading-actions"><button class="reading-action reading-action--secondary" type="button" data-reading-action="hub">К каталогу</button></div></section>';
  setDock(readingPrimary('full-intro','Новый полный раздел'));
  bindActions();focusViewHeading();KINDS.forEach((kind)=>{if(voice[kind].result)registerVoiceTutorContextResult(voice[kind].result,resultAuthority,()=>readingContentGeneration===resultContent&&readingRequestCurrent(resultView,resultAuthority)&&full===resultAttempt&&resultAttempt.result===result).catch((error)=>handleVoiceOwnerError(error,resultAuthority))});
}
function restoreDraft(){
  if(!S.readingPilotDraft)return false;
  const authority=ownerBinding();
  const restored=readingModule.restoreFullAttempt(S.readingPilotDraft,catalog,authority?.username);
  if(!restored.ok){delete S.readingPilotDraft;save();notice='Сохранённая попытка устарела или принадлежит другому аккаунту. Она удалена; начните новый раздел.';return false}
  full={authority,attempt:restored.attempt,resumedAt:Date.now(),result:null};RE=full;renderFullAttempt(true,true);return true;
}
async function initReading(force=false){
  void prepareLearningActivityRecording().catch(()=>{});
  document.getElementById('frame')?.classList.add('reading-expanded');
  const request=++readingViewGeneration,authority=ownerBinding(),owner=authority?.username;
  if(!owner){renderOwnerError();return}
  if(training&&sameOwner(training.authority,authority)&&!training.result){renderTraining(null,true);return}
  if(training&&!sameOwner(training.authority,authority)){training=null;RQ=null}
  if(full&&sameOwner(full.authority,authority)&&!full.result){full.resumedAt=Date.now();renderFullAttempt(false,true);return}
  if(full&&!sameOwner(full.authority,authority)){stopFullTimer();full=null;RE=null}
  if(catalog&&!force){renderHub();return}
  renderLoading();
  if(force)catalog=null;
  if(!loadingPromise)loadingPromise=readingModule.loadPilotCatalog().then((loaded)=>{catalog=readingModule.validateCatalog(loaded);return catalog}).finally(()=>{loadingPromise=null});
  try{
    await loadingPromise;if(!readingRequestCurrent(request,authority))return;
    if(navigator.onLine===false)setNetworkState('cache-ready','Офлайн: каталог Reading загружен из кэша устройства.');
    if(!restoreDraft())renderHub();
  }catch(_){if(readingRequestCurrent(request,authority)){catalog=null;renderCatalogError()}}
}
function bindActions(){
  const host=area();if(!host)return;
  [host,dock()].filter(Boolean).forEach((actionHost)=>actionHost.querySelectorAll('[data-reading-action]').forEach((button)=>button.addEventListener('click',()=>{
    const action=button.dataset.readingAction,kind=button.dataset.kind,position=Number(button.dataset.position)||0;
    if(action==='retry')initReading(true);else if(action==='retry-report')loadReadingReport();else if(action==='technical')startTraining('task10',{technical:true});else if(action==='training'||action==='repeat')startTraining(kind);
    else if(action==='hub')renderHub();else if(action==='submit-training')submitTraining();else if(action==='full-intro')renderFullIntro();else if(action==='start-full')startFullAttempt();
    else if(action==='full-kind'||action==='jump-full')switchFullKind(kind,position);else if(action==='submit-full')requestFullSubmit();else if(action==='cancel-submit')closeSubmitDialog();else if(action==='confirm-submit')confirmFullSubmit();
  })));
  host.querySelector('[data-reading-dialog]')?.addEventListener('keydown',handleBlankDialogKey);
  host.querySelectorAll('[data-reading-answer]').forEach((field)=>field.addEventListener('change',()=>{
    const kind=field.dataset.kind,index=Number(field.dataset.position),value=field.value===''?null:Number(field.value);
    if(full&&!full.result){
      if(kind==='task10'||kind==='task11')full.attempt.answers[kind]=readingModule.selectUnique(full.attempt.answers[kind],index,value);else full.attempt.answers[kind][index]=value;
      full.attempt.currentKind=kind;full.attempt.currentPosition=index;persistFull();renderFullAttempt();
    }
    else if(training&&!training.result){if(kind==='task10'||kind==='task11')training.answers=readingModule.selectUnique(training.answers,index,value);else training.answers[index]=value;renderTraining(index)}
  }));
}

function rHub(){renderHub()}
function rHl(){return startTraining('task10')}
function rGp(){return startTraining('task11')}
function rQs(){return startTraining('task12_18')}
async function launchReadingPractice(kind,cefr,contentRef,{signal=null,authorityCurrent=null}={}){
  const parsed=readingModule.parseAdaptiveContentRef(contentRef);
  if(!parsed||parsed.kind!==kind||parsed.cefr!==cefr)return false;
  return await startTraining(kind,{preferredCefr:cefr,adaptiveContentRef:contentRef,signal,authorityCurrent})===true;
}
function rExam(){renderFullIntro()}
function rExamStart(){return startFullAttempt()}

/* Existing word-saving seam: context remains owner data and never enters the Reading catalog. */
function r_add(status){
  const selected=readingDictionarySelection(),authority=currentOwnerBinding();
  if(!selected||!authority||selected.owner!==authority.username||selected.ownerGeneration!==authority.generation||!['learn','know'].includes(status)||!S)return;
  const lookupState=document.getElementById('r_pop')?.dataset.lookupState;
  if(!['online','builtin'].includes(lookupState))return;
  const word=normalizeVocabularyWord(selected.word),id=personalVocabularyCardId(word);if(!id)return;
  const previousStatus=S.wstatus&&S.wstatus[word];let translation=(document.getElementById('r_tr')?.textContent||'').replace(' · офлайн-словарь','').trim();
  if(!translation||translation.length>240)translation='';
  const pronunciation=(document.getElementById('r_ipa')?.textContent||'').trim();
  const known=EGE_WORDS.find((item)=>wBase(item.w)===word&&(item.provenance==='core'||(!item.provenance&&Number(item.t)!==0)));
  const contextText=selected.context||String(document.getElementById('r_card')?.textContent||'').trim().slice(0,600);
  const activeSets=training?.set?[training.set]:(full?.attempt?.section?.sets?KINDS.map((kind)=>full.attempt.section.sets[kind]):[]);
  const context=readingModule.sourceContextFromSets(activeSets,contextText);if(!context)return;
  S.personalWords=upsertReadingVocabularyCard(S.personalWords||[],{word,translation:translation||null,pronunciation:pronunciation||known?.ipa||null,partOfSpeech:known?.p||null,level:known?.level||null,context});S.personalWordTombstones=(Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[]).filter((value)=>value!==id);S.wstatus=S.wstatus||{};S.wstatus[word]=previousStatus==='know'?'know':status;
  if(status==='know'&&previousStatus!=='know')srsRecordVocabularyOutcome(word,{mode:'russian_reveal',outcome:'knew',now:Date.now()});
  toast(status==='know'?'Отмечено как знакомое · самооценка':'Личная карточка добавлена в «Слова»');save();closeReadingWordPopover();wSync();
}

registerRouteHook((id)=>{
  const frame=document.getElementById('frame');
  if(id==='scr7')initReading();else{
    readingViewGeneration++;reportRequestId++;launchPending=null;closeReadingWordPopover(false);closeSubmitDialog(false);frame?.classList.remove('reading-expanded');pauseFull();setDock();setNetworkState();
  }
});
registerScreenGenerator('scr7',()=>initReading(true));
registerAuthorityReset((authority)=>{
  const active=training?.authority||full?.authority||launchPending?.authority;
  if(!active||authority?.owner!==active.username||authority?.ownerGeneration!==active.generation)return;
  readingViewGeneration++;reportRequestId++;closeSubmitDialog(false);stopFullTimer();training=null;full=null;RE=null;RQ=null;launchPending=null;setDock();setNetworkState();
});

export {RE,RQ,hasActiveReadingPractice,initReading,launchReadingPractice,rExam,rExamStart,rGp,rHl,rHub,rQs,r_add};
