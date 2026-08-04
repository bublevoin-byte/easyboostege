import { nav } from './router.js';
import { launchAdaptiveActivity } from './adaptive-activity-launch.js';

const STORAGE_KEY='easyboost.adaptive.execution.v1';
const STORAGE_VERSION=3;
const MAX_AGE_MS=3*60*60*1000;

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
function validPending(pending,active){if(!pending)return true;if(!pending||!['attempt','bind','advance'].includes(pending.phase)||!uuidValue(pending.advanceKey))return false;
  if(pending.phase==='attempt')return exactKeys(pending,['advanceKey','payload','phase'])&&exactKeys(pending.payload,['activity','adaptiveExecutionClaim','durationMs','id','maxScore','module','score'])
    &&uuidValue(pending.payload.id)&&pending.payload.module===active.module&&pending.payload.activity===active.activityId&&pending.payload.adaptiveExecutionClaim===active.executionClaim
    &&Number.isFinite(pending.payload.score)&&Number.isFinite(pending.payload.maxScore)&&pending.payload.maxScore>0&&pending.payload.score>=0&&pending.payload.score<=pending.payload.maxScore
    &&Number.isInteger(pending.payload.durationMs)&&pending.payload.durationMs>=0;
  return exactKeys(pending,['advanceKey','attempt','phase'])&&validAttempt(pending.attempt,active)}
function runtimeOwner(){try{const value=localStorage.getItem('eb_current');return typeof value==='string'&&value.length>0&&value.length<=64?value:null}catch(_){return null}}
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
function read(){try{const owner=runtimeOwner();const raw=localStorage.getItem(STORAGE_KEY)||'null';if(raw.length>30000)throw new Error('ADAPTIVE_RUNTIME_TOO_LARGE');const value=JSON.parse(raw);if(!owner||!value||!exactKeys(value,['active','control','lastResult','owner','savedAt','version'])||value.version!==STORAGE_VERSION||value.owner!==owner){localStorage.removeItem(STORAGE_KEY);return null}const savedAt=Number(value.savedAt||0);if(!Number.isFinite(savedAt)||savedAt<=0||Date.now()-savedAt>MAX_AGE_MS||savedAt-Date.now()>60_000||!validActive(value.active,savedAt)||!validControl(value.control)){localStorage.removeItem(STORAGE_KEY);return null}return value}catch(_){localStorage.removeItem(STORAGE_KEY);return null}}
function resultSnapshot(value){if(!value)return null;return {session:value.session||null,execution:value.execution||null,summary:value.summary||null,nextAction:value.nextAction||null,completedBlock:value.completedBlock||null,profileChange:value.profileChange||null,planChange:value.planChange||null}}
function write(value){const owner=runtimeOwner();const bounded={version:STORAGE_VERSION,owner,savedAt:Date.now(),active:value&&value.active||null,control:value&&value.control||null,lastResult:resultSnapshot(value&&value.lastResult)};try{if(owner)localStorage.setItem(STORAGE_KEY,JSON.stringify(bounded));else localStorage.removeItem(STORAGE_KEY)}catch(_){}return bounded}
function api(){if(!window.EasyBoostApi)throw new Error('ADAPTIVE_API_UNAVAILABLE');return window.EasyBoostApi}
function isNetworkError(error){return !navigator.onLine||String(error&&error.code)==='NETWORK_ERROR'||Number(error&&error.status)===0}
function isTerminalError(error){const status=Number(error&&error.status)||0;return status>=400&&status<500&&status!==429}
function clearTerminalState(){const state=read()||{};write({active:null,control:null,lastResult:state.lastResult||null})}
function storeConfirmedResult(result,{navigate=true}={}){write({active:null,control:null,lastResult:result});window.dispatchEvent(new CustomEvent('adaptive-session-return',{detail:result}));if(navigate)nav('scr10')}
function sameControl(control,phase,sessionId,blockId,revision){return Boolean(control&&control.phase===phase&&control.sessionId===sessionId&&Number(control.expectedRevision)===Number(revision)&&(phase==='finish'||control.blockId===blockId))}

export function adaptiveRuntimeSnapshot(){return read()||{version:STORAGE_VERSION,owner:runtimeOwner(),active:null,control:null,lastResult:null}}
export function clearAdaptiveRuntime(){try{localStorage.removeItem(STORAGE_KEY)}catch(_){}}
export function openAdaptivePlan(){nav('scr10')}

async function sendControl(state){
  const control=state&&state.control;if(!control)return false;
  if(control.phase==='start'){
    const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/start',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,
    },control.key);
    if(result&&result.recoveryAttempt){
      const recovery={
        phase:'recovery',sessionId:control.sessionId,blockId:control.blockId,
        expectedRevision:Number(result&&result.execution&&result.execution.revision),
        attempt:result.recoveryAttempt,key:uuid(),
      };
      if(!validControl(recovery))throw new Error('ADAPTIVE_START_RESPONSE_INVALID');
      const recoveryState=write({active:null,control:recovery,lastResult:state.lastResult||null});
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
    write({active,control:null,lastResult:state.lastResult||null});
    const launched=await launchAdaptiveActivity(result.launch,block.contentRef);
    if(!launched)throw new Error('ADAPTIVE_ACTIVITY_LAUNCH_FAILED');
    return true;
  }
  if(control.phase==='break'){
    const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/advance',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,attempt:null,
    },control.key);
    storeConfirmedResult(result);return result;
  }
  if(control.phase==='recovery'){
    const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/advance',{
      blockId:control.blockId,expectedRevision:control.expectedRevision,attempt:control.attempt,
    },control.key);
    storeConfirmedResult(result);return result;
  }
  const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(control.sessionId)+'/finish',{
    expectedRevision:control.expectedRevision,
  },control.key);
  storeConfirmedResult(result);return result;
}

