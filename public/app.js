/* legacy block 1 */
import {back,cur,nav,prepareScreen,registerRouteHook,show,tab} from './router.js';
import {configureTts,lStop} from './tts.js';
import {decorateCoreVocabulary} from './modules/core-voice-catalog.js';
import {clearAdaptiveOverviewCache} from './adaptive-overview-cache.js';
import {clearAdaptiveRuntime} from './adaptive-session-runtime.js';
import {classifyLearningAccess,LEARNING_ACCESS_STATES} from './access.js';
import {
  applyVocabularyOutcome,
  localVocabularyProgress,
  mergeLegacyVocabularyProgress,
  migrateLocalVocabularyProgress,
  migrateVocabularyProgress,
  normalizePersonalVocabularyCards,
} from './vocabulary-domain.js';
/*
 * Оболочка не знает, что умеет экран: она знает только, что его код приезжает отдельным чанком.
 * Реестр чанков живёт в screens.js и подключается к маршрутизатору сам — здесь достаточно того,
 * что модуль выполнен до первого перехода.
 */
import './screens.js';

/* ---------- STATE ---------- */
const todayStr=()=>new Date().toISOString().slice(0,10);
const INITIAL_OWNER_MARKER=window.EasyBoostStore?.readCurrentOwner?.()||null;
let currentUser=INITIAL_OWNER_MARKER&&INITIAL_OWNER_MARKER.owner||null,S=null;
let AUTH_SESSION_GENERATION=0;
const AUTHORITY_RESET_HOOKS=new Set();
function registerAuthorityReset(hook){if(typeof hook!=='function')return function(){};AUTHORITY_RESET_HOOKS.add(hook);return function(){AUTHORITY_RESET_HOOKS.delete(hook)}}
async function notifyAuthorityReset(authority){for(const hook of AUTHORITY_RESET_HOOKS){try{await hook(authority)}catch(error){console.error('Authority reset hook failed',error)}}}
const OWNER_SESSION_GENERATION_KEY='eb_owner_generation_session_v1';
function readSessionOwnerGeneration(owner){try{const parsed=JSON.parse(sessionStorage.getItem(OWNER_SESSION_GENERATION_KEY)||'null');
  return parsed&&parsed.owner===owner&&Number.isSafeInteger(parsed.generation)&&parsed.generation>=0?parsed.generation:null}catch(_){return null}}
function rememberSessionOwnerGeneration(owner,generation){try{if(owner&&Number.isSafeInteger(generation))sessionStorage.setItem(OWNER_SESSION_GENERATION_KEY,JSON.stringify({owner:owner,generation:generation}));
  else sessionStorage.removeItem(OWNER_SESSION_GENERATION_KEY)}catch(_){}}
let ADOPTED_OWNER_GENERATION=readSessionOwnerGeneration(currentUser);
if(ADOPTED_OWNER_GENERATION==null&&INITIAL_OWNER_MARKER&&INITIAL_OWNER_MARKER.owner===currentUser)
  ADOPTED_OWNER_GENERATION=INITIAL_OWNER_MARKER.ownerGeneration;
function normalizedAuthOwner(value){var owner=String(value||'').trim();return owner||null}
function captureExplicitAuth(owner=null){var ownerKey=normalizedAuthOwner(owner);
  var authority=store.sync.ownerAuthSnapshot?.(ownerKey)||{ownerGeneration:0,globalGeneration:0};return{
  sessionGeneration:AUTH_SESSION_GENERATION,owner:ownerKey,
  ownerGeneration:ownerKey?authority.ownerGeneration:null,globalGeneration:authority.globalGeneration}}
const store=window.EasyBoostStore;
const ui=window.EasyBoostComponents;
const txt=ui.elementText;
const makeInteractive=ui.makeInteractive;
const bindText=ui.bindText;
const setTxt=ui.setText;
const ringOff=ui.setRingOffset;
const toast=ui.notify;
const wordModule=window.EasyBoostWords;
const grammarModule=window.EasyBoostGrammar;
const readingModule=window.EasyBoostReading;
const listeningModule=window.EasyBoostListening;
const writingModule=window.EasyBoostWriting;
const speakingModule=window.EasyBoostSpeaking;
const examModule=window.EasyBoostExam;
const progressModule=window.EasyBoostProgress;
const profileModule=window.EasyBoostProfile;
function applySyncedGrammarMastery(update){
  if(!S||!update||update.owner!==currentUser||!Array.isArray(update.records))return false;
  if(update.ownerGeneration!==ADOPTED_OWNER_GENERATION)return false;
  if(!currentOwnerAuthorityCurrent(update.owner))return false;
  S.grammarMastery=S.grammarMastery||{};let changed=false;
  update.records.forEach(function(item){
    const topicId=Number(item&&item.topicId);if(!Number.isInteger(topicId)||topicId<1||topicId>20||!item.record)return;
    const incoming=grammarModule.migrateMasteryRecord(item.record);
    const current=grammarModule.migrateMasteryRecord(S.grammarMastery[topicId]);
    if(incoming.masteryRevision<=current.masteryRevision)return;
    S.grammarMastery[topicId]=incoming;changed=true
  });
  if(changed){store.saveLocal(currentUser,S,ADOPTED_OWNER_GENERATION);gSync()}
  return changed
}
store.sync.onGrammarMasterySync?.(applySyncedGrammarMastery);
function applyDeletedOwner(update){
  if(!update||!update.owner)return false;
  if(update.owner!==currentUser)return false;
  const resetAuthority={owner:currentUser,ownerGeneration:ADOPTED_OWNER_GENERATION};
  const deletedGeneration=Number(update.ownerGeneration);
  if(Number.isSafeInteger(deletedGeneration)&&Number.isSafeInteger(ADOPTED_OWNER_GENERATION)
    &&deletedGeneration<=ADOPTED_OWNER_GENERATION&&update.deleted!==true)return false;
  AUTH_SESSION_GENERATION+=1;
  TOKEN='';currentUser=null;S=null;window.__sub=null;ADOPTED_OWNER_GENERATION=null;rememberSessionOwnerGeneration(null,null);store.sync.setOwner(null);
  void notifyAuthorityReset(resetAuthority);
  try{localStorage.removeItem('eb_tg_code')}catch(_){}
  hideLearningShell();show('scr5');
  return true
}
store.sync.onOwnerDeleted?.(applyDeletedOwner);
function getUsers(){try{return JSON.parse(localStorage.getItem('eb_users'))||{}}catch(e){return{}}}
function setUsers(u){localStorage.setItem('eb_users',JSON.stringify(u))}
/* ---------- DATA ---------- */



/* ---------- NAV WIRING (tabs/back/tiles/flows) ---------- */
const TABROUTE={'Главная':'scr1','Учить':'scr2','Прогресс':'scr10','Профиль':'scr11'};
const TILEROUTE={'Слова':'scr2','Грамматика':'scr3','Чтение':'scr7','Аудирование':'scr4','Письмо':'scr8','Говорение':'scr9'};
function wire(){
  document.querySelectorAll('.screen').forEach(scr=>{
    scr.querySelectorAll('div,span,a').forEach(el=>{const t=txt(el);if(TABROUTE[t]&&el.children.length<=1&&t.length<11){const control=el.closest('.navit')||el;makeInteractive(control,t,()=>nav(TABROUTE[t]))}});
    scr.querySelectorAll('svg').forEach(sv=>{const h=(sv.innerHTML||'').toLowerCase();if(h.includes('14 6 8 12 14 18')){const p=sv.parentElement||sv;makeInteractive(p,'Назад',()=>back())}});
  });
  const s1=document.getElementById('scr1');
  if(s1)s1.querySelectorAll('div,span').forEach(el=>{const t=txt(el);if(TILEROUTE[t]&&el.children.length===0){const card=el.closest('.clayCard')||el;makeInteractive(card,t,()=>nav(TILEROUTE[t]))}});
  bindText('scr5','Войти',()=>doLogin());bindText('scr5','Создать',()=>doRegister());
  bindText('scr6','Поехали',()=>startApp());bindText('scr6','Пропустить',()=>startApp());
  bindText('scr14','Повторить',()=>tab('scr8'));bindText('scr14','Учить офлайн',()=>tab('scr2'));
}

/* ---------- AUTH ---------- */
function inputVal(scr,ph){const el=document.querySelector('#'+scr+' input[placeholder*="'+ph+'"]');return el?el.value.trim():''}
document.addEventListener('DOMContentLoaded',()=>{wire();
});
wire();
S=currentUser?store.loadLocal(currentUser,ADOPTED_OWNER_GENERATION):null;

/* ===== READING ===== */
/* Последнее слово, по которому кликнули в тексте: его показывает всплывающая карточка перевода
   и озвучивает кнопка из разметки, поэтому имя живёт в оболочке, а не в чанке чтения. */
let lastWord="",lastWordContext="";

/* ===== ROBUSTNESS + OFFLINE FALLBACKS ===== */
const DICT={
 many:{ipa:'/ˈmeni/',tr:'многие'},students:{ipa:'/ˈstjuːdnts/',tr:'студенты'},take:{ipa:'/teɪk/',tr:'брать, взять'},
 gap:{ipa:'/ɡæp/',tr:'промежуток, разрыв'},year:{ipa:'/jɪə/',tr:'год'},before:{ipa:'/bɪˈfɔː/',tr:'перед, до'},
 university:{ipa:'/ˌjuːnɪˈvɜːsəti/',tr:'университет'},they:{ipa:'/ðeɪ/',tr:'они'},travel:{ipa:'/ˈtrævl/',tr:'путешествовать'},
 work:{ipa:'/wɜːk/',tr:'работать, работа'},volunteering:{ipa:'/ˌvɒlənˈtɪərɪŋ/',tr:'волонтёрство'},
 valuable:{ipa:'/ˈvæljuəbl/',tr:'ценный, полезный'},experience:{ipa:'/ɪkˈspɪəriəns/',tr:'опыт'},
 helps:{ipa:'/helps/',tr:'помогает'},become:{ipa:'/bɪˈkʌm/',tr:'становиться'},more:{ipa:'/mɔː/',tr:'больше, более'},
 independent:{ipa:'/ˌɪndɪˈpendənt/',tr:'независимый, самостоятельный'},confident:{ipa:'/ˈkɒnfɪdənt/',tr:'уверенный'},
 experience_:{}
};
/* translate: AI first, else offline dictionary */
async function trWord(w,encodedContext=''){lastWord=w;try{lastWordContext=decodeURIComponent(encodedContext||'')}catch(_){lastWordContext=''};const pop=document.getElementById('r_pop');
  document.getElementById('r_word').textContent=w;document.getElementById('r_ipa').textContent='';document.getElementById('r_tr').textContent='перевод…';pop.style.display='block';
  try{const d=await generateAiContent('dictionary_lookup',{word:w});
    document.getElementById('r_ipa').textContent=d.ipa||'';document.getElementById('r_tr').textContent=d.tr}
  catch(e){const off=DICT[w];
    if(off){document.getElementById('r_ipa').textContent=off.ipa||'';document.getElementById('r_tr').textContent=off.tr+'  · офлайн-словарь'}
    else{document.getElementById('r_ipa').textContent='';document.getElementById('r_tr').textContent='ИИ офлайн, слова нет в мини-словаре. Включи VPN/ключ.'}}}



/* ===== DASHBOARD / PROGRESS / PROFILE (real data) ===== */
const RING_IDS={words:'ring_words',gram:'ring_gram',read:'ring_read',listen:'ring_listen',write:'ring_write',speak:'ring_speak'};
const METRIC_IDS={words:'m_words',gram:'m_gram',read:'m_read',listen:'m_listen',write:'m_write',speak:'m_speak'};
function daysLeft(){return progressModule.daysLeft(Date.now())}
function renderHome(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('h_hello',profileModule.greeting(currentUser));
  setTxt('h_days','До ЕГЭ — '+view.daysLeft+' дней · полный пробник в разработке');
  setTxt('h_ava',profileModule.initial(currentUser||'друг'));
  setTxt('h_min',view.daily.minutes);setTxt('h_pct',view.daily.percent+'%');ringOff('h_ring',263.9,view.daily.percent);
  setTxt('h_streak',progressModule.streakLabel(view.streak,true));
  progressModule.MODULES.forEach(function(name){
    setTxt(METRIC_IDS[name],view.modules[name]);ringOff(RING_IDS[name],113.1,view.modules[name])});
  setTxt('sub_words',progressModule.learnedLabel(view.learned))}
