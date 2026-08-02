/*
 * Экран «Слова» (scr2). Раздел 6.1 ТЗ обещает словарные карточки и интервальное повторение без
 * сети, поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 *
 * Словарь ЕГЭ, SRS-бухгалтерия и сводка для плитки главного экрана остались в оболочке: их числа
 * нужны сразу после входа, когда этот чанк ещё не загружен. Здесь — только сам экран.
 */
import {registerRouteHook,nav} from '../router.js';
import {wSpeak} from '../tts.js';
import {registerVoiceTutorError,voiceTutorButton} from '../voice-tutor.js';
import {
  EGE_WORDS,S,SRV,TOKEN,WBTN,generateAiContent,registerScreenGenerator,save,srsFail,srsOk,
  todayStr,ui,wBase,wDeco,wMergeAi,wMigrate,wRec,wStats,wSync,wordModule,
} from '../app.js';

/* ===== WORDS v2: SRS-словарь ЕГЭ ===== */
const W_TOPICS={0:'ИИ-набор',1:'Семья и отношения',2:'Образование',3:'Работа и карьера',4:'Путешествия',5:'Природа и экология',6:'Наука и технологии',7:'Здоровье и спорт',8:'Культура и досуг',9:'Общество и СМИ',10:'Город и покупки'};
const W_POS={n:'СУЩЕСТВИТЕЛЬНОЕ',v:'ГЛАГОЛ',adj:'ПРИЛАГАТЕЛЬНОЕ',adv:'НАРЕЧИЕ',ph:'ФРАЗОВЫЙ ГЛАГОЛ',id:'ВЫРАЖЕНИЕ'};
let WQ=[],WI=0,WDONE=0;
function initWords(){if(!S)return;wMigrate();wMergeAi();
  if(S.wday!==todayStr()){S.wday=todayStr();S.wnewUsed=0}
  var lim=Math.max(0,(S.wnew||30)-(S.wnewUsed||0));
  WQ=wordModule.buildDailyQueue(EGE_WORDS,S.srs,{newLimit:lim});WI=0;WDONE=0;
  wSync();wRender();wTopUp()}
function wModeFor(w){return wordModule.modeFor(wRec(w))}
function wBadge(x){var pos=W_POS[x.p]||x.pos||'СЛОВО';var top=W_TOPICS[x.t]||'';
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
  +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+pos+'</span>'
  +(top?'<span style="font-weight:700;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">'+top+'</span>':'')
  +'<button type="button" class="iconbtn clk" aria-label="Озвучить слово" onclick="wSpeak(WQ[WI]?WQ[WI].w:\'\')" style="cursor:pointer;flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:12px;background:#FFF4DE;">'
  +'<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button></div>'}
