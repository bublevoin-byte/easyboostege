/*
 * Production Writing route (tasks 37/38 and server-authoritative AI review).
 * The screen is lazy-loaded; the task bank itself is loaded by the shell for offline drafting.
 */
import {cur,registerRouteHook,tab} from '../router.js';
import {
  S,SRV,TOKEN,W37,W38,apiIsAuthorityFailure,apiMessage,apiPost,apiPostIdempotent,
  apiResponseOwner,currentOwnerBinding,invalidateLearningAuthority,registerAuthorityReset,
  ringOff,save,setTxt,toast,ui,writingModule,
} from '../app.js';
import {adaptiveRuntimeSnapshot,completeAdaptiveServerAttempt,openAdaptivePlan} from '../adaptive-session-runtime.js';
import {sanitizeEgeWritingText} from '../../shared/ege-writing-text-sanitizer.js';
import '../modules/writing.js';
import {voiceTutorButton} from '../voice-tutor-loader.js';

const WRITING_SCREENS=new Set(['scr8','scr12','scr13']);
const MAX_WRITING_DUPLICATE_DRAIN=8;
const MAX_WRITING_EVALUATION_RECORDS=4;
const WRITING_EVALUATION_CLIENT_TIMEOUT_MS=45_000;
const WRITING_EVALUATION_STORAGE='easyboost.writing-evaluation.v1';
const WRITING_UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WRITE={
  37:{label:'ЗАДАНИЕ 37 · ПИСЬМО ДРУГУ'},
  38:{label:'ЗАДАНИЕ 38 · ПРОЕКТ С ДАННЫМИ'},
};
const GUIDE={
  37:'<p><strong>1. Поздоровайся.</strong> На отдельной строке: <i>Dear Emily,</i></p>'
    +'<p><strong>2. Поблагодари за письмо.</strong> Например: <i>Thanks a lot for your email!</i></p>'
    +'<p><strong>3. Ответь на все 3 вопроса друга.</strong> На каждый — 1–2 предложения.</p>'
    +'<p><strong>4. Задай 3 вопроса</strong> о теме из задания.</p>'
    +'<p><strong>5. Заверши письмо.</strong> Объясни, почему заканчиваешь, попрощайся и подпишись на новой строке.</p>'
    +'<p><strong>Проверь:</strong> 100–140 слов, три своих вопроса, без адреса и даты.</p>',
  38:'<p><strong>1. Вступление.</strong> Обозначь тему проекта и источник данных.</p>'
    +'<p><strong>2. Данные.</strong> Опиши 2–3 показателя своими словами.</p>'
    +'<p><strong>3. Сравнение.</strong> Сопоставь 1–2 показателя и объясни различие.</p>'
    +'<p><strong>4. Проблема и решение.</strong> Назови одну проблему по теме и предложи решение.</p>'
    +'<p><strong>5. Вывод.</strong> Сформулируй личное мнение.</p>'
    +'<p><strong>Проверь:</strong> 200–250 слов и пять абзацев.</p>',
};

let curTask=38;
let W_SHEET=false;
let WRITING_BOUND=false;
let REVIEW_BOUND=false;
let REVIEW_ACTION='new';
let WRITING_VIEW_GENERATION=0;
let WRITING_AI_GENERATION=0;
let WR_GEN=null;
let WR_GEN_TIMER=null;
let WR_GEN_DUPLICATE_DRAIN=0;
let SUBMISSION=null;
let SUBMIT_PREFLIGHT=null;
let SUBMIT_RUN=0;
let DRAFT_ANNOUNCE_TIMER=null;
let AMBIGUOUS_REQUEST=null;
let STORAGE_FULL_REQUEST=null;
let RETIRE_PENDING=null;
let WRITING_CONFIRMATION=null;
let LAST_LIMIT_STATE={key:null,state:null};