const PROFILE_HOOKS=[];
function registerProfileHook(hook){PROFILE_HOOKS.push(hook)}
function runProfileHooks(){PROFILE_HOOKS.forEach(function(hook){try{hook()}catch(e){console.error('Profile hook failed',e)}})}
/* Прогресс и профиль рисуют свои чанки: они регистрируют хук сами, когда приезжают. */
registerRouteHook(function(id){if(id==='scr1')renderHome()});


/* ===== FIX TABBAR HIT-AREA + LEARN SHEET ===== */
const LEARN_MODS=[
 ['📇','Слова','лексика · карточки','scr2','linear-gradient(135deg,#FFA570,#F2683F)'],
 ['📐','Грамматика','правила + тесты','scr3','linear-gradient(135deg,#6FC2B0,#1F9E5A)'],
 ['📖','Чтение','перевод по клику','scr7','linear-gradient(135deg,#FFC861,#E8730A)'],
 ['🎧','Аудирование','слушай и отвечай','scr4','linear-gradient(135deg,#5FB6C9,#3E93A8)'],
 ['✍️','Письмо','задания 37 / 38 + ИИ','scr8','linear-gradient(135deg,#FF9E8A,#E26A56)'],
 ['🎤','Говорение','таймер + запись','scr9','linear-gradient(135deg,#FFB07A,#F2683F)'],
 ['⏱','Пробный ЕГЭ','полный вариант · в разработке','scr16','linear-gradient(135deg,#B6BBC2,#8A8F98)']
];
const EXAM_TRAININGS=[
 {screen:'scr3',start:'gExam',icon:'✎',label:'Грамматика · задания 19–24',background:'#FFEDE4'},
 {screen:'scr4',start:'lExam',icon:'🎧',label:'Аудирование · раздел целиком',background:'#E3F1F5'},
 {screen:'scr7',start:'rExam',icon:'📖',label:'Чтение · раздел целиком',background:'#FFF4DE'},
 {screen:'scr8',start:null,icon:'✍️',label:'Письмо · задания 37 и 38',background:'#FCEEEC'},
 {screen:'scr9',start:'spExam',icon:'🎤',label:'Говорение · устная часть',background:'#EAF7F0'}
];
function buildExamTrainingLinks(){
  const root=document.getElementById('exam_training_links');if(!root||root.childElementCount)return;
  EXAM_TRAININGS.forEach(function(training){
    const button=document.createElement('button');button.type='button';button.className='exam-training';
    const icon=document.createElement('span');icon.className='exam-training__icon';icon.setAttribute('aria-hidden','true');icon.style.background=training.background;icon.textContent=training.icon;
    const label=document.createElement('span');label.className='exam-training__label';label.textContent=training.label;
    const chevron=document.createElement('span');chevron.className='exam-training__chevron';chevron.setAttribute('aria-hidden','true');chevron.textContent='›';
    button.append(icon,label,chevron);button.addEventListener('click',function(){
      if(!training.start){tab(training.screen);return}
      tab(training.screen,function(){window[training.start]()});
    });root.appendChild(button);
  });
}
function buildLearnSheet(){
  if(document.getElementById('learnSheet'))return;
  const w=document.createElement('div');w.id='learnSheet';
  const rows=LEARN_MODS.map(m=>'<button type="button" class="lm cardbtn" onclick="learnGo(\''+m[3]+'\')"><span class="ic" aria-hidden="true" style="background:'+m[4]+'">'+m[0]+'</span><span class="tx"><b>'+m[1]+'</b><span>'+m[2]+'</span></span><span class="ch" aria-hidden="true">›</span></button>').join('');
  w.innerHTML='<button type="button" class="bd" aria-label="Закрыть список модулей" onclick="closeLearn()"></button><div class="sheet"><div class="grip"></div><h3>Учить</h3>'+rows+'</div>';
  document.body.appendChild(w);
}
function openLearn(){buildLearnSheet();document.getElementById('learnSheet').classList.add('open')}
function closeLearn(){const e=document.getElementById('learnSheet');if(e)e.classList.remove('open')}
function learnGo(id){closeLearn();nav(id)}

function wireTabs(){
  const R={'Главная':'scr1','Прогресс':'scr10','Профиль':'scr11'};
  document.querySelectorAll('.screen').forEach(scr=>{
    scr.querySelectorAll('span').forEach(sp=>{
      const t=(sp.textContent||'').trim();
      if(t==='Главная'||t==='Учить'||t==='Прогресс'||t==='Профиль'){
        const fresh=sp.cloneNode(true);sp.replaceWith(fresh);       // strip old text-only listener
        const col=fresh.parentElement;if(!col)return;col.style.cursor='pointer';
        makeInteractive(col,t,()=>{if(t==='Учить')openLearn();else nav(R[t])});
      }
    });
  });
}
document.addEventListener('DOMContentLoaded',()=>{buildLearnSheet();buildExamTrainingLinks();wireTabs()});
buildLearnSheet();buildExamTrainingLinks();wireTabs();


/* ===== AI CONTENT GENERATION ===== */


/* -- toast + FAB -- */
function parseJSON(s){try{return JSON.parse(s.replace(/```json|```/g,'').trim())}catch(e){const m=s.match(/[\[{][\s\S]*[\]}]/);if(m){try{return JSON.parse(m[0])}catch(e2){}}return null}}
const GEN_STATE_ID='genstate';
function genStateHost(){var el=document.getElementById(GEN_STATE_ID);
  if(!el){el=document.createElement('div');el.id=GEN_STATE_ID;document.body.appendChild(el)}
  return el}
function genState(options){ui.renderState(genStateHost(),options)}
function genStateClear(){genStateHost().innerHTML=''}
/*
 * Генерацию задания умеет только сам экран, а его код приезжает чанком. Кнопка живёт в оболочке
 * и видна лишь на уже открытом экране, поэтому чанк успевает зарегистрировать свою генерацию.
 */
const SCREEN_GENERATORS={};
function registerScreenGenerator(id,generate){SCREEN_GENERATORS[id]=generate}
async function genForCurrent(){const id=cur();const fab=document.getElementById('genfab');fab.disabled=true;
  genState({kind:'loading',title:'ИИ придумывает задание',description:'Обычно это занимает несколько секунд'});
  try{
    const generate=SCREEN_GENERATORS[id];
    if(generate)await generate();
    genState({kind:'success',title:'Готово — новое задание',description:'Можно продолжать занятие'});
    setTimeout(genStateClear,2600);
  }catch(e){
    genState({kind:'error',title:'ИИ недоступен',description:apiMessage(e,'ai')+' Встроенное задание осталось на месте.',
      actionLabel:'Повторить',onAction:function(){genStateClear();genForCurrent()}});
  }
  fab.disabled=false}

/* -- FAB visibility -- */
(function(){
  const fab=document.createElement('button');fab.id='genfab';fab.innerHTML='✨ ИИ: новое';fab.onclick=genForCurrent;document.body.appendChild(fab);
  ui.ensureLiveRegion('toast');
  registerRouteHook(function(id){const show=['scr2','scr3','scr4','scr7'].includes(id);fab.style.display=show?'inline-flex':'none';if(!show)genStateClear()});
})();


/* ===== SERVER CONNECT (Этап 5) ===== */
const auth=window.EasyBoostAuth;
const SRV=auth.isServerMode;
let TOKEN=''; // маркер активной cookie-сессии; сам JWT недоступен JavaScript
function gv(id){var e=document.getElementById(id);return e?(e.value||'').trim():''}
function lgMsg(t){var e=document.getElementById('lg_msg');if(e)e.textContent=t}
const apiPost=EasyBoostApi.post;
const apiPostIdempotent=EasyBoostApi.postIdempotent;
const apiPut=EasyBoostApi.put;
const apiGet=EasyBoostApi.get;
const apiGetBlob=EasyBoostApi.getBlob;
const apiPostBinary=EasyBoostApi.postBinary;
const apiMessage=EasyBoostApi.messageFor;
const apiResponseOwner=EasyBoostApi.responseOwner;
const apiIsAuthorityFailure=EasyBoostApi.isAuthorityFailure;
const apiCanUseOfflineFallback=EasyBoostApi.canUseOfflineFallback;
function syncModuleAttempt(attempt){return store.sync.saveModuleAttempt(attempt)}
let authTransition=Promise.resolve();
function runAuthTransition(action){
  const pending=authTransition.then(action,action);authTransition=pending.catch(function(){});return pending;
}

