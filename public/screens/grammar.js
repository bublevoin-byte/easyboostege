/*
 * Экран «Грамматика» (scr3). Раздел 6.1 ТЗ обещает встроенные грамматические тесты без сети:
 * production service worker заранее кладёт этот lazy chunk и его каталог в install-closure,
 * поэтому первый офлайн-переход работает без того, чтобы каждая сессия разбирала весь каталог.
 * В initial graph остаются только общий Grammar domain, сводка плитки (gSync) и формат таймера,
 * который делят экзамены чтения и аудирования.
 */
import {registerRouteHook} from '../router.js';
import {registerVoiceTutorError,voiceTutorButton} from '../voice-tutor-loader.js';
import {
  S,SRV,TOKEN,apiGet,apiIsAuthorityFailure,apiPost,apiResponseOwner,currentOwnerBinding,examModule,gExamFmt,gSync,generateAiContent,grammarModule,
  invalidateLearningAuthority,registerAuthorityReset,registerScreenGenerator,save,setTxt,ui,
} from '../app.js';
import {recordCompletedLearningActivity} from '../learning-activity-recorder.js';
import {GRAMMAR_CATALOG,getGrammarCatalogRuntime,validateGeneratedGrammarSupplement} from '../grammar-catalog.js';
import {GENERATED_GRAMMAR_REVISION,GRAMMAR_ACTIVE_PRACTICE_TYPES,GRAMMAR_PRACTICE_MODES,GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,GRAMMAR_RECOMMENDATION_VERSION,isBuiltinGrammarDiagnosticId,isGrammarConfusionPair,isGrammarErrorCode,parseGrammarConfusionPair,parseGeneratedGrammarItemReference} from '../grammar-domain-contract.js';
import '../modules/exam.js';

const GRAM_Q=[
 {t:['She ','_____',' already finished her homework.'],o:['have','has','had','is'],a:1,e:'<b>She/he/it</b> — третье лицо, поэтому <b>has</b>.'},
 {t:['I ','_____',' this film before.'],o:['see','saw','have seen','seeing'],a:2,e:'Опыт без времени → <b>have seen</b>.'},
 {t:['They ','_____',' just arrived.'],o:['have','has','did','was'],a:0,e:'<b>They</b> → have; <b>just</b> → Present Perfect.'},
 {t:['','_____',' you ever been to London?'],o:['Did','Have','Was','Are'],a:1,e:'<b>ever</b> + опыт → <b>Have you ever been</b>.'},
 {t:['He ','_____',' not called yet.'],o:['did','has','have','is'],a:1,e:'<b>He</b> → has; <b>yet</b> → Present Perfect.'}
];
let gi=0,gScore=0,gAns=false;
let GQ=GRAM_Q.slice();
/* Имена остаются для совместимости со старым loader-контрактом; production использует Grammar 2.0. */
function renderG(){initGrammar()}
function pickG(){return false}
function nextG(){return false}
async function genGrammar(){
  const owner=currentOwnerBinding();if(!owner)throw new Error('Grammar owner is unavailable');const requestGeneration=++G_SCREEN_GENERATION;
  try{const expectedOwnerHeaders=gExpectedOwnerHeaders(owner),d=await generateAiContent('grammar_quiz',{},expectedOwnerHeaders);
    if(requestGeneration!==G_SCREEN_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return false;
    if(!await gConfirmOwnerResponse(owner,d))return false;if(!Array.isArray(d)||!d.length)throw 0;
    GQ=d.filter(x=>x.options&&x.options.length>=2).map(x=>({t:[x.before||'',' _____ ',x.after||''],o:x.options,a:x.answer||0,e:x.explain||''}));
    if(!GQ.length){GQ=GRAM_Q.slice();throw 0}initGrammar();return true
  }catch(error){if(requestGeneration!==G_SCREEN_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return false;
    if(apiIsAuthorityFailure(error)){await gInvalidateOwner(owner);return false}throw error}}
/* ===== GRAMMAR v2: карта тем ЕГЭ + теория + 2 уровня практики ===== */
const G_GROUPS=GRAMMAR_CATALOG.groups;
const G_TOPICS=GRAMMAR_CATALOG.topics;
const G_BANK=GRAMMAR_CATALOG.bank;
const G_CATALOG_RUNTIME=getGrammarCatalogRuntime(GRAMMAR_CATALOG.version,GRAMMAR_CATALOG.revision);
function gGeneratedItems(t){var raw=(S&&S.gramAi&&S.gramAi[t])||[],groups=new Map(),safe=[];
  raw.forEach(function(entry){var q=entry&&entry.q,reference=parseGeneratedGrammarItemReference(q&&q.voice);
    if(!reference||entry.k!==reference.kind)return;var group=groups.get(reference.groupId)||{c:[],f:[]};group[reference.kind][reference.index-1]=q;groups.set(reference.groupId,group)});
  groups.forEach(function(group){if(!group.c.length||!group.f.length||!Array.from(group.c).every(Boolean)||!Array.from(group.f).every(Boolean))return;
    try{var checked=validateGeneratedGrammarSupplement('grammar_topic_set',group);
      checked.c.forEach(function(q){safe.push({k:'c',q:q,voice:q.voice})});checked.f.forEach(function(q){safe.push({k:'f',q:q,voice:q.voice})})}catch(error){}});
  return safe}
function gAddressableItem(t,id,catalogRuntime=G_CATALOG_RUNTIME){var entry=catalogRuntime&&catalogRuntime.getItem(id),builtin=entry&&entry.topicId===t?{q:entry.item,t:entry.topicId,k:entry.kind}:null;if(builtin)return builtin;
  var generated=gGeneratedItems(t).find(function(entry){return entry.q.id===id});return generated?{q:generated.q,t:t,k:generated.q.type,source:'generated'}:null}
function gRunnerCatalogRuntime(runtime){return{catalogBank:runtime.catalog.bank,catalogTopics:runtime.catalog.topics,catalogRuntime:runtime}}
/* --- состояние: S.gram = {tid:{masteryVersion,stage,reviewStep,eligibleAt,ok,err,...}} --- */
let GS=null;
let G_TASK_TOKEN=0,G_TARGET_REQUEST_GENERATION=0,G_EXAM_GENERATION=0,G_TOPIC_GENERATION=0,G_SCREEN_GENERATION=0,G_VIEW_GENERATION=0,G_TARGET_PENDING=false;
function gSameOwner(left,right){return Boolean(left&&right&&left.username===right.username&&left.generation===right.generation)}
function gExpectedOwnerHeaders(owner){return{'X-EasyBoost-Expected-Owner':owner.username}}
function gInvalidateOwner(owner){return invalidateLearningAuthority({owner:owner.username,ownerGeneration:owner.generation})}
async function gConfirmOwnerResponse(owner,payload){if(apiResponseOwner(payload)===owner.username)return true;await gInvalidateOwner(owner);return false}
function gArea(){return document.getElementById('g_area')}
function gDock(){return document.getElementById('g_action_dock')}
function gSetPrimaryAction(label,handler,disabled=false){var dock=gDock();if(!dock)return;
  if(!label){dock.replaceChildren();dock.hidden=true;return}
  dock.hidden=false;dock.innerHTML='<button id="g_primary_action" type="button" class="aisy-button grammar-primary" aria-label="'+ui.escapeHtml(label)+'" '
    +(disabled?'disabled aria-disabled="true" ':'')+'onclick="'+handler+'">'+ui.escapeHtml(label)+'</button>'}
function gEnablePrimaryAction(enabled=true){var action=document.getElementById('g_primary_action');if(!action)return;
  action.disabled=!enabled;action.setAttribute('aria-disabled',String(!enabled))}
function gFocus(id){var target=document.getElementById(id),area=gArea();if(!target)return;
  if(area)area.scrollTop=0;target.focus({preventScroll:true});
  if(area&&typeof target.getBoundingClientRect==='function'&&typeof area.getBoundingClientRect==='function'&&typeof target.scrollIntoView==='function'){
    var targetBox=target.getBoundingClientRect(),areaBox=area.getBoundingClientRect();
    if(targetBox.top<areaBox.top||targetBox.bottom>areaBox.bottom)target.scrollIntoView({block:'nearest',inline:'nearest'})}}
function gSetHeader(title,eyebrow){G_VIEW_GENERATION+=1;setTxt('g_header_title',title||'Грамматика');var label=document.querySelector('#scr3 .grammar-route__eyebrow');if(label)label.textContent=eyebrow||'Практика · бумажный маршрут'}
function gSetProgress(label,value,summary){var percent=Math.max(0,Math.min(100,Math.round(Number(value)||0))),bar=document.getElementById('g_bar'),track=bar&&bar.parentElement;
  setTxt('g_sumline',summary);if(bar)bar.style.width=Math.max(2,percent)+'%';if(track){track.setAttribute('aria-label',label);track.setAttribute('aria-valuenow',String(percent))}}
function gVoiceRegistrationCurrent(owner,viewGeneration,session,taskToken){return Boolean(owner&&viewGeneration===G_VIEW_GENERATION&&gSameOwner(owner,currentOwnerBinding())
  &&(!session||GS===session&&GS.uiToken===taskToken&&GS.phase==='explain'))}
function gRegisterVoiceError(details,slotId,owner,viewGeneration,session=null,taskToken=null){if(!owner)return;
  registerVoiceTutorError(details,{owner:owner.username},function(){return gVoiceRegistrationCurrent(owner,viewGeneration,session,taskToken)}).then(function(recorded){if(!recorded||!gVoiceRegistrationCurrent(owner,viewGeneration,session,taskToken))return;
    var slot=document.getElementById(slotId);if(slot)slot.innerHTML=voiceTutorButton(recorded)
  }).catch(function(error){if(gVoiceRegistrationCurrent(owner,viewGeneration,session,taskToken)&&apiIsAuthorityFailure(error))return gInvalidateOwner(owner)})}
function gRenderNetworkState(){var state=document.getElementById('g_network_state');if(!state)return;
  var offline=typeof navigator!=='undefined'&&navigator.onLine===false;state.hidden=!offline;
  state.textContent=offline?'Без сети: сохранённые темы и текущий подход доступны. Новая точечная рекомендация потребует подключения.':''}
function gEvidence(activityId,startedAt=Date.now()){return{id:crypto.randomUUID(),activityId:activityId,startedAt:startedAt,reported:false,score:0,maxScore:0,sources:{},helpUsed:false}}
function gReportEvidence(evidence,metadata,durationMs){if(!evidence||evidence.reported)return;evidence.reported=true;
  recordCompletedLearningActivity({id:evidence.id,module:'grammar',activityId:evidence.activityId,
    score:evidence.score,maxScore:Math.max(1,evidence.maxScore),durationMs:Number.isFinite(durationMs)?Math.max(0,durationMs):Math.max(0,Date.now()-evidence.startedAt),metadata:metadata})
    .catch(function(){evidence.reported=false})}
function gEvidenceSource(evidence,fallback){var sources=Object.keys((evidence&&evidence.sources)||{});
  if(sources.length>1)return'mixed';if(sources[0]==='generated')return'generated';if(sources[0]==='builtin')return'builtin';return fallback||'builtin'}
function gTrackEvidenceSource(evidence,item){if(!evidence)return;var source=item&&item.source==='generated'?'generated':'builtin';evidence.sources[source]=true}
function gIsPracticeSession(){return Boolean(GS&&GS.mode!=='rev'&&GS.sessionId&&GRAMMAR_PRACTICE_MODES.includes(GS.practiceMode))}
function gMarkHelp(topic,affectsMastery=true,answerDisclosed=false){if(!GS)return;GS.helpUsed=true;var countsForMastery=answerDisclosed||(affectsMastery&&!GS.answerCommitted);
  if(affectsMastery&&!GS.answerCommitted)GS.answerAssisted=true;
  if(GS.mode==='rev'){var activityId=grammarModule.activityId(topic,'spaced_review');
    if(countsForMastery){GS.helpActivities[topic]=true;GS.helpActivities[activityId]=true}
    var evidence=GS.evidence[activityId];if(evidence)evidence.helpUsed=true}
  else if(countsForMastery)GS.masteryAssisted=true;
  if(gIsPracticeSession())gPersistRunner()}
function gRunnerSnapshot(){if(!gIsPracticeSession())return null;return{
  schema:'grammar-runner-v5',catalogVersion:GS.catalogVersion||GRAMMAR_CATALOG.version,catalogRevision:GS.catalogRevision||GRAMMAR_CATALOG.revision,sessionId:GS.sessionId,topicId:GS.t,scope:GS.scope||'topic',mode:GS.practiceMode,
  queue:GS.queue.map(function(item){return{id:item.q.id,topicId:item.t||GS.t,transfer:Boolean(item.transfer)}}),i:GS.i,ok:GS.ok,done:GS.done,
  source:GS.source,helpUsed:Boolean(GS.helpUsed),masteryAssisted:Boolean(GS.masteryAssisted),phase:GS.phase||'question',selectedChoice:Number.isInteger(GS.selectedChoice)?GS.selectedChoice:null,draftAnswer:String(GS.draftAnswer||'').slice(0,500),
  answerAssisted:Boolean(GS.answerAssisted),errorReasons:{...(GS.errorReasons||{})},confusionPairs:{...(GS.confusionPairs||{})},independentErrors:JSON.parse(JSON.stringify(GS.independentErrors||{})),types:{...(GS.types||{})},typeScores:JSON.parse(JSON.stringify(GS.typeScores||{})),
  reservedItemIds:(GS.reservedItemIds||[]).slice(0,32),itemOutcomes:JSON.parse(JSON.stringify(GS.itemOutcomes||[])),evidence:JSON.parse(JSON.stringify(GS.evidence)),recommendation:GS.recommendation?JSON.parse(JSON.stringify(GS.recommendation)):null,completionEvent:GS.completionEvent?JSON.parse(JSON.stringify(GS.completionEvent)):null,
}}
function gPersistRunner(){var snapshot=gRunnerSnapshot();if(!snapshot||!S)return;S.grammarRunner=snapshot;save()}
function gClearRunner(){if(!S||S.grammarRunner==null)return;S.grammarRunner=null;save()}
function gSafeRunnerScores(value){var result={};GRAMMAR_ACTIVE_PRACTICE_TYPES.forEach(function(type){var score=value&&value[type];
  if(!score)return;var total=Number(score.total),correct=Number(score.correct);if(Number.isInteger(total)&&Number.isInteger(correct)&&total>=0&&total<=40&&correct>=0&&correct<=total)result[type]={correct:correct,total:total}});return result}
function gSafeRunnerFlags(value){var result={};GRAMMAR_ACTIVE_PRACTICE_TYPES.forEach(function(type){if(value&&value[type]===true)result[type]=true});return result}
function gSafeRunnerErrors(value,t){var candidate=value&&value[t];return isGrammarErrorCode(candidate)?{[t]:candidate}:{}}
function gSafeRunnerPairs(value,t){var candidate=parseGrammarConfusionPair(value&&value[t]);return candidate?{[t]:candidate}:{}}
function gSafeRecommendation(value,t,catalogVersion,catalogRevision){var pointer=value&&value.pointer,itemIds=value&&value.itemIds,completionToken=value&&value.completionToken;if(!pointer||pointer.version!==GRAMMAR_RECOMMENDATION_VERSION||pointer.catalogVersion!==catalogVersion||pointer.catalogRevision!==catalogRevision||pointer.topicId!==t||!isGrammarErrorCode(pointer.errorCode)||(pointer.confusionPair!=null&&!isGrammarConfusionPair(pointer.confusionPair))||!Number.isInteger(pointer.masteryRevision)||pointer.masteryRevision<0||(pointer.eligibleAt!=null&&(!Number.isFinite(pointer.eligibleAt)||pointer.eligibleAt<0))||typeof pointer.earlyPractice!=='boolean'||!/^[0-9a-f]{64}$/u.test(pointer.stateFingerprint)||!/^[0-9a-f]{64}$/u.test(pointer.ref)||!Array.isArray(itemIds)||itemIds.length!==8||new Set(itemIds).size!==8||itemIds.some(function(id){return typeof id!=='string'||!id})||!/^[A-Za-z0-9_-]{43}$/u.test(String(completionToken||'')))return null;
  return{pointer:{version:pointer.version,catalogVersion:pointer.catalogVersion,catalogRevision:pointer.catalogRevision,topicId:pointer.topicId,errorCode:pointer.errorCode,confusionPair:pointer.confusionPair||null,masteryRevision:pointer.masteryRevision,eligibleAt:pointer.eligibleAt==null?null:pointer.eligibleAt,earlyPractice:pointer.earlyPractice,stateFingerprint:pointer.stateFingerprint,ref:pointer.ref},itemIds:itemIds.slice(),completionToken:completionToken}}
function gExactIndependentError(t,itemId,diagnosticId,reason,pair,legacy=false,catalogRuntime=G_CATALOG_RUNTIME){var found=gAddressableItem(t,itemId,catalogRuntime);if(!found||found.source==='generated'||!isGrammarErrorCode(reason))return null;
  var normalizedPair=pair==null?null:parseGrammarConfusionPair(pair);if(pair!=null&&!normalizedPair)return null;
  if(legacy){var legacyReason=['f','input'].includes(found.k)?'word_or_verb_form':'construction_choice';
    if(legacyReason!==reason||normalizedPair!==null)return null;
    return{itemId:itemId,diagnosticId:null,reason:reason,confusionPair:null}}
  var diagnostic=Array.isArray(found.q.diagnostics)?found.q.diagnostics.find(function(candidate){return candidate&&candidate.id===diagnosticId}):null;
  if(diagnostic){if(diagnostic.errorCode!==reason||(diagnostic.confusionPair||null)!==normalizedPair)return null}
  else{var expectedReason=found.q.errorSkill||(['f','input'].includes(found.k)?'word_or_verb_form':'construction_choice');
    var expectedPair=found.q.confusionPair||null;if(diagnosticId!=null||expectedReason!==reason||expectedPair!==normalizedPair)return null}
  return{itemId:itemId,diagnosticId:diagnosticId==null?null:diagnosticId,reason:reason,confusionPair:normalizedPair}}
function gSafeIndependentErrors(value,t,legacy,catalogRuntime=G_CATALOG_RUNTIME){var candidate=value&&value[t];if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return{};
  var exact=gExactIndependentError(t,String(candidate.itemId||''),candidate.diagnosticId==null?null:String(candidate.diagnosticId),String(candidate.reason||''),candidate.confusionPair==null?null:String(candidate.confusionPair),legacy,catalogRuntime);
  return exact?{[t]:exact}:{}}
function gSafeMixedIndependentErrors(value,topics,catalogRuntime=G_CATALOG_RUNTIME){var result={};if(!value||typeof value!=='object'||Array.isArray(value))return result;
  topics.forEach(function(topic){var safe=gSafeIndependentErrors(value,topic,false,catalogRuntime);if(safe[topic])result[topic]=safe[topic]});return result}
function gSafeRunnerOutcomes(value,queue,done,active,scope){if(!Array.isArray(value)||value.length!==done)return null;var outcomes=[],legacyAttempts=new Map();
  for(var index=0;index<value.length;index++){var raw=value[index],item=queue[index],type=item&&item.k==='f'?'input':item&&['c','c2'].includes(item.k)?'choice':item&&item.k;
    if(!raw||!item||raw.id!==item.q.id||raw.type!==type||typeof raw.transfer!=='boolean'||raw.transfer!==Boolean(item.transfer)||typeof raw.correct!=='boolean')return null;
    var diagnosticId=raw.diagnosticId==null?null:String(raw.diagnosticId),errorCode=raw.errorCode==null?null:String(raw.errorCode),confusionPair=raw.confusionPair==null?null:String(raw.confusionPair),transferStatus=raw.transferStatus==null?null:String(raw.transferStatus);
    if(raw.correct?(errorCode!==null||confusionPair!==null):!isGrammarErrorCode(errorCode))return null;
    if(confusionPair!==null&&!isGrammarConfusionPair(confusionPair))return null;
    var generated=item&&item.source==='generated',revision=raw.revision==null?null:Number(raw.revision),provenance=raw.source==null?null:String(raw.source);
    if(generated?(revision!==GENERATED_GRAMMAR_REVISION||provenance!=='generated'):(revision!==null||provenance!==null))return null;
    if(transferStatus!==null&&(transferStatus!=='due_next_session'||raw.correct||(active&&!raw.transfer)))return null;
    if(diagnosticId!==null&&!isBuiltinGrammarDiagnosticId(diagnosticId))return null;
    if(active?((type==='choice'&&!raw.correct&&diagnosticId===null)||((type!=='choice'||raw.correct)&&diagnosticId!==null))
      :(diagnosticId!==null||raw.transfer||confusionPair!==null))return null;
    if(!active){var attempt=(legacyAttempts.get(raw.id)||0)+1;legacyAttempts.set(raw.id,attempt);
      if(attempt>2||(attempt===1&&transferStatus!==null)||(attempt===2&&((raw.correct&&transferStatus!==null)||(!raw.correct&&transferStatus!=='due_next_session'))))return null}
    var topicId=Number(raw.topicId);if(scope==='mixed'&&topicId!==item.t||scope!=='mixed'&&raw.topicId!=null)return null;
    outcomes.push({id:raw.id,...(scope==='mixed'?{topicId:topicId}:{}),type:type,transfer:raw.transfer,correct:raw.correct,diagnosticId:diagnosticId,errorCode:errorCode,confusionPair:confusionPair,transferStatus:transferStatus,
      ...(generated?{source:'generated',revision:GENERATED_GRAMMAR_REVISION}:{})})}
  return outcomes}
function gSafeRunnerEvidence(value,t,mode,source){var activityId=grammarModule.activityId(t,mode),id=String(value&&value.id||''),startedAt=Number(value&&value.startedAt);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))return gEvidence(activityId);
  var sources=source==='mixed'?{builtin:true,generated:true}:source==='generated'?{generated:true}:{builtin:true};
  return{id:id,activityId:activityId,startedAt:Number.isFinite(startedAt)&&startedAt>=0?startedAt:Date.now(),reported:false,score:0,maxScore:0,sources:sources,helpUsed:Boolean(value&&value.helpUsed)}}
