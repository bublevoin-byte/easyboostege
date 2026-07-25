(function createProgressSync(global){
  const STORAGE_KEY='easyboost_pending_modules_v2';
  let baseline={};
  let flushing=null;

  function clone(value){return JSON.parse(JSON.stringify(value==null?null:value))}
  function equal(left,right){try{return JSON.stringify(left)===JSON.stringify(right)}catch(_){return false}}
  function readPending(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch(_){return null}}
  function clearPending(){try{localStorage.removeItem(STORAGE_KEY)}catch(_){}}
  function shouldRetry(error){return !error||!error.status||error.status>=500}
  function changedModules(progress){const modules={};Object.keys(progress||{}).forEach(function(key){if(!equal(progress[key],baseline[key]))modules[key]=clone(progress[key])});return modules}
  function queueModules(modules){
    const previous=readPending();
    const merged={...((previous&&previous.modules)||{}),...clone(modules)};
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({modules:merged,queuedAt:Date.now()}))}catch(_){}
  }
  function applyBaseline(modules){baseline={...baseline,...clone(modules)}}

  async function sendModules(modules){
    if(!Object.keys(modules).length)return true;
    try{await EasyBoostApi.post('/api/progress/modules',{modules:modules},true);applyBaseline(modules);clearPending();return true}
    catch(error){if(shouldRetry(error))queueModules(modules);throw error}
  }
  async function flush(){
    if(flushing)return flushing;
    const pending=readPending();
    if(!pending||!pending.modules)return false;
    flushing=sendModules(pending.modules).catch(function(){return false}).finally(function(){flushing=null});
    return flushing;
  }
  function saveProgress(progress){
    const pending=readPending();
    const modules={...((pending&&pending.modules)||{}),...changedModules(progress)};
    if(!Object.keys(modules).length)return Promise.resolve(true);
    if(typeof navigator!=='undefined'&&navigator.onLine===false){queueModules(modules);return Promise.resolve(false)}
    return sendModules(modules).catch(function(){return false});
  }
  function setBaseline(progress){baseline=clone(progress||{});return flush()}

  if(typeof window!=='undefined')window.addEventListener('online',flush);
  function pendingModules(){const pending=readPending();return (pending&&pending.modules)||{}}
  global.EasyBoostSync=Object.freeze({saveProgress:saveProgress,setBaseline:setBaseline,flush:flush,pendingModules:pendingModules,hasPending:function(){return Boolean(readPending())}});
})(window);