function byId(id){return document.getElementById(id)}
function focusWritingRoute(id){
  const target=byId(id)?.querySelector('main[data-aisy-shell-focus]');
  if(target&&byId(id)?.classList.contains('on'))target.focus({preventScroll:true});
}
function evaluationAuthority(authority){
  const username=String(authority?.username||authority?.owner||'');
  const generation=Number(authority?.generation??authority?.ownerGeneration);
  return username&&Number.isSafeInteger(generation)?{username,generation}:null;
}
function evaluationStorageKey(authority){
  const normalized=evaluationAuthority(authority);
  return normalized?WRITING_EVALUATION_STORAGE+':'+encodeURIComponent(normalized.username)+':'+normalized.generation:'';
}
function evaluationRecords(authority){
  const storageKey=evaluationStorageKey(authority);if(!storageKey)return [];
  try{
    const parsed=JSON.parse(localStorage.getItem(storageKey)||'null');
    return Array.isArray(parsed?.records)?parsed.records.filter(function(record){
      return WRITING_UUID_V4.test(String(record?.key||''))&&record?.payload;
    }):[];
  }catch(_){return []}
}
function evaluationIdentity(payload){
  return{
    taskType:String(payload?.taskType||''),
    taskId:String(payload?.taskId||'').trim(),
    answer:sanitizeEgeWritingText(payload?.answer),
  };
}
function sameEvaluationRecord(record,payload){
  return writingModule.sameEvaluationPayload(record?.identity||evaluationIdentity(record?.payload),evaluationIdentity(payload));
}
function evaluationRecordReusable(record,startedAt){
  if(!record?.terminalAt)return true;
  if(record.terminal==='completed')return true;
  return Number(record.terminalAt)>=startedAt;
}
function writeEvaluationRecords(authority,records){
  const storageKey=evaluationStorageKey(authority);if(!storageKey)return false;
  if(records.length>MAX_WRITING_EVALUATION_RECORDS)return false;
  try{
    if(records.length)localStorage.setItem(storageKey,JSON.stringify({records}));else localStorage.removeItem(storageKey);
    return true;
  }catch(_){return false}
}
function retryStorageError(code){return Object.assign(new Error(code),{code,status:0})}
function withEvaluationLock(authority,operation){
  const storageKey=evaluationStorageKey(authority);
  if(!storageKey||!navigator.locks?.request)return Promise.resolve({error:retryStorageError('WRITING_RETRY_LOCK_UNAVAILABLE')});
  return navigator.locks.request(storageKey+':lock',{mode:'exclusive'},operation).catch(function(){
    return {error:retryStorageError('WRITING_RETRY_LOCK_UNAVAILABLE')};
  });
}
function evaluationRecordLocked(authority,payload,{replaceKey=null,startedAt=Date.now()}={}){
  let records=evaluationRecords(authority);
  const beforePrune=records.length;
  records=records.filter(function(record){
    if(record.key===replaceKey)return true;
    return evaluationRecordReusable(record,startedAt);
  });
  const persistPrune=function(){return records.length===beforePrune||writeEvaluationRecords(authority,records)};
  if(replaceKey){
    const replaced=records.find(function(record){return record.key===replaceKey&&sameEvaluationRecord(record,payload)});
    if(!replaced||replaced.terminal)return {error:retryStorageError('WRITING_EVALUATION_REPEAT_ACK_INVALID')};
    const existingRepeat=[...records].reverse().find(function(record){
      return record.acknowledgeKey===replaceKey&&sameEvaluationRecord(record,payload)
        &&evaluationRecordReusable(record,startedAt);
    });
    if(existingRepeat){
      return persistPrune()?{...existingRepeat,created:false}:{error:retryStorageError('WRITING_RETRY_STORAGE_UNAVAILABLE')};
    }
    if(records.length>=MAX_WRITING_EVALUATION_RECORDS)return {error:retryStorageError('WRITING_RETRY_STORAGE_FULL')};
    const record={key:crypto.randomUUID().toLowerCase(),payload:{...payload},identity:evaluationIdentity(payload),createdAt:Date.now(),acknowledgeKey:replaced.key};
    return writeEvaluationRecords(authority,records.concat([record]))?{...record,created:true}:{error:retryStorageError('WRITING_RETRY_STORAGE_UNAVAILABLE')};
  }
  const existing=[...records].reverse().find(function(record){
    return sameEvaluationRecord(record,payload)&&evaluationRecordReusable(record,startedAt);
  });
  if(existing)return persistPrune()?{...existing,created:false}:{error:retryStorageError('WRITING_RETRY_STORAGE_UNAVAILABLE')};
  if(records.length>=MAX_WRITING_EVALUATION_RECORDS)return {error:retryStorageError('WRITING_RETRY_STORAGE_FULL')};
  const record={key:crypto.randomUUID().toLowerCase(),payload:{...payload},identity:evaluationIdentity(payload),createdAt:Date.now()};
  return writeEvaluationRecords(authority,records.concat([record]))?{...record,created:true}:{error:retryStorageError('WRITING_RETRY_STORAGE_UNAVAILABLE')};
}
function evaluationClaimReachedServer(error){
  return ['AI_UNAVAILABLE','AI_NOT_CONFIGURED','AI_RESPONSE_INVALID'].includes(String(error?.code||''));
}
function markEvaluationTerminalLocked(authority,payload,pending,terminal,error){
  const records=evaluationRecords(authority);const record=records.find(function(item){return item.key===pending.key&&sameEvaluationRecord(item,payload)});
  if(!record)return false;
  const terminalAt=Number(record.terminalAt)||Date.now();
  if(!record.terminal){record.terminal=terminal;record.terminalAt=terminalAt}
  const retirePredecessor=Boolean(pending.acknowledgeKey&&(terminal==='completed'||evaluationClaimReachedServer(error)));
  if(retirePredecessor){
    const predecessor=records.find(function(item){return item.key===pending.acknowledgeKey&&sameEvaluationRecord(item,payload)});
    if(predecessor&&!predecessor.terminal){predecessor.terminal='retired';predecessor.terminalAt=terminalAt}
  }
  return writeEvaluationRecords(authority,records);
}
function runEvaluationTransaction(authority,payload,{replaceKey=null,startedAt=Date.now(),canStart=null,canCommit=null}={},operation){
  return withEvaluationLock(authority,async function(){
    if(canStart&&canStart()!==true)return{cancelled:true};
    const pending=evaluationRecordLocked(authority,payload,{replaceKey,startedAt});
    if(pending.error)return pending;
    let response=null,error=null;
    try{response=await operation(pending)}catch(caught){error=caught}
    if(response&&(!canCommit||canCommit()===true))markEvaluationTerminalLocked(authority,payload,pending,'completed',null);
    else if(error&&error.preserveEvaluation!==true&&!writingModule.evaluationMayBeInFlight(error))markEvaluationTerminalLocked(authority,payload,pending,'failed',error);
    return{pending,response,error};
  });
}
async function retireOldestEvaluation(request){
  const allowed=new Set(['scr12']);
  if(!requestCurrent(request,allowed))return{cancelled:true};
  const result=await withEvaluationLock(request.authority,function(){
    if(!requestCurrent(request,allowed))return{cancelled:true};
    const records=evaluationRecords(request.authority);
    const oldest=[...records].sort(function(left,right){return Number(left.createdAt||0)-Number(right.createdAt||0)})[0];
    if(!oldest)return{retired:false};
    const remaining=records.filter(function(record){return record.key!==oldest.key});
    if(!requestCurrent(request,allowed))return{cancelled:true};
    return writeEvaluationRecords(request.authority,remaining)?{retired:true,key:oldest.key}:{error:retryStorageError('WRITING_RETRY_STORAGE_UNAVAILABLE')};
  });
  return requestCurrent(request,allowed)?result:{cancelled:true};
}
function markEvaluationApplied(authority,payload,key){
  return withEvaluationLock(authority,function(){
    const records=evaluationRecords(authority);const record=records.find(function(item){return item.key===key&&sameEvaluationRecord(item,payload)});
    if(!record||record.terminal!=='completed')return false;
    /* The server fingerprint coalesces a later identical request even under a new key. Once the
       authoritative result and progress are locally applied, retain no extra copy of the essay. */
    return writeEvaluationRecords(authority,records.filter(function(item){return item.key!==key}));
  });
}
function wrPool(task){const ai=(S&&S.writeAi&&S.writeAi['t'+task])||[];return writingModule.pool(task===37?W37:W38,ai)}
function wrCur(task=curTask,state=S){
  const ai=(state&&state.writeAi&&state.writeAi['t'+task])||[];
  return writingModule.current(writingModule.pool(task===37?W37:W38,ai),task===37?(state?.wIdx37||0):(state?.wIdx38||0));
}
function wrKey(task=curTask,state=S){return writingModule.draftKey(task,task===37?(state?.wIdx37||0):(state?.wIdx38||0))}
function writingRouteCurrent(allowed=WRITING_SCREENS){return allowed.has(cur())}
function requestCurrent(request,allowed=WRITING_SCREENS){
  return Boolean(request&&S===request.state&&writingRouteCurrent(allowed)
    &&writingModule.requestIsCurrent(request.authority,request.view,currentOwnerBinding(),WRITING_VIEW_GENERATION));
}
function captureRequest(){const authority=currentOwnerBinding();return authority&&S?{authority,state:S,view:WRITING_VIEW_GENERATION}:null}
function capturedAuthorityCurrent(request){return Boolean(request&&S===request.state&&writingModule.sameOwner(request.authority,currentOwnerBinding()))}
async function invalidateCapturedAuthority(request){
  if(!capturedAuthorityCurrent(request))return false;
  return invalidateLearningAuthority({owner:request.authority.username,ownerGeneration:request.authority.generation});
}
function adaptiveWritingLock(){const active=adaptiveRuntimeSnapshot().active;return active&&active.module==='writing'?active:null}

