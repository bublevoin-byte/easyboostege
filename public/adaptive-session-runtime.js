import { nav } from './router.js';
import { launchAdaptiveActivity } from './adaptive-activity-launch.js';

const STORAGE_KEY='easyboost.adaptive.execution.v1';
const STORAGE_VERSION=4;
const MAX_AGE_MS=3*60*60*1000;
let activeRuntimeLockContext=null;
function runtimeStorageKey(owner,ownerGeneration){return STORAGE_KEY+':'+encodeURIComponent(owner)+':g'+ownerGeneration}

function uuid(){if(globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function')return globalThis.crypto.randomUUID();const hex='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';return hex.replace(/[xy]/gu,function(char){const value=Math.floor(Math.random()*16);return (char==='x'?value:(value&3)|8).toString(16)})}
function uuidValue(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value||''))}
function blockIdValue(value){return /^asb_[0-9a-f]{16}_[0-9]{2}$/u.test(String(value||''))}
function revisionValue(value){return Number.isInteger(Number(value))&&Number(value)>=0}
function exactKeys(value,keys){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify(keys.slice().sort())}
function validAttemptReference(attempt){return Boolean(attempt&&exactKeys(attempt,['type','id'])
  &&(['module','voice_tutor_repeat'].includes(attempt.type)?uuidValue(attempt.id):
    ['writing','speaking'].includes(attempt.type)&&Number.isInteger(Number(attempt.id))&&Number(attempt.id)>0))}
function validAttempt(attempt,active){return Boolean(validAttemptReference(attempt)
  &&(attempt.type==='module'?!['writing','speaking'].includes(active.module)
    :attempt.type==='voice_tutor_repeat'?active.activityId==='voice_tutor_recovery':attempt.type===active.module))}
function assistedMetadata(value){if(!value||typeof value!=='object'||Array.isArray(value)||value.helpUsed!==true)return null;
  const result={helpUsed:true};
  if(typeof value.mode==='string'&&/^[a-z0-9_]{3,80}$/u.test(value.mode))result.mode=value.mode;
  if(typeof value.source==='string'&&/^[a-z0-9_]{3,80}$/u.test(value.source))result.source=value.source;
  if(Number.isInteger(value.hintsUsed)&&value.hintsUsed>=0&&value.hintsUsed<=100)result.hintsUsed=value.hintsUsed;
  return result}
function readingMetadata(value){if(!value||typeof value!=='object'||Array.isArray(value)
  ||value.readingProvenance!=='canonical'||!['reading_headings','reading_gaps','reading_detail'].includes(value.mode)
  ||value.source!=='catalog'||typeof value.helpUsed!=='boolean'||!Number.isInteger(value.hintsUsed)||value.hintsUsed<0||value.hintsUsed>100
  ||!/^reading-pilot-v1\.(?:task10|task11|task12_18)\.[a-z0-9-]{1,100}$/u.test(String(value.readingSetId||''))
  ||!Number.isInteger(value.readingSetRevision)||value.readingSetRevision<1||value.readingSetRevision>10000
  ||!['task10','task11','task12_18'].includes(value.readingKind)||!['B1','B2','B2+/C1'].includes(value.readingCefr)
  ||!/^builtin:reading:(?:task10|task11|task12_18):(?:b1|b2|b2-plus-c1):v1$/u.test(String(value.readingContentRef||''))
  ||!/^[A-Za-z0-9:._-]{8,180}$/u.test(String(value.readingAttemptId||''))||!['gist','detail'].includes(value.readingSlice))return null;
  return {mode:value.mode,source:'catalog',helpUsed:value.helpUsed,hintsUsed:value.hintsUsed,
    readingProvenance:'canonical',readingSetId:value.readingSetId,readingSetRevision:value.readingSetRevision,
    readingKind:value.readingKind,readingCefr:value.readingCefr,readingContentRef:value.readingContentRef,
    readingAttemptId:value.readingAttemptId,readingSlice:value.readingSlice,
    ...(typeof value.readingIndependent==='boolean'?{readingIndependent:value.readingIndependent}:{})}}
