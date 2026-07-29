const CACHE_NAME='easyboost-static-v21';
/*
 * Точка входа и все модули, которые она тянет статически: офлайн приложение должно стартовать
 * целиком. Сюда входят и три экрана раздела 6.1 — «Слова», «Грамматика», «Прогресс», — потому что
 * main.js импортирует их наравне с оболочкой. Пять ленивых чанков здесь отсутствуют: страница не
 * должна просить их при первой загрузке. В кэш они попадают ниже, в обработчике fetch, когда
 * ученик впервые открывает свой экран, — поэтому офлайн-запуск открывает уже виденные экраны.
 */
const APP_SHELL=['/','/offline.html','/privacy.html','/task-bank.json','/main.js','/globals.js','/api.js','/auth.js','/sync.js','/store.js','/components.js','/router.js','/learning.js','/modules/words.js','/modules/grammar.js','/modules/reading.js','/modules/listening.js','/modules/writing.js','/modules/speaking.js','/modules/exam.js','/modules/progress.js','/modules/profile.js','/app.js','/screens.js','/screens/words.js','/screens/grammar.js','/screens/progress.js','/privacy.js','/tts.js','/pwa.js','/manifest.json','/pwa-icon.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
self.addEventListener('install',event=>{event.waitUntil(Promise.all([caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)),self.skipWaiting()]))});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))),self.clients.claim()]))});
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;if(request.mode==='navigate'){event.respondWith(fetch(request).catch(()=>caches.match('/').then(shell=>shell||caches.match('/offline.html'))));return}event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy))}return response}).catch(()=>caches.match(request)))});
