/* legacy block 1 */

/* ---------- STATE ---------- */
const todayStr=()=>new Date().toISOString().slice(0,10);
let currentUser=localStorage.getItem('eb_current')||null,S=null,DEMO_MODE=false;
const store=window.EasyBoostStore;
const ui=window.EasyBoostComponents;
const txt=ui.elementText;
const makeInteractive=ui.makeInteractive;
const bindText=ui.bindText;
const setTxt=ui.setText;
const setW=ui.setWidth;
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
function getUsers(){try{return JSON.parse(localStorage.getItem('eb_users'))||{}}catch(e){return{}}}
function setUsers(u){localStorage.setItem('eb_users',JSON.stringify(u))}
/* ---------- DATA ---------- */
const WRITE={
 37:{label:'ЗАДАНИЕ 37 · ПИСЬМО ДРУГУ',range:'100–140',min:100,max:140,table:false,
   prompt:'Your friend Sam asks about your hobbies. Answer his 3 questions and ask 3 questions about his guitar lessons.'},
 38:{label:'ЗАДАНИЕ 38 · OPINION ESSAY',range:'200–250',min:200,max:250,table:true,
   prompt:'“Online learning is better than studying at school.” Опиши данные опроса, дай мнение с аргументами, контраргумент и вывод.'}
};

/* ---------- WRITING ---------- */
let curTask=38;
const SEG_ON='flex:1;border:0;font-family:inherit;text-align:center;padding:8px 0;font-weight:700;font-size:13px;color:#B54E2F;background:#fff;border-radius:11px;cursor:pointer;';
const SEG_OFF='flex:1;border:0;font-family:inherit;text-align:center;padding:8px 0;font-weight:700;font-size:13px;color:rgba(255,255,255,.92);background:transparent;cursor:pointer;';
function countWords(){const st=writingModule.wordCountStatus(document.getElementById('w_editor').innerText,curTask);
  const e=document.getElementById('w_count');e.textContent=st.count+' / '+st.range+' слов · '+st.hint;e.style.color=st.ok?'#1D7F4A':(st.state==='over'?'#B94A37':'#6A6E75')}

function renderReview(d){
  const safe=ui.escapeHtml;
  const totals=writingModule.reviewTotals(d);const got=totals.got,mx=totals.max;
  document.getElementById('rv_score').textContent=got;
  document.getElementById('rv_max').textContent='из '+mx;
  document.getElementById('rv_ring').setAttribute('stroke-dashoffset',String(226-226*(mx?got/mx:0)));
  document.getElementById('rv_verdict').textContent=d.verdict||'Готово!';
  document.getElementById('rv_sub').textContent=d.sub||'';
  const cc=document.getElementById('rv_crit');cc.innerHTML='';
  (d.criteria||[]).forEach(c=>{const p=c.max?Math.round(c.got/c.max*100):0;const col=p>=100?'#1F9E5A':p>=60?'#E8A33C':'#E26A56';const tc=p>=100?'#1D7F4A':p>=60?'#A56000':'#B94A37';
    cc.insertAdjacentHTML('beforeend','<div style="display:flex;align-items:center;gap:12px;"><span style="flex:1;font-weight:600;font-size:13px;color:#2B2B2B;">'+safe(c.name)+'</span><div style="width:96px;height:8px;border-radius:5px;background:#F1F1F3;"><div style="width:'+p+'%;height:100%;border-radius:5px;background:'+col+';"></div></div><span style="font-weight:800;font-size:12.5px;color:'+tc+';width:30px;text-align:right;">'+safe(c.got)+'/'+safe(c.max)+'</span></div>')});
  const errs=d.errors||[];document.getElementById('rv_errhdr').textContent='РАЗБОР ОШИБОК · '+errs.length;
  const eb=document.getElementById('rv_err');eb.innerHTML='';
  errs.forEach((e,idx)=>{const warn=e.kind==='warn';
    const icon=warn?'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C77400" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>':'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9503C" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    const body=warn?safe(e.note||''):'<span style="text-decoration:line-through;color:#B94A37;">'+safe(e.wrong||'')+'</span> → <span style="color:#1D7F4A;font-weight:700;">'+safe(e.right||'')+'</span>'+(e.note?'<br>'+safe(e.note):'');
    if(idx)eb.insertAdjacentHTML('beforeend','<div style="height:1px;background:#F4F5F6;margin:13px 0;"></div>');
    eb.insertAdjacentHTML('beforeend','<div style="display:flex;gap:11px;"><span style="width:26px;height:26px;flex:none;border-radius:9px;background:'+(warn?'#FFF4DE':'#FCEEEC')+';display:grid;place-items:center;">'+icon+'</span><div style="flex:1;"><div style="font-weight:700;font-size:13.5px;color:#2B2B2B;">'+safe(e.title||'Ошибка')+'</div><div style="margin-top:4px;font-weight:500;font-size:12.5px;color:#6A6E75;line-height:1.45;">'+body+'</div></div></div>')});
}

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
  bindText('scr11','Выйти',()=>logout());
  bindText('scr14','Повторить',()=>tab('scr8'));bindText('scr14','Учить офлайн',()=>tab('scr2'));
}

/* ---------- AUTH ---------- */
function inputVal(scr,ph){const el=document.querySelector('#'+scr+' input[placeholder*="'+ph+'"]');return el?el.value.trim():''}
document.addEventListener('DOMContentLoaded',()=>{wire();
  currentUser=currentUser||'Аня';localStorage.setItem('eb_current',currentUser);
});
wire();
S=store.loadLocal(currentUser);

/* ===== READING ===== */
const READ_TXT="Many students take a gap year before university. They travel, work or do volunteering. It can be a valuable experience that helps them become more independent and confident.";
let lastWord="";
/* ===== GRAMMAR ===== */
const GRAM_Q=[
 {t:['She ','_____',' already finished her homework.'],o:['have','has','had','is'],a:1,e:'<b>She/he/it</b> — третье лицо, поэтому <b>has</b>.'},
 {t:['I ','_____',' this film before.'],o:['see','saw','have seen','seeing'],a:2,e:'Опыт без времени → <b>have seen</b>.'},
 {t:['They ','_____',' just arrived.'],o:['have','has','did','was'],a:0,e:'<b>They</b> → have; <b>just</b> → Present Perfect.'},
 {t:['','_____',' you ever been to London?'],o:['Did','Have','Was','Are'],a:1,e:'<b>ever</b> + опыт → <b>Have you ever been</b>.'},
 {t:['He ','_____',' not called yet.'],o:['did','has','have','is'],a:1,e:'<b>He</b> → has; <b>yet</b> → Present Perfect.'}
];
let gi=0,gScore=0,gAns=false;
/* patch tab to init reading/grammar */
registerRouteHook(function(id){if(id==='scr7')initReading();if(id==='scr3')initGrammar()});


/* ===== LISTENING ===== */
const LISTEN={dialog:"— Hi, can I get a coffee and a croissant, please?  — Sure, that's four pounds fifty. Anything else?  — No, that's all, thanks.",
  q1:{o:['В кафе','В магазине','В библиотеке'],a:0},q2:{o:['Чай и тост','Кофе и круассан'],a:1}};
registerRouteHook(function(id){if(id==='scr4')initListening();if(id==='scr9')initSpeaking()});


/* ===== ROBUSTNESS + DEMO FALLBACK (overrides) ===== */
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
async function trWord(w){lastWord=w;const pop=document.getElementById('r_pop');
  document.getElementById('r_word').textContent=w;document.getElementById('r_ipa').textContent='';document.getElementById('r_tr').textContent='перевод…';pop.style.display='block';
  try{const d=await generateAiContent('dictionary_lookup',{word:w});
    document.getElementById('r_ipa').textContent=d.ipa||'';document.getElementById('r_tr').textContent=d.tr}
  catch(e){const off=DICT[w];
    if(off){document.getElementById('r_ipa').textContent=off.ipa||'';document.getElementById('r_tr').textContent=off.tr+'  · офлайн-словарь'}
    else{document.getElementById('r_ipa').textContent='';document.getElementById('r_tr').textContent='ИИ офлайн, слова нет в мини-словаре. Включи VPN/ключ.'}}}

function localReview(n,task,msg){return writingModule.localReview(n,task,msg)}


/* ===== DASHBOARD / PROGRESS / PROFILE (real data) ===== */
const RING_IDS={words:'ring_words',gram:'ring_gram',read:'ring_read',listen:'ring_listen',write:'ring_write',speak:'ring_speak'};
const METRIC_IDS={words:'m_words',gram:'m_gram',read:'m_read',listen:'m_listen',write:'m_write',speak:'m_speak'};
const BAR_IDS={words:'pb_words',gram:'pb_gram',read:'pb_read',listen:'pb_listen',speak:'pb_speak'};
function daysLeft(){return progressModule.daysLeft(Date.now())}
function renderHome(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('h_hello',profileModule.greeting(currentUser));
  setTxt('h_days','До ЕГЭ — '+view.daysLeft+' дней · пробник в феврале');
  setTxt('h_ava',profileModule.initial(currentUser||'друг'));
  setTxt('h_min',view.daily.minutes);setTxt('h_pct',view.daily.percent+'%');ringOff('h_ring',263.9,view.daily.percent);
  setTxt('h_streak',progressModule.streakLabel(view.streak,true));
  progressModule.MODULES.forEach(function(name){
    setTxt(METRIC_IDS[name],view.modules[name]);ringOff(RING_IDS[name],113.1,view.modules[name])});
  setTxt('sub_words',progressModule.learnedLabel(view.learned))}
function renderProgress(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('p_streak',progressModule.streakLabel(view.streak));setTxt('p_words',view.learned);
  Object.keys(BAR_IDS).forEach(function(name){setW(BAR_IDS[name],view.modules[name])})}
const PROFILE_HOOKS=[];
function registerProfileHook(hook){PROFILE_HOOKS.push(hook)}
function renderProfile(){const u=profileModule.displayName(currentUser);setTxt('pf_ava',profileModule.initial(u));setTxt('pf_name',u);setTxt('pf_ai','через сервер ✓');PROFILE_HOOKS.forEach(function(hook){try{hook()}catch(e){console.error('Profile hook failed',e)}})}
registerRouteHook(function(id){if(id==='scr1')renderHome();if(id==='scr10')renderProgress();if(id==='scr11')renderProfile()});


/* ===== FIX TABBAR HIT-AREA + LEARN SHEET ===== */
const LEARN_MODS=[
 ['📇','Слова','лексика · карточки','scr2','linear-gradient(135deg,#FFA570,#F2683F)'],
 ['📐','Грамматика','правила + тесты','scr3','linear-gradient(135deg,#6FC2B0,#1F9E5A)'],
 ['📖','Чтение','перевод по клику','scr7','linear-gradient(135deg,#FFC861,#E8730A)'],
 ['🎧','Аудирование','слушай и отвечай','scr4','linear-gradient(135deg,#5FB6C9,#3E93A8)'],
 ['✍️','Письмо','задания 37 / 38 + ИИ','scr8','linear-gradient(135deg,#FF9E8A,#E26A56)'],
 ['🎤','Говорение','таймер + запись','scr9','linear-gradient(135deg,#FFB07A,#F2683F)'],
 ['⏱','Пробный ЕГЭ','вариант на время','scr16','linear-gradient(135deg,#B6BBC2,#8A8F98)'],
 ['🏆','Достижения','бейджи и серии','scr17','linear-gradient(135deg,#FFC861,#F2683F)']
];
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
document.addEventListener('DOMContentLoaded',()=>{buildLearnSheet();wireTabs()});
buildLearnSheet();wireTabs();


/* ===== AI CONTENT GENERATION ===== */
let GQ=GRAM_Q.slice();
let LIS={title:'Диалог 1 · В кафе',dialog:LISTEN.dialog,q1:{q:'1. Где происходит разговор?',o:LISTEN.q1.o.slice(),a:LISTEN.q1.a},q2:{q:'2. Что заказал мужчина?',o:LISTEN.q2.o.slice(),a:LISTEN.q2.a}};
let RTXT=READ_TXT;

/* -- grammar fallback renderer -- */
function renderG(){gAns=false;const q=GQ[gi];
  document.getElementById('g_head').textContent='Грамматика · Вопрос '+(gi+1)+' из '+GQ.length;
  document.getElementById('g_steps').innerHTML=GQ.map((_,i)=>'<div style="flex:1;height:5px;border-radius:3px;background:'+(i<=gi?'#fff':'rgba(255,255,255,.35)')+';"></div>').join('');
  document.getElementById('g_q').innerHTML=q.t[0]+'<span style="display:inline-block;min-width:62px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">_____</span>'+q.t[2];
  const op=document.getElementById('g_opts');op.innerHTML='';
  q.o.forEach((opt,oi)=>{const d=document.createElement('div');d.setAttribute('data-i',oi);
    d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #EDEEF0;border-radius:15px;padding:14px 16px;font-weight:700;font-size:15px;color:#6A6E75;cursor:pointer;');
    d.innerHTML=opt+'<span style="width:22px;height:22px;border-radius:50%;border:2px solid #E1E3E6;"></span>';
    d.onclick=()=>pickG(oi);op.appendChild(d)});
  document.getElementById('g_exp').style.display='none';
  const nx=document.getElementById('g_next');nx.style.opacity='.45';nx.textContent='Дальше'}
function pickG(oi){if(gAns)return;gAns=true;const q=GQ[gi];
  [...document.getElementById('g_opts').children].forEach(d=>{const i=+d.getAttribute('data-i');
    if(i===q.a){d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#EAF7F0;border:1.5px solid #1F9E5A;border-radius:15px;padding:14px 16px;font-weight:800;font-size:15px;color:#1D7F4A;');d.querySelector('span').setAttribute('style','width:24px;height:24px;border-radius:50%;background:#1F9E5A;display:grid;place-items:center;');d.querySelector('span').innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>'}
    else if(i===oi){d.setAttribute('style','display:flex;align-items:center;justify-content:space-between;background:#FCEEEC;border:1.5px solid #E26A56;border-radius:15px;padding:14px 16px;font-weight:700;font-size:15px;color:#B94A37;');d.querySelector('span').setAttribute('style','width:24px;height:24px;border-radius:50%;background:#E26A56;display:grid;place-items:center;');d.querySelector('span').innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'}
    else d.style.opacity='.55'});
  if(oi===q.a)gScore++;
  const ex=document.getElementById('g_exp');ex.style.display='flex';
  ex.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1F9E5A" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><div style="font-weight:600;font-size:12.5px;color:#1F7A47;line-height:1.4;">'+(oi===q.a?'Верно! ':'Правильный ответ: <b>'+q.o[q.a]+'</b>. ')+q.e+'</div>';
  const nx=document.getElementById('g_next');nx.style.opacity='1';nx.textContent=(gi<GQ.length-1?'Дальше':'Завершить')}
function nextG(){if(!gAns)return;if(gi<GQ.length-1){gi++;renderG()}else{alert('Результат: '+gScore+' из '+GQ.length+' 🎯');tab('scr1')}}

/* -- toast + FAB -- */
function parseJSON(s){try{return JSON.parse(s.replace(/```json|```/g,'').trim())}catch(e){const m=s.match(/[\[{][\s\S]*[\]}]/);if(m){try{return JSON.parse(m[0])}catch(e2){}}return null}}
const GEN_STATE_ID='genstate';
function genStateHost(){var el=document.getElementById(GEN_STATE_ID);
  if(!el){el=document.createElement('div');el.id=GEN_STATE_ID;document.body.appendChild(el)}
  return el}
function genState(options){ui.renderState(genStateHost(),options)}
function genStateClear(){genStateHost().innerHTML=''}
async function genForCurrent(){const id=cur();const fab=document.getElementById('genfab');fab.disabled=true;
  genState({kind:'loading',title:'ИИ придумывает задание',description:'Обычно это занимает несколько секунд'});
  try{
    if(id==='scr2')await genWords();
    else if(id==='scr3')await genGrammar();
    else if(id==='scr4')await genListening();
    else if(id==='scr7')await genReading();
    genState({kind:'success',title:'Готово — новое задание',description:'Можно продолжать занятие'});
    setTimeout(genStateClear,2600);
  }catch(e){
    genState({kind:'error',title:'ИИ недоступен',description:apiMessage(e,'ai')+' Встроенное задание осталось на месте.',
      actionLabel:'Повторить',onAction:function(){genStateClear();genForCurrent()}});
  }
  fab.disabled=false}
async function genGrammar(){
  const d=await generateAiContent('grammar_quiz');if(!Array.isArray(d)||!d.length)throw 0;
  GQ=d.filter(x=>x.options&&x.options.length>=2).map(x=>({t:[x.before||'',' _____ ',x.after||''],o:x.options,a:x.answer||0,e:x.explain||''}));
  if(!GQ.length){GQ=GRAM_Q.slice();throw 0}initGrammar()}
async function genListening(){
  const d=await generateAiContent('listening_dialog');if(!d||!d.dialog||!d.q1||!d.q2)throw 0;
  LIS={title:d.title||'Новый диалог',dialog:d.dialog,q1:{q:d.q1.q||'1.',o:d.q1.o,a:d.q1.a||0},q2:{q:d.q2.q||'2.',o:d.q2.o,a:d.q2.a||0}};
  initListening()}
async function genReading(){
  const d=await generateAiContent('reading_text');if(!d||!d.text)throw 0;RTXT=d.text;initReading()}

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
const apiPut=EasyBoostApi.put;
const apiGet=EasyBoostApi.get;
const apiGetBlob=EasyBoostApi.getBlob;
const apiPostBinary=EasyBoostApi.postBinary;
const apiMessage=EasyBoostApi.messageFor;
const fillDefaults=store.normalize;

/* save/load через сервер (или локально) */
let _saveT=null;
const START_HOOKS=[];
function registerStartHook(hook){START_HOOKS.push(hook)}
function save(){
  if(DEMO_MODE)return;
  if(SRV&&!TOKEN)return;
  /* локальный снимок держит слова, SRS, грамматику и прогресс доступными без сети */
  store.saveLocal(currentUser,S);
  if(SRV){clearTimeout(_saveT);_saveT=setTimeout(()=>{store.sync.saveProgress(S)},600)}}
async function startApp(){
  if(DEMO_MODE){tab('scr1');return}
  if(SRV){if(!TOKEN){show('scr5');document.getElementById('tabbar').style.display='none';return}
    var served=null;
    try{served=await apiGet('/api/progress')}catch(e){served=null}
    S=store.restore(currentUser,served,store.sync.pendingModules());
    store.saveLocal(currentUser,S);
    if(!served)try{toast('Нет сети — показан сохранённый прогресс')}catch(e){}}
  else{S=store.loadLocal(currentUser)}
  store.sync.setBaseline(S);
  tab('scr1');
  for(const hook of START_HOOKS){try{await hook()}catch(e){}}
}

/* вход/регистрация */
async function doLogin(){
  if(!SRV){const u=gv('lg_user')||'Аня';currentUser=u;localStorage.setItem('eb_current',currentUser);startApp();return}
  const u=gv('lg_user'),p=gv('lg_pass');if(!u||!p){lgMsg('Введите имя и пароль');return}
  lgMsg('Вход…');
  try{const d=await auth.login(u,p);TOKEN=d.authenticated?'cookie':'';
    currentUser=d.username;localStorage.setItem('eb_current',currentUser);lgMsg('');startApp()}
  catch(e){lgMsg(apiMessage(e,'auth'))}}
async function doRegister(){
  if(!SRV){const u=gv('lg_user')||'Аня';currentUser=u;localStorage.setItem('eb_current',currentUser);show('scr6');document.getElementById('tabbar').style.display='none';return}
  const u=gv('lg_user'),p=gv('lg_pass');if(!u||!p){lgMsg('Введите имя и пароль');return}
  lgMsg('Создаём аккаунт…');
  try{const d=await auth.register(u,p);TOKEN=d.authenticated?'cookie':'';
    currentUser=d.username;localStorage.setItem('eb_current',currentUser);lgMsg('');show('scr6');document.getElementById('tabbar').style.display='none'}
  catch(e){lgMsg(apiMessage(e,'auth'))}}
async function logout(){
  try{if(SRV)await auth.logout()}catch(_){}
  TOKEN='';
  try{localStorage.removeItem('eb_current');localStorage.removeItem('eb_tg_code')}catch(_){}
  location.reload()
}

async function startDemo(){
  DEMO_MODE=true;TOKEN='';currentUser='Демо';S=fillDefaults({demo:true});
  var bar=document.getElementById('tabbar');if(bar)bar.style.display='flex';
  var banner=document.getElementById('demo_banner');
  if(!banner){banner=document.createElement('button');banner.id='demo_banner';banner.type='button';banner.textContent='Демо · войти для сохранения';banner.setAttribute('aria-label','Демонстрационный режим. Войти для сохранения прогресса');banner.setAttribute('style','position:fixed;z-index:9998;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);border:0;border-radius:18px;background:#2B2B2B;color:#fff;padding:8px 14px;font:700 11px Manrope;cursor:pointer;');banner.onclick=function(){location.reload()};document.body.appendChild(banner)}
  tab('scr1');
  for(const hook of START_HOOKS){try{await hook()}catch(e){}}
}

function generateAiContent(operation,payload){if(DEMO_MODE)return Promise.reject(new Error('ИИ недоступен в демо-режиме'));return EasyBoostApi.generateContent(operation,payload)}

/* профиль: в серверном режиме ключ не нужен на клиенте */
registerProfileHook(function(){var ai=document.getElementById('pf_ai');if(ai){ai.textContent='через сервер ✓';ai.style.color='#1D7F4A';ai.style.background='#EAF7F0'}})

/* финальная инициализация под серверный режим */
if(SRV){ if(TOKEN){ startApp(); } else { var tb=document.getElementById('tabbar'); if(tb)tb.style.display='none'; show('scr5'); } }


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
  TG_IV=setInterval(async()=>{tries++;
    try{const c=await auth.checkTelegramLogin(TG_CODE);
      if(c&&c.authenticated){clearInterval(TG_IV);TOKEN='cookie';
        currentUser=c.username;localStorage.setItem('eb_current',currentUser);lgMsg('');startApp();}
    }catch(e){}
    if(tries>300){clearInterval(TG_IV)}
  },2000);
}
// Telegram-код создаётся только после явного действия пользователя.


/* ===== TELEGRAM login: настоящая ссылка (iOS-safe) ===== */
try{clearInterval(TG_IV)}catch(e){}
// Восстановление существующей cookie-сессии выполняется ниже через /api/me.


/* legacy block 2 */
/* ===== ДОСТУП / ПОДПИСКА (paywall) ===== */
function pwHide(){var o=document.getElementById('pw_ov');if(o)o.remove();}
function pwShow(bot){
  if(document.getElementById('pw_ov'))return;
  var ov=document.createElement('div');ov.id='pw_ov';
  ov.setAttribute('style','position:fixed;inset:0;z-index:99999;background:linear-gradient(160deg,#FFA570,#F2683F);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;font-family:Manrope;color:#fff;');
  var burl='https://t.me/'+(bot||'');
  ov.innerHTML=
    '<div style="font-size:46px;margin-bottom:10px;">🎓</div>'+
    '<div style="font-weight:800;font-size:23px;margin-bottom:8px;">Easy Boost</div>'+
    '<div style="font-weight:600;font-size:15px;line-height:1.55;max-width:300px;opacity:.96;margin-bottom:22px;">Чтобы заниматься, оформи доступ в нашем Telegram-боте — бесплатный месяц или подписку. Это займёт минуту.</div>'+
    '<a href="'+burl+'" target="_blank" rel="noopener" style="display:block;width:100%;max-width:300px;box-sizing:border-box;height:54px;line-height:54px;background:#fff;color:#B54E2F;border-radius:16px;font-weight:800;font-size:16px;text-decoration:none;margin-bottom:12px;box-shadow:0 12px 24px rgba(20,20,30,.18);">Открыть Telegram-бот</a>'+
    '<button onclick="pwCheck(true)" style="width:100%;max-width:300px;height:48px;background:rgba(255,255,255,.16);color:#fff;border:1.5px solid rgba(255,255,255,.6);border-radius:14px;font-family:Manrope;font-weight:700;font-size:15px;cursor:pointer;">Я оформил — обновить</button>';
  document.body.appendChild(ov);
}
async function pwCheck(){
  if(typeof SRV==='undefined'||!SRV||!TOKEN){pwHide();return true;}
  try{
    var me=await auth.currentSession();
    if(me&&me.active){pwHide();return true;}
    pwShow(me&&me.bot);
    return false;
  }catch(e){ pwHide(); return true; } // при ошибке сети не блокируем доступ
}
window.checkSub=pwCheck;
registerStartHook(function(){return pwCheck()});
if(typeof SRV!=='undefined'&&SRV&&TOKEN){ setTimeout(function(){try{pwCheck();}catch(e){}},300); }

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
  function saveTok(t,u){if(t||u)TOKEN='cookie';
    if(u){currentUser=u;try{localStorage.setItem('eb_current',u)}catch(_){}}}
  async function me(){try{return await auth.currentSession()}catch(e){return null}}
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
    var m=await me();
    if(m&&m.username){
      var had=!!TOKEN;
      saveTok(m.authenticated,m.username);
      window.__sub=m;
      if(!had){try{localStorage.removeItem('eb_tg_code')}catch(_){};startApp();}
    }
  })();
  /* статус подписки в профиле */
  registerProfileHook(function(){
    if(typeof SRV==='undefined'||!SRV)return;
    var host=document.getElementById('pf_name');if(!host||!host.parentElement)return;
    var el=document.getElementById('pf_sub');
    if(!el){el=document.createElement('div');el.id='pf_sub';
      el.setAttribute('style','display:inline-block;margin-top:6px;font:700 11.5px Manrope,sans-serif;padding:5px 10px;border-radius:20px;');
      host.parentElement.appendChild(el);}
    var use=function(m){var s=profileModule.subscriptionStatus(m,Date.now());el.textContent=s.text;el.style.color=s.color;el.style.background=s.background};
    if(window.__sub)use(window.__sub);
    me().then(function(m){if(m){window.__sub=m;use(m)}});
  });
})();