function completionMetadata(value,active){return active&&active.module==='reading'?readingMetadata(value):assistedMetadata(value)}
function validPending(pending,active){if(!pending)return true;if(!pending||!['attempt','bind','advance'].includes(pending.phase)||!uuidValue(pending.advanceKey))return false;
  if(pending.phase==='attempt'){const payloadKeys=['activity','adaptiveExecutionClaim','durationMs','id','maxScore','module','score'];
    const keysValid=exactKeys(pending.payload,payloadKeys)||exactKeys(pending.payload,payloadKeys.concat('metadata'));
    return exactKeys(pending,['advanceKey','payload','phase'])&&keysValid
    &&uuidValue(pending.payload.id)&&pending.payload.module===active.module&&pending.payload.activity===active.activityId&&pending.payload.adaptiveExecutionClaim===active.executionClaim
    &&Number.isFinite(pending.payload.score)&&Number.isFinite(pending.payload.maxScore)&&pending.payload.maxScore>0&&pending.payload.score>=0&&pending.payload.score<=pending.payload.maxScore
    &&Number.isInteger(pending.payload.durationMs)&&pending.payload.durationMs>=0
    &&(!Object.hasOwn(pending.payload,'metadata')||Boolean(completionMetadata(pending.payload.metadata,active)))}
  return exactKeys(pending,['advanceKey','attempt','phase'])&&validAttempt(pending.attempt,active)}
function runtimeOwnerMarker(){try{try{const session=JSON.parse(sessionStorage.getItem('eb_owner_generation_session_v1')||'null');
    if(session&&typeof session.owner==='string'&&session.owner.length>0&&session.owner.length<=64
      &&Number.isSafeInteger(session.generation)&&session.generation>=0)return{owner:session.owner,ownerGeneration:session.generation}}catch(_){}
  const fromStore=window.EasyBoostStore&&window.EasyBoostStore.readCurrentOwner?.();if(fromStore)return fromStore;
  const raw=localStorage.getItem('eb_current');if(!raw)return null;try{const parsed=JSON.parse(raw);if(parsed&&parsed.version===1
    &&typeof parsed.owner==='string'&&parsed.owner.length>0&&parsed.owner.length<=64&&Number.isSafeInteger(parsed.ownerGeneration)&&parsed.ownerGeneration>=0)
    return{owner:parsed.owner,ownerGeneration:parsed.ownerGeneration}}catch(_){}return typeof raw==='string'&&raw.length>0&&raw.length<=64?{owner:raw,ownerGeneration:0}:null}catch(_){return null}}
function runtimeOwner(){return runtimeOwnerMarker()?.owner||null}
function runtimeOwnerGeneration(owner=runtimeOwner()){try{const service=window.EasyBoostSync;if(!owner||!service)return null;
  const bound=service.ownerBoundGeneration(owner),authority=service.ownerAuthSnapshot(owner);
  return Number.isSafeInteger(bound)&&authority&&!authority.deleted&&authority.ownerGeneration===bound?bound:null}catch(_){return null}}
function validActive(active,savedAt){return !active||Boolean(active&&exactKeys(active,['activityId','blockId','claimExpiresAt','contentRef','evidenceContext','executionClaim','expectedRevision','module','pending','sessionId','startedAt'])
  &&uuidValue(active.sessionId)&&blockIdValue(active.blockId)
  &&/^[A-Za-z0-9_-]{32,200}$/u.test(String(active.executionClaim||''))
  &&['vocabulary','grammar','reading','listening','writing','speaking','exam'].includes(active.module)
  &&/^[a-z0-9_]{1,100}$/u.test(String(active.activityId||''))
  &&/^[A-Za-z0-9:._-]{1,240}$/u.test(String(active.contentRef||''))
  &&['exam_practice','planned_practice','scheduled_review','ai_assisted_review'].includes(active.evidenceContext)
  &&revisionValue(active.expectedRevision)
  &&Number.isFinite(Number(active.claimExpiresAt))&&Number(active.claimExpiresAt)>Number(active.startedAt)
  &&Number.isFinite(Number(active.startedAt))&&Number(active.startedAt)>0&&Number(active.startedAt)<=Number(savedAt)
  &&Number(active.claimExpiresAt)-Number(active.startedAt)<=2*60*60*1000+60_000
  &&validPending(active.pending,active))}