function html(value){return ui.escapeHtml(value==null?'':String(value))}
function setButtonLabel(button,label){
  if(!button)return;
  button.textContent=label;button.setAttribute('aria-label',label);
}
function setWaitingPhase(dispatched){
  const route=byId('scr13')?.querySelector('.writing-route');
  if(route)route.dataset.phase=dispatched?'dispatched':'preflight';
  const busyNodes=[route,byId('w_waiting_content')].filter(Boolean);
  busyNodes.forEach(function(node){node.setAttribute('aria-busy','true')});
  setTxt('writing_waiting_summary',dispatched?'Ответ отправлен один раз и остаётся в черновике':'Готовим безопасную отправку ответа');
  setTxt('writing_waiting_title',dispatched?'ИИ проверяет письменный ответ':'Готовим проверку');
  setTxt('writing_waiting_copy',dispatched
    ?'Сервер сверяет работу с критериями задания. Результат появится, когда проверка действительно завершится.'
    :'Проверяем безопасный повтор и возможность отправки. Ответ ещё не передан на проверку.');
  setButtonLabel(byId('w_waiting_primary'),dispatched?'Проверяем…':'Готовим…');
  if(dispatched)busyNodes.forEach(function(node){node.setAttribute('aria-busy','false')});
}
function setRetirementPending(pending){
  const button=byId('rv_primary_action');if(!button)return;
  button.disabled=Boolean(pending);
  if(pending)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  if(REVIEW_ACTION==='retire')setButtonLabel(button,pending?'Освобождаем…':'Освободить место');
}
function confirmationFocusable(dialog){
  return Array.from(dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'))
    .filter(function(node){return node.getClientRects().length>0});
}
function settleWritingConfirmation(accepted){
  const current=WRITING_CONFIRMATION;if(!current)return false;
  WRITING_CONFIRMATION=null;
  if(current.dialog.open)current.dialog.close();
  current.resolve(Boolean(accepted));
  queueMicrotask(function(){
    if(current.returnFocus?.isConnected&&current.returnFocus.getClientRects().length)current.returnFocus.focus({preventScroll:true});
  });
  return true;
}
function bindWritingConfirmation(){
  const dialog=byId('writing_confirm_dialog');if(!dialog||dialog.dataset.bound==='true')return dialog;
  dialog.dataset.bound='true';
  byId('writing_confirm_cancel')?.addEventListener('click',function(){settleWritingConfirmation(false)});
  byId('writing_confirm_accept')?.addEventListener('click',function(){settleWritingConfirmation(true)});
  dialog.addEventListener('cancel',function(event){event.preventDefault();settleWritingConfirmation(false)});
  dialog.addEventListener('keydown',function(event){
    if(event.key==='Escape'){event.preventDefault();settleWritingConfirmation(false);return}
    if(event.key==='Tab'){
      const focusable=confirmationFocusable(dialog);if(!focusable.length){event.preventDefault();dialog.focus();return}
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
    }
  });
  return dialog;
}
function openWritingConfirmation({title,copy,confirmLabel}){
  const dialog=bindWritingConfirmation();if(!dialog||WRITING_CONFIRMATION)return Promise.resolve(false);
  setTxt('writing_confirm_title',title);setTxt('writing_confirm_copy',copy);setButtonLabel(byId('writing_confirm_accept'),confirmLabel);
  const returnFocus=document.activeElement;
  return new Promise(function(resolve){
    WRITING_CONFIRMATION={dialog,resolve,returnFocus};dialog.showModal();byId('writing_confirm_cancel')?.focus({preventScroll:true});
  });
}
function setSubmitting(value){
  const button=byId('w_primary_action');
  if(!button)return;
  button.disabled=Boolean(value)||!wrCur();
  if(value)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  setButtonLabel(button,value?'Проверяем…':'Проверить с ИИ');
}
function announceDraft(copy,state='saved',draftKey=byId('w_editor')?.dataset.draftKey){
  clearTimeout(DRAFT_ANNOUNCE_TIMER);
  DRAFT_ANNOUNCE_TIMER=setTimeout(function(){
    const editor=byId('w_editor'),status=byId('w_draft_status');
    if(!status||editor?.dataset.draftKey!==draftKey)return;
    status.textContent=copy;status.dataset.state=state;
  },450);
}
function countWords(){
  const editor=byId('w_editor');
  const counter=byId('w_count');
  if(!editor||!counter)return 0;
  const st=writingModule.wordCountStatus(editor.value,curTask);
  counter.textContent=st.count+' / '+st.range+' слов · '+st.hint;
  counter.dataset.state=st.state;
  const draftKey=editor.dataset.draftKey||wrKey();
  if(LAST_LIMIT_STATE.key!==draftKey){LAST_LIMIT_STATE={key:draftKey,state:st.state};setTxt('w_limit_status','')}
  else if(LAST_LIMIT_STATE.state!==st.state){
    LAST_LIMIT_STATE={key:draftKey,state:st.state};
    const copy=st.state==='ok'?'Объём в норме: '+st.count+' слов.'
      :st.state==='over'?'Превышен предел: сейчас '+st.count+' слов.'
      :'Объём ниже нормы: сейчас '+st.count+' слов.';
    setTxt('w_limit_status',copy);
  }
  return st.count;
}
function saveDraft(){
  const editor=byId('w_editor');
  if(!editor||!S)return;
  const draftKey=editor.dataset.draftKey||wrKey();
  S.drafts=S.drafts||{};
  S.drafts[draftKey]=editor.value;
  const stored=save({queueNow:true});countWords();announceDraft(stored
    ?'Черновик сохранён на этом устройстве'
    :'Не удалось сохранить черновик на этом устройстве — не закрывайте страницу',stored?'saved':'error',draftKey);
}
function radioKey(event){
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  const radios=Array.from(event.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]:not(:disabled)')||[]);
  if(!radios.length)return;
  const current=radios.indexOf(event.currentTarget);
  const next=event.key==='Home'?0:event.key==='End'?radios.length-1:
    (current+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)+radios.length)%radios.length;
  event.preventDefault();radios[next].focus();radios[next].click();
}
function bindWritingControls(){
  if(WRITING_BOUND)return;WRITING_BOUND=true;
  byId('w_seg37')?.addEventListener('click',function(){setTask(37)});
  byId('w_seg38')?.addEventListener('click',function(){setTask(38)});
  byId('w_seg37')?.addEventListener('keydown',radioKey);
  byId('w_seg38')?.addEventListener('keydown',radioKey);
  byId('w_editor')?.addEventListener('input',saveDraft);
  byId('w_primary_action')?.addEventListener('click',checkWriting);
}
function bindReviewControls(){
  if(REVIEW_BOUND)return;REVIEW_BOUND=true;
  bindWritingConfirmation();
  byId('rv_edit_action')?.addEventListener('click',async function(){
    if(REVIEW_ACTION==='ambiguous'&&AMBIGUOUS_REQUEST){
      const captured=AMBIGUOUS_REQUEST,request=captureRequest();
      const confirmed=await openWritingConfirmation({
        title:'Повторить платную проверку?',
        copy:'Предыдущая проверка могла дойти до провайдера. Новый запрос может привести к повторной платной обработке.',
        confirmLabel:'Проверить заново',
      });
      if(confirmed&&requestCurrent(request,new Set(['scr12']))&&AMBIGUOUS_REQUEST===captured){
        const oldKey=captured.key;tab('scr8',function(){checkWriting({acknowledgePossibleProviderRepeatKey:oldKey})});
      }
      return;
    }
    tab('scr8',function(){byId('w_editor')?.focus()});
  });
  byId('rv_primary_action')?.addEventListener('click',async function(){
    if(REVIEW_ACTION==='ambiguous'){
      tab('scr8',function(){checkWriting()});return;
    }
    if(REVIEW_ACTION==='retry'){
      tab('scr8',function(){checkWriting()});return;
    }
    if(REVIEW_ACTION==='back'){
      tab('scr8',function(){byId('w_editor')?.focus()});return;
    }
    if(REVIEW_ACTION==='retire'&&STORAGE_FULL_REQUEST){
      if(RETIRE_PENDING)return;
      const captured=STORAGE_FULL_REQUEST,request=captureRequest();
      if(!request||!writingModule.sameOwner(captured.authority,request.authority))return;
      const run={request,captured};RETIRE_PENDING=run;setRetirementPending(true);
      const confirmed=await openWritingConfirmation({
        title:'Освободить место для проверки?',
        copy:'Самая старая запись безопасного повтора будет удалена. Её проверка могла быть оплачена и ещё завершиться; восстановить этот результат после удаления не получится.',
        confirmLabel:'Удалить запись',
      });
      if(RETIRE_PENDING!==run||!requestCurrent(request,new Set(['scr12']))){
        if(RETIRE_PENDING===run){RETIRE_PENDING=null;setRetirementPending(false)}return;
      }
      if(!confirmed){RETIRE_PENDING=null;setRetirementPending(false);return}
      const retired=await retireOldestEvaluation(request);
      if(RETIRE_PENDING!==run||!requestCurrent(request,new Set(['scr12']))){
        if(RETIRE_PENDING===run){RETIRE_PENDING=null;setRetirementPending(false)}return;
      }
      RETIRE_PENDING=null;setRetirementPending(false);
      if(STORAGE_FULL_REQUEST!==captured||retired?.cancelled)return;
      if(retired?.error){renderFailure(retired.error);return}
      STORAGE_FULL_REQUEST=null;tab('scr8',function(){checkWriting()});return;
    }
    if(REVIEW_ACTION==='adaptive'){openAdaptivePlan();return}
    tab('scr8',function(){wrNext()});
  });
}

