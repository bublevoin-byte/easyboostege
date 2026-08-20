/*
 * Оболочка приложения в кэше.
 *
 * Список файлов генерирует сборка. В `dist/public` имена хешированные, и держать их здесь руками
 * нельзя: `scripts/build-frontend.js` заменяет блок между маркерами содержимым манифеста Vite.
 * Версия ниже — для исходников, которые сервер отдаёт, когда сборки нет; тот же скрипт сверяет её
 * с графом статических импортов `main.js`, поэтому и она не разъезжается молча. Reading content
 * shards остаются динамическими ресурсами: после первой успешной загрузки общий fetch-контур
 * сохраняет их для последующей офлайн-тренировки, но install приложения их не запрашивает.
 *
 * Сюда входят пять экранов — «Сегодня», «Слова», «Грамматика», «Прогресс» и «Профиль», — потому что main.js
 * импортирует их наравне с оболочкой. Пять ленивых чанков, включая exact-пробник, и content shards
 * отсутствуют: страница не должна просить их при первой загрузке. В кэш они попадают ниже, в
 * обработчике fetch, когда ученик впервые открывает экран; preflight пробника происходит только после
 * загрузки его чанка, поэтому уже начатая попытка открывается из того же runtime-cache без сети.
 */
/* build:app-shell */
const APP_SHELL=['/','/aisy-theme.css','/aisy-shell.css','/today.css','/offline.html','/privacy.html','/task-bank.json','/audio/listening/listening-pilot-v1/manifest.json','/main.js','/globals.js','/api.js','/auth.js','/access.js','/owner-incarnation.js','/sync.js','/store.js','/components.js','/automatic-assessment-contract.js','/shared/automatic-assessment-contract.js','/shared/ege-mock-forecast-metadata.js','/router.js','/aisy-shell.js','/learning.js','/vocabulary-domain.js','/vocabulary-session-view.js','/adaptive-activity-contract.js','/adaptive-activity-launch.js','/adaptive-overview-cache.js','/adaptive-session-runtime.js','/learning-activity-contract.js','/learning-activity-recorder.js','/grammar-domain-contract.js','/grammar-tenses-content.js','/grammar-verb-constructions-content.js','/grammar-parts-of-speech-content.js','/grammar-function-words-content.js','/grammar-catalog-content.js','/grammar-catalog.js','/reading-catalog-contract.js','/reading-pilot-v1.js','/speaking-assessment-contract.js','/ege-mock-catalog-contract.js','/ege-mock-written-continuation.js','/modules/words.js','/modules/grammar.js','/modules/reading.js','/modules/listening.js','/modules/writing.js','/modules/speaking.js','/modules/exam.js','/modules/progress.js','/modules/profile.js','/modules/today.js','/modules/core-voice-catalog.js','/app.js','/voice-tutor.js','/realtime-transport.js','/screens.js','/screens/words.js','/screens/grammar.js','/screens/today.js','/screens/progress.js','/screens/profile.js','/privacy.js','/listening-audio-contract.js','/tts.js','/pwa.js','/manifest.json','/pwa-icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
/* end build:app-shell */
/*
 * Имя кэша считается по самому списку, а не пишется руками. Прежний `easyboost-static-vNN` нужно
 * было поднимать при каждом изменении набора файлов, и забытый бамп оставлял ученика на старой
 * оболочке. В сборке имена файлов хешированные, поэтому любое изменение содержимого меняет список —
 * а значит, и имя кэша.
 */
const CACHE_NAME='easyboost-static-'+APP_SHELL.join('|').split('').reduce(function(hash,character){return Math.imul(hash^character.charCodeAt(0),16777619)>>>0},2166136261).toString(36);
/* build:ege-mock-exec */
const EGE_MOCK_EXEC_PATHS=['/screens/ege-mock.js','/shared/ege-mock-forecast-policy.js','/shared/ege-mock-oral-contract.js','/shared/ege-mock-result-contract.js','/shared/ege-writing-text-sanitizer.js','/shared/ege-writing-text.js','/shared/semantic-json.js','/ege-mock-oral-contract.js','/ege-mock-oral-media.js','/ege-mock-oral-runner.js','/ege-mock-result.js','/ege-mock-writing-assessment-ui.js','/ege-mock-written-assets.js','/ege-mock-written-runner.js','/ege-writing-text.js','/speaking-local-recording.js','/speaking-pronunciation-audio.js'];
/* end build:ege-mock-exec */
const EGE_MOCK_EXEC_CACHE='easyboost-ege-mock-exec-v1-'+EGE_MOCK_EXEC_PATHS.join('|').split('').reduce(function(hash,character){return Math.imul(hash^character.charCodeAt(0),16777619)>>>0},2166136261).toString(36);
const EGE_MOCK_OPEN_CACHE='easyboost-ege-mock-open-v1';
const EGE_MOCK_OPEN_MARKER='/__easyboost/ege-mock-open-v1';
const EGE_MOCK_INSTALL_CACHE='easyboost-ege-mock-install-v1-'+CACHE_NAME;
const EGE_MOCK_HAD_ACTIVE_PREDECESSOR=Boolean(self.registration&&self.registration.active);
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
  await locks.request(EGE_MOCK_INSTALL_LOCK,async()=>{const cache=await caches.open(EGE_MOCK_INSTALL_CACHE);if(typeof cache.keys!=='function')throw new Error('EGE_MOCK_INSTALL_CACHE_KEYS_UNAVAILABLE');const records=egeMockInstallRecords(await cache.keys());const latest=latestEgeMockInstallRecord(records);const generation=(latest?latest.generation:0)+1;const mode=EGE_MOCK_HAD_ACTIVE_PREDECESSOR?'update':'clean';await cache.put(EGE_MOCK_INSTALL_MARKER_PREFIX+generation+'-'+mode,new Response(mode))})
}
async function hadActivePredecessorAtInstall(){
  const cache=await caches.open(EGE_MOCK_INSTALL_CACHE);
  if(typeof cache.keys!=='function')return EGE_MOCK_HAD_ACTIVE_PREDECESSOR;
  const latest=latestEgeMockInstallRecord(egeMockInstallRecords(await cache.keys()));
  return latest?latest.mode==='update':EGE_MOCK_HAD_ACTIVE_PREDECESSOR
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
  await cache.addAll(EGE_MOCK_EXEC_PATHS)
}
async function installEgeMockExecutable(){await recordEgeMockInstallMode();await preserveEgeMockExecutableForUpdate(EGE_MOCK_HAD_ACTIVE_PREDECESSOR,{forceRefresh:true})}
self.addEventListener('install',event=>{event.waitUntil(Promise.all([caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)),installEgeMockExecutable(),self.skipWaiting()]))});
self.addEventListener('activate',event=>{event.waitUntil(preserveEgeMockExecutableForUpdate(undefined,{cacheOnly:true}).then(()=>Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME&&key!==EGE_MOCK_EXEC_CACHE&&key!==EGE_MOCK_OPEN_CACHE&&key!==EGE_MOCK_INSTALL_CACHE&&!key.startsWith('easyboost-ege-mock-assets-v1-')&&!key.startsWith('easyboost-ege-mock-form-v1-')).map(key=>caches.delete(key)))),self.clients.claim()])))});
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();if(event.data&&event.data.type==='EGE_MOCK_ASSET_CAPABILITY'){const ready=ensureEgeMockFormCached().then(()=>event.ports&&event.ports[0]&&event.ports[0].postMessage({capability:'easyboost-ege-mock-assets-v1'}));if(event.waitUntil)event.waitUntil(ready)}});

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
async function fetchListeningMp3(request,event){
  const url=new URL(request.url);const requestedCache=url.searchParams.get('egeMockAssetCache');
  if(requestedCache)return matchEgeMockAsset(url,requestedCache,rangeHeader(request));
  const cache=await caches.open(CACHE_NAME);const key=request.url;const requestedRange=rangeHeader(request);
  try{const response=await fetch(key);if(response.ok&&response.status===200)event.waitUntil(cache.put(key,response.clone()));return responseForRange(response,requestedRange)}
  catch(error){const cached=await cache.match(key);if(!cached)throw error;return responseForRange(cached,requestedRange)}
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
  if(await cache.match(EGE_MOCK_FORM_PATH))return;const response=await fetch(EGE_MOCK_FORM_PATH);if(!response.ok)throw new Error('EGE_MOCK_FORM_CACHE_FAILED');await cache.put(EGE_MOCK_FORM_PATH,response.clone())
}
async function fetchEgeMockForm(request){
  const cache=await caches.open(EGE_MOCK_FORM_CACHE);
  try{const response=await fetch(request);if(response.ok){await cache.put(request,response.clone());return response}const cached=await cache.match(request);if(response.status>=500&&cached)return cached;return response}
  catch(error){const cached=await cache.match(request);if(!cached)throw error;return cached}
}
async function fetchEgeMockExecutable(request){
  const cache=await caches.open(EGE_MOCK_EXEC_CACHE);
  try{const response=await fetch(request);if(response.ok){await cache.put(request,response.clone());return response}const cached=await cache.match(request);if(response.status>=500&&cached)return cached;return response}
  catch(error){const cached=await cache.match(request);if(!cached)throw error;return cached}
}

self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;const requestedEgeMockCache=url.searchParams.get('egeMockAssetCache');if(requestedEgeMockCache){event.respondWith(matchEgeMockAsset(url,requestedEgeMockCache,rangeHeader(request)));return}if(url.pathname===EGE_MOCK_FORM_PATH){event.respondWith(fetchEgeMockForm(request));return}if(egeMockExecutablePath(url.pathname)){event.respondWith(markEgeMockExecutableOpened().then(()=>fetchEgeMockExecutable(request)));return}if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put('/',copy)))}return response}).catch(()=>caches.match('/').then(shell=>shell||caches.match('/offline.html'))));return}if(listeningMp3Path(url.pathname)){event.respondWith(fetchListeningMp3(request,event));return}event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(request,copy)))}return response}).catch(()=>caches.match(request)))});
