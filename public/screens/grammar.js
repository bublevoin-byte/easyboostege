/*
 * Экран «Грамматика» (scr3). Раздел 6.1 ТЗ обещает встроенные грамматические тесты без сети,
 * поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 * В оболочке остались только сводка плитки (gSync) и формат таймера, который делят экзамены
 * чтения и аудирования.
 */
import {registerRouteHook,tab} from '../router.js';
import {registerVoiceTutorError,voiceTutorButton} from '../voice-tutor-loader.js';
import {
  S,SRV,TOKEN,WBTN,apiGet,apiPost,examModule,gExamFmt,gSync,generateAiContent,grammarModule,
  registerScreenGenerator,save,setTxt,ui,wDeco,
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
  source:GS.source,helpUsed:Boolean(GS.helpUsed),masteryAssisted:Boolean(GS.masteryAssisted),phase:GS.phase||'question',
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
    source:source,helpUsed:Boolean(snapshot.helpUsed),masteryAssisted:Boolean(snapshot.masteryAssisted),answerCommitted:false,answerAssisted:Boolean(snapshot.answerAssisted),
    phase:completionPending?'completion_pending':snapshot.phase==='explain'?'explain':snapshot.phase==='advance'?'advance':'question',errorReasons:scope==='mixed'?{}:gSafeRunnerErrors(snapshot.errorReasons,t),confusionPairs:scope==='mixed'?{}:gSafeRunnerPairs(snapshot.confusionPairs,t),independentErrors:scope==='mixed'?gSafeMixedIndependentErrors(snapshot.independentErrors,[...new Set(queue.map(function(item){return item.t}))],resolvedRuntime):gSafeIndependentErrors(snapshot.independentErrors,t,!active,resolvedRuntime),types:gSafeRunnerFlags(snapshot.types),
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
function gAnim(name,dur){ui.animate('g_card',name,dur)}
function gStatusChip(record){var view=grammarModule.masteryView(record);
  if(view.due)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+view.nextLabel.toUpperCase()+'</span>';
  if(view.stage==='stable')return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">УСТОЙЧИВО</span>';
  if(view.stage==='confirmed')return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ПОДТВЕРЖДЕНО</span>';
  if(view.stage==='learned')return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#2369A8;background:#EAF3FC;padding:5px 10px;border-radius:20px;">ИЗУЧЕНО</span>';
  if(view.stage==='learning')return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ИЗУЧАЕТСЯ</span>';
  return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">НЕ НАЧАТА</span>'}
function gDateLine(view){if(view.due)return view.nextLabel;
  if(view.eligibleAt!=null)return 'следующая проверка '+new Date(view.eligibleAt).toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
  return view.nextLabel}
function gRegressionLine(view){if(!view.regressionReason)return'';
  return '<div style="margin-top:7px;font-weight:700;font-size:11px;color:#A56000;">Снова в работе: '+grammarModule.regressionReasonLabel(view.regressionReason)+'</div>'}
function gMasteryQueueAvailable(required){return !window.EasyBoostSync||typeof window.EasyBoostSync.canQueueGrammarMasteryEvent!=='function'||window.EasyBoostSync.canQueueGrammarMasteryEvent(required||1)}
function gShowMasteryQueueFull(){var area=document.getElementById('g_area');if(!area)return;
  area.innerHTML='<div class="clayCard" style="padding:22px;text-align:center;"><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;">Подключитесь для синхронизации</div><div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:8px;">Очередь результатов заполнена. После синхронизации можно продолжить тренировку.</div></div><button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:12px;" onclick="gMap()">К темам</button>'}
function initGrammar(){if(!S)return;gSync();GS=gRestoreRunner();if(GS){gResume();return}if(gRestoreExamRunner())return;if(S.grammarRunner){delete S.grammarRunner;save()}gMap()}
/* Обработчик разметки не может присвоить переменную модуля, поэтому сброс темы — функция. */
function gToThemes(){var preservePending=Boolean(GS&&GS.phase==='completion_pending'&&S&&S.grammarRunner);GS=null;if(!preservePending)gClearRunner();gMap()}
function gRetryPendingCompletion(){var snapshot=S&&S.grammarRunner;if(!snapshot||snapshot.phase!=='completion_pending')return false;
  var pending=gRestoreRunner();if(!pending){gRenderCompletionPending();return true}GS=pending;gResume();return true}
function gMap(){var area=document.getElementById('g_area');if(!area)return;
  var due=gDue();
  var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.05)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var h='';
  var dashboard=examModule.grammarDashboard(S.grammarMastery||{},{now:Date.now()});
  var secured=(dashboard.stageCounts.confirmed||0)+(dashboard.stageCounts.stable||0);
  var weakLabels=dashboard.weakErrorTypes.slice(0,3).map(function(item){return grammarModule.regressionReasonLabel(item.errorCode)});
  h+='<section data-grammar-dashboard role="status" class="clayCard" style="padding:16px 18px;margin-bottom:14px;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;"><div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:17px;color:#2B2B2B;">Grammar 2.0 · 20 тем</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">Подтверждено или устойчиво: '+secured+' · На повторение: '+dashboard.dueTopicIds.length+'</div></div>'
    +'<span style="flex:none;font-weight:900;font-size:18px;color:#1D7F4A;">'+dashboard.stageCounts.stable+'</span></div>'
    +'<div style="font-weight:700;font-size:11.5px;color:#A56000;margin-top:9px;">Слабые места: '+(weakLabels.length?weakLabels.join(' · '):'пока не выявлены')+'</div></section>';
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
  h+='<button type="button" class="sq clk cardbtn" onclick="gStartMixed()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:linear-gradient(145deg,#EAF3FC,#F5F0FF);border:1px solid #D9DDF1;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Смешанная практика</div>'
    +'<div style="font-weight:600;font-size:12px;color:#626B7A;margin-top:2px;">16 заданий · тема заранее не раскрывается</div></div><span style="flex:none;background:#fff;border-radius:14px;padding:9px 14px;font-weight:800;font-size:12.5px;color:#465B9B;">Начать</span></div></button>';
  h+='<button type="button" class="sq clk cardbtn" onclick="gStartTargeted()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:#F2F8F4;border:1px solid #D7EADF;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Точечная практика</div>'
    +'<div style="font-weight:600;font-size:12px;color:#557064;margin-top:2px;">8 заданий по актуальной слабости</div></div><span style="flex:none;background:#fff;border-radius:14px;padding:9px 14px;font-weight:800;font-size:12.5px;color:#1D7F4A;">Подобрать</span></div></button>';
  G_GROUPS.forEach(function(gr){
    h+='<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:12px;letter-spacing:1.8px;color:#6F695E;margin:6px 2px 10px;">'+gr.n.toUpperCase()+'</div>';
    gr.ids.forEach(function(t){var r=gRec(t),tp=G_TOPICS[t],view=grammarModule.masteryView(r);
      var pct=view.stage==='learning'?Math.max(view.progress,Math.min(39,Math.round(r.stats.advancedStreak/4*40))):view.progress;
      h+='<button type="button" class="clayCard sq clk cardbtn" onclick="gOpen('+t+')" style="'+ga()+'padding:14px 16px;margin-bottom:11px;cursor:pointer;">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
        +'<div style="font-weight:800;font-size:14.5px;color:#2B2B2B;">'+tp.n+'</div>'+gStatusChip(r)+'</div>'
        +'<div style="margin-top:10px;height:6px;border-radius:4px;background:#F1EDE7;"><div style="width:'+pct+'%;height:100%;border-radius:4px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'
        +(r.stats.correct+r.stats.errors>0?'<div style="margin-top:7px;font-weight:600;font-size:11px;color:#777163;">верно '+r.stats.correct+' · ошибок '+r.stats.errors+'</div>':'')
        +'<div style="margin-top:6px;font-weight:600;font-size:11px;color:#777163;">'+gDateLine(view)+'</div>'+gRegressionLine(view)
        +'</button>'});
  });
  area.innerHTML=h;setTxt('g_today','20 тем'+(due.length?' · '+due.length+' на повторение':''))}
function gOpen(t){gTheory(t,true)}
function gTheory(t,fromMap){var area=document.getElementById('g_area');if(!area)return;if(!fromMap)gMarkHelp(t);var tp=(GS&&GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t];
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'
    +wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ПРАВИЛО</span>'
    +gStatusChip(gRec(t))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">'+tp.n+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:10px;">'+tp.th+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="'+(fromMap?('gStart('+t+')'):'gResume()')+'">'+(fromMap?'Начать практику':'Продолжить практику')+'</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">← К темам</button></div>';
  gAnim('win','.32s')}
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
function gTargetedUnavailable(){var area=document.getElementById('g_area');if(!area)return;area.innerHTML='<div class="clayCard" role="status" style="padding:22px;text-align:center;"><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;">Точечная практика пока недоступна</div><div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:8px;">Подключитесь к сети и обновите рекомендацию.</div></div><button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:12px;" onclick="gMap()">К темам</button>'}
async function gStartTargeted(){if(gRetryPendingCompletion())return;if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}try{var issued=await apiGet('/api/v1/grammar/recommendation'),recommendation=issued&&issued.recommendation;
    var resolved=await apiPost('/api/v1/grammar/recommendation/resolve',{pointer:recommendation&&recommendation.pointer}),pointer=resolved&&resolved.recommendation&&resolved.recommendation.pointer;
    if(!pointer||JSON.stringify(pointer)!==JSON.stringify(recommendation.pointer)||!resolved.catalog||resolved.catalog.version!==GRAMMAR_CATALOG.version||resolved.catalog.revision!==GRAMMAR_CATALOG.revision||!/^[A-Za-z0-9_-]{43}$/u.test(String(resolved.completionToken||'')))throw new Error('GRAMMAR_RECOMMENDATION_INVALID');
    var expected=grammarModule.buildTargetedPracticeQueue(G_BANK,pointer,{seed:pointer.ref}),ids=Array.isArray(resolved.itemIds)?resolved.itemIds:[];
    if(expected.length!==8||JSON.stringify(expected.map(function(item){return item.q.id}))!==JSON.stringify(ids))throw new Error('GRAMMAR_RECOMMENDATION_INVALID');
    var sessionId=crypto.randomUUID(),t=pointer.topicId;GS={activeRunner:true,practiceMode:'targeted_practice',scope:'topic',catalogVersion:GRAMMAR_CATALOG.version,catalogRevision:GRAMMAR_CATALOG.revision,...gRunnerCatalogRuntime(G_CATALOG_RUNTIME),sessionId:sessionId,t:t,queue:expected,i:0,ok:0,done:0,source:'builtin',helpUsed:false,masteryAssisted:false,answerCommitted:false,answerAssisted:false,phase:'question',reservedItemIds:ids.slice(),itemOutcomes:[],errorReasons:{},confusionPairs:{},independentErrors:{},types:{},typeScores:{},recommendation:{pointer:pointer,itemIds:ids.slice(),completionToken:resolved.completionToken},evidence:gEvidence(grammarModule.activityId(t,'targeted_practice'))};
    gPersistRunner();gRenderQ()}catch(error){gTargetedUnavailable()}}