function historyHtml(){
  const works=writingModule.serverWorks(S?.works).slice(-3).reverse();
  if(!works.length)return '<div class="writing-history"><p>Проверенных работ пока нет. После настоящей серверной проверки результат появится здесь.</p></div>';
  return '<div class="writing-history"><p class="writing-section-label">Последние работы</p>'
    +works.map(function(work){const date=new Date(work.ts);return '<div class="writing-history__item"><span>Задание '+html(work.t)+' · '
      +String(date.getDate()).padStart(2,'0')+'.'+String(date.getMonth()+1).padStart(2,'0')+'</span><strong>'+html(work.g)+' из '+html(work.m)+'</strong></div>'}).join('')+'</div>';
}
function promptHtml(task,topic,lock){
  if(!topic)return '<p>Не удалось открыть точное задание. Вернитесь к разделу и попробуйте снова.</p>';
  let result='';
  if(task===37){
    result='<div class="writing-stimulus">From: '+html(topic.from)+'<br>'+html(topic.stim)+'</div>'
      +'<p>Напиши ответ (100–140 слов): ответь на 3 вопроса '+html(topic.from)+' и задай <strong>3 вопроса</strong> about <strong>'+html(topic.ask)+'</strong>.</p>';
  }else{
    result='<p>Imagine you are doing a project «<strong>'+html(topic.topic)+'</strong>». Comment on the data and give your opinion (200–250 слов).</p>'
      +'<div class="writing-data">'+(topic.rows||[]).map(function(row){return '<div><span>'+html(row[0])+'</span><b>'+html(row[1])+'%</b></div>'}).join('')+'</div>';
  }
  result+='<div class="writing-tools">'
    +(lock?'':'<button type="button" id="w_new_topic" class="writing-tool">Новая тема</button>')
    +'<button type="button" id="w_guide_toggle" class="writing-tool" aria-controls="w_guide" aria-expanded="'+String(W_SHEET)+'">'+(W_SHEET?'Скрыть шпаргалку':'Шпаргалка')+'</button></div>';
  result+='<div id="w_guide" class="writing-guide"'+(W_SHEET?'':' hidden')+'>'+GUIDE[task]+'</div>';
  return result+historyHtml();
}
function renderTask({restoreFocus=null}={}){
  if(!S)return false;
  const activeId=byId('w_prompt')?.contains(document.activeElement)?document.activeElement?.id:null;
  const focusId=restoreFocus||activeId;
  const lock=adaptiveWritingLock();
  const topic=wrCur();
  setTxt('w_tasklabel',WRITE[curTask].label);
  const routeStatus=byId('w_route_status');
  if(routeStatus)routeStatus.textContent=curTask===37?'Задание 37 · 100–140 слов · максимум 6 баллов':'Задание 38 · 200–250 слов · максимум 14 баллов';
  const prompt=byId('w_prompt');if(prompt)prompt.innerHTML=promptHtml(curTask,topic,lock);
  byId('w_new_topic')?.addEventListener('click',wrNext);
  byId('w_guide_toggle')?.addEventListener('click',wrSheet);
  const key=wrKey();const editor=byId('w_editor');
  if(editor&&editor.dataset.draftKey!==key){
    clearTimeout(DRAFT_ANNOUNCE_TIMER);DRAFT_ANNOUNCE_TIMER=null;
    editor.dataset.draftKey=key;
    editor.value=writingModule.draftText(S.drafts?.[key]);
  }
  const status=byId('w_draft_status');if(status){
    delete status.dataset.state;
    status.textContent=editor?.value?'Сохранённый на этом устройстве черновик открыт':'Черновик сохраняется на этом устройстве';
  }
  countWords();setSubmitting(Boolean(SUBMISSION));
  if(focusId&&writingRouteCurrent(new Set(['scr8'])))queueMicrotask(function(){byId(focusId)?.focus({preventScroll:true})});
  return Boolean(topic);
}
function setTask(value){
  if(!S)return false;
  const lock=adaptiveWritingLock();
  let task=writingModule.selectedTaskType(value);
  if(lock){
    task=lock.activityId==='writing_37'?37:38;
    const exact=wrPool(task).findIndex(function(item){return item&&item.id===lock.contentRef});
    if(exact>=0){if(task===37)S.wIdx37=exact;else S.wIdx38=exact}
  }
  const pool=wrPool(task);const index=writingModule.currentIndex(task===37?S.wIdx37:S.wIdx38,pool.length);
  if(task===37)S.wIdx37=index;else S.wIdx38=index;
  curTask=task;S.writingTaskType=task;save({queueNow:true});
  const seg37=byId('w_seg37'),seg38=byId('w_seg38');
  [[seg37,37],[seg38,38]].forEach(function(entry){const button=entry[0],kind=entry[1];if(!button)return;
    const active=kind===task;button.disabled=Boolean(lock);button.setAttribute('aria-checked',String(active));button.tabIndex=active?0:-1});
  renderTask();return Boolean(wrCur());
}
function launchWritingTask(taskType,taskId){
  if(!S||![37,38].includes(taskType)||typeof taskId!=='string')return false;
  const pool=wrPool(taskType);const index=pool.findIndex(function(task){return task&&task.id===taskId});
  if(index<0)return false;
  if(taskType===37)S.wIdx37=index;else S.wIdx38=index;
  W_SHEET=false;S.writingTaskType=taskType;save({queueNow:true});setTask(taskType);
  return Boolean(wrCur()&&wrCur().id===taskId);
}
function wrNext(){
  if(!S)return false;
  if(adaptiveWritingLock()){try{toast('В персональном занятии закреплена эта тема. Сначала заверши её.')}catch(_){}return false}
  const pool=wrPool(curTask);const next=writingModule.currentIndex((curTask===37?S.wIdx37:S.wIdx38)+1,pool.length);
  if(curTask===37)S.wIdx37=next;else S.wIdx38=next;
  W_SHEET=false;save({queueNow:true});setTask(curTask);wrGen();return true;
}
function wrSheet(){
  const restoreFocus=document.activeElement?.id==='w_guide_toggle'?'w_guide_toggle':null;
  W_SHEET=!W_SHEET;renderTask({restoreFocus});return W_SHEET;
}