function gSafeCompletionEvent(value,state){if(!value||typeof value!=='object'||Array.isArray(value))return null;var allowed=['type','id','assisted','source','completedTypes','typeScores','session','independentError','independentErrors','expectedRevision','expectedStage','expectedReviewStep'];
  if(Object.keys(value).some(function(key){return!allowed.includes(key)}))return null;
  var completedTypes=Object.keys(state.types||{}),session=value.session,expectedItems=state.itemOutcomes,expectedMixedErrors=gMixedIndependentErrorList(state),expectedTopics=gMixedTopicIds(state),expectations=session&&session.topicExpectations;
  if(value.type!=='session_completed'||value.id!==state.sessionId||value.source!==state.source||value.assisted!==state.masteryAssisted
    ||!Array.isArray(value.completedTypes)||JSON.stringify([...value.completedTypes].sort())!==JSON.stringify([...completedTypes].sort())
    ||GRAMMAR_ACTIVE_PRACTICE_TYPES.some(function(type){return JSON.stringify(value.typeScores&&value.typeScores[type]||null)!==JSON.stringify(state.typeScores&&state.typeScores[type]||null)})||!session||session.id!==state.sessionId||session.scope!==state.scope||session.mode!==state.practiceMode||session.source!==state.source
    ||!session.catalog||session.catalog.version!==state.catalogVersion||session.catalog.revision!==state.catalogRevision
    ||JSON.stringify(session.items)!==JSON.stringify(expectedItems)||session.startedAt!==state.evidence.startedAt||session.assisted!==state.masteryAssisted
    ||JSON.stringify(value.independentError||null)!==JSON.stringify(state.scope==='mixed'?null:state.independentErrors[state.t]||null)
    ||JSON.stringify(value.independentErrors||null)!==JSON.stringify(state.scope==='mixed'&&expectedMixedErrors.length?expectedMixedErrors:null)
    ||JSON.stringify(session.recommendation||null)!==JSON.stringify(state.practiceMode==='targeted_practice'?state.recommendation:null)
    ||(state.scope==='mixed'&&(!Array.isArray(expectations)||expectations.length!==expectedTopics.length||expectations.some(function(item,index){return!item||item.topicId!==expectedTopics[index]||!Number.isSafeInteger(item.expectedRevision)||!['not_started','learning','learned','confirmed','stable'].includes(item.expectedStage)||!Number.isInteger(item.expectedReviewStep)||item.expectedReviewStep<0||item.expectedReviewStep>5})||!expectations.some(function(item){return item.topicId===state.t&&item.expectedRevision===value.expectedRevision&&item.expectedStage===value.expectedStage&&item.expectedReviewStep===value.expectedReviewStep})))
    ||(state.scope!=='mixed'&&session.topicExpectations!=null)
    ||!Number.isSafeInteger(value.expectedRevision)||!['not_started','learning','learned','confirmed','stable'].includes(value.expectedStage)||!Number.isInteger(value.expectedReviewStep)||value.expectedReviewStep<0||value.expectedReviewStep>5)return null;
  return JSON.parse(JSON.stringify(value))}
