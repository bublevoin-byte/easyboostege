(function createProgressSync(global){
  const LEGACY_STORAGE_KEY='easyboost_pending_modules_v2';
  const STORAGE_KEY='easyboost_pending_modules_v3';
  const ATTEMPT_STORAGE_KEY='easyboost_pending_module_attempts_v1';
  const GRAMMAR_EVENT_STORAGE_KEY='easyboost_pending_grammar_mastery_events_v1';
  const MAX_PENDING_ATTEMPTS=20;
  const MAX_PENDING_GRAMMAR_EVENTS=20;
  const MAX_ATTEMPT_BYTES=20_000;
  const GRAMMAR_SYNC_CHANNEL='easyboost-grammar-mastery-sync-v1';
  const NON_SYNC_PROGRESS_MODULES=new Set(['grammarMastery','grammarRunner']);
  let baseline={};
  const flushingByOwner=new Map();
  let owner=null;
  let ownerAuthGeneration=null;
  const grammarSyncListeners=new Set();
  const ownerDeletedListeners=new Set();
  const incarnation=global.EasyBoostOwnerIncarnation;
  let grammarSyncChannel=null;

  function clone(value){return JSON.parse(JSON.stringify(value==null?null:value))}
  function synchronizedModules(value){const result=clone(value||{});NON_SYNC_PROGRESS_MODULES.forEach(function(key){delete result[key]});return result}
  function equal(left,right){try{return JSON.stringify(left)===JSON.stringify(right)}catch(_){return false}}
  function canonicalJson(value){
    if(Array.isArray(value))return'['+value.map(canonicalJson).join(',')+']';
    if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(function(key){return JSON.stringify(key)+':'+canonicalJson(value[key])}).join(',')+'}';
    return JSON.stringify(value)
  }
  function canonicalEqual(left,right){try{return canonicalJson(left)===canonicalJson(right)}catch(_){return false}}
  function readModuleStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
      return parsed&&parsed.version===3&&parsed.owners&&typeof parsed.owners==='object'?parsed:{version:3,owners:{}}
    }catch(_){return {version:3,owners:{}}}
  }
  function writeModuleStore(store){
    try{
      const owners=store&&store.owners&&typeof store.owners==='object'?store.owners:{};
      if(!Object.keys(owners).length)localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY,JSON.stringify({version:3,owners:owners}));
      return true
    }catch(_){return false}
  }
  function readPending(ownerKey=owner){const store=readModuleStore();return ownerKey&&store.owners[ownerKey]||null}
  function pendingMatchesOwner(pending,ownerKey=owner){
    if(!pending||!ownerKey)return false;
    const generation=Number.isSafeInteger(pending.ownerGeneration)?pending.ownerGeneration:0;
    return ownerAuthorityCurrent(ownerKey)&&generation===ownerAuthGeneration
  }
  function clearPending(ownerKey=owner,sentModules=null){
    if(!ownerKey)return false;
    const store=readModuleStore(),pending=store.owners[ownerKey];
    if(!pending)return true;
    if(sentModules&&pending.modules&&typeof pending.modules==='object'){
      const remaining={...pending.modules};
      Object.keys(sentModules).forEach(function(key){if(equal(remaining[key],sentModules[key]))delete remaining[key]});
      if(Object.keys(remaining).length)store.owners[ownerKey]={modules:remaining,queuedAt:pending.queuedAt||Date.now(),ownerGeneration:pending.ownerGeneration};
      else delete store.owners[ownerKey]
    }else delete store.owners[ownerKey];
    return writeModuleStore(store)
  }
  function normalizedOwner(value){const result=String(value||'').trim();return result&&result.length<=128?result:null}
  function readAttemptStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(ATTEMPT_STORAGE_KEY)||'null');
      return parsed&&parsed.version===1&&parsed.owners&&typeof parsed.owners==='object'?parsed:{version:1,owners:{}}
    }catch(_){return {version:1,owners:{}}}
  }
  function readGrammarEventStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(GRAMMAR_EVENT_STORAGE_KEY)||'null');
      if(!parsed||![1,2].includes(parsed.version)||!parsed.owners||typeof parsed.owners!=='object')return{version:2,owners:{}};
      const owners={};
      Object.keys(parsed.owners).forEach(function(ownerKey){
        const entry=parsed.owners[ownerKey];
        if(parsed.version===1&&Array.isArray(entry))owners[ownerKey]={ownerGeneration:0,batches:entry};
        else if(parsed.version===2&&entry&&Number.isSafeInteger(entry.ownerGeneration)&&Array.isArray(entry.batches))owners[ownerKey]={ownerGeneration:entry.ownerGeneration,batches:entry.batches}
      });
      return{version:2,owners:owners}
    }catch(_){return {version:2,owners:{}}}
  }
  function writeGrammarEventStore(store){
    try{
      const owners=store&&store.owners&&typeof store.owners==='object'?store.owners:{};
      if(!Object.keys(owners).length)localStorage.removeItem(GRAMMAR_EVENT_STORAGE_KEY);
      else localStorage.setItem(GRAMMAR_EVENT_STORAGE_KEY,JSON.stringify({version:2,owners:owners}));
      return true
    }catch(_){return false}
  }
  function ownerGrammarBatches(store,ownerKey=owner){
    const entry=ownerKey&&store.owners[ownerKey],authority=ownerKey&&ownerAuthSnapshot(ownerKey);
    if(!entry||!authority||authority.deleted||entry.ownerGeneration!==authority.ownerGeneration
      ||ownerKey===owner&&entry.ownerGeneration!==ownerAuthGeneration)return[];
    return entry.batches.flatMap(function(item){
      if(item&&Array.isArray(item.events)&&item.events.length)return[{id:String(item.id||item.events[0]?.event?.id||''),events:item.events}];
      if(item&&item.event)return[{id:String(item.event.id||''),events:[item]}];
      return[]
    })
  }
  function ownerGrammarEvents(store,ownerKey=owner){return ownerGrammarBatches(store,ownerKey).flatMap(function(batch){return batch.events})}
  function writeAttemptStore(store){
    try{
      const owners=store&&store.owners&&typeof store.owners==='object'?store.owners:{};
      if(!Object.keys(owners).length)localStorage.removeItem(ATTEMPT_STORAGE_KEY);
      else localStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({version:1,owners:owners}));
      return true
    }catch(_){return false}
  }
  function ownerAttempts(store,ownerKey=owner){return ownerKey&&Array.isArray(store.owners[ownerKey])?store.owners[ownerKey]:[]}
  function attemptGeneration(item){return Number.isSafeInteger(item&&item._ownerGeneration)?item._ownerGeneration:0}
  function publicAttempt(item){if(!item||typeof item!=='object')return item;const result={...item};delete result._ownerGeneration;return result}
  function isOwnerDeleted(ownerKey){return incarnation.isDeleted(ownerKey)}
  function ownerAuthSnapshot(ownerKey=null){return incarnation.snapshot(ownerKey)}
  function markOwnerDeleted(ownerKey){return incarnation.markDeleted(ownerKey)}
  function observeOwnerDeleted(update){return incarnation.observeDeleted(update)}
  async function purgeEgeMockCaches(){
    const cacheStorage=global.caches;
    if(!cacheStorage||typeof cacheStorage.keys!=='function'||typeof cacheStorage.delete!=='function')return true;
    try{
      const names=await cacheStorage.keys();
      const exact=names.filter(function(name){return name.startsWith('easyboost-ege-mock-assets-v1-')
        ||name.startsWith('easyboost-ege-mock-form-v1-')});
      const deleted=await Promise.all(exact.map(function(name){return cacheStorage.delete(name)}));
      return deleted.every(Boolean)
    }catch(_){return false}
  }
  async function purgeOwnerLocalData(ownerKey,ownerGeneration=0,ownerLockToken=null){
    const moduleStore=readModuleStore(),attemptStore=readAttemptStore(),grammarStore=readGrammarEventStore();
    delete moduleStore.owners[ownerKey];delete attemptStore.owners[ownerKey];delete grammarStore.owners[ownerKey];
    let snapshot=true;try{localStorage.removeItem('eb_data_'+ownerKey);localStorage.removeItem('eb_data_'+ownerKey+'_g'+ownerGeneration);
      localStorage.removeItem('easyboost-ege-mock-written-v1:'+ownerKey+':'+ownerGeneration);
      localStorage.removeItem('easyboost-ege-mock-written-v1:'+ownerKey+':'+ownerGeneration+':invalidation')}catch(_){snapshot=false}
    const modulesCleared=writeModuleStore(moduleStore);
    const attemptsCleared=writeAttemptStore(attemptStore);
    const grammarCleared=writeGrammarEventStore(grammarStore);
    let marker=true,runtime=true,overview=true;
    if(ownerLockToken){
      marker=incarnation.clearMatchingStorageLocked(ownerKey,'eb_current',function(raw){try{const value=JSON.parse(raw);
        return value&&value.owner===ownerKey&&value.ownerGeneration===ownerGeneration}catch(_){return ownerGeneration===0&&raw===ownerKey}},ownerLockToken);
      const runtimeKey='easyboost.adaptive.execution.v1:'+encodeURIComponent(ownerKey)+':g'+ownerGeneration;
      runtime=incarnation.clearMatchingStorageLocked(ownerKey,runtimeKey,function(raw){try{const value=JSON.parse(raw);
        return value&&value.owner===ownerKey&&(value.version===3?0:value.ownerGeneration)===ownerGeneration}catch(_){return false}},ownerLockToken);
      if(ownerGeneration===0)runtime=incarnation.clearMatchingStorageLocked(ownerKey,'easyboost.adaptive.execution.v1',function(raw){try{const value=JSON.parse(raw);
        return value&&value.owner===ownerKey&&(value.version===3||value.ownerGeneration===0)}catch(_){return false}},ownerLockToken)&&runtime;
      const overviewKey='easyboost.adaptive.overview.v1:'+encodeURIComponent(ownerKey)+':g'+ownerGeneration;
      overview=incarnation.clearMatchingStorageLocked(ownerKey,overviewKey,function(raw){try{const value=JSON.parse(raw);
        return value&&value.owner===ownerKey&&(value.version==='adaptive-overview-cache-v1'?0:value.ownerGeneration)===ownerGeneration}catch(_){return false}},ownerLockToken)
      if(ownerGeneration===0)overview=incarnation.clearMatchingStorageLocked(ownerKey,'easyboost.adaptive.overview.v1',function(raw){try{const value=JSON.parse(raw);
        return value&&value.owner===ownerKey&&(value.version==='adaptive-overview-cache-v1'?0:value.ownerGeneration)===0}catch(_){return false}},ownerLockToken)&&overview
    }
    const egeCaches=await purgeEgeMockCaches();
    return modulesCleared&&attemptsCleared&&grammarCleared&&snapshot&&marker&&runtime&&overview&&egeCaches
  }
  function durableOwnerAuthorityMatches(ownerKey,generation){
    if(!ownerKey||!Number.isSafeInteger(generation))return false;
    const authority=ownerAuthSnapshot(ownerKey);
    return !authority.deleted&&authority.ownerGeneration===generation
  }
  function ownerAuthorityMatches(ownerKey,generation){
    return ownerKey===owner&&ownerAuthGeneration===generation&&durableOwnerAuthorityMatches(ownerKey,generation)
  }
  function ownerAuthorityCurrent(ownerKey=owner){return ownerAuthorityMatches(ownerKey,ownerAuthGeneration)}
  function ownerBoundGeneration(ownerKey=owner){return ownerKey===owner&&Number.isSafeInteger(ownerAuthGeneration)
    &&durableOwnerAuthorityMatches(ownerKey,ownerAuthGeneration)?ownerAuthGeneration:null}
  function setOwner(value){
    const nextOwner=normalizedOwner(value);
    if(nextOwner!==owner)baseline={};
    owner=nextOwner;ownerAuthGeneration=owner?ownerAuthSnapshot(owner).ownerGeneration:null;
    try{localStorage.removeItem(LEGACY_STORAGE_KEY)}catch(_){}
    return owner
  }
  async function confirmOwner(value,authGuard={},callbacks={}){const nextOwner=normalizedOwner(value);if(!nextOwner)return null;
    const committed=await incarnation.commitOwnerAdoption(nextOwner,{...authGuard,revive:true},callbacks);
    if(!committed)return null;publishOwnerRevived(nextOwner,committed);return setOwner(nextOwner)}
  async function adoptOwner(value,expectedGeneration,callbacks={}){const nextOwner=normalizedOwner(value);if(!nextOwner)return null;
    const committed=await incarnation.commitOwnerAdoption(nextOwner,{ownerScoped:true,ownerGeneration:expectedGeneration,revive:false},callbacks);
    return committed?setOwner(nextOwner):null}
  async function clearOwner(){
    if(!owner)return false;
    const ownerKey=owner;
    const locks=global.navigator&&global.navigator.locks;
    const previousGeneration=ownerAuthGeneration;
    const mutate=async function(token){const tombstone=markOwnerDeleted(ownerKey);
      if(owner===ownerKey){owner=null;ownerAuthGeneration=null;baseline={}}publishOwnerDeleted(ownerKey,tombstone);
      const cleared=await purgeOwnerLocalData(ownerKey,previousGeneration,token);return{tombstone:tombstone,cleared:cleared}};
    const outcome=await (locks&&typeof locks.request==='function'?withGrammarQueueLock(mutate,ownerKey):mutate());
    const tombstone=outcome&&outcome.tombstone||{saved:false,ownerGeneration:ownerAuthSnapshot(ownerKey).ownerGeneration,globalGeneration:ownerAuthSnapshot(ownerKey).globalGeneration};
    const cleared=Boolean(outcome&&outcome.cleared);
    if(owner===ownerKey){owner=null;ownerAuthGeneration=null;baseline={}}
    if(cleared!==true)return cleared&&cleared.code?cleared:grammarQueueError('GRAMMAR_MASTERY_QUEUE_WRITE_FAILED','Не удалось полностью удалить локальные данные аккаунта.');
    if(!tombstone.saved)return grammarQueueError('GRAMMAR_MASTERY_QUEUE_WRITE_FAILED','Локальные данные удалены, но браузер не смог сохранить запрет на восстановление аккаунта.');
    return true
  }
  async function deleteOwner(removeRemote){
    if(!owner||typeof removeRemote!=='function')return false;
    const ownerKey=owner;
    return withGrammarQueueLock(async function(token){
      if(!ownerAuthorityCurrent(ownerKey))return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился. Войдите снова перед удалением.');
      await removeRemote(ownerKey);
      const previousGeneration=ownerAuthGeneration;
      const tombstone=markOwnerDeleted(ownerKey);
      if(owner===ownerKey){owner=null;ownerAuthGeneration=null;baseline={}}
      publishOwnerDeleted(ownerKey,tombstone);
      const cleared=await purgeOwnerLocalData(ownerKey,previousGeneration,token);
      if(!cleared)return grammarQueueError('GRAMMAR_MASTERY_QUEUE_WRITE_FAILED','Не удалось полностью удалить локальные данные аккаунта.');
      if(!tombstone.saved)return grammarQueueError('GRAMMAR_MASTERY_QUEUE_WRITE_FAILED','Локальные данные удалены, но браузер не смог сохранить запрет на восстановление аккаунта.');
      return true
    },ownerKey)
  }
  function shouldRetry(error){return !error||!error.status||error.status>=500}
  function changedModules(progress){const modules={};Object.keys(progress||{}).forEach(function(key){if(!NON_SYNC_PROGRESS_MODULES.has(key)&&!equal(progress[key],baseline[key]))modules[key]=clone(progress[key])});return modules}
  function queueModules(modules,ownerKey=owner){
    if(!ownerKey||isOwnerDeleted(ownerKey)||!ownerAuthorityCurrent(ownerKey))return false;
    modules=synchronizedModules(modules);
    const store=readModuleStore(),previous=readPending(ownerKey);
    const merged={...synchronizedModules((pendingMatchesOwner(previous,ownerKey)&&previous.modules)||{}),...modules};
    if(isOwnerDeleted(ownerKey)||!ownerAuthorityCurrent(ownerKey))return false;
    store.owners[ownerKey]={modules:merged,queuedAt:Date.now(),ownerGeneration:ownerAuthGeneration};return writeModuleStore(store)
  }
  function applyBaseline(modules){baseline={...baseline,...clone(modules)}}

  async function sendModules(modules,ownerKey=owner,expectedGeneration=ownerAuthGeneration){
    modules=synchronizedModules(modules);
    if(!Object.keys(modules).length)return true;
    if(isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))return false;
    try{
      await EasyBoostApi.post('/api/v1/progress/modules',{owner:ownerKey,modules:modules},true);
      return withGrammarQueueLock(function(){
        if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return false;
        applyBaseline(modules);clearPending(ownerKey,modules);return true
      },ownerKey)
    }
    catch(error){if(shouldRetry(error))await withGrammarQueueLock(function(){
      return ownerAuthorityMatches(ownerKey,expectedGeneration)?queueModules(modules,ownerKey):false
    },ownerKey);throw error}
  }
  function queueModuleAttempt(attempt,ownerKey=owner,expectedGeneration=ownerAuthGeneration){
    if(!ownerKey||isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration)||!attempt||typeof attempt!=='object'||typeof attempt.id!=='string'||!attempt.id)return false;
    let candidate;try{candidate={...clone(attempt),_ownerGeneration:expectedGeneration}}catch(_){return false}
    try{if(JSON.stringify(candidate).length>MAX_ATTEMPT_BYTES)return false}catch(_){return false}
    const store=readAttemptStore(),attempts=ownerAttempts(store,ownerKey).slice();
    if(!attempts.some(function(item){return item&&item.id===attempt.id}))attempts.push(candidate);
    if(isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))return false;
    store.owners[ownerKey]=attempts.slice(-MAX_PENDING_ATTEMPTS);return writeAttemptStore(store)
  }
  function removeModuleAttempt(id,ownerKey=owner){
    if(!ownerKey)return;
    const store=readAttemptStore(),attempts=ownerAttempts(store,ownerKey).filter(function(item){return item&&item.id!==id});
    if(attempts.length)store.owners[ownerKey]=attempts;else delete store.owners[ownerKey];writeAttemptStore(store)
  }
  async function sendModuleAttempt(attempt,ownerKey,expectedGeneration,ownerLockToken=null){
    if(!ownerAuthorityMatches(ownerKey,expectedGeneration)||attemptGeneration(attempt)!==expectedGeneration)return{stop:true,ownerConflict:true};
    try{await EasyBoostApi.post('/api/v1/module-attempts',{...publicAttempt(attempt),owner:ownerKey});
      return withGrammarQueueLock(function(){
        if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return{stop:true,ownerConflict:true};
        removeModuleAttempt(attempt.id,ownerKey);return{sent:true}
      },ownerKey,ownerLockToken)}
    catch(error){if(error&&error.status>=400&&error.status<500&&error.status!==401&&error.status!==403
      &&error.code!=='OWNER_CHANGED')return withGrammarQueueLock(function(){
        if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return{stop:true,ownerConflict:true};
        removeModuleAttempt(attempt.id,ownerKey);return{discarded:true,code:error.code||'MODULE_ATTEMPT_REJECTED'}
      },ownerKey,ownerLockToken);
      return{stop:true,ownerConflict:error&&error.code==='OWNER_CHANGED',code:error&&error.code||'NETWORK_ERROR'}}
  }
  function ownerLockTokenMatches(token,ownerKey,expectedGeneration){
    return incarnation.tokenMatches(token,ownerKey)&&ownerAuthorityMatches(ownerKey,expectedGeneration)}
  async function flushModuleAttempts(ownerKey=owner,targetAttemptId=null,expectedGeneration=ownerAuthGeneration,ownerLockToken=null){
    const targeted=typeof targetAttemptId==='string'&&Boolean(targetAttemptId);
    const retryResult=function(code='NETWORK_ERROR'){return targeted?{status:'queued_retry',code:code}:false};
    if(!ownerKey||isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))return targeted?{status:'owner_conflict',code:'OWNER_CHANGED'}:false;
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return retryResult();
    const attempts=await withGrammarQueueLock(function(){return ownerAuthorityMatches(ownerKey,expectedGeneration)
      ?clone(ownerAttempts(readAttemptStore(),ownerKey).filter(function(item){return attemptGeneration(item)===expectedGeneration})):[]},ownerKey,ownerLockToken);
    if(!Array.isArray(attempts)||!attempts.length)return retryResult();
    let sent=false,targetResult=null;
    for(const attempt of attempts){
      const result=await sendModuleAttempt(attempt,ownerKey,expectedGeneration,ownerLockToken);
      if(result&&result.sent){sent=true;if(attempt.id===targetAttemptId)targetResult={status:'delivered',code:null};continue}
      if(result&&result.discarded){if(attempt.id===targetAttemptId)targetResult={status:'terminal_rejected',code:result.code};continue}
      if(attempt.id===targetAttemptId)targetResult=result&&result.ownerConflict?{status:'owner_conflict',code:'OWNER_CHANGED'}:{status:'queued_retry',code:result&&result.code||'NETWORK_ERROR'};
      break
    }
    return targeted?targetResult||{status:'queued_retry',code:'NETWORK_ERROR'}:sent
  }
  function grammarQueueError(code,message){return{queued:false,code:code,message:message}}
  function deliverGrammarMasterySync(update){
    if(!update||typeof update.owner!=='string'||!Number.isSafeInteger(update.ownerGeneration)||!Array.isArray(update.records))return;
    const authority=ownerAuthSnapshot(update.owner);
    if(authority.deleted||authority.ownerGeneration!==update.ownerGeneration
      ||update.owner===owner&&update.ownerGeneration!==ownerAuthGeneration)return;
    grammarSyncListeners.forEach(function(listener){try{listener(clone(update))}catch(_){}})
  }
  function deliverOwnerDeleted(update){
    ownerDeletedListeners.forEach(function(listener){try{listener(clone(update))}catch(_){}})
  }
  function receiveSyncMessage(update){
    if(update&&update.type==='owner_deleted'&&typeof update.owner==='string'){
      void withGrammarQueueLock(async function(token){const before=ownerAuthSnapshot(update.owner).ownerGeneration;
        const observed=observeOwnerDeleted(update);
        deliverOwnerDeleted(update);
        if(observed){await purgeOwnerLocalData(update.owner,Math.max(0,Number(update.ownerGeneration)-1||before),token);if(owner===update.owner)baseline={}}
        return true
      },update.owner);
      return
    }
    if(update&&update.type==='owner_revived'&&typeof update.owner==='string')return;
    deliverGrammarMasterySync(update)
  }
  function ensureGrammarSyncChannel(){
    if(grammarSyncChannel||typeof global.BroadcastChannel!=='function')return grammarSyncChannel;
    try{grammarSyncChannel=new global.BroadcastChannel(GRAMMAR_SYNC_CHANNEL);grammarSyncChannel.onmessage=function(message){receiveSyncMessage(message&&message.data)}}catch(_){grammarSyncChannel=null}
    return grammarSyncChannel
  }
  function onGrammarMasterySync(listener){
    if(typeof listener!=='function')return function(){};
    grammarSyncListeners.add(listener);ensureGrammarSyncChannel();
    return function(){grammarSyncListeners.delete(listener)}
  }
  function onOwnerDeleted(listener){
    if(typeof listener!=='function')return function(){};
    ownerDeletedListeners.add(listener);ensureGrammarSyncChannel();
    return function(){ownerDeletedListeners.delete(listener)}
  }
  function grammarMasteryResultForEntry(entry,results){
    const eventId=entry&&entry.event&&entry.event.id,topicId=Number(entry&&entry.topicId);
    const matches=(results||[]).filter(function(result){return result&&result.eventId===eventId});
    return matches.find(function(result){return Number(result.topicId)===topicId})
      ||(!grammarMasteryEntryExpandsTopics(entry)?matches.find(function(result){return result.topicId==null}):null)
  }
  function grammarMasteryEntryExpandsTopics(entry){
    return Array.isArray(entry&&entry.event&&entry.event.session&&entry.event.session.topicExpectations)
  }
  function grammarMasteryResultTopicAllowed(entry,topicId){
    const expectations=entry&&entry.event&&entry.event.session&&entry.event.session.topicExpectations;
    if(!Array.isArray(expectations))return topicId===Number(entry&&entry.topicId);
    return expectations.some(function(expectation){return Number(expectation&&expectation.topicId)===topicId})
  }
  function publishGrammarMasterySync(ownerKey,expectedGeneration,entries,results){
    if(isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))return;
    const entriesById=new Map(entries.map(function(entry){return[entry&&entry.event&&entry.event.id,entry]})),seen=new Set(),records=[];
    for(const result of results||[]){
      const entry=entriesById.get(result&&result.eventId),resultTopicId=result&&result.topicId==null?NaN:Number(result.topicId);
      const topicId=Number.isInteger(resultTopicId)?resultTopicId:Number(entry&&entry.topicId);
      const identity=`${result&&result.eventId}:${topicId}`;
      if(!entry||result.topicId==null&&grammarMasteryEntryExpandsTopics(entry)||!Number.isInteger(topicId)||!grammarMasteryResultTopicAllowed(entry,topicId)||seen.has(identity)||!(result.applied||result.replay||result.conflict)||!result.record)continue;
      seen.add(identity);records.push({topicId:topicId,record:result.record})
    }
    if(!records.length)return;
    const update={owner:ownerKey,ownerGeneration:expectedGeneration,records:records};deliverGrammarMasterySync(update);
    try{ensureGrammarSyncChannel()?.postMessage(clone(update))}catch(_){}
  }
  function publishOwnerDeleted(ownerKey,tombstone){
    const update={type:'owner_deleted',owner:ownerKey,ownerGeneration:tombstone.ownerGeneration,globalGeneration:tombstone.globalGeneration};
    deliverOwnerDeleted(update);
    try{ensureGrammarSyncChannel()?.postMessage(clone(update))}catch(_){}
  }
  function publishOwnerRevived(ownerKey,snapshot){
    const update={type:'owner_revived',owner:ownerKey,ownerGeneration:snapshot.ownerGeneration,globalGeneration:snapshot.globalGeneration};
    try{ensureGrammarSyncChannel()?.postMessage(clone(update))}catch(_){}
  }
  function withGrammarQueueLock(action,lockOwner=owner,existingToken=null){
    const deepOwner=normalizedOwner(lockOwner)||'unbound';
    return incarnation.withOwnerLock(deepOwner,action,existingToken).then(function(result){return result==null
      ?grammarQueueError('GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE','Safe local persistence is unavailable in this browser.')
      :result});
  }
  function withOwnerIncarnationLock(guard,action){const ownerKey=normalizedOwner(guard&&guard.owner),expectedGeneration=Number(guard&&guard.ownerGeneration);
    if(!ownerKey||!Number.isSafeInteger(expectedGeneration)||typeof action!=='function')return Promise.resolve(grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился.'));
    return withGrammarQueueLock(async function(token){
      if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился.');
      return action(token)
    },ownerKey)
  }
  function withDurableOwnerIncarnationLock(guard,action){const ownerKey=normalizedOwner(guard&&guard.owner),expectedGeneration=Number(guard&&guard.ownerGeneration);
    if(!ownerKey||!Number.isSafeInteger(expectedGeneration)||typeof action!=='function')return Promise.resolve(grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился.'));
    return withGrammarQueueLock(async function(token){const authority=ownerAuthSnapshot(ownerKey);
      if(authority.deleted||authority.ownerGeneration!==expectedGeneration)return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился.');
      return action(token)
    },ownerKey)
  }
  function queueGrammarMasteryBatch(ownerKey,expectedGeneration,entries){
    if(isOwnerDeleted(ownerKey))return grammarQueueError('GRAMMAR_MASTERY_OWNER_DELETED','Аккаунт удалён. Результат нельзя сохранить.');
    if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился. Войдите снова перед сохранением результата.');
    if(!ownerKey||!Array.isArray(entries)||!entries.length||entries.length>MAX_PENDING_GRAMMAR_EVENTS)return grammarQueueError('GRAMMAR_MASTERY_EVENT_INVALID','Некорректный результат тренировки.');
    let candidates;try{candidates=clone(entries)}catch(_){return grammarQueueError('GRAMMAR_MASTERY_EVENT_INVALID','Некорректный результат тренировки.')}
    if(candidates.some(function(item){return !Number.isInteger(Number(item&&item.topicId))||!item.event||typeof item.event.id!=='string'||!item.event.id}))return grammarQueueError('GRAMMAR_MASTERY_EVENT_INVALID','Некорректный результат тренировки.');
    const store=readGrammarEventStore();
    let batches=ownerGrammarBatches(store,ownerKey);
    const events=batches.flatMap(function(batch){return batch.events});
    const existingIds=new Set(events.map(function(item){return item.event.id}));
    const requestedIds=new Set(candidates.map(function(item){return item.event.id}));
    if(requestedIds.size!==candidates.length)return grammarQueueError('GRAMMAR_MASTERY_EVENT_INVALID','Некорректный результат тренировки.');
    const duplicateBatch=batches.find(function(batch){return batch.events.length===candidates.length
      &&candidates.every(function(item){return batch.events.some(function(existing){return existing.event.id===item.event.id})})});
    if(duplicateBatch){
      const exact=candidates.every(function(item){return duplicateBatch.events.some(function(existing){return Number(existing.topicId)===Number(item.topicId)&&existing.event.id===item.event.id&&canonicalEqual(existing.event,item.event)})});
      return exact?{queued:true,duplicate:true,batchId:duplicateBatch.id}:grammarQueueError('GRAMMAR_MASTERY_EVENT_CONFLICT','Этот результат уже ожидает синхронизации с другим содержимым.')
    }
    const blockedTopics=new Set(events.filter(function(item){return Number.isInteger(item&&item._conflictRevision)})
      .map(function(item){return Number(item.topicId)}));
    if(candidates.some(function(item){return blockedTopics.has(Number(item.topicId))}))return grammarQueueError('GRAMMAR_MASTERY_EVENT_CONFLICT','Previous evidence for this topic is still unresolved.');
    const retryableCount=events.filter(function(item){return !Number.isInteger(item&&item._conflictRevision)}).length;
    if(retryableCount+candidates.length>MAX_PENDING_GRAMMAR_EVENTS)return grammarQueueError('GRAMMAR_MASTERY_QUEUE_FULL','Подключитесь для синхронизации: очередь результатов заполнена.');
    if(candidates.some(function(item){return existingIds.has(item.event.id)}))return grammarQueueError('GRAMMAR_MASTERY_EVENT_INVALID','Некорректный результат тренировки.');
    const batchId=candidates[0].event.id;
    batches.push({id:batchId,events:candidates});
    if(isOwnerDeleted(ownerKey))return grammarQueueError('GRAMMAR_MASTERY_OWNER_DELETED','Аккаунт удалён. Результат нельзя сохранить.');
    if(!ownerAuthorityMatches(ownerKey,expectedGeneration))return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился. Войдите снова перед сохранением результата.');
    store.owners[ownerKey]={ownerGeneration:expectedGeneration,batches:batches};
    return writeGrammarEventStore(store)?{queued:true,batchId:batchId}:{...grammarQueueError('GRAMMAR_MASTERY_QUEUE_WRITE_FAILED','Не удалось безопасно сохранить результат.')}
  }
  function coalesceGrammarConflictMarkers(batches){
    return batches.filter(function(batch){return batch.events.length})
  }
  function replaceGrammarMasteryBatch(ownerKey,expectedGeneration,batchId,events){
    if(isOwnerDeleted(ownerKey)||!durableOwnerAuthorityMatches(ownerKey,expectedGeneration))return false;
    const store=readGrammarEventStore(),batches=ownerGrammarBatches(store,ownerKey),index=batches.findIndex(function(batch){return batch.id===batchId});
    if(index<0)return false;
    if(events.length)batches[index]={id:batchId,events:events};else batches.splice(index,1);
    const coalesced=coalesceGrammarConflictMarkers(batches);
    if(!durableOwnerAuthorityMatches(ownerKey,expectedGeneration))return false;
    if(coalesced.length)store.owners[ownerKey]={ownerGeneration:expectedGeneration,batches:coalesced};else delete store.owners[ownerKey];return writeGrammarEventStore(store)
  }
  async function flushGrammarMasteryEventsUnlocked(ownerKey,targetBatchId=null,expectedGeneration=ownerAuthGeneration){
      const batches=await withGrammarQueueLock(function(){return ownerAuthorityMatches(ownerKey,expectedGeneration)
        ?clone(ownerGrammarBatches(readGrammarEventStore(),ownerKey)):[]},ownerKey);
      if(!Array.isArray(batches)||!batches.length||isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))return false;
      let last=false,target=false;const blockedTopics=new Set();
      for(const batch of batches){
        if(isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration))break;
        const blocked=batch.events.filter(function(item){return Number.isInteger(item&&item._conflictRevision)});
        blocked.forEach(function(item){blockedTopics.add(Number(item.topicId))});
        let events=batch.events.filter(function(item){return !Number.isInteger(item&&item._conflictRevision)
          &&!blockedTopics.has(Number(item.topicId))});
        if(!events.length)continue;
        for(let attempt=0;attempt<2&&events.length;attempt++){
          try{
            last=await EasyBoostApi.post('/api/v1/grammar/mastery-events/batch',{owner:ownerKey,batchId:batch.id,events:events},true);
            if(batch.id===targetBatchId)target=last;
            if(isOwnerDeleted(ownerKey)||!durableOwnerAuthorityMatches(ownerKey,expectedGeneration))return false;
            const update=await withGrammarQueueLock(function(){
              if(!durableOwnerAuthorityMatches(ownerKey,expectedGeneration))return null;
              const results=last&&last.results||[],knownIds=[],remaining=blocked.slice();
              for(const item of events){
                const result=grammarMasteryResultForEntry(item,results);
                if(result)knownIds.push(item.event.id);
                if(result&&(result.applied||result.replay))continue;
                const conflictRevision=Number(result&&result.record&&result.record.masteryRevision);
                remaining.push(result&&result.conflict&&Number.isInteger(conflictRevision)
                  ?{...item,_conflictRevision:conflictRevision}:item);
                if(result&&result.conflict&&Number.isInteger(conflictRevision))blockedTopics.add(Number(item.topicId))
              }
              if(!replaceGrammarMasteryBatch(ownerKey,expectedGeneration,batch.id,remaining))return null;
              publishGrammarMasterySync(ownerKey,expectedGeneration,events,results);
              return{remaining:remaining,knownIds:knownIds}
            },ownerKey);
            if(!update||!Array.isArray(update.remaining))break;
            const remaining=update.remaining,knownIds=new Set(update.knownIds||[]);
            events=remaining.filter(function(item){return !Number.isInteger(item&&item._conflictRevision)});
            if(!ownerAuthorityMatches(ownerKey,expectedGeneration))break;
            if(!events.length||!events.every(function(item){return !knownIds.has(item.event.id)}))break
          }catch(error){
            if(error&&error.code==='GRAMMAR_MASTERY_OWNER_CHANGED')return grammarQueueError('GRAMMAR_MASTERY_OWNER_CHANGED','Аккаунт изменился. Войдите снова и повторите синхронизацию.');
            return false
          }
        }
      }
      return targetBatchId?target:last
  }
  async function flushGrammarMasteryEvents(ownerKey=owner,expectedGeneration=ownerAuthGeneration){
    if(!ownerKey||isOwnerDeleted(ownerKey)||!ownerAuthorityMatches(ownerKey,expectedGeneration)||typeof navigator!=='undefined'&&navigator.onLine===false)return false;
    return flushGrammarMasteryEventsUnlocked(ownerKey,null,expectedGeneration)
  }
  async function flush(){
    const requestedOwner=owner;
    if(!ownerAuthorityCurrent(requestedOwner))return false;
    if(flushingByOwner.has(requestedOwner))return flushingByOwner.get(requestedOwner);
    const ownerKey=owner,expectedGeneration=ownerAuthGeneration,pending=readPending(ownerKey);
    const modules=synchronizedModules((pendingMatchesOwner(pending,ownerKey)&&pending.modules)||{});
    const hasModules=Boolean(modules&&Object.keys(modules).length);
    const hasAttempts=ownerAttempts(readAttemptStore(),ownerKey).some(function(item){return attemptGeneration(item)===expectedGeneration});
    const hasGrammarEvents=Boolean(ownerGrammarBatches(readGrammarEventStore(),ownerKey).length);
    if(!hasModules&&!hasAttempts&&!hasGrammarEvents)return false;
    const current=Promise.all([
      hasModules?sendModules(modules,ownerKey,expectedGeneration).catch(function(){return false}):false,
      hasAttempts?flushModuleAttempts(ownerKey,null,expectedGeneration):false,
      hasGrammarEvents?flushGrammarMasteryEvents(ownerKey,expectedGeneration):false,
    ]).then(function(results){return results.some(function(result){
      return result===true||Boolean(result&&Array.isArray(result.results)&&result.results.some(function(item){return item&&(item.applied||item.replay)}))
    })}).finally(function(){
      if(flushingByOwner.get(ownerKey)===current)flushingByOwner.delete(ownerKey)
    });
    flushingByOwner.set(ownerKey,current);
    return current;
  }
  function progressModules(progress){
    const pending=readPending();
    return {...((pendingMatchesOwner(pending)&&pending.modules)||{}),...changedModules(progress)}
  }
  async function queueProgress(progress){
    const modules=progressModules(progress);
    if(!Object.keys(modules).length)return false;
    const ownerKey=owner;
    return withGrammarQueueLock(function(){return owner===ownerKey?queueModules(modules,ownerKey):false},ownerKey)
  }
  async function saveProgress(progress){
    const modules=progressModules(progress);
    if(!Object.keys(modules).length)return true;
    const ownerKey=owner,expectedGeneration=ownerAuthGeneration;
    const queued=await withGrammarQueueLock(function(){
      if(owner!==ownerKey||queueModules(modules,ownerKey)!==true)return false;
      return true
    },ownerKey);
    if(queued!==true||typeof navigator!=='undefined'&&navigator.onLine===false)return false;
    return sendModules(modules,ownerKey,expectedGeneration).catch(function(){return false})
  }
  async function saveModuleAttempt(attempt,guard={}){
    const ownerKey=owner,guarded=Object.hasOwn(guard,'owner');
    const expectedGeneration=guarded?guard.ownerGeneration:ownerAuthGeneration;
    const ownerConflict=function(){return guarded?{status:'owner_conflict',code:'OWNER_CHANGED'}:false};
    if(guarded&&(guard.owner!==ownerKey||!ownerAuthorityMatches(ownerKey,expectedGeneration)))return ownerConflict();
    const held=ownerLockTokenMatches(guard&&guard.ownerLockToken,ownerKey,expectedGeneration);
    const queued=held?(ownerAuthorityMatches(ownerKey,expectedGeneration)?queueModuleAttempt(attempt,ownerKey,expectedGeneration):ownerConflict())
      :await withGrammarQueueLock(function(){return ownerAuthorityMatches(ownerKey,expectedGeneration)?queueModuleAttempt(attempt,ownerKey,expectedGeneration):ownerConflict()},ownerKey);
    if(queued!==true){
      if(guarded&&queued&&queued.code==='GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE')return{status:'queued_retry',code:queued.code};
      return queued&&queued.status?queued:ownerConflict()
    }
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return guarded?{status:'queued_retry',code:'NETWORK_ERROR'}:false;
    return flushModuleAttempts(ownerKey,attempt&&attempt.id,expectedGeneration,held?guard.ownerLockToken:null)
  }
  async function saveGrammarMasteryEvents(entries){
    const ownerKey=owner,expectedGeneration=ownerAuthGeneration;
    const queued=await withGrammarQueueLock(function(){
      const queued=queueGrammarMasteryBatch(ownerKey,expectedGeneration,entries);
      return queued||false
    },ownerKey);
    if(!queued||queued.queued!==true)return queued||false;
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return false;
    const result=await flushGrammarMasteryEventsUnlocked(ownerKey,queued.batchId,expectedGeneration);
    return ownerAuthorityMatches(ownerKey,expectedGeneration)?result:false
  }
  function saveGrammarMasteryEvent(topicId,event){return saveGrammarMasteryEvents([{topicId:Number(topicId),event:event}])}
  function setBaseline(progress){baseline=clone(progress||{});return flush()}

  if(typeof window!=='undefined')window.addEventListener('online',flush);
  function pendingModules(){
    const pending=readPending();
    const modules=pendingMatchesOwner(pending)?pending.modules||{}:{};
    if(!Object.keys(modules).some(function(key){return NON_SYNC_PROGRESS_MODULES.has(key)}))return modules;
    const sanitized=clone(modules);
    NON_SYNC_PROGRESS_MODULES.forEach(function(key){delete sanitized[key]});
    return sanitized
  }
  function pendingModuleAttempts(){return clone(ownerAttempts(readAttemptStore()).filter(function(item){return attemptGeneration(item)===ownerAuthGeneration}).map(publicAttempt))}
  function pendingGrammarMasteryEvents(){return clone(ownerGrammarEvents(readGrammarEventStore()))}
  function canQueueGrammarMasteryEvent(required=1){
    const slots=Math.max(1,Math.min(MAX_PENDING_GRAMMAR_EVENTS,Math.floor(Number(required)||1)));
    const retryable=ownerGrammarEvents(readGrammarEventStore()).filter(function(item){return !Number.isInteger(item&&item._conflictRevision)});
    return Boolean(owner)&&!isOwnerDeleted(owner)&&ownerAuthorityCurrent(owner)&&retryable.length+slots<=MAX_PENDING_GRAMMAR_EVENTS
  }
  global.EasyBoostSync=Object.freeze({
    queueProgress:queueProgress,saveProgress:saveProgress,saveModuleAttempt:saveModuleAttempt,saveGrammarMasteryEvent:saveGrammarMasteryEvent,saveGrammarMasteryEvents:saveGrammarMasteryEvents,setBaseline:setBaseline,setOwner:setOwner,confirmOwner:confirmOwner,adoptOwner:adoptOwner,clearOwner:clearOwner,deleteOwner:deleteOwner,isOwnerDeleted:isOwnerDeleted,ownerAuthSnapshot:ownerAuthSnapshot,ownerBoundGeneration:ownerBoundGeneration,withOwnerIncarnationLock:withOwnerIncarnationLock,withDurableOwnerIncarnationLock:withDurableOwnerIncarnationLock,
    flush:flush,pendingModules:pendingModules,pendingModuleAttempts:pendingModuleAttempts,pendingGrammarMasteryEvents:pendingGrammarMasteryEvents,canQueueGrammarMasteryEvent:canQueueGrammarMasteryEvent,onGrammarMasterySync:onGrammarMasterySync,onOwnerDeleted:onOwnerDeleted,
    hasPending:function(){return Object.keys(pendingModules()).length>0
      ||ownerAttempts(readAttemptStore()).some(function(item){return attemptGeneration(item)===ownerAuthGeneration})
      ||Boolean(ownerGrammarEvents(readGrammarEventStore()).length)},
  });
})(window);