function criterionMarkup(criterion){
  const got=Number(criterion.got)||0,max=Number(criterion.max)||0;
  return '<div class="writing-criterion"><span>'+html(criterion.name)+'</span><strong>'+got+'/'+max+'</strong>'
    +'<progress value="'+Math.max(0,got)+'" max="'+Math.max(1,max)+'" aria-label="'+html(criterion.name)+': '+got+' из '+max+'"></progress></div>';
}
function feedbackMarkup(item){
  const warning=item.kind==='warn';
  let details='';
  if(item.right)details+='<dt>Правильный вариант</dt><dd class="writing-feedback__correction">'+html(item.right)+'</dd>';
  if(item.note)details+='<dt>Правило</dt><dd>'+html(item.note)+'</dd>';
  if(item.example)details+='<dt>Пример</dt><dd>'+html(item.example)+'</dd>';
  if(item.wrong)details+='<dt>Фрагмент из работы</dt><dd>'+html(item.wrong)+'</dd>';
  return '<article class="writing-feedback" data-kind="'+(warning?'warn':'err')+'"><h3>'+html(item.title||'Комментарий')+'</h3><dl>'+details+'</dl></article>';
}
function renderReview(review,evaluationScope,voiceTutor,{progressStored=true}={}){
  bindReviewControls();
  const totals=writingModule.reviewTotals(review);
  setTxt('rv_score',totals.got);setTxt('rv_max','из '+totals.max);
  const ring=byId('rv_ring');if(ring){ring.max=Math.max(1,totals.max);ring.value=Math.max(0,totals.got)}
  setTxt('rv_verdict',review.verdict||'Разбор готов');setTxt('rv_sub',review.sub||'');
  document.getElementById('ai_disclaimer').textContent=ui.AI_DISCLAIMER;
  const scope=byId('rv_scope_notice'),scopeText=writingModule.evaluationNotice(evaluationScope);
  scope.textContent=scopeText;scope.hidden=!scopeText;
  const criteria=byId('rv_crit');criteria.innerHTML=(review.criteria||[]).map(criterionMarkup).join('');
  const errors=review.errors||[];setTxt('rv_errhdr','Разбор ошибок · '+errors.length);
  const errorHost=byId('rv_err');
  errorHost.innerHTML=errors.length?errors.map(feedbackMarkup).join(''):'<p>Сервер не отметил ошибок в этой работе.</p>';
  if(voiceTutor&&totals.got<totals.max)errorHost.insertAdjacentHTML('beforeend',voiceTutorButton(voiceTutor));
  byId('rv_result').hidden=false;byId('rv_error_state').hidden=true;
  const savedNotice=byId('rv_saved_notice');if(savedNotice){
    savedNotice.textContent=progressStored
      ?'Разбор сохранён на сервере · серверный прогресс обновлён'
      :'Разбор сохранён на сервере · локальную копию прогресса сохранить не удалось';
    savedNotice.hidden=false;
  }
  setTxt('rv_status','Проверка завершена. Балл '+totals.got+' из '+totals.max+'.');
  const edit=byId('rv_edit_action'),primary=byId('rv_primary_action');edit.hidden=false;setButtonLabel(edit,'Исправить');primary.hidden=false;setButtonLabel(primary,'Новая работа');REVIEW_ACTION='new';
}
function renderFailure(error){
  bindReviewControls();
  const failure=writingModule.classifyEvaluationFailure(error);
  byId('rv_result').hidden=true;byId('rv_error_state').hidden=false;
  const savedNotice=byId('rv_saved_notice');if(savedNotice)savedNotice.hidden=true;
  setTxt('rv_error_kind','Проверка не выполнена');setTxt('rv_error_title',failure.title);setTxt('rv_error_copy',failure.description);setTxt('rv_status',failure.title+'. '+failure.description);
  const edit=byId('rv_edit_action'),primary=byId('rv_primary_action');primary.hidden=false;primary.disabled=false;primary.removeAttribute('aria-busy');edit.disabled=false;
  if(failure.kind==='ambiguous'||failure.kind==='progress-pending'){
    edit.hidden=failure.allowPaidRepeat!==true;if(!edit.hidden)setButtonLabel(edit,'Проверить заново');setButtonLabel(primary,'Проверить статус');REVIEW_ACTION='ambiguous';
  }else if(failure.kind==='retry-storage-full'){
    edit.hidden=true;setButtonLabel(primary,'Освободить место');REVIEW_ACTION='retire';
  }else{
    edit.hidden=true;setButtonLabel(primary,failure.retryable?'Повторить проверку':'Вернуться к работе');REVIEW_ACTION=failure.retryable?'retry':'back';
  }
  return failure;
}
function wrStore(progress,state){
  state.works=progress.works.map(function(work){return{...work}});state.essays=progress.attemptCount;
  state.prog=state.prog||{};state.prog.write=progress.average;
  setTxt('sub_write','работ: '+progress.attemptCount+' · средний '+progress.average+'%');
  try{setTxt('m_write',progress.average);ringOff('ring_write',113.1,progress.average)}catch(_){}
  return true;
}
function showAdaptiveWritingReturn(){
  const host=byId('rv_err');if(!host||byId('adaptive_writing_return'))return;
  const button=document.createElement('button');button.id='adaptive_writing_return';button.type='button';button.className='aisy-button aisy-button--secondary writing-adaptive-return';button.textContent='Вернуться к персональному плану';button.addEventListener('click',openAdaptivePlan);host.appendChild(button);
}
function invalidReviewError(){return Object.assign(new Error('WRITING_EVALUATION_RESPONSE_INVALID'),{code:'WRITING_EVALUATION_RESPONSE_INVALID',status:502})}
function sameSubmission(entry,state,authority,payload,acknowledgeKey){
  return Boolean(entry&&entry.state===state&&writingModule.sameOwner(entry.authority,authority)
    &&writingModule.sameEvaluationPayload(evaluationIdentity(entry.payload),evaluationIdentity(payload))
    &&String(entry.acknowledgeKey||'')===String(acknowledgeKey||''));
}
async function timedEvaluationPost(payload,idempotencyKey,headers){
  const controller=new AbortController();let timedOut=false;
  const timer=setTimeout(function(){timedOut=true;controller.abort()},WRITING_EVALUATION_CLIENT_TIMEOUT_MS);
  try{return await apiPostIdempotent('/api/v1/ai/evaluate-writing',payload,idempotencyKey,headers,{signal:controller.signal})}
  catch(error){if(timedOut)throw Object.assign(new Error('REQUEST_TIMEOUT'),{code:'REQUEST_TIMEOUT',status:0});throw error}
  finally{clearTimeout(timer)}
}
async function checkWriting(options={}){
  const editor=byId('w_editor');const answer=editor?.value||'';const count=writingModule.countWords(answer);
  const validation=byId('w_editor_error');
  if(count<10){if(validation){validation.textContent='Напиши хотя бы несколько предложений перед проверкой.';validation.hidden=false}editor?.focus();return false}
  if(validation){validation.textContent='';validation.hidden=true}
  const topic=wrCur();
  if(!topic||!topic.id){tab('scr12',function(){renderFailure({code:'UNKNOWN_TASK',status:404});focusWritingRoute('scr12')});return false}
  const authority=currentOwnerBinding();
  if(!authority||!S){tab('scr12',function(){renderFailure({code:'OWNER_CHANGED',status:409});focusWritingRoute('scr12')});return false}
  const state=S;const task=curTask;
  const payload=writingModule.buildPayload(task,topic,answer);
  const acknowledgeKey=options?.acknowledgePossibleProviderRepeatKey||null;
  if(sameSubmission(SUBMISSION,state,authority,payload,acknowledgeKey))return SUBMISSION.promise;
  if(sameSubmission(SUBMIT_PREFLIGHT,state,authority,payload,acknowledgeKey))return SUBMIT_PREFLIGHT.promise;
  const run=++SUBMIT_RUN;const startedAt=Date.now();
  let resolveSubmission;
  const promise=new Promise(function(resolve){resolveSubmission=resolve});
  SUBMIT_PREFLIGHT={run,state,authority,payload,promise};SUBMIT_PREFLIGHT.acknowledgeKey=acknowledgeKey;
  setSubmitting(true);
  tab('scr13',function(){setWaitingPhase(false);focusWritingRoute('scr13')});
  const request={run,state,authority,view:WRITING_VIEW_GENERATION};
  (async function(){
    try{
      const outcome=await runEvaluationTransaction(authority,payload,{
        replaceKey:acknowledgeKey,startedAt,
        canStart:function(){return SUBMIT_PREFLIGHT?.run===run&&requestCurrent(request,new Set(['scr13']))},
        canCommit:function(){return requestCurrent(request,new Set(['scr13']))},
      },async function(pending){
        if(SUBMIT_PREFLIGHT?.run!==run||!requestCurrent(request,new Set(['scr13'])))return null;
        SUBMISSION={run,promise,state,authority,payload,acknowledgeKey};SUBMIT_PREFLIGHT=null;
        setWaitingPhase(true);
        const response=await timedEvaluationPost(payload,pending.key,{
          'X-EasyBoost-Expected-Owner':authority.username,
          ...(pending.acknowledgeKey?{'X-EasyBoost-Acknowledge-Provider-Repeat':pending.acknowledgeKey}:{}),
        });
        if(apiResponseOwner(response)!==authority.username){
          throw Object.assign(new Error('OWNER_CHANGED'),{code:'OWNER_CHANGED',status:409,preserveEvaluation:true});
        }
        if(!writingModule.validEvaluationResponse(response,task,ui.AI_DISCLAIMER,topic.id))throw invalidReviewError();
        return response;
      });
      if(outcome?.cancelled)return false;
      if(outcome?.error&&!outcome.pending){
        if(!requestCurrent(request,new Set(['scr13'])))return false;
        if(outcome.error.code==='WRITING_RETRY_STORAGE_FULL')STORAGE_FULL_REQUEST={authority,payload};
        tab('scr12',function(){renderFailure(outcome.error);focusWritingRoute('scr12')});return false;
      }
      const pending=outcome?.pending;
      const response=outcome?.response;
      const error=outcome?.error;
      if(!requestCurrent(request,new Set(['scr13'])))return false;
      if(error){
        if(apiIsAuthorityFailure(error)){await invalidateCapturedAuthority(request);return false}
        if(error?.code==='WRITING_EVALUATION_SETTLEMENT_UNKNOWN'||error?.code==='WRITING_EVALUATION_RESPONSE_INVALID'
          ||error?.code==='WRITING_PROGRESS_UNAVAILABLE'||error?.code==='WRITING_REPLAY_CONTRACT_UNAVAILABLE'
          ||error?.code==='REQUEST_TIMEOUT'||error?.code==='NETWORK_ERROR')
          AMBIGUOUS_REQUEST={authority,payload,key:pending.key,allowPaidRepeat:error?.code!=='WRITING_EVALUATION_RESPONSE_INVALID'};
        if(error?.code==='WRITING_EVALUATION_REPEAT_ACK_NOT_READY'&&pending.acknowledgeKey)
          AMBIGUOUS_REQUEST={authority,payload,key:pending.acknowledgeKey};
        if(pending.acknowledgeKey&&evaluationClaimReachedServer(error))AMBIGUOUS_REQUEST=null;
        tab('scr12',function(){renderFailure(error);focusWritingRoute('scr12')});return false;
      }
      if(!response)return false;
      const d=response&&response.review;
      if(!requestCurrent(request,new Set(['scr13'])))return false;
      wrStore(response.writingProgress,state);
      const progressStored=save({queueNow:true});
      if(progressStored)await markEvaluationApplied(authority,payload,pending.key);
      if(!requestCurrent(request,new Set(['scr13'])))return false;
      AMBIGUOUS_REQUEST=null;STORAGE_FULL_REQUEST=null;
      tab('scr12',function(){renderReview(d,response.evaluationScope,response.voiceTutor,{progressStored});focusWritingRoute('scr12')});
      const adaptiveRequest={state,authority,view:WRITING_VIEW_GENERATION};
      completeAdaptiveServerAttempt('writing',response.attemptId).then(function(result){if(result&&requestCurrent(adaptiveRequest,new Set(['scr12'])))showAdaptiveWritingReturn()}).catch(function(error){
        if(apiIsAuthorityFailure(error)){invalidateCapturedAuthority(adaptiveRequest);return}
        if(requestCurrent(adaptiveRequest,new Set(['scr12'])))try{toast('Работа сохранена, но персональный план пока не обновлён: '+apiMessage(error,'request'))}catch(_){}
      });
      return true;
    }catch(error){
      if(!requestCurrent(request,new Set(['scr13'])))return false;
      if(apiIsAuthorityFailure(error)){await invalidateCapturedAuthority(request);return false}
      tab('scr12',function(){renderFailure(error);focusWritingRoute('scr12')});return false;
    }finally{
      let released=false;
      if(SUBMISSION?.run===run){SUBMISSION=null;released=true}
      if(SUBMIT_PREFLIGHT?.run===run){SUBMIT_PREFLIGHT=null;released=true}
      if(released&&S===state)setSubmitting(false);
    }
  })().then(resolveSubmission,resolveSubmission);
  return promise;
}

