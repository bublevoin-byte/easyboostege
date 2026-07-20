(function createProgressSync(global){
  const STORAGE_KEY='easyboost_pending_progress_v1';
  let flushing=null;

  function readPending(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch(_){return null}}
  function queueProgress(progress){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({progress:progress,queuedAt:Date.now()}))}catch(_){}}
  function clearPending(){try{localStorage.removeItem(STORAGE_KEY)}catch(_){}}
  function shouldRetry(error){return !error||!error.status||error.status>=500}

  async function send(progress){
    try{await EasyBoostApi.post('/api/progress',progress,true);clearPending();return true}
    catch(error){if(shouldRetry(error))queueProgress(progress);throw error}
  }

  async function flush(){
    if(flushing)return flushing;
    const pending=readPending();
    if(!pending||!pending.progress)return false;
    flushing=send(pending.progress).catch(function(){return false}).finally(function(){flushing=null});
    return flushing;
  }

  function saveProgress(progress){
    if(typeof navigator!=='undefined'&&navigator.onLine===false){queueProgress(progress);return Promise.resolve(false)}
    return send(progress).catch(function(){return false});
  }

  if(typeof window!=='undefined')window.addEventListener('online',flush);
  global.EasyBoostSync=Object.freeze({saveProgress:saveProgress,flush:flush,hasPending:function(){return Boolean(readPending())}});
})(window);
