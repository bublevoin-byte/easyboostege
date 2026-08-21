/*
 * Экран «Слова» (scr2). Раздел 6.1 ТЗ обещает словарные карточки и интервальное повторение без
 * сети, поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 *
 * Словарь ЕГЭ, SRS-бухгалтерия и сводка для плитки главного экрана остались в оболочке: их числа
 * нужны сразу после входа, когда этот чанк ещё не загружен. Здесь — только сам экран.
 */
import {registerRouteHook} from '../router.js';
import {wSpeak} from '../tts.js';
import {registerVoiceTutorError,voiceTutorButton} from '../voice-tutor.js';
import {coreVocabularyVoice} from '../modules/core-voice-catalog.js';
import {completeAdaptiveModuleActivity} from '../adaptive-session-runtime.js';
import {createVocabularySessionView} from '../vocabulary-session-view.js';
import {
  appendVocabularySessionHistory,buildVocabularyModuleAttempt,buildVocabularyQueue,buildVocabularyRecognitionOptions,
  buildVocabularyTrend,composeVocabularySession,deriveVocabularyState,gradeVocabularyAnswer,
  migrateVocabularyProgress,normalizeVocabularyWord,personalVocabularyCardId,reinsertVocabularyFailure,
  summarizeVocabularySession,
} from '../vocabulary-domain.js';
import {
  EGE_WORDS,S,SRV,TOKEN,WBTN,currentOwnerBinding,generateAiContent,registerAuthorityReset,registerScreenGenerator,save,srsFail,srsOk,
  srsRecordVocabularyOutcome,syncModuleAttempt,toast,todayStr,ui,wBase,wDeco,wMergeAi,wMigrate,wStats,wSync,wordModule,
} from '../app.js';

/* ===== WORDS v2: SRS-словарь ЕГЭ ===== */
const W_TOPICS={0:'ИИ-набор',1:'Семья и отношения',2:'Образование',3:'Работа и карьера',4:'Путешествия',5:'Природа и экология',6:'Наука и технологии',7:'Здоровье и спорт',8:'Культура и досуг',9:'Общество и СМИ',10:'Город и покупки'};
const W_POS={n:'СУЩЕСТВИТЕЛЬНОЕ',v:'ГЛАГОЛ',adj:'ПРИЛАГАТЕЛЬНОЕ',adv:'НАРЕЧИЕ',ph:'ФРАЗОВЫЙ ГЛАГОЛ',id:'ВЫРАЖЕНИЕ'};
const W_STATE_LABELS={new:'Новое',learning:'Изучаю',review:'Повторяю',strong:'Уверенно'};
const W_PROVENANCE_LABELS={core:'Проверенная база',personal:'Личное слово',generated:'Сгенерированное',unknown:'Источник не указан'};
let WQ=[],WI=0,WDONE=0,WCORRECT=0,W_ADAPTIVE_MODE=null,W_ADAPTIVE_ACTIVITY=null,W_ADAPTIVE_REPORTED=false;
let W_VIEW='home',W_LIBRARY_SCROLL=0,W_DETAIL_RETURN_WORD='';
let W_EVENTS=[],W_REPEAT_COUNTS={},W_PENDING_ANSWER='',W_SUMMARY_SAVED=false,W_LAST_SUMMARY=null;
let W_SESSION_ATTEMPT_ID='',W_SESSION_OWNER=null,W_SESSION_STARTED_AT=0,W_MODULE_ATTEMPT_REPORTED=false;
let W_SESSION_VIEW=null;
function wSameOwner(left,right){return Boolean(left&&right&&left.username===right.username&&left.generation===right.generation)}
function wAttemptId(){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'
  ?globalThis.crypto.randomUUID():('00000000-0000-4000-8000-'+Date.now().toString(16).padStart(12,'0').slice(-12))}
function wArea(){return document.getElementById('w_area')}
function hasActiveVocabularyPractice(){return W_VIEW==='practice'&&WQ.length>WI&&wSameOwner(W_SESSION_OWNER,currentOwnerBinding())}
function wResetToday(){if(S.wday!==todayStr()){S.wday=todayStr();S.wnewUsed=0}}
function wStoredProgress(word){
  return wordModule.progressRecord(S.srs,word);
}
function wProgressStorageKey(word){return wordModule.progressStorageKey(S.srs,word)}
function wStatusFor(word){
  var normalized=normalizeVocabularyWord(word),statuses=S.wstatus||{};
  if(statuses[word]||statuses[normalized])return statuses[word]||statuses[normalized];
  var key=Object.keys(statuses).find(function(value){return normalizeVocabularyWord(value)===normalized});
  return key?statuses[key]:null;
}
function wProgressFor(item){return migrateVocabularyProgress(wStoredProgress(item.w)||{word:item.w,stage:0,errorCount:0,reviewCount:0,dueAt:null})}
function wProvenance(item){
  if(['core','personal','generated','unknown'].includes(item.provenance))return item.provenance;
  if(Number(item.t)>=1)return'core';
  if(Number(item.t)===0)return wStatusFor(item.w)&&!String(item.ex||'').trim()?'personal':'generated';
  return wStatusFor(item.w)?'personal':'core';
}
function wStarted(item){return Boolean(wStoredProgress(item.w)||wStatusFor(item.w))}
function wLibraryCatalog(){
  var items=EGE_WORDS.slice();
  (Array.isArray(S.personalWords)?S.personalWords:[]).forEach(function(card){items.push(wordModule.personalCardItem(card))});
  var seen=new Set(items.map(function(item){return normalizeVocabularyWord(item.w)}));
  var tombstones=new Set(Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[]);
  Object.entries(S.srs||{}).forEach(function(entry){
    var record=entry[1],displayWord=String((record&&record.word)||entry[0]||'').trim(),word=normalizeVocabularyWord(displayWord);
    if(word&&!seen.has(word)){items.push({w:displayWord,provenance:'unknown'});seen.add(word)}
  });
  Object.keys(S.wstatus||{}).forEach(function(key){
    var displayWord=String(key||'').trim(),word=normalizeVocabularyWord(displayWord);
    if(word&&!seen.has(word)&&!tombstones.has(personalVocabularyCardId(word))){items.push({id:personalVocabularyCardId(word),w:displayWord,provenance:'personal'});seen.add(word)}
  });
  return items.filter(function(item){var provenance=wProvenance(item),id=personalVocabularyCardId(item.w);
    if(provenance==='personal'&&tombstones.has(id))return false;
    return ['core','personal'].includes(provenance)||wStarted(item)});
}
function wPracticeCatalog(){var byWord=new Map();
  var tombstones=new Set(Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[]);
  EGE_WORDS.filter(function(item){var provenance=wProvenance(item);
    return (provenance==='core'||wStarted(item))
      &&!(provenance==='personal'&&tombstones.has(personalVocabularyCardId(item.w)))})
    .forEach(function(item){byWord.set(normalizeVocabularyWord(item.w),item)});
  (Array.isArray(S.personalWords)?S.personalWords:[]).forEach(function(card){
    var item=wordModule.personalCardItem(card);
    if(!tombstones.has(personalVocabularyCardId(item.w)))byWord.set(normalizeVocabularyWord(item.w),item)});
  return Array.from(byWord.values())}