function gSelectedQueueHasExactTransfers(queue){return queue.every(function(item,index){if(!item.transfer)return true;var original=queue[index-1];return Boolean(original&&!original.transfer&&original.t===item.t&&original.k===item.k&&original.q.transferPair===item.q.transferPair)})}
function gRestoreRunner(){var snapshot=S&&S.grammarRunner;if(!snapshot||!['grammar-runner-v4','grammar-runner-v5'].includes(snapshot.schema))return null;
  var t=Number(snapshot.topicId),queueRaw=Array.isArray(snapshot.queue)?snapshot.queue:[];
  var sessionId=String(snapshot.sessionId||''),ok=Number(snapshot.ok),done=Number(snapshot.done),practiceMode=String(snapshot.mode||'');
  var completionPending=snapshot.phase==='completion_pending';
  var scope=practiceMode==='mixed_practice'?'mixed':'topic',active=practiceMode!=='legacy_practice'&&GRAMMAR_PRACTICE_MODES.includes(practiceMode),source=String(snapshot.source||'');
  var resolvedRuntime=getGrammarCatalogRuntime(snapshot.catalogVersion,snapshot.catalogRevision);if(!resolvedRuntime)return null;
  var currentCatalog=resolvedRuntime===G_CATALOG_RUNTIME,catalogLevels=resolvedRuntime.catalog.bank[t];
  var catalogHasActivePractice=grammarModule.hasActivePractice(catalogLevels),currentHasActivePractice=grammarModule.hasActivePractice(G_BANK[t]);
  var activatedLegacy=!active&&!catalogHasActivePractice&&currentHasActivePractice&&!currentCatalog&&GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.includes(t);
  if(!GRAMMAR_PRACTICE_MODES.includes(practiceMode)||(snapshot.scope!=null&&snapshot.scope!==scope)||active&&!catalogHasActivePractice||!active&&currentHasActivePractice&&!activatedLegacy
    ||!['builtin','mixed','generated'].includes(source)||(source!=='builtin'&&!snapshot.masteryAssisted)
    ||!G_TOPICS[t]||queueRaw.length<1||queueRaw.length>(active?32:16)||!Number.isInteger(snapshot.i)||snapshot.i<0||snapshot.i>queueRaw.length||(!completionPending&&snapshot.i>=queueRaw.length)||(completionPending&&snapshot.i!==queueRaw.length)
    ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)
    ||!Number.isInteger(ok)||!Number.isInteger(done)||ok<0||done<0||ok>done||done>32)return null;
  var seen=new Set(),queue=[];
  for(var raw of queueRaw){var itemTopic=scope==='mixed'?Number(raw&&raw.topicId):t,found=gAddressableItem(itemTopic,raw&&raw.id,resolvedRuntime);if(!found||(active&&seen.has(raw.id))||(activatedLegacy&&found.source!=='generated'&&!resolvedRuntime.hasLegacyItem(found.q.id)))return null;seen.add(raw.id);
    if(!active&&raw.transfer)return null;queue.push({k:found.k,q:found.q,t:itemTopic,voice:found.q.voice||null,source:found.source||'builtin',transfer:Boolean(raw.transfer)})}
  if(scope==='mixed'){var mixedOriginals=queue.filter(function(item){return!item.transfer}),mixedTypes=Object.fromEntries(GRAMMAR_ACTIVE_PRACTICE_TYPES.map(function(type){return[type,mixedOriginals.filter(function(item){return item.k===type}).length]})),mixedTopics=new Map();
    mixedOriginals.forEach(function(item){mixedTopics.set(item.t,(mixedTopics.get(item.t)||0)+1)});if(mixedOriginals.length!==16||Object.values(mixedTypes).some(function(count){return count!==4})||mixedTopics.size<8||Math.max(...mixedTopics.values())>2||source!=='builtin'||!gSelectedQueueHasExactTransfers(queue))return null}
  var recommendation=practiceMode==='targeted_practice'?gSafeRecommendation(snapshot.recommendation,t,snapshot.catalogVersion,snapshot.catalogRevision):null;
  if(practiceMode==='targeted_practice'){var expectedTargeted=recommendation&&grammarModule.buildTargetedPracticeQueue(resolvedRuntime.catalog.bank,recommendation.pointer,{seed:recommendation.pointer.ref}),targetedOriginals=queue.filter(function(item){return!item.transfer});
    if(!recommendation||targetedOriginals.length!==8||source!=='builtin'||queue.some(function(item){return item.t!==t})||JSON.stringify(targetedOriginals.map(function(item){return item.q.id}))!==JSON.stringify(expectedTargeted.map(function(item){return item.q.id}))||JSON.stringify(recommendation.itemIds)!==JSON.stringify(targetedOriginals.map(function(item){return item.q.id}))||!gSelectedQueueHasExactTransfers(queue))return null}
  if(grammarModule.queueSource(queue)!==source)return null;
  var evidence=gSafeRunnerEvidence(snapshot.evidence,t,practiceMode,source);
  var itemOutcomes=gSafeRunnerOutcomes(snapshot.itemOutcomes,queue,done,active,scope);if(!itemOutcomes)return null;
  var restored={activeRunner:active,practiceMode:practiceMode,scope:scope,catalogVersion:snapshot.catalogVersion,catalogRevision:snapshot.catalogRevision,...gRunnerCatalogRuntime(resolvedRuntime),sessionId:sessionId,t:t,queue:queue,i:snapshot.i,ok:ok,done:done,
    source:source,helpUsed:Boolean(snapshot.helpUsed),masteryAssisted:Boolean(snapshot.masteryAssisted),answerCommitted:false,answerAssisted:Boolean(snapshot.answerAssisted),selectedChoice:Number.isInteger(snapshot.selectedChoice)?snapshot.selectedChoice:null,draftAnswer:String(snapshot.draftAnswer||'').slice(0,500),
    phase:completionPending?'completion_pending':snapshot.phase==='explain'?'explain':snapshot.phase==='selected'?'selected':snapshot.phase==='advance'?'advance':'question',errorReasons:scope==='mixed'?{}:gSafeRunnerErrors(snapshot.errorReasons,t),confusionPairs:scope==='mixed'?{}:gSafeRunnerPairs(snapshot.confusionPairs,t),independentErrors:scope==='mixed'?gSafeMixedIndependentErrors(snapshot.independentErrors,[...new Set(queue.map(function(item){return item.t}))],resolvedRuntime):gSafeIndependentErrors(snapshot.independentErrors,t,!active,resolvedRuntime),types:gSafeRunnerFlags(snapshot.types),
    typeScores:gSafeRunnerScores(snapshot.typeScores),reservedItemIds:active?[...seen]:Array.isArray(snapshot.reservedItemIds)?snapshot.reservedItemIds.filter(function(id){return Boolean(gAddressableItem(t,id,resolvedRuntime))}).slice(0,32):[...seen],itemOutcomes:itemOutcomes,evidence:evidence,recommendation:recommendation};
  if(restored.phase==='advance'){restored.i++;restored.phase='question'}
  if(restored.phase==='completion_pending'){restored.completionEvent=gSafeCompletionEvent(snapshot.completionEvent,restored);if(!restored.completionEvent)return null}
  return restored}
function gRec(t){S.grammarMastery=S.grammarMastery||{};return S.grammarMastery[t]||(S.grammarMastery[t]=grammarModule.migrateMasteryRecord())}
function gSetRec(t,record){S.grammarMastery=S.grammarMastery||{};S.grammarMastery[t]=record;return record}
function gMasteryExpectation(record){return{expectedRevision:record.masteryRevision,expectedStage:record.stage,expectedReviewStep:record.reviewStep}}
function gMixedTopicIds(session){return[...new Set((session.itemOutcomes||[]).filter(function(item){return!item.transfer}).map(function(item){return Number(item.topicId)}).filter(Number.isInteger))]}
function gMixedIndependentErrorList(session){return gMixedTopicIds(session).flatMap(function(topic){var error=session.independentErrors&&session.independentErrors[topic];return error?[{topicId:topic,...error}]:[]})}
function gMasteryOutcomes(result){return result&&Array.isArray(result.results)?result.results:[result]}
function gMasteryDurable(result,event,topicId){
  var syncedRecord=S&&S.grammarMastery&&S.grammarMastery[topicId];
  return grammarModule.completionEventIsDurable({record:syncedRecord,event:event,result:result})
}
function gMasteryProvisional(result){return result===false||Boolean(result&&result.queued===true)}
function gMasteryUnsaved(result){return Boolean(result&&result.queued===false)||gMasteryOutcomes(result).some(function(item){return Boolean(item&&item.conflict)})}
function gMasteryPersistenceLine(result){
  if(gMasteryProvisional(result))return'Сохранено на устройстве, статус обновится после синхронизации';
  if(!gMasteryUnsaved(result))return'';
  if(result&&result.code==='GRAMMAR_MASTERY_QUEUE_FULL')return'Подключитесь для синхронизации: результат не записан';
  if(result&&result.code==='GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE')return'Безопасное сохранение недоступно: повторите подход в поддерживаемом браузере';
  if(result&&result.code==='GRAMMAR_MASTERY_QUEUE_WRITE_FAILED')return'Не удалось безопасно сохранить результат: освободите место и повторите подход';
  if(result&&result.code==='GRAMMAR_MASTERY_OWNER_CHANGED')return'Аккаунт изменился: войдите снова и повторите синхронизацию';
  if(result&&result.code==='GRAMMAR_MASTERY_OWNER_DELETED')return'Аккаунт удалён: результат нельзя сохранить';
  return'Результат не записан: прогресс изменился, обновите раздел и повторите подход'
}
async function gSubmitMasteryEvent(topicId,event){
  if(!window.EasyBoostSync||typeof window.EasyBoostSync.saveGrammarMasteryEvent!=='function')return false;
  var response=await window.EasyBoostSync.saveGrammarMasteryEvent(topicId,event);
  if(response&&Array.isArray(response.results))response.results.forEach(function(item){if(Number.isInteger(item&&item.topicId)&&item.record)gSetRec(item.topicId,item.record)});
  var result=response&&Array.isArray(response.results)?response.results.find(function(item){return item&&item.eventId===event.id}):response;
  if(result&&result.record)gSetRec(topicId,result.record);
  return event&&event.session&&['mixed_practice','exam_19_24'].includes(event.session.mode)&&response?response:result
}
async function gSubmitMasteryBatch(entries){
  if(!window.EasyBoostSync||typeof window.EasyBoostSync.saveGrammarMasteryEvents!=='function'){
    if(entries.length!==1)return false;
    var single=await gSubmitMasteryEvent(entries[0].topicId,entries[0].event);return single&&single.eventId?{results:[single]}:single
  }
  var result=await window.EasyBoostSync.saveGrammarMasteryEvents(entries);
  if(result&&Array.isArray(result.results)){var byId=new Map(result.results.map(function(item){return[item&&item.eventId,item]}));
    entries.forEach(function(entry){var item=byId.get(entry.event.id);if(item&&item.record)gSetRec(entry.topicId,item.record)})}
  return result
}
function gAnim(){var card=document.getElementById('g_card');if(!card||!card.classList)return;
  card.classList.add('aisy-paper-transition');card.classList.remove('grammar-paper-enter');requestAnimationFrame(function(){card.classList.add('grammar-paper-enter')})}
function gStatusChip(record){var view=grammarModule.masteryView(record);
  var state=view.due?'due':view.stage,label=view.due?view.nextLabel:view.stage==='stable'?'Устойчиво':view.stage==='confirmed'?'Подтверждено':view.stage==='learned'?'Изучено':view.stage==='learning'?'Изучается':'Не начата';
  return '<span class="grammar-status" data-state="'+state+'">'+ui.escapeHtml(label)+'</span>'}