function wAnim(name,dur){ui.animate('w_card',name,dur)}
function wProgress(){var t=document.getElementById('w_today');if(t)t.textContent=WDONE+' / '+WQ.length+' сегодня'}
function wDistract(x,field){return wordModule.distractors(EGE_WORDS,x,field)}
function wRender(){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  if(!card||!opts)return;wProgress();
  wAnim('win','.32s');
  var x=WQ[WI];
  if(!x){var st=wStats(),n=S.wnewUsed||0;
    card.innerHTML=wDeco()+'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:22px 0;">'
      +'<div style="font-size:44px;">🎉</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:10px;">'+(n>0?'Ура! Сегодня +'+n+' новых слов':'На сегодня всё!')+'</div>'
      +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">Выучено полностью: '+st.learned+' из '+st.total+'<br>Слова вернутся на повторение в свой срок</div></div>';
    opts.innerHTML='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wExtra()">Хочу ещё 30 слов</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="nav(\'scr1\')">На главную</button>';
    return}
  var mode=wModeFor(x.w);
  if(mode==='c1'||mode==='c2'){
    var q=mode==='c1'?x.w:x.tr, field=mode==='c1'?'tr':'w';
    var right=x[field], all=wDistract(x,field).concat([right]).sort(function(){return Math.random()-.5});
    card.innerHTML=wDeco()+wBadge(x)
      +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
      +'<div style="font-weight:600;font-size:11.5px;letter-spacing:1px;color:#777163;">'+(mode==='c1'?'ВЫБЕРИ ПЕРЕВОД':'ВЫБЕРИ СЛОВО')+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:'+(mode==='c1'?'30':'24')+'px;color:#2B2B2B;margin-top:10px;letter-spacing:-.5px;">'+q+'</div></div>';
    opts.innerHTML=all.map(function(v){return '<button class="sq" style="'+WBTN+'" onclick="wPick(this,\''+encodeURIComponent(v)+'\',\''+encodeURIComponent(right)+'\')">'+v+'</button>'}).join('');
    if(mode==='c1')wSpeak(x.w);
    return}
  var blank=(x.ex||'').replace(new RegExp(wBase(x.w).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),'_____');
  card.innerHTML=wDeco()+wBadge(x)
    +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
    +'<div style="font-weight:600;font-size:11.5px;letter-spacing:1px;color:#777163;">НАПИШИ СЛОВО</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:24px;color:#B54E2F;margin-top:8px;">'+x.tr+'</div>'
    +'<div style="font-weight:500;font-size:13.5px;color:#777163;margin-top:10px;font-style:italic;line-height:1.5;">'+blank+'</div></div>';
  opts.innerHTML='<input id="w_inp" aria-label="Введи слово по-английски" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="Введи слово по-английски" '
    +'style="width:100%;box-sizing:border-box;height:52px;border:1px solid #F0EAE2;border-radius:18px;padding:0 16px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);" '
    +'onkeydown="if(event.key===\'Enter\')wSubmit()">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wSubmit()">Проверить</button>'}
/* карточка-переворот после ошибки */
function wFlip(x,learnerAnswer){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  if(!card||!opts)return;
  wAnim('wflip','.5s');
  card.innerHTML=wDeco()+wBadge(x)
    +'<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 0;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:30px;color:#2B2B2B;letter-spacing:-.6px;">'+x.w+'</div>'
    +(x.ipa?'<div style="font-weight:500;font-size:14px;color:#777163;margin-top:5px;">'+x.ipa+'</div>':'')
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:20px;color:#B54E2F;margin-top:12px;">'+x.tr+'</div>'
    +'<div style="font-weight:500;font-size:13.5px;color:#777163;margin-top:12px;font-style:italic;line-height:1.5;background:#FAF6F1;border-radius:14px;padding:10px 14px;">'+(x.ex||'')+'</div>'
    +'<div style="font-weight:600;font-size:11.5px;color:#75705F;margin-top:10px;">Запомни — слово вернётся позже</div></div>';
  opts.innerHTML='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="wNext()">Понятно, дальше</button>';
  if(x.voice)registerVoiceTutorError({module:'vocabulary',itemId:x.voice.id,revision:x.voice.revision,learnerAnswer:learnerAnswer})
    .then(function(recorded){if(recorded&&WQ[WI]===x&&opts.isConnected)opts.insertAdjacentHTML('afterbegin',voiceTutorButton(recorded))}).catch(function(){});
  wSpeak(x.w)}