function validControl(control){if(!control)return true;if(!control||!uuidValue(control.key)||!uuidValue(control.sessionId)||!revisionValue(control.expectedRevision))return false;
  if(control.phase==='start')return exactKeys(control,['blockId','expectedRevision','key','phase','sessionId'])&&blockIdValue(control.blockId);
  if(control.phase==='break')return exactKeys(control,['blockId','expectedRevision','key','phase','sessionId'])&&blockIdValue(control.blockId);
  if(control.phase==='recovery')return exactKeys(control,['attempt','blockId','expectedRevision','key','phase','sessionId'])
    &&blockIdValue(control.blockId)&&validAttemptReference(control.attempt);
  if(control.phase==='finish')return exactKeys(control,['expectedRevision','key','phase','sessionId']);
  return false}
function runtimeEnvelopeKeys(){return['active','control','lastResult','owner','ownerGeneration','revision','runtimeId','savedAt','version']}
function runtimeAuthorityCurrent(value){try{if(!value||value.version!==STORAGE_VERSION||!uuidValue(value.runtimeId)||!Number.isSafeInteger(value.revision)
    ||runtimeOwner()!==value.owner||runtimeOwnerGeneration(value.owner)!==value.ownerGeneration)return false;
  const stored=JSON.parse(localStorage.getItem(runtimeStorageKey(value.owner,value.ownerGeneration))||'null');
  return Boolean(stored&&exactKeys(stored,runtimeEnvelopeKeys())&&stored.version===STORAGE_VERSION
    &&stored.owner===value.owner&&stored.ownerGeneration===value.ownerGeneration
    &&stored.runtimeId===value.runtimeId&&stored.revision===value.revision)}catch(_){return false}}
function ownerChangedError(){return Object.assign(new Error('adaptive owner or runtime changed'),{code:'OWNER_CHANGED',status:409})}
function assertRuntimeAuthority(value){if(!runtimeAuthorityCurrent(value))throw ownerChangedError();return value}
function runtimeLockError(){return Object.assign(new Error('adaptive runtime lock unavailable'),{code:'ADAPTIVE_RUNTIME_LOCK_UNAVAILABLE',status:0})}
function withRuntimeLock(operation){const owner=runtimeOwner(),ownerGeneration=runtimeOwnerGeneration(owner);
  const locks=globalThis.navigator&&globalThis.navigator.locks;
  const service=window.EasyBoostSync;
  if(!owner||!Number.isSafeInteger(ownerGeneration)||!locks||typeof locks.request!=='function'
    ||!service||typeof service.withOwnerIncarnationLock!=='function')return Promise.reject(runtimeLockError());
  let entered=false;
  return service.withOwnerIncarnationLock({owner,ownerGeneration},function(ownerLockToken){entered=true;
    return locks.request('easyboost-adaptive-runtime:'+owner+':'+ownerGeneration,{mode:'exclusive'},async function(lock){
      if(!lock||runtimeOwner()!==owner||runtimeOwnerGeneration(owner)!==ownerGeneration)throw ownerChangedError();
      activeRuntimeLockContext={owner,ownerGeneration,ownerLockToken};
      try{return await operation({owner,ownerGeneration,ownerLockToken})}finally{activeRuntimeLockContext=null}
    })
  }).then(function(result){if(!entered)throw result&&result.code==='GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE'?runtimeLockError():ownerChangedError();return result})
    .catch(async function(error){await invalidateRuntimeAuthority(error,{owner:owner,ownerGeneration:ownerGeneration});throw error})}