function gResume(){if(!GS){gMap();return}if(GS.phase==='completion_pending'){gRenderCompletionPending();gFinish();return}if(GS.phase==='explain'){gExplain(GS.queue[GS.i],null,true);return}gRenderQ(true)}
function gReview(){if(gRetryPendingCompletion())return;var due=gDue();if(!due.length){gMap();return}if(!gMasteryQueueAvailable(due.length)){gShowMasteryQueueFull();return}
  var items=[];
  due.forEach(function(t){items=items.concat(gShuffle(gLvl2(t)).slice(0,2))});
  var queue=gShuffle(items);
  GS={mode:'rev',revT:due.slice(),queue:queue,i:0,ok:0,done:0,errT:{},startedAt:Date.now(),source:grammarModule.queueSource(queue),helpUsed:false,answerCommitted:false,answerAssisted:false,errorReasons:{},independentErrors:{},helpActivities:{},evidence:{}};
  gRenderQ()}
function gProgressLine(){setTxt('g_today',(GS.done)+' / '+GS.queue.length+' в подходе')}
function gRenderQ(preserveAnswerState){var area=document.getElementById('g_area');if(!area||!GS)return;gProgressLine();
  var it=GS.queue[GS.i];
  if(!it){gFinish();return}
  GS.answerCommitted=false;if(!preserveAnswerState)GS.answerAssisted=false;GS.phase='question';if(gIsPracticeSession())gPersistRunner();
  var t=it.t||GS.t,tp=(GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t],mixed=GS.scope==='mixed',hiddenTopic=mixed||GS.practiceMode==='targeted_practice';
  var labels={choice:'УРОВЕНЬ 1 · ВЫБОР',input:'УРОВЕНЬ 2 · ВВОД',correction:'УРОВЕНЬ 3 · ИСПРАВЛЕНИЕ',transform:'УРОВЕНЬ 4 · ПРЕОБРАЗОВАНИЕ'};
  var level=it.transfer?'ТРАНСФЕР · '+(labels[it.k]||'НОВОЕ ЗАДАНИЕ'):(labels[it.k]||(it.k==='c'?'УРОВЕНЬ 1 · ВЫБОР':'УРОВЕНЬ 2 · КАК НА ЕГЭ'));
  var head='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span data-grammar-level="'+it.k+'" style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+(GS.mode==='rev'?'ПОВТОРЕНИЕ':level)+'</span>'
    +(hiddenTopic?'':'<button id="g_rule_btn" type="button" class="clk iconbtn" onclick="gTheory('+t+')" style="box-sizing:border-box;min-block-size:48px;min-inline-size:48px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;cursor:pointer;">ПРАВИЛО</button>')+'</div>';
  if(it.k==='c'||it.k==='c2'||it.k==='choice'){var q=it.q;
    area.innerHTML='<div id="g_card" class="clayCard" aria-live="polite" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+(mixed?'Смешанная практика · определи правило сам':GS.practiceMode==='targeted_practice'?'Точечная практика · определи правило сам':tp.n)+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;line-height:1.5;margin-top:8px;">'
      +q.t[0]+'<span style="display:inline-block;min-width:64px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>'+q.t[1]+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'" onclick="gPick(this,'+i+')">'+o+'</button>'}).join('')+'</div>';
  }else{var q=it.q,isInput=it.k==='f'||it.k==='input',instruction=isInput?'впиши форму слова':it.k==='correction'?'перепиши предложение без ошибки':'выполни преобразование';
    var prompt=isInput?q.s.replace('_____','<span style="display:inline-block;min-width:70px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>'):q.s;
    var inputLabel=isInput?'Форма слова '+q.b:it.k==='correction'?'Исправленное предложение':'Преобразованное предложение';
    area.innerHTML='<div id="g_card" class="clayCard" aria-live="polite" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+(mixed?'Смешанная практика · ':GS.practiceMode==='targeted_practice'?'Точечная практика · ':tp.n+' · ')+instruction+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.55;margin-top:8px;">'
      +prompt+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +'<input id="g_inp" aria-label="'+inputLabel+'" autocapitalize="sentences" autocomplete="off" spellcheck="false" placeholder="'+inputLabel+'" '
      +'style="width:100%;box-sizing:border-box;height:52px;border:1px solid #F0EAE2;border-radius:18px;padding:0 16px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);" onkeydown="if(event.key===\'Enter\')gSubmit()">'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gSubmit()">Проверить</button>'}
  gAnim('win','.32s')}
