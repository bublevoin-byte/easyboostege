(function createProgressSync(global){
  const LEGACY_STORAGE_KEY='easyboost_pending_modules_v2';
  const STORAGE_KEY='easyboost_pending_modules_v3';
  const ATTEMPT_STORAGE_KEY='easyboost_pending_module_attempts_v1';
  const MAX_PENDING_ATTEMPTS=20;
  const MAX_ATTEMPT_BYTES=20_000;
  let baseline={};
  let flushing=null;
  let flushingOwner=null;
  let owner=null;

  function clone(value){return JSON.parse(JSON.stringify(value==null?null:value))}
  function equal(left,right){try{return JSON.stringify(left)===JSON.stringify(right)}catch(_){return false}}
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
  function clearPending(ownerKey=owner,sentModules=null){
    if(!ownerKey)return false;
    const store=readModuleStore(),pending=store.owners[ownerKey];
    if(!pending)return true;
    if(sentModules&&pending.modules&&typeof pending.modules==='object'){
      const remaining={...pending.modules};
      Object.keys(sentModules).forEach(function(key){if(equal(remaining[key],sentModules[key]))delete remaining[key]});
      if(Object.keys(remaining).length)store.owners[ownerKey]={modules:remaining,queuedAt:pending.queuedAt||Date.now()};
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
  function writeAttemptStore(store){
    try{
      const owners=store&&store.owners&&typeof store.owners==='object'?store.owners:{};
      if(!Object.keys(owners).length)localStorage.removeItem(ATTEMPT_STORAGE_KEY);
      else localStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({version:1,owners:owners}));
      return true
    }catch(_){return false}
  }
  function ownerAttempts(store,ownerKey=owner){return ownerKey&&Array.isArray(store.owners[ownerKey])?store.owners[ownerKey]:[]}
  function setOwner(value){
    const nextOwner=normalizedOwner(value);
    if(nextOwner!==owner)baseline={};
    owner=nextOwner;
    try{localStorage.removeItem(LEGACY_STORAGE_KEY)}catch(_){}
    return owner
  }
  function clearOwner(){
    if(!owner)return false;
    const ownerKey=owner;
    const moduleStore=readModuleStore(),attemptStore=readAttemptStore();
    delete moduleStore.owners[ownerKey];delete attemptStore.owners[ownerKey];
    const modulesCleared=writeModuleStore(moduleStore);
    const attemptsCleared=writeAttemptStore(attemptStore);
    owner=null;baseline={};return modulesCleared&&attemptsCleared
  }
  function shouldRetry(error){return !error||!error.status||error.status>=500}
  function changedModules(progress){const modules={};Object.keys(progress||{}).forEach(function(key){if(!equal(progress[key],baseline[key]))modules[key]=clone(progress[key])});return modules}
  function queueModules(modules,ownerKey=owner){
    if(!ownerKey)return false;
    const store=readModuleStore(),previous=readPending(ownerKey);
    const merged={...((previous&&previous.modules)||{}),...clone(modules)};
    store.owners[ownerKey]={modules:merged,queuedAt:Date.now()};return writeModuleStore(store)
  }
  function applyBaseline(modules){baseline={...baseline,...clone(modules)}}

  async function sendModules(modules,ownerKey=owner){
    if(!Object.keys(modules).length)return true;
    try{
      await EasyBoostApi.post('/api/v1/progress/modules',{modules:modules},true);
      if(owner===ownerKey)applyBaseline(modules);
      clearPending(ownerKey,modules);return true
    }
    catch(error){if(shouldRetry(error))queueModules(modules,ownerKey);throw error}
  }
  function queueModuleAttempt(attempt){
    if(!owner||!attempt||typeof attempt!=='object'||typeof attempt.id!=='string'||!attempt.id)return false;
    let candidate;try{candidate=clone(attempt)}catch(_){return false}
    try{if(JSON.stringify(candidate).length>MAX_ATTEMPT_BYTES)return false}catch(_){return false}
    const store=readAttemptStore(),attempts=ownerAttempts(store).slice();
    if(!attempts.some(function(item){return item&&item.id===attempt.id}))attempts.push(candidate);
    store.owners[owner]=attempts.slice(-MAX_PENDING_ATTEMPTS);return writeAttemptStore(store)
  }
  function removeModuleAttempt(id,ownerKey=owner){
    if(!ownerKey)return;
    const store=readAttemptStore(),attempts=ownerAttempts(store,ownerKey).filter(function(item){return item&&item.id!==id});
    if(attempts.length)store.owners[ownerKey]=attempts;else delete store.owners[ownerKey];writeAttemptStore(store)
  }
  async function flushModuleAttempts(ownerKey=owner){
    if(!ownerKey||typeof navigator!=='undefined'&&navigator.onLine===false)return false;
    const attempts=ownerAttempts(readAttemptStore(),ownerKey).slice();if(!attempts.length)return false;
    let sent=false;
    for(const attempt of attempts){
      try{await EasyBoostApi.post('/api/v1/module-attempts',attempt);removeModuleAttempt(attempt.id,ownerKey);sent=true}
      catch(error){
        if(error&&error.status>=400&&error.status<500&&error.status!==401&&error.status!==403){removeModuleAttempt(attempt.id,ownerKey);continue}
        break
      }
    }
    return sent
  }
  async function flush(){
    const requestedOwner=owner;
    if(flushing){
      if(flushingOwner===requestedOwner)return flushing;
      return flushing.then(function(){return flush()},function(){return flush()})
    }
    const ownerKey=owner,pending=readPending(ownerKey);
    const modules=pending&&pending.modules;
    const hasModules=Boolean(modules&&Object.keys(modules).length);
    const hasAttempts=Boolean(ownerAttempts(readAttemptStore(),ownerKey).length);
    if(!hasModules&&!hasAttempts)return false;
    flushingOwner=ownerKey;
    const current=Promise.all([
      hasModules?sendModules(modules,ownerKey).catch(function(){return false}):false,
      hasAttempts?flushModuleAttempts(ownerKey):false,
    ]).then(function(results){return results.some(Boolean)}).finally(function(){
      if(flushing===current){flushing=null;flushingOwner=null}
    });
    flushing=current;
    return flushing;
  }
  function progressModules(progress){
    const pending=readPending();
    return {...((pending&&pending.modules)||{}),...changedModules(progress)}
  }
  function queueProgress(progress){
    const modules=progressModules(progress);
    if(!Object.keys(modules).length)return false;
    return queueModules(modules)
  }
  function saveProgress(progress){
    const modules=progressModules(progress);
    if(!Object.keys(modules).length)return Promise.resolve(true);
    queueModules(modules);
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return Promise.resolve(false);
    return sendModules(modules).catch(function(){return false});
  }
  function saveModuleAttempt(attempt){
    if(!queueModuleAttempt(attempt))return Promise.resolve(false);
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return Promise.resolve(false);
    return flush()
  }
  function setBaseline(progress){baseline=clone(progress||{});return flush()}

  if(typeof window!=='undefined')window.addEventListener('online',flush);
  function pendingModules(){const pending=readPending();return (pending&&pending.modules)||{}}
  function pendingModuleAttempts(){return clone(ownerAttempts(readAttemptStore()))}
  global.EasyBoostSync=Object.freeze({
    queueProgress:queueProgress,saveProgress:saveProgress,saveModuleAttempt:saveModuleAttempt,setBaseline:setBaseline,setOwner:setOwner,clearOwner:clearOwner,
    flush:flush,pendingModules:pendingModules,pendingModuleAttempts:pendingModuleAttempts,
    hasPending:function(){return Boolean(readPending())||Boolean(ownerAttempts(readAttemptStore()).length)},
  });
})(window);