function hideLearningShell(){
  const bar=document.getElementById('tabbar');if(bar)bar.style.display='none';
}
function setAccessBackgroundInert(inert){
  document.querySelectorAll('.screen,#tabbar,#genfab,#learnSheet').forEach(function(element){element.inert=inert});
}
function closeAccessGate(focusLogin=false){
  document.getElementById('access_gate')?.remove();setAccessBackgroundInert(false);
  if(focusLogin)queueMicrotask(function(){document.querySelector('#scr5 input, #scr5 button, #scr5 a')?.focus()});
}
function accessGate(){
  let gate=document.getElementById('access_gate');if(gate)return gate;
  gate=document.createElement('section');gate.id='access_gate';gate.setAttribute('role','dialog');gate.setAttribute('aria-modal','true');gate.setAttribute('aria-labelledby','access_gate_title');gate.setAttribute('aria-describedby','access_gate_copy');
  gate.setAttribute('style','position:fixed;inset:0;z-index:100000;background:linear-gradient(160deg,#FFA570,#F2683F);display:grid;place-items:center;padding:24px;font-family:Manrope,system-ui,sans-serif;');
  const card=document.createElement('div');card.setAttribute('style','width:min(100%,390px);box-sizing:border-box;border-radius:28px;background:#fff;padding:28px 24px;text-align:center;box-shadow:0 20px 55px rgba(20,20,30,.22);');
  const title=document.createElement('h1');title.id='access_gate_title';title.setAttribute('style','margin:0;color:#2B2B2B;font:800 23px Nunito,Manrope,sans-serif;');
  const copy=document.createElement('p');copy.id='access_gate_copy';copy.setAttribute('style','margin:10px 0 20px;color:#5D6168;font:600 14px/1.55 Manrope,system-ui,sans-serif;');
  const bot=document.createElement('a');bot.id='access_gate_bot';bot.target='_blank';bot.rel='noopener';bot.setAttribute('style','display:none;min-height:50px;box-sizing:border-box;border-radius:15px;background:#F2683F;color:#fff;padding:14px 16px;font:800 14px Manrope,sans-serif;text-decoration:none;');bot.textContent='Открыть Telegram-бот';
  const privacy=document.createElement('button');privacy.id='access_gate_privacy';privacy.type='button';privacy.setAttribute('style','display:none;width:100%;min-height:48px;margin-top:10px;border:1.5px solid #D9DCE1;border-radius:15px;background:#fff;color:#454950;font:800 14px Manrope,sans-serif;cursor:pointer;');privacy.textContent='Настройки приватности и данных';privacy.addEventListener('click',function(){window.openCalibrationPrivacy?.()});
  const retry=document.createElement('button');retry.id='access_gate_retry';retry.type='button';retry.setAttribute('style','width:100%;min-height:48px;margin-top:10px;border:1.5px solid #F3D2C8;border-radius:15px;background:#fff;color:#B54E2F;font:800 14px Manrope,sans-serif;cursor:pointer;');retry.textContent='Повторить проверку';retry.addEventListener('click',function(){pwCheck()});
  card.append(title,copy,bot,privacy,retry);gate.appendChild(card);gate.addEventListener('keydown',function(event){
    if(event.key!=='Tab')return;const controls=[bot,privacy,retry].filter(function(control){return control.offsetParent!==null});
    if(!controls.length)return;const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  });document.body.appendChild(gate);return gate;
}
function applyLearningAccess(result){
  const state=result.state;hideLearningShell();
  if(state===LEARNING_ACCESS_STATES.ACTIVE){closeAccessGate();return}
  if(state===LEARNING_ACCESS_STATES.NO_SESSION){
    show('scr5');closeAccessGate(true);const login=document.getElementById('scr5');if(login)login.dataset.accessState=state;lgMsg('Войдите, чтобы проверить активный доступ.');return
  }
  show('scr5');const gate=accessGate();setAccessBackgroundInert(true);gate.dataset.state=state;
  const title=document.getElementById('access_gate_title');const copy=document.getElementById('access_gate_copy');const bot=document.getElementById('access_gate_bot');const privacy=document.getElementById('access_gate_privacy');
  if(state===LEARNING_ACCESS_STATES.INACTIVE){
    title.textContent='Нужен активный доступ';copy.textContent='Сессия подтверждена, но подписка неактивна или закончилась. Учебные разделы откроются после активации доступа.';
    if(result.session&&result.session.bot){bot.href='https://t.me/'+result.session.bot;bot.style.display='block'}else bot.style.display='none';
    privacy.style.display='block';
  }else{
    title.textContent='Не удалось проверить доступ';copy.textContent='Сейчас нет связи с сервером, поэтому мы не можем подтвердить подписку. Учебные разделы не открыты. Проверьте сеть и повторите попытку.';bot.style.display='none';privacy.style.display='none';
  }queueMicrotask(function(){document.getElementById('access_gate_retry')?.focus()})
}
function adoptServerSession(session,ownerGeneration){
  const sessionOwner=normalizedAuthOwner(session&&session.username);
  if(!session||session.authenticated!==true||!sessionOwner||!Number.isSafeInteger(ownerGeneration)||ownerGeneration<0)return false;
  const authority=store.sync.ownerAuthSnapshot?.(sessionOwner)||{ownerGeneration:0,deleted:false};
  if(authority.deleted||authority.ownerGeneration!==ownerGeneration)return false;
  AUTH_SESSION_GENERATION+=1;
  TOKEN='cookie';window.__sub=session;currentUser=sessionOwner;ADOPTED_OWNER_GENERATION=ownerGeneration;
  rememberSessionOwnerGeneration(currentUser,ADOPTED_OWNER_GENERATION);
  return true
}
function currentOwnerAuthorityCurrent(owner=currentUser){
  if(!owner||owner!==currentUser||!Number.isSafeInteger(ADOPTED_OWNER_GENERATION))return false;
  const authority=store.sync.ownerAuthSnapshot?.(owner)||{ownerGeneration:0,deleted:false};
  if(authority.ownerGeneration===ADOPTED_OWNER_GENERATION&&!authority.deleted)return true;
  applyDeletedOwner({owner:owner,ownerGeneration:authority.ownerGeneration,deleted:authority.deleted});return false
}
async function checkLearningAccess(session=null,{preserveActiveShell=false,signal=null}={}){
  if(!SRV){const result=classifyLearningAccess(null,new Error('server mode required'));applyLearningAccess(result);return result}
  const authGuard={sessionGeneration:AUTH_SESSION_GENERATION,owner:currentUser,ownerGeneration:ADOPTED_OWNER_GENERATION,
    globalGeneration:store.sync.ownerAuthSnapshot?.()?.globalGeneration??0};
  try{
    if(signal?.aborted)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,aborted:true};
    const current=session||await auth.currentSession({signal,cache:'no-store'});
    if(signal?.aborted)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,aborted:true};
    if(authGuard.sessionGeneration!==AUTH_SESSION_GENERATION){return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,stale:true}}
    const result=classifyLearningAccess(current);
    if(current&&current.authenticated===true){
      const sessionOwner=normalizedAuthOwner(current.username);let generation=authGuard.ownerGeneration;
      if(Number.isSafeInteger(generation)){
        if(sessionOwner!==authGuard.owner||store.sync.ownerAuthSnapshot?.(sessionOwner)?.ownerGeneration!==generation)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,stale:true}
      }else{
        if(authGuard.owner&&sessionOwner!==authGuard.owner)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,stale:true};
        if(store.sync.ownerAuthSnapshot?.()?.globalGeneration!==authGuard.globalGeneration)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,stale:true};
        generation=store.sync.ownerAuthSnapshot?.(sessionOwner)?.ownerGeneration??0
      }
      const adopted=await store.sync.adoptOwner?.(sessionOwner,generation,{
        canCommit:function(){return authGuard.sessionGeneration===AUTH_SESSION_GENERATION},
        commit:function(committedGeneration){return adoptServerSession(current,committedGeneration)},
      });
      if(adopted!==sessionOwner)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,stale:true}
    }else{TOKEN='';ADOPTED_OWNER_GENERATION=null;rememberSessionOwnerGeneration(null,null)}
    if(preserveActiveShell&&result.state===LEARNING_ACCESS_STATES.ACTIVE)closeAccessGate();else applyLearningAccess(result);return result;
  }catch(error){
    if(signal?.aborted)return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null,aborted:true};
    const result=classifyLearningAccess(null,error);if(result.state===LEARNING_ACCESS_STATES.NO_SESSION)TOKEN='';applyLearningAccess(result);return result;
  }
}
async function verifyLearningAccessForLaunch({signal=null}={}){
  return runAuthTransition(async function(){
    const access=await checkLearningAccess(null,{preserveActiveShell:true,signal});
    return signal?.aborted!==true&&access.state===LEARNING_ACCESS_STATES.ACTIVE;
  });
}

/* save/load через сервер (или локально) */
let _saveT=null;
const START_HOOKS=[];
function registerStartHook(hook){START_HOOKS.push(hook)}
function save(options={}){
  if(SRV&&(!TOKEN||!currentOwnerAuthorityCurrent())||!SRV&&store.sync.isOwnerDeleted?.(currentUser))return;
  /* локальный снимок держит слова, SRS, грамматику и прогресс доступными без сети */
  store.saveLocal(currentUser,S,ADOPTED_OWNER_GENERATION);
  if(SRV){clearTimeout(_saveT);if(options.queueNow)store.sync.queueProgress(S);_saveT=setTimeout(()=>{if(currentOwnerAuthorityCurrent())store.sync.saveProgress(S)},600)}}
async function invalidateLearningAuthority(authority){
  var owner=authority&&authority.owner,ownerGeneration=authority&&authority.ownerGeneration;
  if(currentUser!==owner||ADOPTED_OWNER_GENERATION!==ownerGeneration)return false;
  AUTH_SESSION_GENERATION+=1;TOKEN='';currentUser=null;S=null;window.__sub=null;ADOPTED_OWNER_GENERATION=null;rememberSessionOwnerGeneration(null,null);store.sync.setOwner(null);
  await notifyAuthorityReset(authority);
  await Promise.all([
    store.clearCurrentOwner?.(owner,ownerGeneration),
    clearAdaptiveRuntime({owner:owner,ownerGeneration:ownerGeneration}),
    clearAdaptiveOverviewCache(localStorage,{owner:owner,ownerGeneration:ownerGeneration}),
  ]);
  hideLearningShell();show('scr5');return true;
}
window.EasyBoostAuthority=Object.freeze({invalidate:invalidateLearningAuthority});
async function startLearningWithVerifiedSession(session){
  const access=classifyLearningAccess(session);applyLearningAccess(access);
  if(access.state!==LEARNING_ACCESS_STATES.ACTIVE||normalizedAuthOwner(session&&session.username)!==currentUser||!currentOwnerAuthorityCurrent())return false;
  var startOwner=currentUser,startGeneration=AUTH_SESSION_GENERATION,startOwnerGeneration=ADOPTED_OWNER_GENERATION;
  function startStillCurrent(){return Boolean(TOKEN&&currentUser===startOwner
    &&AUTH_SESSION_GENERATION===startGeneration&&currentOwnerAuthorityCurrent(startOwner))}
  /* Встроенные задания нужны до первого экрана письма и должны быть доступны офлайн,
     поэтому банк загружается из закэшированного /task-bank.json на старте. */
  await loadTaskBank();
  if(!startStillCurrent())return false;
  store.sync.setOwner(currentUser);
  if(SRV){
    var served=null,localWorkflow=store.loadLocal(currentUser,ADOPTED_OWNER_GENERATION);
    try{served=await apiGet('/api/v1/progress',{headers:{'X-EasyBoost-Expected-Owner':startOwner}})}catch(e){
      if(apiIsAuthorityFailure(e))await invalidateLearningAuthority({owner:startOwner,ownerGeneration:startOwnerGeneration});
      if(!apiCanUseOfflineFallback(e))return false;served=null}
    if(!startStillCurrent())return false;
    if(served&&apiResponseOwner(served)!==startOwner){await invalidateLearningAuthority({owner:startOwner,ownerGeneration:startOwnerGeneration});return false}
    S=store.restore(currentUser,served,store.sync.pendingModules(),ADOPTED_OWNER_GENERATION);
    /* Active exercise queues are device-local workflow, not mastery authority. Keep the exact
       generation-bound value (including null) so an immediate reload cannot lose a committed
       answer or resurrect a completed queue while server-owned mastery still comes from served. */
    if(Object.hasOwn(localWorkflow,'grammarRunner'))S.grammarRunner=localWorkflow.grammarRunner;
    store.saveLocal(currentUser,S,ADOPTED_OWNER_GENERATION);
    if(!served)try{toast('Нет сети — показан сохранённый прогресс')}catch(e){}}
  if(!startStillCurrent())return false;
  store.sync.setBaseline(S);
  tab('scr1');
  for(const hook of START_HOOKS){if(!startStillCurrent())return false;try{await hook()}catch(e){}if(!startStillCurrent())return false}
  return true;
}
async function confirmExplicitServerOwner(session,authGuard){
  var sessionOwner=normalizedAuthOwner(session&&session.username);
  if(!authGuard||authGuard.sessionGeneration!==AUTH_SESSION_GENERATION||!sessionOwner)return false;
  if(authGuard.owner&&authGuard.owner!==sessionOwner)return false;
  const confirmed=await store.sync.confirmOwner?.(sessionOwner,{
    ownerScoped:Boolean(authGuard.owner),ownerGeneration:authGuard.ownerGeneration,globalGeneration:authGuard.globalGeneration,
  },{
    canCommit:function(){return authGuard.sessionGeneration===AUTH_SESSION_GENERATION},
    commit:function(){const generation=authGuard.owner?authGuard.ownerGeneration:store.sync.ownerAuthSnapshot?.(sessionOwner)?.ownerGeneration;
      return adoptServerSession(session,generation)},
  });
  return confirmed===sessionOwner
}
async function startApp(){
  return runAuthTransition(async function(){
    const access=await checkLearningAccess();
    if(access.state!==LEARNING_ACCESS_STATES.ACTIVE)return false;
    return startLearningWithVerifiedSession(access.session);
  });
}

/* вход/регистрация */
async function doLogin(){
  if(!SRV){applyLearningAccess(classifyLearningAccess(null,new Error('server mode required')));return}
  const u=gv('lg_user'),p=gv('lg_pass');if(!u||!p){lgMsg('Введите имя и пароль');return}
  lgMsg('Вход…');
  try{await runAuthTransition(async function(){var authGuard=captureExplicitAuth(u);const d=await auth.login(u,p);
    if(!await confirmExplicitServerOwner(d,authGuard))return false;lgMsg('');await startLearningWithVerifiedSession(d)})}
  catch(e){lgMsg(apiMessage(e,'auth'))}}
async function doRegister(){
  if(!SRV){applyLearningAccess(classifyLearningAccess(null,new Error('server mode required')));return}
  const u=gv('lg_user'),p=gv('lg_pass');if(!u||!p){lgMsg('Введите имя и пароль');return}
  lgMsg('Создаём аккаунт…');
  try{await runAuthTransition(async function(){var authGuard=captureExplicitAuth(u);const d=await auth.register(u,p);
    if(!await confirmExplicitServerOwner(d,authGuard))return false;lgMsg('');if(classifyLearningAccess(d).state===LEARNING_ACCESS_STATES.ACTIVE){show('scr6');hideLearningShell()}else applyLearningAccess(classifyLearningAccess(d))})}
  catch(e){lgMsg(apiMessage(e,'auth'))}}
async function logout(){
  return runAuthTransition(async function(){
    const logoutOwner=currentUser,logoutOwnerGeneration=ADOPTED_OWNER_GENERATION;
    try{if(SRV)await auth.logout()}catch(_){}
    AUTH_SESSION_GENERATION+=1;
    TOKEN='';ADOPTED_OWNER_GENERATION=null;rememberSessionOwnerGeneration(null,null);store.sync.setOwner(null);
    await Promise.all([
      store.clearCurrentOwner?.(logoutOwner,logoutOwnerGeneration),
      clearAdaptiveRuntime({owner:logoutOwner,ownerGeneration:logoutOwnerGeneration}),
      clearAdaptiveOverviewCache(localStorage,{owner:logoutOwner,ownerGeneration:logoutOwnerGeneration}),
    ]);
    try{localStorage.removeItem('eb_tg_code')}catch(_){}
    location.reload()
  })
}

function generateAiContent(operation,payload){return EasyBoostApi.generateContent(operation,payload)}