function attachRuntimeState(error,state){if(error&&typeof error==='object'&&!error.runtimeState)error.runtimeState=state;return error}
function read(){try{const owner=runtimeOwner(),ownerGeneration=runtimeOwnerGeneration(owner);const key=runtimeStorageKey(owner,ownerGeneration);
  const scopedRaw=localStorage.getItem(key);const legacyKey=!scopedRaw&&ownerGeneration===0?STORAGE_KEY:null;const raw=scopedRaw||legacyKey&&localStorage.getItem(legacyKey)||'null';if(raw.length>30000)return null;const value=JSON.parse(raw);
  const legacy=Boolean(value&&value.version===3&&exactKeys(value,['active','control','lastResult','owner','savedAt','version']));
  const current=Boolean(value&&value.version===STORAGE_VERSION&&exactKeys(value,runtimeEnvelopeKeys())
    &&uuidValue(value.runtimeId)&&Number.isSafeInteger(value.revision)&&value.revision>=0);
  if(!owner||!Number.isSafeInteger(ownerGeneration)||!value||(!legacy&&!current)||value.owner!==owner
    ||legacy&&ownerGeneration!==0||current&&value.ownerGeneration!==ownerGeneration){
    const storedGeneration=legacy?0:current?value.ownerGeneration:null;
    if(value&&typeof value.owner==='string'&&Number.isSafeInteger(storedGeneration))void clearAdaptiveRuntime({owner:value.owner,ownerGeneration:storedGeneration,runtimeId:value.runtimeId,revision:value.revision});
    return null}
  const savedAt=Number(value.savedAt||0);if(!Number.isFinite(savedAt)||savedAt<=0||Date.now()-savedAt>MAX_AGE_MS||savedAt-Date.now()>60_000||!validActive(value.active,savedAt)||!validControl(value.control)){
    void clearAdaptiveRuntime({owner:value.owner,ownerGeneration:legacy?0:value.ownerGeneration,runtimeId:value.runtimeId,revision:value.revision});
    return null}
  if(!legacyKey&&!legacy)return value;
  const migrated=legacy?{...value,version:STORAGE_VERSION,ownerGeneration:ownerGeneration,runtimeId:uuid(),revision:0}:value;
  if(activeRuntimeLockContext&&activeRuntimeLockContext.owner===owner&&activeRuntimeLockContext.ownerGeneration===ownerGeneration
    &&localStorage.getItem(legacyKey||key)===raw){localStorage.setItem(key,JSON.stringify(migrated));if(legacyKey)localStorage.removeItem(legacyKey);
    if(runtimeAuthorityCurrent(migrated))return migrated;void clearAdaptiveRuntime(migrated)}
  return migrated}catch(_){return null}}
function resultSnapshot(value){if(!value)return null;return {session:value.session||null,execution:value.execution||null,summary:value.summary||null,nextAction:value.nextAction||null,completedBlock:value.completedBlock||null,profileChange:value.profileChange||null,planChange:value.planChange||null}}
function removeExactRuntime(value){try{const key=runtimeStorageKey(value&&value.owner,value&&value.ownerGeneration);const stored=JSON.parse(localStorage.getItem(key)||'null');
  if(stored&&value&&stored.owner===value.owner&&stored.ownerGeneration===value.ownerGeneration&&stored.runtimeId===value.runtimeId&&stored.revision===value.revision)localStorage.removeItem(key)}catch(_){}}
function write(value){try{const bound=Boolean(value&&value.version===STORAGE_VERSION&&uuidValue(value.runtimeId)&&Number.isSafeInteger(value.revision));
  const owner=bound?value.owner:runtimeOwner(),ownerGeneration=bound?value.ownerGeneration:runtimeOwnerGeneration(owner);
  if(!owner||!Number.isSafeInteger(ownerGeneration)||bound&&!runtimeAuthorityCurrent(value))return null;
  const bounded={version:STORAGE_VERSION,owner,ownerGeneration,runtimeId:bound?value.runtimeId:uuid(),revision:bound?value.revision+1:0,
    savedAt:Date.now(),active:value&&value.active||null,control:value&&value.control||null,lastResult:resultSnapshot(value&&value.lastResult)};
  localStorage.setItem(runtimeStorageKey(owner,ownerGeneration),JSON.stringify(bounded));if(!runtimeAuthorityCurrent(bounded)){removeExactRuntime(bounded);return null}return bounded}catch(_){return null}}