function gNorm(v){return grammarModule.normalizeAnswer(v)}
function gExplain(it,userWrong,restoring){var q=it.q,t=it.t||GS.t;gMarkHelp(t,true,true);GS.phase='explain';if(gIsPracticeSession())gPersistRunner();
  var textAnswer=it.k==='f'||it.k==='input'||it.k==='correction'||it.k==='transform';
  var right=textAnswer?q.ans[0]:q.o[q.a];
  var sent=it.k==='f'||it.k==='input'
    ? q.s.replace('_____','<b style="color:#1D7F4A;">'+right+'</b>').replace(/\((?:[A-Z ]+)\)/,'')
    : textAnswer?q.s+'<br><b style="color:#1D7F4A;">'+right+'</b>':q.t[0]+'<b style="color:#1D7F4A;">'+right+'</b>'+q.t[1];
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" aria-live="polite" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">РАЗБОР ОШИБКИ</span></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:22px;color:#1D7F4A;margin-top:14px;text-align:center;">'+right+'</div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.6;margin-top:10px;text-align:center;font-style:italic;">'+sent+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:12px;background:#FDF3EC;border-left:3px solid #F2683F;border-radius:0 14px 14px 0;padding:11px 14px;"><b>Почему:</b> '+(q.e||'')+'</div>'
    +'<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:12px 14px;">'
    +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ПРАВИЛО · '+((GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t]).n.toUpperCase()+'</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.6;margin-top:6px;">'+((GS.catalogTopics||G_TOPICS)[t]||G_TOPICS[t]).th+'</div></div>'
    +'<div style="font-weight:600;font-size:11.5px;color:#75705F;margin-top:10px;text-align:center;">'+(GS.itemOutcomes&&GS.itemOutcomes.at(-1)&&GS.itemOutcomes.at(-1).transferStatus==='due_next_session'?'Одна transfer-попытка использована. Эта точная слабость сохранена на следующий подход.':it.transfer?'Следующее задание проверит перенос ещё раз':'Дальше будет отдельное новое задание на эту же слабость')+'</div><div id="voice_tutor_grammar_practice"></div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gAfterExplain()">Понятно, дальше</button></div>';
  if(!restoring&&it.voice&&userWrong!=null)registerVoiceTutorError({module:'grammar',itemId:it.voice.id,revision:it.voice.revision,learnerAnswer:String(userWrong)})
    .then(function(recorded){var slot=document.getElementById('voice_tutor_grammar_practice');if(slot&&recorded)slot.innerHTML=voiceTutorButton(recorded)}).catch(function(){});
  gAnim('wflip','.5s')}