/* профиль: в серверном режиме ключ не нужен на клиенте */
registerProfileHook(function(){var ai=document.getElementById('pf_ai');if(ai){ai.textContent='через сервер ✓';ai.style.color='#1D7F4A';ai.style.background='#EAF7F0'}})

/* До серверной проверки всегда виден только вход, а учебная оболочка скрыта. */
hideLearningShell();show('scr5');
/*
 * После подтверждённого входа ученик уходит на «Главную». Готовим её заранее: первая отрисовка
 * стоит около двухсот миллисекунд. Подготовка не показывает экран и не даёт доступ к навигации.
 */
prepareScreen('scr1');


/* ===== TELEGRAM LOGIN v2 (mobile-safe) ===== */
let TG_URL='', TG_CODE='', TG_IV=null;
async function tgInit(){
  if(typeof SRV==='undefined'||!SRV)return;
  try{const d=await auth.startTelegramLogin();TG_URL=d.url;TG_CODE=d.code;
    var a=document.getElementById('tgbtn');if(a)a.href=TG_URL;tgPoll();}
  catch(e){lgMsg(apiMessage(e,'telegram'));}
}
function tgPoll(){
  if(!TG_CODE)return;try{localStorage.setItem('eb_tg_code',TG_CODE)}catch(_){};let tries=0;clearInterval(TG_IV);
  TG_IV=setInterval(()=>{tries++;runAuthTransition(async function(){
    try{var authGuard=captureExplicitAuth();const c=await auth.checkTelegramLogin(TG_CODE);
      if(c&&c.authenticated){clearInterval(TG_IV);
        if(!await confirmExplicitServerOwner(c,authGuard))return false;lgMsg('');await startLearningWithVerifiedSession(c);}
    }catch(e){}
    if(tries>300){clearInterval(TG_IV)}
  })},2000);
}
// Telegram-код создаётся только после явного действия пользователя.


/* ===== TELEGRAM login: настоящая ссылка (iOS-safe) ===== */
try{clearInterval(TG_IV)}catch(e){}
// Восстановление существующей cookie-сессии выполняется ниже через /api/v1/me.


/* legacy block 2 */
async function pwCheck(){
  return runAuthTransition(async function(){
    const access=await checkLearningAccess();
    if(access.state!==LEARNING_ACCESS_STATES.ACTIVE)return false;
    await startLearningWithVerifiedSession(access.session);return true;
  });
}
window.checkSub=pwCheck;

/* legacy block 3 */
/* ===== Вход по ссылке из бота (magic link) — без всплывающих окон ===== */
(function(){
  try{
    // Старые magic-link JWT обрабатываются сервером до загрузки страницы.
    if(new URLSearchParams(location.search).has('t'))history.replaceState(null,'',location.pathname);
  }catch(e){}
})();
/* Кнопка Telegram v9: берём ссылку по клику и сразу открываем бота + видимый запасной линк */
try{var _tb=document.getElementById('tgbtn'); if(_tb)_tb.removeAttribute('target');}catch(_){}
async function tgClick(e){
  if(e&&e.preventDefault)e.preventDefault();
  if(typeof SRV==='undefined'||!SRV){ lgMsg('Открой приложение по ссылке сервера.'); return false; }
  lgMsg('Готовлю вход…');
  try{
    if(typeof TG_URL==='undefined'||!TG_URL){ var d=await auth.startTelegramLogin(); TG_URL=d.url; TG_CODE=d.code; }
  }catch(err){ lgMsg(apiMessage(err,'telegram')); return false; }
  try{ if(typeof tgPoll==='function') tgPoll(); }catch(_){}
  var m=document.getElementById('lg_msg');
  if(m) m.innerHTML='<a href="'+TG_URL+'" style="display:inline-block;margin-top:2px;color:#B54E2F;font-weight:800;text-decoration:underline;font-size:14.5px;">Открыть Telegram-бот</a><div style="margin-top:5px;font-size:12.5px;color:#6A6E75;">нажми ссылку → Start → кнопка «Открыть Easy Boost»</div>';
  try{ window.location.href=TG_URL; }catch(_){}
  return false;
}

/* legacy block 4 */
/* ===== SESSION v2: постоянный вход, восстановление сессии, подписка ===== */
(function(){
  async function me(){return runAuthTransition(function(){return auth.currentSession()})}
  window.ebMe=me;
  /* вход через Telegram переживает перезагрузку страницы */
  try{
    var pc=localStorage.getItem('eb_tg_code');
    if(!TOKEN&&pc){TG_CODE=pc;tgPoll();}
  }catch(_){}
  setInterval(function(){if(TOKEN){try{localStorage.removeItem('eb_tg_code')}catch(_){}}},3000);
  /* восстановление сессии из cookie + продление токена при каждом заходе */
  (async function(){
    if(typeof SRV==='undefined'||!SRV)return;
    await runAuthTransition(async function(){
      const access=await checkLearningAccess();
      if(access.state===LEARNING_ACCESS_STATES.ACTIVE){try{localStorage.removeItem('eb_tg_code')}catch(_){};await startLearningWithVerifiedSession(access.session)}
    });
  })();
  /* статус подписки в профиле */
  registerProfileHook(function(){
    if(typeof SRV==='undefined'||!SRV)return;
    var host=document.getElementById('pf_name');if(!host||!host.parentElement)return;
    var el=document.getElementById('pf_sub');
    if(!el){el=document.createElement('div');el.id='pf_sub';
      el.setAttribute('style','display:inline-block;margin-top:6px;font:700 11.5px Manrope,sans-serif;padding:5px 10px;border-radius:20px;');
      host.parentElement.appendChild(el);}
    var aiStatus=document.getElementById('pf_ai');var voiceRow=document.getElementById('pf_voice_row');
    if(aiStatus&&!voiceRow){var list=aiStatus.parentElement&&aiStatus.parentElement.parentElement;
      if(list){voiceRow=document.createElement('div');voiceRow.id='pf_voice_row';voiceRow.setAttribute('style','display:flex;align-items:center;gap:13px;padding:15px 16px;border-bottom:1px solid #F4F5F6;');
        var icon=document.createElement('span');icon.setAttribute('style','width:34px;height:34px;border-radius:11px;background:#FFF4DE;display:grid;place-items:center;font-size:17px;flex:0 0 auto;');icon.textContent='🎙️';
        var copy=document.createElement('span');copy.setAttribute('style','flex:1;min-width:0;');
        var title=document.createElement('span');title.id='pf_voice_title';title.setAttribute('style','display:block;font-weight:700;font-size:14px;color:#2B2B2B;');
        var detail=document.createElement('span');detail.id='pf_voice_detail';detail.setAttribute('role','status');detail.setAttribute('style','display:inline-block;margin-top:4px;font-weight:700;font-size:11.5px;padding:4px 8px;border-radius:12px;line-height:1.35;');
        var action=document.createElement('button');action.id='pf_voice_action';action.type='button';action.setAttribute('aria-label','Запросить доступ к Voice Tutor Premium');action.setAttribute('style','display:none;min-height:44px;border:0;border-radius:14px;padding:8px 11px;background:#F2683F;color:#fff;font:700 11px Manrope,sans-serif;cursor:pointer;');
        copy.appendChild(title);copy.appendChild(detail);voiceRow.appendChild(icon);voiceRow.appendChild(copy);voiceRow.appendChild(action);list.insertBefore(voiceRow,aiStatus.parentElement.nextSibling);}}
    var paymentRequest=null;
    var renderProfileStatuses=function(profile){var subscriptionStatus=profileModule.subscriptionStatus(profile,Date.now());el.textContent=subscriptionStatus.text;el.style.color=subscriptionStatus.color;el.style.background=subscriptionStatus.background;
      var voiceTutorStatus=profileModule.voiceTutorStatus(profile,paymentRequest);var title=document.getElementById('pf_voice_title');var detail=document.getElementById('pf_voice_detail');var action=document.getElementById('pf_voice_action');
      if(title)title.textContent=voiceTutorStatus.title;if(detail){detail.textContent=voiceTutorStatus.text;detail.style.color=voiceTutorStatus.color;detail.style.background=voiceTutorStatus.background}
      if(action){action.textContent=voiceTutorStatus.actionLabel;action.style.display=voiceTutorStatus.actionLabel?'block':'none';action.disabled=false;action.onclick=voiceTutorStatus.actionLabel?async function(){action.disabled=true;try{var result=await EasyBoostApi.post('/api/v1/payments/requests',{product:'premium_voice'});paymentRequest=result.request;renderProfileStatuses(profile)}catch(error){action.disabled=false;detail.textContent=EasyBoostApi.messageFor(error)}}:null}};
    if(window.__sub)renderProfileStatuses(window.__sub);
    Promise.all([me(),EasyBoostApi.get('/api/v1/payments/requests?product=premium_voice').catch(function(){return{request:null}})]).then(function(values){var profile=values[0];paymentRequest=values[1]&&values[1].request;if(profile){window.__sub=profile;renderProfileStatuses(profile)}});
  });
})();