function requireWrite(value){const written=write(value);if(!written)throw ownerChangedError();return written}
function api(){if(!window.EasyBoostApi)throw new Error('ADAPTIVE_API_UNAVAILABLE');return window.EasyBoostApi}
function sync(){if(!window.EasyBoostSync)throw Object.assign(new Error('adaptive sync unavailable'),{code:'NETWORK_ERROR',status:0});return window.EasyBoostSync}
function ownerHeaders(state){return{'X-EasyBoost-Expected-Owner':state.owner}}
function boundResult(result,state){assertRuntimeAuthority(state);if(!result||api().responseOwner(result)!==state.owner)throw ownerChangedError();return result}
async function invalidateRuntimeAuthority(error,state){if(api().isAuthorityFailure?.(error)&&state){const invalidate=window.EasyBoostAuthority&&window.EasyBoostAuthority.invalidate;if(typeof invalidate==='function')await invalidate({owner:state.owner,ownerGeneration:state.ownerGeneration})}}
async function boundPost(state,path,body){return boundResult(await api().post(path,body,ownerHeaders(state)),state)}
async function boundPostIdempotent(state,path,body,key){return boundResult(await api().postIdempotent(path,body,key,ownerHeaders(state)),state)}
function isNetworkError(error){return !navigator.onLine||String(error&&error.code)==='NETWORK_ERROR'||Number(error&&error.status)===0}
function isTerminalError(error){const status=Number(error&&error.status)||0;return status>=400&&status<500&&status!==429}
function isTerminalVoiceClaimError(error){return['ADAPTIVE_EXECUTION_CLAIM_INVALID','ADAPTIVE_EXECUTION_CLAIM_EXPIRED','ADAPTIVE_EXECUTION_CLAIM_CONSUMED','ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH'].includes(String(error&&error.code||''))}
function clearTerminalState(state){if(!state)return false;return Boolean(write({...state,active:null,control:null,lastResult:state.lastResult||null}))}
function storeConfirmedResult(result,state,{navigate=true}={}){requireWrite({...state,active:null,control:null,lastResult:result});window.dispatchEvent(new CustomEvent('adaptive-session-return',{detail:result}));if(navigate)nav('scr10')}
function sameControl(control,phase,sessionId,blockId,revision){return Boolean(control&&control.phase===phase&&control.sessionId===sessionId&&Number(control.expectedRevision)===Number(revision)&&(phase==='finish'||control.blockId===blockId))}

export function adaptiveRuntimeSnapshot(){return read()||{version:STORAGE_VERSION,owner:runtimeOwner(),ownerGeneration:runtimeOwnerGeneration(),runtimeId:null,revision:0,active:null,control:null,lastResult:null}}
export function adaptiveSessionReplacementAvailable(session,execution,runtime=adaptiveRuntimeSnapshot()){
  if(!session||!execution||session.replacement||session.status!=='created'||execution.status!=='created'
    ||Number(execution.revision||0)!==0||execution.startedAt||(execution.completedBlockIds||[]).length)return false;
  const localActive=runtime&&runtime.active&&runtime.active.sessionId===session.id;
  const localControl=runtime&&runtime.control&&runtime.control.sessionId===session.id;
  return !localActive&&!localControl
}
export function clearAdaptiveRuntime(authority=null){try{const owner=authority&&authority.owner||runtimeOwner();const ownerGeneration=authority&&authority.ownerGeneration;
  const expectedGeneration=Number.isSafeInteger(ownerGeneration)?ownerGeneration:runtimeOwnerGeneration(owner);
  const key=runtimeStorageKey(owner,expectedGeneration);const raw=localStorage.getItem(key);let stored=null;if(raw){stored=JSON.parse(raw);
    const storedGeneration=stored&&stored.version===3?0:stored&&stored.ownerGeneration;
    if(!stored||stored.owner!==owner||storedGeneration!==expectedGeneration)return false;
    if(authority&&authority.runtimeId&&stored.runtimeId!==authority.runtimeId)return false;
    if(authority&&Number.isSafeInteger(authority.revision)&&stored.revision!==authority.revision)return false}
  const legacyMatcher=function(candidate){try{const value=JSON.parse(candidate);
    return value&&value.owner===owner&&(value.version===3||value.ownerGeneration===0)}catch(_){return false}};
  if(expectedGeneration===0&&!raw)return window.EasyBoostOwnerIncarnation.clearMatchingStorage(owner,STORAGE_KEY,legacyMatcher);
  const clearScoped=raw?window.EasyBoostOwnerIncarnation.clearMatchingStorage(owner,key,function(candidate){try{const value=JSON.parse(candidate);
    const generation=value&&value.version===3?0:value&&value.ownerGeneration;
    return value&&value.owner===owner&&generation===expectedGeneration
      &&(!authority?.runtimeId||value.runtimeId===authority.runtimeId)
      &&(!Number.isSafeInteger(authority?.revision)||value.revision===authority.revision)}catch(_){return false}}):Promise.resolve(true);
  if(expectedGeneration!==0)return clearScoped;
  return Promise.resolve(clearScoped).then(function(cleared){return window.EasyBoostOwnerIncarnation.clearMatchingStorage(owner,STORAGE_KEY,legacyMatcher).then(function(legacyCleared){return Boolean(cleared&&legacyCleared)})})
  }catch(_){return Promise.resolve(false)}}
