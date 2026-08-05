/*
 * Оболочка приложения в кэше.
 *
 * Список файлов генерирует сборка. В `dist/public` имена хешированные, и держать их здесь руками
 * нельзя: `scripts/build-frontend.js` заменяет блок между маркерами содержимым манифеста Vite.
 * Версия ниже — для исходников, которые сервер отдаёт, когда сборки нет; тот же скрипт сверяет её
 * с графом статических импортов `main.js`, поэтому и она не разъезжается молча.
 *
 * Сюда входят четыре экрана — «Слова», «Грамматика», «Прогресс» и «Профиль», — потому что main.js
 * импортирует их наравне с оболочкой; профиль нужен для первого офлайн-открытия настроек. Четыре
 * ленивых чанка здесь отсутствуют: страница не должна
 * просить их при первой загрузке. В кэш они попадают ниже, в обработчике fetch, когда ученик
 * впервые открывает свой экран, — поэтому офлайн-запуск открывает уже виденные экраны.
 */
/* build:app-shell */
const APP_SHELL=['/','/offline.html','/privacy.html','/task-bank.json','/audio/listening/listening-pilot-v1/manifest.json','/main.js','/globals.js','/api.js','/auth.js','/sync.js','/store.js','/components.js','/router.js','/learning.js','/vocabulary-domain.js','/vocabulary-session-view.js','/adaptive-activity-contract.js','/adaptive-activity-launch.js','/adaptive-overview-cache.js','/adaptive-session-runtime.js','/learning-activity-contract.js','/learning-activity-recorder.js','/modules/words.js','/modules/grammar.js','/modules/reading.js','/modules/listening.js','/modules/writing.js','/modules/speaking.js','/modules/exam.js','/modules/progress.js','/modules/profile.js','/modules/core-voice-catalog.js','/app.js','/voice-tutor.js','/realtime-transport.js','/screens.js','/screens/words.js','/screens/grammar.js','/screens/progress.js','/screens/profile.js','/privacy.js','/listening-audio-contract.js','/tts.js','/pwa.js','/manifest.json','/pwa-icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
/* end build:app-shell */
/*
 * Имя кэша считается по самому списку, а не пишется руками. Прежний `easyboost-static-vNN` нужно
 * было поднимать при каждом изменении набора файлов, и забытый бамп оставлял ученика на старой
 * оболочке. В сборке имена файлов хешированные, поэтому любое изменение содержимого меняет список —
 * а значит, и имя кэша.
 */
const CACHE_NAME='easyboost-static-'+APP_SHELL.join('|').split('').reduce(function(hash,character){return Math.imul(hash^character.charCodeAt(0),16777619)>>>0},2166136261).toString(36);
self.addEventListener('install',event=>{event.waitUntil(Promise.all([caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)),self.skipWaiting()]))});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))),self.clients.claim()]))});
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting()});

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
  const cache=await caches.open(CACHE_NAME);const key=request.url;const requestedRange=rangeHeader(request);
  try{const response=await fetch(key);if(response.ok&&response.status===200)event.waitUntil(cache.put(key,response.clone()));return responseForRange(response,requestedRange)}
  catch(error){const cached=await cache.match(key);if(!cached)throw error;return responseForRange(cached,requestedRange)}
}

self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put('/',copy)))}return response}).catch(()=>caches.match('/').then(shell=>shell||caches.match('/offline.html'))));return}if(listeningMp3Path(url.pathname)){event.respondWith(fetchListeningMp3(request,event));return}event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy))}return response}).catch(()=>caches.match(request)))});
