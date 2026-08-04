import { nav } from './router.js';
import { launchAdaptiveActivity } from './adaptive-activity-launch.js';

const STORAGE_KEY='easyboost.adaptive.execution.v1';
const MAX_AGE_MS=3*60*60*1000;

function uuid(){if(globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function')return globalThis.crypto.randomUUID();const hex='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';return hex.replace(/[xy]/gu,function(char){const value=Math.floor(Math.random()*16);return (char==='x'?value:(value&3)|8).toString(16)})}
function uuidValue(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value||''))}
function exactKeys(value,keys){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify(keys.slice().sort())}
function validAttempt(attempt,active){return Boolean(attempt&&exactKeys(attempt,['type','id'])
  &&(attempt.type==='module'?uuidValue(attempt.id)&&active.module!=='writing'&&active.module!=='speaking':
    ['writing','speaking'].includes(attempt.type)&&attempt.type===active.module&&Number.isInteger(Number(attempt.id))&&Number(attempt.id)>0))}
function validPending(pending,active){if(!pending)return true;if(!pending||!['attempt','bind','advance'].includes(pending.phase)||!uuidValue(pending.advanceKey))return false;
  if(pending.phase==='attempt')return exactKeys(pending,['advanceKey','payload','phase'])&&exactKeys(pending.payload,['activity','adaptiveExecutionClaim','durationMs','id','maxScore','module','score'])
    &&uuidValue(pending.payload.id)&&pending.payload.module===active.module&&pending.payload.activity===active.activityId&&pending.payload.adaptiveExecutionClaim===active.executionClaim
    &&Number.isFinite(pending.payload.score)&&Number.isFinite(pending.payload.maxScore)&&pending.payload.maxScore>0&&pending.payload.score>=0&&pending.payload.score<=pending.payload.maxScore
    &&Number.isInteger(pending.payload.durationMs)&&pending.payload.durationMs>=0;
  return exactKeys(pending,['advanceKey','attempt','phase'])&&validAttempt(pending.attempt,active)}
function validActive(active,savedAt){return !active||Boolean(active&&typeof active==='object'
  &&uuidValue(active.sessionId)
  &&/^asb_[0-9a-f]{16}_[0-9]{2}$/u.test(String(active.blockId||''))
  &&/^[A-Za-z0-9_-]{32,200}$/u.test(String(active.executionClaim||''))
  &&['vocabulary','grammar','reading','listening','writing','speaking'].includes(active.module)
  &&/^[a-z0-9_]{1,100}$/u.test(String(active.activityId||''))
  &&/^[A-Za-z0-9:_-]{1,240}$/u.test(String(active.contentRef||''))
  &&Number.isInteger(Number(active.expectedRevision))&&Number(active.expectedRevision)>=0
  &&Number.isFinite(Number(active.claimExpiresAt))&&Number(active.claimExpiresAt)>Number(active.startedAt)
  &&Number.isFinite(Number(active.startedAt))&&Number(active.startedAt)>0&&Number(active.startedAt)<=Number(savedAt)
  &&Number(active.claimExpiresAt)-Number(active.startedAt)<=2*60*60*1000+60_000
  &&validPending(active.pending,active))}
function read(){try{const raw=localStorage.getItem(STORAGE_KEY)||'null';if(raw.length>20000)throw new Error('ADAPTIVE_RUNTIME_TOO_LARGE');const value=JSON.parse(raw);if(!value||typeof value!=='object')return null;const savedAt=Number(value.savedAt||0);if(!Number.isFinite(savedAt)||savedAt<=0||Date.now()-savedAt>MAX_AGE_MS||savedAt-Date.now()>60_000||!validActive(value.active,savedAt)){localStorage.removeItem(STORAGE_KEY);return null}return value}catch(_){localStorage.removeItem(STORAGE_KEY);return null}}
function resultSnapshot(value){if(!value)return null;return {session:value.session||null,execution:value.execution||null,summary:value.summary||null,nextAction:value.nextAction||null,completedBlock:value.completedBlock||null,profileChange:value.profileChange||null,planChange:value.planChange||null}}
function write(value){const bounded={version:1,savedAt:Date.now(),active:value&&value.active||null,lastResult:resultSnapshot(value&&value.lastResult)};try{localStorage.setItem(STORAGE_KEY,JSON.stringify(bounded))}catch(_){}return bounded}
function api(){if(!window.EasyBoostApi)throw new Error('ADAPTIVE_API_UNAVAILABLE');return window.EasyBoostApi}
function isNetworkError(error){return !navigator.onLine||String(error&&error.code)==='NETWORK_ERROR'||Number(error&&error.status)===0}
function isTerminalError(error){const status=Number(error&&error.status)||0;return status>=400&&status<500&&status!==429}
function clearTerminalState(){const state=read()||{};write({active:null,lastResult:state.lastResult||null})}
function returnToPlan(result){const current=read()||{};write({active:null,lastResult:result});window.dispatchEvent(new CustomEvent('adaptive-session-return',{detail:result}));nav('scr10')}

export function adaptiveRuntimeSnapshot(){return read()||{version:1,active:null,lastResult:null}}

export async function beginAdaptiveBlock(session,block,execution){
  if(!session||!block||block.kind!=='learning')throw new Error('ADAPTIVE_BLOCK_INVALID');
  const stored=read();
  if(stored&&stored.active&&stored.active.sessionId===session.id&&stored.active.blockId===block.id
    && stored.active.claimExpiresAt>Date.now()){
    return launchAdaptiveActivity(block.launch,block.contentRef);
  }
  let result;try{result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(session.id)+'/start',{
    blockId:block.id,expectedRevision:Number(execution&&execution.revision||0),
  },uuid())}catch(error){if(isTerminalError(error))clearTerminalState();throw error}
  write({active:{
    sessionId:session.id,blockId:block.id,module:block.module,activityId:block.activityId,
    contentRef:block.contentRef,executionClaim:result.executionClaim,
    claimExpiresAt:new Date(result.claimExpiresAt).getTime(),expectedRevision:result.execution.revision,
    startedAt:Date.now(),pending:null,
  },lastResult:stored&&stored.lastResult||null});
  const launched=await launchAdaptiveActivity(block.launch,block.contentRef);
  if(!launched)throw new Error('ADAPTIVE_ACTIVITY_LAUNCH_FAILED');
  return true;
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
    returnToPlan(result);return result;
  }
  return false;
}

export async function completeAdaptiveModuleActivity({module,activityId,score,maxScore,durationMs}={}){
  const state=read(),active=state&&state.active;
  if(!active||active.pending||active.module!==module||active.activityId!==activityId)return false;
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

export async function advanceAdaptiveBreak(session,block,execution){
  const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(session.id)+'/advance',{
    blockId:block.id,expectedRevision:Number(execution&&execution.revision||0),attempt:null,
  },uuid());
  returnToPlan(result);return result;
}

export async function finishAdaptiveSession(session,execution){
  const result=await api().postIdempotent('/api/v1/adaptive-learning/sessions/'+encodeURIComponent(session.id)+'/finish',{
    expectedRevision:Number(execution&&execution.revision||0),
  },uuid());
  returnToPlan(result);return result;
}

export async function resumeAdaptiveExecution(){
  const state=read();if(!state||!state.active||!state.active.pending||!navigator.onLine)return false;
  try{return await sendPending(state)}catch(error){if(isNetworkError(error))return false;if(isTerminalError(error))clearTerminalState();throw error}
}

window.addEventListener('online',function(){resumeAdaptiveExecution().catch(function(){})});