function wLibraryEntries(){
  var catalog=wLibraryCatalog().map(function(item){return Object.assign({},item,{provenance:wProvenance(item)})});
  return wordModule.buildLibraryEntries(catalog,S.srs,{stateFor:function(record,item){
    if(!record&&wStatusFor(item.w))return'learning';
    return deriveVocabularyState(record?migrateVocabularyProgress(Object.assign({},record,{word:item.w})):wProgressFor(item))}});
}
function wPlan(){
  var catalog=wPracticeCatalog(),byWord=new Map();
  catalog.forEach(function(item){byWord.set(normalizeVocabularyWord(item.w),item)});
  var budget=wordModule.normalizeNewWordBudget(S.vocabularyNewBudget);
  var queue=buildVocabularyQueue(catalog.map(wProgressFor),{newWordBudget:budget,reviewLimit:20});
  function items(records){return records.map(function(record){return byWord.get(record.word)}).filter(Boolean)}
  var due=items(queue.due),weak=items(queue.weak),fresh=items(queue.new);
  return {due:due,weak:weak,fresh:fresh,items:due.concat(weak,fresh),
    minutes:wordModule.estimateSessionMinutes({due:due.length,weak:weak.length,fresh:fresh.length})};
}
function wRenderFailure(){
  var area=wArea();if(!area)return;
  ui.renderState(area,{kind:'error',title:'Словарь не открылся',
    description:'Попробуй ещё раз — сохранённые слова не потерялись.',
    actionLabel:'Повторить',onAction:initWords});
}
function initWords(){if(!S)return;var area=wArea();
  if(hasActiveVocabularyPractice()&&area){
    wHeading('Тренировка');wProgress();return
  }
  W_ADAPTIVE_MODE=null;W_ADAPTIVE_ACTIVITY=null;W_ADAPTIVE_REPORTED=false;
  W_VIEW='loading';if(area)ui.renderState(area,{kind:'loading',title:'Готовим словарь',description:'Считаем повторения и новые слова'});
  Promise.resolve().then(function(){wMigrate();wMergeAi();wResetToday();
    S.vocabularyNewBudget=wordModule.normalizeNewWordBudget(S.vocabularyNewBudget);
    wSync();if(W_VIEW==='loading')wShowHome()}).catch(function(error){console.error('Vocabulary screen failed',error);wRenderFailure()})}
function wModeFor(w){return W_ADAPTIVE_MODE==='lexical_choice'?'c1':wordModule.modeFor(wStoredProgress(w))}
function launchVocabularyPractice(mode,topicId){
  var modes={
    lexical_choice:{forcedMode:'receptive_meaning',activity:'vocabulary_lexical_choice'},
    english_production:{forcedMode:'english_production',activity:'vocabulary_productive'},
    contextual_production:{forcedMode:'contextual_production',activity:'vocabulary_context'},
    listening:{forcedMode:'listening',activity:'vocabulary_listening'},
  },config=modes[mode];
  if(!config||!Number.isInteger(topicId)||topicId<1||topicId>10||!S)return false;
  wMigrate();wMergeAi();
  if(S.wday!==todayStr()){S.wday=todayStr();S.wnewUsed=0}
  var pool=EGE_WORDS.filter(function(word){if(Number(word.t)!==topicId)return false;
    if(config.forcedMode==='contextual_production')return Boolean(String(word.ex||'').trim());
    return Boolean(String(word.w||'').trim()&&String(word.tr||'').trim())});
  if(!pool.length)return false;
  var items=wordModule.buildDailyQueue(pool,S.srs,{newLimit:12}).slice(0,12);
  if(!items.length)items=pool.slice(0,12);
  W_ADAPTIVE_MODE=config.forcedMode;
  W_ADAPTIVE_ACTIVITY=config.activity+'_topic_'+topicId;
  W_ADAPTIVE_REPORTED=false;wBeginSession(items,config.forcedMode);wSync();
  return true;
}
function wBadge(x){var pos=W_POS[x.p]||x.pos||'СЛОВО';var top=W_TOPICS[x.t]||'';
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
  +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+pos+'</span>'
  +(top?'<span style="font-weight:700;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">'+top+'</span>':'')
  +'<button type="button" class="iconbtn clk" aria-label="Озвучить слово" onclick="wSpeak(WQ[WI]?WQ[WI].w:\'\')" style="cursor:pointer;flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:12px;background:#FFF4DE;">'
  +'<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button></div>'}