/* legacy block 5 */
const EGE_WORDS=[
{w:'relationship',t:1,p:'n',tr:'отношения',ex:'They have a close relationship.',voice:{id:'vocabulary.relationship.meaning',revision:1}},
{w:'sibling',t:1,p:'n',tr:'брат или сестра',ex:'I have one sibling, a younger brother.'},
{w:'upbringing',t:1,p:'n',tr:'воспитание',ex:'She had a strict upbringing.'},
{w:'to bring up',t:1,p:'ph',tr:'воспитывать',ex:'It is hard to bring up children alone.'},
{w:'to get on with',t:1,p:'ph',tr:'ладить с кем-то',ex:'I get on with my parents well.'},
{w:'to rely on',t:1,p:'ph',tr:'полагаться на',ex:'You can always rely on true friends.'},
{w:'supportive',t:1,p:'adj',tr:'поддерживающий',ex:'My family is very supportive.'},
{w:'to argue',t:1,p:'v',tr:'спорить, ссориться',ex:'They argue about small things.'},
{w:'argument',t:1,p:'n',tr:'ссора, спор',ex:'We had an argument yesterday.'},
{w:'household',t:1,p:'n',tr:'домохозяйство, семья',ex:'Every household has its rules.'},
{w:'chores',t:1,p:'n',tr:'домашние обязанности',ex:'I do chores every weekend.'},
{w:'to take care of',t:1,p:'id',tr:'заботиться о',ex:'She has to take care of her granny.'},
{w:'generation',t:1,p:'n',tr:'поколение',ex:'Each generation has its own values.'},
{w:'elderly',t:1,p:'adj',tr:'пожилой',ex:'We should help elderly people.'},
{w:'to respect',t:1,p:'v',tr:'уважать',ex:'Children should respect their parents.'},
{w:'bond',t:1,p:'n',tr:'связь, узы',ex:'There is a strong bond between twins.'},
{w:'to trust',t:1,p:'v',tr:'доверять',ex:'I trust my best friend completely.'},
{w:'honest',t:1,p:'adj',tr:'честный',ex:'Be honest with your family.'},
{w:'to forgive',t:1,p:'v',tr:'прощать',ex:'It is important to forgive each other.'},
{w:'to quarrel',t:1,p:'v',tr:'ссориться',ex:'Brothers sometimes quarrel over toys.'},
{w:'to resemble',t:1,p:'v',tr:'быть похожим на',ex:'I resemble my mother a lot.'},
{w:'to look after',t:1,p:'ph',tr:'присматривать за',ex:'Grandparents look after the kids.'},
{w:'to grow up',t:1,p:'ph',tr:'вырастать',ex:'Children grow up so fast.'},
{w:'marriage',t:1,p:'n',tr:'брак',ex:'Their marriage lasted fifty years.'},
{w:'mutual',t:1,p:'adj',tr:'взаимный',ex:'Friendship is based on mutual trust.'},
{w:'to appreciate',t:1,p:'v',tr:'ценить',ex:'I appreciate your help a lot.'},
{w:'to support',t:1,p:'v',tr:'поддерживать',ex:'Parents support us in hard times.'},
{w:'ancestor',t:1,p:'n',tr:'предок',ex:'My ancestors lived in a village.'},
{w:'to inherit',t:1,p:'v',tr:'наследовать',ex:'She will inherit the house.'},
{w:'strict',t:1,p:'adj',tr:'строгий',ex:'His father is quite strict.'},
{w:'to attend',t:2,p:'v',tr:'посещать',ex:'All children attend school here.'},
{w:'compulsory',t:2,p:'adj',tr:'обязательный',ex:'Education is compulsory in Russia.'},
{w:'curriculum',t:2,p:'n',tr:'учебная программа',ex:'The curriculum includes two languages.'},
{w:'timetable',t:2,p:'n',tr:'расписание',ex:'Check the timetable for Monday.'},
{w:'to fail',t:2,p:'v',tr:'провалить (экзамен)',ex:'I do not want to fail the exam.'},
{w:'grade',t:2,p:'n',tr:'оценка, класс',ex:'She always gets good grades.'},
{w:'knowledge',t:2,p:'n',tr:'знания',ex:'Reading widens your knowledge.'},
{w:'to acquire',t:2,p:'v',tr:'приобретать (знания)',ex:'Students acquire new skills.'},
{w:'to memorise',t:2,p:'v',tr:'заучивать',ex:'It is hard to memorise dates.'},
{w:'to revise',t:2,p:'v',tr:'повторять (материал)',ex:'I revise grammar before tests.'},
{w:'revision',t:2,p:'n',tr:'повторение',ex:'Revision helps before exams.'},
{w:'achievement',t:2,p:'n',tr:'достижение',ex:'Winning was a great achievement.'},
{w:'to achieve',t:2,p:'v',tr:'достигать',ex:'You can achieve your goals.'},
{w:'opportunity',t:2,p:'n',tr:'возможность',ex:'University gives you every opportunity to grow.'},
{w:'skill',t:2,p:'n',tr:'навык',ex:'Writing is a useful skill.'},
{w:'to develop',t:2,p:'v',tr:'развивать',ex:'Sports develop team spirit.'},
{w:'to graduate',t:2,p:'v',tr:'оканчивать (вуз)',ex:'She will graduate next year.'},
{w:'degree',t:2,p:'n',tr:'учёная степень, диплом',ex:'He has a degree in law.'},
{w:'scholarship',t:2,p:'n',tr:'стипендия',ex:'She won a scholarship to Oxford.'},
{w:'term',t:2,p:'n',tr:'четверть, семестр',ex:'The autumn term starts in September.'},
{w:'assignment',t:2,p:'n',tr:'задание',ex:'Hand in your assignment on Friday.'},
{w:'to concentrate',t:2,p:'v',tr:'сосредотачиваться',ex:'I cannot concentrate in noise.'},
{w:'to succeed',t:2,p:'v',tr:'преуспевать',ex:'Work hard to succeed in exams.'},
{w:'successful',t:2,p:'adj',tr:'успешный',ex:'She is a successful student.'},
{w:'effort',t:2,p:'n',tr:'усилие',ex:'Learning takes time and effort.'},
{w:'to make progress',t:2,p:'id',tr:'делать успехи',ex:'You make progress every week.'},
{w:'pupil',t:2,p:'n',tr:'ученик',ex:'Every pupil has a locker.'},
{w:'to cheat',t:2,p:'v',tr:'списывать, жульничать',ex:'Never cheat in a test.'},
{w:'boarding school',t:2,p:'n',tr:'школа-интернат',ex:'He studies at a boarding school.'},
{w:'to encourage',t:2,p:'v',tr:'поощрять, вдохновлять',ex:'Teachers encourage us to read.'},
{w:'career',t:3,p:'n',tr:'карьера',ex:'She built a career in medicine.'},
{w:'to apply for',t:3,p:'ph',tr:'подавать заявку на',ex:'You can apply for this job online.'},
{w:'application',t:3,p:'n',tr:'заявление, заявка',ex:'Send your application by May.'},
{w:'employer',t:3,p:'n',tr:'работодатель',ex:'Her employer offered a pay rise.'},
{w:'employee',t:3,p:'n',tr:'сотрудник',ex:'Every employee gets a bonus.'},
{w:'to employ',t:3,p:'v',tr:'нанимать',ex:'The firm employs 200 people.'},
{w:'unemployed',t:3,p:'adj',tr:'безработный',ex:'He was unemployed for a year.'},
{w:'salary',t:3,p:'n',tr:'зарплата',ex:'The salary is paid monthly.'},
{w:'to earn',t:3,p:'v',tr:'зарабатывать',ex:'Doctors earn a good salary.'},
{w:'to hire',t:3,p:'v',tr:'нанимать',ex:'They hire students in summer.'},
{w:'to quit',t:3,p:'v',tr:'увольняться',ex:'He decided to quit his job.'},
{w:'to retire',t:3,p:'v',tr:'выходить на пенсию',ex:'My granddad will retire soon.'},
{w:'responsibility',t:3,p:'n',tr:'ответственность',ex:'The job involves great responsibility.'},
{w:'responsible',t:3,p:'adj',tr:'ответственный',ex:'She is responsible for sales.'},
{w:'to be in charge of',t:3,p:'id',tr:'руководить, отвечать за',ex:'You will be in charge of the project.'},
{w:'experience',t:3,p:'n',tr:'опыт',ex:'The job requires experience.'},
{w:'qualification',t:3,p:'n',tr:'квалификация',ex:'What qualifications do you need?'},
{w:'interview',t:3,p:'n',tr:'собеседование',ex:'I have a job interview tomorrow.'},
{w:'part-time',t:3,p:'adj',tr:'на неполный день',ex:'She has a part-time job.'},
{w:'colleague',t:3,p:'n',tr:'коллега',ex:'My colleagues are friendly.'},
{w:'staff',t:3,p:'n',tr:'персонал',ex:'The staff work very hard.'},
{w:'to manage',t:3,p:'v',tr:'управлять; справляться',ex:'She manages a small team.'},
{w:'ambitious',t:3,p:'adj',tr:'амбициозный',ex:'He is young and ambitious.'},
{w:'demanding',t:3,p:'adj',tr:'требовательный, тяжёлый',ex:'Nursing is a demanding job.'},
{w:'rewarding',t:3,p:'adj',tr:'приносящий удовлетворение',ex:'Teaching is a rewarding career.'},
{w:'deadline',t:3,p:'n',tr:'крайний срок',ex:'The deadline is on Friday.'},
{w:'to run a business',t:3,p:'id',tr:'вести бизнес',ex:'Her parents run a business.'},
{w:'wage',t:3,p:'n',tr:'заработная плата (почасовая)',ex:'The minimum wage went up.'},
{w:'promotion',t:3,p:'n',tr:'повышение',ex:'He got a promotion last month.'},
{w:'to take on',t:3,p:'ph',tr:'брать (работу, сотрудника)',ex:'We will take on extra staff.'},
{w:'journey',t:4,p:'n',tr:'поездка, путь',ex:'The journey takes three hours.'},
{w:'voyage',t:4,p:'n',tr:'морское путешествие',ex:'The voyage across the sea was long.'},
{w:'to book',t:4,p:'v',tr:'бронировать',ex:'Book your tickets early.'},
{w:'accommodation',t:4,p:'n',tr:'жильё, размещение',ex:'The price includes accommodation.'},
{w:'luggage',t:4,p:'n',tr:'багаж',ex:'My luggage was too heavy.'},
{w:'to pack',t:4,p:'v',tr:'собирать вещи',ex:'I pack my suitcase the night before.'},
{w:'destination',t:4,p:'n',tr:'пункт назначения',ex:'Paris is a popular destination.'},
{w:'sightseeing',t:4,p:'n',tr:'осмотр достопримечательностей',ex:'We went sightseeing in Rome.'},
{w:'souvenir',t:4,p:'n',tr:'сувенир',ex:'I bought a souvenir for my mum.'},
{w:'abroad',t:4,p:'adv',tr:'за границей',ex:'She often travels abroad.'},
{w:'flight',t:4,p:'n',tr:'рейс, полёт',ex:'Our flight was delayed.'},
{w:'to delay',t:4,p:'v',tr:'задерживать',ex:'Fog can delay planes.'},
{w:'to cancel',t:4,p:'v',tr:'отменять',ex:'They had to cancel the trip.'},
{w:'to miss',t:4,p:'v',tr:'опоздать на; скучать',ex:'Hurry up or we will miss the train.'},
{w:'route',t:4,p:'n',tr:'маршрут',ex:'We planned the route carefully.'},
{w:'to explore',t:4,p:'v',tr:'исследовать',ex:'We love to explore old towns.'},
{w:'adventure',t:4,p:'n',tr:'приключение',ex:'The hike was a real adventure.'},
{w:'to set off',t:4,p:'ph',tr:'отправляться в путь',ex:'We set off early in the morning.'},
{w:'to check in',t:4,p:'ph',tr:'регистрироваться',ex:'Please check in two hours before.'},
{w:'to get around',t:4,p:'ph',tr:'передвигаться (по городу)',ex:'It is easy to get around by bus.'},
{w:'foreign',t:4,p:'adj',tr:'иностранный',ex:'She speaks two foreign languages.'},
{w:'currency',t:4,p:'n',tr:'валюта',ex:'What currency do they use?'},
{w:'to exchange',t:4,p:'v',tr:'обменивать',ex:'You can exchange money at the bank.'},
{w:'customs',t:4,p:'n',tr:'таможня',ex:'We went through customs quickly.'},
{w:'insurance',t:4,p:'n',tr:'страховка',ex:'Travel insurance is a must.'},
{w:'memorable',t:4,p:'adj',tr:'запоминающийся',ex:'It was a memorable holiday.'},
{w:'guidebook',t:4,p:'n',tr:'путеводитель',ex:'The guidebook lists cheap cafes.'},
{w:'crew',t:4,p:'n',tr:'экипаж',ex:'The cabin crew were polite.'},
{w:'to board',t:4,p:'v',tr:'садиться (на транспорт)',ex:'Passengers board the plane now.'},
{w:'scenery',t:4,p:'n',tr:'пейзаж',ex:'The mountain scenery is stunning.'},
{w:'environment',t:5,p:'n',tr:'окружающая среда',ex:'We must protect the environment.'},
{w:'environmental',t:5,p:'adj',tr:'экологический',ex:'Environmental problems are serious.'},
{w:'pollution',t:5,p:'n',tr:'загрязнение',ex:'Air pollution harms our health.'},
{w:'to pollute',t:5,p:'v',tr:'загрязнять',ex:'Factories pollute the river.'},
{w:'litter',t:5,p:'n',tr:'мусор (на улице)',ex:'Do not drop litter in the park.'},
{w:'rubbish',t:5,p:'n',tr:'мусор',ex:'Take the rubbish out, please.'},
{w:'waste',t:5,p:'n',tr:'отходы',ex:'Plastic waste is everywhere.'},
{w:'to recycle',t:5,p:'v',tr:'перерабатывать',ex:'We recycle paper and glass.'},
{w:'to reduce',t:5,p:'v',tr:'сокращать',ex:'We should reduce energy use.'},
{w:'to reuse',t:5,p:'v',tr:'использовать повторно',ex:'You can reuse glass jars.'},
{w:'climate change',t:5,p:'n',tr:'изменение климата',ex:'Climate change affects everyone.'},
{w:'global warming',t:5,p:'n',tr:'глобальное потепление',ex:'Global warming melts the ice.'},
{w:'to protect',t:5,p:'v',tr:'защищать',ex:'Laws protect rare animals.'},
{w:'endangered',t:5,p:'adj',tr:'находящийся под угрозой',ex:'Tigers are an endangered species.'},
{w:'species',t:5,p:'n',tr:'биологический вид',ex:'Many species live in the ocean.'},
{w:'extinct',t:5,p:'adj',tr:'вымерший',ex:'Dinosaurs are extinct.'},
{w:'habitat',t:5,p:'n',tr:'среда обитания',ex:'Forests are the habitat of bears.'},
{w:'wildlife',t:5,p:'n',tr:'дикая природа',ex:'The park is rich in wildlife.'},
{w:'to threaten',t:5,p:'v',tr:'угрожать',ex:'Fires threaten the forest.'},
{w:'threat',t:5,p:'n',tr:'угроза',ex:'Plastic is a threat to sea life.'},
{w:'drought',t:5,p:'n',tr:'засуха',ex:'The drought lasted all summer.'},
{w:'flood',t:5,p:'n',tr:'наводнение',ex:'The flood destroyed many homes.'},
{w:'disaster',t:5,p:'n',tr:'катастрофа',ex:'The earthquake was a disaster.'},
{w:'renewable',t:5,p:'adj',tr:'возобновляемый',ex:'Wind is a renewable source.'},
{w:'to conserve',t:5,p:'v',tr:'сохранять, беречь',ex:'Turn off lights to conserve energy.'},
{w:'emission',t:5,p:'n',tr:'выброс',ex:'Car emissions cause smog.'},
{w:'to run out of',t:5,p:'ph',tr:'исчерпать',ex:'We may run out of clean water.'},
{w:'to throw away',t:5,p:'ph',tr:'выбрасывать',ex:'Do not throw away old clothes.'},
{w:'harmful',t:5,p:'adj',tr:'вредный',ex:'Smog is harmful to lungs.'},
{w:'to plant',t:5,p:'v',tr:'сажать',ex:'Volunteers plant trees every spring.'},
{w:'device',t:6,p:'n',tr:'устройство',ex:'This device measures your pulse.'},
{w:'to invent',t:6,p:'v',tr:'изобретать',ex:'Who invented the telephone?'},
{w:'invention',t:6,p:'n',tr:'изобретение',ex:'The wheel is a great invention.'},
{w:'research',t:6,p:'n',tr:'исследование',ex:'Research shows teens sleep less.'},
{w:'scientist',t:6,p:'n',tr:'учёный',ex:'Scientists study the climate.'},
{w:'discovery',t:6,p:'n',tr:'открытие',ex:'It was an important discovery.'},
{w:'to discover',t:6,p:'v',tr:'открывать, обнаруживать',ex:'They hope to discover new planets.'},
{w:'artificial',t:6,p:'adj',tr:'искусственный',ex:'Artificial intelligence is everywhere.'},
{w:'gadget',t:6,p:'n',tr:'гаджет',ex:'Teens love new gadgets.'},
{w:'to download',t:6,p:'v',tr:'скачивать',ex:'You can download the app free.'},
{w:'to upload',t:6,p:'v',tr:'загружать (в сеть)',ex:'She uploads videos every week.'},
{w:'to browse',t:6,p:'v',tr:'просматривать (сайты)',ex:'I browse the news at breakfast.'},
{w:'network',t:6,p:'n',tr:'сеть',ex:'The school network is fast.'},
{w:'wireless',t:6,p:'adj',tr:'беспроводной',ex:'The hotel has wireless internet.'},
{w:'to connect',t:6,p:'v',tr:'подключать(ся)',ex:'Connect your phone to wifi.'},
{w:'data',t:6,p:'n',tr:'данные',ex:'The app collects user data.'},
{w:'to store',t:6,p:'v',tr:'хранить',ex:'Clouds store our photos.'},
{w:'digital',t:6,p:'adj',tr:'цифровой',ex:'We live in a digital world.'},
{w:'to update',t:6,p:'v',tr:'обновлять',ex:'Update the app to fix bugs.'},
{w:'software',t:6,p:'n',tr:'программное обеспечение',ex:'The software needs a licence.'},
{w:'virtual',t:6,p:'adj',tr:'виртуальный',ex:'We took a virtual museum tour.'},
{w:'to log in',t:6,p:'ph',tr:'входить в систему',ex:'Log in with your password.'},
{w:'to switch off',t:6,p:'ph',tr:'выключать',ex:'Switch off your phone in class.'},
{w:'to charge',t:6,p:'v',tr:'заряжать',ex:'I charge my phone at night.'},
{w:'battery',t:6,p:'n',tr:'батарея',ex:'My battery dies by evening.'},
{w:'breakthrough',t:6,p:'n',tr:'прорыв',ex:'It was a breakthrough in medicine.'},
{w:'experiment',t:6,p:'n',tr:'эксперимент',ex:'We did an experiment in class.'},
{w:'to carry out',t:6,p:'ph',tr:'проводить (исследование)',ex:'They carry out tests daily.'},
{w:'evidence',t:6,p:'n',tr:'доказательство',ex:'There is strong evidence for it.'},
{w:'efficient',t:6,p:'adj',tr:'эффективный',ex:'Solar panels became more efficient.'},
{w:'healthy',t:7,p:'adj',tr:'здоровый',ex:'A healthy diet includes fruit.'},
{w:'illness',t:7,p:'n',tr:'болезнь',ex:'Stress can cause illness.'},
{w:'disease',t:7,p:'n',tr:'заболевание',ex:'Vaccines prevent many diseases.'},
{w:'to suffer from',t:7,p:'ph',tr:'страдать от',ex:'Many teens suffer from stress.'},
{w:'symptom',t:7,p:'n',tr:'симптом',ex:'A cough is a common symptom.'},
{w:'to recover',t:7,p:'v',tr:'выздоравливать',ex:'He needs a week to recover.'},
{w:'injury',t:7,p:'n',tr:'травма',ex:'The player has a knee injury.'},
{w:'to injure',t:7,p:'v',tr:'травмировать',ex:'You may injure your back at the gym.'},
{w:'to treat',t:7,p:'v',tr:'лечить',ex:'Doctors treat patients with care.'},
{w:'treatment',t:7,p:'n',tr:'лечение',ex:'The treatment lasts a month.'},
{w:'medicine',t:7,p:'n',tr:'лекарство; медицина',ex:'Take the medicine twice a day.'},
{w:'to prescribe',t:7,p:'v',tr:'выписывать (лекарство)',ex:'The doctor prescribed some pills.'},
{w:'nutrition',t:7,p:'n',tr:'питание',ex:'Good nutrition matters for teens.'},
{w:'to keep fit',t:7,p:'id',tr:'поддерживать форму',ex:'I run to keep fit.'},
{w:'to work out',t:7,p:'ph',tr:'тренироваться',ex:'I work out three times a week.'},
{w:'to train',t:7,p:'v',tr:'тренировать(ся)',ex:'We train hard before matches.'},
{w:'coach',t:7,p:'n',tr:'тренер',ex:'Our coach is very strict.'},
{w:'competition',t:7,p:'n',tr:'соревнование',ex:'She won the swimming competition.'},
{w:'to compete',t:7,p:'v',tr:'соревноваться',ex:'Ten teams compete for the cup.'},
{w:'opponent',t:7,p:'n',tr:'соперник',ex:'Respect your opponent.'},
{w:'to defeat',t:7,p:'v',tr:'побеждать (кого-то)',ex:'They defeated the champions.'},
{w:'victory',t:7,p:'n',tr:'победа',ex:'The victory made us proud.'},
{w:'championship',t:7,p:'n',tr:'чемпионат',ex:'The championship starts in May.'},
{w:'to give up',t:7,p:'ph',tr:'бросать (привычку); сдаваться',ex:'He wants to give up sweets.'},
{w:'habit',t:7,p:'n',tr:'привычка',ex:'Reading at night is my habit.'},
{w:'addiction',t:7,p:'n',tr:'зависимость',ex:'Phone addiction is a real problem.'},
{w:'to prevent',t:7,p:'v',tr:'предотвращать',ex:'Exercise prevents many illnesses.'},
{w:'exhausted',t:7,p:'adj',tr:'измотанный',ex:'I was exhausted after the race.'},
{w:'to warm up',t:7,p:'ph',tr:'разминаться',ex:'Always warm up before running.'},
{w:'referee',t:7,p:'n',tr:'судья (в спорте)',ex:'The referee stopped the game.'},
{w:'entertainment',t:8,p:'n',tr:'развлечение',ex:'The city offers lots of entertainment.'},
{w:'performance',t:8,p:'n',tr:'выступление, спектакль',ex:'The performance lasted two hours.'},
{w:'to perform',t:8,p:'v',tr:'выступать',ex:'The band will perform tonight.'},
{w:'audience',t:8,p:'n',tr:'зрители, публика',ex:'The audience clapped loudly.'},
{w:'exhibition',t:8,p:'n',tr:'выставка',ex:'We visited a photo exhibition.'},
{w:'masterpiece',t:8,p:'n',tr:'шедевр',ex:'This novel is a masterpiece.'},
{w:'to admire',t:8,p:'v',tr:'восхищаться',ex:'I admire her talent.'},
{w:'novel',t:8,p:'n',tr:'роман',ex:'I am reading a detective novel.'},
{w:'author',t:8,p:'n',tr:'автор',ex:'The author signed my book.'},
{w:'plot',t:8,p:'n',tr:'сюжет',ex:'The plot is full of surprises.'},
{w:'character',t:8,p:'n',tr:'персонаж; характер',ex:'The main character is a spy.'},
{w:'to publish',t:8,p:'v',tr:'издавать',ex:'The book was published in May.'},
{w:'review',t:8,p:'n',tr:'рецензия, отзыв',ex:'The film got great reviews.'},
{w:'fascinating',t:8,p:'adj',tr:'увлекательный',ex:'The story is fascinating.'},
{w:'leisure',t:8,p:'n',tr:'досуг',ex:'How do you spend your leisure time?'},
{w:'to take up',t:8,p:'ph',tr:'увлечься, начать заниматься',ex:'I want to take up painting.'},
{w:'to be keen on',t:8,p:'id',tr:'увлекаться чем-то',ex:'It helps to be keen on your hobby.'},
{w:'impressive',t:8,p:'adj',tr:'впечатляющий',ex:'The set design was impressive.'},
{w:'to impress',t:8,p:'v',tr:'впечатлять',ex:'The actors impress everyone.'},
{w:'orchestra',t:8,p:'n',tr:'оркестр',ex:'The orchestra played Mozart.'},
{w:'rehearsal',t:8,p:'n',tr:'репетиция',ex:'We have a rehearsal at five.'},
{w:'stage',t:8,p:'n',tr:'сцена',ex:'She stepped onto the stage.'},
{w:'applause',t:8,p:'n',tr:'аплодисменты',ex:'The song ended with applause.'},
{w:'festival',t:8,p:'n',tr:'фестиваль',ex:'The film festival is in June.'},
{w:'tradition',t:8,p:'n',tr:'традиция',ex:'It is a family tradition.'},
{w:'heritage',t:8,p:'n',tr:'наследие',ex:'We must keep our cultural heritage.'},
{w:'ancient',t:8,p:'adj',tr:'древний',ex:'We saw ancient Greek vases.'},
{w:'to entertain',t:8,p:'v',tr:'развлекать',ex:'Clowns entertain the children.'},
{w:'subtitles',t:8,p:'n',tr:'субтитры',ex:'I watch films with subtitles.'},
{w:'to broadcast',t:9,p:'v',tr:'транслировать',ex:'They broadcast the match live.'},
{w:'society',t:9,p:'n',tr:'общество',ex:'Society is changing fast.'},
{w:'community',t:9,p:'n',tr:'сообщество',ex:'Our community helps the elderly.'},
{w:'charity',t:9,p:'n',tr:'благотворительность',ex:'The concert raised money for charity.'},
{w:'to donate',t:9,p:'v',tr:'жертвовать',ex:'People donate clothes and food.'},
{w:'to volunteer',t:9,p:'v',tr:'работать волонтёром',ex:'I volunteer at an animal shelter.'},
{w:'poverty',t:9,p:'n',tr:'бедность',ex:'Poverty is a global issue.'},
{w:'wealthy',t:9,p:'adj',tr:'богатый',ex:'He comes from a wealthy family.'},
{w:'equality',t:9,p:'n',tr:'равенство',ex:'We stand for equality.'},
{w:'to influence',t:9,p:'v',tr:'влиять',ex:'Ads influence our choices.'},
{w:'advertisement',t:9,p:'n',tr:'реклама',ex:'The advertisement was funny.'},
{w:'to advertise',t:9,p:'v',tr:'рекламировать',ex:'They advertise on social media.'},
{w:'headline',t:9,p:'n',tr:'заголовок',ex:'The headline caught my eye.'},
{w:'article',t:9,p:'n',tr:'статья',ex:'I read an article about space.'},
{w:'journalist',t:9,p:'n',tr:'журналист',ex:'The journalist asked hard questions.'},
{w:'source',t:9,p:'n',tr:'источник',ex:'Check the source of the news.'},
{w:'reliable',t:9,p:'adj',tr:'надёжный',ex:'Is this website reliable?'},
{w:'to convince',t:9,p:'v',tr:'убеждать',ex:'He convinced me to join.'},
{w:'to persuade',t:9,p:'v',tr:'уговаривать',ex:'She persuaded them to help.'},
{w:'opinion',t:9,p:'n',tr:'мнение',ex:'In my opinion, it is fair.'},
{w:'to express',t:9,p:'v',tr:'выражать',ex:'Express your ideas clearly.'},
{w:'freedom',t:9,p:'n',tr:'свобода',ex:'Freedom of speech matters.'},
{w:'government',t:9,p:'n',tr:'правительство',ex:'The government passed a new law.'},
{w:'law',t:9,p:'n',tr:'закон',ex:'The law protects consumers.'},
{w:'to obey',t:9,p:'v',tr:'подчиняться',ex:'Drivers must obey the rules.'},
{w:'citizen',t:9,p:'n',tr:'гражданин',ex:'Every citizen has rights.'},
{w:'to vote',t:9,p:'v',tr:'голосовать',ex:'You can vote at eighteen.'},
{w:'campaign',t:9,p:'n',tr:'кампания',ex:'They started an anti-litter campaign.'},
{w:'issue',t:9,p:'n',tr:'проблема, вопрос',ex:'Bullying is a serious issue.'},
{w:'awareness',t:9,p:'n',tr:'осведомлённость',ex:'The ad raises awareness of ecology.'},
{w:'neighbourhood',t:10,p:'n',tr:'район, окрестности',ex:'We live in a quiet neighbourhood.'},
{w:'suburb',t:10,p:'n',tr:'пригород',ex:'They moved to a suburb of London.'},
{w:'crowded',t:10,p:'adj',tr:'переполненный',ex:'The metro is crowded at eight.'},
{w:'convenient',t:10,p:'adj',tr:'удобный',ex:'Online shopping is convenient.'},
{w:'facilities',t:10,p:'n',tr:'инфраструктура, удобства',ex:'The area has good sports facilities.'},
{w:'pedestrian',t:10,p:'n',tr:'пешеход',ex:'This street is for pedestrians only.'},
{w:'traffic jam',t:10,p:'n',tr:'пробка',ex:'We got stuck in a traffic jam.'},
{w:'to commute',t:10,p:'v',tr:'ездить на работу/учёбу',ex:'Dad commutes by train.'},
{w:'resident',t:10,p:'n',tr:'житель',ex:'Residents want a new park.'},
{w:'to rent',t:10,p:'v',tr:'снимать, арендовать',ex:'They rent a flat downtown.'},
{w:'to afford',t:10,p:'v',tr:'позволить себе',ex:'I cannot afford a new phone.'},
{w:'affordable',t:10,p:'adj',tr:'доступный по цене',ex:'The cafe has affordable prices.'},
{w:'bargain',t:10,p:'n',tr:'выгодная покупка',ex:'This jacket was a real bargain.'},
{w:'discount',t:10,p:'n',tr:'скидка',ex:'Students get a ten percent discount.'},
{w:'to queue',t:10,p:'v',tr:'стоять в очереди',ex:'We had to queue for an hour.'},
{w:'receipt',t:10,p:'n',tr:'чек',ex:'Keep the receipt for a refund.'},
{w:'refund',t:10,p:'n',tr:'возврат денег',ex:'I asked for a full refund.'},
{w:'customer',t:10,p:'n',tr:'покупатель, клиент',ex:'The customer is always right.'},
{w:'to deliver',t:10,p:'v',tr:'доставлять',ex:'They deliver pizza in thirty minutes.'},
{w:'brand',t:10,p:'n',tr:'бренд',ex:'Which brand do you prefer?'},
{w:'to try on',t:10,p:'ph',tr:'примерять',ex:'Can I try on these jeans?'},
{w:'to pay in cash',t:10,p:'id',tr:'платить наличными',ex:'You can pay in cash or by card.'},
{w:'to save up',t:10,p:'ph',tr:'копить',ex:'I save up for a new bike.'},
{w:'groceries',t:10,p:'n',tr:'продукты',ex:'Mum buys groceries on Saturdays.'},
{w:'purchase',t:10,p:'n',tr:'покупка',ex:'It was an expensive purchase.'},
{w:'to spend',t:10,p:'v',tr:'тратить',ex:'Teens spend money on games.'},
{w:'shop assistant',t:10,p:'n',tr:'продавец-консультант',ex:'The shop assistant helped me.'},
{w:'to fit',t:10,p:'v',tr:'подходить по размеру',ex:'These shoes fit perfectly.'},
{w:'to suit',t:10,p:'v',tr:'идти, быть к лицу',ex:'This colour suits you.'},
{w:'window shopping',t:10,p:'n',tr:'разглядывание витрин',ex:'We went window shopping in the mall.'}
];
decorateCoreVocabulary(EGE_WORDS);
var W_SYNC=new Map(),W_SYNC_T=new Map();
function wAuthority(){return TOKEN&&currentOwnerAuthorityCurrent()?Object.freeze({owner:currentUser,ownerGeneration:ADOPTED_OWNER_GENERATION}):null}
function wAuthorityKey(authority){return authority.owner+'\u0000'+authority.ownerGeneration}
function wAuthorityCurrent(authority){return Boolean(authority&&currentUser===authority.owner&&ADOPTED_OWNER_GENERATION===authority.ownerGeneration&&currentOwnerAuthorityCurrent(authority.owner))}
async function wFlushServer(authority){
  var key=wAuthorityKey(authority),pending=W_SYNC.get(key);W_SYNC_T.delete(key);
  if(!pending||!pending.size||!wAuthorityCurrent(authority))return false;
  var entries=Array.from(pending.entries()),result;
  try{result=await apiPut('/api/v1/word-progress',{words:entries.map(function(entry){return entry[1]})},{'X-EasyBoost-Expected-Owner':authority.owner})}
  catch(error){if(apiIsAuthorityFailure(error))await invalidateLearningAuthority(authority);return false}
  if(!wAuthorityCurrent(authority))return false;
  if(apiResponseOwner(result)!==authority.owner){await invalidateLearningAuthority(authority);return false}
  entries.forEach(function(entry){if(pending.get(entry[0])===entry[1])pending.delete(entry[0])});if(!pending.size)W_SYNC.delete(key);return true
}
function wQueueServer(w){if(typeof SRV==='undefined'||!SRV)return;var authority=wAuthority(),r=wRec(w);if(!authority||!r)return;
  var key=wAuthorityKey(authority),pending=W_SYNC.get(key);if(!pending){pending=new Map();W_SYNC.set(key,pending)}
  pending.set(w,migrateVocabularyProgress({...r,word:w}));clearTimeout(W_SYNC_T.get(key));
  W_SYNC_T.set(key,setTimeout(function(){void wFlushServer(authority)},900))}
