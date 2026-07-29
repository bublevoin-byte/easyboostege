/*
 * Раньше этот файл читал apiGetBlob, lPlayBtn, SRV, TOKEN и LSLOW прямо из глобальной области,
 * куда их клал app.js. В модуле такой области нет, поэтому зависимости передаются явно.
 * Изменяемые значения (сессия, режим замедления) приходят функциями, а не копиями: обработчик
 * может переключить скорость уже после настройки, и озвучка обязана это увидеть.
 */
var TTS_CACHE={},TTS_CURRENT=null,TTS_SEQUENCE=0;
var TTS_DEPS={
  apiGetBlob:function(){return Promise.reject(new Error('TTS is not configured'))},
  lPlayBtn:function(){},
  lStopFallback:function(){},
  lPlayRawFallback:function(){},
  wSpeakFallback:function(){},
  serverAvailable:function(){return false},
  slow:function(){return false}
};

function configureTts(deps){Object.keys(deps||{}).forEach(function(key){TTS_DEPS[key]=deps[key]})}

function fetchTtsAudio(text,voice,slow){
  var key=voice+'|'+(slow?1:0)+'|'+text;
  if(TTS_CACHE[key])return Promise.resolve(TTS_CACHE[key]);
  return TTS_DEPS.apiGetBlob('/api/v1/tts?text='+encodeURIComponent(text)+'&voice='+voice+(slow?'&slow=1':''))
    .then(function(blob){if(!blob.size)throw new Error('Empty TTS response');var url=URL.createObjectURL(blob);TTS_CACHE[key]=url;return url})}
function stopTtsAudio(){TTS_SEQUENCE++;if(TTS_CURRENT){try{TTS_CURRENT.pause()}catch(e){}TTS_CURRENT=null}}
function lStop(){stopTtsAudio();TTS_DEPS.lStopFallback();try{TTS_DEPS.lPlayBtn('')}catch(e){}}
function lPlayRaw(lines){
  if(!TTS_DEPS.serverAvailable()){TTS_DEPS.lPlayRawFallback(lines);return}
  stopTtsAudio();TTS_DEPS.lStopFallback();var requestSequence=++TTS_SEQUENCE;try{TTS_DEPS.lPlayBtn('load')}catch(e){}
  Promise.all(lines.map(function(line){return fetchTtsAudio(line.t,line.s?'en-GB-SoniaNeural':'en-GB-RyanNeural',TTS_DEPS.slow())}))
    .then(function(urls){if(requestSequence!==TTS_SEQUENCE)return;var index=0;(function playNext(){if(requestSequence!==TTS_SEQUENCE||index>=urls.length){if(requestSequence===TTS_SEQUENCE){TTS_CURRENT=null;try{TTS_DEPS.lPlayBtn('')}catch(e){}}return}if(index===0)try{TTS_DEPS.lPlayBtn('play')}catch(e){}TTS_CURRENT=new Audio(urls[index++]);TTS_CURRENT.onended=playNext;TTS_CURRENT.onerror=playNext;TTS_CURRENT.play().catch(playNext)})()})
    .catch(function(){if(requestSequence===TTS_SEQUENCE){try{TTS_DEPS.lPlayBtn('')}catch(e){}TTS_DEPS.lPlayRawFallback(lines)}})}
function wSpeak(text){
  var cleanText=(text||'').replace(/^to /,'').trim();if(!cleanText)return;
  if(!TTS_DEPS.serverAvailable()){TTS_DEPS.wSpeakFallback(text);return}
  var requestSequence=++TTS_SEQUENCE;
  fetchTtsAudio(cleanText,'en-GB-SoniaNeural',false)
    .then(function(url){if(requestSequence!==TTS_SEQUENCE)return;if(TTS_CURRENT){try{TTS_CURRENT.pause()}catch(e){}}TTS_CURRENT=new Audio(url);TTS_CURRENT.play().catch(function(){})})
    .catch(function(){if(requestSequence===TTS_SEQUENCE)TTS_DEPS.wSpeakFallback(text)})}

export {configureTts,lPlayRaw,lStop,wSpeak};
