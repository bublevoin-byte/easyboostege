/*
 * Оболочка приложения в кэше.
 *
 * Список файлов генерирует сборка. В `dist/public` имена хешированные, и держать их здесь руками
 * нельзя: `scripts/build-frontend.js` заменяет блок между маркерами содержимым манифеста Vite.
 * Версия ниже — для исходников, которые сервер отдаёт, когда сборки нет; тот же скрипт сверяет её
 * со всей initial closure: module-графом `main.js`, прямыми classic scripts из `index.html`
 * (`theme-prepaint.js`) и обязательными static assets. Reading content shards остаются
 * динамическими ресурсами: после первой успешной загрузки общий fetch-контур
 * сохраняет их для последующей офлайн-тренировки, но install приложения их не запрашивает.
 *
 * Initial graph содержит Сегодня и Слова. Static closures Грамматики, top-level Practice, ЕГЭ,
 * Прогресса, Профиля, Аси и privacy предзагружаются отдельно: они не исполняются при первой
 * загрузке, но доступны после установки PWA. На чистой установке остальные глубокие предметные
 * чанки, Voice Tutor, exact-пробник и content shards отсутствуют и попадают в runtime-cache после
 * явного использования. Production package дополнительно хранит digest-verified executable graph
 * точного predecessor: он не входит в APP_SHELL и initial execution, но старый открытый document
 * может догрузить свой content-hashed chunk до явного per-tab consent. При обновлении существующей
 * версии exact-пробник — отдельное исключение:
 * его executable closure предзагружается даже без open-marker для совместимости восстановления,
 * но в clean-install APP_SHELL она не входит.
 */