/* список выученных */
function wShowKnown(){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
  if(!card||!opts)return;
  var list=EGE_WORDS.filter(function(x){var r=wRec(x.w);return r&&r.s>=5});
  var rows=list.map(function(x){
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="min-width:0;"><div style="font-weight:800;font-size:15px;color:#2B2B2B;">'+x.w+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:1px;">'+x.tr+'</div></div>'
      +'<button type="button" class="iconbtn clk" aria-label="Озвучить слово '+ui.escapeHtml(x.w)+'" onclick="wSpeak(\''+x.w.replace(/'/g,'')+'\')" style="cursor:pointer;flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:11px;background:#FFF4DE;">'
      +'<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button></div>'}).join('');
  card.innerHTML='<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;">Выученные слова · '+list.length+'</div>'
    +'<div id="w_known_body" style="margin-top:10px;"></div>';
  if(list.length)document.getElementById('w_known_body').innerHTML=rows;
  else ui.renderState('w_known_body',{kind:'empty',title:'Пока пусто',
    description:'Слово попадает сюда, когда ты подтвердишь его на всех повторениях',
    actionLabel:'Начать занятие',onAction:wRender});
  opts.innerHTML='<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="wRender()">← Вернуться к занятию</button>'}
function wNext(){WI++;wSync();save();wRender()}
function wPick(btn,vEnc,rightEnc){var x=WQ[WI];if(!x||btn.dataset.done)return;
  var v=decodeURIComponent(vEnc),right=decodeURIComponent(rightEnc);
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var r0=wRec(x.w),isNew=!r0||!r0.s;
  if(isNew)S.wnewUsed=(S.wnewUsed||0)+1;
  if(v===right){ui.markAnswer(btn,'correct');srsOk(x.w);WDONE++;wAnim('wpop','.35s');
    setTimeout(wNext,650)}
  else{ui.markAnswer(btn,'wrong');wAnim('wshake','.42s');
    all.forEach(function(b){if(b.textContent===right)ui.markAnswer(b,'correct')});
    srsFail(x.w);WDONE++;WQ.push(x);
    setTimeout(function(){wFlip(x,v)},900)}}
function wSubmit(){var x=WQ[WI];if(!x)return;var inp=document.getElementById('w_inp');if(!inp||inp.dataset.done)return;
  var val=(inp.value||'').toLowerCase().trim().replace(/^to /,'');
  var ok=val===wBase(x.w);inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  if(!ok){inp.value=wBase(x.w);srsFail(x.w);WQ.push(x)}else srsOk(x.w);
  WDONE++;if(ok){wSpeak(x.w);wAnim('wpop','.35s')}else wAnim('wshake','.42s');
  setTimeout(ok?wNext:function(){wFlip(x,val)},ok?650:900)}
function wExtra(){wMergeAi();
  var fresh=EGE_WORDS.filter(function(x){var r=wRec(x.w);return !r||!r.s});
  WQ=fresh.slice(0,30);WI=0;WDONE=0;wRender();
  if(fresh.length<40)wTopUp()}
/* фоновая генерация: база сама пополняется, сверяясь с уже известными словами */
var W_GEN=false;
async function wTopUp(){
  if(W_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var fresh=EGE_WORDS.filter(function(x){var r=wRec(x.w);return !r||!r.s}).length;
  if(fresh>=40)return;W_GEN=true;
  try{
    var have=EGE_WORDS.map(function(x){return x.w}).slice(0,500);
    var d=await generateAiContent('vocabulary_cards',{count:30,exclude:have});
    if(Array.isArray(d)&&d.length){var have2={};EGE_WORDS.forEach(function(x){have2[x.w]=1});
      var added=[];
      d.forEach(function(x){if(x.w&&x.tr&&!have2[x.w]&&(x.ex||'').toLowerCase().indexOf(x.w.replace(/^to /,'').toLowerCase())>=0){var it={w:x.w,p:x.p||'n',t:0,tr:x.tr,ex:x.ex||''};EGE_WORDS.push(it);added.push(it);have2[x.w]=1}});
      if(added.length){S.aiWords=(S.aiWords||[]).concat(added);save();wSync()}}
  }catch(e){}
  W_GEN=false}
/* ИИ-набор слов теперь пополняет базу ЕГЭ */
async function genWords(){
  const d=await generateAiContent('vocabulary_cards',{count:8,exclude:EGE_WORDS.map(function(x){return x.w}).slice(0,500)});if(!Array.isArray(d)||!d.length)throw 0;
  var have={};EGE_WORDS.forEach(function(x){have[x.w]=1});
  d.forEach(function(x){if(x.w&&x.tr&&!have[x.w])EGE_WORDS.push({w:x.w,p:x.p||'n',t:0,tr:x.tr,ex:x.ex||''})});
  initWords()}

registerRouteHook(function(id){if(id==='scr2')initWords()});
registerScreenGenerator('scr2',genWords);

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {WI,WQ,wExtra,wNext,wPick,wRender,wShowKnown,wSubmit};