function gAfterExplain(){GS.i++;GS.phase='question';if(gIsPracticeSession())gPersistRunner();gSync();save();gRenderQ()}
function gErrorReason(it){if(GS&&GS.practiceMode==='legacy_practice')return it&&['f','input'].includes(it.k)?'word_or_verb_form':'construction_choice';var candidate=it&&((it.errorSkill)||(it.q&&it.q.errorSkill));if(isGrammarErrorCode(candidate))return candidate;
  return it&&['f','input'].includes(it.k)?'word_or_verb_form':'construction_choice'}
function gAnswer(ok,it,checked){var topic=it.t||GS.t,type=it.k==='f'?'input':it.k==='c'||it.k==='c2'?'choice':it.k;GS.types=GS.types||{};GS.typeScores=GS.typeScores||{};GS.types[type]=true;
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
    evidence.helpUsed=Boolean(GS.helpActivities[activityId]);gTrackEvidenceSource(evidence,it);evidence.maxScore++;if(ok)evidence.score++}}
function gCommitWrongState(it,checked){
  gMarkHelp(it.t||GS.t,true,true);
  if(GS.activeRunner){var topic=it.t||GS.t,transferResult=grammarModule.enqueueTransferAfterFailure(GS,(GS.catalogBank||G_BANK)[topic],it,GS.sessionId+':transfer:'+GS.done,{errorCode:checked&&checked.errorCode||gErrorReason(it),confusionPair:checked&&Object.hasOwn(checked,'confusionPair')?checked.confusionPair:it.q&&it.q.confusionPair||null});
    if(transferResult&&transferResult.status==='due_next_session'&&GS.itemOutcomes.length)GS.itemOutcomes[GS.itemOutcomes.length-1].transferStatus='due_next_session'}
  GS.phase='explain';if(gIsPracticeSession())gPersistRunner()
}
function gScheduleWrongExplanation(it,userWrong){var sessionId=GS.sessionId,itemId=it.q.id;
  setTimeout(function(){if(!GS||GS.sessionId!==sessionId||GS.phase!=='explain'||!GS.queue[GS.i]||GS.queue[GS.i].q.id!==itemId)return;gExplain(it,userWrong)},900)}