/* build:app-shell */
const APP_SHELL=['/','/aisy-theme.css','/aisy-shell.css','/first-launch.css','/asya-assistant.css','/today.css','/practice.css','/words.css','/grammar.css','/ege-hub.css','/ege-mock.css','/reading-listening.css','/writing.css','/speaking.css','/progress-profile.css','/offline.html','/privacy.html','/task-bank.json','/audio/listening/listening-pilot-v1/manifest.json','/assets/opening/answer.webp','/assets/opening/login.webp','/assets/opening/logo.webp','/assets/opening/map.webp','/assets/opening/practice.webp','/assets/fonts/MANROPE-OFL.txt','/assets/fonts/NUNITO-OFL.txt','/assets/fonts/manrope-cyrillic-variable.woff2','/assets/fonts/manrope-latin-variable.woff2','/assets/fonts/nunito-cyrillic-variable.woff2','/assets/fonts/nunito-latin-variable.woff2','/main.js','/theme-prepaint.js','/theme.js','/globals.js','/api.js','/auth.js','/access.js','/commercial-copy.js','/owner-incarnation.js','/sync.js','/store.js','/components.js','/automatic-assessment-contract.js','/shared/automatic-assessment-contract.js','/shared/ege-mock-forecast-metadata.js','/router.js','/aisy-shell.js','/asya-launcher.js','/asya-assistant.js','/learning.js','/vocabulary-domain.js','/vocabulary-session-view.js','/adaptive-activity-contract.js','/adaptive-activity-launch.js','/adaptive-overview-cache.js','/adaptive-session-loader.js','/adaptive-session-runtime.js','/learning-activity-contract.js','/learning-activity-recorder.js','/grammar-domain-contract.js','/grammar-tenses-content.js','/grammar-verb-constructions-content.js','/grammar-parts-of-speech-content.js','/grammar-function-words-content.js','/grammar-catalog-content.js','/grammar-catalog.js','/reading-catalog-contract.js','/reading-pilot-v1.js','/ege-mock-catalog-contract.js','/ege-mock-written-continuation.js','/modules/words.js','/modules/grammar.js','/modules/exam.js','/modules/reading.js','/modules/progress.js','/modules/profile.js','/modules/today.js','/modules/core-voice-catalog.js','/modules/practice.js','/modules/ege-hub.js','/first-launch.js','/app.js','/voice-tutor-contract.js','/voice-tutor-loader.js','/screens.js','/screens/words.js','/screens/grammar.js','/screens/today.js','/screens/progress.js','/screens/profile.js','/screens/practice.js','/screens/ege-hub.js','/privacy-loader.js','/privacy.js','/listening-audio-contract.js','/tts.js','/pwa.js','/manifest.json','/pwa-icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
/* end build:app-shell */
/*
 * Production-сборка подставляет SHA-256 worker policy и байтов каждого APP_SHELL response.
 * Поэтому меняется и хешированный chunk, и стабильный путь вроде manifest/icon/offline.html.
 * Source-mode версия нужна только для локального запуска без dist.
 */
/* build:release-version */
const RELEASE_VERSION='source-v1';
/* end build:release-version */
const CACHE_NAME='easyboost-static-'+RELEASE_VERSION;
/* build:predecessor-compat */
const PREDECESSOR_COMPATIBILITY={baseCommit:null,cacheName:null,contentSha256:null,files:[]};
/* end build:predecessor-compat */
/* build:ege-mock-exec */
const EGE_MOCK_EXEC_PATHS=['/screens/ege-mock.js','/shared/ege-mock-forecast-policy.js','/shared/ege-mock-oral-contract.js','/shared/ege-mock-result-contract.js','/shared/ege-writing-text-sanitizer.js','/shared/ege-writing-text.js','/shared/semantic-json.js','/ege-mock-oral-contract.js','/ege-mock-oral-media.js','/ege-mock-oral-runner.js','/ege-mock-result.js','/ege-mock-writing-assessment-ui.js','/ege-mock-written-assets.js','/ege-mock-written-runner.js','/ege-writing-text.js','/modules/listening.js','/modules/reading.js','/reading-catalog-contract.js','/reading-pilot-v1.js','/speaking-local-recording.js','/speaking-pronunciation-audio.js'];
/* end build:ege-mock-exec */
const EGE_MOCK_EXEC_CACHE='easyboost-ege-mock-exec-v1-'+CACHE_NAME+'-'+EGE_MOCK_EXEC_PATHS.join('|').split('').reduce(function(hash,character){return Math.imul(hash^character.charCodeAt(0),16777619)>>>0},2166136261).toString(36);
const EGE_MOCK_OPEN_CACHE='easyboost-ege-mock-open-v1';
const EGE_MOCK_OPEN_MARKER='/__easyboost/ege-mock-open-v1';
const EGE_MOCK_INSTALL_CACHE='easyboost-ege-mock-install-v1-'+CACHE_NAME;
const HAD_ACTIVE_PREDECESSOR=Boolean(self.registration&&self.registration.active);
const PWA_CLIENT_STATE_CACHE='easyboost-pwa-client-state-v1-'+CACHE_NAME;
const PWA_CONSENT_PREFIX='/__easyboost/pwa-consent-v1/';
const PWA_READY_PREFIX='/__easyboost/pwa-current-ready-v1/';
const PWA_PARTICIPANT_PREFIX='/__easyboost/pwa-learner-shell-v1/';
const PWA_ACTIVATED_MARKER='/__easyboost/pwa-activated-v1';
const PWA_RETIREMENT_PLAN='/__easyboost/pwa-retirement-plan-v1';
const PWA_RETIREMENT_SCHEMA='aisy-pwa-retirement-plan-v2';
const PWA_RETIREMENT_MAX_BYTES=1024;
const PWA_RETIREMENT_MAX_CACHES=4;
let ACTIVATION_COMPLETE=false;
let OBSOLETE_RELEASES_PRUNED=false;
let UPDATE_QUORUM_RECHECK=null;
let UPDATE_QUORUM_RECHECK_QUEUED=null;
let SKIP_WAITING_REQUESTED=false;
const UPDATE_QUORUM_RECHECK_INTERVAL_MS=250;
const UPDATE_QUORUM_RECHECK_ATTEMPTS=240;
const EGE_MOCK_INSTALL_MARKER_PREFIX='/__easyboost/ege-mock-install-mode-v3/';
const EGE_MOCK_INSTALL_LOCK='easyboost-ege-mock-install-mode-v3-'+CACHE_NAME;
function egeMockExecutablePath(pathname){return EGE_MOCK_EXEC_PATHS.includes(pathname)}
function priorEgeMockExecutablePath(pathname){return pathname==='/screens/ege-mock.js'||/^\/assets\/ege-mock-[^/]+\.js$/u.test(pathname)}
async function markEgeMockExecutableOpened(){await (await caches.open(EGE_MOCK_OPEN_CACHE)).put(EGE_MOCK_OPEN_MARKER,new Response('opened'))}
async function hasEgeMockOpenMarker(){return Boolean(await (await caches.open(EGE_MOCK_OPEN_CACHE)).match(EGE_MOCK_OPEN_MARKER))}
function egeMockInstallRecords(requests){return requests.map(request=>{const pathname=new URL(request.url,self.location.origin).pathname;if(!pathname.startsWith(EGE_MOCK_INSTALL_MARKER_PREFIX))return null;const match=/^(\d+)-(update|clean)$/u.exec(pathname.slice(EGE_MOCK_INSTALL_MARKER_PREFIX.length));const generation=match?Number(match[1]):0;return Number.isSafeInteger(generation)&&generation>0?{generation,mode:match[2]}:null}).filter(Boolean)}
function latestEgeMockInstallRecord(records){
  if(!records.length)return null;
  const generation=Math.max(...records.map(record=>record.generation));
  const latest=records.filter(record=>record.generation===generation);
  if(latest.length!==1)throw new Error('EGE_MOCK_INSTALL_GENERATION_AMBIGUOUS');
  return latest[0]
}
async function recordEgeMockInstallMode(){
  const locks=self.navigator&&self.navigator.locks;
  if(!locks||typeof locks.request!=='function')throw new Error('EGE_MOCK_INSTALL_LOCK_UNAVAILABLE');
  await locks.request(EGE_MOCK_INSTALL_LOCK,async()=>{const cache=await caches.open(EGE_MOCK_INSTALL_CACHE);if(typeof cache.keys!=='function')throw new Error('EGE_MOCK_INSTALL_CACHE_KEYS_UNAVAILABLE');const records=egeMockInstallRecords(await cache.keys());const latest=latestEgeMockInstallRecord(records);const generation=(latest?latest.generation:0)+1;const mode=HAD_ACTIVE_PREDECESSOR?'update':'clean';await cache.put(EGE_MOCK_INSTALL_MARKER_PREFIX+generation+'-'+mode,new Response(mode))})
}
async function hadActivePredecessorAtInstall(){
  const cache=await caches.open(EGE_MOCK_INSTALL_CACHE);
  if(typeof cache.keys!=='function')return HAD_ACTIVE_PREDECESSOR;
  const latest=latestEgeMockInstallRecord(egeMockInstallRecords(await cache.keys()));
  return latest?latest.mode==='update':HAD_ACTIVE_PREDECESSOR
}
async function hadOpenedEgeMockExecutable(){
  const names=await caches.keys();
  for(const name of names){
    if(name.startsWith('easyboost-ege-mock-exec-v1-')&&name!==EGE_MOCK_EXEC_CACHE)return true;
    if(!name.startsWith('easyboost-static-'))continue;
    const cache=await caches.open(name);if(typeof cache.keys!=='function')continue;
    const requests=await cache.keys();if(requests.some(request=>priorEgeMockExecutablePath(new URL(request.url).pathname)))return true
  }
  return false
}
async function preserveEgeMockExecutableForUpdate(hadActivePredecessor,options={}){
  const hadPredecessor=hadActivePredecessor===undefined?await hadActivePredecessorAtInstall():hadActivePredecessor;
  if(!hadPredecessor&&!await hasEgeMockOpenMarker()&&!await hadOpenedEgeMockExecutable())return;
  const cache=await caches.open(EGE_MOCK_EXEC_CACHE);
  const requests=typeof cache.keys==='function'?await cache.keys():[];
  const cachedPaths=new Set(requests.map(request=>new URL(request.url,self.location.origin).pathname));
  const complete=EGE_MOCK_EXEC_PATHS.every(path=>cachedPaths.has(path));
  if(complete&&!options.forceRefresh)return;
  if(options.cacheOnly)throw new Error('EGE_MOCK_EXECUTABLE_CACHE_INCOMPLETE');
  await cache.addAll(EGE_MOCK_EXEC_PATHS.map(path=>new Request(path,{cache:'reload'})))
}
async function installEgeMockExecutable(){await recordEgeMockInstallMode();await preserveEgeMockExecutableForUpdate(HAD_ACTIVE_PREDECESSOR,{forceRefresh:true})}
function responseHasNoStore(response){return /(?:^|,)\s*no-store(?:\s*(?:,|$))/iu.test(response.headers&&response.headers.get?response.headers.get('cache-control')||'':'')}
async function putRuntimeResponse(cache,request,response){if(!response.ok||responseHasNoStore(response))return false;await cache.put(request,response.clone());return true}
function digestHex(bytes){return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('')}
async function verifiedCompatibilityResponse(file){
  const response=await fetch(file.path,{cache:'no-store'});
  if(!response.ok||responseHasNoStore(response))throw new Error('PWA_PREDECESSOR_COMPAT_FETCH_FAILED');
  const bytes=await response.clone().arrayBuffer();
  if(bytes.byteLength!==file.bytes||digestHex(await crypto.subtle.digest('SHA-256',bytes))!==file.sha256){
    throw new Error('PWA_PREDECESSOR_COMPAT_DIGEST_MISMATCH')}
  return response
}
async function installPredecessorCompatibility(){
  if(!HAD_ACTIVE_PREDECESSOR||!PREDECESSOR_COMPATIBILITY.cacheName||!PREDECESSOR_COMPATIBILITY.files.length)return;
  const cache=await caches.open(PREDECESSOR_COMPATIBILITY.cacheName);
  await Promise.all(PREDECESSOR_COMPATIBILITY.files.map(async file=>cache.put(file.path,await verifiedCompatibilityResponse(file))))
}
async function installRelease(){
  await Promise.all([
    caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL.map(path=>new Request(path,{cache:'reload'})))),
    installEgeMockExecutable(),
    installPredecessorCompatibility(),
  ]);
  /* A clean install may activate immediately. An update remains waiting until the learner explicitly
     confirms from the in-app update notice, so a deep or in-progress task is never interrupted. */
  if(!HAD_ACTIVE_PREDECESSOR)await self.skipWaiting()
}
self.addEventListener('install',event=>{event.waitUntil(installRelease())});
function clientMarker(prefix,id){return prefix+encodeURIComponent(id)}
async function currentWindowSource(event){
  const source=event.source;
  if(!source||source.type!=='window'||!source.id||new URL(source.url).origin!==self.location.origin)return null;
  return source
}
async function markClient(prefix,client){await (await caches.open(PWA_CLIENT_STATE_CACHE)).put(clientMarker(prefix,client.id),new Response(RELEASE_VERSION))}
async function markReleaseActivated(){await (await caches.open(PWA_CLIENT_STATE_CACHE)).put(PWA_ACTIVATED_MARKER,new Response(RELEASE_VERSION))}
async function releaseIsActivated(){return ACTIVATION_COMPLETE||Boolean(await (await caches.open(PWA_CLIENT_STATE_CACHE)).match(PWA_ACTIVATED_MARKER))}
async function markedClientIds(prefix){
  const cache=await caches.open(PWA_CLIENT_STATE_CACHE);
  if(typeof cache.keys!=='function')return new Set();
  const ids=(await cache.keys()).map(request=>new URL(request.url,self.location.origin).pathname)
    .filter(pathname=>pathname.startsWith(prefix)).map(pathname=>decodeURIComponent(pathname.slice(prefix.length)));
  return new Set(ids)
}
function predecessorRetirementAuthority(){
  const value=PREDECESSOR_COMPATIBILITY;
  if(!value||value.schemaVersion!=='aisy-pwa-predecessor-compat-v1'
    ||!/^[a-f0-9]{40}$/u.test(value.baseCommit||'')
    ||!/^[a-f0-9]{64}$/u.test(value.contentSha256||'')
    ||!/^easyboost-static-[a-z0-9-]{1,96}$/u.test(value.cacheName||''))return null;
  return {schemaVersion:value.schemaVersion,baseCommit:value.baseCommit,
    contentSha256:value.contentSha256,caches:[value.cacheName]}
}
function expectedReleaseRetirementPlan(){
  const predecessor=predecessorRetirementAuthority();
  return predecessor?{schemaVersion:PWA_RETIREMENT_SCHEMA,releaseVersion:RELEASE_VERSION,predecessor}:null
}
function validateReleaseRetirementPlan(value){
  const expected=expectedReleaseRetirementPlan();
  const caches=value&&value.predecessor&&value.predecessor.caches;
  if(!expected||!value||value.schemaVersion!==PWA_RETIREMENT_SCHEMA
    ||value.releaseVersion!==RELEASE_VERSION||!Array.isArray(caches)
    ||caches.length<1||caches.length>PWA_RETIREMENT_MAX_CACHES
    ||caches.length!==new Set(caches).size||caches.some((name,index)=>
      typeof name!=='string'||name.length>128||(index>0&&caches[index-1]>=name))
    ||JSON.stringify(value)!==JSON.stringify(expected))throw new Error('PWA_RETIREMENT_PLAN_INVALID');
  return Object.freeze([...caches])
}
async function parseReleaseRetirementPlan(response){
  if(!response)return null;
  try{
    const bytes=await response.clone().arrayBuffer();
    if(bytes.byteLength<1||bytes.byteLength>PWA_RETIREMENT_MAX_BYTES)return null;
    return validateReleaseRetirementPlan(JSON.parse(await response.text()))
  }catch(error){return null}
}
async function readReleaseRetirementPlan(){
  const response=await (await caches.open(PWA_CLIENT_STATE_CACHE)).match(PWA_RETIREMENT_PLAN);
  return parseReleaseRetirementPlan(response)
}
async function persistReleaseRetirementPlan(){
  const cache=await caches.open(PWA_CLIENT_STATE_CACHE);
  const existing=await cache.match(PWA_RETIREMENT_PLAN);
  if(existing)return parseReleaseRetirementPlan(existing);
  const planned=expectedReleaseRetirementPlan();
  if(!planned)return null;
  await cache.put(PWA_RETIREMENT_PLAN,new Response(JSON.stringify(planned),{headers:{'content-type':'application/json'}}));
  return readReleaseRetirementPlan()
}
async function pruneObsoleteAisyReleasesIfSafe(){
  if(OBSOLETE_RELEASES_PRUNED)return true;
  const windows=await participatingWindowClients();
  const ready=await markedClientIds(PWA_READY_PREFIX);
  if(windows.some(client=>!ready.has(client.id)))return false;
  const planned=await readReleaseRetirementPlan();
  if(!planned)return false;
  await Promise.all(planned.map(key=>caches.delete(key)));
  OBSOLETE_RELEASES_PRUNED=true;
  return true
}
function legacyLearnerShellClient(client){
  const url=new URL(client.url,self.location.origin);
  return url.origin===self.location.origin&&(url.pathname==='/'||url.pathname==='/index.html')
}
async function participatingWindowClients(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const registered=await markedClientIds(PWA_PARTICIPANT_PREFIX);
  return windows.filter(client=>legacyLearnerShellClient(client)||registered.has(client.id))
}
async function updateConsentQuorumReached(){
  const windows=await participatingWindowClients();
  const consenting=await markedClientIds(PWA_CONSENT_PREFIX);
  return windows.every(client=>consenting.has(client.id))
}
async function requestActivationWhenQuorum(){
  if(SKIP_WAITING_REQUESTED||await releaseIsActivated())return true;
  if(!await updateConsentQuorumReached())return false;
  SKIP_WAITING_REQUESTED=true;
  await self.skipWaiting();
  return true
}
function updateQuorumDelay(){return new Promise(resolve=>setTimeout(resolve,UPDATE_QUORUM_RECHECK_INTERVAL_MS))}
function queuedUpdateConsentQuorumRecheck(){
  if(!UPDATE_QUORUM_RECHECK_QUEUED){
    let resolve;let reject;
    const promise=new Promise((resolvePromise,rejectPromise)=>{resolve=resolvePromise;reject=rejectPromise});
    UPDATE_QUORUM_RECHECK_QUEUED={promise,resolve,reject}
  }
  return UPDATE_QUORUM_RECHECK_QUEUED.promise
}
function recheckUpdateConsentQuorum(options={}){
  if(UPDATE_QUORUM_RECHECK)return options.extend?queuedUpdateConsentQuorumRecheck():UPDATE_QUORUM_RECHECK;
  const operation=(async()=>{
    for(let attempt=0;attempt<UPDATE_QUORUM_RECHECK_ATTEMPTS;attempt+=1){
      await updateQuorumDelay();
      if(await requestActivationWhenQuorum())return true
    }
    return false
  })();
  const tracked=operation.finally(async()=>{
    if(UPDATE_QUORUM_RECHECK!==tracked)return;
    UPDATE_QUORUM_RECHECK=null;
    const queued=UPDATE_QUORUM_RECHECK_QUEUED;
    UPDATE_QUORUM_RECHECK_QUEUED=null;
    if(!queued)return;
    try{
      if(await releaseIsActivated())queued.resolve(true);
      else queued.resolve(recheckUpdateConsentQuorum())
    }catch(error){queued.reject(error)}
  });
  UPDATE_QUORUM_RECHECK=tracked;
  return UPDATE_QUORUM_RECHECK
}
async function activateRelease(){
  await preserveEgeMockExecutableForUpdate(undefined,{cacheOnly:true});
  await persistReleaseRetirementPlan();
  if(!await hadActivePredecessorAtInstall())await self.clients.claim();
  await markReleaseActivated();
  ACTIVATION_COMPLETE=true
}
self.addEventListener('activate',event=>{event.waitUntil(activateRelease())});
async function consentToUpdate(event){
  const client=await currentWindowSource(event);
  if(!client)return;
  await markClient(PWA_PARTICIPANT_PREFIX,client);
  await markClient(PWA_CONSENT_PREFIX,client);
  if(await releaseIsActivated()){await client.navigate(client.url);return}
  if(!await requestActivationWhenQuorum()){
    client.postMessage({type:'WAITING_FOR_OTHER_TABS'});
    await recheckUpdateConsentQuorum();
  }
}
async function recordCurrentClient(event){
  const client=await currentWindowSource(event);
  if(!client)return;
  await markClient(PWA_PARTICIPANT_PREFIX,client);
  await markClient(PWA_READY_PREFIX,client);
  await pruneObsoleteAisyReleasesIfSafe()
}
async function registerLearnerShellClient(event){
  const client=await currentWindowSource(event);
  if(client)await markClient(PWA_PARTICIPANT_PREFIX,client)
}
async function renewUpdateConsentQuorum(){
  if(await requestActivationWhenQuorum())return true;
  return recheckUpdateConsentQuorum({extend:true})
}
self.addEventListener('message',event=>{
  if(event.data&&event.data.type==='REGISTER_LEARNER_SHELL_CLIENT'){const register=registerLearnerShellClient(event);if(event.waitUntil)event.waitUntil(register)}
  if(event.data&&event.data.type==='SKIP_WAITING'){const applying=consentToUpdate(event);if(event.waitUntil)event.waitUntil(applying)}
  if(event.data&&event.data.type==='RECHECK_UPDATE_CONSENT'){const recheck=renewUpdateConsentQuorum();if(event.waitUntil)event.waitUntil(recheck)}
  if(event.data&&event.data.type==='CURRENT_CLIENT_READY'){const ready=recordCurrentClient(event);if(event.waitUntil)event.waitUntil(ready)}
  if(event.data&&event.data.type==='GET_RELEASE_VERSION'&&event.ports&&event.ports[0])event.ports[0].postMessage({releaseVersion:RELEASE_VERSION,cacheName:CACHE_NAME});
  if(event.data&&event.data.type==='EGE_MOCK_ASSET_CAPABILITY'){const ready=ensureEgeMockFormCached().then(()=>event.ports&&event.ports[0]&&event.ports[0].postMessage({capability:'easyboost-ege-mock-assets-v1'}));if(event.waitUntil)event.waitUntil(ready)}
});