function wToday0(){var d=new Date();d.setHours(0,0,0,0);return d.getTime()}
function wRec(w){S.srs=S.srs||{};return S.srs[w]}
function wSet(w){S.srs=S.srs||{};return S.srs[w]||(S.srs[w]=localVocabularyProgress(w,{s:0,e:0,n:0,due:0}))}
function wBase(w){return wordModule.baseForm(w)}
function srsApply(w,ok){S.srs=S.srs||{};var current=wSet(w),legacy=EasyBoostLearning.reviewWord(current,ok);
  S.srs[w]=localVocabularyProgress(w,mergeLegacyVocabularyProgress(current,{word:w,...legacy}));wQueueServer(w)}
function srsOk(w){srsApply(w,true)}
function srsFail(w){srsApply(w,false)}
function srsRecordVocabularyOutcome(w,attempt){S.srs=S.srs||{};var current=wSet(w);
  var next=applyVocabularyOutcome({...current,word:w},attempt);
  S.srs[w]=localVocabularyProgress(w,next);wQueueServer(w);return S.srs[w]}
function wStats(){return wordModule.calculateStats(EGE_WORDS,S.srs)}
function wSync(){var st=wStats();S.learned=st.learned;S.prog=S.prog||{};S.prog.words=EasyBoostLearning.calculateProgress(st.learned,st.total);
  setTxt('w_know_n','Знаю '+st.learned);setTxt('pf_known_n',String(st.learned));setTxt('w_sumline','Выучено '+st.learned+' из '+st.total+' слов');
  var bar=document.getElementById('w_bar');if(bar)bar.style.width=Math.max(2,Math.round(st.learned/st.total*100))+'%';
  setTxt('sub_words','учу · '+st.learned+' / '+st.total)}