function gScheduleCorrectAdvance(it){var session=GS,itemId=it.q.id;
  setTimeout(function(){if(!GS||GS!==session||GS.phase!=='advance'||!GS.queue[GS.i]||GS.queue[GS.i].q.id!==itemId)return;GS.i++;GS.phase='question';if(gIsPracticeSession())gPersistRunner();gSync();save();gRenderQ()},600)}
function gPick(btn,i){var it=GS.queue[GS.i];if(!it||btn.dataset.done)return;var q=it.q;
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var checked=grammarModule.checkPracticeAnswer(it,i),ok=checked.correct;
  gAnswer(ok,it,checked);
  if(ok){ui.markAnswer(btn,'correct');gAnim('wpop','.35s');GS.phase='advance';if(gIsPracticeSession())gPersistRunner();
    gScheduleCorrectAdvance(it)}
  else{ui.markAnswer(btn,'wrong');
    all.forEach(function(b,bi){if(bi===q.a)ui.markAnswer(b,'correct')});
    gCommitWrongState(it,checked);gAnim('wshake','.42s');gScheduleWrongExplanation(it,q.o[i])}}
function gSubmit(){var it=GS.queue[GS.i];if(!it)return;var inp=document.getElementById('g_inp');if(!inp||inp.dataset.done)return;
  var q=it.q,userWrong=inp.value,checked=grammarModule.checkPracticeAnswer(it,userWrong),ok=checked.correct;
  inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  gAnswer(ok,it,checked);
  if(ok){gAnim('wpop','.35s');GS.phase='advance';if(gIsPracticeSession())gPersistRunner();gScheduleCorrectAdvance(it)}
  else{inp.value=q.ans[0];gCommitWrongState(it,checked);gAnim('wshake','.42s');gScheduleWrongExplanation(it,userWrong)}}