export function openAdaptivePlan(){nav('scr10')}

async function sendControl(state){
  const control=state&&state.control;if(!control)return false;
  try{
  if(control.phase==='start'){
    const result=await boundPostIdempotent(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/start',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,
    },control.key);
    if(result&&result.recoveryAttempt){
      const recovery={
        phase:'recovery',sessionId:control.sessionId,blockId:control.blockId,
        expectedRevision:Number(result&&result.execution&&result.execution.revision),
        attempt:result.recoveryAttempt,key:uuid(),
      };
      if(!validControl(recovery))throw new Error('ADAPTIVE_START_RESPONSE_INVALID');
      const recoveryState=requireWrite({...state,active:null,control:recovery,lastResult:state.lastResult||null});
      return sendControl(recoveryState);
    }
    const block=result&&result.block;
    const startedAt=Date.now();const claimExpiresAt=new Date(result&&result.claimExpiresAt).getTime();
    const evidenceContext=result&&result.evidenceContext||(
      ['writing','speaking'].includes(block&&block.module)?'ai_assisted_review':result&&result.launch&&result.launch.kind==='exam_workflow'?'exam_practice':(block&&block.reasonCodes||[]).includes('due_review')?'scheduled_review':'planned_practice');
    const active={
      sessionId:control.sessionId,blockId:control.blockId,module:block&&block.module,activityId:block&&block.activityId,
      contentRef:block&&block.contentRef,executionClaim:result&&result.executionClaim,
      claimExpiresAt,expectedRevision:Number(result&&result.execution&&result.execution.revision),
      startedAt,evidenceContext,pending:null,
    };
    if(!validActive(active,startedAt))throw new Error('ADAPTIVE_START_RESPONSE_INVALID');
    const startedState=requireWrite({...state,active,control:null,lastResult:state.lastResult||null});
    assertRuntimeAuthority(startedState);
    const launched=await launchAdaptiveActivity(result.launch,block.contentRef,()=>runtimeAuthorityCurrent(startedState));
    assertRuntimeAuthority(startedState);
    if(!launched)throw new Error('ADAPTIVE_ACTIVITY_LAUNCH_FAILED');
    return true;
  }
  if(control.phase==='break'){
    const result=await boundPostIdempotent(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/advance',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,attempt:null,
    },control.key);
    storeConfirmedResult(result,state);return result;
  }
  if(control.phase==='recovery'){
    const result=await boundPostIdempotent(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/advance',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,attempt:control.attempt,
    },control.key);
    storeConfirmedResult(result,state);return result;
  }
  const result=await boundPostIdempotent(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/finish',{
    expectedRevision:control.expectedRevision,
  },control.key);
  storeConfirmedResult(result,state);return result;
  }catch(error){throw attachRuntimeState(error,state)}
}