function gDateLine(view){if(view.due)return view.nextLabel;
  if(view.eligibleAt!=null)return 'следующая проверка '+new Date(view.eligibleAt).toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
  return view.nextLabel}
function gRegressionLine(view){if(!view.regressionReason)return'';
  return '<p class="grammar-regression">Снова в работе: '+ui.escapeHtml(grammarModule.regressionReasonLabel(view.regressionReason))+'</p>'}
function gMasteryQueueAvailable(required){return !window.EasyBoostSync||typeof window.EasyBoostSync.canQueueGrammarMasteryEvent!=='function'||window.EasyBoostSync.canQueueGrammarMasteryEvent(required||1)}
function gShowMasteryQueueFull(){var area=document.getElementById('g_area');if(!area)return;
  gSetHeader('Нужна синхронизация','Грамматика · состояние');area.innerHTML='<section class="grammar-view"><div class="grammar-paper grammar-state" role="alert"><span class="grammar-state__glyph" aria-hidden="true">!</span><h2 class="grammar-title">Подключитесь для синхронизации</h2><p class="grammar-copy">Очередь результатов заполнена. После синхронизации можно продолжить тренировку.</p></div></section>';gSetPrimaryAction('К темам','gMap()')}
function initGrammar(){if(!S)return;gRenderNetworkState();gSync();GS=gRestoreRunner();if(GS){gResume();return}if(gRestoreExamRunner())return;if(S.grammarRunner){delete S.grammarRunner;save()}gMap()}
/* Обработчик разметки не может присвоить переменную модуля, поэтому сброс темы — функция. */
function gToThemes(){var preservePending=Boolean(GS&&GS.phase==='completion_pending'&&S&&S.grammarRunner);GS=null;if(!preservePending)gClearRunner();gMap()}
function gRetryPendingCompletion(){var snapshot=S&&S.grammarRunner;if(!snapshot||snapshot.phase!=='completion_pending')return false;
  var pending=gRestoreRunner();if(!pending){gRenderCompletionPending();return true}GS=pending;gResume();return true}
function gMap(){var area=gArea();if(!area)return;
  gSetHeader('Грамматика','Практика · 20 тем');gRenderNetworkState();
  var due=gDue(),dashboard=examModule.grammarDashboard(S.grammarMastery||{},{now:Date.now()});
  var secured=(dashboard.stageCounts.confirmed||0)+(dashboard.stageCounts.stable||0);
  var weakLabels=dashboard.weakErrorTypes.slice(0,3).map(function(item){return grammarModule.regressionReasonLabel(item.errorCode)});
  var recommendation=due.length
    ?{title:'Пора повторить',reason:due.length+' '+(due.length===1?'тема ждёт':due.length<5?'темы ждут':'тем ждут')+' проверки памяти',label:'Начать повторение',handler:'gReview()'}
    :weakLabels.length
      ?{title:'Точечная практика',reason:'Актуальный фокус: '+weakLabels[0],label:'Подобрать задания',handler:'gStartTargeted()'}
      :{title:'Смешанная практика',reason:'16 заданий по разным темам без подсказки раздела',label:'Начать практику',handler:'gStartMixed()'};
  var h='<div class="grammar-view">'
    +'<section class="grammar-paper grammar-paper--hero grammar-recommendation" aria-labelledby="g_catalog_title">'
    +'<p class="grammar-kicker">Рекомендация на сейчас</p><h2 id="g_catalog_title" class="grammar-title" tabindex="-1">'+ui.escapeHtml(recommendation.title)+'</h2>'
    +'<p class="grammar-copy">'+ui.escapeHtml(recommendation.reason)+'</p><div class="grammar-recommendation__meta">'
    +'<span class="grammar-data-pill">≈ 10–15 минут</span><span class="grammar-data-pill">Следующий шаг</span></div></section>'
    +'<section data-grammar-dashboard role="status" class="grammar-paper grammar-dashboard" aria-label="Сводка освоения грамматики">'
    +'<p class="grammar-kicker">Ваш маршрут</p><h2 class="grammar-title">Grammar 2.0 · 20 тем</h2>'
    +'<p class="grammar-copy">Подтверждено или устойчиво: '+secured+' · На повторение: '+dashboard.dueTopicIds.length+'</p>'
    +'<div class="grammar-dashboard__metrics"><span class="grammar-data-pill">Устойчиво: '+dashboard.stageCounts.stable+'</span>'
    +'<span class="grammar-data-pill">Слабые места: '+ui.escapeHtml(weakLabels.length?weakLabels.join(' · '):'пока не выявлены')+'</span></div></section>'
    +'<section aria-labelledby="g_routes_title"><h2 id="g_routes_title" class="grammar-section-title">Режимы практики</h2><div class="grammar-route-list">'
    +'<button type="button" class="aisy-choice grammar-route-card" onclick="gExam()"><strong>Экзамен · задания 19–24</strong><small>'+((S.exam19||{}).n?'Лучший результат: '+S.exam19.best+' из 6':'Текст с пропусками, без подсказок')+'</small></button>'
    +(due.length?'<button type="button" class="aisy-choice grammar-route-card" onclick="gReview()"><strong>Повторение по сроку</strong><small>'+due.length+' тем ждут проверки памяти</small></button>':'')
    +'<button type="button" class="aisy-choice grammar-route-card" onclick="gStartMixed()"><strong>Смешанная практика</strong><small>Все четыре типа задания · 16 вопросов</small></button>'
    +'<button type="button" class="aisy-choice grammar-route-card" onclick="gStartTargeted()"><strong>Точечная практика</strong><small>8 заданий по актуальной слабости</small></button></div></section>';
  G_GROUPS.forEach(function(group){
    h+='<section aria-labelledby="g_group_'+group.ids[0]+'"><h2 id="g_group_'+group.ids[0]+'" class="grammar-section-title">'+ui.escapeHtml(group.n)+'</h2><div class="grammar-topic-list">';
    group.ids.forEach(function(t){var record=gRec(t),topic=G_TOPICS[t],view=grammarModule.masteryView(record);
      var pct=view.stage==='learning'?Math.max(view.progress,Math.min(39,Math.round(record.stats.advancedStreak/4*40))):view.progress;
      var stats=record.stats.correct+record.stats.errors>0?'Верно '+record.stats.correct+' · ошибок '+record.stats.errors+' · ':'';
      h+='<button type="button" class="aisy-choice grammar-topic" onclick="gOpen('+t+')" aria-label="'+ui.escapeHtml(topic.n)+'. '+ui.escapeHtml(gDateLine(view))+'. Освоено '+pct+' процентов">'
        +'<span class="grammar-topic__head"><strong>'+ui.escapeHtml(topic.n)+'</strong>'+gStatusChip(record)+'</span>'
        +'<span class="grammar-topic__progress" role="progressbar" aria-label="Освоение темы '+ui.escapeHtml(topic.n)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><span style="--grammar-progress:'+pct+'%"></span></span>'
        +'<small class="grammar-topic__stats">'+stats+ui.escapeHtml(gDateLine(view))+'</small>'+gRegressionLine(view)+'</button>'});
    h+='</div></section>'});
  area.innerHTML=h+'</div>';setTxt('g_today','20 тем'+(due.length?' · '+due.length+' на повторение':''));
  gSetProgress('Устойчиво освоенные темы',Math.round((dashboard.stageCounts.stable||0)/20*100),'Устойчиво освоено '+dashboard.stageCounts.stable+' из 20 тем');
  gSetPrimaryAction(recommendation.label,recommendation.handler);gFocus('g_catalog_title')}
function gOpen(t){gTheory(t,true)}
function gTheory(t,fromMap){var area=gArea();if(!area)return;if(!fromMap)gMarkHelp(t);var topic=(GS&&GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t];
  gSetHeader(topic.n,'Грамматика · правило');
  area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-paper--hero" aria-labelledby="g_theory_title">'
    +'<div class="grammar-task-head"><p class="grammar-label">Правило</p>'+gStatusChip(gRec(t))+'</div>'
    +'<h2 id="g_theory_title" class="grammar-title" tabindex="-1">'+ui.escapeHtml(topic.n)+'</h2>'
    +'<p class="grammar-copy">'+topic.th+'</p></section>'
    +'<button type="button" class="aisy-button aisy-button--secondary grammar-secondary" onclick="gMap()">К каталогу тем</button></div>';
  gSetPrimaryAction(fromMap?'Начать практику':'Продолжить практику',fromMap?'gStart('+t+')':'gResume()');gFocus('g_theory_title');gAnim('win','.32s')}
function gShuffle(a){return grammarModule.shuffled(a)}
function gBankEff(t){var b=G_BANK[t]||{};var ai=gGeneratedItems(t);
  return grammarModule.effectiveBank(b,ai)}
function gLvl2(t){return grammarModule.levelTwo(gBankEff(t),t)}
function gDue(){return grammarModule.dueTopics(S.grammarMastery)}
function gStart(t){if(gRetryPendingCompletion())return;if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}var e=gBankEff(t),r=gRec(t);
  var active=grammarModule.hasActivePractice(G_BANK[t]),sessionId=crypto.randomUUID();
  var queue=active?grammarModule.buildActiveTopicQueue(G_BANK[t],t,GRAMMAR_CATALOG.version+':'+t+':'+sessionId):grammarModule.buildTopicQueue(e,t,r);
  var practiceMode=active?'topic_practice':'legacy_practice',queueSource=grammarModule.queueSource(queue);
  GS={activeRunner:active,practiceMode:practiceMode,catalogVersion:GRAMMAR_CATALOG.version,catalogRevision:GRAMMAR_CATALOG.revision,...gRunnerCatalogRuntime(G_CATALOG_RUNTIME),sessionId:sessionId,t:t,queue:queue,i:0,ok:0,done:0,source:queueSource,helpUsed:false,masteryAssisted:queueSource!=='builtin',answerCommitted:false,answerAssisted:false,phase:'question',reservedItemIds:queue.map(function(item){return item.q.id}),itemOutcomes:[],errorReasons:{},confusionPairs:{},independentErrors:{},types:{},typeScores:{},evidence:gEvidence(grammarModule.activityId(t,practiceMode))};
  gPersistRunner();gRenderQ();gGen(t)}
function gStartMixed(){if(gRetryPendingCompletion())return;if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}var sessionId=crypto.randomUUID();
  var queue=grammarModule.buildMixedPracticeQueue(G_BANK,S.grammarMastery||{},{seed:GRAMMAR_CATALOG.version+':mixed:'+sessionId,now:Date.now()});if(queue.length!==16){gMap();return}
  var t=queue[0].t;GS={activeRunner:true,practiceMode:'mixed_practice',scope:'mixed',catalogVersion:GRAMMAR_CATALOG.version,catalogRevision:GRAMMAR_CATALOG.revision,...gRunnerCatalogRuntime(G_CATALOG_RUNTIME),sessionId:sessionId,t:t,queue:queue,i:0,ok:0,done:0,source:'builtin',helpUsed:false,masteryAssisted:false,answerCommitted:false,answerAssisted:false,phase:'question',reservedItemIds:queue.map(function(item){return item.q.id}),itemOutcomes:[],errorReasons:{},confusionPairs:{},independentErrors:{},types:{},typeScores:{},evidence:gEvidence(grammarModule.activityId(t,'mixed_practice'))};
  gPersistRunner();gRenderQ()}
function gTargetedUnavailable(){var area=gArea();if(!area)return;var offline=typeof navigator!=='undefined'&&navigator.onLine===false;
  gSetHeader('Точечная практика','Грамматика · рекомендация');
  area.innerHTML='<div class="grammar-view"><section class="grammar-paper grammar-state" role="alert"><span class="grammar-state__glyph" aria-hidden="true">!</span>'
    +'<h2 id="g_targeted_error_title" class="grammar-title" tabindex="-1">'+(offline?'Для точечного подхода нужна сеть':'Рекомендацию не удалось подтвердить')+'</h2>'
    +'<p class="grammar-copy">'+(offline?'Подключитесь к сети и повторите. Каталог и сохранённые подходы доступны без подключения.':'Повторите запрос. Мы не начнём подход, пока сервер не подтвердит владельца и актуальную рекомендацию.')+'</p></section></div>';
  gSetPrimaryAction('Повторить','gStartTargeted()');gFocus('g_targeted_error_title')}