function gRenderCompletionPending(){var area=document.getElementById('g_area');if(!area||!GS)return;
  area.innerHTML='<div id="g_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:24px;text-align:center;">'+wDeco()
    +'<div style="font-size:44px;">⏳</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:10px;">Сохраняем результат…</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">Не закрывайте этот экран: точная сессия уже сохранена на устройстве и будет безопасно повторена.</div></div>'}
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
  var sessionLabel=mixed?'Смешанная практика':targeted?'Точечная практика · '+tp.n:tp.n,statusLine=mixed?'Результаты тем сверены с их доказательными сроками':targeted?view.label+' · '+gDateLine(view)+gRegressionLine(view):view.label+' · '+gDateLine(view)+gRegressionLine(view),retryAction=mixed?'gStartMixed()':targeted?'gStartTargeted()':'gStart('+finishedSession.t+')';
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:24px;">'+wDeco()
    +'<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14px 0;">'
    +'<div style="font-size:44px;">'+(provisional?'⏳':stable?'🏆':'💪')+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:10px;">'+(unsaved?'Результат не сохранён':provisional?'Результат ждёт синхронизации':stable?'Навык устойчив!':'Подход завершён')+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">'+sessionLabel+'<br>Верно: '+finishedSession.ok+' из '+finishedSession.done+'<br>'+(provisional?'СТАТУС ОБНОВИТСЯ ПОСЛЕ СИНХРОНИЗАЦИИ':statusLine)+(persistenceLine?'<br>'+persistenceLine:'')+(finishedSession.masteryAssisted?'<br>Ошибки и показанные ответы не повышают соответствующие темы':'')+'</div></div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +(stable?'':'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="'+(durable?retryAction:'gFinish()')+'">'+(durable?'Ещё подход':'Повторить синхронизацию')+'</button>')
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gToThemes()">К темам</button></div>';
  gAnim('win','.32s');gSync();save()}
async function gFinishRev(){var reviewSession=GS,area=document.getElementById('g_area'),rows='',finishedAt=Date.now();
  if(!reviewSession)return;
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
  for(let index=0;index<entries.length;index++){var t=entries[index].topicId,bad=reviewSession.errT[t],event=entries[index].event,result=resultsById.get(event.id)||batchResult,r=result&&result.record?result.record:gRec(t),line=gMasteryPersistenceLine(result)||batchLine,provisional=gMasteryProvisional(result)||batchProvisional;
    var view=grammarModule.masteryView(r,{now:finishedAt});
    var eventHistory=Array.isArray(r.masteryHistory)&&r.masteryHistory.find(function(item){return item&&item.eventId===event.id});
    var regressed=Boolean(event.passed===false&&!event.assisted&&result&&(result.applied||result.replay)
      &&eventHistory&&eventHistory.outcome==='regressed'&&r.lastRegressionReason);
    rows+='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div><div style="font-weight:700;font-size:13.5px;color:#2B2B2B;">'+G_TOPICS[t].n+'</div><div style="font-weight:600;font-size:11px;color:#777163;margin-top:4px;">'+(provisional?'СТАТУС ОБНОВИТСЯ ПОСЛЕ СИНХРОНИЗАЦИИ':gDateLine(view))+'</div>'+(provisional?'':gRegressionLine(view))+(line?'<div style="font-weight:700;font-size:11px;color:#A56000;margin-top:4px;">'+line+'</div>':'')+'</div>'
      +(provisional?'<span style="flex:none;font-weight:800;font-size:10px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ОЖИДАЕТ СИНХРОНИЗАЦИИ</span>'
        :regressed?'<span style="flex:none;font-weight:800;font-size:10px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">СНОВА В РАБОТЕ</span>'
           :'<span style="flex:none;font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">'+view.label.toUpperCase()+'</span>')
      +'</div>'}
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">🧠</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">'+(batchUnsaved?'Результат не сохранён':batchProvisional?'Результат ждёт синхронизации':'Повторение завершено')+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Верно: '+reviewSession.ok+' из '+reviewSession.done+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gToThemes()">К темам</button></div>';
  GS=null;gSync();save();gAnim('win','.32s')}
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
function gExamInput(index,value){if(!EX||!Number.isInteger(index)||index<0||index>=6)return;EX.answers[index]=String(value||'').slice(0,200);gPersistExamRunner()}
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
function gExamStart(contentRef){var adaptive=contentRef==='builtin:exam:grammar:19-24:v1';var pool=adaptive?G_EXAMS:gExamPool();
  if(!gMasteryQueueAvailable()){gShowMasteryQueueFull();return}
  S.examIdx=(S.examIdx||0);var ex=adaptive?G_EXAMS[0]:pool[S.examIdx%pool.length];if(!adaptive)S.examIdx++;
  if(EX&&EX.iv)clearInterval(EX.iv);
  var startedAt=Date.now();EX={ex:ex,t0:startedAt,sessionId:crypto.randomUUID(),source:adaptive||G_EXAMS.includes(ex)?'builtin':'generated',answers:['','','','','',''],
    evidence:gEvidence(grammarModule.activityId(null,'exam_19_24'),startedAt),iv:null};gPersistExamRunner();gExamRender()}