export async function beginAdaptiveBlock(session,block,execution){
  if(!session||!block||block.kind!=='learning')throw new Error('ADAPTIVE_BLOCK_INVALID');
  let state=read()||write({active:null,control:null,lastResult:null});
  if(state.active&&state.active.sessionId===session.id&&state.active.blockId===block.id&&state.active.claimExpiresAt>Date.now()){
    return launchAdaptiveActivity(block.launch,block.contentRef);
  }
  const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'start',session.id,block.id,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control){state=write({active:null,control:{phase:'start',sessionId:session.id,blockId:block.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null})}
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState();throw error}
}

async function sendPending(state){
  const active=state&&state.active;if(!active||!active.pending)return false;
  const pending=active.pending;
  if(pending.phase==='attempt'){
    const recorded=await api().post('/api/v1/module-attempts',pending.payload);
    pending.attempt={type:'module',id:recorded.id};pending.phase='advance';write(state);
  }
  if(pending.phase==='bind'){
    await api().post('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(active.sessionId)+'/bind-attempt',{
      executionClaim:active.executionClaim,attempt:pending.attempt,
    });
    pending.phase='advance';write(state);
  }
  if(pending.phase==='advance'){
    const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(active.sessionId)+'/advance',{
      blockId:active.blockId,expectedRevision:active.expectedRevision,attempt:pending.attempt,
    },pending.advanceKey);
    storeConfirmedResult(result,{navigate:!['writing','speaking'].includes(active.module)});return result;
  }
  return false;
}

export async function completeAdaptiveModuleActivity({module,activityId,score,maxScore,durationMs}={}){
  const state=read(),active=state&&state.active;
  if(!active||active.pending||active.module!==module||active.activityId!==activityId||['writing','speaking'].includes(module))return false;
  const id=uuid();const maximum=Math.max(1,Number(maxScore)||1);
  active.pending={phase:'attempt',advanceKey:uuid(),payload:{
    id,module:active.module,activity:active.activityId,
    score:Math.min(maximum,Math.max(0,Number(score)||0)),maxScore:maximum,
    durationMs:Number.isFinite(durationMs)?Math.max(0,Math.round(durationMs)):Math.max(0,Date.now()-active.startedAt),
    adaptiveExecutionClaim:active.executionClaim,
  }};
  write(state);
  if(!navigator.onLine)return {queued:true};
  try{return await sendPending(state)}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState();throw error}
}

export async function completeAdaptiveServerAttempt(type,attemptId){
  if(!['writing','speaking'].includes(type)||!Number.isInteger(Number(attemptId)))return false;
  const state=read(),active=state&&state.active;
  if(!active||active.module!==type||active.pending)return false;
  active.pending={phase:'bind',advanceKey:uuid(),attempt:{type,id:Number(attemptId)}};
  write(state);
  if(!navigator.onLine)return {queued:true};
  try{return await sendPending(state)}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState();throw error}
}

export async function completeAdaptiveVoiceTutorRepeat({repeatId,taskId,answer,attemptId}={}){
  const state=read(),active=state&&state.active;
  if(!active||active.pending||active.activityId!=='voice_tutor_recovery'||!uuidValue(repeatId)||!uuidValue(attemptId)
    ||typeof taskId!=='string'||typeof answer!=='string'||!answer.trim())return false;
  const result=await api().post('/api/v1/voice-tutor/repeats/'+encodeURIComponent(repeatId)+'/attempts',{
    attemptId,taskId,answer:answer.trim(),adaptiveExecutionClaim:active.executionClaim,adaptiveSessionId:active.sessionId,
  });
  const reference={type:'voice_tutor_repeat',id:String(result&&result.attempt&&result.attempt.id||'')};
  if(!validAttempt(reference,active))throw new Error('ADAPTIVE_REPEAT_RESPONSE_INVALID');
  active.pending={phase:'advance',advanceKey:uuid(),attempt:reference};write(state);
  try{const advanced=await sendPending(state);return {attempt:result.attempt,adaptive:true,advanced}}catch(error){if(isNetworkError(error))return {queued:true};if(isTerminalError(error))clearTerminalState();throw error}
}

export async function advanceAdaptiveBreak(session,block,execution){
  let state=read()||write({active:null,control:null,lastResult:null});const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'break',session.id,block.id,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control)state=write({active:null,control:{phase:'break',sessionId:session.id,blockId:block.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null});
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState();throw error}
}

export async function finishAdaptiveSession(session,execution){
  let state=read()||write({active:null,control:null,lastResult:null});const revision=Number(execution&&execution.revision||0);
  if(state.control&&!sameControl(state.control,'finish',session.id,null,revision))throw new Error('ADAPTIVE_CONTROL_OPERATION_PENDING');
  if(!state.control)state=write({active:null,control:{phase:'finish',sessionId:session.id,expectedRevision:revision,key:uuid()},lastResult:state.lastResult||null});
  if(!navigator.onLine)throw Object.assign(new Error('offline'),{code:'NETWORK_ERROR',status:0});
  try{return await sendControl(state)}catch(error){if(isTerminalError(error))clearTerminalState();throw error}
}

export async function resumeAdaptiveExecution(){
  const state=read();if(!state||!navigator.onLine)return false;
  try{if(state.control)return await sendControl(state);if(state.active&&state.active.pending)return await sendPending(state);return false}
  catch(error){if(isNetworkError(error))return false;if(isTerminalError(error))clearTerminalState();throw error}
}

window.addEventListener('online',function(){resumeAdaptiveExecution().catch(function(){})});
