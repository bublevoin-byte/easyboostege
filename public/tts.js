var TTS_CACHE={},TTS_CURRENT=null,TTS_SEQUENCE=0;

function fetchTtsAudio(text,voice,slow){
  var key=voice+'|'+(slow?1:0)+'|'+text;
  if(TTS_CACHE[key])return Promise.resolve(TTS_CACHE[key]);
  return apiGetBlob('/api/v1/tts?text='+encodeURIComponent(text)+'&voice='+voice+(slow?'&slow=1':''))
    .then(function(blob){if(!blob.size)throw new Error('Empty TTS response');var url=URL.createObjectURL(blob);TTS_CACHE[key]=url;return url})}
function stopTtsAudio(){TTS_SEQUENCE++;if(TTS_CURRENT){try{TTS_CURRENT.pause()}catch(e){}TTS_CURRENT=null}}
function lStop(){stopTtsAudio();lStopFallback();try{lPlayBtn('')}catch(e){}}
function lPlayRaw(lines){
  if(typeof SRV==='undefined'||!SRV||!TOKEN){lPlayRawFallback(lines);return}
  stopTtsAudio();lStopFallback();var requestSequence=++TTS_SEQUENCE;try{lPlayBtn('load')}catch(e){}
  Promise.all(lines.map(function(line){return fetchTtsAudio(line.t,line.s?'en-GB-SoniaNeural':'en-GB-RyanNeural',LSLOW)}))
    .then(function(urls){if(requestSequence!==TTS_SEQUENCE)return;var index=0;(function playNext(){if(requestSequence!==TTS_SEQUENCE||index>=urls.length){if(requestSequence===TTS_SEQUENCE){TTS_CURRENT=null;try{lPlayBtn('')}catch(e){}}return}if(index===0)try{lPlayBtn('play')}catch(e){}TTS_CURRENT=new Audio(urls[index++]);TTS_CURRENT.onended=playNext;TTS_CURRENT.onerror=playNext;TTS_CURRENT.play().catch(playNext)})()})
    .catch(function(){if(requestSequence===TTS_SEQUENCE){try{lPlayBtn('')}catch(e){}lPlayRawFallback(lines)}})}
function wSpeak(text){
  var cleanText=(text||'').replace(/^to /,'').trim();if(!cleanText)return;
  if(typeof SRV==='undefined'||!SRV||!TOKEN){wSpeakFallback(text);return}
  var requestSequence=++TTS_SEQUENCE;
  fetchTtsAudio(cleanText,'en-GB-SoniaNeural',false)
    .then(function(url){if(requestSequence!==TTS_SEQUENCE)return;if(TTS_CURRENT){try{TTS_CURRENT.pause()}catch(e){}}TTS_CURRENT=new Audio(url);TTS_CURRENT.play().catch(function(){})})
    .catch(function(){if(requestSequence===TTS_SEQUENCE)wSpeakFallback(text)})}
