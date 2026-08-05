import {assertListeningAudioManifest} from './listening-audio-contract.js';

/*
 * Раньше этот файл читал apiGetBlob, lPlayBtn, SRV, TOKEN и LSLOW прямо из глобальной области,
 * куда их клал app.js. В модуле такой области нет, поэтому зависимости передаются явно.
 * Изменяемые значения (сессия, режим замедления) приходят функциями, а не копиями: обработчик
 * может переключить скорость уже после настройки, и озвучка обязана это увидеть.
 */
var TTS_CACHE={},TTS_CURRENT=null,TTS_SEQUENCE=0,TTS_LISTENING_MANIFEST=null,TTS_LISTENING_MANIFEST_PROMISE=null;
var TTS_DEPS={
  apiGetBlob:function(){return Promise.reject(new Error('TTS is not configured'))},
  lPlayBtn:function(){},
  lStopFallback:function(){},
  lPlayRawFallback:function(){},
  wSpeakFallback:function(){},
  serverAvailable:function(){return false},
  slow:function(){return false},
  createAudio:function(url){return new Audio(url)},
  loadListeningManifest:function(){return Promise.reject(new Error('Listening audio manifest is not configured'))},
  listeningAudioStatus:function(){}
};

function configureTts(deps){if(deps&&Object.prototype.hasOwnProperty.call(deps,'loadListeningManifest')){
    TTS_LISTENING_MANIFEST=null;TTS_LISTENING_MANIFEST_PROMISE=null}
  Object.keys(deps||{}).forEach(function(key){TTS_DEPS[key]=deps[key]})}

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
    .then(function(urls){if(requestSequence!==TTS_SEQUENCE)return;var index=0;(function playNext(){if(requestSequence!==TTS_SEQUENCE||index>=urls.length){if(requestSequence===TTS_SEQUENCE){TTS_CURRENT=null;try{TTS_DEPS.lPlayBtn('')}catch(e){}}return}if(index===0)try{TTS_DEPS.lPlayBtn('play')}catch(e){}TTS_CURRENT=TTS_DEPS.createAudio(urls[index++]);TTS_CURRENT.onended=playNext;TTS_CURRENT.onerror=playNext;TTS_CURRENT.play().catch(playNext)})()})
    .catch(function(){if(requestSequence===TTS_SEQUENCE){try{TTS_DEPS.lPlayBtn('')}catch(e){}TTS_DEPS.lPlayRawFallback(lines)}})}

function loadListeningManifest(){if(TTS_LISTENING_MANIFEST)return Promise.resolve(TTS_LISTENING_MANIFEST);
  if(!TTS_LISTENING_MANIFEST_PROMISE)TTS_LISTENING_MANIFEST_PROMISE=Promise.resolve().then(function(){return TTS_DEPS.loadListeningManifest()})
    .then(assertListeningAudioManifest).then(function(manifest){TTS_LISTENING_MANIFEST=manifest;return manifest})
    .catch(function(error){TTS_LISTENING_MANIFEST_PROMISE=null;throw error});
  return TTS_LISTENING_MANIFEST_PROMISE}
function listeningAssets(manifest,set,lineCount){if(!set||typeof set.id!=='string'||!Number.isSafeInteger(set.revision))return[];
  var assets=manifest.assets.filter(function(asset){return asset.setId===set.id&&asset.revision===set.revision})
    .sort(function(left,right){return left.segmentIndex-right.segmentIndex});
  if(assets.length!==lineCount||assets.some(function(asset,index){return asset.segmentIndex!==index}))return[];return assets}
function listeningStatus(status,onStatus){try{TTS_DEPS.listeningAudioStatus(status)}catch(e){}try{if(typeof onStatus==='function')onStatus(status)}catch(e){}}
function listeningFallback(lines,status,onStatus){stopTtsAudio();TTS_DEPS.lStopFallback();listeningStatus(status,onStatus);lPlayRaw(lines);return false}
async function lPlayListeningSet(set,lines,onStatus){lines=Array.isArray(lines)?lines:[];
  stopTtsAudio();TTS_DEPS.lStopFallback();var requestSequence=++TTS_SEQUENCE;
  if(TTS_DEPS.slow())return listeningFallback(lines,'assisted-slow',onStatus);
  var manifest;try{manifest=await loadListeningManifest()}catch(e){if(requestSequence!==TTS_SEQUENCE)return false;return listeningFallback(lines,'fallback',onStatus)}
  if(requestSequence!==TTS_SEQUENCE)return false;
  var assets=listeningAssets(manifest,set,lines.length);if(!assets.length)return listeningFallback(lines,'fallback',onStatus);
  var index=0,fellBack=false;
  function fallback(){if(fellBack||requestSequence!==TTS_SEQUENCE)return;fellBack=true;listeningFallback(lines,'fallback-error',onStatus)}
  async function playNext(){if(requestSequence!==TTS_SEQUENCE)return;
    if(index>=assets.length){TTS_CURRENT=null;try{TTS_DEPS.lPlayBtn('')}catch(e){}return}
    var asset=assets[index++];if(index===1){try{TTS_DEPS.lPlayBtn('play')}catch(e){}listeningStatus('static',onStatus)}
    try{TTS_CURRENT=TTS_DEPS.createAudio(asset.path);TTS_CURRENT.onended=function(){playNext().catch(fallback)};TTS_CURRENT.onerror=fallback;
      await TTS_CURRENT.play()}catch(e){fallback()}}
  await playNext();return !fellBack}
function wSpeak(text){
  var cleanText=(text||'').replace(/^to /,'').trim();if(!cleanText)return;
  if(!TTS_DEPS.serverAvailable()){TTS_DEPS.wSpeakFallback(text);return}
  var requestSequence=++TTS_SEQUENCE;
  fetchTtsAudio(cleanText,'en-GB-SoniaNeural',false)
    .then(function(url){if(requestSequence!==TTS_SEQUENCE)return;if(TTS_CURRENT){try{TTS_CURRENT.pause()}catch(e){}}TTS_CURRENT=TTS_DEPS.createAudio(url);TTS_CURRENT.play().catch(function(){})})
    .catch(function(){if(requestSequence===TTS_SEQUENCE)TTS_DEPS.wSpeakFallback(text)})}

export {configureTts,lPlayListeningSet,lPlayRaw,lStop,wSpeak};