function gExamRender(){if(!EX)return;if(EX.iv)clearInterval(EX.iv);EX.iv=setInterval(function(){if(EX)setTxt('g_today',gExamFmt(Math.floor((Date.now()-EX.t0)/1000)))},1000);
  var ex=EX.ex;
  var area=document.getElementById('g_area');
  var txt='';
  ex.tx.forEach(function(seg,i){txt+=seg;
    if(i<6)txt+='<b style="color:#B54E2F;">'+(19+i)+'</b>&nbsp;<span style="display:inline-block;min-width:56px;border-bottom:2.5px dashed #F2683F;"></span>&nbsp;<b style="color:#777163;font-size:12px;">('+ex.gaps[i].b+')</b> '});
  var inputs=ex.gaps.map(function(g,i){
    return '<div style="display:flex;align-items:center;gap:10px;">'
      +'<span style="flex:none;width:64px;font-weight:800;font-size:12.5px;color:#B54E2F;">'+(19+i)+' · '+g.b+'</span>'
      +'<input id="g_ex_'+i+'" aria-label="Пропуск '+(19+i)+', форма слова '+g.b+'" value="'+ui.escapeHtml(EX.answers[i]||'')+'" oninput="gExamInput('+i+',this.value)" autocapitalize="none" autocomplete="off" spellcheck="false" style="flex:1;box-sizing:border-box;height:46px;border:1px solid #F0EAE2;border-radius:15px;padding:0 13px;font-family:Manrope,sans-serif;font-weight:700;font-size:14px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);"></div>'}).join('');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 19–24</span></div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.7;margin-top:12px;">'+txt+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:9px;">'+inputs
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:3px;" onclick="gExamCheck()">Проверить</button></div>';
  gAnim('win','.32s')}