/* legacy block 5 */
/* ===== WORDS v2: SRS-словарь ЕГЭ ===== */
const W_TOPICS={0:'ИИ-набор',1:'Семья и отношения',2:'Образование',3:'Работа и карьера',4:'Путешествия',5:'Природа и экология',6:'Наука и технологии',7:'Здоровье и спорт',8:'Культура и досуг',9:'Общество и СМИ',10:'Город и покупки'};
const W_POS={n:'СУЩЕСТВИТЕЛЬНОЕ',v:'ГЛАГОЛ',adj:'ПРИЛАГАТЕЛЬНОЕ',adv:'НАРЕЧИЕ',ph:'ФРАЗОВЫЙ ГЛАГОЛ',id:'ВЫРАЖЕНИЕ'};
const EGE_WORDS=[
{w:'relationship',t:1,p:'n',tr:'отношения',ex:'They have a close relationship.'},
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
let WQ=[],WI=0,WDONE=0;
var W_SYNC={},W_SYNC_T=null;
function wQueueServer(w){if(typeof SRV==='undefined'||!SRV||!TOKEN)return;var r=wRec(w);if(!r)return;
  W_SYNC[w]={word:w,stage:r.s||0,errorCount:r.e||0,reviewCount:r.n||0,dueAt:r.due||null};clearTimeout(W_SYNC_T);
  W_SYNC_T=setTimeout(function(){var pending=W_SYNC;W_SYNC={};apiPut('/api/word-progress',{words:Object.keys(pending).map(function(k){return pending[k]})}).catch(function(){Object.keys(pending).forEach(function(k){W_SYNC[k]=pending[k]})})},900)}
function wToday0(){var d=new Date();d.setHours(0,0,0,0);return d.getTime()}
function wRec(w){S.srs=S.srs||{};return S.srs[w]}
function wSet(w){S.srs=S.srs||{};return S.srs[w]||(S.srs[w]={s:0,e:0,n:0,due:0})}
function wBase(w){return wordModule.baseForm(w)}
function srsApply(w,ok){S.srs=S.srs||{};S.srs[w]=EasyBoostLearning.reviewWord(wSet(w),ok);wQueueServer(w)}
function srsOk(w){srsApply(w,true)}
function srsFail(w){srsApply(w,false)}
function wStats(){return wordModule.calculateStats(EGE_WORDS,S.srs)}
function wSync(){var st=wStats();S.learned=st.learned;S.prog=S.prog||{};S.prog.words=EasyBoostLearning.calculateProgress(st.learned,st.total);
  setTxt('w_know_n','Знаю '+st.learned);setTxt('pf_known_n',String(st.learned));setTxt('w_sumline','Выучено '+st.learned+' из '+st.total+' слов');
  var bar=document.getElementById('w_bar');if(bar)bar.style.width=Math.max(2,Math.round(st.learned/st.total*100))+'%';
  setTxt('sub_words','учу · '+st.learned+' / '+st.total)}
function wMigrate(){if(S.srsMig)return;S.srsMig=1;S.srs=wordModule.migrateLegacy(EGE_WORDS,S.box,S.srs||{})}
function initWords(){if(!S)return;wMigrate();wMergeAi();
  if(S.wday!==todayStr()){S.wday=todayStr();S.wnewUsed=0}
  var lim=Math.max(0,(S.wnew||30)-(S.wnewUsed||0));
  WQ=wordModule.buildDailyQueue(EGE_WORDS,S.srs,{newLimit:lim});WI=0;WDONE=0;
  wSync();wRender();wTopUp()}
function wModeFor(w){return wordModule.modeFor(wRec(w))}
function wSpeakFallback(txt){try{var u=new SpeechSynthesisUtterance(txt.replace(/^to /,''));u.lang='en-GB';u.rate=.9;speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}
function wBadge(x){var pos=W_POS[x.p]||x.pos||'СЛОВО';var top=W_TOPICS[x.t]||'';
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
  +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+pos+'</span>'
  +(top?'<span style="font-weight:700;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">'+top+'</span>':'')
  +'<button type="button" class="iconbtn clk" aria-label="Озвучить слово" onclick="wSpeak(WQ[WI]?WQ[WI].w:\'\')" style="cursor:pointer;flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:12px;background:#FFF4DE;">'
  +'<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg></button></div>'}
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
function wAnim(name,dur){ui.animate('w_card',name,dur)}
const WBTN='width:100%;min-height:52px;border:1px solid #F0EAE2;background:#fff;border-radius:18px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;cursor:pointer;padding:13px 14px;text-align:center;box-shadow:0 10px 22px rgba(60,45,30,.07),inset 0 2px 0 rgba(255,255,255,.9);';
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
function wFlip(x){var card=document.getElementById('w_card'),opts=document.getElementById('w_opts');
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
    setTimeout(function(){wFlip(x)},900)}}
function wSubmit(){var x=WQ[WI];if(!x)return;var inp=document.getElementById('w_inp');if(!inp||inp.dataset.done)return;
  var val=(inp.value||'').toLowerCase().trim().replace(/^to /,'');
  var ok=val===wBase(x.w);inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  if(!ok){inp.value=wBase(x.w);srsFail(x.w);WQ.push(x)}else srsOk(x.w);
  WDONE++;if(ok){wSpeak(x.w);wAnim('wpop','.35s')}else wAnim('wshake','.42s');
  setTimeout(ok?wNext:function(){wFlip(x)},ok?650:900)}
function wExtra(){wMergeAi();
  var fresh=EGE_WORDS.filter(function(x){var r=wRec(x.w);return !r||!r.s});
  WQ=fresh.slice(0,30);WI=0;WDONE=0;wRender();
  if(fresh.length<40)wTopUp()}
function wMergeAi(){if(!S||!S.aiWords)return;wordModule.mergeGenerated(EGE_WORDS,S.aiWords)}
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
/* домашняя плитка при загрузке */
try{if(S)wSync()}catch(e){}
registerStartHook(function(){wMigrate();wMergeAi();return wSync()});
registerRouteHook(function(id){if(id==='scr2'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});

/* legacy block 6 */
/* ===== GRAMMAR v2: карта тем ЕГЭ + теория + 2 уровня практики ===== */
const G_GROUPS=[{n:'Времена',ids:[1,2,3,13,4]},{n:'Глагол',ids:[5,6,7,8,9,18]},{n:'Части речи',ids:[10,11,12,16,17,20]},{n:'Служебные слова',ids:[14,15,19]}];
const G_TOPICS={
1:{n:'Present Simple и Continuous',th:'<b>Present Simple</b> — регулярные действия, факты: V / V+s (he, she, it).<br>Маркеры: every day, usually, often, never.<br><b>Present Continuous</b> — действие прямо сейчас: am/is/are + V-ing.<br>Маркеры: now, at the moment, Look!, Listen!<br><b>Ловушка ЕГЭ:</b> глаголы состояния (know, like, want, hear, believe) не используются в Continuous.'},
2:{n:'Past Simple и Continuous',th:'<b>Past Simple</b> — завершённое действие в прошлом: V2 / did + V.<br>Маркеры: yesterday, last week, in 2020, ago.<br><b>Past Continuous</b> — процесс в момент прошлого: was/were + V-ing.<br>Маркеры: while, at 5 pm yesterday, when (фон действия).<br><b>Ловушка:</b> длинное действие — Continuous, короткое ворвавшееся — Simple: I <b>was cooking</b> when he <b>came</b>.'},
3:{n:'Present Perfect и Past Simple',th:'<b>Present Perfect</b> — результат к настоящему: have/has + V3.<br>Маркеры: already, just, yet, ever, never, since, for.<br><b>Past Simple</b> — факт в конкретном прошлом: yesterday, last year, in 2019.<br><b>Правило выбора:</b> есть точное время в прошлом → Past Simple. Важен результат сейчас → Present Perfect.'},
4:{n:'Будущее время',th:'<b>will + V</b> — предсказание, спонтанное решение, обещание.<br><b>be going to</b> — намерение или очевидное будущее (Look at the clouds!).<br><b>Present Continuous</b> — личная договорённость (We are flying on Friday).<br><b>Present Simple</b> — расписания: The train <b>leaves</b> at 6.<br><b>Ловушка:</b> после if/when о будущем — настоящее время!'},
5:{n:'Пассивный залог',th:'<b>Passive</b> = be (в нужном времени) + V3.<br>is/are + V3 — регулярно; was/were + V3 — прошлое;<br>will be + V3 — будущее; is being + V3 — прямо сейчас;<br>has been + V3 — результат.<br><b>Ловушка ЕГЭ:</b> в заданиях 19–24 если подлежащее само не делает действие — это пассив: The bridge <b>was built</b>.'},
6:{n:'Условные предложения',th:'<b>0 тип</b> (факты): If + Present, Present. If you heat ice, it melts.<br><b>1 тип</b> (реально): If + Present, will + V. If it rains, we will stay.<br><b>2 тип</b> (нереально сейчас): If + Past, would + V. If I were you…<br><b>3 тип</b> (нереально в прошлом): If + had V3, would have V3.<br><b>Ловушка:</b> после if НЕ ставим will.'},
7:{n:'Косвенная речь',th:'Сдвиг времён после said/told/asked:<br>Present Simple → Past Simple; Present Perfect / Past Simple → Past Perfect;<br>will → would, can → could, may → might.<br>Вопросы: he asked <b>if</b>… / he asked <b>where I lived</b> (прямой порядок слов!).<br><b>Ловушка:</b> в косвенном вопросе нет do/does/did.'},
8:{n:'Модальные глаголы',th:'<b>must</b> — обязан (сам считаю); <b>have to</b> — вынужден (обстоятельства);<br><b>mustn\'t</b> — запрещено; <b>don\'t have to</b> — не обязательно;<br><b>should</b> — совет; <b>can/could</b> — умение, возможность;<br><b>may/might</b> — разрешение, вероятность.<br><b>Ловушка:</b> после модальных — инфинитив без to (кроме have to, ought to).'},
9:{n:'Инфинитив и герундий',th:'<b>Герундий (V-ing)</b> после: enjoy, avoid, mind, suggest, finish, stop, look forward to, предлогов.<br><b>Инфинитив с to</b> после: want, decide, hope, plan, promise, it is easy…<br><b>Без to</b> после: let, make, модальных.<br><b>Ловушка:</b> stop doing — перестать делать; stop to do — остановиться, чтобы сделать.'},
10:{n:'Степени сравнения',th:'Короткие прилагательные: -er / the -est (big → bigger → the biggest).<br>Длинные: more / the most interesting.<br><b>Исключения:</b> good → better → best; bad → worse → worst; far → further; little → less; many/much → more → most.<br><b>Конструкции:</b> as … as, than.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD в сравнении — это better/best.'},
11:{n:'Местоимения',th:'<b>Притяжательные:</b> my/your/his/her/its/our/their + сущ.; без сущ. — mine, yours, hers, theirs.<br><b>Возвратные:</b> myself, himself, herself, itself, ourselves, themselves.<br><b>some/any:</b> some — утверждение, any — вопрос и отрицание.<br><b>Ловушка:</b> its (его) без апострофа; it\'s = it is.'},
12:{n:'Числительные',th:'<b>Порядковые:</b> the first, second, third, дальше -th: fifth (!), ninth (!), twelfth (!), twentieth.<br>Даты: on the fifth of May.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово TWO/FIVE часто нужно превратить в second/fifth (этаж, место, день рождения).<br>hundreds/thousands <b>of</b> people, но two hundred people.'},
13:{n:"Past Perfect",th:"<b>Past Perfect</b> = had + V3 — действие, которое случилось <b>раньше</b> другого действия в прошлом.<br>Маркеры: by the time, before, after, already (к моменту прошлого).<br>Пример: When we arrived, the film <b>had started</b> — фильм начался ДО нашего прихода.<br><b>Ловушка:</b> если действия идут просто по порядку, Past Perfect не нужен — оба в Past Simple."},
14:{n:"Артикли",th:"<b>a/an</b> — один из многих, впервые упомянутый: I saw <b>a</b> cat.<br><b>the</b> — конкретный, известный или единственный: <b>the</b> sun, the cat from our yard, превосходная степень (the best).<br><b>Без артикля:</b> имена, большинство стран, языки, приёмы пищи (have breakfast), go to school.<br><b>Ловушка:</b> the USA, the UK — c the; play <b>the</b> piano, но play football."},
15:{n:"Предлоги",th:"<b>Время:</b> at 5, at night · on Monday, on the 5th of May · in June, in 2020, in the morning.<br><b>Место:</b> at school, at home · in the room, in Moscow · on the wall.<br><b>Устойчивые:</b> depend <b>on</b>, good <b>at</b>, afraid <b>of</b>, interested <b>in</b>, listen <b>to</b>, wait <b>for</b>.<br><b>Ловушка:</b> in the morning, но at night; on TV, on the Internet."},
16:{n:"Множественное число",th:"Обычно +s/es. <b>Исключения — учи наизусть:</b> man → men, woman → women, child → children, foot → feet, tooth → teeth, mouse → mice, person → people, sheep → sheep.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово CHILD/MAN в скобках почти всегда просит форму множественного числа: children, men. People — уже множественное: people <b>are</b>."},
17:{n:"Прилагательные -ing и -ed",th:"<b>-ing</b> — сам предмет вызывает чувство: The film is <b>boring</b> (фильм скучный).<br><b>-ed</b> — человек испытывает чувство: I am <b>bored</b> (мне скучно).<br>Пары: interesting/interested, exciting/excited, tiring/tired, surprising/surprised.<br><b>Приём:</b> спроси «кто испытывает чувство?» Если человек — ставь -ed."},
18:{n:"Вопросы и порядок слов",th:"Вопрос: <b>вопросительное слово + вспомогательный + подлежащее + глагол</b>: Where <b>does she</b> live?<br>Вопрос к подлежащему — БЕЗ do/does/did: Who <b>broke</b> the window?<br><b>Разделительный вопрос:</b> утверждение + отрицательный хвост: You like tea, <b>don\u0027t you</b>?<br><b>Ловушка:</b> в косвенном вопросе прямой порядок слов: I wonder where she <b>lives</b>."},
19:{n:"Союзы и связки",th:"<b>because</b> + причина · <b>so</b> + следствие · <b>although</b> (хотя) + контраст.<br><b>however</b> — однако (после точки, с запятой).<br><b>despite / in spite of</b> + существительное или V-ing, НЕ предложение!<br><b>Ловушка ЕГЭ:</b> despite the rain (сущ.), но although it rained (целое предложение)."},
20:{n:"Наречия",th:"Наречие = прилагательное + <b>-ly</b>: slow → slowly, easy → easily, happy → happily.<br><b>Исключения:</b> good → <b>well</b>; fast → fast; hard → hard.<br><b>hardly</b> — «почти не», а не «тяжело»: I could hardly hear.<br><b>Ловушка ЕГЭ:</b> в 19–24 слово GOOD после глагола действия превращается в well: sings well."}
};
const G_BANK={
1:{c:[
 {t:['She ',' to school every day.'],o:['go','goes','is going','went'],a:1,e:'every day → Present Simple, she → V+s.'},
 {t:['Look! It ',' .'],o:['rains','is raining','rain','rained'],a:1,e:'Look! → действие сейчас → Continuous.'},
 {t:['Water ',' at 100 degrees.'],o:['boils','is boiling','boil','boiled'],a:0,e:'Факт природы → Present Simple.'},
 {t:['I ',' you well now.'],o:['hear','am hearing','hears','heard'],a:0,e:'hear — глагол состояния, без Continuous.'},
 {t:['He usually ',' up at seven.'],o:['get','gets','is getting','got'],a:1,e:'usually → Simple, he → gets.'}],
f:[
 {s:'My brother _____ (WATCH) TV every evening.',b:'WATCH',ans:['watches'],e:'every evening → Present Simple, 3-е лицо → watches.'},
 {s:'Listen! Somebody _____ (SING).',b:'SING',ans:['is singing'],e:'Listen! → прямо сейчас → is singing.'},
 {s:'She _____ (NOT LIKE) loud music.',b:'NOT LIKE',ans:['does not like','doesnt like'],e:'Отрицание в Present Simple → does not like.'},
 {s:'We _____ (STUDY) English twice a week.',b:'STUDY',ans:['study'],e:'Регулярность → Present Simple, we → study.'},
 {s:'Right now they _____ (PLAY) chess.',b:'PLAY',ans:['are playing'],e:'right now → are playing.'}]},
2:{c:[
 {t:['I ',' him yesterday.'],o:['see','saw','have seen','was seeing'],a:1,e:'yesterday → Past Simple.'},
 {t:['While I ',' dinner, the phone rang.'],o:['cooked','was cooking','cook','am cooking'],a:1,e:'while → процесс → Past Continuous.'},
 {t:['They ',' to Moscow in 2020.'],o:['move','moved','have moved','were moving'],a:1,e:'in 2020 → Past Simple.'},
 {t:['When she came in, he ',' TV.'],o:['watched','was watching','watches','has watched'],a:1,e:'Фоновый процесс → was watching.'},
 {t:['Columbus ',' America in 1492.'],o:['discovers','discovered','has discovered','was discovering'],a:1,e:'Дата в прошлом → Past Simple.'}],
f:[
 {s:'She _____ (BUY) a new dress last week.',b:'BUY',ans:['bought'],e:'last week → Past Simple: buy → bought.'},
 {s:'At 5 pm yesterday we _____ (PLAY) football.',b:'PLAY',ans:['were playing'],e:'Момент-процесс → were playing.'},
 {s:'He _____ (COME) home late last night.',b:'COME',ans:['came'],e:'last night → came.'},
 {s:'While mum _____ (COOK), dad set the table.',b:'COOK',ans:['was cooking'],e:'while → was cooking.'},
 {s:'I _____ (NOT SEE) him at school yesterday.',b:'NOT SEE',ans:['did not see','didnt see'],e:'Отрицание в Past Simple → did not see.'}]},
3:{c:[
 {t:['She ',' already finished her homework.'],o:['have','has','had','is'],a:1,e:'she → has; already → Present Perfect.'},
 {t:['I ',' this film before.'],o:['see','saw','have seen','seeing'],a:2,e:'Опыт без даты → have seen.'},
 {t:['He ',' to London last year.'],o:['has gone','went','goes','has been'],a:1,e:'last year → Past Simple.'},
 {t:['',' you ever been to Paris?'],o:['Did','Have','Was','Are'],a:1,e:'ever → Have you ever been.'},
 {t:['We ',' friends since 2015.'],o:['are','were','have been','had been'],a:2,e:'since → Present Perfect.'}],
f:[
 {s:'I _____ (KNOW) her for ten years.',b:'KNOW',ans:['have known'],e:'for + период до сейчас → have known.'},
 {s:'They _____ (JUST ARRIVE) — meet them!',b:'JUST ARRIVE',ans:['have just arrived'],e:'just → have just arrived.'},
 {s:'She _____ (VISIT) Rome in 2019.',b:'VISIT',ans:['visited'],e:'in 2019 → visited.'},
 {s:'He _____ (NOT FINISH) the report yet.',b:'NOT FINISH',ans:['has not finished','hasnt finished'],e:'yet → Present Perfect: has not finished.'},
 {s:'We _____ (BE) here since morning.',b:'BE',ans:['have been'],e:'since → have been.'}]},
4:{c:[
 {t:['I think it ',' tomorrow.'],o:['rains','will rain','is raining','rained'],a:1,e:'Предсказание с I think → will.'},
 {t:['Look at the clouds! It ',' .'],o:['will rain','is going to rain','rains','rained'],a:1,e:'Очевидно по признакам → be going to.'},
 {t:['The train ',' at 6:30.'],o:['leaves','will leave','is leaving','left'],a:0,e:'Расписание → Present Simple.'},
 {t:['We ',' to the cinema tonight — I have the tickets.'],o:['go','are going','will go','went'],a:1,e:'Договорённость → Present Continuous.'},
 {t:['I promise I ',' you.'],o:['help','am helping','will help','helped'],a:2,e:'Обещание → will.'}],
f:[
 {s:'I am sure she _____ (COME) tomorrow.',b:'COME',ans:['will come'],e:'Уверенность о будущем → will come.'},
 {s:'I hope he _____ (WIN) the match.',b:'WIN',ans:['will win'],e:'hope → will win.'},
 {s:'The lesson _____ (START) at nine on Mondays.',b:'START',ans:['starts'],e:'Расписание → starts.'},
 {s:'Wait, I _____ (HELP) you with the bags.',b:'HELP',ans:['will help'],e:'Спонтанное решение → will help.'},
 {s:'We will go out when the rain _____ (STOP).',b:'STOP',ans:['stops'],e:'После when о будущем — Present Simple.'}]},
5:{c:[
 {t:['This book ',' in 1997.'],o:['wrote','was written','is written','has written'],a:1,e:'Книга не сама пишет → пассив прошлого.'},
 {t:['Letters ',' every day.'],o:['deliver','are delivered','delivered','are delivering'],a:1,e:'Регулярный пассив → are delivered.'},
 {t:['The new school ',' next year.'],o:['will build','will be built','is built','builds'],a:1,e:'Будущий пассив → will be built.'},
 {t:['English ',' all over the world.'],o:['speaks','is spoken','spoke','is speaking'],a:1,e:'Пассив: is spoken.'},
 {t:['The room ',' right now.'],o:['is cleaned','is being cleaned','cleans','was cleaned'],a:1,e:'Процесс сейчас в пассиве → is being cleaned.'}],
f:[
 {s:'The bridge _____ (BUILD) in 1932.',b:'BUILD',ans:['was built'],e:'Пассив прошлого → was built.'},
 {s:'Rice _____ (GROW) in China.',b:'GROW',ans:['is grown'],e:'Факт-пассив → is grown.'},
 {s:'The letter _____ (SEND) tomorrow.',b:'SEND',ans:['will be sent'],e:'Будущее в пассиве → will be sent.'},
 {s:'This song _____ (WRITE) by The Beatles.',b:'WRITE',ans:['was written'],e:'by → пассив: was written.'},
 {s:'Dinner _____ (COOK) at the moment.',b:'COOK',ans:['is being cooked'],e:'at the moment + пассив → is being cooked.'}]},
6:{c:[
 {t:['If it rains, we ',' at home.'],o:['stay','will stay','would stay','stayed'],a:1,e:'1 тип: If + Present, will.'},
 {t:['If I ',' you, I would apologise.'],o:['am','was','were','be'],a:2,e:'2 тип: If I were you.'},
 {t:['She would come if you ',' her.'],o:['invite','invited','will invite','had invited'],a:1,e:'2 тип: If + Past Simple.'},
 {t:['If you heat ice, it ',' .'],o:['melts','will melt','would melt','melted'],a:0,e:'0 тип — факт: Present + Present.'},
 {t:['If I had known, I ',' you.'],o:['would tell','told','would have told','will tell'],a:2,e:'3 тип: would have + V3.'}],
f:[
 {s:'If he _____ (HAVE) time, he will call you.',b:'HAVE',ans:['has'],e:'1 тип: после if — Present Simple.'},
 {s:'If I _____ (BE) you, I would wait.',b:'BE',ans:['were'],e:'2 тип: were для всех лиц.'},
 {s:'We will go out if the rain _____ (STOP).',b:'STOP',ans:['stops'],e:'После if НЕ будет will → stops.'},
 {s:'If she studied harder, she _____ (PASS) her exams.',b:'PASS',ans:['would pass'],e:'2 тип: would + V.'},
 {s:'If they _____ (LEAVE) earlier, they would have caught the train.',b:'LEAVE',ans:['had left'],e:'3 тип: If + had V3.'}]},
7:{c:[
 {t:['He said he ',' busy.'],o:['is','was','were','be'],a:1,e:'Косвенная речь: сказал, что занят СЕЙЧАС для того момента — is сдвигается в was.'},
 {t:['She said she ',' come the next day.'],o:['will','would','can','shall'],a:1,e:'Косвенная речь: will всегда сдвигается в would.'},
 {t:['Tom asked where I ',' .'],o:['live','lived','do live','living'],a:1,e:'Косвенный вопрос: прямой порядок, сдвиг → lived.'},
 {t:['Mum said she ',' the film before.'],o:['saw','has seen','had seen','sees'],a:2,e:'Она видела фильм ЕЩЁ РАНЬШЕ этого разговора — действие до прошлого → Past Perfect: had seen.'},
 {t:['He asked if I ',' help.'],o:['need','needed','will need','am needing'],a:1,e:'Косвенный вопрос: время сдвигается назад (need → needed), порядок слов прямой.'}],
f:[
 {s:'She said she _____ (LIVE) in Kazan.',b:'LIVE',ans:['lived'],e:'Косвенная речь: живёт (lives) → жила для того момента (lived).'},
 {s:'He told me he _____ (CALL) later.',b:'CALL',ans:['would call'],e:'Косвенная речь: will call → would call (обещание, переданное позже).'},
 {s:'They said they _____ (FINISH) the project already.',b:'FINISH',ans:['had finished'],e:'Закончили ЕЩЁ ДО того, как сказали → Past Perfect: had finished.'},
 {s:'He asked what time it _____ (BE).',b:'BE',ans:['was'],e:'Косвенный вопрос → was.'},
 {s:'She said she _____ (CAN) not come.',b:'CAN',ans:['could'],e:'can → could.'}]},
8:{c:[
 {t:['You ',' wear a helmet — it is the law.'],o:['can','must','may','might'],a:1,e:'Обязанность → must.'},
 {t:['You ',' smoke here — it is forbidden.'],o:['must not','do not have to','may','need'],a:0,e:'Запрет → must not.'},
 {t:['',' I open the window, please?'],o:['Must','May','Should','Have'],a:1,e:'Просьба о разрешении → May I…'},
 {t:['He ',' swim when he was five.'],o:['can','could','may','must'],a:1,e:'Умение в прошлом → could.'},
 {t:['You look tired — you ',' rest.'],o:['must not','should','may not','could not'],a:1,e:'Совет → should.'}],
c2:[
 {t:['You ',' pay — the museum is free today.'],o:['must not','do not have to','can not','should'],a:1,e:'Нет необходимости → do not have to (must not = запрет!).'},
 {t:['She ',' be at home — the lights are on.'],o:['must','has to','should','need'],a:0,e:'Логический вывод → must be.'},
 {t:['I ',' get up early yesterday.'],o:['must','had to','should','may'],a:1,e:'Вынужденность в прошлом → had to.'},
 {t:['',' you help me with this bag?'],o:['Must','Could','Should','May'],a:1,e:'Вежливая просьба → Could you…'},
 {t:['It ',' rain later — take an umbrella.'],o:['must','might','has to','should'],a:1,e:'Вероятность → might.'}]},
9:{c:[
 {t:['I enjoy ',' detective stories.'],o:['read','to read','reading','reads'],a:2,e:'enjoy + V-ing.'},
 {t:['She wants ',' a doctor.'],o:['become','becoming','to become','becomes'],a:2,e:'want + to V.'},
 {t:['He stopped ',' last year — good for him!'],o:['smoke','smoking','to smoke','smoked'],a:1,e:'stop doing = бросить.'},
 {t:['Let me ',' you.'],o:['help','to help','helping','helped'],a:0,e:'let + инфинитив без to.'},
 {t:['It is easy ',' mistakes.'],o:['make','making','to make','made'],a:2,e:'It is easy + to V.'}],
f:[
 {s:'Avoid _____ (MAKE) noise after ten.',b:'MAKE',ans:['making'],e:'avoid + V-ing.'},
 {s:'They decided _____ (STAY) at home.',b:'STAY',ans:['to stay'],e:'decide + to V.'},
 {s:'I look forward to _____ (SEE) you.',b:'SEE',ans:['seeing'],e:'look forward to + V-ing.'},
 {s:'He made me _____ (LAUGH).',b:'LAUGH',ans:['laugh'],e:'make + инфинитив без to.'},
 {s:'She suggested _____ (GO) for a walk.',b:'GO',ans:['going'],e:'suggest + V-ing.'}]},
10:{c:[
 {t:['This task is ',' than that one.'],o:['easy','easier','the easiest','more easy'],a:1,e:'Сравнение коротких: -er + than.'},
 {t:['It is the ',' film I have ever seen.'],o:['good','better','best','goodest'],a:2,e:'good → better → the best.'},
 {t:['My car is ',' expensive than yours.'],o:['more','most','much','many'],a:0,e:'Длинное прилагательное → more + adj.'},
 {t:['The weather is getting ',' .'],o:['bad','worse','the worst','badly'],a:1,e:'bad → worse.'},
 {t:['He is as ',' as his brother.'],o:['tall','taller','the tallest','more tall'],a:0,e:'as + положительная степень + as.'}],
f:[
 {s:'February is the _____ (SHORT) month of the year.',b:'SHORT',ans:['shortest'],e:'Превосходная: the shortest.'},
 {s:'This road is _____ (BAD) than ours.',b:'BAD',ans:['worse'],e:'bad → worse.'},
 {s:'It was the _____ (INTERESTING) trip in my life.',b:'INTERESTING',ans:['most interesting'],e:'Длинное → the most interesting.'},
 {s:'Winters here are _____ (COLD) than at home.',b:'COLD',ans:['colder'],e:'Короткое → colder.'},
 {s:'She sings much _____ (GOOD) than me.',b:'GOOD',ans:['better'],e:'good → better.'}]},
11:{c:[
 {t:['This is ',' book, not yours.'],o:['my','mine','me','myself'],a:0,e:'Перед сущ. → my.'},
 {t:['The red bag is ',' .'],o:['her','hers','she','herself'],a:1,e:'Без сущ. → hers.'},
 {t:['I fixed the bike ',' .'],o:['me','my','myself','mine'],a:2,e:'Сам → myself.'},
 {t:['There is ',' milk in the fridge.'],o:['some','any','no one','every'],a:0,e:'Утверждение → some.'},
 {t:['Is there ',' juice left?'],o:['some','any','none','a'],a:1,e:'Вопрос → any.'}],
f:[
 {s:'Look at _____ (SHE) new dress!',b:'SHE',ans:['her'],e:'Перед сущ. → her.'},
 {s:'These toys are _____ (THEY).',b:'THEY',ans:['theirs'],e:'Без сущ. → theirs.'},
 {s:'We enjoyed _____ (WE) at the party.',b:'WE',ans:['ourselves'],e:'enjoy oneself → ourselves.'},
 {s:'The cat licked _____ (IT) paw.',b:'IT',ans:['its'],e:'Притяжательное its — без апострофа.'},
 {s:'He cut _____ (HE) while cooking.',b:'HE',ans:['himself'],e:'Возвратное → himself.'}]},
12:{c:[
 {t:['My birthday is on the ',' of May.'],o:['five','fifth','fifty','fiveth'],a:1,e:'Дата → порядковое: the fifth.'},
 {t:['There are ',' months in a year.'],o:['twelve','twelfth','twelves','twelfths'],a:0,e:'Количество → twelve.'},
 {t:['He came ',' in the race.'],o:['first','one','once','firstly'],a:0,e:'Место в гонке → first.'},
 {t:['Open your books at page ',' .'],o:['three','third','thirds','thirdly'],a:0,e:'После сущ. (page 3) → количественное.'},
 {t:['',' of people visited the fair.'],o:['Hundred','Hundreds','The hundred','Hundredth'],a:1,e:'Hundreds of people (неточное число).'}],
f:[
 {s:'Today is her _____ (TWELVE) birthday.',b:'TWELVE',ans:['twelfth'],e:'12th → twelfth (без e!).'},
 {s:'He finished _____ (TWO) in the marathon.',b:'TWO',ans:['second'],e:'Место → second.'},
 {s:'It is my _____ (ONE) visit to Moscow.',b:'ONE',ans:['first'],e:'one → first.'},
 {s:'The _____ (FIVE) lesson starts at one o\'clock.',b:'FIVE',ans:['fifth'],e:'five → fifth (f!).'},
 {s:'Our office is on the _____ (TWENTY) floor.',b:'TWENTY',ans:['twentieth'],e:'twenty → twentieth.'}]},
13:{c:[
 {t:["When I came, they "," already left."],o:["have","had","has","were"],a:1,e:"Они ушли ДО того, как я пришёл — действие раньше прошлого → had left."},
 {t:["By the time the bus arrived, we "," for an hour."],o:["waited","had waited","have waited","wait"],a:1,e:"by the time → ждали ДО прибытия → Past Perfect: had waited."},
 {t:["She was sad because she "," her keys."],o:["lost","had lost","has lost","loses"],a:1,e:"Сначала потеряла ключи, ПОТОМ грустила → более раннее действие → had lost."},
 {t:["After he "," dinner, he watched TV."],o:["had cooked","has cooked","cooks","is cooking"],a:0,e:"after + действие, которое было первым → had cooked."},
 {t:["I "," never seen the sea before that trip."],o:["have","had","was","did"],a:1,e:"Опыт ДО момента в прошлом (before that trip) → had never seen."}],
f:[
 {s:"When we got to the station, the train _____ (ALREADY LEAVE).",b:"ALREADY LEAVE",ans:["had already left"],e:"Поезд ушёл ДО нашего прихода → had already left."},
 {s:"He was tired because he _____ (NOT SLEEP) all night.",b:"NOT SLEEP",ans:["had not slept","hadnt slept"],e:"Не спал ДО того, как устал → had not slept."},
 {s:"By 2020 they _____ (BUILD) the new bridge.",b:"BUILD",ans:["had built"],e:"by 2020 — к моменту в прошлом → had built."},
 {s:"After I _____ (FINISH) my homework, I went out.",b:"FINISH",ans:["had finished"],e:"after + первое из двух действий → had finished."},
 {s:"She realised she _____ (FORGET) her password.",b:"FORGET",ans:["had forgotten"],e:"Забыла РАНЬШЕ, чем поняла → had forgotten."}]},
14:{c:[
 {t:["I have "," idea!"],o:["a","an","the","—"],a:1,e:"idea начинается с гласного звука → an idea."},
 {t:[""," sun rises in the east."],o:["A","An","The","—"],a:2,e:"Солнце единственное в своём роде → the sun."},
 {t:["She plays "," piano very well."],o:["a","an","the","—"],a:2,e:"Музыкальные инструменты → play the piano."},
 {t:["We usually have "," breakfast at eight."],o:["a","an","the","—"],a:3,e:"Приёмы пищи без артикля: have breakfast."},
 {t:["He lives in "," USA."],o:["a","an","the","—"],a:2,e:"Страны из нескольких слов → the USA."}],
c2:[
 {t:["It was "," best day of my life."],o:["a","an","the","—"],a:2,e:"Превосходная степень всегда с the: the best."},
 {t:["My dad is "," engineer."],o:["a","an","the","—"],a:1,e:"Профессия — с a/an; engineer начинается с гласного → an."},
 {t:["We went to "," cinema last night."],o:["a","an","the","—"],a:2,e:"go to the cinema — устойчиво с the."},
 {t:[""," children learn languages faster than adults."],o:["A","An","The","—"],a:3,e:"Обобщение во множественном числе — без артикля."},
 {t:["Pass me "," salt, please."],o:["a","an","the","—"],a:2,e:"Конкретная соль на этом столе → the salt."}]},
15:{c:[
 {t:["The lesson starts "," nine."],o:["at","on","in","to"],a:0,e:"Точное время → at nine."},
 {t:["My birthday is "," June."],o:["at","on","in","of"],a:2,e:"Месяц → in June."},
 {t:["We met "," Monday."],o:["at","on","in","by"],a:1,e:"День недели → on Monday."},
 {t:["She is good "," maths."],o:["in","at","on","of"],a:1,e:"Устойчиво: good at."},
 {t:["It depends "," the weather."],o:["of","from","on","at"],a:2,e:"Устойчиво: depend on (не from!)."}],
c2:[
 {t:["I am interested "," history."],o:["at","in","on","of"],a:1,e:"interested in."},
 {t:["Do not be afraid "," mistakes."],o:["of","at","from","by"],a:0,e:"afraid of."},
 {t:["We waited "," the bus for ages."],o:["at","on","for","to"],a:2,e:"wait for."},
 {t:["He listens "," music every day."],o:["at","to","on","for"],a:1,e:"listen to."},
 {t:["I read about it "," the Internet."],o:["in","at","on","by"],a:2,e:"on the Internet, on TV."}]},
16:{c:[
 {t:["There are five "," in the room."],o:["mans","men","man","mens"],a:1,e:"man → men (без s!)."},
 {t:["The "," are playing outside."],o:["childs","children","child","childrens"],a:1,e:"child → children."},
 {t:["My "," hurt after the long walk."],o:["foots","feet","foot","feets"],a:1,e:"foot → feet."},
 {t:["Some "," think differently."],o:["persons","people","peoples","person"],a:1,e:"person → people."},
 {t:["A few "," are grazing in the field."],o:["sheeps","sheep","shep","sheepes"],a:1,e:"sheep не меняется: one sheep — two sheep."}],
f:[
 {s:"Three _____ (WOMAN) were waiting at the door.",b:"WOMAN",ans:["women"],e:"woman → women."},
 {s:"All the _____ (CHILD) love this game.",b:"CHILD",ans:["children"],e:"child → children."},
 {s:"My _____ (TOOTH) hurt after too many sweets.",b:"TOOTH",ans:["teeth"],e:"tooth → teeth."},
 {s:"Hundreds of _____ (PERSON) came to the concert.",b:"PERSON",ans:["people"],e:"person → people."},
 {s:"Two white _____ (MOUSE) live in the cage.",b:"MOUSE",ans:["mice"],e:"mouse → mice."}]},
17:{c:[
 {t:["The journey was long and very "," ."],o:["tired","tiring","tire","tiredly"],a:1,e:"Поездка сама утомляет → tiring."},
 {t:["I am "," in space and planets."],o:["interesting","interested","interest","interestly"],a:1,e:"Человек испытывает интерес → interested."},
 {t:["The news was really "," ."],o:["surprised","surprising","surprise","surprisingly"],a:1,e:"Новость вызывает удивление → surprising."},
 {t:["We were "," by the result."],o:["amazing","amazed","amaze","amazedly"],a:1,e:"Мы испытали чувство → amazed."},
 {t:["This game is so "," !"],o:["excited","exciting","excite","excitedly"],a:1,e:"Игра вызывает восторг → exciting."}],
f:[
 {s:"The lecture was really _____ (BORE).",b:"BORE",ans:["boring"],e:"Лекция сама наводит скуку → boring."},
 {s:"She was _____ (EXCITE) about the trip.",b:"EXCITE",ans:["excited"],e:"Она испытывает чувство → excited."},
 {s:"His answer was quite _____ (SURPRISE).",b:"SURPRISE",ans:["surprising"],e:"Ответ вызывает удивление → surprising."},
 {s:"I feel _____ (TIRE) after training.",b:"TIRE",ans:["tired"],e:"Я испытываю усталость → tired."},
 {s:"The book is very _____ (INTEREST).",b:"INTEREST",ans:["interesting"],e:"Книга вызывает интерес → interesting."}]},
18:{c:[
 {t:["Where "," your brother work?"],o:["does","is","do","did"],a:0,e:"He/she → вспомогательный does: Where does he work?"},
 {t:["Who "," the window yesterday?"],o:["broke","did break","breaks","break"],a:0,e:"Вопрос к подлежащему (КТО разбил?) — без did: Who broke…"},
 {t:["You are coming with us, "," ?"],o:["are you","aren\u0027t you","do you","isn\u0027t it"],a:1,e:"Утверждение с are → хвост aren\u0027t you?"},
 {t:["She speaks French, "," ?"],o:["does she","doesn\u0027t she","isn\u0027t she","hasn\u0027t she"],a:1,e:"speaks (Present Simple) → doesn\u0027t she?"},
 {t:["I wonder where he "," ."],o:["lives","does live","live","is live"],a:0,e:"Косвенный вопрос — прямой порядок слов: where he lives."}],
c2:[
 {t:[""," you ever tried sushi?"],o:["Did","Have","Do","Was"],a:1,e:"ever + опыт → Have you ever tried…"},
 {t:["He can swim, "," ?"],o:["can he","can\u0027t he","does he","isn\u0027t he"],a:1,e:"can → хвост can\u0027t he?"},
 {t:["Tell me what time it "," ."],o:["is","does","be","was being"],a:0,e:"Косвенный вопрос: what time it is (без do)."},
 {t:[""," did you get home? — Late at night."],o:["When","Where","Who","Which"],a:0,e:"Ответ про время → When."},
 {t:["They went home early, "," ?"],o:["did they","didn\u0027t they","do they","weren\u0027t they"],a:1,e:"went → didn\u0027t they?"}]},
19:{c:[
 {t:["We stayed at home "," it was raining."],o:["so","because","despite","however"],a:1,e:"Причина → because."},
 {t:["We went for a walk "," the cold."],o:["although","because","despite","so"],a:2,e:"Дальше существительное (the cold) → despite."},
 {t:[""," he was tired, he kept working."],o:["Despite","Although","So","Because"],a:1,e:"Дальше целое предложение → Although."},
 {t:["She was ill, "," she came to school."],o:["so","because","but","despite"],a:2,e:"Контраст двух фактов → but."},
 {t:["I overslept, "," I was late."],o:["because","so","although","despite"],a:1,e:"Следствие → so (проспал, ПОЭТОМУ опоздал)."}],
c2:[
 {t:[""," the traffic, we arrived on time."],o:["Although","Despite","Because","However"],a:1,e:"Дальше существительное → Despite the traffic."},
 {t:["He passed the exam "," he had hardly studied."],o:["despite","although","so","because of"],a:1,e:"Дальше предложение → although."},
 {t:["The film was long. "," , it was great."],o:["Despite","However","Although","Because"],a:1,e:"Новое предложение + запятая → However."},
 {t:["Take an umbrella "," it rains."],o:["in case","despite","so","although"],a:0,e:"На случай, если пойдёт дождь → in case."},
 {t:["I like tea "," my brother prefers coffee."],o:["while","despite","so","because"],a:0,e:"Сопоставление двух фактов → while."}]},
20:{c:[
 {t:["She sings very "," ."],o:["good","well","goodly","best"],a:1,e:"После глагола действия — наречие: good → well."},
 {t:["He drives too "," ."],o:["fast","fastly","fastest","fasten"],a:0,e:"fast — исключение: наречие тоже fast."},
 {t:["Speak "," , please."],o:["slow","slowly","slowest","slowness"],a:1,e:"Как говорить? → наречие slowly."},
 {t:["I could "," hear him."],o:["hard","hardly","harder","hardness"],a:1,e:"hardly = почти не. I could hardly hear — почти не слышал."},
 {t:["They worked "," all day."],o:["hard","hardly","hardful","hardy"],a:0,e:"hard = усердно (hardly — ловушка, «почти не»)."}],
f:[
 {s:"She smiled _____ (HAPPY).",b:"HAPPY",ans:["happily"],e:"happy → happily (y → ily)."},
 {s:"He answered all the questions _____ (CORRECT).",b:"CORRECT",ans:["correctly"],e:"Как ответил? → correctly."},
 {s:"Please listen _____ (CAREFUL).",b:"CAREFUL",ans:["carefully"],e:"careful → carefully (две l)."},
 {s:"My granny cooks really _____ (GOOD).",b:"GOOD",ans:["well"],e:"good → well (исключение!)."},
 {s:"It was raining _____ (HEAVY).",b:"HEAVY",ans:["heavily"],e:"heavy → heavily."}]}
};
const G_RINT=[7,16,35];
/* --- состояние: S.gram = {tid:{st,ok,err,sr,rs,due}} --- */
let GS=null;
function gRec(t){S.gram=S.gram||{};return S.gram[t]||(S.gram[t]={st:0,ok:0,err:0,sr:0})}
function gClosed(){return grammarModule.countClosed(S.gram)}
function gSync(){if(!S)return;var c=gClosed();S.prog=S.prog||{};S.prog.gram=Math.round(c/20*100);
  setTxt('sub_gram','закреплено '+c+' из 20 тем');setTxt('g_sumline','Закреплено '+c+' из 20 тем');
  var bar=document.getElementById('g_bar');if(bar)bar.style.width=Math.max(2,Math.round(c/20*100))+'%'}
function gAnim(name,dur){ui.animate('g_card',name,dur)}
function gStatusChip(st,isDue){
  if(st===2&&isDue)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ПОРА ПОВТОРИТЬ</span>';
  if(st===2)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАКРЕПЛЕНА</span>';
  if(st===1)return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ИЗУЧАЕТСЯ</span>';
  return '<span style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">НЕ НАЧАТА</span>'}
function initGrammar(){if(!S)return;gSync();gMap()}
function gMap(){var area=document.getElementById('g_area');if(!area)return;
  var due=gDue();
  var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.05)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var h='';
  var e19=S.exam19||{};
  h+='<button type="button" class="sq clk cardbtn" onclick="gExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'<path class="eb5sp" style="animation-delay:2.3s" d="M120,20 Q120,23 123,23 Q120,23 120,26 Q120,23 117,23 Q120,23 120,20 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 19–24</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(e19.n?('лучший результат: '+e19.best+' из 6'):'текст с пропусками, без подсказок')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  if(due.length)h+='<button type="button" class="sq clk cardbtn" onclick="gReview()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:14px;cursor:pointer;background:linear-gradient(135deg,#FFA570,#F2683F);box-shadow:0 14px 28px rgba(242,104,63,.32),inset 0 2px 4px rgba(255,255,255,.45),inset 0 -6px 14px rgba(190,55,18,.25);">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Пора повторить</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.85);margin-top:2px;">'+due.length+' '+(due.length===1?'тема ждёт':(due.length<5?'темы ждут':'тем ждут'))+' проверки памяти</div></div>'
    +'<span style="flex:none;background:rgba(255,255,255,.96);border-radius:14px;padding:9px 14px;font-weight:800;font-size:12.5px;color:#C2421B;">Начать</span></div></button>';
  G_GROUPS.forEach(function(gr){
    h+='<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:12px;letter-spacing:1.8px;color:#6F695E;margin:6px 2px 10px;">'+gr.n.toUpperCase()+'</div>';
    gr.ids.forEach(function(t){var r=gRec(t),tp=G_TOPICS[t];
      var isDue=r.st===2&&r.due&&r.due<=Date.now();
      var pct=r.st===2?100:Math.min(99,Math.round(r.sr/4*100));
      h+='<button type="button" class="clayCard sq clk cardbtn" onclick="gOpen('+t+')" style="'+ga()+'padding:14px 16px;margin-bottom:11px;cursor:pointer;">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
        +'<div style="font-weight:800;font-size:14.5px;color:#2B2B2B;">'+tp.n+'</div>'+gStatusChip(r.st,isDue)+'</div>'
        +'<div style="margin-top:10px;height:6px;border-radius:4px;background:#F1EDE7;"><div style="width:'+pct+'%;height:100%;border-radius:4px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'
        +(r.ok+r.err>0?'<div style="margin-top:7px;font-weight:600;font-size:11px;color:#777163;">верно '+r.ok+' · ошибок '+r.err+'</div>':'')
        +'</button>'});
  });
  area.innerHTML=h;setTxt('g_today','20 тем'+(due.length?' · '+due.length+' на повторение':''))}
function gOpen(t){gTheory(t,true)}
function gTheory(t,fromMap){var area=document.getElementById('g_area');if(!area)return;var tp=G_TOPICS[t];
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'
    +wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ПРАВИЛО</span>'
    +gStatusChip(gRec(t).st)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">'+tp.n+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:10px;">'+tp.th+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="'+(fromMap?('gStart('+t+')'):'gResume()')+'">'+(fromMap?'Начать практику':'Продолжить практику')+'</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">← К темам</button></div>';
  gAnim('win','.32s')}
function gShuffle(a){return grammarModule.shuffled(a)}
function gBankEff(t){var b=G_BANK[t]||{};var ai=(S&&S.gramAi&&S.gramAi[t])||[];
  return grammarModule.effectiveBank(b,ai)}
function gLvl2(t){return grammarModule.levelTwo(gBankEff(t),t)}
function gDue(){return grammarModule.dueTopics(S.gram)}
function gStart(t){var e=gBankEff(t),r=gRec(t);
  var queue=grammarModule.buildTopicQueue(e,t,r);
  GS={t:t,queue:queue,i:0,ok:0,done:0};
  gRenderQ();gGen(t)}
function gResume(){if(GS)gRenderQ();else gMap()}
function gReview(){var due=gDue();if(!due.length){gMap();return}
  var items=[];
  due.forEach(function(t){items=items.concat(gShuffle(gLvl2(t)).slice(0,2))});
  GS={mode:'rev',revT:due.slice(),queue:gShuffle(items),i:0,ok:0,done:0,errT:{}};
  gRenderQ()}
function gProgressLine(){setTxt('g_today',(GS.done)+' / '+GS.queue.length+' в подходе')}
function gRenderQ(){var area=document.getElementById('g_area');if(!area||!GS)return;gProgressLine();
  var it=GS.queue[GS.i];
  if(!it){gFinish();return}
  var t=it.t||GS.t,tp=G_TOPICS[t];
  var head='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+(GS.mode==='rev'?'ПОВТОРЕНИЕ':(it.k==='c'?'УРОВЕНЬ 1 · ВЫБОР':'УРОВЕНЬ 2 · КАК НА ЕГЭ'))+'</span>'
    +'<button type="button" class="clk iconbtn" onclick="gTheory('+t+')" style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;cursor:pointer;">ПРАВИЛО</button></div>';
  if(it.k==='c'||it.k==='c2'){var q=it.q;
    area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+tp.n+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;line-height:1.5;margin-top:8px;">'
      +q.t[0]+'<span style="display:inline-block;min-width:64px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>'+q.t[1]+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'" onclick="gPick(this,'+i+')">'+o+'</button>'}).join('')+'</div>';
  }else{var q=it.q;
    area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;min-height:150px;">'+wDeco()+head
      +'<div style="font-weight:600;font-size:11px;color:#777163;margin-top:14px;">'+tp.n+' · впиши форму слова</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.55;margin-top:8px;">'
      +q.s.replace('_____','<span style="display:inline-block;min-width:70px;border-bottom:2.5px dashed #F2683F;text-align:center;color:#B54E2F;">&nbsp;?&nbsp;</span>')+'</div></div>'
      +'<div id="g_btns" style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +'<input id="g_inp" aria-label="Форма слова '+q.b+'" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="Форма слова '+q.b+'" '
      +'style="width:100%;box-sizing:border-box;height:52px;border:1px solid #F0EAE2;border-radius:18px;padding:0 16px;font-family:Manrope,sans-serif;font-weight:700;font-size:15px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);" onkeydown="if(event.key===\'Enter\')gSubmit()">'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gSubmit()">Проверить</button>'}
  gAnim('win','.32s')}
function gNorm(v){return grammarModule.normalizeAnswer(v)}
function gExplain(it,userWrong){var q=it.q,t=it.t||GS.t;
  var right=it.k==='f'?q.ans[0]:q.o[q.a];
  var sent=it.k==='f'
    ? q.s.replace('_____','<b style="color:#1D7F4A;">'+right+'</b>').replace(/\((?:[A-Z ]+)\)/,'')
    : q.t[0]+'<b style="color:#1D7F4A;">'+right+'</b>'+q.t[1];
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">РАЗБОР ОШИБКИ</span></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:22px;color:#1D7F4A;margin-top:14px;text-align:center;">'+right+'</div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.6;margin-top:10px;text-align:center;font-style:italic;">'+sent+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:12px;background:#FDF3EC;border-left:3px solid #F2683F;border-radius:0 14px 14px 0;padding:11px 14px;"><b>Почему:</b> '+(q.e||'')+'</div>'
    +'<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:12px 14px;">'
    +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ПРАВИЛО · '+G_TOPICS[t].n.toUpperCase()+'</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.6;margin-top:6px;">'+G_TOPICS[t].th+'</div></div>'
    +'<div style="font-weight:600;font-size:11.5px;color:#75705F;margin-top:10px;text-align:center;">Вопрос вернётся в конце подхода</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gAfterExplain()">Понятно, дальше</button></div>';
  gAnim('wflip','.5s')}
function gAfterExplain(){GS.i++;gSync();save();gRenderQ()}
function gAnswer(ok,it){grammarModule.applyAnswer(gRec(it.t||GS.t),GS,it,ok)}
function gPick(btn,i){var it=GS.queue[GS.i];if(!it||btn.dataset.done)return;var q=it.q;
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var ok=i===q.a;
  gAnswer(ok,it);
  if(ok){ui.markAnswer(btn,'correct');gAnim('wpop','.35s');
    setTimeout(function(){GS.i++;gSync();save();gRenderQ()},600)}
  else{ui.markAnswer(btn,'wrong');
    all.forEach(function(b,bi){if(bi===q.a)ui.markAnswer(b,'correct')});
    gAnim('wshake','.42s');
    setTimeout(function(){gExplain(it)},900)}}
function gSubmit(){var it=GS.queue[GS.i];if(!it)return;var inp=document.getElementById('g_inp');if(!inp||inp.dataset.done)return;
  var q=it.q,val=gNorm(inp.value);
  var ok=q.ans.some(function(a){return gNorm(a)===val});
  inp.dataset.done=1;
  inp.style.borderColor=ok?'#1F9E5A':'#E24B4A';inp.style.background=ok?'#EAF7F0':'#FDEDEA';
  gAnswer(ok,it);
  if(ok){gAnim('wpop','.35s');setTimeout(function(){GS.i++;gSync();save();gRenderQ()},600)}
  else{inp.value=q.ans[0];gAnim('wshake','.42s');setTimeout(function(){gExplain(it)},900)}}
function gFinish(){if(GS&&GS.mode==='rev'){gFinishRev();return}
  var area=document.getElementById('g_area');var r=gRec(GS.t),tp=G_TOPICS[GS.t];
  var closed=r.st===2;
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:24px;">'+wDeco()
    +'<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14px 0;">'
    +'<div style="font-size:44px;">'+(closed?'🏆':'💪')+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:10px;">'+(closed?'Тема закреплена!':'Подход завершён')+'</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#777163;margin-top:8px;line-height:1.5;">'+tp.n+'<br>Верно: '+GS.ok+' из '+GS.done+(closed?'':'<br>Для закрепления — 4 верных ответа уровня 2 подряд')+'</div></div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +(closed?'':'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gStart('+GS.t+')">Ещё подход</button>')
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="GS=null;initGrammar()">К темам</button></div>';
  gAnim('win','.32s');gSync();save()}
function gFinishRev(){var area=document.getElementById('g_area');var rows='';
  GS.revT.forEach(function(t){var r=gRec(t);var bad=GS.errT[t];
    if(bad){r.st=1;r.sr=0;r.due=0}
    else{r.rs=Math.min(2,(r.rs||0)+1);r.due=Date.now()+G_RINT[r.rs]*86400000}
    rows+='<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="font-weight:700;font-size:13.5px;color:#2B2B2B;">'+G_TOPICS[t].n+'</div>'
      +(bad?'<span style="flex:none;font-weight:800;font-size:10px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">СНОВА В РАБОТЕ</span>'
           :'<span style="flex:none;font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЧЕРЕЗ '+G_RINT[r.rs]+' ДН.</span>')
      +'</div>'});
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">🧠</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">Повторение завершено</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Верно: '+GS.ok+' из '+GS.done+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="GS=null;initGrammar()">К темам</button></div>';
  GS=null;gSync();save();gAnim('win','.32s')}
/* ===== ЭКЗАМЕН: задания 19–24 (текст с 6 пропусками) ===== */
const G_EXAMS=[
{tx:['Last summer Kate and her brother ',' to St Petersburg. It was their ',' visit to the city. The Hermitage ',' in 1764. Kate thought the real palaces were much ',' than in photos. Now she ',' a new trip together with ',' best friend.'],
 gaps:[{b:'GO',ans:['went'],e:'last summer → Past Simple: went.',t:2},
  {b:'ONE',ans:['first'],e:'Порядковое: one → first.',t:12},
  {b:'FOUND',ans:['was founded'],e:'Музей основали → пассив прошлого: was founded.',t:5},
  {b:'BEAUTIFUL',ans:['more beautiful'],e:'Длинное прилагательное → more beautiful.',t:10},
  {b:'PLAN',ans:['is planning'],e:'now → Present Continuous: is planning.',t:1},
  {b:'SHE',ans:['her'],e:'Перед сущ. → притяжательное her.',t:11}]},
{tx:['Tom is fond of science. Every week he ',' a robotics club. Yesterday, while he ',' on his robot, his teacher said that the results ',' impressive. If Tom ',' the city contest, he will go to the national final. It will be the ',' competition in his life. Tom believes that in the future robots ',' everywhere.'],
 gaps:[{b:'ATTEND',ans:['attends'],e:'every week → Present Simple, he → attends.',t:1},
  {b:'WORK',ans:['was working'],e:'while → Past Continuous: was working.',t:2},
  {b:'BE',ans:['were'],e:'Косвенная речь: сдвиг are → were.',t:7},
  {b:'WIN',ans:['wins'],e:'1 тип условия: после if — Present Simple.',t:6},
  {b:'THREE',ans:['third'],e:'three → third.',t:12},
  {b:'USE',ans:['will be used'],e:'Будущее в пассиве → will be used.',t:5}]},
{tx:['My granny lives in the country. Her house ',' by my great-grandfather. It is much ',' than our flat. When I visited her last month, she ',' jam. She said she ',' me a jar. Granny keeps three cats, and each of ',' has ',' own bowl.'],
 gaps:[{b:'BUILD',ans:['was built'],e:'Дом построили → пассив: was built.',t:5},
  {b:'OLD',ans:['older'],e:'Сравнение: older than.',t:10},
  {b:'MAKE',ans:['was making'],e:'Процесс в момент прошлого → was making.',t:2},
  {b:'GIVE',ans:['would give'],e:'Косвенная речь: will give → would give.',t:7},
  {b:'THEY',ans:['them'],e:'each of them.',t:11},
  {b:'IT',ans:['its'],e:'Притяжательное its (без апострофа).',t:11}]}
];
let EX=null;
function gExamPool(){var ai=(S&&S.examAi)||[];return G_EXAMS.concat(ai)}
function gExamFmt(sec){return grammarModule.formatDuration(sec)}
function gExam(){var area=document.getElementById('g_area');if(!area)return;
  var st=S.exam19||{};
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Задания 19–24</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Связный текст с шестью пропусками. Впиши правильную форму слов, данных ЗАГЛАВНЫМИ буквами — без вариантов ответа, как на настоящем экзамене. Идёт таймер.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний результат: '+st.last+' из 6 · лучший: '+st.best+' из 6</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">← К темам</button></div>';
  gAnim('win','.32s');gExamGen()}
function gExamStart(){var pool=gExamPool();
  S.examIdx=(S.examIdx||0);var ex=pool[S.examIdx%pool.length];S.examIdx++;
  if(EX&&EX.iv)clearInterval(EX.iv);
  EX={ex:ex,t0:Date.now(),iv:setInterval(function(){setTxt('g_today',gExamFmt(Math.floor((Date.now()-EX.t0)/1000)))},1000)};
  var area=document.getElementById('g_area');
  var txt='';
  ex.tx.forEach(function(seg,i){txt+=seg;
    if(i<6)txt+='<b style="color:#B54E2F;">'+(19+i)+'</b>&nbsp;<span style="display:inline-block;min-width:56px;border-bottom:2.5px dashed #F2683F;"></span>&nbsp;<b style="color:#777163;font-size:12px;">('+ex.gaps[i].b+')</b> '});
  var inputs=ex.gaps.map(function(g,i){
    return '<div style="display:flex;align-items:center;gap:10px;">'
      +'<span style="flex:none;width:64px;font-weight:800;font-size:12.5px;color:#B54E2F;">'+(19+i)+' · '+g.b+'</span>'
      +'<input id="g_ex_'+i+'" aria-label="Пропуск '+(19+i)+', форма слова '+g.b+'" autocapitalize="none" autocomplete="off" spellcheck="false" style="flex:1;box-sizing:border-box;height:46px;border:1px solid #F0EAE2;border-radius:15px;padding:0 13px;font-family:Manrope,sans-serif;font-weight:700;font-size:14px;color:#2B2B2B;outline:none;box-shadow:inset 0 2px 4px rgba(60,45,30,.05);"></div>'}).join('');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 19–24</span></div>'
    +'<div style="font-weight:600;font-size:14px;color:#2B2B2B;line-height:1.7;margin-top:12px;">'+txt+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:9px;">'+inputs
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:3px;" onclick="gExamCheck()">Проверить</button></div>';
  gAnim('win','.32s')}
function gExamCheck(){if(!EX)return;var ex=EX.ex;
  clearInterval(EX.iv);var sec=examModule.elapsedSeconds(EX.t0,Date.now());
  var score=0,rows='',bank=[];
  ex.gaps.forEach(function(g,i){var inp=document.getElementById('g_ex_'+i);var val=gNorm(inp?inp.value:'');
    var ok=g.ans.some(function(a){return gNorm(a)===val});
    if(ok)score++;
    else{if(g.t){var r=gRec(g.t);r.err++;if(r.st===2)r.due=Date.now()}
      bank.push({module:'grammar',itemKey:'grammar_19_24:'+String(g.b).toLowerCase(),errorType:'incorrect_form',details:{expected:String(g.ans[0])}})}
    rows+='<div style="padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<span style="font-weight:800;font-size:13px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(19+i)+' · '+g.b+' → '+g.ans[0]+'</span>'
      +(ok?'<span style="font-weight:800;font-size:10px;color:#1D7F4A;background:#EAF7F0;padding:4px 9px;border-radius:20px;">ВЕРНО</span>'
          :'<span style="font-weight:800;font-size:10px;color:#A83226;background:#FDEDEA;padding:4px 9px;border-radius:20px;">'+((document.getElementById('g_ex_'+i)||{}).value||'—')+'</span>')
      +'</div>'
      +(ok?'':'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:4px;">'+g.e+'</div>')
      +'</div>'});
  S.exam19=examModule.record(S.exam19,score);
  if(typeof SRV!=='undefined'&&SRV&&TOKEN&&typeof crypto!=='undefined'&&crypto.randomUUID){
    apiPost('/api/module-attempts',examModule.attempt(crypto.randomUUID(),{module:'exam',activity:'grammar_19_24',score:score,maxScore:6,durationMs:sec*1000})).catch(function(){})}
  if(bank.length&&typeof SRV!=='undefined'&&SRV&&TOKEN){apiPost('/api/error-bank',{errors:bank}).catch(function(){})}
  EX=null;save();gSync();
  var area=document.getElementById('g_area');
  area.innerHTML='<div id="g_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(score,6)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+score+' из 6</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+(score<6?' · слабые темы отмечены к повторению':'')+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="gExamStart()">Ещё текст</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="gMap()">К темам</button></div>';
  gAnim('win','.32s');gExamGen()}
/* фоновая генерация новых экзаменационных текстов */
var G_EXGEN=false;
async function gExamGen(){
  if(G_EXGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  if(gExamPool().length>=8)return;G_EXGEN=true;
  try{
    var d=await generateAiContent('grammar_exam_19_24');
    if(d&&Array.isArray(d.tx)&&d.tx.length===7&&Array.isArray(d.gaps)&&d.gaps.length===6
       &&d.gaps.every(function(g){return g&&g.b&&Array.isArray(g.ans)&&g.ans.length})){
      var ex={tx:d.tx.map(String),gaps:d.gaps.map(function(g){return{b:String(g.b),ans:g.ans.map(String),e:String(g.e||''),t:+g.t||0}})};
      S.examAi=(S.examAi||[]).concat([ex]);save()}
  }catch(e){}
  G_EXGEN=false}
/* фоновая ИИ-догенерация заданий по теме */
var G_GEN=false;
async function gGen(t){
  if(G_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  var ai=(S.gramAi&&S.gramAi[t])||[];
  if(ai.length>=15)return;G_GEN=true;
  try{
    var tp=G_TOPICS[t];
    var d=await generateAiContent('grammar_topic_set',{topicId:t,topic:tp.n});var add=[];
    if(d&&Array.isArray(d.c))d.c.forEach(function(q){if(q&&Array.isArray(q.t)&&q.t.length>=2&&Array.isArray(q.o)&&q.o.length===4&&+q.a>=0&&+q.a<4)add.push({k:'c',q:{t:[String(q.t[0]),String(q.t[1])],o:q.o.map(String),a:+q.a,e:String(q.e||'')}})});
    if(d&&Array.isArray(d.f))d.f.forEach(function(q){if(q&&q.s&&String(q.s).indexOf('_____')>=0&&Array.isArray(q.ans)&&q.ans.length)add.push({k:'f',q:{s:String(q.s),b:String(q.b||''),ans:q.ans.map(String),e:String(q.e||'')}})});
    if(add.length){S.gramAi=S.gramAi||{};S.gramAi[t]=((S.gramAi[t])||[]).concat(add);save()}
  }catch(e){}
  G_GEN=false}
/* прячем FAB на грамматике, синк при старте */
registerRouteHook(function(id){if(EX&&EX.iv){clearInterval(EX.iv);EX=null}if(id==='scr3'){var f=document.getElementById('genfab');if(f)f.style.display='none';GS=null}});
registerStartHook(function(){return gSync()});

/* legacy block 7 */
/* ===== READING v2: задание 10 + задания 12-18 + словарь в SRS ===== */
const R_HL=[
{hl:['A hobby for everyone','Dangers of city life','A new way to travel','Sport at school','Eating for health'],
 txts:[
 {t:'More and more teenagers choose cycling to get to school. It is cheap, fast and green. Some cities even build special lanes for young riders.',a:2,k:'cycling to get to school, special lanes — речь о способе добираться, то есть о передвижении.'},
 {t:'Doctors say that fruit and vegetables must be on your plate every day. A balanced diet gives you energy and protects you from illnesses.',a:4,k:'balanced diet, fruit and vegetables — про здоровое питание.'},
 {t:'Football, volleyball and athletics are part of the timetable in most Russian schools. PE lessons help students stay active and make friends.',a:3,k:'PE lessons, timetable — спорт именно в школе.'},
 {t:'Collecting stamps, drawing or playing chess — there is an activity for every character. The main thing is to find what you really enjoy.',a:0,k:'an activity for every character — хобби найдётся для каждого.'}]},
{hl:['A famous discovery','Learning languages online','Weather and mood','A family tradition','Protecting nature'],
 txts:[
 {t:'Every Sunday my grandmother bakes her special apple pie, and the whole family meets at her place. This custom is more than fifty years old.',a:3,k:'custom, every Sunday, the whole family — семейная традиция.'},
 {t:'Scientists say that sunny days make people happier and more active, while long rains can cause sadness and low energy.',a:2,k:'sunny days → happier; rains → sadness — связь погоды и настроения.'},
 {t:'Volunteers clean rivers and plant trees in our region every spring. They want to keep the local forests safe for animals and people.',a:4,k:'clean rivers, plant trees, keep forests safe — защита природы.'},
 {t:'With modern apps you can practise English anywhere: on the bus, at breakfast or before sleep. Short daily lessons work better than long ones.',a:1,k:'apps, practise English anywhere — изучение языка онлайн.'}]},
{hl:['A useful invention','Holiday plans','A school project','Reading habits','City transport problems'],
 txts:[
 {t:'Teenagers read fewer paper books today, but they read a lot online: articles, blogs and e-books. The way of reading has changed, not the love for it.',a:3,k:'read online, e-books — о том, КАК читают, то есть о привычках чтения.'},
 {t:'Next summer our class is going to the sea. We have already booked the hotel and planned excursions to two ancient towns.',a:1,k:'next summer, booked the hotel — планы на каникулы.'},
 {t:'Our students made a website about the history of our town. They interviewed old residents and collected photos from family albums.',a:2,k:'students made a website, interviewed — школьный проект.'},
 {t:'Traffic jams make people in big cities lose hours every day. Experts suggest developing the metro and building more bike lanes.',a:4,k:'traffic jams, metro, bike lanes — транспортные проблемы города.'}]}
];
const R_QS=[
{tx:'Many British students take a gap year before university. During this year they travel, work or volunteer in other countries. Supporters say that a gap year helps young people become independent and understand what they really want to study. However, some parents are afraid that after a long break their children will not want to return to studying. Universities report that gap-year students usually get better marks in the first year, because they are more motivated and organised. Experts advise planning the year carefully: a person who just stays at home often wastes time and loses study habits.',
 qs:[
 {q:'What do many British students do before university?',o:['They take exams again','They take a year off','They start full-time careers','They move abroad for good'],a:1,ev:'Many British students take a gap year before university.',e:'gap year — это год перерыва между школой и университетом.'},
 {q:'What are some parents afraid of?',o:['Money problems','Danger during travel','That children will not return to study','Bad school marks'],a:2,ev:'…some parents are afraid that after a long break their children will not want to return to studying.',e:'Страх родителей — что ребёнок не захочет вернуться к учёбе.'},
 {q:'According to universities, gap-year students usually…',o:['get better first-year marks','miss more lessons','choose easier subjects','leave university earlier'],a:0,ev:'Universities report that gap-year students usually get better marks in the first year…',e:'better marks in the first year — лучшие оценки на первом курсе.'},
 {q:'What do experts advise?',o:['To stay at home','To plan the year carefully','To avoid working','To skip the gap year'],a:1,ev:'Experts advise planning the year carefully…',e:'Главный совет экспертов — тщательно планировать год.'}]},
{tx:'Some schools in Europe have banned smartphones during lessons and breaks. Teachers noticed that students talk to each other more and play active games in the yard again. Not everyone is happy, though. Many parents want to be able to contact their children at any moment. Some students say phones help them study: they use dictionaries, calculators and educational apps. Scientists offer a compromise: keep phones in special boxes during lessons and return them after classes. In schools that tried this system, test results improved and the number of conflicts between students went down.',
 qs:[
 {q:'What happened after the smartphone ban?',o:['Students became lonely','Students talk and play more','Parents visited school more often','Lessons became longer'],a:1,ev:'…students talk to each other more and play active games in the yard again.',e:'Ученики стали больше общаться вживую и играть во дворе.'},
 {q:'Why are many parents unhappy about the ban?',o:['Phones are expensive','They cannot contact their children','Children play too much','Teachers became stricter'],a:1,ev:'Many parents want to be able to contact their children at any moment.',e:'Родителям важна возможность связаться с ребёнком в любой момент.'},
 {q:'How do phones help students, according to some of them?',o:['They give study tools','They help make friends','They improve sport results','They help fall asleep'],a:0,ev:'…they use dictionaries, calculators and educational apps.',e:'Словари, калькуляторы, учебные приложения — инструменты для учёбы.'},
 {q:'What compromise do scientists suggest?',o:['Shorter lessons','No homework','Phones in boxes during lessons','Moving school online'],a:2,ev:'…keep phones in special boxes during lessons and return them after classes.',e:'Компромисс — телефоны в коробках на время уроков.'}]},
{tx:'Last year more than a million Russian teenagers took part in volunteer projects. They helped animal shelters, visited elderly people and cleaned parks. Psychologists say that volunteering makes teenagers more confident and teaches them to work in a team. It can also help with a future career: universities pay attention to social activity, and some companies prefer candidates with volunteer experience. To become a volunteer, you do not need money or special skills — only free time and the wish to help. Most projects accept school students from the age of fourteen.',
 qs:[
 {q:'What did teenagers do as volunteers?',o:['They built new houses','They helped shelters and elderly people','They taught at schools','They worked only in hospitals'],a:1,ev:'They helped animal shelters, visited elderly people and cleaned parks.',e:'Приюты, пожилые люди, парки — именно это перечислено в тексте.'},
 {q:'What do psychologists say about volunteering?',o:['It takes too much time','It builds confidence and teamwork','It is dangerous for teens','It is only for adults'],a:1,ev:'…volunteering makes teenagers more confident and teaches them to work in a team.',e:'Уверенность и командная работа — эффект волонтёрства.'},
 {q:'How can volunteering help in the future?',o:['It guarantees any job','Universities and companies value it','It pays very well','It replaces school exams'],a:1,ev:'…universities pay attention to social activity, and some companies prefer candidates with volunteer experience.',e:'Вузы и работодатели ценят волонтёрский опыт — но не «гарантируют работу».'},
 {q:'What do you need to become a volunteer?',o:['Money','Special skills','Free time and the wish to help','A special diploma'],a:2,ev:'…you do not need money or special skills — only free time and the wish to help.',e:'Нужны только свободное время и желание помогать.'}]}
];
const R_GAPS=[
{tx:['Our school library is more than just a room with books. Students come here ',' or to prepare for lessons. Last year the library bought new computers, ',' much faster. Teachers say that students ',' now spend more time reading than before.'],
 fr:['to do their homework in silence','which made the search for information','who visit the library regularly','that was built ten years ago'],
 a:[0,1,2],
 k:['Цель прихода → инфинитив: come here TO DO homework.','which относится к computers, а дальше есть made … faster — фраза продолжает мысль о поиске.','who — придаточное о людях; речь о студентах, которые ходят в библиотеку.']},
{tx:['The new park opened in our city last spring. People of all ages come there ',' . There is a special area for dogs, ',' without a lead. Next year the city plans to build an open-air stage ',' .'],
 fr:['to walk, run and ride bikes','where they can play freely','where concerts and festivals will take place','that sells ice cream'],
 a:[0,1,2],
 k:['Зачем приходят → инфинитив цели: TO WALK, run and ride bikes.','where + play freely without a lead — место для собак.','Сцена — место будущих концертов: where concerts … will take place.']},
{tx:['Last month a student from Britain joined our class. At first it was hard for him ',' , but soon he made friends. He says Russian winter is the coldest thing ',' . Next month our class is planning a trip to Suzdal ',' .'],
 fr:['to understand our fast speech','that he has ever experienced','to show him old Russian towns','who lives near the school'],
 a:[0,1,2],
 k:['it was hard for him + инфинитив: TO UNDERSTAND.','the coldest thing THAT he has ever experienced — классика с ever после превосходной степени.','Цель поездки → инфинитив: TO SHOW him old towns.']}
];
let RG=null;
let RH=null,RQ=null;
function rSt(){S.read=readingModule.normalizeState(S.read);return S.read}
function rSync(){if(!S)return;var r=rSt();var stats=readingModule.summary(r),acc=stats.accuracy;
  S.prog=S.prog||{};S.prog.read=acc;
  setTxt('sub_read',r.texts?('текстов: '+r.texts+' · точность '+acc+'%'):'начни с первого текста');
  setTxt('r_sumline',r.texts?('Прочитано '+r.texts+' · точность '+acc+'%'):'Два тренажёра — как на экзамене');
  var bar=document.getElementById('r_bar');if(bar)bar.style.width=Math.max(2,acc)+'%'}
function rAnim(name,dur){ui.animate('r_card',name,dur)}
function rEsc(w){return ui.escapeHtml(w)}
function rWordsHtml(text){return text.split(/(\s+)/).map(function(tok){
  if(/^\s+$/.test(tok))return tok;
  var m=tok.match(/[A-Za-z][A-Za-z'-]*/);if(!m)return rEsc(tok);
  var clean=m[0].toLowerCase();
  var st=S.wstatus&&S.wstatus[clean];
  var bg=st==='learn'?'background:#FFEDE4;border-radius:5px;':(st==='know'?'background:#EAF7F0;border-radius:5px;':'');
  return '<button type="button" class="clk iconbtn" data-w="'+clean+'" onclick="trWord(this.dataset.w)" style="cursor:pointer;'+bg+'">'+rEsc(tok)+'</button>'}).join('')}
function initReading(){if(!S)return;rSync();rHub()}
function rHub(){var area=document.getElementById('r_area');if(!area)return;RH=null;RQ=null;
  var r=rSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  function acc(x){return x.tot?Math.round(x.ok/x.tot*100)+'%':'—'}
  var re=S.readExam||{};
  area.innerHTML=
   '<button type="button" class="sq clk cardbtn" onclick="rExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'<path class="eb5sp" style="animation-delay:2.3s" d="M120,20 Q120,23 123,23 Q120,23 120,26 Q120,23 117,23 Q120,23 120,20 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 10–18</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(re.n?('лучший результат: '+re.best+' из 11'):'все три задания подряд, на время')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rHl()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Заголовки</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задание 10 · подбери заголовок к тексту</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;background:#FFEDE4;padding:8px 12px;border-radius:14px;">'+acc(r.h)+'</span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rQs()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Полное понимание</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задания 12–18 · текст и вопросы</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#1D7F4A;background:#EAF7F0;padding:8px 12px;border-radius:14px;">'+acc(r.q)+'</span></div></button>'
   +'<button type="button" class="clayCard sq clk cardbtn" onclick="rGp()" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">Пропуски</div>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">задание 11 · верни фразы в текст</div></div>'
    +'<span style="flex:none;font-weight:800;font-size:12px;color:#A56000;background:#FFF4DE;padding:8px 12px;border-radius:14px;">'+acc(r.g)+'</span></div></button>'
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#FFF4DE;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#E8730A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Тапни любое слово в тексте — покажем перевод и добавим его в модуль «Слова»</div></div>';
  setTxt('r_today','3 тренажёра');rGen()}
/* перемешивание вариантов с пересчётом ответов */
function rShufHl(set){return readingModule.shuffleHeadings(set)}
function rShufGp(set){return readingModule.shuffleGaps(set)}
/* ---- Задание 10: заголовки ---- */
function rHl(){S.readIdxH=(S.readIdxH||0);var pool=rPool('h',R_HL);var set=rShufHl(pool[S.readIdxH%pool.length]);S.readIdxH++;
  RH={set:set,sel:[null,null,null,null],done:false};rHlRender()}
function rHlRender(){var area=document.getElementById('r_area');var set=RH.set;
  var L='ABCDE';
  var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 10 · ЗАГОЛОВКИ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Подбери заголовок к каждому тексту. Один заголовок лишний.</div>'
    +set.hl.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+x+'</div>'}).join('')+'</div>';
  set.txts.forEach(function(tx,ti){
    h+='<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;">'
      +'<div style="font-weight:500;font-size:13.5px;line-height:1.6;color:#2B2B2B;">'+rWordsHtml(tx.t)+'</div>'
      +'<div style="margin-top:11px;display:flex;gap:8px;" id="rhl_row_'+ti+'">'
      +set.hl.map(function(_,hi){var on=RH.sel[ti]===hi;
        return '<button onclick="rHlPick('+ti+','+hi+')" style="flex:1;height:38px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[hi]+'</button>'}).join('')
      +'</div><div id="rhl_res_'+ti+'"></div></div>'});
  var all=RH.sel.every(function(x){return x!==null});
  h+='<div style="margin-bottom:8px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="rHlCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button></div>';
  area.innerHTML=h;setTxt('r_today',RH.sel.filter(function(x){return x!==null}).length+' / 4 выбрано')}
function rHlPick(ti,hi){if(RH.done)return;
  RH.sel=readingModule.selectUnique(RH.sel,ti,hi);
  rHlRender()}
function rHlCheck(){if(RH.done)return;RH.done=true;var set=RH.set,L='ABCDE',r=rSt(),okn=0;
  set.txts.forEach(function(tx,ti){var ok=RH.sel[ti]===tx.a;if(ok)okn++;
    r.h.tot++;if(ok)r.h.ok++;
    var el=document.getElementById('rhl_res_'+ti);
    if(el)el.innerHTML='<div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильный ответ ')+L[tx.a]+'. '+set.hl[tx.a]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Ключ:</b> '+tx.k+'</div></div>';
    var row=document.getElementById('rhl_row_'+ti);if(row)row.style.pointerEvents='none'});
  var used={};set.txts.forEach(function(t){used[t.a]=1});
  var extra=[0,1,2,3,4].find(function(i){return !used[i]});
  r.texts++;rSync();save();
  var area=document.getElementById('r_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===4?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из 4</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишний заголовок: '+'ABCDE'[extra]+'. '+RH.set.hl[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="rHl()">Ещё подход</button></div>';
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};rGen()}
/* ---- Задания 12-18: полное понимание ---- */
function rQs(){S.readIdxQ=(S.readIdxQ||0);var pool=rPool('q',R_QS);var set=pool[S.readIdxQ%pool.length];S.readIdxQ++;
  RQ={set:set,i:-1,ok:0,showTx:false};rQsRender()}
function rQsRender(){var area=document.getElementById('r_area');var set=RQ.set;
  if(RQ.i<0){
    area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 12–18 · ТЕКСТ</span>'
      +'<div style="font-weight:500;font-size:14px;line-height:1.7;color:#2B2B2B;margin-top:12px;">'+rWordsHtml(set.tx)+'</div></div>'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="RQ.i=0;rQsRender()">К вопросам</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button>';
    rAnim('win','.32s');setTxt('r_today','читаем текст');return}
  var q=set.qs[RQ.i];
  if(!q){var r=rSt();r.texts++;rSync();save();
    area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">'+(RQ.ok===set.qs.length?'🏆':(RQ.ok>=2?'💪':'📚'))+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">'+RQ.ok+' из '+set.qs.length+'</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Точность в этом тренажёре: '+(rSt().q.tot?Math.round(rSt().q.ok/rSt().q.tot*100):0)+'%</div></div>'
      +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
      +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rQs()">Ещё текст</button>'
      +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">К чтению</button></div>';
    rAnim('win','.32s');return}
  area.innerHTML=(RQ.showTx?('<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;"><div style="font-weight:500;font-size:13px;line-height:1.65;color:#2B2B2B;">'+rWordsHtml(set.tx)+'</div></div>'):'')
    +'<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(RQ.i+1)+' ИЗ '+set.qs.length+'</span>'
    +'<button type="button" class="clk iconbtn" onclick="RQ.showTx=!RQ.showTx;rQsRender()" style="font-weight:800;font-size:10px;letter-spacing:.6px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;cursor:pointer;">'+(RQ.showTx?'СКРЫТЬ ТЕКСТ':'ТЕКСТ')+'</button></div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16.5px;color:#2B2B2B;line-height:1.45;margin-top:12px;">'+q.q+'</div></div>'
    +'<div style="display:flex;flex-direction:column;gap:10px;">'
    +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'text-align:left;" onclick="rQsPick(this,'+i+')">'+o+'</button>'}).join('')+'</div>';
  rAnim('win','.32s');setTxt('r_today',(RQ.i+1)+' / '+set.qs.length)}
function rQsPick(btn,i){var q=RQ.set.qs[RQ.i];if(!q||btn.dataset.done)return;
  var all=btn.parentElement.querySelectorAll('button');all.forEach(function(b){b.dataset.done=1});
  var ok=i===q.a,r=rSt();r.q.tot++;if(ok){r.q.ok++;RQ.ok++}
  if(ok){ui.markAnswer(btn,'correct');rAnim('wpop','.35s');
    setTimeout(function(){RQ.i++;rSync();save();rQsRender()},650)}
  else{ui.markAnswer(btn,'wrong');
    all.forEach(function(b,bi){if(bi===q.a)ui.markAnswer(b,'correct')});
    rAnim('wshake','.42s');
    setTimeout(function(){rQsExplain(q)},900)}}
function rQsExplain(q){var area=document.getElementById('r_area');
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">РАЗБОР ОШИБКИ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#1D7F4A;margin-top:12px;">'+q.o[q.a]+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.6;margin-top:10px;background:#F2F8F4;border-left:3px solid #1F9E5A;border-radius:0 14px 14px 0;padding:11px 14px;"><b>В тексте:</b> «'+q.ev+'»</div>'
    +'<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;margin-top:10px;background:#FDF3EC;border-left:3px solid #F2683F;border-radius:0 14px 14px 0;padding:11px 14px;"><b>Почему:</b> '+q.e+'</div></div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="RQ.i++;rSync();save();rQsRender()">Понятно, дальше</button>';
  rAnim('wflip','.5s')}
/* ---- Задание 11: пропуски ---- */
function rGp(){S.readIdxG=(S.readIdxG||0);var pool=rPool('g',R_GAPS);var set=rShufGp(pool[S.readIdxG%pool.length]);S.readIdxG++;
  RG={set:set,sel:[null,null,null],done:false};rGpRender()}
function rGpRender(){var area=document.getElementById('r_area');var set=RG.set,L='ABCD';
  var txt='';
  set.tx.forEach(function(seg,i){txt+=rWordsHtml(seg);
    if(i<3){var s=RG.sel[i];
      txt+=' <b style="color:#B54E2F;">('+(i+1)+')</b>&nbsp;<span style="display:inline-block;min-width:54px;border-bottom:2.5px dashed #F2683F;text-align:center;font-weight:800;color:#C2421B;">'+(s!==null?L[s]:'&nbsp;')+'</span> '}});
  var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 11 · ПРОПУСКИ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Верни фразы на свои места. Одна фраза лишняя.</div>'
    +'<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+txt+'</div></div>'
    +'<div class="clayCard" style="padding:14px 16px;margin-bottom:12px;">'
    +set.fr.map(function(f,i){return '<div style="margin-top:6px;font-weight:700;font-size:12.5px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+f+'</div>'}).join('')+'</div>';
  [0,1,2].forEach(function(gi){
    h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;">'
      +'<div style="display:flex;align-items:center;gap:8px;">'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:56px;">Пропуск '+(gi+1)+'</span>'
      +'<div style="flex:1;display:flex;gap:8px;" id="rgp_row_'+gi+'">'
      +set.fr.map(function(_,fi){var on=RG.sel[gi]===fi;
        return '<button onclick="rGpPick('+gi+','+fi+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[fi]+'</button>'}).join('')
      +'</div></div><div id="rgp_res_'+gi+'"></div></div>'});
  var all=RG.sel.every(function(x){return x!==null});
  h+='<div style="margin-bottom:8px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="rGpCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="rHub()">← К чтению</button></div>';
  area.innerHTML=h;setTxt('r_today',RG.sel.filter(function(x){return x!==null}).length+' / 3 выбрано')}
function rGpPick(gi,fi){if(RG.done)return;
  RG.sel=readingModule.selectUnique(RG.sel,gi,fi);
  rGpRender()}
function rGpCheck(){if(RG.done)return;RG.done=true;var set=RG.set,L='ABCD',r=rSt(),okn=0;
  [0,1,2].forEach(function(gi){var ok=RG.sel[gi]===set.a[gi];if(ok)okn++;
    r.g.tot++;if(ok)r.g.ok++;
    var el=document.getElementById('rgp_res_'+gi);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно ')+L[set.a[gi]]+'. '+set.fr[set.a[gi]]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Почему:</b> '+set.k[gi]+'</div></div>';
    var row=document.getElementById('rgp_row_'+gi);if(row)row.style.pointerEvents='none'});
  var used={};set.a.forEach(function(x){used[x]=1});
  var extra=[0,1,2,3].find(function(i){return !used[i]});
  r.texts++;rSync();save();
  var area=document.getElementById('r_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===3?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из 3</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишняя фраза: '+L[extra]+'. '+set.fr[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="rGp()">Ещё подход</button></div>';
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};rGen()}
/* ---- слово из текста → в модуль Слова ---- */
function r_add(st){if(!lastWord)return;
  S.wstatus=S.wstatus||{};S.wstatus[lastWord]=st;
  if(st==='learn'){
    var tr=(document.getElementById('r_tr')||{}).textContent||'';
    if(tr&&tr.indexOf('перевод')<0&&tr.indexOf('офлайн, слова нет')<0&&tr.length<60){
      var have=EGE_WORDS.some(function(x){return wBase(x.w)===lastWord});
      if(!have){var it={w:lastWord,p:'n',t:0,tr:tr.replace(' · офлайн-словарь','').trim(),ex:''};
        EGE_WORDS.push(it);S.aiWords=(S.aiWords||[]).concat([it]);
        try{toast('Добавлено в «Слова» ✓')}catch(e){}}
      else{try{toast('Это слово уже в изучении')}catch(e){}}}}
  save();var p=document.getElementById('r_pop');if(p)p.style.display='none';
  try{wSync()}catch(e){}}
/* ---- экзамен по чтению: 10 + 11 + 12-18 ---- */
let RE=null;
function rExam(){var area=document.getElementById('r_area');if(!area)return;
  var st=S.readExam||{};
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Раздел «Чтение» целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Заголовки → пропуски → текст с вопросами. Никаких подсказок до конца, идёт таймер. Максимум 11 баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из 11 · лучший: '+st.best+' из 11</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">← К чтению</button></div>';
  rAnim('win','.32s')}
function rExamStart(){
  var ph=rPool('h',R_HL),pg=rPool('g',R_GAPS),pq=rPool('q',R_QS);
  S.reIdx=(S.reIdx||0);
  RE={h:rShufHl(ph[S.reIdx%ph.length]),g:rShufGp(pg[S.reIdx%pg.length]),q:pq[S.reIdx%pq.length],
      selH:[null,null,null,null],selG:[null,null,null],ansQ:[],stage:0,t0:Date.now()};
  S.reIdx++;
  RE.iv=setInterval(function(){if(RE)setTxt('r_today',gExamFmt(Math.floor((Date.now()-RE.t0)/1000)))},1000);
  rExamRender()}
function rExamBtnRow(ok,label,fn){
  return '<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:4px;'+(ok?'':'opacity:.45;pointer-events:none;')+'" onclick="'+fn+'">'+label+'</button>'}
function rExamRender(){var area=document.getElementById('r_area');if(!area||!RE)return;var L='ABCDE';
  if(RE.stage===0){var set=RE.h;
    var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 1 ИЗ 3 · ЗАГОЛОВКИ</span>'
      +set.hl.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+L[i]+'.</b> '+x+'</div>'}).join('')+'</div>';
    set.txts.forEach(function(tx,ti){
      h+='<div class="clayCard" style="padding:14px 16px;margin-bottom:11px;">'
        +'<div style="font-weight:500;font-size:13px;line-height:1.6;color:#2B2B2B;">'+rEsc(tx.t)+'</div>'
        +'<div style="margin-top:10px;display:flex;gap:8px;">'
        +set.hl.map(function(_,hi){var on=RE.selH[ti]===hi;
          return '<button onclick="RE.selH['+ti+']='+hi+';rExamDedup(\'selH\','+ti+','+hi+');rExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+L[hi]+'</button>'}).join('')+'</div></div>'});
    h+=rExamBtnRow(RE.selH.every(function(x){return x!==null}),'Дальше → пропуски','RE.stage=1;rExamRender()');
    area.innerHTML=h;return}
  if(RE.stage===1){var set=RE.g;
    var txt='';set.tx.forEach(function(seg,i){txt+=rEsc(seg);
      if(i<3){var s=RE.selG[i];txt+=' <b style="color:#B54E2F;">('+(i+1)+')</b>&nbsp;<span style="display:inline-block;min-width:50px;border-bottom:2.5px dashed #F2683F;text-align:center;font-weight:800;color:#C2421B;">'+(s!==null?'ABCD'[s]:'&nbsp;')+'</span> '}});
    var h='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 2 ИЗ 3 · ПРОПУСКИ</span>'
      +'<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+txt+'</div>'
      +set.fr.map(function(f,i){return '<div style="margin-top:6px;font-weight:700;font-size:12.5px;color:#2B2B2B;"><b style="color:#B54E2F;">'+'ABCD'[i]+'.</b> '+rEsc(f)+'</div>'}).join('')+'</div>';
    [0,1,2].forEach(function(gi){
      h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;">'
        +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:56px;">Пропуск '+(gi+1)+'</span>'
        +'<div style="flex:1;display:flex;gap:8px;">'
        +set.fr.map(function(_,fi){var on=RE.selG[gi]===fi;
          return '<button onclick="RE.selG['+gi+']='+fi+';rExamDedup(\'selG\','+gi+','+fi+');rExamRender()" style="flex:1;height:34px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:12.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+'ABCD'[fi]+'</button>'}).join('')+'</div></div>'});
    h+=rExamBtnRow(RE.selG.every(function(x){return x!==null}),'Дальше → текст','RE.stage=2;rExamRender()');
    area.innerHTML=h;return}
  var set=RE.q,qi=RE.ansQ.length;
  if(qi>=set.qs.length){rExamFinish();return}
  var q=set.qs[qi];
  area.innerHTML='<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;"><div style="font-weight:500;font-size:13px;line-height:1.65;color:#2B2B2B;">'+rEsc(set.tx)+'</div></div>'
    +'<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 3 ИЗ 3 · ВОПРОС '+(qi+1)+' ИЗ '+set.qs.length+'</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#2B2B2B;line-height:1.45;margin-top:12px;">'+rEsc(q.q)+'</div></div>'
    +'<div style="display:flex;flex-direction:column;gap:10px;">'
    +q.o.map(function(o,i){return '<button class="sq" style="'+WBTN+'text-align:left;" onclick="RE.ansQ.push('+i+');rExamRender()">'+rEsc(o)+'</button>'}).join('')+'</div>'}
function rExamDedup(field,idx,val){RE[field]=readingModule.selectUnique(RE[field],idx,val)}
function rExamFinish(){if(!RE)return;clearInterval(RE.iv);
  var sec=examModule.elapsedSeconds(RE.t0,Date.now()),L='ABCDE',r=rSt();
  var okH=0;RE.h.txts.forEach(function(tx,ti){r.h.tot++;if(RE.selH[ti]===tx.a){okH++;r.h.ok++}});
  var okG=0;[0,1,2].forEach(function(gi){r.g.tot++;if(RE.selG[gi]===RE.g.a[gi]){okG++;r.g.ok++}});
  var okQ=0;RE.q.qs.forEach(function(q,i){r.q.tot++;if(RE.ansQ[i]===q.a){okQ++;r.q.ok++}});
  var total=okH+okG+okQ;
  S.readExam=examModule.record(S.readExam,total);
  var rows='';
  RE.h.txts.forEach(function(tx,ti){if(RE.selH[ti]!==tx.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Заголовки · текст '+(ti+1)+' → '+L[tx.a]+'. '+rEsc(RE.h.hl[tx.a])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+tx.k+'</div></div>'});
  [0,1,2].forEach(function(gi){if(RE.selG[gi]!==RE.g.a[gi])
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Пропуск '+(gi+1)+' → '+'ABCD'[RE.g.a[gi]]+'. '+rEsc(RE.g.fr[RE.g.a[gi]])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+RE.g.k[gi]+'</div></div>'});
  RE.q.qs.forEach(function(q,i){if(RE.ansQ[i]!==q.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Вопрос '+(i+1)+' → '+rEsc(q.o[q.a])+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+rEsc(q.ev)+'»</div></div>'});
  RE=null;rSync();save();
  var parts=[['Заголовки',okH,4],['Пропуски',okG,3],['Вопросы',okQ,4]];
  var max=examModule.maxScore(parts),weak=examModule.weakestSection(parts);
  var area=document.getElementById('r_area');
  area.innerHTML='<div id="r_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(total,max)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+total+' из '+max+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+' · '+examModule.sectionLine(parts)+'</div>'
    +(total<max?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+weak.label.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div>'+(rows?'<div style="margin-top:12px;">'+rows+'</div>':'')+'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="rExamStart()">Ещё раз</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="rHub()">К чтению</button></div>';
  rAnim('win','.32s');rGen()}
/* ---- фоновая ИИ-генерация комплектов чтения ---- */
function rPool(kind,base){var ai=(S&&S.readAi&&S.readAi[kind])||[];return readingModule.pool(base,ai)}
var R_GEN=false;
async function rGen(){
  if(R_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.readAi=S.readAi||{h:[],q:[],g:[]};
  var kind=null;
  if(rPool('h',R_HL).length<6)kind='h';
  else if(rPool('q',R_QS).length<6)kind='q';
  else if(rPool('g',R_GAPS).length<6)kind='g';
  if(!kind)return;R_GEN=true;
  try{
    var d,item=null;
    if(kind==='h'){
      d=await generateAiContent('reading_headings');
      if(d&&Array.isArray(d.hl)&&d.hl.length===5&&Array.isArray(d.txts)&&d.txts.length===4
        &&d.txts.every(function(t){return t&&t.t&&t.a>=0&&t.a<5&&t.k})
        &&new Set(d.txts.map(function(t){return +t.a})).size===4){
        item={hl:d.hl.map(String),txts:d.txts.map(function(t){return{t:String(t.t),a:+t.a,k:String(t.k)}})}}
    }else if(kind==='q'){
      d=await generateAiContent('reading_questions');
      if(d&&d.tx&&Array.isArray(d.qs)&&d.qs.length===4
        &&d.qs.every(function(q){return q&&q.q&&Array.isArray(q.o)&&q.o.length===4&&q.a>=0&&q.a<4&&q.ev&&q.e})){
        item={tx:String(d.tx),qs:d.qs.map(function(q){return{q:String(q.q),o:q.o.map(String),a:+q.a,ev:String(q.ev),e:String(q.e)}})}}
    }else{
      d=await generateAiContent('reading_gaps');
      if(d&&Array.isArray(d.tx)&&d.tx.length===4&&Array.isArray(d.fr)&&d.fr.length===4
        &&Array.isArray(d.a)&&d.a.length===3&&d.a.every(function(x){return x>=0&&x<4})
        &&new Set(d.a.map(Number)).size===3&&Array.isArray(d.k)&&d.k.length===3){
        item={tx:d.tx.map(String),fr:d.fr.map(String),a:d.a.map(Number),k:d.k.map(String)}}
    }
    if(item){S.readAi[kind]=(S.readAi[kind]||[]).concat([item]);save()}
  }catch(e){}
  R_GEN=false;
  /* если ещё есть чем пополнить — продолжим в фоне */
  try{var need=rPool('h',R_HL).length<6||rPool('q',R_QS).length<6||rPool('g',R_GAPS).length<6;
    if(need)setTimeout(rGen,4000)}catch(e){}}
/* FAB прячем и на чтении; синк при старте */
registerRouteHook(function(id){if(RE&&RE.iv){clearInterval(RE.iv);RE=null}if(id==='scr7'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});
registerStartHook(function(){return rSync()});

/* legacy block 8 */
/* ===== LISTENING v2: задания 1, 2, 3-9 + озвучка по ролям ===== */
const L_M=[
{st:['Music helps this speaker to relax.','This speaker prefers active holidays.','This speaker enjoys cooking for the family.','This speaker spends a lot of time reading.','This speaker dreams of travelling abroad.'],
 sp:[
 {t:'After school I always put on my headphones. When I listen to my favourite songs, all my problems disappear and I feel calm again.'},
 {t:'On holidays I never stay at home. My family goes hiking in the mountains, and in summer we swim and ride bikes all day long.'},
 {t:'Every weekend I try a new recipe. My parents say my pancakes are the best, and I love making dinner for everybody on Sundays.'},
 {t:'I can spend the whole evening with a good detective story. Last month I read five books, and my room looks like a small library.'}],
 a:[0,1,2,3],
 k:['listen to songs → feel calm — музыка помогает расслабиться.','hiking, swim, ride bikes — активный отдых.','a new recipe, making dinner for everybody — готовит для семьи.','detective story, read five books — много читает.']},
{st:['The speaker finds exams stressful.','The speaker likes studying with friends.','The speaker is happy with a new school subject.','The speaker complains about too much homework.','The speaker wants to change schools.'],
 sp:[
 {t:'Before every test my hands shake and I cannot sleep well. Even when I know the material, I am still afraid of getting a bad mark.'},
 {t:'It is boring to do exercises alone. When my classmates come to my place, we explain difficult things to each other and studying becomes fun.'},
 {t:'This year we started learning economics. The lessons are so interesting that I even read extra articles at home.'},
 {t:'Teachers give us so many tasks that I sit at my desk till late evening. I have almost no time for walks or sport.'}],
 a:[0,1,2,3],
 k:['hands shake, afraid of a bad mark — экзамены вызывают стресс.','with classmates studying becomes fun — любит заниматься с друзьями.','started learning economics, so interesting — рад новому предмету.','so many tasks, no time for walks — жалуется на объём домашки.']}
];
const L_TF=[
{d:[
 {s:0,t:'Hi Kate! Are you free on Saturday? There is a new science museum in the city centre.'},
 {s:1,t:'Oh, I have heard about it! Tickets are half price for students, right?'},
 {s:0,t:'Exactly, five pounds instead of ten. My brother went last week and loved the space hall.'},
 {s:1,t:'Great. Shall we go in the morning? In the afternoon I have a piano lesson.'},
 {s:0,t:'Morning works for me. Let us meet at the bus stop at ten.'},
 {s:1,t:'Perfect. I will bring my camera — I hope taking photos is allowed there.'}],
 st:[
 {t:'The museum is in the city centre.',a:0,ev:'There is a new science museum in the city centre.',e:'Прямо сказано в первой реплике.'},
 {t:'Students pay ten pounds for a ticket.',a:1,ev:'…five pounds instead of ten.',e:'Для студентов полцены — пять фунтов, а не десять → False.'},
 {t:'The boy’s brother has already been to the museum.',a:0,ev:'My brother went last week and loved the space hall.',e:'Брат ходил на прошлой неделе → True.'},
 {t:'Kate is busy on Saturday afternoon.',a:0,ev:'In the afternoon I have a piano lesson.',e:'Днём у Кейт урок фортепиано → True.'},
 {t:'Taking photos is allowed in the museum.',a:2,ev:'I hope taking photos is allowed there.',e:'Кейт только НАДЕЕТСЯ — разрешено или нет, в диалоге не сказано → Not stated.'}]},
{d:[
 {s:1,t:'Tom, you look tired today. Is everything OK?'},
 {s:0,t:'We got a puppy two days ago, and he cries every night. I get up three or four times to calm him down.'},
 {s:1,t:'Poor you! What breed is he?'},
 {s:0,t:'A beagle. He is only two months old, but he is very clever. He already knows his name — Rex.'},
 {s:1,t:'My cat never comes when I call her. By the way, who walks him in the morning?'},
 {s:0,t:'My dad does, before work. And I walk him after school. The vet says short walks are better for puppies.'}],
 st:[
 {t:'Tom got his puppy two days ago.',a:0,ev:'We got a puppy two days ago…',e:'Прямое совпадение с репликой Тома.'},
 {t:'The puppy sleeps well at night.',a:1,ev:'…he cries every night. I get up three or four times…',e:'Щенок плачет по ночам → False.'},
 {t:'Rex is six months old.',a:1,ev:'He is only two months old…',e:'Ему два месяца, а не шесть → False.'},
 {t:'The girl’s cat comes when she calls it.',a:1,ev:'My cat never comes when I call her.',e:'Кошка никогда не приходит → False.'},
 {t:'Tom’s dad walks the puppy in the park.',a:2,ev:'My dad does, before work.',e:'Папа гуляет утром, но ГДЕ — не говорится → Not stated.'}]}
];
const L_IN=[
{d:[
 {s:1,t:'Today our guest is Alex, a young swimmer who won the regional championship. Alex, when did you start swimming?'},
 {s:0,t:'When I was six. My mum took me to the pool because I was often ill, and doctors advised sport.'},
 {s:1,t:'Do you train every day?'},
 {s:0,t:'Five times a week, early in the morning before school. On Sundays I always rest — my coach says rest is part of training.'},
 {s:1,t:'What was the hardest moment in your career?'},
 {s:0,t:'Last year I broke my arm and missed four months. I thought about leaving sport, but my team supported me.'},
 {s:1,t:'And what are your plans?'},
 {s:0,t:'I dream of the national team, but first I want to win the city cup in May.'}],
 qs:[
 {q:'Why did Alex start swimming?',o:['Doctors recommended sport','His friends invited him','He watched it on TV'],a:0,ev:'…I was often ill, and doctors advised sport.',e:'Причина — совет врачей из-за частых болезней.'},
 {q:'How often does Alex train?',o:['Every day','Five times a week','Only at weekends'],a:1,ev:'Five times a week, early in the morning before school.',e:'Пять раз в неделю, воскресенье — отдых.'},
 {q:'What happened to Alex last year?',o:['He left his team','He broke his arm','He lost the championship'],a:1,ev:'Last year I broke my arm and missed four months.',e:'Сломал руку и пропустил четыре месяца.'},
 {q:'What does Alex want to do first?',o:['Join the national team','Win the city cup','Become a coach'],a:1,ev:'…but first I want to win the city cup in May.',e:'Сначала — кубок города, сборная — мечта на потом.'}]},
{d:[
 {s:0,t:'Our guest today is Lena, who runs a popular blog about school life. Lena, how did it all begin?'},
 {s:1,t:'Two years ago I started posting short videos with study tips. At first only my classmates watched them.'},
 {s:0,t:'And now you have thousands of followers! How much time does the blog take?'},
 {s:1,t:'About two hours a day. I film in the evening and edit videos at the weekend. My parents help me with the camera.'},
 {s:0,t:'Has the blog changed your life?'},
 {s:1,t:'Yes, I have become more confident. But my marks went down a little last term, so now I plan my time more carefully.'},
 {s:0,t:'What advice can you give to beginners?'},
 {s:1,t:'Do not copy others. Viewers feel when you are honest, and honesty works better than expensive equipment.'}],
 qs:[
 {q:'When did Lena start her blog?',o:['Two years ago','Two months ago','Last term'],a:0,ev:'Two years ago I started posting short videos…',e:'Прямо названо в начале интервью.'},
 {q:'Who helps Lena with her blog?',o:['Her classmates','Her parents','Her teachers'],a:1,ev:'My parents help me with the camera.',e:'С камерой помогают родители.'},
 {q:'What problem did the blog cause?',o:['She lost her friends','Her marks got worse','She stopped sleeping'],a:1,ev:'…my marks went down a little last term…',e:'Оценки немного снизились — пришлось планировать время.'},
 {q:'What does Lena advise beginners?',o:['To buy a good camera','To copy popular bloggers','To be honest'],a:2,ev:'…honesty works better than expensive equipment.',e:'Главный совет — честность, а не дорогая техника.'}]}
];
let LM=null,LT=null,LI=null,LPLAYS=0,LSLOW=false;
function lSt(){S.lis=listeningModule.normalizeState(S.lis);return S.lis}
function lSync(){if(!S)return;var r=lSt(),sum=listeningModule.summary(r),acc=sum.accuracy;
  S.prog=S.prog||{};S.prog.listen=acc;
  setTxt('sub_listen',r.done?('подходов: '+r.done+' · точность '+acc+'%'):'начни с первого диалога');
  setTxt('l_sumline',r.done?('Пройдено '+r.done+' · точность '+acc+'%'):'Три формата — как на экзамене');
  var bar=document.getElementById('l_bar');if(bar)bar.style.width=Math.max(2,acc)+'%'}
function lAnim(name,dur){ui.animate('l_card',name,dur)}
function lStopFallback(){try{speechSynthesis.cancel()}catch(e){}}
function lVoice(i){try{var vs=(speechSynthesis.getVoices()||[]).filter(function(v){return /^en[-_]/i.test(v.lang)});
  if(!vs.length)return null;
  var gb=vs.filter(function(v){return /GB/i.test(v.lang)});
  var pool=gb.length>1?gb:vs;
  return pool[i%pool.length]}catch(e){return null}}
function lPlayRawFallback(lines){
  if(!('speechSynthesis'in window)){try{toast('Озвучка недоступна в этом браузере')}catch(e){}return}
  lStop();
  var us=lines.map(function(ln){var u=new SpeechSynthesisUtterance(ln.t);
    u.lang='en-GB';u.rate=LSLOW?0.68:0.85;u.pitch=ln.s?1.15:0.92;
    var v=lVoice(ln.s);if(v)u.voice=v;return u});
  if(us.length){us[us.length-1].onend=function(){try{lPlayBtn('')}catch(e){}};try{lPlayBtn('play')}catch(e){}}
  us.forEach(function(u){speechSynthesis.speak(u)})}
function lPlay(lines){LPLAYS++;lPlaysUi();lPlayRaw(lines)}
function lPlaysUi(){var el=document.getElementById('l_plays');if(!el)return;
  el.textContent=LPLAYS<=2?('прослушиваний: '+LPLAYS+' из 2'):(LPLAYS+'-е — на ЕГЭ так нельзя!');
  el.style.color=LPLAYS<=2?'#1D7F4A':'#A56000';el.style.background=LPLAYS<=2?'#EAF7F0':'#FFF4DE'}
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
function lCtl(fn){
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    +'<button id="l_playbtn" class="sq" onclick="'+fn+'" style="flex:1;min-width:160px;min-height:54px;display:inline-flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,#FFA570,#F2683F);border:none;border-radius:18px;padding:0 18px;font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#fff;cursor:pointer;box-shadow:0 12px 26px rgba(242,104,63,.35),inset 0 2px 3px rgba(255,255,255,.4),inset 0 -4px 8px rgba(190,55,18,.28);">'
    +'<span id="l_playic" style="display:grid;place-items:center;width:22px;">'+L_PLAYSVG+'</span><span id="l_playtx">Слушать</span></button>'
    +'<button type="button" class="sq" aria-label="Остановить воспроизведение" onclick="lStop()" style="flex:none;width:40px;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:#fff;cursor:pointer;display:grid;place-items:center;"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="#8A8F98"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>'
    +'<button class="sq" onclick="LSLOW=!LSLOW;this.style.background=LSLOW?\'#FFEDE4\':\'#fff\';this.style.color=LSLOW?\'#C2421B\':\'#6A6E75\'" style="flex:none;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:'+(LSLOW?'#FFEDE4':'#fff')+';color:'+(LSLOW?'#E44E20':'#8A8F98')+';padding:0 13px;font-family:Manrope,sans-serif;font-weight:800;font-size:12px;cursor:pointer;">0.7×</button>'
    +'<span id="l_plays" style="flex:none;font-weight:800;font-size:11px;padding:7px 11px;border-radius:14px;color:#6A6E75;background:#F1F2F4;">прослушиваний: 0 из 2</span></div>'}
function lTranscript(lines,evs){
  return '<div class="clayCard" style="padding:15px 16px;margin-bottom:12px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#6A6E75;background:#F1F2F4;padding:5px 10px;border-radius:20px;">ТРАНСКРИПТ · тапни слово для перевода</span>'
    +lines.map(function(ln){
      var hl=(evs||[]).some(function(ev){return ev&&ln.t.indexOf(ev.replace(/^…/,'').replace(/…$/,'').replace(/\.$/,'').slice(0,25))>=0});
      return '<div style="margin-top:8px;font-weight:500;font-size:13px;line-height:1.6;color:#2B2B2B;'+(hl?'background:#FFF4DE;border-radius:8px;padding:5px 8px;':'')+'">'
        +'<b style="color:'+(ln.s?'#3E93A8':'#F2683F')+';">—</b> '+rWordsHtml(ln.t)+'</div>'}).join('')+'</div>'}
function initListening(){if(!S)return;lSync();lHub()}
function lHub(){var area=document.getElementById('l_area');if(!area)return;LM=null;LT=null;LI=null;lStop();
  var r=lSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  function acc(x){return x.tot?Math.round(x.ok/x.tot*100)+'%':'—'}
  function card(fn,title,sub,chip,color,bg){
    return '<button type="button" class="clayCard sq clk cardbtn" onclick="'+fn+'" style="'+ga()+'padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">'+title+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">'+sub+'</div></div>'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:'+color+';background:'+bg+';padding:8px 12px;border-radius:14px;">'+chip+'</span></div></button>'}
  var le=S.lisExam||{};
  var exCard='<button type="button" class="sq clk cardbtn" onclick="lExam()" style="'+ga()+'position:relative;overflow:hidden;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · задания 1–9</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(le.n?('лучший результат: '+le.best+' из 13'):'три задания подряд · запись дважды')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  area.innerHTML=exCard
    +card('lMt()','Соответствия','задание 1 · кто о чём говорит',acc(r.m),'#E44E20','#FFEDE4')
   +card('lTf()','Верно · Неверно · Не сказано','задание 2 · диалог и утверждения',acc(r.tf),'#C77400','#FFF4DE')
   +card('lIq()','Интервью','задания 3–9 · вопросы с выбором',acc(r.iq),'#1F8A50','#EAF7F0')
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#E3F1F5;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#3E93A8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Сначала прочитай вопросы, потом слушай — как на экзамене. Запись можно включить дважды</div></div>';
  setTxt('l_today','3 тренажёра');lGen()}
function lShufM(set){return listeningModule.shuffleMatching(set)}
/* ---- задание 1: соответствия ---- */
function lMt(){S.lisIdxM=(S.lisIdxM||0);var pool=lPool('m',L_M);var set=lShufM(pool[S.lisIdxM%pool.length]);S.lisIdxM++;
  LM={set:set,sel:[null,null,null,null],done:false};LPLAYS=0;lMtRender()}
function lMtLines(){return LM.set.sp.map(function(sp,i){return {s:i%2,t:'Speaker '+'ABCD'[i]+'. '+sp.t}})}
function lMtRender(){var area=document.getElementById('l_area');var set=LM.set;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 1 · СООТВЕТСТВИЯ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай утверждения, послушай четырёх говорящих и подбери соответствия. Одно утверждение лишнее.</div>'
    +set.st.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+(i+1)+'.</b> '+x+'</div>'}).join('')
    +lCtl('lPlay(lMtLines())')+'</div>';
  'ABCD'.split('').forEach(function(L,si){
    h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;">'
      +'<div style="display:flex;align-items:center;gap:8px;">'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:82px;">Говорящий '+L+'</span>'
      +'<div style="flex:1;display:flex;gap:7px;" id="lmt_row_'+si+'">'
      +set.st.map(function(_,ti){var on=LM.sel[si]===ti;
        return '<button onclick="lMtPick('+si+','+ti+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+(ti+1)+'</button>'}).join('')
      +'</div></div><div id="lmt_res_'+si+'"></div></div>'});
  var all=LM.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lMtCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LM.sel.filter(function(x){return x!==null}).length+' / 4 выбрано')}
function lMtPick(si,ti){if(LM.done)return;
  LM.sel=listeningModule.selectUnique(LM.sel,si,ti);
  lMtRender()}
function lMtCheck(){if(LM.done)return;LM.done=true;lStop();var set=LM.set,r=lSt(),okn=0;
  'ABCD'.split('').forEach(function(L,si){var ok=LM.sel[si]===set.a[si];if(ok)okn++;
    r.m.tot++;if(ok)r.m.ok++;
    var el=document.getElementById('lmt_res_'+si);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно ')+(set.a[si]+1)+'. '+set.st[set.a[si]]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>Ключ:</b> '+set.k[si]+'</div></div>';
    var row=document.getElementById('lmt_row_'+si);if(row)row.style.pointerEvents='none'});
  var used={};set.a.forEach(function(x){used[x]=1});
  var extra=[0,1,2,3,4].find(function(i){return !used[i]});
  r.done++;lSync();save();
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===4?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из 4</div>'
    +'<div style="font-weight:600;font-size:12.5px;color:#777163;margin-top:4px;">Лишнее утверждение: '+(extra+1)+'. '+set.st[extra]+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lMt()">Ещё подход</button></div>'
    +lTranscript(lMtLines(),[]);
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- задание 2: True/False/Not stated ---- */
function lTf(){S.lisIdxT=(S.lisIdxT||0);var pool=lPool('tf',L_TF);var set=pool[S.lisIdxT%pool.length];S.lisIdxT++;
  LT={set:set,sel:set.st.map(function(){return null}),done:false};LPLAYS=0;lTfRender()}
function lTfRender(){var area=document.getElementById('l_area');var set=LT.set;
  var LBL=['Верно','Неверно','Не сказано'];
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЗАДАНИЕ 2 · ВЕРНО / НЕВЕРНО / НЕ СКАЗАНО</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай утверждения, послушай диалог и реши: верно, неверно или об этом не говорилось.</div>'
    +lCtl('lPlay(LT.set.d)')+'</div>';
  set.st.forEach(function(x,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+x.t+'</div>'
      +'<div style="margin-top:9px;display:flex;gap:7px;" id="ltf_row_'+i+'">'
      +LBL.map(function(l,li){var on=LT.sel[i]===li;
        return '<button onclick="lTfPick('+i+','+li+')" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:11.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+l+'</button>'}).join('')
      +'</div><div id="ltf_res_'+i+'"></div></div>'});
  var all=LT.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lTfCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LT.sel.filter(function(x){return x!==null}).length+' / '+set.st.length+' отмечено')}
function lTfPick(i,li){if(LT.done)return;LT.sel[i]=li;lTfRender()}
function lTfCheck(){if(LT.done)return;LT.done=true;lStop();var set=LT.set,r=lSt(),okn=0;
  var LBL=['Верно','Неверно','Не сказано'];
  set.st.forEach(function(x,i){var ok=LT.sel[i]===x.a;if(ok)okn++;
    r.tf.tot++;if(ok)r.tf.ok++;
    var el=document.getElementById('ltf_res_'+i);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно · ':'Неверно · правильно: ')+LBL[x.a]+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>В записи:</b> «'+x.ev+'» — '+x.e+'</div></div>';
    var row=document.getElementById('ltf_row_'+i);if(row)row.style.pointerEvents='none'});
  r.done++;lSync();save();
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===set.st.length?'🏆':(okn>=3?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из '+set.st.length+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lTf()">Ещё подход</button></div>'
    +lTranscript(set.d,set.st.map(function(x){return x.ev}));
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- задания 3-9: интервью ---- */
function lIq(){S.lisIdxI=(S.lisIdxI||0);var pool=lPool('iq',L_IN);var set=pool[S.lisIdxI%pool.length];S.lisIdxI++;
  LI={set:set,sel:set.qs.map(function(){return null}),done:false};LPLAYS=0;lIqRender()}
function lIqRender(){var area=document.getElementById('l_area');var set=LI.set;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЗАДАНИЯ 3–9 · ИНТЕРВЬЮ</span>'
    +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Прочитай вопросы, послушай интервью и выбери ответы.</div>'
    +lCtl('lPlay(LI.set.d)')+'</div>';
  set.qs.forEach(function(q,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+q.q+'</div>'
      +'<div style="margin-top:9px;display:flex;flex-direction:column;gap:7px;" id="liq_row_'+i+'">'
      +q.o.map(function(o,oi){var on=LI.sel[i]===oi;
        return '<button onclick="lIqPick('+i+','+oi+')" style="text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:700;font-size:12.5px;color:'+(on?'#E44E20':'#5b5f66')+';cursor:pointer;">'+o+'</button>'}).join('')
      +'</div><div id="liq_res_'+i+'"></div></div>'});
  var all=LI.sel.every(function(x){return x!==null});
  h+='<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);'+(all?'':'opacity:.45;pointer-events:none;')+'" onclick="lIqCheck()">Проверить</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;margin-top:10px;" onclick="lHub()">← К аудированию</button>';
  area.innerHTML=h;lPlaysUi();setTxt('l_today',LI.sel.filter(function(x){return x!==null}).length+' / '+set.qs.length+' отвечено')}
function lIqPick(i,oi){if(LI.done)return;LI.sel[i]=oi;lIqRender()}
function lIqCheck(){if(LI.done)return;LI.done=true;lStop();var set=LI.set,r=lSt(),okn=0;
  set.qs.forEach(function(q,i){var ok=LI.sel[i]===q.a;if(ok)okn++;
    r.iq.tot++;if(ok)r.iq.ok++;
    var el=document.getElementById('liq_res_'+i);
    if(el)el.innerHTML='<div style="margin-top:9px;padding:10px 12px;border-radius:12px;background:'+(ok?'#EAF7F0':'#FDEDEA')+';">'
      +'<div style="font-weight:800;font-size:12.5px;color:'+(ok?'#1F8A50':'#C0392B')+';">'+(ok?'Верно':'Правильно: '+q.o[q.a])+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;"><b>В записи:</b> «'+q.ev+'» — '+q.e+'</div></div>';
    var row=document.getElementById('liq_row_'+i);if(row)row.style.pointerEvents='none'});
  r.done++;lSync();save();
  var area=document.getElementById('l_area');
  var d=document.createElement('div');
  d.innerHTML='<div class="clayCard" style="padding:16px 18px;margin-bottom:12px;text-align:center;animation:win .35s both;">'
    +'<div style="font-size:36px;">'+(okn===set.qs.length?'🏆':(okn>=2?'💪':'📚'))+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:19px;color:#2B2B2B;margin-top:6px;">'+okn+' из '+set.qs.length+'</div>'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:12px;" onclick="lIq()">Ещё подход</button></div>'
    +lTranscript(set.d,set.qs.map(function(q){return q.ev}));
  area.insertBefore(d,area.firstChild);
  try{d.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){};lGen()}
/* ---- экзамен по аудированию: 1 + 2 + 3-9 ---- */
let LE=null;
function lExam(){var area=document.getElementById('l_area');if(!area)return;lStop();
  var st=S.lisExam||{};
  area.innerHTML='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Раздел «Аудирование» целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Соответствия → верно/неверно/не сказано → интервью. Каждую запись можно включить только дважды, разбор — в конце. Максимум 13 баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из 13 · лучший: '+st.best+' из 13</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="lExamStart()">Начать</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="lHub()">← К аудированию</button></div>';
  lAnim('win','.32s')}
function lExamStart(){
  var pm=lPool('m',L_M),pt=lPool('tf',L_TF),pi=lPool('iq',L_IN);
  S.leIdx=(S.leIdx||0);
  LE={m:lShufM(pm[S.leIdx%pm.length]),tf:pt[S.leIdx%pt.length],iq:pi[S.leIdx%pi.length],
      stage:0,selM:[null,null,null,null],plays:[0,0,0],t0:Date.now()};
  LE.selT=LE.tf.st.map(function(){return null});
  LE.selI=LE.iq.qs.map(function(){return null});
  S.leIdx++;LSLOW=false;
  LE.iv=setInterval(function(){if(LE)setTxt('l_today',gExamFmt(Math.floor((Date.now()-LE.t0)/1000)))},1000);
  lExamRender()}
function lExamPlay(){if(!LE)return;
  if(!listeningModule.registerPlay(LE.plays,LE.stage,2)){try{toast('На ЕГЭ запись звучит только дважды')}catch(e){}return}
  var lines=LE.stage===0?LE.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+'ABCD'[i]+'. '+sp.t}}):(LE.stage===1?LE.tf.d:LE.iq.d);
  lPlayRaw(lines);
  var el=document.getElementById('lex_plays');
  if(el){el.textContent='прослушиваний: '+LE.plays[LE.stage]+' из 2';
    el.style.color=LE.plays[LE.stage]>=2?'#A56000':'#1D7F4A';el.style.background=LE.plays[LE.stage]>=2?'#FFF4DE':'#EAF7F0'}}
function lExamCtl(){
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    +'<button id="l_playbtn" class="sq" onclick="lExamPlay()" style="flex:1;min-width:160px;min-height:54px;display:inline-flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,#FFA570,#F2683F);border:none;border-radius:18px;padding:0 18px;font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:16px;color:#fff;cursor:pointer;box-shadow:0 12px 26px rgba(242,104,63,.35),inset 0 2px 3px rgba(255,255,255,.4),inset 0 -4px 8px rgba(190,55,18,.28);">'
    +'<span id="l_playic" style="display:grid;place-items:center;width:22px;">'+L_PLAYSVG+'</span><span id="l_playtx">Слушать</span></button>'
    +'<button type="button" class="sq" aria-label="Остановить воспроизведение" onclick="lStop()" style="flex:none;width:40px;height:40px;border-radius:14px;border:1px solid #F0EAE2;background:#fff;cursor:pointer;display:grid;place-items:center;"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="#8A8F98"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>'
    +'<span id="lex_plays" style="flex:none;font-weight:800;font-size:11px;padding:7px 11px;border-radius:14px;color:'+(LE.plays[LE.stage]>=2?'#C77400':'#1F8A50')+';background:'+(LE.plays[LE.stage]>=2?'#FFF4DE':'#EAF7F0')+';">прослушиваний: '+LE.plays[LE.stage]+' из 2</span></div>'}
function lExamNextBtn(ok,label,fn){
  return '<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);margin-top:4px;'+(ok?'':'opacity:.45;pointer-events:none;')+'" onclick="'+fn+'">'+label+'</button>'}
function lExamRender(){var area=document.getElementById('l_area');if(!area||!LE)return;
  if(LE.stage===0){var set=LE.m;
    var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#C2421B;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 1 ИЗ 3 · СООТВЕТСТВИЯ</span>'
      +set.st.map(function(x,i){return '<div style="margin-top:8px;font-weight:700;font-size:13px;color:#2B2B2B;"><b style="color:#B54E2F;">'+(i+1)+'.</b> '+x+'</div>'}).join('')
      +lExamCtl()+'</div>';
    'ABCD'.split('').forEach(function(L,si){
      h+='<div class="clayCard" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px;">'
        +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;width:82px;">Говорящий '+L+'</span>'
        +'<div style="flex:1;display:flex;gap:7px;">'
        +set.st.map(function(_,ti){var on=LE.selM[si]===ti;
          return '<button onclick="LE.selM['+si+']='+ti+';lExamDedup(\'selM\','+si+','+ti+');lExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:13px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+(ti+1)+'</button>'}).join('')+'</div></div>'});
    h+=lExamNextBtn(LE.selM.every(function(x){return x!==null}),'Дальше → верно/неверно','lStop();LE.stage=1;lExamRender()');
    area.innerHTML=h;return}
  if(LE.stage===1){var set=LE.tf,LBL=['Верно','Неверно','Не сказано'];
    var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 2 ИЗ 3 · ВЕРНО / НЕВЕРНО / НЕ СКАЗАНО</span>'
      +lExamCtl()+'</div>';
    set.st.forEach(function(x,i){
      h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
        +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+x.t+'</div>'
        +'<div style="margin-top:9px;display:flex;gap:7px;">'
        +LBL.map(function(l,li){var on=LE.selT[i]===li;
          return '<button onclick="LE.selT['+i+']='+li+';lExamRender()" style="flex:1;height:36px;border-radius:11px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:800;font-size:11.5px;color:'+(on?'#E44E20':'#8A8F98')+';cursor:pointer;">'+l+'</button>'}).join('')+'</div></div>'});
    h+=lExamNextBtn(LE.selT.every(function(x){return x!==null}),'Дальше → интервью','lStop();LE.stage=2;lExamRender()');
    area.innerHTML=h;return}
  var set=LE.iq;
  var h='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:16px 18px;margin-bottom:12px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;background:#EAF7F0;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · 3 ИЗ 3 · ИНТЕРВЬЮ</span>'
    +lExamCtl()+'</div>';
  set.qs.forEach(function(q,i){
    h+='<div class="clayCard" style="padding:13px 14px;margin-bottom:10px;">'
      +'<div style="font-weight:700;font-size:13px;color:#2B2B2B;line-height:1.5;">'+(i+1)+'. '+q.q+'</div>'
      +'<div style="margin-top:9px;display:flex;flex-direction:column;gap:7px;">'
      +q.o.map(function(o,oi){var on=LE.selI[i]===oi;
        return '<button onclick="LE.selI['+i+']='+oi+';lExamRender()" style="text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid '+(on?'#F2683F':'#F0EAE2')+';background:'+(on?'#FFEDE4':'#fff')+';font-family:Manrope,sans-serif;font-weight:700;font-size:12.5px;color:'+(on?'#E44E20':'#5b5f66')+';cursor:pointer;">'+o+'</button>'}).join('')+'</div></div>'});
  h+=lExamNextBtn(LE.selI.every(function(x){return x!==null}),'Завершить','lExamFinish()');
  area.innerHTML=h}
function lExamDedup(field,idx,val){LE[field]=listeningModule.selectUnique(LE[field],idx,val)}
function lExamFinish(){if(!LE)return;clearInterval(LE.iv);lStop();
  var sec=examModule.elapsedSeconds(LE.t0,Date.now()),r=lSt(),LBL=['Верно','Неверно','Не сказано'];
  var okM=0;LE.m.a.forEach(function(a,si){r.m.tot++;if(LE.selM[si]===a){okM++;r.m.ok++}});
  var okT=0;LE.tf.st.forEach(function(x,i){r.tf.tot++;if(LE.selT[i]===x.a){okT++;r.tf.ok++}});
  var okI=0;LE.iq.qs.forEach(function(q,i){r.iq.tot++;if(LE.selI[i]===q.a){okI++;r.iq.ok++}});
  var total=okM+okT+okI;
  S.lisExam=examModule.record(S.lisExam,total);
  var rows='';
  LE.m.a.forEach(function(a,si){if(LE.selM[si]!==a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Говорящий '+'ABCD'[si]+' → '+(a+1)+'. '+LE.m.st[a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+LE.m.k[si]+'</div></div>'});
  LE.tf.st.forEach(function(x,i){if(LE.selT[i]!==x.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Утверждение '+(i+1)+' → '+LBL[x.a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+x.ev+'» — '+x.e+'</div></div>'});
  LE.iq.qs.forEach(function(q,i){if(LE.selI[i]!==q.a)
    rows+='<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;"><div style="font-weight:800;font-size:12.5px;color:#A83226;">Вопрос '+(i+1)+' → '+q.o[q.a]+'</div><div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">«'+q.ev+'»</div></div>'});
  var tr1=lTranscript(LE.m.sp.map(function(sp,i){return{s:i%2,t:'Speaker '+'ABCD'[i]+'. '+sp.t}}),[]);
  var tr2=lTranscript(LE.tf.d,LE.tf.st.map(function(x){return x.ev}));
  var tr3=lTranscript(LE.iq.d,LE.iq.qs.map(function(q){return q.ev}));
  LE=null;r.done++;lSync();save();
  var parts=[['Соответствия',okM,4],['Верно/неверно',okT,5],['Интервью',okI,4]];
  var max=examModule.maxScore(parts),weak=examModule.weakestSection(parts);
  var area=document.getElementById('l_area');
  area.innerHTML='<div id="l_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(total,max)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:22px;color:#2B2B2B;margin-top:8px;">'+total+' из '+max+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+gExamFmt(sec)+' · '+examModule.sectionLine(parts)+'</div>'
    +(total<max?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+weak.label.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div>'+(rows?'<div style="margin-top:12px;">'+rows+'</div>':'')+'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +'<button class="sq" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#FFA570,#F2683F)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(242,104,63,.32);" onclick="lExamStart()">Ещё раз</button>'
    +'<button class="sq" style="'+WBTN+'color:#B54E2F;" onclick="lHub()">К аудированию</button></div>'
    +tr1+tr2+tr3;
  lAnim('win','.32s');lGen()}
/* ---- фоновая ИИ-генерация комплектов аудирования ---- */
function lPool(kind,base){var ai=(S&&S.lisAi&&S.lisAi[kind])||[];return listeningModule.pool(base,ai)}
var L_GEN=false;
async function lGen(){
  if(L_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.lisAi=S.lisAi||{m:[],tf:[],iq:[]};
  var kind=null;
  if(lPool('m',L_M).length<5)kind='m';
  else if(lPool('tf',L_TF).length<5)kind='tf';
  else if(lPool('iq',L_IN).length<5)kind='iq';
  if(!kind)return;L_GEN=true;
  try{
    var d,item=null;
    if(kind==='m'){
      d=await generateAiContent('listening_matching');
      if(d&&Array.isArray(d.st)&&d.st.length===5&&Array.isArray(d.sp)&&d.sp.length===4
        &&Array.isArray(d.a)&&d.a.length===4&&d.a.every(function(x){return x>=0&&x<5})&&new Set(d.a.map(Number)).size===4
        &&Array.isArray(d.k)&&d.k.length===4&&d.sp.every(function(s){return s&&s.t})){
        item={st:d.st.map(String),sp:d.sp.map(function(s){return{t:String(s.t)}}),a:d.a.map(Number),k:d.k.map(String)}}
    }else if(kind==='tf'){
      d=await generateAiContent('listening_true_false');
      if(d&&Array.isArray(d.d)&&d.d.length>=5&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.st)&&d.st.length===5
        &&d.st.every(function(x){return x&&x.t&&x.a>=0&&x.a<3&&x.ev&&x.e})
        &&d.st.some(function(x){return +x.a===2})){
        item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),st:d.st.map(function(x){return{t:String(x.t),a:+x.a,ev:String(x.ev),e:String(x.e)}})}}
    }else{
      d=await generateAiContent('listening_interview');
      if(d&&Array.isArray(d.d)&&d.d.length>=6&&d.d.every(function(x){return x&&x.t&&(x.s===0||x.s===1)})
        &&Array.isArray(d.qs)&&d.qs.length===4
        &&d.qs.every(function(q){return q&&q.q&&Array.isArray(q.o)&&q.o.length===3&&q.a>=0&&q.a<3&&q.ev&&q.e})){
        item={d:d.d.map(function(x){return{s:+x.s,t:String(x.t)}}),qs:d.qs.map(function(q){return{q:String(q.q),o:q.o.map(String),a:+q.a,ev:String(q.ev),e:String(q.e)}})}}
    }
    if(item){S.lisAi[kind]=(S.lisAi[kind]||[]).concat([item]);save()}
  }catch(e){}
  L_GEN=false;
  try{var need=lPool('m',L_M).length<5||lPool('tf',L_TF).length<5||lPool('iq',L_IN).length<5;
    if(need)setTimeout(lGen,4000)}catch(e){}}
/* FAB прячем, звук глушим при уходе, синк при старте */
registerRouteHook(function(id){lStop();if(LE&&LE.iv){clearInterval(LE.iv);LE=null}if(id==='scr4'){var f=document.getElementById('genfab');if(f)f.style.display='none'}});
registerStartHook(function(){return lSync()});

/* legacy block 10 */
/* ===== WRITING v2: банк тем, стимулы как на ЕГЭ, шпаргалки, черновики, история ===== */
const W37=[
{from:'Emily',stim:'…We moved to a new flat last month, and I had to change my school too. Have you ever changed schools? How do you usually make new friends? What do you like most about your school?… Oh, my mum is calling me. Write back soon!',ask:'her new flat'},
{from:'Ben',stim:'…Last weekend I tried cooking for the first time and made pasta for the whole family! What food can you cook? Do you help your parents about the house? What do you usually do at weekends?… Sorry, I have to walk my dog now.',ask:'his dog'},
{from:'Kate',stim:'…I have just come back from my first real football match — our school team won! Do you do any sport? How much free time do you have on school days? Where do you like spending your holidays?… Got to go, my dad needs the laptop.',ask:'the football match'}
];
const W38=[
{topic:'Why teenagers do sport',rows:[['To keep fit',45],['To meet friends',25],['To achieve results and win',18],['Other reasons',12]]},
{topic:'How teenagers spend their free time',rows:[['Playing computer games',40],['Doing sport',25],['Reading books and blogs',15],['Creative hobbies',12],['Other activities',8]]},
{topic:'The most important school subjects according to students',rows:[['Maths',35],['Foreign languages',30],['Science',20],['Literature',10],['Other subjects',5]]}
];
let W_SHEET=false,_wrBound=false;
function wrPool(t){var ai=(S&&S.writeAi&&S.writeAi['t'+t])||[];return writingModule.pool(t===37?W37:W38,ai)}
function wrIdx(t){return (t===37?(S.wIdx37||0):(S.wIdx38||0))}
function wrCur(){return writingModule.current(wrPool(curTask),wrIdx(curTask))}
function wrKey(){return writingModule.draftKey(curTask,wrIdx(curTask))}
function wrNext(){if(curTask===37)S.wIdx37=(S.wIdx37||0)+1;else S.wIdx38=(S.wIdx38||0)+1;
  W_SHEET=false;save();setTask(curTask);wrGen()}
function wrSheet(){W_SHEET=!W_SHEET;setTask(curTask)}
function wrHistHtml(){var ws=(S.works||[]).slice(-3).reverse();
  if(!ws.length)return '<div style="margin-top:12px;">'
    +ui.stateMarkup({kind:'empty',title:'Проверенных работ пока нет',
      description:'Напиши ответ и нажми «Проверить» — разбор появится здесь'})+'</div>';
  return '<div style="margin-top:12px;border-top:1px solid #F4EFE9;padding-top:10px;">'
    +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#6F695E;">ПОСЛЕДНИЕ РАБОТЫ</div>'
    +ws.map(function(w){var d=new Date(w.ts);
      return '<div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:600;font-size:12px;color:#4A453E;">'
        +'<span>Задание '+w.t+' · '+('0'+d.getDate()).slice(-2)+'.'+('0'+(d.getMonth()+1)).slice(-2)+'</span>'
        +'<span style="font-weight:800;color:'+(w.g/w.m>=0.7?'#1D7F4A':(w.g/w.m>=0.4?'#A56000':'#A83226'))+';">'+w.g+' из '+w.m+'</span></div>'}).join('')+'</div>'}
const W_SHEET37='<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">КАК ПИСАТЬ ПИСЬМО · ПОШАГОВО</div>'
 +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.7;margin-top:8px;">'
 +'Письмо собирается как конструктор из 7 частей — иди по шагам:<br><br>'
 +'<b>1. Поздоровайся.</b> На отдельной строке: <i>Dear Emily,</i><br><br>'
 +'<b>2. Поблагодари за письмо</b> (1-2 предложения): <i>Thanks a lot for your email! It was great to hear from you again.</i><br><br>'
 +'<b>3. Ответь на все 3 вопроса друга.</b> Перечитай письмо сверху — в нём три вопроса со знаком «?». На каждый ответь 1-2 предложениями. Пропустишь вопрос — потеряешь баллы.<br><br>'
 +'<b>4. Задай свои 3 вопроса</b> о том, что выделено в задании жирным. Например, о новой квартире: <i>By the way, what is your new flat like? How many rooms are there? Is it far from your school?</i><br><br>'
 +'<b>5. Объясни, почему заканчиваешь:</b> <i>Anyway, I have to go now — it is time for my English lesson.</i><br><br>'
 +'<b>6. Пожелай на прощание:</b> <i>Hope to hear from you soon!</i><br><br>'
 +'<b>7. Подпишись.</b> На отдельной строке <i>Best wishes,</i> и ниже только имя без точки: <i>Anya</i><br><br>'
 +'<b>Перед отправкой проверь:</b> 100–140 слов · ровно три «?» в твоих вопросах · без адреса и даты — в электронном письме они не нужны.</div>';
const W_SHEET38='<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">КАК ПИСАТЬ ПРОЕКТ · ПОШАГОВО</div>'
 +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.7;margin-top:8px;">'
 +'Это сочинение по данным опроса из таблицы. Ровно <b>5 абзацев</b>, у каждого своя задача:<br><br>'
 +'<b>1. Вступление — зачем этот проект:</b> <i>I am currently working on a project on why teenagers do sport. I have found a table with the results of a survey, and I would like to comment on the data.</i><br><br>'
 +'<b>2. Назови 2-3 цифры из таблицы своими словами:</b> <i>According to the data, almost half of the teenagers (45%) do sport to keep fit.</i> Дословно переписывать строки таблицы нельзя!<br><br>'
 +'<b>3. Сравни 1-2 показателя:</b> <i>Keeping fit is almost twice as popular as meeting friends — 45% against 25%.</i><br><br>'
 +'<b>4. Назови проблему по теме и предложи решение:</b> <i>However, many teenagers give up sport because of school workload. A possible solution is short workouts at home.</i><br><br>'
 +'<b>5. Вывод + твоё мнение:</b> <i>In conclusion, I strongly believe that sport plays an important role in teenagers\u0027 lives.</i><br><br>'
 +'<b>Перед отправкой проверь:</b> 200–250 слов · мнение только во вступлении и выводе · пять абзацев на месте.</div>';
/* — перерисовка карточки задания — */
function setTask(n){curTask=n;var d=WRITE[n],tp=wrCur();
  var s37=document.getElementById('w_seg37'),s38=document.getElementById('w_seg38');
  if(s37)s37.setAttribute('style',n===37?SEG_ON:SEG_OFF);
  if(s38)s38.setAttribute('style',n===38?SEG_ON:SEG_OFF);
  setTxt('w_tasklabel',n===37?'ЗАДАНИЕ 37 · ПИСЬМО ДРУГУ':'ЗАДАНИЕ 38 · ПРОЕКТ С ДАННЫМИ');
  var th=document.getElementById('w_tablehint');if(th)th.style.display='none';
  var p=document.getElementById('w_prompt');
  if(p){var h='';
    if(n===37){
      h+='<div style="background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">From: '+tp.from+'<br>'+tp.stim+'</div>'
        +'<div style="margin-top:9px;font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.5;">Напиши ответ (100–140 слов): ответь на 3 вопроса '+tp.from+' и задай <b>3 вопроса</b> about <b>'+tp.ask+'</b>.</div>';
    }else{
      h+='<div style="font-weight:600;font-size:13px;color:#2B2B2B;line-height:1.5;">Imagine you are doing a project «<b>'+tp.topic+'</b>». You have found some data (see the table). Comment on the data and give your opinion (200–250 слов).</div>'
        +'<div style="margin-top:9px;background:#FAF6F1;border-radius:14px;padding:6px 13px;">'
        +tp.rows.map(function(r){return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #F0E9E0;font-weight:600;font-size:12.5px;color:#4A453E;"><span>'+r[0]+'</span><b style="color:#C2421B;">'+r[1]+'%</b></div>'}).join('')+'</div>';
    }
    h+='<div style="margin-top:11px;display:flex;gap:8px;">'
      +'<button type="button" class="clk sq iconbtn" onclick="wrNext()" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Новая тема</button>'
      +'<button type="button" class="clk sq iconbtn" onclick="wrSheet()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(W_SHEET?'Скрыть шпаргалку':'Шпаргалка')+'</button></div>';
    if(W_SHEET)h+='<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;">'+(n===37?W_SHEET37:W_SHEET38)+'</div>';
    h+=wrHistHtml();
    p.innerHTML=h;
  }
  /* черновик */
  var ed=document.getElementById('w_editor');
  if(ed){S.drafts=S.drafts||{};ed.innerText=S.drafts[wrKey()]||'';
    if(!_wrBound){_wrBound=true;
      ed.addEventListener('input',function(){S.drafts=S.drafts||{};S.drafts[wrKey()]=ed.innerText;save()})}}
  countWords()}
/* — проверка ИИ: актуальные критерии + контекст темы + история — */
async function checkWriting(){
  var t=(document.getElementById('w_editor').innerText||'').trim();
  var n=writingModule.countWords(t);
  if(n<10){alert('Напиши хотя бы несколько предложений.');return}
  tab('scr13');var task=curTask,tp=wrCur();
  if(DEMO_MODE){renderReview(localReview(n,task,'демо-режим'));showScreen('scr12');HIST.push('scr8');return}
  try{
    var payload=writingModule.buildPayload(task,tp,t);
    var response=await apiPost('/api/v1/ai/evaluate-writing',payload,true);
    var d=response&&response.review;
    if(!d||!d.criteria)throw new Error('bad');
    wrStore(d,n,task);
    renderReview(d);S.essays=(S.essays||0)+1;save();showScreen('scr12');HIST.push('scr8');
  }catch(e){renderReview(localReview(n,task,e.message));showScreen('scr12');HIST.push('scr8')}}
function wrStore(d,n,task){
  S.works=writingModule.appendWork(S.works,{t:task,g:+d.overall_got||0,m:+d.overall_max||writingModule.limits(task).maxScore,n:n,ts:Date.now()});
  var sum=writingModule.summary(S.works),avg=sum.average;
  S.prog=S.prog||{};S.prog.write=avg;
  setTxt('sub_write','работ: '+sum.count+' · средний '+avg+'%');
  try{setTxt('m_write',avg);ringOff('ring_write',113.1,avg)}catch(e){}}
function wrSyncTile(){if(!S)return;var sum=writingModule.summary(S.works);
  if(!sum.count){setTxt('sub_write','задания 37–38 · ИИ');return}
  S.prog=S.prog||{};S.prog.write=sum.average;
  setTxt('sub_write','работ: '+sum.count+' · средний '+sum.average+'%')}
/* — фоновая ИИ-генерация тем — */
var WR_GEN=false;
async function wrGen(){
  if(WR_GEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.writeAi=S.writeAi||{t37:[],t38:[]};
  var kind=null;
  if(wrPool(37).length<6)kind=37;else if(wrPool(38).length<6)kind=38;
  if(!kind)return;WR_GEN=true;
  try{
    var d=await generateAiContent(kind===37?'writing_task_37':'writing_task_38');
    var item=writingModule.normalizeGenerated(kind,d);
    if(item){S.writeAi['t'+kind].push(item);save()}
  }catch(e){}
  WR_GEN=false;
  try{if(wrPool(37).length<6||wrPool(38).length<6)setTimeout(wrGen,4000)}catch(e){}}
/* — запуск генерации при входе, синк плитки при старте — */
registerRouteHook(function(id){if(id==='scr8'){setTask(curTask);wrGen()}});
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
/* ===== SPEAKING v2: устная часть ЕГЭ, 4 задания ===== */
const SP1=[
{tx:'Libraries are changing fast. Twenty years ago they were quiet places with paper books only. Today a modern library offers computers, online courses and clubs for different hobbies. People come here not only to read, but also to meet friends, work on projects or listen to interesting lectures. Many libraries stay open late in the evening, so students often do their homework there. Scientists say that such places help people of all ages to keep learning through the whole life.'},
{tx:'Walking is the easiest kind of sport. You do not need special equipment, a gym or a trainer — only comfortable shoes. Doctors say that thirty minutes of walking a day make the heart stronger, improve sleep and even help the brain to work better. Walking with friends is also a great way to spend time together. Some schools now organise walking clubs, where students discover interesting places in their city and learn to notice the beauty around them.'}];
const SP2=[
{ad:'Language Summer Camp «Sunny Hills». English every day with native speakers, sports and new friends! Join us this summer!',
 points:['dates of the course','price','number of lessons a day','accommodation'],
 exq:['When does the course start?','How much does the course cost?','How many lessons a day are there?','Where will the students live?']},
{ad:'New Fitness Club «Energy» is open in your district! Modern gym, swimming pool and yoga classes for teenagers.',
 points:['opening hours','monthly fee','age requirements','personal trainer availability'],
 exq:['What are the opening hours?','How much is a monthly membership?','How old should I be to join the club?','Can I train with a personal trainer?']}];
const SP3=[
{topic:'Хобби и свободное время',qs:['What do you usually do in your free time?','Why do teenagers need hobbies?','What new hobby would you like to try and why?','Do you prefer spending free time alone or with friends? Why?','What can a hobby teach a person?']},
{topic:'Школьная жизнь',qs:['What is your favourite school subject and why?','How much time do you usually spend on homework?','What would you like to change in your school?','Why is it important to get a good education?','What are you going to do after leaving school?']}];
const SP4=[
{topic:'Зимние каникулы',ph:['Фото 1: семья катается на лыжах в горах в солнечный день','Фото 2: девушка читает книгу у камина дома'],
 plan:['кратко опиши обе фотографии — что на них происходит','скажи, что общего у этих фотографий','скажи, чем они различаются','скажи, какой отдых ближе тебе, и объясни почему']},
{topic:'Еда дома и в кафе',ph:['Фото 1: мама с сыном вместе готовят ужин на кухне','Фото 2: друзья едят пиццу в кафе'],
 plan:['кратко опиши обе фотографии','скажи, что общего у фотографий','скажи, чем они различаются','скажи, что предпочитаешь ты, и объясни почему']}];
const SP_CONF={1:speakingModule.config(1),2:speakingModule.config(2),3:speakingModule.config(3),4:speakingModule.config(4)};
const SP_SHEET={
1:'<b>Как читать вслух на 1 балл:</b><br>— Во время подготовки прочитай текст про себя и отметь трудные слова.<br>— Читай по смысловым кусочкам, с паузами на запятых и точках.<br>— Не глотай окончания <i>-s</i> и <i>-ed</i>: he work<b>s</b>, play<b>ed</b>.<br>— Вопросы читай с восходящей интонацией, утверждения — с нисходящей.<br>— Лучше чуть медленнее, но чётко: ошибки в словах = потеря балла.',
2:'<b>Как задавать прямые вопросы:</b><br>Каждый пункт превращай в ПРЯМОЙ вопрос:<br>— цена → <i>How much does it cost?</i><br>— даты → <i>When does the course start?</i><br>— место → <i>Where is the club located?</i><br>— возможность → <i>Can I…? / Is it possible to…?</i><br><b>Ловушки:</b> «What about the price?» — НЕ вопрос, балл не дадут. Вопрос «зачитыванием пункта» (price?) — тоже. Нужен полный вопрос с вспомогательным глаголом.',
3:'<b>Как отвечать на вопросы интервью:</b><br>— Отвечай развёрнуто: 2-3 предложения, а не «Yes, I do».<br>— Формула: прямой ответ → причина → пример. <i>I usually read in my free time. It helps me to relax. For example, last week I finished a great detective story.</i><br>— Не молчи: если нужно время, начни с <i>Well, let me think…</i><br>— Следи за временем вопроса: «What did you do…» → отвечай в прошедшем.',
4:'<b>Скелет монолога (2,5–3 минуты):</b><br>1. Вступление: <i>I have found two photos for our project about…</i><br>2. Описание: <i>In the first photo we can see… In the second photo there is…</i><br>3. Общее: <i>Both photos show… / What these photos have in common is…</i><br>4. Различия: <i>The main difference is that… while…</i><br>5. Мнение: <i>As for me, I prefer… because…</i><br>6. Финал: <i>That is all I wanted to say.</i><br><b>Ловушка:</b> пропустил пункт плана — минус баллы за решение задачи.'};
let SP=null,SP_rec=null,SP_chunks=[],SP_tm=null,SP_sheet=false;
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
function spAnim(n,d){ui.animate('s9_card',n,d)}
function spMime(){return speakingModule.preferredMimeType(window.MediaRecorder)}
function spFmt(s){return speakingModule.formatTime(s)}
function spStopAll(){clearInterval(SP_tm);SP_tm=null;
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  try{lStop()}catch(e){}}
function spReleaseRecording(){if(SP&&SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}if(SP){SP.url=null;SP.blob=null}SP_chunks=[]}
function initSpeaking(){if(!S)return;spStopAll();spReleaseRecording();SP=null;spSync();spHub()}
function spHub(){var area=document.getElementById('s9_area');if(!area)return;
  var r=spSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var se=S.spkExam||{};
  var exCard='<button type="button" class="sq clk" onclick="spExam()" style="'+ga()+'position:relative;overflow:hidden;width:100%;border:0;text-align:left;font:inherit;border-radius:24px;padding:16px 18px;margin-bottom:12px;cursor:pointer;background:linear-gradient(150deg,#3A3532,#2B2B2B);box-shadow:0 14px 28px rgba(43,35,30,.32),inset 0 2px 3px rgba(255,255,255,.14),inset 0 -5px 10px rgba(0,0,0,.35);">'
    +'<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 346 80" preserveAspectRatio="xMidYMid slice">'
    +'<g fill="rgba(255,255,255,.75)">'
    +'<path class="eb5sp" style="animation-delay:.3s" d="M22,14 Q22,17.5 25.5,17.5 Q22,17.5 22,21 Q22,17.5 18.5,17.5 Q22,17.5 22,14 Z"/>'
    +'<path class="eb5sp" style="animation-delay:1.4s" d="M210,12 Q210,15 213,15 Q210,15 210,18 Q210,15 207,15 Q210,15 210,12 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.9s" d="M180,58 Q180,61 183,61 Q180,61 180,64 Q180,61 177,61 Q180,61 180,58 Z"/>'
    +'</g><g fill="rgba(255,178,76,.85)">'
    +'<path class="eb5sp" style="animation-delay:1.9s" d="M250,30 Q250,34 254,34 Q250,34 250,38 Q250,34 246,34 Q250,34 250,30 Z"/>'
    +'<path class="eb5sp" style="animation-delay:.6s" d="M60,54 Q60,57.5 63.5,57.5 Q60,57.5 60,61 Q60,57.5 56.5,57.5 Q60,57.5 60,54 Z"/>'
    +'</g></svg>'
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#fff;">Экзамен · устная часть</div>'
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(se.n?('лучший результат: '+se.best+' из '+speakingModule.EXAM_MAX):'4 задания подряд, оценка ИИ')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  area.innerHTML=exCard+[1,2,3,4].map(function(t){var c=SP_CONF[t];
    return '<button type="button" class="clayCard sq clk" onclick="spOpen('+t+')" style="'+ga()+'width:100%;border:0;text-align:left;font:inherit;padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">'+c.name+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">'+c.sub+'</div></div>'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;background:#FFEDE4;padding:8px 12px;border-radius:14px;">'+(r['t'+t].n||'—')+'</span></div></button>'}).join('')
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#FBE9EF;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#D4537E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Сначала подготовка по таймеру, потом запись — тайминги как на настоящем экзамене</div></div>';
  setTxt('s9_today','4 задания');spGen()}
function spPool(t){var ai=(S&&S.spkAi&&S.spkAi['p'+t])||[];return speakingModule.pool([SP1,SP2,SP3,SP4][t-1],ai)}
function spSet(t){var k='spIdx'+t;S[k]=(S[k]||0);return speakingModule.select(spPool(t),S[k])}
function spNextSet(t){S['spIdx'+t]=(S['spIdx'+t]||0)+1;save()}
function spOpen(t){spReleaseRecording();SP={t:t,set:spSet(t),phase:'intro',qi:0,url:null};SP_sheet=false;spRender()}
function spBtn(label,fn,solid){return '<button class="sq" style="'+WBTN+(solid?'background:linear-gradient(135deg,#FFA570,#F2683F);color:#fff;border:none;box-shadow:0 12px 24px rgba(242,104,63,.32);':'color:#B54E2F;')+'" onclick="'+fn+'">'+label+'</button>'}
function spTimerChip(){return '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;">'
  +'<span id="s9_timer" style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;">'+spFmt(SP.left)+'</span></div>'
  +'<div style="margin-top:8px;height:7px;border-radius:5px;background:#F1EDE7;"><div id="s9_tbar" style="width:100%;height:100%;border-radius:5px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'}
function spTick(total,onEnd){clearInterval(SP_tm);
  SP_tm=setInterval(function(){if(!SP){clearInterval(SP_tm);return}
    SP.left--;setTxt('s9_timer',spFmt(SP.left));
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SP.left/total*100))+'%';
    setTxt('s9_today',spFmt(SP.left));
    if(SP.left<=0){clearInterval(SP_tm);onEnd()}},1000)}
function spRender(){var area=document.getElementById('s9_area');if(!area||!SP)return;
  var t=SP.t,c=SP_CONF[t],set=SP.set;
  /* ---- интро ---- */
  if(SP.phase==='intro'){
    var body='';
    if(t===1)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Прочитай текст вслух. Подготовка — '+spFmt(c.prep)+', чтение — до '+spFmt(c.rec)+'.</div>';
    if(t===2)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Изучи объявление и задай <b>4 прямых вопроса</b> по пунктам. Подготовка — '+spFmt(c.prep)+', на каждый вопрос — 20 секунд.</div>';
    if(t===3)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Интервью на тему «'+set.topic+'». Услышишь 5 вопросов — на каждый отвечай развёрнуто, до 40 секунд. Подготовки нет, как на экзамене.</div>';
    if(t===4)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Голосовое сообщение другу: сравни две фотографии по плану. Подготовка — '+spFmt(c.prep)+', монолог — до '+spFmt(c.rec)+'.</div>';
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+c.sub.toUpperCase()+'</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:10px;">'+c.name+'</div>'
      +'<div style="margin-top:8px;">'+body+'</div>'
      +'<div style="margin-top:11px;display:flex;gap:8px;">'
      +'<button type="button" class="clk sq iconbtn" onclick="spNextSet(SP.t);spOpen(SP.t)" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Другой вариант</button>'
      +'<button type="button" class="clk sq iconbtn" onclick="SP_sheet=!SP_sheet;spRender()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(SP_sheet?'Скрыть шпаргалку':'Шпаргалка')+'</button></div>'
      +(SP_sheet?'<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.65;">'+SP_SHEET[t]+'</div>':'')
      +'</div>'
      +spBtn(c.prep?'Начать подготовку':'Начать интервью','spPrep()',true)
      +'<div style="height:10px;"></div>'
      +spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');setTxt('s9_today',c.name);return}
  /* ---- подготовка ---- */
  if(SP.phase==='prep'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ПОДГОТОВКА</span>'
      +spTaskBody()
      +spTimerChip()+'</div>'
      +spBtn('Готово — к записи','spRec()',true)
      +'<div style="height:10px;"></div>'
      +spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  /* ---- запись ---- */
  if(SP.phase==='rec'){
    var head=SP.t===3
      ?'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+(SP.qi+1)+' из 5</div>'
       +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+SP.set.qs[SP.qi]+'</div>'
       +'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Озвучить вопрос</button></div>'
      :spTaskBody();
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">● ИДЁТ ЗАПИСЬ</span>'
      +head+spTimerChip()+'</div>'
      +(SP.t===3&&SP.qi<4?spBtn('Следующий вопрос →','spNextQ()',true)+'<div style="height:10px;"></div>':'')
      +spBtn(SP.t===3&&SP.qi>=4?'Завершить интервью':'Стоп — закончить запись','spFinish()',SP.t===3)
      ;
    return}
  /* ---- результат ---- */
  if(SP.phase==='done'){var r=spSt();
    var extra='';
    if(t===1)extra='<div style="height:10px;"></div>'+spBtn('🔊 Эталон диктора','spEtalon()');
    if(t===2)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ОБРАЗЦЫ ВОПРОСОВ</div>'
      +set.points.map(function(p,i){return '<div style="margin-top:8px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;"><b>'+(i+1)+'. '+p+':</b><br><i>'+set.exq[i]+'</i></div>'}).join('')+'</div>';
    if(t===4)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ПРОВЕРЬ СЕБЯ</div>'
      +set.plan.map(function(p,i){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'?</div>'}).join('')+'</div>';
    if(t===3)extra='<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ВОПРОСЫ ИНТЕРВЬЮ</div>'
      +set.qs.map(function(q,i){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+q+'</div>'}).join('')+'</div>';
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">🎙️</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Запись готова!</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай себя со стороны и сверься со шпаргалкой.<br>Тренировок в этом задании: '+r['t'+t].n+'</div></div>'
      +'<div style="height:12px;"></div>'
      +(SP.url?spBtn('▶ Послушать свою запись','spPlay()',true):'<div style="text-align:center;font-weight:600;font-size:12.5px;color:#A83226;">Запись не получилась — проверь доступ к микрофону</div>')
      +(SP.blob?'<div style="height:10px;"></div><button class="sq" onclick="spEval(this)" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#6FC2B0,#1F9E5A)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(31,158,90,.3);">✨ Оценить с ИИ по критериям</button>':'')
      +(SP.blob?'<div style="height:10px;"></div>'+spBtn('Удалить запись','spDeleteRecording()'):'')
      +(SP.t>1?'<div style="height:10px;"></div>'+spBtn('Образец ответа от ИИ','spSample(this)'):'')
      +'<div id="sp_evalbox"></div>'
      +extra
      +'<div style="height:10px;"></div>'+spBtn('Ещё раз','spNextSet(SP.t);spOpen(SP.t)')
      +'<div style="height:10px;"></div>'+spBtn('К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');setTxt('s9_today',SP_CONF[t].name);return}}
function spTaskBody(){var t=SP.t,set=SP.set;
  if(t===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+set.tx+'</div>';
  if(t===2)return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+set.ad+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(i+1)+'. '+p+'</div>'}).join('');
  if(t===4)return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('');
  return ''}
function spPrep(){var c=SP_CONF[SP.t];
  if(!c.prep){spRec();return}
  SP.phase='prep';SP.left=c.prep;spRender();
  spTick(c.prep,function(){spRec()})}
async function spRec(){var c=SP_CONF[SP.t];
  clearInterval(SP_tm);
  spReleaseRecording();
  try{
    var st=await navigator.mediaDevices.getUserMedia({audio:true});
    var mime=spMime();
    SP_rec=mime?new MediaRecorder(st,{mimeType:mime}):new MediaRecorder(st);SP_chunks=[];
    SP_rec.ondataavailable=function(e){SP_chunks.push(e.data)};
    SP_rec.onstop=function(){var tp=SP_rec.mimeType||(SP_chunks[0]&&SP_chunks[0].type)||'';
      var bl=tp?new Blob(SP_chunks,{type:tp}):new Blob(SP_chunks);SP.blob=bl;SP.url=URL.createObjectURL(bl);st.getTracks().forEach(function(x){x.stop()});
      if(SP.phase==='done')spRender()};
    SP_rec.start();
  }catch(e){SP.url=null;SP.phase='intro';spRender();try{toast('Нет доступа к микрофону. Разреши доступ в настройках браузера и попробуй снова.')}catch(_){}return}
  SP.phase='rec';SP.left=c.rec;SP.qi=0;spRender();
  if(SP.t===3){try{lPlayRaw([{s:1,t:SP.set.qs[0]}])}catch(e){}}
  spTick(c.rec,function(){SP.t===3?spNextQ():spFinish()})}
function spNextQ(){if(!SP)return;
  if(SP.qi>=4){spFinish();return}
  SP.qi++;SP.left=SP_CONF[3].rec;spRender();
  try{lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])}catch(e){}
  spTick(SP_CONF[3].rec,function(){SP.qi>=4?spFinish():spNextQ()})}
function spFinish(){if(!SP)return;clearInterval(SP_tm);try{lStop()}catch(e){}
  var r=spSt();r['t'+SP.t].n++;spNextSet(SP.t);
  SP.phase='done';
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  spSync();save();spRender()}
var SP_audio=null;
function spPlay(){if(!SP||!SP.url)return;
  try{lStop()}catch(e){}
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  SP_audio=new Audio(SP.url);
  SP_audio.onerror=function(){try{toast('Не удалось воспроизвести запись — попробуй записать ещё раз')}catch(e){}};
  SP_audio.play().catch(function(){try{toast('Браузер не дал воспроизвести — нажми ещё раз')}catch(e){}})}
function spDeleteRecording(){if(!SP)return;if(SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}SP.url=null;SP.blob=null;SP_chunks=[];spRender();try{toast('Запись удалена')}catch(e){}}
function spEtalon(){if(!SP||SP.t!==1)return;
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  var parts=speakingModule.sentences(SP.set.tx).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 2: расшифровка и оценка ИИ ---- */
async function spSTT(blob){
  var j=await apiPostBinary('/api/stt',blob,blob.type||'application/octet-stream');
  return j.text||''}
function spAssignment(t,set){return speakingModule.assignment(t,set)}
async function spEval(btn){
  if(!SP||!SP.blob)return;
  if(btn){if(btn.dataset.busy)return;btn.dataset.busy=1;btn.textContent='Расшифровываю запись…';btn.style.pointerEvents='none'}
  try{
    var tr=await spSTT(SP.blob);
    if(!speakingModule.isTranscriptUsable(tr))throw new Error('речь не распознана — говори громче и ближе к микрофону');
    if(btn)btn.textContent='Оцениваю по критериям…';
    var response=await apiPost('/api/v1/ai/evaluate-speaking',{taskType:SP.t,transcript:tr,assignment:spAssignment(SP.t,SP.set)},true);
    var d=response.review;
    if(!d||typeof d.got==='undefined')throw new Error('ИИ вернул неожиданный ответ, попробуй ещё раз');
    var score=speakingModule.clampScore(d,SP.t);d.got=score.got;d.max=score.max;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:SP.t,g:d.got,m:d.max,ts:Date.now()});
    spSync();save();
    if(btn){btn.style.display='none'}
    spShowEval(d,tr);
  }catch(e){
    if(btn){btn.textContent='✨ Оценить с ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'stt'))}catch(_){}}}
function spShowEval(d,tr){var box=document.getElementById('sp_evalbox');if(!box)return;
  var pct=d.got/(d.max||1);
  var col=pct>=0.7?'#1F8A50':(pct>=0.4?'#C77400':'#C0392B');
  var h='<div class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-top:12px;animation:wflip .5s cubic-bezier(.25,.75,.35,1) both;">'
    +'<div style="text-align:center;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:30px;color:'+col+';">'+d.got+' из '+d.max+'</div>'
    +'<div style="font-weight:700;font-size:13.5px;color:#2B2B2B;margin-top:4px;">'+(d.verdict||'')+'</div></div>';
  if(Array.isArray(d.criteria)&&d.criteria.length)
    h+='<div style="margin-top:12px;">'+d.criteria.map(function(c){
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #F4EFE9;font-weight:600;font-size:12.5px;color:#4A453E;"><span>'+c.name+'</span><b style="flex:none;color:'+((+c.got||0)>=(+c.max||1)?'#1F8A50':'#C77400')+';">'+c.got+' / '+c.max+'</b></div>'}).join('')+'</div>';
  if(Array.isArray(d.good)&&d.good.length)
    h+='<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ЧТО ПОЛУЧИЛОСЬ</div>'
      +d.good.map(function(g){return '<div style="margin-top:5px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">• '+g+'</div>'}).join('')+'</div>';
  if(Array.isArray(d.fix)&&d.fix.length)
    h+='<div style="margin-top:10px;background:#FDF3EC;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#C2421B;">НАД ЧЕМ ПОРАБОТАТЬ</div>'
      +d.fix.map(function(f){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">'
        +(f.wrong?'<s style="color:#A83226;">'+f.wrong+'</s> → ':'')+(f.right?'<b style="color:#1D7F4A;">'+f.right+'</b><br>':'')+(f.note||'')+'</div>'}).join('')+'</div>';
  h+='<div style="margin-top:10px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">ИИ проверил текст ответа. Произношение, интонация, паузы и беглость не оценивались.</div>';
  h+='<div class="ai-disclaimer" style="margin-top:8px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">'+ui.escapeHtml(ui.AI_DISCLAIMER)+'</div>';
  h+='<details style="margin-top:12px;"><summary style="font-weight:700;font-size:12px;color:#777163;cursor:pointer;">Расшифровка твоей речи</summary>'
    +'<div style="margin-top:8px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">'+tr+'</div><button class="sq" onclick="spFlagTranscript()" style="margin-top:8px;border:0;background:#F4EFE9;padding:7px 10px;border-radius:10px;font-weight:700;font-size:11px;">Расшифровка неточная</button></details>'
    +'</div>';
  box.innerHTML=h;
  try{box.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}}
function spFlagTranscript(){S.sttFeedback=(S.sttFeedback||0)+1;save();try{toast('Спасибо, отметка сохранена')}catch(e){}}
async function spSample(btn){
  if(!SP)return;var t=SP.t,set=SP.set;
  if(btn){if(btn.dataset.busy)return;btn.dataset.busy=1;btn.textContent='Готовлю образец…';btn.style.pointerEvents='none'}
  try{
    var response=await apiPost('/api/v1/ai/generate-speaking-sample',{taskType:t,assignment:spAssignment(t,set)},true);
    var d=response.data;if(!d||!d.text)throw new Error('не получилось');
    SP.sample=String(d.text);
    var box=document.getElementById('sp_evalbox');
    if(box)box.insertAdjacentHTML('afterbegin','<div class="clayCard" style="padding:16px;margin-top:12px;animation:win .35s both;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
      +'<span style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ОБРАЗЕЦ ОТ ИИ</span>'
      +'<button type="button" class="clk sq iconbtn" onclick="spVoiceSample()" style="display:inline-flex;align-items:center;gap:6px;background:#E3F1F5;border-radius:12px;padding:7px 12px;font-weight:800;font-size:11px;color:#317485;cursor:pointer;">🔊 Озвучить</button></div>'
      +'<div style="margin-top:9px;font-weight:500;font-size:13px;color:#2B2B2B;line-height:1.65;">'+SP.sample+'</div></div>');
    if(btn){btn.style.display='none'}
  }catch(e){
    if(btn){btn.textContent='Образец ответа от ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'ai'))}catch(_){}}}
function spVoiceSample(){if(!SP||!SP.sample)return;
  var parts=speakingModule.sentences(SP.sample).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 3: экзамен устной части целиком ---- */
let SPE=null;
function spExam(){var area=document.getElementById('s9_area');if(!area)return;spStopAll();SP=null;
  var st=S.spkExam||{};
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Устная часть целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Чтение → вопросы → интервью → монолог, всё подряд с экзаменационными таймерами и без шпаргалок. Задания переключаются сами. В конце ИИ оценит каждую запись — максимум 20 баллов.</div>'
    +(st.n?'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Попыток: '+st.n+' · последний: '+st.last+' из '+speakingModule.EXAM_MAX+' · лучший: '+st.best+' из '+speakingModule.EXAM_MAX+'</div>':'')
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn('Начать экзамен','speStart()',true)
    +spBtn('← К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s')}
function speStart(){
  S.spExIdx=(S.spExIdx||0);
  var sets={};speakingModule.TASKS.forEach(function(t){sets[t]=speakingModule.select(spPool(t),S.spExIdx)});
  S.spExIdx++;save();
  SPE={stage:1,sets:sets,blobs:{},qi:0,t0:Date.now(),tm:null};
  speStage()}
function speStage(){var c=SP_CONF[SPE.stage];
  if(c.prep){SPE.phase='prep';SPE.left=c.prep;speRender();
    speTick(c.prep,function(){speRec()})}
  else speRec()}
async function speRec(){var c=SP_CONF[SPE.stage];
  clearInterval(SPE.tm);
  try{
    var st=await navigator.mediaDevices.getUserMedia({audio:true});
    var mime=spMime();
    SPE.stream=st;SPE.chunks=[];SPE.rec=mime?new MediaRecorder(st,{mimeType:mime}):new MediaRecorder(st);
    SPE.rec.ondataavailable=function(e){SPE.chunks.push(e.data)};
    SPE.rec.start();
  }catch(e){SPE.rec=null;try{toast('Нет доступа к микрофону — задание будет без записи')}catch(_){}}
  SPE.phase='rec';SPE.left=c.rec;SPE.qi=0;speRender();
  if(SPE.stage===3){try{lPlayRaw([{s:1,t:SPE.sets[3].qs[0]}])}catch(e){}}
  speTick(c.rec,function(){SPE.stage===3?speNextQ():speEndStage()})}
function speNextQ(){if(!SPE)return;
  if(SPE.qi>=4){speEndStage();return}
  SPE.qi++;SPE.left=SP_CONF[3].rec;speRender();
  try{lPlayRaw([{s:1,t:SPE.sets[3].qs[SPE.qi]}])}catch(e){}
  speTick(SP_CONF[3].rec,function(){SPE.qi>=4?speEndStage():speNextQ()})}
function speEndStage(){if(!SPE)return;clearInterval(SPE.tm);try{lStop()}catch(e){}
  var done=function(){if(!SPE)return;
    if(SPE.stage<4){SPE.stage++;speStage()}else speFinish()};
  if(SPE.rec&&SPE.rec.state!=='inactive'){
    var stg=SPE.stage;
    SPE.rec.onstop=function(){if(!SPE)return;
      var tp=(SPE.rec&&SPE.rec.mimeType)||(SPE.chunks[0]&&SPE.chunks[0].type)||'';
      SPE.blobs[stg]=tp?new Blob(SPE.chunks,{type:tp}):new Blob(SPE.chunks);
      try{SPE.stream.getTracks().forEach(function(x){x.stop()})}catch(e){}
      done()};
    try{SPE.rec.stop()}catch(e){done()}}
  else done()}
function speTick(total,onEnd){clearInterval(SPE.tm);
  SPE.tm=setInterval(function(){if(!SPE){return}
    SPE.left--;setTxt('s9_timer',spFmt(SPE.left));
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SPE.left/total*100))+'%';
    setTxt('s9_today','задание '+SPE.stage+' · '+spFmt(SPE.left));
    if(SPE.left<=0){clearInterval(SPE.tm);onEnd()}},1000)}
function speTaskBody(){var t=SPE.stage,set=SPE.sets[t];
  if(t===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+set.tx+'</div>';
  if(t===2)return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+set.ad+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(i+1)+'. '+p+'</div>'}).join('');
  if(t===3)return '<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+(SPE.qi+1)+' из 5</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+set.qs[SPE.qi]+'</div>'
    +'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SPE.sets[3].qs[SPE.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Повторить вопрос</button></div>';
  return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('')}
function speRender(){var area=document.getElementById('s9_area');if(!area||!SPE)return;
  var c=SP_CONF[SPE.stage];
  var chip=SPE.phase==='prep'
    ?'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">ПОДГОТОВКА</span>'
    :'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A83226;background:#FDEDEA;padding:5px 10px;border-radius:20px;">● ЗАПИСЬ</span>';
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · '+SPE.stage+' ИЗ 4 · '+SP_CONF[SPE.stage].name.toUpperCase()+'</span>'+chip+'</div>'
    +speTaskBody()
    +'<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;">'
    +'<span id="s9_timer" style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;">'+spFmt(SPE.left)+'</span></div>'
    +'<div style="margin-top:8px;height:7px;border-radius:5px;background:#F1EDE7;"><div id="s9_tbar" style="width:100%;height:100%;border-radius:5px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'
    +'</div>'
    +(SPE.phase==='prep'
      ?spBtn('Готово — к записи','clearInterval(SPE.tm);speRec()',true)
      :(SPE.stage===3&&SPE.qi<4?spBtn('Следующий вопрос →','clearInterval(SPE.tm);speNextQ()',true):spBtn(SPE.stage<4?'Стоп — дальше':'Завершить экзамен','clearInterval(SPE.tm);speEndStage()',true)))}
async function speFinish(){if(!SPE)return;clearInterval(SPE.tm);try{lStop()}catch(e){}
  var sec=Math.floor((Date.now()-SPE.t0)/1000);
  var area=document.getElementById('s9_area');
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
    +'<div style="font-size:42px;">🎧</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Экзамен записан!</div>'
    +'<div id="spe_prog" style="font-weight:600;font-size:13px;color:#777163;margin-top:6px;">Начинаю проверку…</div>'
    +'<div style="margin-top:12px;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;border:3px solid #F1EDE7;border-top-color:#F2683F;animation:lspin .8s linear infinite;"></span></div></div>';
  var results={};
  for(var t=1;t<=4;t++){
    setTxt('spe_prog','Оцениваю задание '+t+' из 4…');
    var d=null,bl=SPE.blobs[t];
    if(bl){try{
      var tr=await spSTT(bl);
      if(speakingModule.isTranscriptUsable(tr)){
        var response=await apiPost('/api/v1/ai/evaluate-speaking',{taskType:t,transcript:tr,assignment:spAssignment(t,SPE.sets[t])},true);
        var p=response.review;
        if(p&&typeof p.got!=='undefined')d={got:speakingModule.clampScore(p,t).got,verdict:String(p.verdict||''),fix:Array.isArray(p.fix)?p.fix:[]}}
    }catch(e){}}
    if(!d)d={got:0,verdict:bl?'не удалось оценить запись':'записи нет',fix:[]};
    results[t]=d;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:t,g:d.got,m:SP_CONF[t].max,ts:Date.now()});
  }
  var got=speakingModule.examTotal(results);
  S.spkExam=examModule.record(S.spkExam,got);
  var r=spSt();r.t1.n++;r.t2.n++;r.t3.n++;r.t4.n++;
  spSync();save();
  var weak=speakingModule.weakestTask(results);
  var rows=[1,2,3,4].map(function(t){var d=results[t];
    return '<div style="padding:9px 2px;border-bottom:1px solid #F4EFE9;">'
      +'<div style="display:flex;justify-content:space-between;gap:10px;font-weight:700;font-size:13px;color:#2B2B2B;"><span>'+SP_CONF[t].name+'</span><b style="flex:none;color:'+(d.got/SP_CONF[t].max>=0.7?'#1F8A50':(d.got>0?'#C77400':'#C0392B'))+';">'+d.got+' / '+SP_CONF[t].max+'</b></div>'
      +(d.verdict?'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:3px;">'+d.verdict+'</div>':'')
      +(d.fix||[]).map(function(f){return '<div style="font-weight:600;font-size:12px;color:#4A453E;margin-top:4px;line-height:1.5;">'+(f.wrong?'<s style="color:#A83226;">'+f.wrong+'</s> → ':'')+(f.right?'<b style="color:#1D7F4A;">'+f.right+'</b> ':'')+(f.note||'')+'</div>'}).join('')
      +'</div>'}).join('');
  SPE=null;
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">'+examModule.badge(got,speakingModule.EXAM_MAX,speakingModule.BADGES)+'</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:26px;color:#2B2B2B;margin-top:8px;">'+got+' из '+speakingModule.EXAM_MAX+'</div>'
    +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:4px;">Время: '+spFmt(sec)+'</div>'
    +(got<speakingModule.EXAM_MAX?'<div style="font-weight:700;font-size:12.5px;color:#A56000;margin-top:6px;">Слабое место: '+SP_CONF[weak].name.toLowerCase()+' — потренируй отдельно</div>':'')
    +'</div><div style="margin-top:12px;">'+rows+'</div></div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn('Ещё раз','speStart()',true)
    +spBtn('К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s');spGen()}
/* ---- фоновая ИИ-генерация комплектов говорения ---- */
var SPGEN=false;
async function spGen(){
  if(SPGEN)return;if(typeof SRV==='undefined'||!SRV||!TOKEN)return;
  S.spkAi=S.spkAi||{p1:[],p2:[],p3:[],p4:[]};
  var kind=null;
  for(var t=1;t<=4;t++){if(spPool(t).length<5){kind=t;break}}
  if(!kind)return;SPGEN=true;
  try{
    var d=await generateAiContent('speaking_task_'+kind);
    var item=speakingModule.normalizeGenerated(kind,d);
    if(item){S.spkAi['p'+kind]=(S.spkAi['p'+kind]||[]).concat([item]);save()}
  }catch(e){}
  SPGEN=false;
  try{var need=false;for(var t=1;t<=4;t++)if(spPool(t).length<5){need=true;break}
    if(need)setTimeout(spGen,4000)}catch(e){}}
/* уборка при уходе с экрана + синк */
registerRouteHook(function(id){
  if(id!=='scr9'){
    if(SP){spStopAll();SP=null}
    if(SPE){clearInterval(SPE.tm);try{if(SPE.rec&&SPE.rec.state!=='inactive')SPE.rec.stop()}catch(e){}try{SPE.stream&&SPE.stream.getTracks().forEach(function(x){x.stop()})}catch(e){}SPE=null}}});
registerStartHook(function(){return spSync()});