async function gStartTargeted(){if(G_TARGET_PENDING||gRetryPendingCompletion())return;if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}
  var owner=currentOwnerBinding(),area=gArea();if(!owner||typeof navigator!=='undefined'&&navigator.onLine===false){gTargetedUnavailable();return}
  G_TARGET_PENDING=true;var requestGeneration=++G_TARGET_REQUEST_GENERATION;
  gSetHeader('Подбираем задания','Грамматика · рекомендация');
  if(area)area.innerHTML='<div class="grammar-view"><section class="grammar-paper grammar-state" role="status" aria-live="polite"><span class="ebstate-spin" aria-hidden="true"></span><h2 class="grammar-title">Собираем точечный подход…</h2><p class="grammar-copy">Проверяем актуальную слабость и восемь подходящих заданий.</p></section></div>';
  gSetPrimaryAction(null);
  var expectedOwnerHeaders=gExpectedOwnerHeaders(owner);
  try{var issued=await apiGet('/api/v1/grammar/recommendation',{headers:expectedOwnerHeaders});
    if(requestGeneration!==G_TARGET_REQUEST_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
    if(!await gConfirmOwnerResponse(owner,issued))return;
    var recommendation=issued&&issued.recommendation;
    var resolved=await apiPost('/api/v1/grammar/recommendation/resolve',{pointer:recommendation&&recommendation.pointer},expectedOwnerHeaders),pointer=resolved&&resolved.recommendation&&resolved.recommendation.pointer;
    if(requestGeneration!==G_TARGET_REQUEST_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
    if(!await gConfirmOwnerResponse(owner,resolved))return;
    if(!pointer||JSON.stringify(pointer)!==JSON.stringify(recommendation.pointer)||!resolved.catalog||resolved.catalog.version!==GRAMMAR_CATALOG.version||resolved.catalog.revision!==GRAMMAR_CATALOG.revision||!/^[A-Za-z0-9_-]{43}$/u.test(String(resolved.completionToken||'')))throw new Error('GRAMMAR_RECOMMENDATION_INVALID');
    var expected=grammarModule.buildTargetedPracticeQueue(G_BANK,pointer,{seed:pointer.ref}),ids=Array.isArray(resolved.itemIds)?resolved.itemIds:[];
    if(expected.length!==8||JSON.stringify(expected.map(function(item){return item.q.id}))!==JSON.stringify(ids))throw new Error('GRAMMAR_RECOMMENDATION_INVALID');
    var sessionId=crypto.randomUUID(),t=pointer.topicId;GS={activeRunner:true,practiceMode:'targeted_practice',scope:'topic',catalogVersion:GRAMMAR_CATALOG.version,catalogRevision:GRAMMAR_CATALOG.revision,...gRunnerCatalogRuntime(G_CATALOG_RUNTIME),sessionId:sessionId,t:t,queue:expected,i:0,ok:0,done:0,source:'builtin',helpUsed:false,masteryAssisted:false,answerCommitted:false,answerAssisted:false,phase:'question',selectedChoice:null,draftAnswer:'',reservedItemIds:ids.slice(),itemOutcomes:[],errorReasons:{},confusionPairs:{},independentErrors:{},types:{},typeScores:{},recommendation:{pointer:pointer,itemIds:ids.slice(),completionToken:resolved.completionToken},evidence:gEvidence(grammarModule.activityId(t,'targeted_practice'))};
    gPersistRunner();gRenderQ()}catch(error){if(requestGeneration!==G_TARGET_REQUEST_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
    if(apiIsAuthorityFailure(error)){await gInvalidateOwner(owner);return}gTargetedUnavailable()}
  finally{if(requestGeneration===G_TARGET_REQUEST_GENERATION)G_TARGET_PENDING=false}}
function gResume(){if(!GS){gMap();return}if(GS.phase==='completion_pending'){gRenderCompletionPending();gFinish();return}if(GS.phase==='explain'){gExplain(GS.queue[GS.i],null,true);return}gRenderQ(true)}
function gReview(){if(gRetryPendingCompletion())return;var due=gDue();if(!due.length){gMap();return}if(!gMasteryQueueAvailable(due.length)){gShowMasteryQueueFull();return}
  var items=[];
  due.forEach(function(t){items=items.concat(gShuffle(gLvl2(t)).slice(0,2))});
  var queue=gShuffle(items);
  GS={mode:'rev',revT:due.slice(),queue:queue,i:0,ok:0,done:0,errT:{},startedAt:Date.now(),source:grammarModule.queueSource(queue),helpUsed:false,answerCommitted:false,answerAssisted:false,errorReasons:{},independentErrors:{},helpActivities:{},evidence:{}};
  gRenderQ()}
function gProgressLine(){if(!GS)return;var total=Math.max(1,GS.queue.length),current=Math.min(total,GS.done+1),percent=Math.round(GS.done/total*100);
  setTxt('g_today',current+' / '+total+' в подходе');gSetProgress('Завершено заданий в подходе',percent,'Завершено '+GS.done+' из '+total+' заданий')}
function gTaskCurrent(token){return Boolean(GS&&GS.uiToken===Number(token)&&GS.queue[GS.i])}
function gRenderQ(preserveAnswerState){var area=gArea();if(!area||!GS)return;gProgressLine();
  var it=GS.queue[GS.i];if(!it){gFinish();return}
  GS.answerCommitted=false;if(!preserveAnswerState){GS.answerAssisted=false;GS.selectedChoice=null;GS.draftAnswer=''}
  var isChoice=['c','c2','choice'].includes(it.k);
  if(!isChoice)GS.selectedChoice=null;
  if(!Number.isInteger(GS.selectedChoice)||!isChoice||GS.selectedChoice<0||GS.selectedChoice>=it.q.o.length)GS.selectedChoice=null;
  GS.phase=Number.isInteger(GS.selectedChoice)?'selected':'question';GS.uiToken=++G_TASK_TOKEN;if(gIsPracticeSession())gPersistRunner();
  var token=GS.uiToken,t=it.t||GS.t,topic=(GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t],mixed=GS.scope==='mixed',hiddenTopic=mixed||GS.practiceMode==='targeted_practice';
  var labels={choice:'УРОВЕНЬ 1 · ВЫБОР',input:'УРОВЕНЬ 2 · ВВОД',correction:'УРОВЕНЬ 3 · ИСПРАВЛЕНИЕ',transform:'УРОВЕНЬ 4 · ПРЕОБРАЗОВАНИЕ'};
  var level=it.transfer?'ТРАНСФЕР · '+(labels[it.k]||'НОВОЕ ЗАДАНИЕ'):(labels[it.k]||(it.k==='c'?'УРОВЕНЬ 1 · ВЫБОР':'УРОВЕНЬ 2 · КАК НА ЕГЭ'));
  gSetHeader('Задание '+Math.min(GS.done+1,GS.queue.length)+' из '+GS.queue.length,mixed?'Грамматика · смешанный подход':GS.practiceMode==='targeted_practice'?'Грамматика · точечный подход':'Грамматика · '+topic.n);
  var head='<div class="grammar-task-head"><p class="grammar-label" data-grammar-level="'+ui.escapeHtml(it.k)+'">'+ui.escapeHtml(GS.mode==='rev'?'Повторение':level)+'</p>'
    +(hiddenTopic?'':'<button id="g_rule_btn" type="button" class="aisy-button aisy-button--secondary grammar-rule-button" onclick="gTheory('+t+')">Правило</button>')+'</div>';
  var context=mixed?'Смешанная практика · определи правило сам':GS.practiceMode==='targeted_practice'?'Точечная практика · определи правило сам':topic.n;
  if(isChoice){var question=it.q;
    area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-paper--hero" aria-labelledby="g_task_title">'+head
      +'<p class="grammar-copy">'+ui.escapeHtml(context)+'</p><h2 id="g_task_title" class="grammar-title grammar-title--task" tabindex="-1">'
      +ui.escapeHtml(question.t[0])+'<span class="grammar-gap">&nbsp;?&nbsp;</span>'+ui.escapeHtml(question.t[1])+'</h2></section>'
      +'<div id="g_btns" class="grammar-choice-list" role="radiogroup" aria-labelledby="g_task_title">'
      +question.o.map(function(option,index){var selected=index===GS.selectedChoice;return '<button id="g_choice_'+index+'" type="button" class="aisy-choice grammar-choice" role="radio" aria-checked="'+selected+'" tabindex="'+(selected||GS.selectedChoice==null&&index===0?'0':'-1')+'" onclick="gSelectChoice(this,'+index+','+token+')" onkeydown="gChoiceKey(event,'+index+','+token+')"><span class="grammar-choice__label">'+ui.escapeHtml(option)+'</span><span class="grammar-choice__state">'+(selected?'Выбрано':'')+'</span></button>'}).join('')+'</div>'
      +'<p id="g_feedback_status" class="grammar-live" role="status" aria-live="polite" aria-atomic="true">'+(GS.selectedChoice==null?'':'Выбран ответ '+ui.escapeHtml(question.o[GS.selectedChoice]))+'</p></div>';
    gSetPrimaryAction('Проверить ответ','gSubmitChoice('+token+')',GS.selectedChoice==null);
    gFocus(GS.selectedChoice==null?'g_choice_0':'g_choice_'+GS.selectedChoice)
  }else{var question=it.q,isInput=it.k==='f'||it.k==='input',instruction=isInput?'Впиши форму слова':it.k==='correction'?'Перепиши предложение без ошибки':'Выполни преобразование';
    var prompt=isInput?ui.escapeHtml(question.s).replace('_____','<span class="grammar-gap">&nbsp;?&nbsp;</span>'):ui.escapeHtml(question.s);
    var inputLabel=isInput?'Форма слова '+question.b:it.k==='correction'?'Исправленное предложение':'Преобразованное предложение';
    area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-paper--hero" aria-labelledby="g_task_title">'+head
      +'<p class="grammar-copy">'+ui.escapeHtml(context+' · '+instruction)+'</p><h2 id="g_task_title" class="grammar-title grammar-title--task" tabindex="-1">'+prompt+'</h2></section>'
      +'<label class="grammar-label" for="g_inp">'+ui.escapeHtml(inputLabel)+'</label>'
      +'<input id="g_inp" class="grammar-answer-input" aria-describedby="g_feedback_status" autocapitalize="sentences" autocomplete="off" spellcheck="false" placeholder="'+ui.escapeHtml(inputLabel)+'" value="'+ui.escapeHtml(GS.draftAnswer||'')+'" oninput="gInputChanged(this.value,'+token+')" onkeydown="if(event.key===\'Enter\'){event.preventDefault();gSubmit('+token+')}">'
      +'<p id="g_feedback_status" class="grammar-live" role="status" aria-live="polite" aria-atomic="true"></p></div>';
    gSetPrimaryAction('Проверить ответ','gSubmit('+token+')',!String(GS.draftAnswer||'').trim());gFocus('g_inp')}
  gAnim('win','.32s')}
function gSelectChoice(btn,index,token){if(!gTaskCurrent(token)||GS.answerCommitted)return;var choices=Array.from(document.querySelectorAll('#g_btns [role="radio"]'));
  if(!Number.isInteger(index)||index<0||index>=choices.length)return;GS.selectedChoice=index;GS.phase='selected';
  choices.forEach(function(choice,choiceIndex){var selected=choiceIndex===index,state=choice.querySelector('.grammar-choice__state');choice.setAttribute('aria-checked',String(selected));choice.tabIndex=selected?0:-1;if(state)state.textContent=selected?'Выбрано':''});
  var status=document.getElementById('g_feedback_status');if(status)status.textContent='Выбран ответ '+String(GS.queue[GS.i].q.o[index]||'');
  gEnablePrimaryAction(true);if(gIsPracticeSession())gPersistRunner()}
function gPick(btn,i){gSelectChoice(btn,i,GS&&GS.uiToken)}
function gChoiceKey(event,index,token){if(!gTaskCurrent(token)||!['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End'].includes(event.key))return;
  var choices=Array.from(document.querySelectorAll('#g_btns [role="radio"]'));if(!choices.length)return;event.preventDefault();
  var next=event.key==='Home'?0:event.key==='End'?choices.length-1:(index+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)+choices.length)%choices.length;
  gSelectChoice(choices[next],next,token);choices[next].focus()}
function gInputChanged(value,token){if(!gTaskCurrent(token)||GS.answerCommitted)return;GS.draftAnswer=String(value||'').slice(0,500);gEnablePrimaryAction(Boolean(GS.draftAnswer.trim()));if(gIsPracticeSession())gPersistRunner()}
function gNorm(v){return grammarModule.normalizeAnswer(v)}
function gExplain(it,userAnswer,restoring,knownCorrect){if(!GS||!it)return;var question=it.q,t=it.t||GS.t,lastOutcome=GS.itemOutcomes&&GS.itemOutcomes.at(-1);
  var correct=typeof knownCorrect==='boolean'?knownCorrect:Boolean(lastOutcome&&lastOutcome.id===question.id&&lastOutcome.correct);
  GS.phase='explain';if(gIsPracticeSession())gPersistRunner();
  var textAnswer=['f','input','correction','transform'].includes(it.k),right=textAnswer?question.ans[0]:question.o[question.a],shownAnswer=userAnswer==null?(textAnswer?GS.draftAnswer:Number.isInteger(GS.selectedChoice)?question.o[GS.selectedChoice]:''):String(userAnswer);
  var sentence=it.k==='f'||it.k==='input'
    ?ui.escapeHtml(question.s).replace('_____', '<strong>'+ui.escapeHtml(right)+'</strong>').replace(/\((?:[A-Z ]+)\)/u,'')
    :textAnswer?ui.escapeHtml(question.s)+'<br><strong>'+ui.escapeHtml(right)+'</strong>':ui.escapeHtml(question.t[0])+'<strong>'+ui.escapeHtml(right)+'</strong>'+ui.escapeHtml(question.t[1]);
  var topic=(GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t],transferLine=lastOutcome&&lastOutcome.transferStatus==='due_next_session'
    ?'Одна transfer-попытка использована. Эта точная слабость сохранена на следующий подход.'
    :it.transfer?'Это задание проверило перенос правила на новый пример.':'Следующее задание продолжит тот же учебный маршрут.';
  var assisted=Boolean(GS.answerAssisted||it.source==='generated'),answerProvenance=correct?(assisted?'ответ с опорой':'самостоятельный ответ'):'ответ показан';
  var evidence=(it.source==='generated'?'Дополнительный материал':'Проверенная база')+' · '+answerProvenance;
  var checkedControl=textAnswer
    ?'<label class="grammar-label" for="g_review_input">Ваш ответ</label><input id="g_review_input" class="grammar-answer-input '+(correct?'is-correct':'is-incorrect')+'" value="'+ui.escapeHtml(shownAnswer)+'" disabled aria-describedby="g_review_control_state"><p id="g_review_control_state" class="grammar-choice__state">Ваш ответ — '+(correct?'верно':'неверно')+'</p>'
    :'<div class="grammar-choice-list" role="radiogroup" aria-label="Проверенный ответ" aria-disabled="true">'+question.o.map(function(option,index){var chosen=index===GS.selectedChoice,isRight=index===question.a,state=isRight?(chosen?'Ваш ответ — верно':'Правильный ответ'):chosen?'Ваш ответ — неверно':'';return '<button type="button" class="aisy-choice grammar-choice '+(isRight?'is-correct':chosen?'is-incorrect':'')+'" role="radio" aria-checked="'+chosen+'" disabled aria-disabled="true"><span class="grammar-choice__label">'+ui.escapeHtml(option)+'</span><span class="grammar-choice__state">'+state+'</span></button>'}).join('')+'</div>';
  var area=gArea();gSetHeader(correct?'Верно':'Разбор ответа','Грамматика · обратная связь');
  area.innerHTML='<div class="grammar-view"><p id="g_feedback_status" class="grammar-live grammar-live--feedback" role="status" aria-live="polite" aria-atomic="true">'+(correct?'Ответ верный.':'Ответ неверный. Показан разбор.')+'</p><section id="g_card" class="grammar-feedback" data-verdict="'+(correct?'correct':'incorrect')+'" aria-labelledby="g_review_title">'
    +'<p class="grammar-verdict">'+(correct?'✓ Верно':'✕ Неверно')+'</p><h2 id="g_review_title" class="grammar-feedback__answer" tabindex="-1">'+ui.escapeHtml(right)+'</h2>'
    +checkedControl+'<div class="grammar-rule-sheet"><strong>Правило · '+ui.escapeHtml(topic.n)+'</strong><p>'+(question.e?ui.escapeHtml(question.e):topic.th)+'</p></div>'
    +'<p class="grammar-feedback__example">'+sentence+'</p>'
    +'<p class="grammar-feedback__evidence">'+ui.escapeHtml(evidence)+'</p><p class="grammar-feedback__evidence">'+ui.escapeHtml(transferLine)+'</p>'
    +'<div id="voice_tutor_grammar_practice"></div></section></div>';
  gSetPrimaryAction(GS.i<GS.queue.length-1?'Следующее задание':'Завершить подход','gAfterExplain()');gFocus('g_review_title');
  if(!correct&&!restoring&&it.voice&&userAnswer!=null){var voiceOwner=currentOwnerBinding();
    gRegisterVoiceError({module:'grammar',itemId:it.voice.id,revision:it.voice.revision,learnerAnswer:String(userAnswer)},'voice_tutor_grammar_practice',voiceOwner,G_VIEW_GENERATION,GS,GS.uiToken)}
  gAnim('win','.32s')}
function gAfterExplain(){if(!GS||GS.phase!=='explain')return;GS.phase='advance';GS.i++;GS.selectedChoice=null;GS.draftAnswer='';GS.answerCommitted=false;
  if(gIsPracticeSession())gPersistRunner();gSync();save();gRenderQ()}
function gErrorReason(it){if(GS&&GS.practiceMode==='legacy_practice')return it&&['f','input'].includes(it.k)?'word_or_verb_form':'construction_choice';var candidate=it&&((it.errorSkill)||(it.q&&it.q.errorSkill));if(isGrammarErrorCode(candidate))return candidate;
  return it&&['f','input'].includes(it.k)?'word_or_verb_form':'construction_choice'}
function gAnswer(ok,it,checked){if(!GS||GS.answerCommitted)return false;var topic=it.t||GS.t,type=it.k==='f'?'input':it.k==='c'||it.k==='c2'?'choice':it.k;GS.types=GS.types||{};GS.typeScores=GS.typeScores||{};GS.types[type]=true;
  var committedWithoutHelp=!GS.answerAssisted;GS.answerCommitted=true;var rule=document.getElementById('g_rule_btn');if(rule){rule.disabled=true;rule.setAttribute('aria-disabled','true')}
  var score=GS.typeScores[type]||(GS.typeScores[type]={correct:0,total:0});score.total++;if(ok)score.correct++;
  var legacy=GS.practiceMode==='legacy_practice';var errorCode=ok?null:(legacy?gErrorReason(it):checked&&checked.errorCode||gErrorReason(it)),confusionPair=ok||legacy?null:(checked&&Object.hasOwn(checked,'confusionPair')?checked.confusionPair:it.q&&it.q.confusionPair||null);
  if(!ok){GS.errorReasons=GS.errorReasons||{};GS.confusionPairs=GS.confusionPairs||{};GS.errorReasons[topic]=errorCode;GS.confusionPairs[topic]=confusionPair;
    if(committedWithoutHelp){var exactError=gExactIndependentError(topic,it.q.id,checked&&checked.diagnosticId||null,errorCode,confusionPair,GS.practiceMode==='legacy_practice',GS.catalogRuntime||G_CATALOG_RUNTIME);if(exactError){GS.independentErrors=GS.independentErrors||{};GS.independentErrors[topic]=exactError}}}
  if(gIsPracticeSession()){GS.itemOutcomes=GS.itemOutcomes||[];GS.itemOutcomes.push({id:it.q.id,...(GS.scope==='mixed'?{topicId:topic}:{}),type:type,transfer:Boolean(it.transfer),correct:Boolean(ok),diagnosticId:GS.activeRunner&&!ok?(checked&&checked.diagnosticId||null):null,errorCode:errorCode,confusionPair:GS.activeRunner?confusionPair:null,transferStatus:null,
    ...(it.source==='generated'?{source:'generated',revision:it.q.revision}:{})})}
  grammarModule.applyAnswer(gRec(topic),GS,it,ok);
  if(GS.mode==='rev'){var activityId=grammarModule.activityId(topic,'spaced_review');var evidence=GS.evidence[activityId];
    if(!evidence)evidence=GS.evidence[activityId]=gEvidence(activityId,GS.startedAt);
    evidence.helpUsed=Boolean(GS.helpActivities[activityId]);gTrackEvidenceSource(evidence,it);evidence.maxScore++;if(ok)evidence.score++}
  return true}
function gCommitWrongState(it,checked){gMarkHelp(it.t||GS.t,true,true);
  if(GS.activeRunner){var topic=it.t||GS.t,transferResult=grammarModule.enqueueTransferAfterFailure(GS,(GS.catalogBank||G_BANK)[topic],it,GS.sessionId+':transfer:'+GS.done,{errorCode:checked&&checked.errorCode||gErrorReason(it),confusionPair:checked&&Object.hasOwn(checked,'confusionPair')?checked.confusionPair:it.q&&it.q.confusionPair||null});
    if(transferResult&&transferResult.status==='due_next_session'&&GS.itemOutcomes.length)GS.itemOutcomes[GS.itemOutcomes.length-1].transferStatus='due_next_session'}
  GS.phase='explain';if(gIsPracticeSession())gPersistRunner()}
function gSubmitChoice(token){if(!gTaskCurrent(token)||GS.answerCommitted||!Number.isInteger(GS.selectedChoice))return;gEnablePrimaryAction(false);
  var it=GS.queue[GS.i],choice=GS.selectedChoice,checked=grammarModule.checkPracticeAnswer(it,choice),correct=checked.correct;
  if(!gAnswer(correct,it,checked))return;if(!correct)gCommitWrongState(it,checked);else{GS.phase='explain';if(gIsPracticeSession())gPersistRunner()}
  gExplain(it,it.q.o[choice],false,correct)}
function gSubmit(token){if(!gTaskCurrent(token)||GS.answerCommitted)return;var input=document.getElementById('g_inp'),answer=String(input&&input.value||GS.draftAnswer||'').trim();
  if(!answer){var status=document.getElementById('g_feedback_status');if(status)status.textContent='Введите ответ перед проверкой.';if(input)input.focus();return}
  gEnablePrimaryAction(false);var it=GS.queue[GS.i],checked=grammarModule.checkPracticeAnswer(it,answer),correct=checked.correct;
  if(!gAnswer(correct,it,checked))return;if(!correct)gCommitWrongState(it,checked);else{GS.phase='explain';if(gIsPracticeSession())gPersistRunner()}
  gExplain(it,answer,false,correct)}
function gRenderCompletionPending(){var area=document.getElementById('g_area');if(!area||!GS)return;
  gSetHeader('Сохраняем результат','Грамматика · синхронизация');area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-state" role="status" aria-live="polite"><span class="ebstate-spin" aria-hidden="true"></span><h2 class="grammar-title">Сохраняем результат…</h2><p class="grammar-copy">Точная сессия уже сохранена на устройстве и будет безопасно повторена.</p></section></div>';gSetPrimaryAction(null)}
function gCompletionEvent(session){var current=gRec(session.t),mixed=session.scope==='mixed',independentError=mixed?null:session.independentErrors&&session.independentErrors[session.t],independentErrors=mixed?gMixedIndependentErrorList(session):[],topicExpectations=mixed?gMixedTopicIds(session).map(function(topic){return{topicId:topic,...gMasteryExpectation(gRec(topic))}}):null;
  return{type:'session_completed',id:session.sessionId,assisted:session.masteryAssisted,source:session.source,completedTypes:Object.keys(session.types||{}),typeScores:session.typeScores,session:{id:session.sessionId,scope:session.scope||'topic',mode:session.practiceMode,source:session.source,catalog:{version:session.catalogVersion||GRAMMAR_CATALOG.version,revision:session.catalogRevision||GRAMMAR_CATALOG.revision},items:session.itemOutcomes,startedAt:session.evidence.startedAt,assisted:session.masteryAssisted,...(mixed?{topicExpectations:topicExpectations}:{}),...(session.practiceMode==='targeted_practice'?{recommendation:session.recommendation}:{})},...(independentError?{independentError:independentError}:{}),...(independentErrors.length?{independentErrors:independentErrors}:{}),...gMasteryExpectation(current)}}
async function gFinish(){if(GS&&GS.mode==='rev'){await gFinishRev();return}
  var finishedSession=GS,result=null,durable=false;if(!finishedSession)return;
  finishedSession.evidence.score=finishedSession.ok;finishedSession.evidence.maxScore=finishedSession.done;
  var focus=finishedSession.recommendation&&finishedSession.recommendation.pointer;
  gReportEvidence(finishedSession.evidence,{mode:finishedSession.practiceMode,source:finishedSession.source,helpUsed:finishedSession.helpUsed,hintsUsed:0,
    ...(finishedSession.scope==='mixed'?{}:{grammarTopicId:finishedSession.t}),grammarErrorCode:focus&&focus.errorCode||finishedSession.errorReasons[finishedSession.t],grammarConfusionPair:focus?focus.confusionPair:finishedSession.confusionPairs[finishedSession.t]});
  var completedTypes=Object.keys(finishedSession.types||{});
  if(completedTypes.length){
    if(!finishedSession.completionEvent)finishedSession.completionEvent=gCompletionEvent(finishedSession);
    finishedSession.phase='completion_pending';gPersistRunner();gRenderCompletionPending();
    result=await gSubmitMasteryEvent(finishedSession.t,finishedSession.completionEvent);
    if(GS!==finishedSession)return;
    durable=gMasteryDurable(result,finishedSession.completionEvent,finishedSession.t);if(durable)gClearRunner();
  }
  if(GS!==finishedSession)return;
  var area=document.getElementById('g_area');var r=gRec(finishedSession.t),tp=(finishedSession.catalogTopics||G_TOPICS)[finishedSession.t]||G_TOPICS[finishedSession.t],view=grammarModule.masteryView(r),mixed=finishedSession.scope==='mixed',targeted=finishedSession.practiceMode==='targeted_practice';
  var provisional=gMasteryProvisional(result),unsaved=gMasteryUnsaved(result),persistenceLine=gMasteryPersistenceLine(result),stable=!mixed&&!targeted&&!unsaved&&!provisional&&view.stage==='stable';
  var regression=view.regressionReason?' · Снова в работе: '+grammarModule.regressionReasonLabel(view.regressionReason):'';
  var sessionLabel=mixed?'Смешанная практика':targeted?'Точечная практика · '+tp.n:tp.n,statusLine=mixed?'Результаты тем сверены с их доказательными сроками':view.label+' · '+gDateLine(view)+regression,retryAction=mixed?'gStartMixed()':targeted?'gStartTargeted()':'gStart('+finishedSession.t+')';
  var resultTitle=unsaved?'Результат не сохранён':provisional?'Результат ждёт синхронизации':stable?'Навык устойчив!':'Подход завершён';
  gSetHeader(resultTitle,'Грамматика · результат');area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-state" aria-labelledby="g_result_title">'
    +'<span class="grammar-state__glyph" aria-hidden="true">'+(provisional?'…':stable?'✓':'•')+'</span><h2 id="g_result_title" class="grammar-title" tabindex="-1">'+resultTitle+'</h2>'
    +'<p class="grammar-copy">'+ui.escapeHtml(sessionLabel)+'<br>Верно: '+finishedSession.ok+' из '+finishedSession.done+'<br>'+ui.escapeHtml(provisional?'Статус обновится после синхронизации':statusLine)+(persistenceLine?'<br>'+ui.escapeHtml(persistenceLine):'')+(finishedSession.masteryAssisted?'<br>Ошибки и показанные ответы не повышают соответствующие темы':'')+'</p></section>'
    +(stable?'':'<button type="button" class="aisy-button aisy-button--secondary grammar-secondary" onclick="gToThemes()">К каталогу тем</button>')+'</div>';
  gSetPrimaryAction(stable?'К темам':durable?'Ещё подход':'Повторить синхронизацию',stable?'gToThemes()':durable?retryAction:'gFinish()');gFocus('g_result_title');gAnim();gSync();
  gSetProgress('Завершено заданий в подходе',100,'Завершено '+finishedSession.done+' из '+finishedSession.done+' заданий');setTxt('g_today','Результат · '+finishedSession.ok+' из '+finishedSession.done);save()}
async function gFinishRev(){var reviewSession=GS,area=gArea(),rows='',finishedAt=Date.now();if(!reviewSession||!area)return;
  gSetHeader('Сохраняем повторение','Грамматика · синхронизация');area.innerHTML='<div class="grammar-view"><section class="grammar-paper grammar-state" role="status" aria-live="polite"><span class="ebstate-spin" aria-hidden="true"></span><h2 class="grammar-title">Сверяем сроки тем…</h2></section></div>';gSetPrimaryAction(null);
  var durationMs=Math.max(0,finishedAt-reviewSession.startedAt);
  grammarModule.reviewEvidenceSlices(reviewSession.evidence,durationMs).forEach(function(evidence){
    gReportEvidence(evidence,{mode:'spaced_review',source:gEvidenceSource(evidence,reviewSession.source),helpUsed:evidence.helpUsed,hintsUsed:0},evidence.durationMs)});
  var entries=reviewSession.revT.map(function(t){var bad=reviewSession.errT[t],activityId=grammarModule.activityId(t,'spaced_review'),evidence=reviewSession.evidence[activityId],current=gRec(t);
    var independentError=reviewSession.independentErrors&&reviewSession.independentErrors[t];
    var event={type:'review_completed',id:crypto.randomUUID(),passed:!bad,assisted:Boolean(reviewSession.helpActivities[t]||reviewSession.helpActivities[activityId]),source:gEvidenceSource(evidence,reviewSession.source),...(bad&&independentError?{independentError:independentError}:{}),...gMasteryExpectation(current)};
    return{topicId:t,event:event}});
  var batchResult=await gSubmitMasteryBatch(entries),results=batchResult&&Array.isArray(batchResult.results)?batchResult.results:[];
  if(GS!==reviewSession)return;
  var batchProvisional=gMasteryProvisional(batchResult),batchUnsaved=gMasteryUnsaved(batchResult),batchLine=gMasteryPersistenceLine(batchResult);
  var resultsById=new Map(results.map(function(item){return[item&&item.eventId,item]}));
  for(let index=0;index<entries.length;index++){var t=entries[index].topicId,event=entries[index].event,result=resultsById.get(event.id)||batchResult,record=result&&result.record?result.record:gRec(t),line=gMasteryPersistenceLine(result)||batchLine,provisional=gMasteryProvisional(result)||batchProvisional;
    var view=grammarModule.masteryView(record,{now:finishedAt}),eventHistory=Array.isArray(record.masteryHistory)&&record.masteryHistory.find(function(item){return item&&item.eventId===event.id});
    var regressed=Boolean(event.passed===false&&!event.assisted&&result&&(result.applied||result.replay)&&eventHistory&&eventHistory.outcome==='regressed'&&record.lastRegressionReason);
    var state=provisional?'learning':regressed?'due':view.stage,label=provisional?'Ожидает синхронизации':regressed?'Снова в работе':view.label;
    rows+='<li class="grammar-result-row"><span class="grammar-topic__head"><strong>'+ui.escapeHtml(G_TOPICS[t].n)+'</strong><span class="grammar-status" data-state="'+state+'">'+ui.escapeHtml(label)+'</span></span>'
      +'<small>'+(provisional?'Статус обновится после синхронизации':ui.escapeHtml(gDateLine(view)))+'</small>'+(provisional||!regressed?'':gRegressionLine(view))+(line?'<p class="grammar-regression">'+ui.escapeHtml(line)+'</p>':'')+'</li>'}
  var resultTitle=batchUnsaved?'Результат не сохранён':batchProvisional?'Результат ждёт синхронизации':'Повторение завершено';
  gSetHeader(resultTitle,'Грамматика · результат');area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper" aria-labelledby="g_review_result_title">'
    +'<p class="grammar-kicker">Повторение по сроку</p><h2 id="g_review_result_title" class="grammar-title" tabindex="-1">'+resultTitle+'</h2><p class="grammar-copy">Верно: '+reviewSession.ok+' из '+reviewSession.done+'</p>'
    +'<ul class="grammar-result-list">'+rows+'</ul></section></div>';
  GS=null;gSetPrimaryAction('К темам','gToThemes()');gSync();
  gSetProgress('Завершено заданий в повторении',100,'Завершено '+reviewSession.done+' из '+reviewSession.done+' заданий');setTxt('g_today','Результат · '+reviewSession.ok+' из '+reviewSession.done);
  save();gFocus('g_review_result_title');gAnim()}
/* ===== ЭКЗАМЕН: задания 19–24 (текст с 6 пропусками) ===== */
const G_EXAMS=GRAMMAR_CATALOG.exams;

let EX=null;
function gExamPool(){var ai=(S&&S.examAi)||[];return G_EXAMS.concat(ai)}
function gExamFormById(id,source){var pool=source==='generated'?(S.examAi||[]):G_EXAMS;return pool.find(function(form){return form&&form.id===id})||null}
function gExamSnapshot(){return S&&S.grammarRunner&&S.grammarRunner.schema==='grammar-exam-runner-v1'?S.grammarRunner:null}
function gPersistExamRunner(){if(!S||!EX)return;S.grammarRunner={schema:'grammar-exam-runner-v1',sessionId:EX.sessionId,
  catalogVersion:GRAMMAR_CATALOG.version,catalogRevision:GRAMMAR_CATALOG.revision,formId:EX.ex.id,formRevision:EX.ex.revision,
  source:EX.source,startedAt:EX.t0,answers:EX.answers.slice(0,6).map(function(answer){return String(answer).slice(0,200)})};save()}
function gRestoreExamRunner(){var snapshot=gExamSnapshot();if(!snapshot||snapshot.catalogVersion!==GRAMMAR_CATALOG.version
  ||snapshot.catalogRevision!==GRAMMAR_CATALOG.revision||!['builtin','generated'].includes(snapshot.source)
  ||typeof snapshot.sessionId!=='string'||!Array.isArray(snapshot.answers)||snapshot.answers.length!==6
  ||!Number.isSafeInteger(snapshot.startedAt)||snapshot.startedAt<0)return false;
  var ex=gExamFormById(snapshot.formId,snapshot.source);if(!ex||ex.revision!==snapshot.formRevision)return false;
  EX={ex:ex,t0:snapshot.startedAt,sessionId:snapshot.sessionId,source:snapshot.source,answers:snapshot.answers.map(String),
    evidence:gEvidence(grammarModule.activityId(null,'exam_19_24'),snapshot.startedAt),iv:null};gExamRender();return true}
function gExamProgress(){if(!EX)return;var filled=EX.answers.filter(function(answer){return String(answer||'').trim()}).length;
  gSetProgress('Заполнено ответов экзамена',Math.round(filled/6*100),'Заполнено '+filled+' из 6 ответов')}
function gExamInput(index,value){if(!EX||!Number.isInteger(index)||index<0||index>=6)return;EX.answers[index]=String(value||'').slice(0,200);gPersistExamRunner();gExamProgress()}
async function gStoreExamErrors(errors,owner,viewGeneration,examSession){
  if(!errors.length||typeof SRV==='undefined'||!SRV||!TOKEN)return true;
  try{var response=await apiPost('/api/v1/error-bank',{errors:errors},gExpectedOwnerHeaders(owner));
    if(EX!==examSession||viewGeneration!==G_VIEW_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return false;
    return gConfirmOwnerResponse(owner,response)
  }catch(error){if(EX!==examSession||viewGeneration!==G_VIEW_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return false;
    if(apiIsAuthorityFailure(error)){await gInvalidateOwner(owner);return false}return true}}
function gExam(){var area=gArea();if(!area)return;var stats=S.exam19||{};
  gSetHeader('Задания 19–24','Грамматика · экзаменационный режим');
  area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-paper--hero" aria-labelledby="g_exam_intro_title">'
    +'<p class="grammar-kicker">Как на ЕГЭ</p><h2 id="g_exam_intro_title" class="grammar-title" tabindex="-1">Задания 19–24</h2>'
    +'<p class="grammar-copy">Связный текст с шестью пропусками. Впиши правильную форму слов, данных заглавными буквами, без вариантов ответа. Таймер начнётся вместе с заданием.</p>'
    +(stats.n?'<div class="grammar-result__meta"><span class="grammar-data-pill">Попыток: '+stats.n+'</span><span class="grammar-data-pill">Последний: '+stats.last+' из 6</span><span class="grammar-data-pill">Лучший: '+stats.best+' из 6</span></div>':'')
    +'</section><button type="button" class="aisy-button aisy-button--secondary grammar-secondary" onclick="gMap()">К каталогу тем</button></div>';
  gSetProgress('Заполнено ответов экзамена',0,'Заполнено 0 из 6 ответов');setTxt('g_today','6 заданий');
  gSetPrimaryAction('Начать','gExamStart()');gFocus('g_exam_intro_title');gAnim();gExamGen()}
function gExamStart(contentRef){var adaptive=contentRef==='builtin:exam:grammar:19-24:v1';var pool=adaptive?G_EXAMS:gExamPool();
  if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}
  S.examIdx=(S.examIdx||0);var ex=adaptive?G_EXAMS[0]:pool[S.examIdx%pool.length];if(!adaptive)S.examIdx++;
  if(EX&&EX.iv)clearInterval(EX.iv);
  var startedAt=Date.now();EX={ex:ex,t0:startedAt,sessionId:crypto.randomUUID(),source:adaptive||G_EXAMS.includes(ex)?'builtin':'generated',answers:['','','','','',''],
    evidence:gEvidence(grammarModule.activityId(null,'exam_19_24'),startedAt),iv:null};gPersistExamRunner();gExamRender()}
function gExamRender(){if(!EX)return;if(EX.iv)clearInterval(EX.iv);EX.iv=setInterval(function(){if(EX)setTxt('g_exam_timer','Время: '+gExamFmt(Math.floor((Date.now()-EX.t0)/1000)))},1000);
  var exam=EX.ex,area=gArea(),text='';
  exam.tx.forEach(function(segment,index){text+=ui.escapeHtml(segment);if(index<6)text+='<b>'+(19+index)+'</b>&nbsp;<span class="grammar-gap"></span>&nbsp;<small>('+ui.escapeHtml(exam.gaps[index].b)+')</small> '});
  var inputs=exam.gaps.map(function(gap,index){return '<div class="grammar-exam-field"><label for="g_ex_'+index+'">'+(19+index)+' · '+ui.escapeHtml(gap.b)+'</label>'
      +'<input id="g_ex_'+index+'" class="grammar-exam-input" maxlength="200" aria-label="Пропуск '+(19+index)+', форма слова '+ui.escapeHtml(gap.b)+'" value="'+ui.escapeHtml(EX.answers[index]||'')+'" oninput="gExamInput('+index+',this.value)" autocapitalize="none" autocomplete="off" spellcheck="false"></div>'}).join('');
  gSetHeader('Задания 19–24','Грамматика · экзаменационный режим');
  area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper grammar-paper--hero" aria-labelledby="g_exam_task_title"><p class="grammar-kicker">Задания 19–24</p>'
    +'<h2 id="g_exam_task_title" class="grammar-title" tabindex="-1">Поставь слова в нужную форму</h2><p id="g_exam_timer" class="grammar-exam-timer">Время: '+gExamFmt(Math.floor((Date.now()-EX.t0)/1000))+'</p><p class="grammar-exam-text">'+text+'</p></section>'
    +'<div class="grammar-exam-grid">'+inputs+'</div></div>';
  gExamProgress();setTxt('g_today','В работе · 6 заданий');gSetPrimaryAction('Проверить','gExamCheck()');gFocus('g_ex_0');gAnim()}
async function gExamCheck(){if(!EX||EX.submitting)return;var examSession=EX,owner=currentOwnerBinding();if(!owner)return;
  var viewGeneration=G_VIEW_GENERATION;EX.submitting=true;gEnablePrimaryAction(false);var exam=EX.ex,evidence=EX.evidence,source=EX.source;clearInterval(EX.iv);var seconds=examModule.elapsedSeconds(EX.t0,Date.now());
  EX.answers=exam.gaps.map(function(_gap,index){var input=document.getElementById('g_ex_'+index);return String(input?input.value:EX.answers[index]||'').slice(0,200)});gPersistExamRunner();
  var assessment;try{assessment=examModule.assessGrammar19To24({id:EX.sessionId,catalog:GRAMMAR_CATALOG,form:exam,answers:EX.answers,records:S.grammarMastery||{},startedAt:EX.t0,source:source})}
  catch(_){EX.submitting=false;gExamRender();return}
  var score=assessment.score,rows='',bank=assessment.errorBank,voiceErrors=[],masteryResult=await gSubmitMasteryEvent(assessment.event.topicId,assessment.event.event);
  if(EX!==examSession||viewGeneration!==G_VIEW_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
  var provisional=gMasteryProvisional(masteryResult),unsaved=gMasteryUnsaved(masteryResult),persistenceLine=gMasteryPersistenceLine(masteryResult);
  if(!unsaved&&!await gStoreExamErrors(bank,owner,viewGeneration,examSession))return;
  if(EX!==examSession||viewGeneration!==G_VIEW_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
  exam.gaps.forEach(function(gap,index){var learnerAnswer=EX.answers[index]||'',correct=gap.ans.some(function(answer){return examModule.normalizeGrammarAnswer(answer)===examModule.normalizeGrammarAnswer(learnerAnswer)}),voiceSlot='';
    if(!correct&&gap.voice){var slotId='voice_tutor_grammar_'+index;voiceSlot='<div id="'+slotId+'"></div>';voiceErrors.push({slotId:slotId,module:'grammar',itemId:gap.voice.id,revision:gap.voice.revision,learnerAnswer:learnerAnswer})}
    rows+='<li class="grammar-result-row" data-verdict="'+(correct?'correct':'incorrect')+'"><span class="grammar-topic__head"><strong>'+(correct?'✓ Верно':'✕ Неверно')+' · '+(19+index)+' · '+ui.escapeHtml(gap.b)+' → '+ui.escapeHtml(gap.ans[0])+'</strong>'
      +'<span class="grammar-status" data-state="'+(correct?'stable':'due')+'">'+(correct?'Верно':'Ваш ответ: '+ui.escapeHtml(learnerAnswer||'—'))+'</span></span>'
      +(correct?'':'<small>'+ui.escapeHtml(gap.e)+'</small>'+voiceSlot)+'</li>'});
  if(!unsaved){S.exam19=examModule.record(S.exam19,score);evidence.score=score;evidence.maxScore=6;
    gReportEvidence(evidence,{mode:'exam_19_24',source:source,helpUsed:false,hintsUsed:0});
    EX=null;gClearRunner();save();gSync()
  }else{EX.submitting=false;gPersistExamRunner()}
  var area=gArea(),resultCopy='Время: '+gExamFmt(seconds)+(score<6?' · слабые темы отмечены к повторению':'')+(provisional?' · статус обновится после синхронизации':'')+(unsaved?' · результат mastery не записан':'')+(persistenceLine?' · '+persistenceLine:'');
  gSetHeader(score+' из 6','Грамматика · результат экзамена');area.innerHTML='<div class="grammar-view"><section id="g_card" class="grammar-paper" aria-labelledby="g_exam_result_title">'
    +'<p class="grammar-kicker">Результат заданий 19–24</p><h2 id="g_exam_result_title" class="grammar-title" tabindex="-1">'+score+' из 6</h2><p class="grammar-copy">'+ui.escapeHtml(resultCopy)+'</p>'
    +'<ul class="grammar-result-list">'+rows+'</ul></section>'
    +(unsaved?'':score<6?'<button type="button" class="aisy-button aisy-button--secondary grammar-secondary" onclick="gExamStart()">Ещё текст</button>':'')
    +'<button type="button" class="aisy-button aisy-button--secondary grammar-secondary" onclick="gMap()">К темам</button></div>';
  gSetProgress('Проверено заданий экзамена',100,'Проверено 6 из 6 заданий');setTxt('g_today','Результат · '+score+' из 6');
  gSetPrimaryAction(unsaved?'Повторить сохранение':score<6?'Точная практика по ошибке':'Ещё текст',unsaved?'gExamCheck()':score<6?'gStartTargeted()':'gExamStart()');gFocus('g_exam_result_title');
  if(!unsaved)voiceErrors.forEach(function(details){gRegisterVoiceError(details,details.slotId,owner,G_VIEW_GENERATION)});
  gAnim();if(!unsaved)gExamGen()}
function launchGrammarExam(contentRef){if(contentRef!=='builtin:exam:grammar:19-24:v1')return false;gExamStart(contentRef);return true}
/* фоновая генерация новых экзаменационных текстов */
var G_EXGEN=false;
async function gExamGen(){
  if(G_EXGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var owner=currentOwnerBinding();if(!owner)return;if(gExamPool().length>=8)return;G_EXGEN=true;var requestGeneration=++G_EXAM_GENERATION;
  var expectedOwnerHeaders=gExpectedOwnerHeaders(owner);
  try{var d=await generateAiContent('grammar_exam_19_24',{},expectedOwnerHeaders);
    if(requestGeneration!==G_EXAM_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
    if(!await gConfirmOwnerResponse(owner,d))return;
    var ex=validateGeneratedGrammarSupplement('grammar_exam_19_24',d);
    S.examAi=(S.examAi||[]).concat([ex]);save()
  }catch(error){if(requestGeneration===G_EXAM_GENERATION&&gSameOwner(owner,currentOwnerBinding())&&apiIsAuthorityFailure(error))await gInvalidateOwner(owner)}
  finally{if(requestGeneration===G_EXAM_GENERATION)G_EXGEN=false}}
/* фоновая ИИ-догенерация заданий по теме */
var G_GEN=false;
async function gGen(t){
  if(G_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var owner=currentOwnerBinding();if(!owner)return;var ai=(S.gramAi&&S.gramAi[t])||[];
  if(ai.length>=15)return;G_GEN=true;var requestGeneration=++G_TOPIC_GENERATION;
  var expectedOwnerHeaders=gExpectedOwnerHeaders(owner);
  try{var tp=G_TOPICS[t],response=await generateAiContent('grammar_topic_set',{topicId:t,topic:tp.n},expectedOwnerHeaders);
    if(requestGeneration!==G_TOPIC_GENERATION||!gSameOwner(owner,currentOwnerBinding()))return;
    if(!await gConfirmOwnerResponse(owner,response))return;
    var d=validateGeneratedGrammarSupplement('grammar_topic_set',response);
    var add=[];d.c.forEach(function(q){add.push({k:'c',q:q,voice:q.voice||null})});d.f.forEach(function(q){add.push({k:'f',q:q,voice:q.voice||null})});
    if(add.length){S.gramAi=S.gramAi||{};S.gramAi[t]=((S.gramAi[t])||[]).concat(add);save()}
  }catch(error){if(requestGeneration===G_TOPIC_GENERATION&&gSameOwner(owner,currentOwnerBinding())&&apiIsAuthorityFailure(error))await gInvalidateOwner(owner)}
  finally{if(requestGeneration===G_TOPIC_GENERATION)G_GEN=false}}
registerRouteHook(function(id){if(id==='scr3')initGrammar()});
/* Экзамен по грамматике не должен тикать в фоне после ухода с экрана. */
registerRouteHook(function(id){if(id!=='scr3'){if(EX&&EX.iv)clearInterval(EX.iv);EX=null;GS=null;G_TASK_TOKEN+=1;G_TARGET_REQUEST_GENERATION+=1;G_EXAM_GENERATION+=1;G_TOPIC_GENERATION+=1;G_SCREEN_GENERATION+=1;G_VIEW_GENERATION+=1;G_TARGET_PENDING=false;G_EXGEN=false;G_GEN=false;gSetPrimaryAction(null)}});
window.addEventListener('online',gRenderNetworkState);
window.addEventListener('offline',gRenderNetworkState);
registerAuthorityReset(function(){if(EX&&EX.iv)clearInterval(EX.iv);EX=null;GS=null;GQ=GRAM_Q.slice();G_TASK_TOKEN+=1;G_TARGET_REQUEST_GENERATION+=1;G_EXAM_GENERATION+=1;G_TOPIC_GENERATION+=1;G_SCREEN_GENERATION+=1;G_VIEW_GENERATION+=1;G_TARGET_PENDING=false;G_EXGEN=false;G_GEN=false;gSetPrimaryAction(null);var area=gArea();if(area)area.replaceChildren()});
registerScreenGenerator('scr3',genGrammar);

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  gAfterExplain,gChoiceKey,gExam,gExamCheck,gExamInput,gExamStart,gFinish,gInputChanged,gMap,gOpen,gPick,gResume,gReview,gSelectChoice,gStart,gStartMixed,gStartTargeted,gSubmit,gSubmitChoice,launchGrammarExam,
  gTheory,gToThemes,
};