function listeningMp3Path(pathname){return pathname.startsWith('/audio/listening/')&&pathname.endsWith('.mp3')}
function rangeHeader(request){return request.headers&&typeof request.headers.get==='function'?request.headers.get('range'):null}
async function responseForRange(response,requestedRange){
  if(!requestedRange||response.status!==200)return response;
  const match=/^bytes=(\d*)-(\d*)$/iu.exec(requestedRange.trim());
  if(!match)return response;
  const body=await response.arrayBuffer();const size=body.byteLength;let start;let end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});start=Math.max(0,size-suffix);end=size-1}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){
    return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}})}
  const headers=new Headers(response.headers);headers.set('Accept-Ranges','bytes');headers.set('Content-Length',String(end-start+1));headers.set('Content-Range','bytes '+start+'-'+end+'/'+size);
  return new Response(body.slice(start,end+1),{status:206,statusText:'Partial Content',headers})
}
function fetchListeningMp3(request,event){
  const url=new URL(request.url);const requestedCache=url.searchParams.get('egeMockAssetCache');
  if(requestedCache)return matchEgeMockAsset(url,requestedCache,rangeHeader(request));
  const key=request.url;const requestedRange=rangeHeader(request);const cachePromise=caches.open(CACHE_NAME);
  const prepared=fetch(key).then(response=>({response,cacheResponse:response.clone()}));
  const cacheWork=Promise.all([cachePromise,prepared]).then(([cache,{response,cacheResponse}])=>response.status===200?putRuntimeResponse(cache,key,cacheResponse):false);
  event.waitUntil(cacheWork.catch(()=>false));
  return prepared.then(({response})=>responseForRange(response,requestedRange)).catch(async error=>{const cached=await (await cachePromise).match(key);if(!cached)throw error;return responseForRange(cached,requestedRange)})
}
async function matchEgeMockAsset(url,requestedCache,requestedRange){
  const requestedDigest=url.searchParams.get('egeMockAssetDigest');
  if(!requestedCache.startsWith('easyboost-ege-mock-assets-v1-')||!/^[a-f0-9]{64}$/u.test(requestedDigest||''))return new Response(null,{status:400});
  const cached=await (await caches.open(requestedCache)).match(url.toString());
  if(!cached)return new Response(null,{status:503});
  return responseForRange(cached,requestedRange)
}