async function beginAdaptiveBlockUnlocked(session,block,execution){
  if(!session||!block||block.kind!=='learning')throw new Error('ADAPTIVE_BLOCK_INVALID');
  let state=read()||requireWrite({active:null,control:null,lastResult:null});
  if(state.active&&state.active.sessionId===session.id&&state.active.blockId===block.id&&state.active.claimExpiresAt>Date.now()){
    assertRuntimeAuthority(state);const launched=await launchAdaptiveActivity(block.launch,block.contentRef,()=>runtimeAuthorityCurrent(state));assertRuntimeAuthority(state);return launched;
  }
  const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'start',session.id,block.id,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control){state=requireWrite({...state,active:null,control:{phase:'start',sessionId:session.id,blockId:block.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null})}
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function sendPending(initialState,runtimeGuard=null){
  let state=initialState;
  const active=state&&state.active;if(!active||!active.pending)return false;
  const pending=active.pending;
  try{
  if(pending.phase==='attempt'){
    const owner=state.owner,ownerGeneration=state.ownerGeneration;
    if(!owner||runtimeOwner()!==owner||!Number.isSafeInteger(ownerGeneration)||runtimeOwnerGeneration(owner)!==ownerGeneration)
      throw Object.assign(new Error('adaptive owner changed'),{code:'OWNER_CHANGED',status:409});
    const saved=await sync().saveModuleAttempt(pending.payload,{owner,ownerGeneration,ownerLockToken:runtimeGuard&&runtimeGuard.ownerLockToken});
    assertRuntimeAuthority(state);
    if(saved!==true&&(!saved||saved.status!=='delivered')){
      const terminal=saved&&['terminal_rejected','owner_conflict'].includes(saved.status);
      throw Object.assign(new Error(terminal?'adaptive attempt rejected':'adaptive attempt not yet synced'),{
        code:saved&&saved.code||'NETWORK_ERROR',status:terminal?409:0,
      });
    }
    pending.attempt={type:'module',id:pending.payload.id};pending.phase='advance';state=requireWrite(state);
  }
  if(pending.phase==='bind'){
    await boundPost(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(active.sessionId)+'/bind-attempt',{
      executionClaim:active.executionClaim,attempt:pending.attempt,
    });
    pending.phase='advance';state=requireWrite(state);
  }
  if(pending.phase==='advance'){
    const result=await boundPostIdempotent(state,'/api/v1/adaptive-learning/sessions/'+encodeURIComponent(active.sessionId)+'/advance',{
      blockId:active.blockId,expectedRevision:active.expectedRevision,attempt:pending.attempt,
    },pending.advanceKey);
    storeConfirmedResult(result,state,{navigate:!['writing','speaking'].includes(active.module)});return result;
  }
  return false;
  }catch(error){throw attachRuntimeState(error,state)}
}

async function completeAdaptiveModuleActivityUnlocked({module,activityId,score,maxScore,durationMs,metadata}={},runtimeGuard=null){
  let state=read();const active=state&&state.active;
  if(!active||active.pending||active.module!==module||active.activityId!==activityId||['writing','speaking'].includes(module))return false;
  const safeMetadata=completionMetadata(metadata,active);
  if(module==='reading'&&(!safeMetadata||safeMetadata.readingContentRef!==active.contentRef))return false;
  const id=uuid();const maximum=Math.max(1,Number(maxScore)||1);
  active.pending={phase:'attempt',advanceKey:uuid(),payload:{
    id,module:active.module,activity:active.activityId,
    score:Math.min(maximum,Math.max(0,Number(score)||0)),maxScore:maximum,
    durationMs:Number.isFinite(durationMs)?Math.max(0,Math.round(durationMs)):Math.max(0,Date.now()-active.startedAt),
    adaptiveExecutionClaim:active.executionClaim,
    ...(safeMetadata?{metadata:safeMetadata}:{}),
  }};
  state=requireWrite(state);
  if(!navigator.onLine)return {queued:true};
  try{return await sendPending(state,runtimeGuard)}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function completeAdaptiveServerAttemptUnlocked(type,attemptId,runtimeGuard=null){
  if(!['writing','speaking'].includes(type)||!Number.isInteger(Number(attemptId)))return false;
  let state=read();const active=state&&state.active;
  if(!active||active.module!==type||active.pending)return false;
  active.pending={phase:'bind',advanceKey:uuid(),attempt:{type,id:Number(attemptId)}};
  state=requireWrite(state);
  if(!navigator.onLine)return {queued:true};
  try{return await sendPending(state,runtimeGuard)}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function completeAdaptiveVoiceTutorRepeatUnlocked({repeatId,taskId,answer,attemptId}={},runtimeGuard=null){
  let state=read();const active=state&&state.active;
  if(!active||active.pending||active.activityId!=='voice_tutor_recovery'||!uuidValue(repeatId)||!uuidValue(attemptId)
    ||typeof taskId!=='string'||typeof answer!=='string'||!answer.trim())return false;
  let result;
  try{result=await boundPost(state,'/api/v1/voice-tutor/repeats/'+encodeURIComponent(repeatId)+'/attempts',{
    attemptId,taskId,answer:answer.trim(),adaptiveExecutionClaim:active.executionClaim,adaptiveSessionId:active.sessionId,
  })}catch(error){attachRuntimeState(error,state);if(isTerminalVoiceClaimError(error))clearTerminalState(state);throw error}
  const reference={type:'voice_tutor_repeat',id:String(result&&result.attempt&&result.attempt.id||'')};
  if(!validAttempt(reference,active))throw new Error('ADAPTIVE_REPEAT_RESPONSE_INVALID');
  active.pending={phase:'advance',advanceKey:uuid(),attempt:reference};state=requireWrite(state);
  try{const advanced=await sendPending(state,runtimeGuard);return {attempt:result.attempt,adaptive:true,advanced}}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function advanceAdaptiveBreakUnlocked(session,block,execution){
  let state=read()||requireWrite({active:null,control:null,lastResult:null});const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'break',session.id,block.id,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control)state=requireWrite({...state,active:null,control:{phase:'break',sessionId:session.id,blockId:block.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null});
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function finishAdaptiveSessionUnlocked(session,execution){
  let state=read()||requireWrite({active:null,control:null,lastResult:null});const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'finish',session.id,null,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control)state=requireWrite({...state,active:null,control:{phase:'finish',sessionId:session.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null});
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

async function resumeAdaptiveExecutionUnlocked(runtimeGuard=null){
  const state=read();if(!state||!navigator.onLine)return false;
  try{if(state.control)return await sendControl(state);if(state.active&&state.active.pending)return await sendPending(state,runtimeGuard);return false}
  catch(error){if(isNetworkError(error))return false;if(isTerminalError(error))clearTerminalState(error.runtimeState||state);throw error}
}

export function beginAdaptiveBlock(session,block,execution){return withRuntimeLock(()=>beginAdaptiveBlockUnlocked(session,block,execution))}
export function completeAdaptiveModuleActivity(payload){return withRuntimeLock((guard)=>completeAdaptiveModuleActivityUnlocked(payload,guard))}
export function completeAdaptiveServerAttempt(type,attemptId){return withRuntimeLock((guard)=>completeAdaptiveServerAttemptUnlocked(type,attemptId,guard))}
export function completeAdaptiveVoiceTutorRepeat(payload){return withRuntimeLock((guard)=>completeAdaptiveVoiceTutorRepeatUnlocked(payload,guard))}
export function advanceAdaptiveBreak(session,block,execution){return withRuntimeLock(()=>advanceAdaptiveBreakUnlocked(session,block,execution))}
export function finishAdaptiveSession(session,execution){return withRuntimeLock(()=>finishAdaptiveSessionUnlocked(session,execution))}
export function resumeAdaptiveExecution(){return withRuntimeLock((guard)=>resumeAdaptiveExecutionUnlocked(guard))}

window.addEventListener('online',function(){resumeAdaptiveExecution().catch(function(){})});