async function wrGen(){
  if(WR_GEN||!SRV||!TOKEN||!S)return false;
  const base=captureRequest();if(!base||!requestCurrent(base,new Set(['scr8'])))return false;
  base.aiGeneration=++WRITING_AI_GENERATION;
  base.kind=wrPool(37).length<6?37:wrPool(38).length<6?38:null;
  if(!base.kind)return false;
  S.writeAi=S.writeAi||{t37:[],t38:[]};WR_GEN=base;
  let added=false,delivered=false;
  try{
    const response=await apiPost('/api/v1/tasks/next',{operation:base.kind===37?'writing_task_37':'writing_task_38'},{'X-EasyBoost-Expected-Owner':base.authority.username});
    if(WR_GEN!==base||base.aiGeneration!==WRITING_AI_GENERATION||!requestCurrent(base,new Set(['scr8'])))return false;
    if(apiResponseOwner(response)!==base.authority.username){await invalidateCapturedAuthority(base);return false}
    const item=writingModule.normalizeGenerated(base.kind,response&&response.task,response&&(response.externalId||response.taskId));
    delivered=Boolean(item);
    if(item&&!wrPool(base.kind).some(function(existing){return existing.id===item.id})){
      base.state.writeAi['t'+base.kind].push(item);save({queueNow:true});added=true;WR_GEN_DUPLICATE_DRAIN=0;
    }else if(item)WR_GEN_DUPLICATE_DRAIN++;
  }catch(error){if(apiIsAuthorityFailure(error))await invalidateCapturedAuthority(base)}
  finally{if(WR_GEN===base)WR_GEN=null}
  if(delivered&&WR_GEN_DUPLICATE_DRAIN<MAX_WRITING_DUPLICATE_DRAIN
    &&requestCurrent(base,new Set(['scr8']))&&(wrPool(37).length<6||wrPool(38).length<6)){
    clearTimeout(WR_GEN_TIMER);WR_GEN_TIMER=setTimeout(wrGen,4000);
  }
  return added;
}