const EGE_MOCK_FORM_CACHE='easyboost-ege-mock-form-v1-0a24dad6e3e3e37d2a30b0062351e216f0106ca1b55a859440f06f895642f001';
/* build:ege-mock-form */
const EGE_MOCK_FORM_PATH='/ege-mock-form-1-v1.js';
/* end build:ege-mock-form */
async function ensureEgeMockFormCached(){
  const cache=await caches.open(EGE_MOCK_FORM_CACHE);
  if(await cache.match(EGE_MOCK_FORM_PATH))return;const response=await fetch(new Request(EGE_MOCK_FORM_PATH,{cache:'reload'}));if(!await putRuntimeResponse(cache,EGE_MOCK_FORM_PATH,response))throw new Error('EGE_MOCK_FORM_CACHE_FAILED')
}
async function fetchEgeMockForm(request){
  const cache=await caches.open(EGE_MOCK_FORM_CACHE);
  try{const response=await fetch(new Request(request,{cache:'reload'}));if(await putRuntimeResponse(cache,request,response))return response;const cached=await cache.match(request);if(response.status>=500&&cached)return cached;return response}
  catch(error){const cached=await cache.match(request);if(!cached)throw error;return cached}
}
async function fetchEgeMockExecutable(request){
  const cache=await caches.open(EGE_MOCK_EXEC_CACHE);
  const cached=async()=>{
    const executable=await cache.match(request);
    if(executable)return executable;
    const pathname=new URL(request.url,self.location.origin).pathname;
    if(!APP_SHELL.includes(pathname))return null;
    return (await caches.open(CACHE_NAME)).match(request,{ignoreVary:true})
  };
  try{const response=await fetch(new Request(request,{cache:'reload'}));if(await putRuntimeResponse(cache,request,response))return response;const fallback=await cached();if(response.status>=500&&fallback)return fallback;return response}
  catch(error){const fallback=await cached();if(!fallback)throw error;return fallback}
}