async function gExamCheck(){if(!EX||EX.submitting)return;EX.submitting=true;var ex=EX.ex,evidence=EX.evidence,source=EX.source;
  clearInterval(EX.iv);var sec=examModule.elapsedSeconds(EX.t0,Date.now());
  EX.answers=ex.gaps.map(function(_g,i){var inp=document.getElementById('g_ex_'+i);return inp?inp.value:EX.answers[i]||''});gPersistExamRunner();
  var assessment;try{assessment=examModule.assessGrammar19To24({id:EX.sessionId,catalog:GRAMMAR_CATALOG,form:ex,answers:EX.answers,records:S.grammarMastery||{},startedAt:EX.t0,source:source})}
  catch(_){EX.submitting=false;gExamRender();return}
  var score=assessment.score,rows='',bank=assessment.errorBank,voiceErrors=[];
  var masteryResult=await gSubmitMasteryEvent(assessment.event.topicId,assessment.event.event);
  var provisional=gMasteryProvisional(masteryResult),unsaved=gMasteryUnsaved(masteryResult),persistenceLine=gMasteryPersistenceLine(masteryResult);
  ex.gaps.forEach(function(g,i){var learnerAnswer=EX.answers[i]||'';var ok=g.ans.some(function(a){return examModule.normalizeGrammarAnswer(a)===examModule.normalizeGrammarAnswer(learnerAnswer)});
    var voiceSlot='';
    if(!ok&&g.voice){var slotId='voice_tutor_grammar_'+i;voiceSlot='<div id="'+slotId+'"></div>';voiceErrors.push({slotId:slotId,module:'grammar',itemId:g.voice.id,revision:g.voice.revision,learnerAnswer:learnerAnswer})}
    rows+='<div style="padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<span style="font-weight:800;font-size:13px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(19+i)+' · '+g.b+' → '+g.ans[0]+'</span>'
      +(ok?'<span style="font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:4px 9px;border-radius:20px;">ВЕРНО</span>'
          :'<span style="font-weight:800;font-size:10px;color:#A83226;background:#FDEDEA;padding:4px 9px;border-radius:20px;">'+ui.escapeHtml(learnerAnswer||'—')+'</span>')
      +'</div>'
      +(ok?'':'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:4px;">'+g.e+'</div>'+voiceSlot)
      +'</div>'});
  if(!unsaved){
    S.exam19=examModule.record(S.exam19,score);
    evidence.score=score;evidence.maxScore=6;
    gReportEvidence(evidence,{mode:'exam_19_24',source:source,helpUsed:false,hintsUsed:0});
    if(bank.length&&typeof SRV!=='undefined'&&SRV&&TOKEN){apiPost('/api/v1/error-bank',{errors:bank}).catch(function(){})}
    EX=null;gClearRunner();save();gSync()
  }else{EX.submitting=false;gPersistExamRunner()}
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(score,6)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+score+' из 6</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+(score<6?' · слабые темы отмечены к повторению':'')+(provisional?' · статус обновится после синхронизации':'')+(unsaved?' · результат mastery не записан':'')+(persistenceLine?'<br>'+persistenceLine:'')+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +(unsaved?'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gExamCheck()">Повторить сохранение</button>'
      :(score<6?'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gStartTargeted()">Точная практика по ошибке</button>':'')
        +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gExamStart()">Ещё текст</button>'
        +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">К темам</button>')+'</div>';
  if(!unsaved)voiceErrors.forEach(function(details){registerVoiceTutorError(details).then(function(recorded){var slot=document.getElementById(details.slotId);if(slot&&recorded)slot.innerHTML=voiceTutorButton(recorded)}).catch(function(){})});
  gAnim('win','.32s');if(!unsaved)gExamGen()}
function launchGrammarExam(contentRef){if(contentRef!=='builtin:exam:grammar:19-24:v1')return false;gExamStart(contentRef);return true}
/* фоновая генерация новых экзаменационных текстов */
var G_EXGEN=false;
async function gExamGen(){
  if(G_EXGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  if(gExamPool().length>=8)return;G_EXGEN=true;
  try{
    var d=await generateAiContent('grammar_exam_19_24');
    var ex=validateGeneratedGrammarSupplement('grammar_exam_19_24',d);
    S.examAi=(S.examAi||[]).concat([ex]);save()
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
    var d=validateGeneratedGrammarSupplement('grammar_topic_set',await generateAiContent('grammar_topic_set',{topicId:t,topic:tp.n}));var add=[];
    d.c.forEach(function(q){add.push({k:'c',q:q,voice:q.voice||null})});
    d.f.forEach(function(q){add.push({k:'f',q:q,voice:q.voice||null})});
    if(add.length){S.gramAi=S.gramAi||{};S.gramAi[t]=((S.gramAi[t])||[]).concat(add);save()}
  }catch(e){}
  G_GEN=false}
registerRouteHook(function(id){if(id==='scr3')initGrammar()});
/* Экзамен по грамматике не должен тикать в фоне после ухода с экрана. */
registerRouteHook(function(id){if(id!=='scr3'){if(EX&&EX.iv)clearInterval(EX.iv);EX=null;GS=null}});
registerScreenGenerator('scr3',genGrammar);

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  gAfterExplain,gExam,gExamCheck,gExamInput,gExamStart,gFinish,gMap,gOpen,gPick,gResume,gReview,gStart,gStartMixed,gStartTargeted,gSubmit,launchGrammarExam,
  gTheory,gToThemes,
};