function wMigrate(){if(!S.srsMig){S.srsMig=1;S.srs=wordModule.migrateLegacy(EGE_WORDS,S.box,S.srs||{})}
  S.srs=migrateLocalVocabularyProgress(S.srs||{});S.srsMasteryVersion=1;
  S.personalWords=normalizePersonalVocabularyCards(S.personalWords||[]);
  S.personalWordTombstones=Array.from(new Set((Array.isArray(S.personalWordTombstones)?S.personalWordTombstones:[])
    .map(String).filter(function(id){return id.startsWith('personal:')}))).slice(-500);
  store.saveLocal(currentUser,S,ADOPTED_OWNER_GENERATION)}
function wSpeakFallback(txt){try{var u=new SpeechSynthesisUtterance(txt.replace(/^to /,''));u.lang='en-GB';u.rate=.9;speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}
function wDeco(){return '<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 280" preserveAspectRatio="xMidYMid slice">'
  +'<circle cx="330" cy="8" r="64" fill="rgba(255,200,97,.16)"/>'
  +'<circle cx="10" cy="270" r="54" fill="rgba(242,104,63,.07)"/>'
  +'<circle cx="300" cy="250" r="30" fill="rgba(255,165,112,.10)"/>'
  +'<g fill="rgba(242,104,63,.5)">'
  +'<path class="eb5sp" style="animation-delay:.3s" d="M28,52 Q28,56 32,56 Q28,56 28,60 Q28,56 24,56 Q28,56 28,52 Z"/>'
  +'<path class="eb5sp" style="animation-delay:1.4s" d="M318,120 Q318,124 322,124 Q318,124 318,128 Q318,124 314,124 Q318,124 318,120 Z"/>'
  +'<path class="eb5sp" style="animation-delay:.8s" d="M40,205 Q40,209 44,209 Q40,209 40,213 Q40,209 36,209 Q40,209 40,205 Z"/>'
  +'</g><g fill="rgba(255,178,76,.75)">'
  +'<path class="eb5sp" style="animation-delay:1.9s" d="M300,45 Q300,49.5 304.5,49.5 Q300,49.5 300,54 Q300,49.5 295.5,49.5 Q300,49.5 300,45 Z"/>'
  +'<path class="eb5sp" style="animation-delay:.5s" d="M170,28 Q170,31.5 173.5,31.5 Q170,31.5 170,35 Q170,31.5 166.5,31.5 Q170,31.5 170,28 Z"/>'
  +'<path class="eb5sp" style="animation-delay:2.3s" d="M310,215 Q310,218.5 313.5,218.5 Q310,218.5 310,222 Q310,218.5 306.5,218.5 Q310,218.5 310,215 Z"/>'
  +'<path class="eb5sp" style="animation-delay:1.1s" d="M25,130 Q25,133.5 28.5,133.5 Q25,133.5 25,137 Q25,133.5 21.5,133.5 Q25,133.5 25,130 Z"/>'
  +'</g></svg>'}
const WBTN='width:100%;min-height:52px;border:1px solid #F0EAE2;background:#fff;border-radius:18px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;cursor:pointer;padding:13px 14px;text-align:center;box-shadow:0 10px 22px rgba(60,45,30,.07),inset 0 2px 0 rgba(255,255,255,.9);';
function wMergeAi(){if(!S||!S.aiWords)return;wordModule.mergeGenerated(EGE_WORDS,S.aiWords)}
/* домашняя плитка при загрузке */
try{if(S)wSync()}catch(e){}
registerStartHook(function(){wMigrate();wMergeAi();return wSync()});
registerRouteHook(function(id){if(id==='scr2'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});

/* legacy block 6 */
function gClosed(){return grammarModule.countStable(S.grammarMastery)}
function gSync(){if(!S)return;var before=JSON.stringify(S.grammarMastery||{});
  S.grammarMastery=grammarModule.hasCanonicalMasteryRecords(S.grammarMastery)
    ?grammarModule.migrateMasteryRecords(S.grammarMastery)
    :grammarModule.migrateLegacyMasteryRecords(S.gram);
  if(JSON.stringify(S.grammarMastery)!==before)save();var c=gClosed();S.prog=S.prog||{};S.prog.gram=Math.round(c/20*100);
  setTxt('sub_gram','устойчиво '+c+' из 20 тем');setTxt('g_sumline','Устойчиво освоено '+c+' из 20 тем');
  var bar=document.getElementById('g_bar');if(bar)bar.style.width=Math.max(2,Math.round(c/20*100))+'%'}
function gExamFmt(sec){return grammarModule.formatDuration(sec)}
/* прячем FAB на грамматике, синк при старте */
registerRouteHook(function(id){if(id==='scr3'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});
registerStartHook(function(){return gSync()});

/* legacy block 7 */
function rSt(){S.read=readingModule.normalizeState(S.read);return S.read}
function rSync(){if(!S)return;var r=rSt();var stats=readingModule.summary(r),acc=stats.accuracy;
  S.prog=S.prog||{};S.prog.read=acc;
  setTxt('sub_read',r.texts?('текстов: '+r.texts+' · точность '+acc+'%'):'начни с первого текста');
  setTxt('r_sumline',r.texts?('Прочитано '+r.texts+' · точность '+acc+'%'):'Два тренажёра — как на экзамене');
  var bar=document.getElementById('r_bar');if(bar)bar.style.width=Math.max(2,acc)+'%'}
function rEsc(w){return ui.escapeHtml(w)}
function rWordsHtml(text){var sentences=String(text||'').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/gu)||[String(text||'')];
  return sentences.map(function(sentence){var context=sentence.trim(),encoded=encodeURIComponent(context).replace(/'/g,'%27');
    return sentence.split(/(\s+)/).map(function(tok){
      if(/^\s+$/.test(tok))return tok;
      var m=tok.match(/[A-Za-z][A-Za-z'-]*/);if(!m)return rEsc(tok);
      var clean=m[0].toLowerCase();
      var st=S.wstatus&&S.wstatus[clean];
      var bg=st==='learn'?'background:#FFEDE4;border-radius:5px;':(st==='know'?'background:#EAF7F0;border-radius:5px;':'');
      return '<button type="button" class="clk iconbtn" data-w="'+clean+'" data-context="'+encoded+'" onclick="trWord(this.dataset.w,this.dataset.context)" style="cursor:pointer;'+bg+'">'+rEsc(tok)+'</button>'}).join('')
  }).join('')}
/* FAB прячем и на чтении; синк при старте */
registerRouteHook(function(id){if(id==='scr7'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});
registerStartHook(function(){return rSync()});

/* legacy block 8 */
/* Замедленная озвучка — настройка проигрывателя, а не экрана: её читает tts.js, который
   настроен один раз при старте, задолго до того как приедет чанк аудирования. */
let LSLOW=false,L_FALLBACK_FINISH=null;
function lSt(){S.lis=listeningModule.normalizeState(S.lis);return S.lis}
function lSync(){if(!S)return;var r=lSt(),sum=listeningModule.summary(r),acc=sum.accuracy;
  S.prog=S.prog||{};S.prog.listen=acc;
  setTxt('sub_listen',r.done?('подходов: '+r.done+' · точность '+acc+'%'):'начни с первого диалога');
  setTxt('l_sumline',r.done?('Пройдено '+r.done+' · точность '+acc+'%'):'Три формата — как на экзамене');
  var bar=document.getElementById('l_bar');if(bar)bar.style.width=Math.max(2,acc)+'%'}
function lStopFallback(){if(L_FALLBACK_FINISH){var finish=L_FALLBACK_FINISH;L_FALLBACK_FINISH=null;finish(false)}try{speechSynthesis.cancel()}catch(e){}}
function lVoice(i){try{var vs=(speechSynthesis.getVoices()||[]).filter(function(v){return /^en[-_]/i.test(v.lang)});
  if(!vs.length)return null;
  var gb=vs.filter(function(v){return /GB/i.test(v.lang)});
  var pool=gb.length>1?gb:vs;
  return pool[i%pool.length]}catch(e){return null}}
function lPlayRawFallback(lines){
  lStopFallback();
  return new Promise(function(resolve){
    function finish(result){if(L_FALLBACK_FINISH===finish)L_FALLBACK_FINISH=null;resolve(Boolean(result))}
    L_FALLBACK_FINISH=finish;
    if(!('speechSynthesis'in window)){try{toast('Озвучка недоступна в этом браузере')}catch(e){}finish(false);return}
    var us=lines.map(function(ln){var u=new SpeechSynthesisUtterance(ln.t);
      u.lang='en-GB';u.rate=LSLOW?0.68:0.85;u.pitch=ln.s?1.15:0.92;
      var v=lVoice(ln.s);if(v)u.voice=v;return u});
    if(!us.length){finish(true);return}
    us[us.length-1].onend=function(){try{lPlayBtn('')}catch(e){}finish(true)};
    us[us.length-1].onerror=function(){try{lPlayBtn('')}catch(e){}finish(false)};
    try{lPlayBtn('play')}catch(e){}
    try{us.forEach(function(u){speechSynthesis.speak(u)})}catch(e){finish(false)}
  })}
var L_PLAYSVG='<svg width="17" height="17" viewBox="0 0 24 24" fill="#fff"><path d="M7 5v14l12-7z"/></svg>';
function lPlayBtn(st){var b=document.getElementById('l_playbtn'),ic=document.getElementById('l_playic'),tx=document.getElementById('l_playtx');
  if(!b||!ic||!tx)return;
  if(st==='load'){b.style.animation='lpulse 1.1s ease-in-out infinite';b.style.pointerEvents='none';
    ic.innerHTML='<span style="display:block;width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;animation:lspin .8s linear infinite;"></span>';
    tx.textContent='Готовлю озвучку…'}
  else if(st==='play'){b.style.animation='';b.style.pointerEvents='';
    ic.innerHTML='<span style="display:flex;align-items:flex-end;gap:2.5px;height:18px;">'
      +[0,1,2,3].map(function(i){return '<span style="width:3.5px;height:18px;border-radius:2px;background:#fff;transform-origin:bottom;animation:leq '+(0.7+i*0.13)+'s ease-in-out infinite;"></span>'}).join('')+'</span>';
    tx.textContent='Играет'}
  else{b.style.animation='';b.style.pointerEvents='';ic.innerHTML=L_PLAYSVG;tx.textContent='Слушать'}}
function lAudioStatus(status){var el=document.getElementById('l_audio_source');if(!el)return;
  if(status==='static'){el.textContent='Готовая экзаменационная запись';el.style.color='#1D7F4A';return}
  if(status==='assisted-slow'){el.textContent='Замедленная тренировочная синтезированная озвучка · с помощью';el.style.color='#A56000';return}
  el.textContent=status==='fallback-error'?'Запись недоступна · тренировочная синтезированная озвучка':'Тренировочная синтезированная озвучка';
  el.style.color='#A56000'}
/* Переключение замедленной озвучки: переменную модуля ни разметка, ни чанк присвоить не могут. */
function lToggleSlow(button){LSLOW=!LSLOW;button.style.background=LSLOW?'#FFEDE4':'#fff';button.style.color=LSLOW?'#C2421B':'#6A6E75'}
function lSetSlow(value){LSLOW=Boolean(value)}
/* FAB прячем, звук глушим при уходе, синк при старте */
registerRouteHook(function(id){lStop();if(id==='scr4'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});
registerStartHook(function(){return lSync()});

/* legacy block 10 */
var W37=[],W38=[];
function applyTaskBank(bank){
  var b=bank||{};
  W37=(b.writing_task_37||[]).map(function(t){return {id:t.id,from:t.from,stim:t.stim,ask:t.ask}});
  W38=(b.writing_task_38||[]).map(function(t){return {id:t.id,topic:t.topic,rows:t.rows}});
  return W37.length+W38.length;
}
function loadTaskBank(){
  return EasyBoostApi.get('/task-bank.json').then(applyTaskBank).catch(function(){return 0});
}
function wrSyncTile(){if(!S)return;var sum=writingModule.summary(S.works);
  if(!sum.count){setTxt('sub_write','задания 37–38 · ИИ');return}
  S.prog=S.prog||{};S.prog.write=sum.average;
  setTxt('sub_write','работ: '+sum.count+' · средний '+sum.average+'%')}
registerStartHook(function(){return wrSyncTile()});

/* legacy block 11 */
/* ===== GLOW: переливающаяся рамка при вводе ===== */
(function(){
  document.addEventListener('focusin',function(e){var t=e.target;if(!t)return;
    if(t.id==='w_editor'){var g=document.getElementById('w_edglow');if(g)g.classList.add('glow-on')}
    if(t.tagName==='INPUT'&&/^(w_inp|g_inp|g_ex_\d+)$/.test(t.id||''))t.classList.add('glow-input')});
  document.addEventListener('focusout',function(e){var t=e.target;if(!t)return;
    if(t.id==='w_editor'){var g=document.getElementById('w_edglow');if(g)g.classList.remove('glow-on')}
    if(t.tagName==='INPUT')t.classList.remove('glow-input')});
})();

/* legacy block 12 */
function spSt(){S.spk=speakingModule.normalizeState(S.spk);return S.spk}
function spSync(){if(!S)return;var sum=speakingModule.summary(S.spkScores,spSt()),tot=sum.trainings;
  S.prog=S.prog||{};S.prog.speak=sum.progress;
  if(sum.rated){
    setTxt('sub_speak','оценок: '+sum.count+' · средний '+sum.average+'%');
    setTxt('s9_sumline','Оценок ИИ: '+sum.count+' · средний '+sum.average+'%');
  }else{
    setTxt('sub_speak',tot?('тренировок: '+tot):'устная часть · запись');
    setTxt('s9_sumline',tot?('Тренировок: '+tot+' · 4 задания'):'Четыре задания — как на экзамене');}
  var bar=document.getElementById('s9_bar');if(bar)bar.style.width=Math.max(2,Math.min(100,S.prog.speak||0))+'%';
  try{setTxt('m_speak',S.prog.speak);ringOff('ring_speak',113.1,S.prog.speak)}catch(e){}}
registerStartHook(function(){return spSync()});

/* ---------- ГРАНИЦА МОДУЛЯ ---------- */
/* Озвучка живёт отдельным модулем и не имеет доступа к состоянию приложения.
   Изменяемое (сессия, замедление) передаётся функциями, иначе tts.js увидит снимок на момент старта. */
configureTts({
  apiGetBlob:apiGetBlob,
  lPlayBtn:lPlayBtn,
  lStopFallback:lStopFallback,
  lPlayRawFallback:lPlayRawFallback,
  wSpeakFallback:wSpeakFallback,
  serverAvailable:function(){return Boolean(SRV&&TOKEN)},
  slow:function(){return LSLOW},
  loadListeningManifest:function(){return EasyBoostApi.get('/audio/listening/listening-pilot-v1/manifest.json')},
  listeningAudioStatus:lAudioStatus
});

/*
 * Имена, которые обязаны быть видны за пределами модуля: их ищут инлайновые обработчики
 * разметки, сгенерированная разметка экранов и e2e-сценарии. Список сверяется автоматически —
 * `npm run check` запускает scripts/check-inline-handlers.js. Раскладывает их по window main.js.
 * Имена экранов сюда не входят: они приезжают со своим чанком и попадают на window тогда же.
 */
export {
  lastWord,lastWordContext,
  closeLearn,learnGo,logout,lToggleSlow,openLearn,pwCheck,rSync,save,startApp,
  tgClick,trWord,
};

/* Зависимости privacy.js и pwa.js, которые раньше находились через глобальную область. */
export {SRV,registerProfileHook,registerStartHook,toast};

/*
 * Оболочка для чанков экранов. Экран не видит глобальной области: всё, чем он пользуется —
 * состояние ученика, сохранение, общие помощники разметки и сводки главного экрана — приходит
 * сюда импортом. Сводки (wSync, gSync, rSync, lSync, wrSyncTile, spSync) живут в оболочке
 * намеренно: плитки главного экрана обязаны показывать настоящие числа сразу после входа,
 * когда ни один чанк ещё не загружен.
 */
export {
  EGE_WORDS,LSLOW,L_PLAYSVG,S,TOKEN,W37,W38,WBTN,
  apiCanUseOfflineFallback,apiGet,apiIsAuthorityFailure,apiMessage,apiPost,apiPostBinary,apiPostIdempotent,apiPut,apiResponseOwner,currentUser,examModule,gExamFmt,gSync,generateAiContent,invalidateLearningAuthority,registerAuthorityReset,
  grammarModule,lSetSlow,lSt,lSync,listeningModule,profileModule,progressModule,readingModule,
  rEsc,rSt,rWordsHtml,registerScreenGenerator,ringOff,runProfileHooks,setTxt,spSt,spSync,
  speakingModule,srsFail,srsOk,srsRecordVocabularyOutcome,syncModuleAttempt,todayStr,ui,wBase,wDeco,wMergeAi,wMigrate,wRec,wStats,wSync,
  verifyLearningAccessForLaunch,wordModule,writingModule,
};