async function refreshVerifiedRootShell(requestUrl,response){
  if(requestUrl.pathname!=='/'||!response.ok)return;
  const responseUrl=new URL(response.url||requestUrl.href,self.location.origin);
  const contentType=response.headers&&response.headers.get?response.headers.get('content-type')||'':'';
  if(responseUrl.origin!==self.location.origin||responseUrl.pathname!=='/'||!contentType.includes('text/html'))return;
  const cacheResponse=response.clone();
  const html=await response.clone().text();
  if(!html.includes('data-aisy-app-shell="v1"'))return;
  await (await caches.open(CACHE_NAME)).put('/',cacheResponse)
}
async function offlineNavigation(request){
  const cache=await caches.open(CACHE_NAME);
  const exact=await cache.match(request,{ignoreSearch:true});
  if(exact)return exact;
  return await cache.match('/')||cache.match('/offline.html')
}

function privateControlPath(pathname){return /^\/(?:api|internal|health)(?:\/|$)/iu.test(pathname)}
function privateControlRequest(url){return privateControlPath(url.pathname)
  ||(url.pathname==='/'&&url.searchParams.has('login_code'))}
function freshShellRequest(request,pathname){return APP_SHELL.includes(pathname)?new Request(request,{cache:'reload'}):request}
function navigationNetworkResponse(event,request,url){
  const network=fetch(freshShellRequest(request,url.pathname));
  event.waitUntil(network.then(response=>refreshVerifiedRootShell(url,response)).catch(()=>false));
  return network
}
function runtimeNetworkResponse(event,request,pathname){
  const prepared=fetch(freshShellRequest(request,pathname))
    .then(response=>({response,cacheResponse:response.clone()}));
  const cacheWork=prepared.then(({cacheResponse})=>caches.open(CACHE_NAME)
    .then(cache=>putRuntimeResponse(cache,request,cacheResponse)));
  event.waitUntil(cacheWork.catch(()=>false));
  return prepared.then(({response})=>response)
}
async function currentRuntimeFallback(request){return (await caches.open(CACHE_NAME)).match(request)}
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;if(HAD_ACTIVE_PREDECESSOR&&!OBSOLETE_RELEASES_PRUNED)event.waitUntil(pruneObsoleteAisyReleasesIfSafe());if(privateControlRequest(url))return;const requestedEgeMockCache=url.searchParams.get('egeMockAssetCache');if(requestedEgeMockCache){event.respondWith(matchEgeMockAsset(url,requestedEgeMockCache,rangeHeader(request)));return}if(url.pathname===EGE_MOCK_FORM_PATH){event.respondWith(fetchEgeMockForm(request));return}if(egeMockExecutablePath(url.pathname)){event.respondWith(markEgeMockExecutableOpened().then(()=>fetchEgeMockExecutable(request)));return}if(request.mode==='navigate'){event.respondWith(navigationNetworkResponse(event,request,url).catch(()=>offlineNavigation(request)));return}if(listeningMp3Path(url.pathname)){event.respondWith(fetchListeningMp3(request,event));return}event.respondWith(runtimeNetworkResponse(event,request,url.pathname).catch(()=>currentRuntimeFallback(request)))});