function wAnim(name,dur){ui.animate('w_card',name,dur)}
function wProgress(){var t=document.getElementById('w_today');if(t)t.textContent=WDONE+' / '+WQ.length+' сегодня'}
function wDistract(x,field){return wordModule.distractors(EGE_WORDS,x,field)}
function wHeading(title){var heading=document.getElementById('w_header_title');if(heading)heading.textContent=title}
function wHandlerValue(value){return encodeURIComponent(value).replace(/'/g,'%27')}
function wSpeaker(label,value){
  return '<button type="button" class="vocab-icon-btn" aria-label="'+ui.escapeHtml(label)+'" onclick="wSpeakLibraryValue(\''+wHandlerValue(value)+'\')">'
    +'<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button>';
}
function wSessionView(){if(!W_SESSION_VIEW)W_SESSION_VIEW=createVocabularySessionView({
  escapeHtml:ui.escapeHtml,decoration:wDeco,badge:wBadge,speaker:wSpeaker,handlerValue:wHandlerValue,
  requestFrame:function(callback){requestAnimationFrame(callback)},
});return W_SESSION_VIEW}
function wSpeakLibraryValue(encoded){wSpeak(decodeURIComponent(encoded||''))}
function wShowHome(){
  var area=wArea();if(!area)return;W_VIEW='home';wHeading('Слова');
  var plan=wPlan(),budget=wordModule.normalizeNewWordBudget(S.vocabularyNewBudget);
  var total=plan.items.length,entries=wLibraryEntries(),topicCounts={};
  var trend7=buildVocabularyTrend(S.vocabularyHistory,{days:7}),trend30=buildVocabularyTrend(S.vocabularyHistory,{days:30});
  entries.forEach(function(entry){entry.topicIds.forEach(function(id){if(W_TOPICS[id])topicCounts[id]=(topicCounts[id]||0)+1})});
  var topicOverview=Object.keys(topicCounts).sort(function(left,right){return topicCounts[right]-topicCounts[left]}).slice(0,3);
  area.innerHTML='<section class="vocab vocab-home" aria-labelledby="w_home_title">'
    +'<p class="vocab-kicker">АКТИВНЫЙ СЛОВАРЬ</p><h1 id="w_home_title">Сегодня</h1>'
    +'<div class="vocab-stats" aria-label="План на сегодня">'
    +'<article><strong>'+plan.due.length+'</strong><span>к сроку</span></article>'
    +'<article><strong>'+plan.fresh.length+'</strong><span>новых</span></article>'
    +'<article><strong>'+plan.minutes+'</strong><span>минут</span></article></div>'
    +(plan.weak.length?'<p class="vocab-note">Ещё '+plan.weak.length+' '+(plan.weak.length===1?'слово требует':'слова требуют')+' внимания — они уже учтены во времени.</p>':'')
    +'<fieldset class="vocab-budget"><legend>Новых слов за день</legend><div class="vocab-budget-options" role="group" aria-label="Количество новых слов">'
    +wordModule.newWordBudgets.map(function(value){var selected=value===budget;
      return '<button type="button" id="w_budget_'+value+'" class="vocab-budget-btn'+(selected?' is-selected':'')+'" aria-pressed="'+selected+'" onclick="wSetBudget('+value+')">'+value+'</button>'}).join('')
    +'</div><p id="w_budget_note" role="status" aria-live="polite">Если накопились повторения, новых слов будет меньше.</p></fieldset>'
    +'<button type="button" class="vocab-primary sq" onclick="wStartPractice()"'+(total?'':' disabled')+'>'+(total?'Начать · '+total:'На сегодня всё')+'</button>'
    +wSessionView().trendMarkup(trend7,trend30)
    +'<button type="button" class="vocab-library-link" onclick="wShowLibrary()">'
    +'<span><strong>Библиотека</strong><small>Проверенная база и все начатые слова</small></span><span aria-hidden="true">'+entries.length+' ›</span></button>'
    +(topicOverview.length?'<section class="vocab-topic-overview" aria-labelledby="w_topic_overview_title"><h2 id="w_topic_overview_title">Темы библиотеки</h2><div>'
      +topicOverview.map(function(id){return'<span>'+ui.escapeHtml(W_TOPICS[id])+' · '+topicCounts[id]+'</span>'}).join('')+'</div></section>':'')
    +'</section>';
  var start=area.querySelector('.vocab-primary');if(start&&start.disabled)start.setAttribute('aria-label','На сегодня нет запланированных слов')}
function wSetBudget(value){
  S.vocabularyNewBudget=wordModule.normalizeNewWordBudget(value);save();wShowHome();
  var selected=document.getElementById('w_budget_'+S.vocabularyNewBudget);if(selected)selected.focus()}
function wStartPractice(){
  W_ADAPTIVE_MODE=null;W_ADAPTIVE_ACTIVITY=null;W_ADAPTIVE_REPORTED=false;
  var plan=wPlan();wBeginSession(plan.items);
}
function wBeginSession(items,forcedMode){
  var progressByWord={};items.forEach(function(item){var progress=wStoredProgress(item.w);if(progress)progressByWord[item.w]=progress});
  WQ=composeVocabularySession(items,{progressByWord:progressByWord,forcedMode:forcedMode});WI=0;WDONE=0;WCORRECT=0;
  W_EVENTS=[];W_REPEAT_COUNTS={};W_PENDING_ANSWER='';W_SUMMARY_SAVED=false;W_LAST_SUMMARY=null;W_VIEW='practice';
  W_SESSION_ATTEMPT_ID=wAttemptId();W_SESSION_OWNER=currentOwnerBinding();W_SESSION_STARTED_AT=Date.now();W_MODULE_ATTEMPT_REPORTED=false;
  var area=wArea();if(!area)return;
  area.innerHTML='<div id="w_card" class="vocab-practice-card"></div><div id="w_opts" class="vocab-practice-options"></div>';
  wHeading('Тренировка');wRender()}
function wFilters(){
  var value=S.vocabularyLibraryFilters;
  if(!value||typeof value!=='object')value={};
  return {
    query:String(value.query||''),
    topics:Array.isArray(value.topics)?value.topics.map(String):[],
    states:Array.isArray(value.states)?value.states.map(String):[],
    provenances:Array.isArray(value.provenances)?value.provenances.map(String):[],
  };
}
function wStoreFilters(filters){S.vocabularyLibraryFilters=filters;save()}
function wFilterCheckbox(kind,value,label,selected){
  return '<label class="vocab-filter-chip"><input type="checkbox" aria-label="'+ui.escapeHtml(label)+'" value="'+ui.escapeHtml(value)+'" '+(selected?'checked ':'')
    +'onchange="wSetLibraryFilter(\''+kind+'\',this.value,this.checked)"><span>'+ui.escapeHtml(label)+'</span></label>';
}
function wAvailableTopics(entries){
  var ids=new Set();entries.forEach(function(entry){entry.topicIds.forEach(function(id){ids.add(id)})});
  return Array.from(ids).sort(function(left,right){return Number(left)-Number(right)})
}
function wShowLibrary(){
  var area=wArea();if(!area)return;var returnWord=W_VIEW==='detail'?W_DETAIL_RETURN_WORD:'';
  var announceLibrary=W_VIEW!=='library';W_VIEW='library';wHeading('Библиотека');
  var entries=wLibraryEntries(),filters=wFilters(),topics=wAvailableTopics(entries);
  area.innerHTML='<section class="vocab vocab-library" aria-labelledby="w_library_title">'
    +'<div class="vocab-view-head"><button type="button" class="vocab-back" onclick="wShowHome()" aria-label="Вернуться на главную словаря">←</button>'
    +'<div><p class="vocab-kicker">ВСЕ СЛОВА</p><h1 id="w_library_title" tabindex="-1">Библиотека</h1></div></div>'
    +'<label id="w_library_search_label" class="vocab-search-label" for="w_library_search">Поиск по слову или переводу</label>'
    +'<input id="w_library_search" class="vocab-search" type="search" aria-labelledby="w_library_search_label" value="'+ui.escapeHtml(filters.query)+'" autocomplete="off" placeholder="Например, achievement" oninput="wSetLibrarySearch(this.value)">'
    +'<details class="vocab-filters"><summary>Фильтры</summary>'
    +'<fieldset><legend>Темы</legend><div class="vocab-filter-grid">'
    +topics.map(function(id){return wFilterCheckbox('topics',id,W_TOPICS[id]||('Тег '+id),filters.topics.includes(id))}).join('')+'</div></fieldset>'
    +'<fieldset><legend>Статусы</legend><div class="vocab-filter-grid">'
    +Object.keys(W_STATE_LABELS).map(function(id){return wFilterCheckbox('states',id,W_STATE_LABELS[id],filters.states.includes(id))}).join('')+'</div></fieldset>'
    +'<fieldset><legend>Источник</legend><div class="vocab-filter-grid">'
    +Object.keys(W_PROVENANCE_LABELS).map(function(id){return wFilterCheckbox('provenances',id,W_PROVENANCE_LABELS[id],filters.provenances.includes(id))}).join('')+'</div></fieldset>'
    +'<button type="button" class="vocab-clear" onclick="wClearLibraryFilters()">Сбросить фильтры</button></details>'
    +'<p id="w_library_status" class="vocab-results-status" role="status" aria-live="polite" aria-atomic="true"></p>'
    +'<div id="w_library_results"></div></section>';
  wRenderLibraryResults();requestAnimationFrame(function(){area.scrollTop=W_LIBRARY_SCROLL;
    if(returnWord){var buttons=Array.from(area.querySelectorAll('.vocab-word-open'));
      var target=buttons.find(function(button){return button.dataset.vocabWord===returnWord})||document.getElementById('w_library_title');
      if(target)target.focus()}
    else if(announceLibrary){var heading=document.getElementById('w_library_title');if(heading)heading.focus()}})}
function wSetLibrarySearch(value){var filters=wFilters();filters.query=String(value||'');wStoreFilters(filters);wRenderLibraryResults()}
function wSetLibraryFilter(kind,value,checked){
  if(!['topics','states','provenances'].includes(kind))return;
  var filters=wFilters(),selected=new Set(filters[kind]);if(checked)selected.add(String(value));else selected.delete(String(value));
  filters[kind]=Array.from(selected);wStoreFilters(filters);wRenderLibraryResults()}
function wClearLibraryFilters(){
  wStoreFilters({query:'',topics:[],states:[],provenances:[]});W_LIBRARY_SCROLL=0;wShowLibrary();
  var search=document.getElementById('w_library_search');if(search)search.focus()}
function wRenderLibraryResults(){
  var host=document.getElementById('w_library_results'),status=document.getElementById('w_library_status');if(!host)return;
  try{
    var visible=wordModule.filterLibraryEntries(wLibraryEntries(),wFilters());
    if(status)status.textContent='Найдено слов: '+visible.length;
    if(!visible.length){ui.renderState(host,{kind:'empty',title:'Пока пусто',
      description:'Измени запрос или сбрось один из фильтров.',actionLabel:'Сбросить фильтры',onAction:wClearLibraryFilters});return}
    host.innerHTML='<ul class="vocab-word-list">'+visible.map(function(entry){
      var word=ui.escapeHtml(entry.word),translation=entry.translation?ui.escapeHtml(entry.translation):'Перевод пока не добавлен';
      var topics=entry.topicIds.map(function(id){return '<span>'+ui.escapeHtml(W_TOPICS[id]||('Тег '+id))+'</span>'}).join('');
      return '<li class="vocab-word-row vocab-source-'+entry.provenance+'">'
        +'<button type="button" class="vocab-word-open" data-vocab-word="'+wHandlerValue(entry.word)+'" data-vocab-id="'+wHandlerValue(entry.id)+'" onclick="wShowWord(\''+wHandlerValue(entry.id)+'\')">'
        +'<span class="vocab-word-main"><strong>'+word+'</strong><small>'+translation+'</small></span>'
        +'<span class="vocab-word-meta"><span class="vocab-state">'+W_STATE_LABELS[entry.state]+'</span>'
        +'<span class="vocab-provenance">'+W_PROVENANCE_LABELS[entry.provenance]+'</span></span>'
        +(topics?'<span class="vocab-topic-tags">'+topics+'</span>':'')+'</button>'
        +wSpeaker('Озвучить слово '+entry.word,entry.word)+'</li>'}).join('')+'</ul>';
  }catch(error){console.error('Vocabulary library failed',error);if(status)status.textContent='';
    ui.renderState(host,{kind:'error',title:'Слова не показались',description:'Повтори загрузку списка.',
      actionLabel:'Повторить',onAction:wRenderLibraryResults})}}
function wFindWord(encoded){
  var value=decodeURIComponent(encoded||''),items=wLibraryCatalog();
  return items.find(function(item){var provenance=wProvenance(item),id=String(item.id||provenance+':'+normalizeVocabularyWord(item.w));return id===value})
    ||items.find(function(item){return normalizeVocabularyWord(item.w)===normalizeVocabularyWord(value)})||null}
function wMetadata(label,value,missing){
  return '<div><dt>'+label+'</dt><dd class="'+(value?'':'is-missing')+'">'+ui.escapeHtml(value||missing)+'</dd></div>'}
function wHonestDetailItem(item){
  var legacyPersonal=wProvenance(item)==='personal'&&Number(item.t)===0&&!item.provenance
    &&!String(item.ex||'').trim()&&!(Array.isArray(item.examples)&&item.examples.length);
  return legacyPersonal?Object.assign({},item,{p:null,pos:null}):item;
}
function wShowWord(encoded){
  var area=wArea();if(!area)return;W_LIBRARY_SCROLL=area.scrollTop;var item=wFindWord(encoded);
  if(!item){ui.renderState(area,{kind:'error',title:'Карточка не найдена',description:'Вернись в библиотеку и выбери слово снова.',
    actionLabel:'В библиотеку',onAction:wShowLibrary});return}
  var itemId=String(item.id||wProvenance(item)+':'+normalizeVocabularyWord(item.w));
  W_DETAIL_RETURN_WORD=wHandlerValue(item.w);W_VIEW='detail';wHeading('Карточка');
  var details=wordModule.wordDetails(wHonestDetailItem(item)),provenance=wProvenance(item);
  var meanings=details.meanings.length
    ?'<ul class="vocab-meanings">'+details.meanings.map(function(value){return'<li>'+ui.escapeHtml(value)+'</li>'}).join('')+'</ul>'
    :'<p class="vocab-missing">Перевод пока не добавлен</p>';
  var examples=details.examples.length?details.examples.map(function(example,index){
    var translation=example.translation||'Перевод примера пока не добавлен';
    return '<li class="vocab-example"><div><p lang="en">'+ui.escapeHtml(example.text)+'</p>'
      +wSpeaker('Озвучить пример '+(index+1),example.text)+'</div>'
      +'<button type="button" class="vocab-example-toggle" aria-expanded="false" aria-controls="w_example_translation_'+index+'" onclick="wToggleExampleTranslation('+index+',this)">Показать перевод</button>'
      +'<p id="w_example_translation_'+index+'" class="'+(example.translation?'':'is-missing')+'" hidden>'+ui.escapeHtml(translation)+'</p></li>'}).join('')
    :'<li class="vocab-missing">Примеры пока не добавлены</li>';
  area.innerHTML='<article class="vocab vocab-detail" aria-labelledby="w_detail_title">'
    +'<div class="vocab-view-head"><button id="w_detail_back" type="button" class="vocab-back" onclick="wShowLibrary()" aria-label="Вернуться в библиотеку">←</button>'
    +'<div><p class="vocab-kicker">'+W_PROVENANCE_LABELS[provenance]+'</p><h1 id="w_detail_title" tabindex="-1" lang="en">'+ui.escapeHtml(details.word)+'</h1></div>'
    +wSpeaker('Озвучить слово '+details.word,details.word)+'</div>'
    +'<dl class="vocab-metadata">'+wMetadata('Произношение',details.pronunciation,'Транскрипция пока не добавлена')
    +wMetadata('Часть речи',W_POS[details.partOfSpeech]||details.partOfSpeech,'Часть речи не указана')
    +wMetadata('Уровень',details.level,'Уровень пока не указан')
    +wMetadata('Источник карточки',details.source,'Источник пока не указан')+'</dl>'
    +'<section class="vocab-detail-section"><h2>Значения</h2>'+meanings+'</section>'
    +'<section class="vocab-detail-section"><h2>Примеры в контексте</h2><ul class="vocab-examples">'+examples+'</ul></section>'
    +'<p class="vocab-readonly-note">Просмотр и озвучка не меняют прогресс слова.</p>'
    +(provenance==='personal'?'<section class="vocab-personal-actions" aria-labelledby="w_personal_actions_title">'
      +'<h2 id="w_personal_actions_title">Личная карточка</h2><p>Можно удалить контекст из чтения. Прогресс слова и проверенная карточка не изменятся.</p>'
      +'<button type="button" class="vocab-delete-personal" onclick="wDeletePersonalWord(\''+wHandlerValue(itemId)+'\')">Удалить личную карточку</button></section>':'')+'</article>';
  var detailHeading=document.getElementById('w_detail_title');if(detailHeading)detailHeading.focus()}
function wDeletePersonalWord(encoded){var item=wFindWord(encoded);if(!item||wProvenance(item)!=='personal')return;
  var computedId=String(item.id||personalVocabularyCardId(item.w));if(!computedId.startsWith('personal:'))return;
  if(!window.confirm('Удалить только личную карточку из чтения? Прогресс слова и проверенная база останутся.'))return;
  var id=computedId,word=normalizeVocabularyWord(item.w);
  S.personalWords=(Array.isArray(S.personalWords)?S.personalWords:[]).filter(function(card){return card.id!==id});
  S.personalWordTombstones=Array.from(new Set((Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[]).concat([id]))).slice(-500);
  if(S.wstatus)delete S.wstatus[word];save();wSync();wShowLibrary();
  try{toast('Личная карточка удалена. Прогресс слова сохранён.')}catch(e){}}
function wToggleExampleTranslation(index,button){
  var translation=document.getElementById('w_example_translation_'+index);if(!translation||!button)return;
  var expanded=button.getAttribute('aria-expanded')==='true';translation.hidden=expanded;
  button.setAttribute('aria-expanded',String(!expanded));button.textContent=expanded?'Показать перевод':'Скрыть перевод'}
function wSessionItem(task){return wPracticeCatalog().find(function(item){return normalizeVocabularyWord(item.w)===task.word})||null}
function wAcceptedEnglish(item){return Array.from(new Set([wBase(item.w)].concat(Array.isArray(item.acceptedAnswers)?item.acceptedAnswers:[]).filter(Boolean)))}
function wContextBlank(item){var base=wBase(item.w),escaped=base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return String(item.ex||'').replace(new RegExp(escaped,'iu'),'_____')}
function wBridgeCandidates(failedWord){var seen=new Set([normalizeVocabularyWord(failedWord)]),candidates=[];
  function add(word){var normalized=normalizeVocabularyWord(word);if(!normalized||seen.has(normalized))return;
    seen.add(normalized);candidates.push({id:normalized+':bridge',word:normalized,mode:'bridge',introduced:false,reviewed:false})}
  WQ.slice(0,WI).forEach(function(task){if(task.mode!=='introduction')add(task.word)});
  wPracticeCatalog().forEach(function(item){add(item.w)});return candidates}
function wShowFeedback(task,item,result){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');if(!card||!opts)return;
  wSessionView().renderFeedback(card,opts,task,item,result)}
function wRecordSessionOutcome(task,item,result){
  srsRecordVocabularyOutcome(wProgressStorageKey(item.w),{mode:task.mode,outcome:result.outcome,now:Date.now()});
  W_EVENTS.push({word:task.word,mode:task.mode,outcome:result.outcome,
    independentSuccess:result.independentSuccess,introduced:false,reviewed:task.reviewed});
  WDONE++;if(result.independentSuccess)WCORRECT++;
  if(['almost','incorrect','not_known'].includes(result.outcome)){
    var repeated=reinsertVocabularyFailure(WQ,task,{afterIndex:WI,minInterveningItems:2,
      repeatCounts:W_REPEAT_COUNTS,maxRepeatsPerWord:2,
      fallbackItems:wBridgeCandidates(task.word)});
    WQ=repeated.items;W_REPEAT_COUNTS=repeated.repeatCounts;
  }
  save();wSync();wShowFeedback(task,item,result)}
function wCompleteIntroduction(){var task=WQ[WI],item=task&&wSessionItem(task);if(!task||!item||task.mode!=='introduction')return;
  W_EVENTS.push({word:task.word,mode:'introduction',introduced:true,reviewed:false});
  S.wnewUsed=(S.wnewUsed||0)+1;save();wSessionNext()}
function wCompleteBridge(){var task=WQ[WI];if(!task||!task.bridge)return;wSessionNext()}
function wChooseRecognition(encoded){var task=WQ[WI],item=task&&wSessionItem(task);if(!task||!item||task.mode!=='receptive_meaning')return;
  var answer=decodeURIComponent(encoded||'');var result=gradeVocabularyAnswer({mode:task.mode,answer:answer,acceptedAnswers:[item.tr]});
  wRecordSessionOutcome(task,item,result)}
function wRevealRussian(){var task=WQ[WI],item=task&&wSessionItem(task),input=document.getElementById('w_session_input');
  if(!task||!item||task.mode!=='russian_reveal'||!input)return;W_PENDING_ANSWER=input.value||'';
  var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  wSessionView().renderRussianReveal(card,opts,item)}
function wRateRussian(rating){var task=WQ[WI],item=task&&wSessionItem(task);if(!task||!item||task.mode!=='russian_reveal')return;
  var result=gradeVocabularyAnswer({mode:task.mode,answer:W_PENDING_ANSWER,acceptedAnswers:[item.tr],selfRating:rating});
  wRecordSessionOutcome(task,item,result)}
function wSubmitSession(){var task=WQ[WI],item=task&&wSessionItem(task),input=document.getElementById('w_session_input');
  if(!task||!item||!input||input.dataset.done)return;
  if(task.mode==='russian_reveal'){wRevealRussian();return}
  input.dataset.done='true';var result=gradeVocabularyAnswer({mode:task.mode,answer:input.value,acceptedAnswers:wAcceptedEnglish(item)});
  wRecordSessionOutcome(task,item,result)}
function wNotKnown(){var task=WQ[WI],item=task&&wSessionItem(task);if(!task||!item||task.mode==='introduction')return;
  var input=document.getElementById('w_session_input'),answer=input?input.value:'';
  var result=gradeVocabularyAnswer({mode:task.mode,answer:answer,acceptedAnswers:task.mode==='receptive_meaning'?[item.tr]:wAcceptedEnglish(item),
    selfRating:task.mode==='russian_reveal'?'not_known':null,notKnown:true});
  wRecordSessionOutcome(task,item,result)}
function wSessionNext(){WI++;W_PENDING_ANSWER='';wRender()}
function wReportSessionAttempt(){if(W_MODULE_ATTEMPT_REPORTED||!W_SESSION_ATTEMPT_ID)return;
  var attempt=buildVocabularyModuleAttempt(W_EVENTS,{id:W_SESSION_ATTEMPT_ID,durationMs:Date.now()-W_SESSION_STARTED_AT,
    activity:W_ADAPTIVE_ACTIVITY||'vocabulary_active_recall_session'});
  if(W_ADAPTIVE_ACTIVITY){W_MODULE_ATTEMPT_REPORTED=true;W_ADAPTIVE_REPORTED=true;
    Promise.resolve(completeAdaptiveModuleActivity({module:'vocabulary',activityId:W_ADAPTIVE_ACTIVITY,score:attempt.score,maxScore:attempt.maxScore,durationMs:attempt.durationMs}))
      .then(function(result){if(!result){W_MODULE_ATTEMPT_REPORTED=false;W_ADAPTIVE_REPORTED=false}})
      .catch(function(){W_MODULE_ATTEMPT_REPORTED=false;W_ADAPTIVE_REPORTED=false});return}
  if(typeof SRV==='undefined'||!SRV||!TOKEN)return;W_MODULE_ATTEMPT_REPORTED=true;
  syncModuleAttempt(attempt)}
function wRenderSummary(card,opts){var summary=summarizeVocabularySession(W_EVENTS);W_LAST_SUMMARY=summary;
  if(!W_SUMMARY_SAVED){W_SUMMARY_SAVED=true;S.vocabularyHistory=appendVocabularySessionHistory(S.vocabularyHistory,summary);save();wSync()}
  wReportSessionAttempt();
  wSessionView().renderSummary(card,opts,summary)}
function wPracticeDifficult(){if(!W_LAST_SUMMARY)return;W_ADAPTIVE_MODE=null;W_ADAPTIVE_ACTIVITY=null;W_ADAPTIVE_REPORTED=false;
  var difficult=new Set(W_LAST_SUMMARY.difficultWords.map(function(item){return item.word}));
  var items=wPracticeCatalog().filter(function(item){return difficult.has(normalizeVocabularyWord(item.w))});if(items.length)wBeginSession(items)}
function wRenderSession(){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');if(!card||!opts)return;
  wProgress();var task=WQ[WI];if(!task){wRenderSummary(card,opts);return}var item=wSessionItem(task);if(!item){wSessionNext();return}
  wAnim('win','.32s');wSessionView().renderTask(card,opts,{task:task,item:item,
    choices:task.mode==='receptive_meaning'?buildVocabularyRecognitionOptions(wPracticeCatalog(),item):[],
    contextPrompt:task.mode==='contextual_production'?wContextBlank(item):''});
  if(task.mode==='listening')wSpeak(item.w)}
function wRender(){wRenderSession()}
function wRenderLegacy(){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  if(!card||!opts)return;wProgress();
  wAnim('win','.32s');
  var x=WQ[WI];
  if(!x){var st=wStats(),n=S.wnewUsed||0;
    if(W_ADAPTIVE_MODE&&!W_ADAPTIVE_REPORTED){W_ADAPTIVE_REPORTED=true;completeAdaptiveModuleActivity({module:'vocabulary',activityId:W_ADAPTIVE_ACTIVITY,score:WCORRECT,maxScore:Math.max(1,WDONE)}).catch(function(){W_ADAPTIVE_REPORTED=false})}
    card.innerHTML=wDeco()+'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:22px 0;">'
      +'<div style="font-size:44px;">🎉</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:10px;">'+(n>0?'Ура! Сегодня +'+n+' новых слов':'На сегодня всё!')+'</div>'
      +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">Выучено полностью: '+st.learned+' из '+st.total+'<br>Слова вернутся на повторение в свой срок</div></div>';
    opts.innerHTML='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wShowHome()">К плану на сегодня</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="wShowLibrary()">Открыть библиотеку</button>';
    return}
  var mode=wModeFor(x.w);
  if(mode==='c1'||mode==='c2'){
    var q=mode==='c1'?x.w:x.tr, field=mode==='c1'?'tr':'w';
    var right=x[field], all=wDistract(x,field).concat([right]).sort(function(){return Math.random()-.5});
    card.innerHTML=wDeco()+wBadge(x)
      +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
      +'<div style="font-weight:600;font-size:11.5px;letter-spacing:1px;color:#777163;">'+(mode==='c1'?'ВЫБЕРИ ПЕРЕВОД':'ВЫБЕРИ СЛОВО')+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:'+(mode==='c1'?'30':'24')+'px;color:#2B2B2B;margin-top:10px;letter-spacing:-.5px;">'+q+'</div></div>';
    opts.innerHTML=all.map(function(v){return '<button class="sq" style="'+WBTN+'" onclick="wPick(this,\''+encodeURIComponent(v)+'\',\''+encodeURIComponent(right)+'\')">'+v+'</button>'}).join('');
    if(mode==='c1')wSpeak(x.w);
    return}
  var blank=(x.ex||'').replace(new RegExp(wBase(x.w).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),'_____');
  card.innerHTML=wDeco()+wBadge(x)
    +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
    +'<div style="font-weight:600;font-size:11.5px;letter-spacing:1px;color:#777163;">НАПИШИ СЛОВО</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:24px;color:#B54E2F;margin-top:8px;">'+x.tr+'</div>'
    +'<div style="font-weight:500;font-size:13.5px;color:#777163;margin-top:10px;font-style:italic;line-height:1.5;">'+blank+'</div></div>';
  opts.innerHTML='<input id="w_inp" aria-label="Введи слово по-английски" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="Введи слово по-английски" '
    +'style="width:100%;box-sizing:border-box;height:52px;border:1px solid #F0EAE2;border-radius:18px;padding:0 16px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);" '
    +'onkeydown="if(event.key===\'Enter\')wSubmit()">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wSubmit()">Проверить</button>'}
/* карточка-переворот после ошибки */
function wFlip(x,learnerAnswer,mode){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  if(!card||!opts)return;
  wAnim('wflip','.5s');
  card.innerHTML=wDeco()+wBadge(x)
    +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:30px;color:#2B2B2B;letter-spacing:-.6px;">'+x.w+'</div>'
    +(x.ipa?'<div style="font-weight:500;font-size:14px;color:#777163;margin-top:5px;">'+x.ipa+'</div>':'')
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:20px;color:#B54E2F;margin-top:12px;">'+x.tr+'</div>'
    +'<div style="font-weight:500;font-size:13.5px;color:#777163;margin-top:12px;font-style:italic;line-height:1.5;background:#FAF6F1;border-radius:14px;padding:10px 14px;">'+(x.ex||'')+'</div>'
    +'<div style="font-weight:600;font-size:11.5px;color:#75705F;margin-top:10px;">Запомни — слово вернётся позже</div></div>';
  opts.innerHTML='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wNext()">Понятно, дальше</button>';
  var voice=coreVocabularyVoice(x,mode);
  if(voice)registerVoiceTutorError({module:'vocabulary',itemId:voice.id,revision:voice.revision,learnerAnswer:learnerAnswer})
    .then(function(recorded){if(recorded&&WQ[WI]===x&&opts.isConnected)opts.insertAdjacentHTML('afterbegin',voiceTutorButton(recorded))}).catch(function(){});
  wSpeak(x.w)}
/* Старая ссылка из профиля теперь открывает ту же постоянную библиотеку, уже с фильтром Strong. */
function wShowKnown(){W_LIBRARY_SCROLL=0;wStoreFilters({query:'',topics:[],states:['strong'],provenances:[]});wShowLibrary()}
function wNext(){if(!W_ADAPTIVE_MODE)return wSessionNext();WI++;wSync();save();wRender()}
function wPick(btn,vEnc,rightEnc){var x=WQ[WI];if(!x||btn.dataset.done)return;
  var v=decodeURIComponent(vEnc),right=decodeURIComponent(rightEnc),mode=wModeFor(x.w);
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var progressKey=wProgressStorageKey(x.w),r0=wStoredProgress(x.w),isNew=!r0||!r0.s;
  if(isNew)S.wnewUsed=(S.wnewUsed||0)+1;
  if(v===right){ui.markAnswer(btn,'correct');srsOk(progressKey);WDONE++;WCORRECT++;wAnim('wpop','.35s');
    setTimeout(wNext,650)}
  else{ui.markAnswer(btn,'wrong');wAnim('wshake','.42s');
    all.forEach(function(b){if(b.textContent===right)ui.markAnswer(b,'correct')});
    srsFail(progressKey);WDONE++;WQ.push(x);
    setTimeout(function(){wFlip(x,v,mode)},900)}}
function wSubmit(){var x=WQ[WI];if(!x)return;var inp=document.getElementById('w_inp');if(!inp||inp.dataset.done)return;
  var progressKey=wProgressStorageKey(x.w),val=(inp.value||'').toLowerCase().trim().replace(/^to /,'');
  var ok=val===wBase(x.w);inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  if(!ok){inp.value=wBase(x.w);srsFail(progressKey);WQ.push(x)}else srsOk(progressKey);
  WDONE++;if(ok){WCORRECT++;wSpeak(x.w);wAnim('wpop','.35s')}else wAnim('wshake','.42s');
  setTimeout(ok?wNext:function(){wFlip(x,val,'type')},ok?650:900)}
function wExtra(){wMergeAi();
  var fresh=EGE_WORDS.filter(function(x){var r=wStoredProgress(x.w);return !r||!r.s});
  wBeginSession(fresh.slice(0,30));
  if(fresh.length<40)wTopUp()}
/* фоновая генерация: база сама пополняется, сверяясь с уже известными словами */
var W_GEN=false;
async function wTopUp(){
  if(W_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var fresh=EGE_WORDS.filter(function(x){var r=wStoredProgress(x.w);return !r||!r.s}).length;
  if(fresh>=40)return;W_GEN=true;
  try{
    var have=EGE_WORDS.map(function(x){return x.w}).slice(0,500);
    var d=await generateAiContent('vocabulary_cards',{count:8,exclude:have});
    if(Array.isArray(d)&&d.length){var have2={};EGE_WORDS.forEach(function(x){have2[x.w]=1});
      var added=[];
      d.forEach(function(x){if(x.w&&x.tr&&!have2[x.w]&&(x.ex||'').toLowerCase().indexOf(x.w.replace(/^to /,'').toLowerCase())>=0){var it={w:x.w,p:x.p||'n',t:0,tr:x.tr,ex:x.ex||'',voice_tutor:x.voice_tutor||null};EGE_WORDS.push(it);added.push(it);have2[x.w]=1}});
      if(added.length){S.aiWords=(S.aiWords||[]).concat(added);save();wSync()}}
  }catch(e){}
  W_GEN=false}
/* ИИ-набор слов теперь пополняет базу ЕГЭ */
async function genWords(){
  const d=await generateAiContent('vocabulary_cards',{count:8,exclude:EGE_WORDS.map(function(x){return x.w}).slice(0,500)});if(!Array.isArray(d)||!d.length)throw 0;
  var have={};EGE_WORDS.forEach(function(x){have[x.w]=1});
  d.forEach(function(x){if(x.w&&x.tr&&!have[x.w])EGE_WORDS.push({w:x.w,p:x.p||'n',t:0,tr:x.tr,ex:x.ex||'',voice_tutor:x.voice_tutor||null})});
  initWords()}

registerRouteHook(function(id){if(id==='scr2')initWords()});
registerScreenGenerator('scr2',genWords);
registerAuthorityReset(function(authority){
  if(!W_SESSION_OWNER||authority?.owner!==W_SESSION_OWNER.username||authority?.ownerGeneration!==W_SESSION_OWNER.generation)return;
  WQ=[];WI=0;WDONE=0;WCORRECT=0;W_EVENTS=[];W_REPEAT_COUNTS={};W_PENDING_ANSWER='';W_SESSION_VIEW=null;
  W_SESSION_ATTEMPT_ID='';W_SESSION_OWNER=null;W_SESSION_STARTED_AT=0;W_MODULE_ATTEMPT_REPORTED=false;W_VIEW='home';
});
document.addEventListener('keydown',function(event){
  var screen=document.getElementById('scr2');
  if(event.key==='Escape'&&W_VIEW==='detail'&&screen&&screen.classList.contains('on')){
    event.preventDefault();wShowLibrary()}
});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  WI,WQ,W_SESSION_OWNER,hasActiveVocabularyPractice,initWords,launchVocabularyPractice,wChooseRecognition,wClearLibraryFilters,wDeletePersonalWord,
  wCompleteBridge,wCompleteIntroduction,wExtra,wNext,wNotKnown,wPick,wPracticeDifficult,wRateRussian,wRender,
  wRevealRussian,wSessionNext,wSetBudget,wSetLibraryFilter,wSetLibrarySearch,wShowHome,wShowKnown,
  wShowLibrary,wShowWord,wSpeakLibraryValue,wStartPractice,wSubmit,wSubmitSession,wToggleExampleTranslation,
};