function enterWriting(){
  bindWritingControls();bindReviewControls();
  const task=writingModule.selectedTaskType(S?.writingTaskType);
  setTask(task);wrGen();focusWritingRoute('scr8');
}
function clearOwnerWritingDom(){
  const editor=byId('w_editor');
  if(editor){editor.value='';editor.removeAttribute('data-draft-key')}
  const draftStatus=byId('w_draft_status');if(draftStatus){draftStatus.textContent='';delete draftStatus.dataset.state}
  const editorError=byId('w_editor_error');if(editorError){editorError.textContent='';editorError.hidden=true}
  ['w_prompt','rv_crit','rv_err'].forEach(function(id){byId(id)?.replaceChildren()});
  const ring=byId('rv_ring');if(ring){ring.value=0;ring.max=14}
  const scope=byId('rv_scope_notice');if(scope){scope.textContent='';scope.hidden=true}
  const result=byId('rv_result'),failure=byId('rv_error_state');if(result)result.hidden=true;if(failure)failure.hidden=true;
  setTxt('rv_score','—');setTxt('rv_max','из —');setTxt('rv_verdict','Разбор готов');setTxt('rv_sub','');setTxt('rv_status','');setTxt('ai_disclaimer','');
  const savedNotice=byId('rv_saved_notice');if(savedNotice)savedNotice.hidden=true;
  REVIEW_ACTION='new';
  RETIRE_PENDING=null;setRetirementPending(false);settleWritingConfirmation(false);LAST_LIMIT_STATE={key:null,state:null};
  AMBIGUOUS_REQUEST=null;STORAGE_FULL_REQUEST=null;
}
registerRouteHook(function(id,previous){
  WRITING_VIEW_GENERATION++;WRITING_AI_GENERATION++;
  if(previous&&previous!==id&&WRITING_CONFIRMATION)settleWritingConfirmation(false);
  if(previous==='scr12'&&id!=='scr12'){RETIRE_PENDING=null;setRetirementPending(false)}
  clearTimeout(WR_GEN_TIMER);WR_GEN_TIMER=null;
  if(id==='scr8'){if(previous!=='scr8')WR_GEN_DUPLICATE_DRAIN=0;enterWriting();return}
  if(!WRITING_SCREENS.has(id)){WR_GEN=null;W_SHEET=false}
});
registerAuthorityReset(function(authority){
  WRITING_VIEW_GENERATION++;WRITING_AI_GENERATION++;clearTimeout(WR_GEN_TIMER);WR_GEN_TIMER=null;WR_GEN=null;
  if(SUBMISSION&&authority?.owner===SUBMISSION.authority.username&&authority?.ownerGeneration===SUBMISSION.authority.generation)SUBMISSION=null;
  if(SUBMIT_PREFLIGHT&&authority?.owner===SUBMIT_PREFLIGHT.authority.username&&authority?.ownerGeneration===SUBMIT_PREFLIGHT.authority.generation)SUBMIT_PREFLIGHT=null;
  if(AMBIGUOUS_REQUEST&&authority?.owner===AMBIGUOUS_REQUEST.authority.username&&authority?.ownerGeneration===AMBIGUOUS_REQUEST.authority.generation)AMBIGUOUS_REQUEST=null;
  if(STORAGE_FULL_REQUEST&&authority?.owner===STORAGE_FULL_REQUEST.authority.username&&authority?.ownerGeneration===STORAGE_FULL_REQUEST.authority.generation)STORAGE_FULL_REQUEST=null;
  /* Keep durable exact-request records across an ordinary session reset. They are partitioned by
     owner generation and are removed only by the central confirmed-account-deletion purge. */
  WR_GEN_DUPLICATE_DRAIN=0;
  clearTimeout(DRAFT_ANNOUNCE_TIMER);DRAFT_ANNOUNCE_TIMER=null;W_SHEET=false;clearOwnerWritingDom();
});

export {checkWriting,countWords,launchWritingTask,setTask,wrNext,wrSheet};
