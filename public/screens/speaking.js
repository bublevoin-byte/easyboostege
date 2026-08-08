/*
 * Экран «Говорение» (scr9). Приезжает динамическим import() при первом переходе на него.
 * Озвучку и её остановку берём у общего проигрывателя оболочки — чанк аудирования для этого
 * загружать не нужно.
 */
import {registerRouteHook} from '../router.js';
import {lPlayRaw,lStop} from '../tts.js';
import {
  S,SRV,TOKEN,WBTN,apiGet,apiMessage,apiPost,apiPostBinary,apiPut,generateAiContent,save,
  setTxt,spSt,spSync,speakingModule,toast,ui,wDeco,
} from '../app.js';
import {adaptiveRuntimeSnapshot,completeAdaptiveServerAttempt,openAdaptivePlan} from '../adaptive-session-runtime.js';
import {adaptiveSpeakingTask} from '../adaptive-speaking-tasks.js';
import {voiceTutorButton} from '../voice-tutor.js';
import {createSpeakingTask1BrowserFlow} from '../speaking-task1-runtime.js';
import {createSpeakingTask2BrowserFlow} from '../speaking-task2-runtime.js';
import {createSpeakingTask3BrowserFlow} from '../speaking-task3-runtime.js';
import {createSpeakingTask4BrowserFlow} from '../speaking-task4-runtime.js';
import {createSpeakingFullBrowserFlow} from '../speaking-full-runtime.js';
import {convertRecordingToPcm16Wav} from '../speaking-pronunciation-audio.js';
import {SPEAKING_TASK1_CATALOG} from '../content/speaking/task1-v1.js';
import {SPEAKING_TASK2_CATALOG} from '../content/speaking/task2-v1.js';
import {SPEAKING_TASK3_CATALOG} from '../content/speaking/task3-v1.js';
import {SPEAKING_TASK4_CATALOG} from '../content/speaking/task4-v1.js';
import {SPEAKING_TASK4_PHOTO_MANIFEST} from '../assets/speaking/task4-v1/manifest.js';

/* ===== SPEAKING v2: устная часть ЕГЭ, 4 задания ===== */
const SP1=[
{tx:'Libraries are changing fast. Twenty years ago they were quiet places with paper books only. Today a modern library offers computers, online courses and clubs for different hobbies. People come here not only to read, but also to meet friends, work on projects or listen to interesting lectures. Many libraries stay open late in the evening, so students often do their homework there. Scientists say that such places help people of all ages to keep learning through the whole life.'},
{tx:'Walking is the easiest kind of sport. You do not need special equipment, a gym or a trainer — only comfortable shoes. Doctors say that thirty minutes of walking a day make the heart stronger, improve sleep and even help the brain to work better. Walking with friends is also a great way to spend time together. Some schools now organise walking clubs, where students discover interesting places in their city and learn to notice the beauty around them.'}];
const SP_TASK1_CATALOG_KEYS=new Set(SPEAKING_TASK1_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
const SP_TASK2_CATALOG_KEYS=new Set(SPEAKING_TASK2_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
const SP_TASK3_CATALOG_KEYS=new Set(SPEAKING_TASK3_CATALOG.tasks.map(function(task){return task.id+'@'+task.revision}));
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
{topic:'Зимние каникулы',
 ph:['Фото 1: семья катается на лыжах в горах в солнечный день','Фото 2: девушка читает книгу у камина дома'],
 plan:['кратко опиши обе фотографии — что на них происходит','скажи, что общего у этих фотографий','скажи, чем они различаются','скажи, какой отдых ближе тебе, и объясни почему']},
{topic:'Еда дома и в кафе',ph:['Фото 1: мама с сыном вместе готовят ужин на кухне','Фото 2: друзья едят пиццу в кафе'],
 plan:['кратко опиши обе фотографии','скажи, что общего у фотографий','скажи, чем они различаются','скажи, что предпочитаешь ты, и объясни почему']}];
const SP_CONF={1:speakingModule.config(1),2:speakingModule.config(2),3:speakingModule.config(3),4:speakingModule.config(4)};
const SP_SHEET={
1:'<b>Как читать вслух на 1 балл:</b><br>— Во время подготовки прочитай текст про себя и отметь трудные слова.<br>— Читай по смысловым кусочкам, с паузами на запятых и точках.<br>— Не глотай окончания <i>-s</i> и <i>-ed</i>: he work<b>s</b>, play<b>ed</b>.<br>— Вопросы читай с восходящей интонацией, утверждения — с нисходящей.<br>— Лучше чуть медленнее, но чётко: ошибки в словах = потеря балла.',
2:'<b>Как задавать прямые вопросы:</b><br>Каждый пункт превращай в ПРЯМОЙ вопрос:<br>— цена → <i>How much does it cost?</i><br>— даты → <i>When does the course start?</i><br>— место → <i>Where is the club located?</i><br>— возможность → <i>Can I…? / Is it possible to…?</i><br><b>Ловушки:</b> «What about the price?» — НЕ вопрос, балл не дадут. Вопрос «зачитыванием пункта» (price?) — тоже. Нужен полный вопрос с вспомогательным глаголом.',
3:'<b>Как отвечать на вопросы интервью:</b><br>— Отвечай развёрнуто: 2-3 предложения, а не «Yes, I do».<br>— Формула: прямой ответ → причина → пример. <i>I usually read in my free time. It helps me to relax. For example, last week I finished a great detective story.</i><br>— Не молчи: если нужно время, начни с <i>Well, let me think…</i><br>— Следи за временем вопроса: «What did you do…» → отвечай в прошедшем.',
4:'<b>Скелет монолога (2,5–3 минуты):</b><br>1. Вступление: <i>I have found two photos for our project about…</i><br>2. Описание: <i>In the first photo we can see… In the second photo there is…</i><br>3. Общее: <i>Both photos show… / What these photos have in common is…</i><br>4. Различия: <i>The main difference is that… while…</i><br>5. Мнение: <i>As for me, I prefer… because…</i><br>6. Финал: <i>That is all I wanted to say.</i><br><b>Ловушка:</b> пропустил пункт плана — минус баллы за решение задачи.'};
let SP=null,SP_rec=null,SP_chunks=[],SP_tm=null,SP_sheet=false,SP_TASK1_FLOW=null,SP_TASK2_FLOW=null,SP_TASK3_FLOW=null,SP_TASK4_FLOW=null;
let SP_ACCENT=null,SP_ACCENT_SETUP=null,SP_CALIBRATION_CONSENT=null,SP_TARGETED_PRACTICE=null;
function spAnim(n,d){ui.animate('s9_card',n,d)}
function spMime(){return speakingModule.preferredMimeType(window.MediaRecorder)}
function spFmt(s){return speakingModule.formatTime(s)}
function spStopAll(){clearInterval(SP_tm);SP_tm=null;
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  try{lStop()}catch(e){}}
function spReleaseRecording(){if(SP&&SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}if(SP){SP.url=null;SP.blob=null;SP.pronunciationUploadCache=null}SP_chunks=[]}
function spDisposeTask1Flow(){if(SP_TASK1_FLOW){SP_TASK1_FLOW.dispose();SP_TASK1_FLOW=null}}
function spDisposeTask2Flow(){if(SP_TASK2_FLOW){SP_TASK2_FLOW.dispose();SP_TASK2_FLOW=null}}
function spDisposeTask3Flow(){if(SP_TASK3_FLOW){SP_TASK3_FLOW.dispose();SP_TASK3_FLOW=null}}
function spDisposeTask4Flow(){if(SP_TASK4_FLOW){SP_TASK4_FLOW.dispose();SP_TASK4_FLOW=null}}
function officialTask2Active(){return Boolean(SP&&SP.t===2&&SP_TASK2_FLOW)}
function officialTask3Active(){return Boolean(SP&&SP.t===3&&SP_TASK3_FLOW)}
function officialTask4Active(){return Boolean(SP&&SP.t===4&&SP_TASK4_FLOW)}
function task4PhotoAsset(src){return SPEAKING_TASK4_PHOTO_MANIFEST.assets.find(function(asset){return asset.src===src})||null}
function task2RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK2_CATALOG_REVISION_MISMATCH'}
function task3RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK3_CATALOG_REVISION_MISMATCH'}
function task4RecoveryPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_TASK4_CATALOG_REVISION_MISMATCH'}
function adaptiveSpeakingLock(){try{var active=adaptiveRuntimeSnapshot().active;return active&&active.module==='speaking'?active:null}catch(_){return null}}
function launchAdaptiveSpeakingLock(lock){if(!lock)return false;var descriptor=adaptiveSpeakingTask(lock.contentRef);if(!descriptor)return false;void spOpen(descriptor.taskNumber,{adaptiveLock:lock});return true}
function initSpeaking(){if(!S)return;var lock=adaptiveSpeakingLock();spStopAll();spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP=null;spSync();if(lock){launchAdaptiveSpeakingLock(lock);return}
  var area=document.getElementById('s9_area');if(area)area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Загружаем профиль произношения…</div>';
  Promise.all([apiGet('/api/v1/speaking/accent-profile'),apiGet('/api/v1/speaking/calibration-consent')]).then(function(results){
    SP_ACCENT=results[0]&&results[0].profile||null;SP_ACCENT_SETUP=results[0]&&results[0].calibration||null;SP_CALIBRATION_CONSENT=results[1]&&results[1].consent||null;
    if(SP_ACCENT)spHub();else spAccentSetup()}).catch(function(error){if(area)area.innerHTML='<div class="clayCard" role="alert" style="padding:18px;color:#A83226;font-weight:700;">Не удалось загрузить профиль произношения. Проверь сеть и повтори.</div><div style="height:10px;"></div>'+spBtn('Повторить','initSpeaking()',true);try{toast(apiMessage(error,'request'))}catch(_){}})}
function spAccentSetup(){var area=document.getElementById('s9_area');if(!area)return;
  var calibrationChoice=!SP_ACCENT
    ?'<div style="height:10px;"></div>'+spBtn(SP_ACCENT_SETUP?'Продолжить короткую двойную калибровку':'Не знаю — короткая двойная калибровка','spAccentStartUnknown()',false)
      +'<div class="clayCard" style="padding:13px 15px;margin-top:12px;font-size:12px;line-height:1.5;color:#6B655D;">Для варианта «Не знаю» одна и та же короткая запись проверяется в en-GB и en-US один раз. Затем приложение предлагает профиль; оно не выбирает больший балл заново на каждой попытке.</div>'
    :'<div class="clayCard" style="padding:13px 15px;margin-top:12px;font-size:12px;line-height:1.5;color:#6B655D;">Изменение применяется только к новым тренировкам. Уже начатая тренировка сохраняет прежний профиль.</div>';
  area.innerHTML='<div class="clayCard" style="padding:20px;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;">Какой вариант произношения будем тренировать?</div>'
    +'<div style="font-weight:600;font-size:13px;line-height:1.55;color:#6B655D;margin-top:7px;">ЕГЭ допускает обе нормы. Выбор закрепляется за новой тренировкой и не меняет уже сохранённые оценки.</div></div>'
    +'<div style="height:10px;"></div>'+spBtn('🇬🇧 Британский · en-GB','spChooseAccent(\'en-GB\')',true)
    +'<div style="height:10px;"></div>'+spBtn('🇺🇸 Американский · en-US','spChooseAccent(\'en-US\')',true)
    +calibrationChoice
    +(SP_ACCENT?'<div style="height:10px;"></div>'+spBtn('Назад без изменений','spHub()',false):'');setTxt('s9_today','настройка произношения')}
async function spChooseAccent(locale){if(!['en-GB','en-US'].includes(locale))return false;try{var result=await apiPut('/api/v1/speaking/accent-profile',{locale:locale});SP_ACCENT=result.profile;SP_ACCENT_SETUP=null;spHub();return true}catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spAccentStartUnknown(){try{if(!SP_ACCENT_SETUP)SP_ACCENT_SETUP=await apiPost('/api/v1/speaking/accent-profile/calibration',{});var opened=await spOpen(1);if(opened&&SP){SP.accentCalibration=SP_ACCENT_SETUP;toast('Прочитай короткий текст один раз. После записи сравним en-GB и en-US.')}return opened}catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function spCalibrationConsentSetup(){var area=document.getElementById('s9_area');if(!area)return;var current=SP_CALIBRATION_CONSENT;
  area.innerHTML='<div class="clayCard" style="padding:20px;"><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;">Добровольная калибровка точности</div>'
    +'<p style="font-size:13px;line-height:1.55;color:#625D56;">Это отдельное согласие на временное хранение анонимной записи для двух независимых экспертных оценок. Отказ не ограничивает обучение или подписку. Сырой звук удаляется после согласованной двойной оценки, отзыва или не позднее 180 дней.</p>'
    +'<label style="display:grid;gap:6px;font-weight:800;font-size:13px;">Возрастная группа<select id="sp_cal_age" style="min-height:46px;border:1px solid #D7CFC5;border-radius:13px;padding:0 10px;"><option value="adult">18 лет или старше</option><option value="minor">Младше 18 лет</option></select></label>'
    +'<label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;font-size:12.5px;font-weight:650;"><input id="sp_cal_guardian" type="checkbox" aria-label="Подтверждение законного представителя" style="width:22px;height:22px;min-height:0;accent-color:#F2683F;"><span>Законный представитель подтвердил передачу записи внешнему сервису и экспертам.</span></label></div>'
    +'<div style="height:10px;"></div>'+spBtn('Дать добровольное согласие','spSaveCalibrationConsent(true)',true)
    +(current&&current.granted?'<div style="height:10px;"></div>'+spBtn('Отозвать согласие и удалить сырой звук','spSaveCalibrationConsent(false)',false):'')
    +'<div style="height:10px;"></div>'+spBtn('Назад без изменений','spHub()',false)}
async function spSaveCalibrationConsent(granted){var age=document.getElementById('sp_cal_age');var guardian=document.getElementById('sp_cal_guardian');var ageGroup=age?age.value:(SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.age_group)||'adult';var guardianConfirmed=Boolean(guardian&&guardian.checked);if(!granted&&SP_CALIBRATION_CONSENT){ageGroup=SP_CALIBRATION_CONSENT.age_group;guardianConfirmed=Boolean(SP_CALIBRATION_CONSENT.guardian_confirmed)}
  try{SP_CALIBRATION_CONSENT=await apiPut('/api/v1/speaking/calibration-consent',{granted:Boolean(granted),ageGroup:ageGroup,guardianConfirmed:guardianConfirmed});spHub();toast(granted?'Согласие сохранено. Его можно отозвать в любой момент.':'Согласие отозвано; незавершённые сырые записи удалены.');return true}catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spLoadPronunciationStatus(){var box=document.getElementById('speaking_pronunciation_status');if(!box)return;
  try{var payload=await apiGet('/api/v1/speaking/pronunciation-assessments/status');var view=speakingModule.pronunciationStatusView(payload);box=document.getElementById('speaking_pronunciation_status');if(!box)return;
    if(view.available){box.style.background='#EAF7F0';box.style.color='#1D6944';box.innerHTML='<b>Оценка произношения доступна</b><br><span style="font-size:11.5px;">Осталось '+spFmt(view.remainingSeconds)+' из '+spFmt(view.limitSeconds)+' в этом месяце · '+(view.tier==='premium'?'Premium':'Base')+'. Локальная запись и прослушивание не расходуют лимит.</span>';return}
    box.style.background='#FFF4E6';box.style.color='#714515';box.innerHTML='<b>Оценка произношения пока недоступна</b><br><span style="font-size:11.5px;">Можно записывать и прослушивать ответы локально — это не расходует лимит.</span>'}
  catch(_){box=document.getElementById('speaking_pronunciation_status');if(!box)return;box.style.background='#FFF4E6';box.style.color='#714515';box.innerHTML='<b>Оценка произношения пока недоступна</b><br><span style="font-size:11.5px;">Локальная запись и прослушивание не расходуют лимит.</span>'}}
function spLearningList(title,items){if(!items||!items.length)return '';return '<div style="margin-top:9px;font-size:12px;"><b>'+ui.escapeHtml(title)+':</b><ul style="margin:5px 0 0;padding-left:18px;line-height:1.45;">'+items.map(function(item){return '<li>'+ui.escapeHtml(item)+'</li>'}).join('')+'</ul></div>'}
function spIssueDynamics(item){var labels={improved:'улучшение',declined:'снижение',stable:'без изменений',insufficient_data:'данных для сравнения пока мало'};var detail=item.previousAccuracy==null||item.currentAccuracy==null?'':' · '+item.previousAccuracy+'→'+item.currentAccuracy+(item.delta==null?'':' ('+(item.delta>0?'+':'')+item.delta+')');return item.label+(item.accentLocale?' · '+item.accentLocale:'')+' · '+item.count+' раз'+(item.averageAccuracy==null?'':' · среднее '+item.averageAccuracy+'/100')+' · '+(labels[item.direction]||labels.insufficient_data)+detail}
function spSpeakingSkillLabel(skillId){var labels={'ege.speaking.reading_aloud':'Чтение вслух','ege.speaking.direct_questions':'Прямые вопросы','ege.speaking.interview_completeness':'Полнота ответов в интервью','ege.speaking.monologue_content':'Содержание монолога','ege.speaking.monologue_organization':'Организация монолога','ege.speaking.spoken_grammar':'Грамматика устной речи','ege.speaking.spoken_lexis':'Лексика устной речи','ege.speaking.fluency':'Беглость речи','ege.speaking.pronunciation_words':'Произношение слов','ege.speaking.pronunciation_phonemes':'Произношение звуков','ege.speaking.signal_quality':'Качество записи'};return labels[skillId]||'Навык говорения'}
function spSpeakingTargetFocus(focus){if(!focus)return '';if(focus.kind==='word')return 'слово «'+focus.value+'»';if(focus.kind==='phoneme')return 'фонема /'+focus.value+'/ в слове «'+focus.anchorWord+'»';return ''}
function spVoiceTutorOptions(voice){if(!voice||!voice.attemptSummary)return null;if(voice.attemptSummary.attemptId===voice.attemptId){var base={profile:{entitlements:{voice_tutor:true}},source:'speaking',attemptId:voice.attemptId,revision:voice.revision};if(voice.criterion)return Object.assign(base,{criterionChoices:[{index:voice.criterion.index,label:voice.criterion.label}]});if(voice.pronunciationError)return Object.assign(base,{pronunciationError:{ref:voice.pronunciationError.ref,label:voice.pronunciationError.label}})}return null}
function spLearningReportMarkup(report){var safe=ui.escapeHtml,current=report&&report.currentAttempt,access=report&&report.access;if(!report||!access)return '';
  var header='<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;"><b style="font-size:14px;">Личный прогресс Speaking</b><span style="font-size:11px;font-weight:900;color:#B54E2F;background:#FFEDE4;padding:6px 9px;border-radius:12px;">'+(access.tier==='premium'?'PREMIUM':'BASE')+(report.activeAccentLocale?' · '+safe(report.activeAccentLocale):'')+' · '+Math.round(access.remainingSeconds/60)+' мин</span></div>';
  var next=report.nextStep?'<div style="margin-top:9px;padding:9px 11px;border-radius:12px;background:#FFF4DE;font-size:12px;color:#714515;"><b>Следующий шаг:</b> '+safe(report.nextStep.label)+'</div>':'';
  var timeline=(report.attemptTimeline||[]).slice(-10).map(function(item){return 'Попытка '+item.attemptId+' · задание '+item.taskType+' · '+(item.status==='scored'?(item.score+' / '+item.maxScore):'нужна новая запись')+(item.masteryEligible?'':' · не меняет освоение')});
  var history=spLearningList('История попыток',timeline);
  SP_TARGETED_PRACTICE=null;
  if(!current)return '<div class="clayCard" style="padding:15px;margin-bottom:12px;">'+header+'<div style="margin-top:7px;font-size:12px;color:#777163;">После первой оценки здесь появятся критерии и слабые места.</div>'+next+history+'</div>';
  var technical=current.status!=='scored';var summary=technical
    ?'<div style="margin-top:9px;padding:10px;border-radius:12px;background:#FFF4E6;color:#714515;font-size:12px;"><b>Оценку нельзя считать надёжной.</b><br>'+safe(current.verdict||'Нужна новая запись.')+'</div>'
    :'<div style="margin-top:9px;font-size:13px;font-weight:800;">Последняя оценка: '+current.score+' из '+current.maxScore+(current.accentLocale?' · '+safe(current.accentLocale):'')+'</div><div style="margin-top:5px;font-size:12px;line-height:1.45;color:#4A453E;">'+safe(current.verdict||'')+'</div>';
  var transcript=current.transcript?'<details style="margin-top:9px;padding:9px 11px;border-radius:12px;background:#F8F5F1;"><summary style="cursor:pointer;font-size:12px;font-weight:850;color:#4A453E;">Расшифровка последней попытки</summary><div style="margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:#4A453E;">'+safe(current.transcript)+'</div></details>':'';
  var criteria=(current.criteria||[]).map(function(item){return '<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid #F4EFE9;font-size:12px;"><span>'+safe(item.name)+'</span><b>'+item.score+' / '+item.maxScore+'</b></div>'}).join('');
  var signal=current.signal||{};var pause=signal.pauseAnalysis||{};var pauseText=pause.available?('лишних '+pause.unexpectedBreakCount+', пропущенных '+pause.missingBreakCount):(pause.reason==='locale_not_supported'?'анализ недоступен для выбранного варианта английского':'отдельный показатель провайдером не поддерживается');var signalText=technical?'Качество сигнала: '+safe(signal.quality||'не определено'):'Беглость: '+(signal.fluencyScore==null?'нет отдельного показателя':Math.round(signal.fluencyScore)+'/100')+' · полнота: '+(signal.completenessScore==null?'нет отдельного показателя':Math.round(signal.completenessScore)+'/100')+' · паузы: '+pauseText;
  var words=(current.wordIssues||[]).map(function(item){var phonemes=(item.phonemes||[]).map(function(p){return p.label+(p.accuracyScore==null?'':' '+Math.round(p.accuracyScore)+'/100')}).join(', ');var hasTime=typeof item.offsetSeconds==='number'&&Number.isFinite(item.offsetSeconds)&&typeof item.durationSeconds==='number'&&Number.isFinite(item.durationSeconds);var stamp='';if(hasTime){var fmt=function(value){var minutes=Math.floor(value/60);var seconds=(value-minutes*60).toFixed(1).padStart(4,'0');return minutes+':'+seconds};stamp=' · '+(item.itemIndex?'Ответ '+item.itemIndex+' · ':'')+fmt(item.offsetSeconds)+'–'+fmt(item.offsetSeconds+item.durationSeconds)}return item.word+(item.accuracyScore==null?'':' · '+Math.round(item.accuracyScore)+'/100')+stamp+(phonemes?' · '+phonemes:'')});
  var fixes=(current.improvements||[]).map(function(item){return item.wrong+' → '+item.right+(item.note?' · '+item.note:'')});
  var premium='';if(report.premium){var target=report.premium.targetedPractice;var voice=report.premium.voiceTutor;var voiceOptions=spVoiceTutorOptions(voice);var voiceReady=Boolean(voiceOptions);SP_TARGETED_PRACTICE=target||null;
    var comparison=report.premium.comparison;var allocation=(report.premium.timeAllocationRecommendation||[]).map(function(item){return item.label+(item.accentLocale?' · '+item.accentLocale:'')+' — '+item.percentage+'% учебного времени'});
    var repeatedWords=(report.premium.wordDynamics||[]).slice(0,5).map(function(item){return spIssueDynamics(item)});
    var repeatedPhonemes=(report.premium.phonemeDynamics||[]).slice(0,5).map(function(item){return spIssueDynamics(item)});
    var criterionDynamics=(report.premium.criterionDynamics||[]).slice(0,8).map(function(item){var point=(item.points||[]).slice(-1)[0];return spSpeakingSkillLabel(item.skillId)+(item.accentLocale?' · '+item.accentLocale:'')+(point?' · '+point.score+'/'+point.maxScore:'')+' · '+(item.points||[]).length+' проверок'});
    var fluencyDynamics=(report.premium.fluencyDynamics||[]).slice(-5).map(function(item){return 'Попытка '+item.attemptId+(item.accentLocale?' · '+item.accentLocale:'')+' · беглость '+(item.fluencyScore==null?'нет данных':Math.round(item.fluencyScore)+'/100')+' · полнота '+(item.completenessScore==null?'нет данных':Math.round(item.completenessScore)+'/100')});
    var pauseDynamics=(report.premium.pauseDynamics||[]).slice(-5).map(function(item){return 'Попытка '+item.attemptId+(item.accentLocale?' · '+item.accentLocale:'')+' · '+(item.available?('лишних пауз '+item.unexpectedBreakCount+', пропущенных '+item.missingBreakCount):'отдельная метрика пауз недоступна')});
    var personal=report.premium.personalSummary||{};var personalSummary=['Надёжных попыток: '+(personal.reliableAttemptCount||0)+(personal.currentReliableAccentLocale?' · '+personal.currentReliableAccentLocale:''),'Приоритетов на занятие: '+(personal.priorityCount||0),'Целей без подходящего серверного материала: '+(personal.unavailableTargetCount||0)];
    var unavailable=(report.premium.unavailableTargets||[]).slice(0,5).map(function(item){return item.label+' · пока нет другого серверного задания с этой точной целью'});
    var outcomes=(report.premium.targetOutcomes||[]).slice(-5).map(function(item){var focus=spSpeakingTargetFocus(item.focus);return spSpeakingSkillLabel(item.skillId)+(focus?' · '+focus:'')+' · '+(item.status==='resolved'?'цель закрыта':(item.status==='still_needs_work'?'нужно повторить':'результат не подтверждён'))});
    premium='<div style="margin-top:10px;padding-top:10px;border-top:1px solid #E8E0D7;font-size:12px;color:#4A453E;"><b>Надёжная динамика:</b> '+report.premium.trend.length+' попыток'+(comparison&&comparison.scoreDelta!=null?' · '+(comparison.scoreDelta>=0?'+':'')+comparison.scoreDelta+' п.п. к заданию того же типа, уровня и '+safe(comparison.accentLocale||'акцента'):'')+'</div>'
      +spLearningList('Динамика критериев',criterionDynamics)+spLearningList('Повторяющиеся слова',repeatedWords)+spLearningList('Фонемная динамика',repeatedPhonemes)+spLearningList('Беглость и полнота',fluencyDynamics)+spLearningList('Паузы',pauseDynamics)+spLearningList('Персональный итог',personalSummary)+spLearningList('Результаты целевых проверок',outcomes)+spLearningList('Цели, для которых пока нет другого материала',unavailable)+spLearningList('Рекомендация на 60 минут',allocation)
      +(target?'<button type="button" class="sq" onclick="spStartTargetedPractice()" style="width:100%;min-height:44px;margin-top:9px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:900;">Целевая тренировка · другое серверное задание</button>':'')
      +(voiceReady?voiceTutorButton(voiceOptions):'')}
  return '<div class="clayCard" style="padding:15px;margin-bottom:12px;">'+header+summary+transcript+(criteria?'<div style="margin-top:7px;">'+criteria+'</div>':'')+'<div style="margin-top:9px;font-size:12px;color:#4A453E;">'+signalText+'</div>'+spLearningList('Что получилось',current.strengths||[])+spLearningList('Что исправить',fixes)+spLearningList('Проблемные слова и фонемы',words)+next+history+premium+'</div>'}
function spStartTargetedPractice(){var target=SP_TARGETED_PRACTICE;if(!target)return false;return spOpen(target.taskType,{targetedPractice:target})}
async function spLoadLearningReport(){var box=document.getElementById('speaking_learning_report');if(!box)return;try{var report=await apiGet('/api/v1/speaking/learning-report');box=document.getElementById('speaking_learning_report');if(box)box.innerHTML=spLearningReportMarkup(report)}catch(_){box=document.getElementById('speaking_learning_report');if(box)box.innerHTML=''}}
function spHub(){var area=document.getElementById('s9_area');if(!area)return;
  var lock=adaptiveSpeakingLock();if(lock){launchAdaptiveSpeakingLock(lock);return}
  var r=spSt();var GA=0;function ga(){return 'animation:win .34s '+((GA++)*0.06)+'s cubic-bezier(.25,.75,.35,1) both;'}
  var accentLabel=SP_ACCENT&&SP_ACCENT.locale==='en-US'?'Американский · en-US':'Британский · en-GB';
  var accentCard='<div class="clayCard" style="'+ga()+'padding:13px 15px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;">'
    +'<div><div style="font-weight:900;font-size:13px;color:#2B2B2B;">Профиль произношения</div><div style="font-weight:650;font-size:11.5px;color:#777163;margin-top:3px;">'+ui.escapeHtml(accentLabel)+' · действует для новых тренировок</div></div>'
    +'<button type="button" class="sq" onclick="spAccentSetup()" style="flex:none;border:0;border-radius:12px;padding:9px 11px;background:#FFEDE4;color:#B54E2F;font-weight:800;cursor:pointer;">Изменить</button></div>';
  var calibrationGranted=Boolean(SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.granted);
  var calibrationCard='<button type="button" class="clayCard sq" onclick="spCalibrationConsentSetup()" style="'+ga()+'width:100%;border:0;text-align:left;font:inherit;padding:13px 15px;margin-bottom:12px;cursor:pointer;">'
    +'<div style="font-weight:900;font-size:13px;color:#2B2B2B;">Добровольная калибровка точности</div><div style="font-weight:650;font-size:11.5px;color:'+(calibrationGranted?'#1D7F4A':'#777163')+';margin-top:3px;">'+(calibrationGranted?'Согласие дано · можно отозвать':'Не включена · обучение доступно полностью')+'</div></button>';
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
    +'<div style="font-weight:600;font-size:12px;color:rgba(255,255,255,.62);margin-top:2px;">'+(S.speakingFullSessionId?'есть незавершённая сессия · максимум 20':'4 задания подряд · максимум 20 · примерная оценка после сдачи')+'</div></div>'
    +'<span style="flex:none;background:linear-gradient(145deg,#FFC861,#F2683F);border-radius:14px;width:42px;height:42px;display:grid;place-items:center;box-shadow:0 6px 12px rgba(242,104,63,.4),inset 0 2px 3px rgba(255,255,255,.5);">'
    +'<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span></div></button>';
  area.innerHTML=accentCard+calibrationCard+exCard+'<div id="speaking_pronunciation_status" class="clayCard" role="status" aria-live="polite" aria-atomic="true" style="'+ga()+'margin-bottom:12px;padding:13px 15px;background:#F4F1EA;color:#514B43;font-weight:650;font-size:12.5px;line-height:1.45;">Проверяем доступность оценки произношения…<br><span style="font-size:11.5px;">Локальная запись и прослушивание не расходуют лимит.</span></div><div id="speaking_learning_report" role="status" aria-live="polite"></div>'+[1,2,3,4].map(function(t){var c=SP_CONF[t];
    return '<button type="button" class="clayCard sq clk" onclick="spOpen('+t+')" style="'+ga()+'width:100%;border:0;text-align:left;font:inherit;padding:16px 18px;margin-bottom:12px;cursor:pointer;">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">'
      +'<div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:15.5px;color:#2B2B2B;">'+c.name+'</div>'
      +'<div style="font-weight:600;font-size:12px;color:#777163;margin-top:2px;">'+c.sub+'</div></div>'
      +'<span style="flex:none;font-weight:800;font-size:12px;color:#C2421B;background:#FFEDE4;padding:8px 12px;border-radius:14px;">'+(r['t'+t].n||'—')+'</span></div></button>'}).join('')
   +'<div class="clayCard" style="'+ga()+'display:flex;align-items:center;gap:12px;padding:13px 15px;">'
    +'<span style="flex:none;width:38px;height:38px;border-radius:13px;background:#FBE9EF;display:grid;place-items:center;"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#D4537E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg></span>'
    +'<div style="font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.45;">Сначала подготовка по таймеру, потом запись — тайминги как на настоящем экзамене</div></div>';
  setTxt('s9_today','4 задания');spLoadPronunciationStatus();spLoadLearningReport();spGen()}
function spPool(t){var ai=(S&&S.spkAi&&S.spkAi['p'+t])||[];return speakingModule.pool([SP1,SP2,SP3,SP4][t-1],ai)}
function spSet(t){var k='spIdx'+t;S[k]=(S[k]||0);return speakingModule.select(spPool(t),S[k])}
function spNextSet(t){if((SP&&SP.adaptiveContentRef)||adaptiveSpeakingLock()){try{toast('В персональном занятии закреплён точный вариант задания')}catch(_){}return false}S['spIdx'+t]=(S['spIdx'+t]||0)+1;save();return true}
async function spOpen(t,options){var adaptiveLock=options&&options.adaptiveLock||null;var targetedPractice=options&&options.targetedPractice||null;var lock=adaptiveSpeakingLock();if(lock&&!adaptiveLock)return launchAdaptiveSpeakingLock(lock);var adaptiveContentRef=adaptiveLock&&adaptiveLock.contentRef||null;var freshAssignment=Boolean(adaptiveContentRef||targetedPractice);var targetedBody=targetedPractice?{targetedPractice:{sourceAttemptId:targetedPractice.sourceAttemptId,reportRevision:targetedPractice.reportRevision,accentLocale:targetedPractice.accentLocale||null,skillId:targetedPractice.skillId,contentRef:targetedPractice.contentRef}}:null;function assignmentPost(path,body){var assignmentPath='/api/v1/speaking/task-'+t+'/sessions';if(targetedBody&&path===assignmentPath)return apiPost(path,targetedBody);return apiPost(path,body)}spReleaseRecording();spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();SP_sheet=false;
  if(t===1){var area=document.getElementById('s9_area');if(area)area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает текст…</div>';
    SP_TASK1_FLOW=createSpeakingTask1BrowserFlow({api:{post:function(path,body){if(targetedBody&&path==='/api/v1/speaking/task-1/sessions')return apiPost(path,targetedBody);return apiPost(path,SP_ACCENT_SETUP&&!SP_ACCENT?{calibrationSetupId:SP_ACCENT_SETUP.id}:body)}}});
    try{var session=await SP_TASK1_FLOW.loadAssignment();var serverSet=speakingModule.serverTask1Set(session);if(!serverSet||!SP_TASK1_CATALOG_KEYS.has(serverSet.id+'@'+serverSet.revision))throw new Error('SPEAKING_TASK1_RESPONSE_INVALID');
      SP={t:1,set:serverSet,session:session,phase:'intro',qi:0,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){spDisposeTask1Flow();SP=null;try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===2){var task2Area=document.getElementById('s9_area');if(task2Area)task2Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает объявление…</div>';
    SP_TASK2_FLOW=createSpeakingTask2BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});
    try{var task2Session=null;
      if(!freshAssignment&&S.speakingTask2SessionId){try{task2Session=await SP_TASK2_FLOW.restoreSession(S.speakingTask2SessionId)}catch(error){
        if(!task2RecoveryPointerInvalid(error))throw error;delete S.speakingTask2SessionId;save()}}
      if(!task2Session||task2Session.status==='completed')task2Session=await SP_TASK2_FLOW.loadAssignment();
      var serverTask2=speakingModule.serverTask2Set(task2Session);
      if(!serverTask2||!SP_TASK2_CATALOG_KEYS.has(serverTask2.id+'@'+serverTask2.revision))throw new Error('SPEAKING_TASK2_RESPONSE_INVALID');
      if(!adaptiveContentRef){S.speakingTask2SessionId=task2Session.id;save()}
      SP={t:2,set:serverTask2,session:task2Session,phase:task2Session.status==='assigned'?'intro':'question',qi:task2Session.currentQuestion-1,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){spDisposeTask2Flow();SP=null;if(task2RecoveryPointerInvalid(error)){delete S.speakingTask2SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===3){var task3Area=document.getElementById('s9_area');if(task3Area)task3Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает интервью…</div>';
    SP_TASK3_FLOW=createSpeakingTask3BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});
    try{var task3Session=null;
      if(!freshAssignment&&S.speakingTask3SessionId){try{task3Session=await SP_TASK3_FLOW.restoreSession(S.speakingTask3SessionId)}catch(error){
        if(!task3RecoveryPointerInvalid(error))throw error;delete S.speakingTask3SessionId;save()}}
      if(!task3Session||task3Session.status==='completed')task3Session=await SP_TASK3_FLOW.loadAssignment();
      var serverTask3=speakingModule.serverTask3Set(task3Session);
      if(!serverTask3||!SP_TASK3_CATALOG_KEYS.has(serverTask3.id+'@'+serverTask3.revision))throw new Error('SPEAKING_TASK3_RESPONSE_INVALID');
      if(!adaptiveContentRef){S.speakingTask3SessionId=task3Session.id;save()}
      SP={t:3,set:serverTask3,session:task3Session,phase:task3Session.status==='assigned'?'intro':'question',qi:task3Session.currentQuestion-1,url:null,mic:null,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){spDisposeTask3Flow();SP=null;if(task3RecoveryPointerInvalid(error)){delete S.speakingTask3SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  if(t===4){var task4Area=document.getElementById('s9_area');if(task4Area)task4Area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер подбирает фотопроект и загружает изображения…</div>';
    var task4Flow=createSpeakingTask4BrowserFlow({api:{post:assignmentPost,get:function(path){return apiGet(path)}}});SP_TASK4_FLOW=task4Flow;
    try{var task4Session=null;
      if(!freshAssignment&&S.speakingTask4SessionId){try{task4Session=await task4Flow.restoreSession(S.speakingTask4SessionId);if(SP_TASK4_FLOW!==task4Flow)return false}catch(error){
        if(!task4RecoveryPointerInvalid(error))throw error;delete S.speakingTask4SessionId;save()}}
      if(!task4Session||task4Session.status==='completed'){task4Session=await task4Flow.loadAssignment();if(SP_TASK4_FLOW!==task4Flow)return false}
      var serverTask4=speakingModule.serverTask4Set(task4Session);
      if(!serverTask4||!SPEAKING_TASK4_CATALOG.tasks.some(function(task){return task.id===serverTask4.id&&task.revision===serverTask4.revision}))throw new Error('SPEAKING_TASK4_RESPONSE_INVALID');
      await task4Flow.prepareAssets();if(SP_TASK4_FLOW!==task4Flow)return false;
      if(!adaptiveContentRef){S.speakingTask4SessionId=task4Session.id;save()}
      SP={t:4,set:serverTask4,session:task4Session,phase:'intro',qi:0,url:null,mic:null,assetReady:true,adaptiveContentRef:adaptiveContentRef};spRender();return true}
    catch(error){if(SP_TASK4_FLOW!==task4Flow)return false;spDisposeTask4Flow();SP=null;if(task4RecoveryPointerInvalid(error)){delete S.speakingTask4SessionId;save()}
      try{toast(apiMessage(error,'request'))}catch(_){}spHub();return false}}
  SP={t:t,set:spSet(t),phase:'intro',qi:0,url:null};spRender();return true}
function launchSpeakingTask(taskNumber,contentRef){
  var descriptor=adaptiveSpeakingTask(contentRef);if(!descriptor||descriptor.taskNumber!==Number(taskNumber))return false;
  return launchAdaptiveSpeakingLock({contentRef:contentRef})}
function spRestartAdaptive(){if(!SP||!SP.adaptiveContentRef||SP.evaluating)return false;var taskNumber=SP.t,contentRef=SP.adaptiveContentRef;spStopAll();return launchSpeakingTask(taskNumber,contentRef)}
function spBtn(label,fn,solid){return '<button type="button" class="sq" style="'+WBTN+(solid?'background:linear-gradient(135deg,#A83226,#7A251D);color:#fff;border:none;box-shadow:0 12px 24px rgba(122,37,29,.28);':'color:#B54E2F;')+'" onclick="'+fn+'">'+label+'</button>'}
function spTimerChip(){return '<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;">'
  +'<span id="s9_timer" style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;">'+spFmt(SP.left)+'</span></div>'
  +'<div style="margin-top:8px;height:7px;border-radius:5px;background:#F1EDE7;"><div id="s9_tbar" style="width:100%;height:100%;border-radius:5px;background:linear-gradient(90deg,#FFA570,#F2683F);"></div></div>'}
function spTick(total,onEnd){clearInterval(SP_tm);
  SP_tm=setInterval(function(){if(!SP){clearInterval(SP_tm);return}
    SP.left--;setTxt('s9_timer',spFmt(SP.left));
    var b=document.getElementById('s9_tbar');if(b)b.style.width=Math.max(0,Math.round(SP.left/total*100))+'%';
    setTxt('s9_today',spFmt(SP.left));
    if(SP.left<=0){clearInterval(SP_tm);onEnd()}},1000)}
/* Показ листа с подсказками: переменную модуля разметка присвоить не может. */
async function spToggleSheet(){if(!SP)return false;if(!SP_sheet&&SP.session&&SP.session.id){try{await apiPost('/api/v1/speaking/task-'+SP.t+'/sessions/'+SP.session.id+'/assistance',{})}catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}SP_sheet=!SP_sheet;spRender();return true}
function spRender(){var area=document.getElementById('s9_area');if(!area||!SP)return;
  var t=SP.t,c=SP_CONF[t],set=SP.set;
  if(officialTask2Active()&&SP.phase==='question'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 4</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;margin-top:10px;">Продолжить с вопроса '+(SP.qi+1)+' из 4</div>'
      +spTaskBody()
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов':'Сигнал тихий · подвинь микрофон ближе'):'После восстановления снова проверь микрофон')+'</div></div>'
      +spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>'
      +spBtn('Записать вопрос '+(SP.qi+1),'spRec()',true)+'<div style="height:10px;"></div>'+spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Запись вопроса '+(SP.qi+1)+' готова</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только безопасные метаданные.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать вопрос '+(SP.qi+1),'spPlayTask2Question('+(SP.qi+1)+')',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Как получился прямой вопрос?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask2Question(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать вопрос','spRec()');
    spAnim('win','.32s');return}
  if(officialTask2Active()&&SP.phase==='task2_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">4 отдельные записи завершены</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Все четыре локальные записи готовы. По твоей команде они будут отправлены в защищённый контур оценки и связаны только с этой тренировкой.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('✨ Оценить по критериям ЕГЭ','spEval(this)',true)+'<div id="sp_evalbox"></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(2)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='question'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 5</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:18px;color:#2B2B2B;margin-top:10px;">Продолжить с вопроса '+(SP.qi+1)+' из 5</div>'
      +spTargetFocusBanner()
      +'<div lang="en" style="font-weight:600;font-size:12px;color:#777163;line-height:1.5;margin-top:8px;">'+ui.escapeHtml(SP.set.instruction)+'</div>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:9px;">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов':'Сигнал тихий · подвинь микрофон ближе'):'После восстановления снова проверь микрофон')+'</div></div>'
      +spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>'
      +spBtn('Записать ответ '+(SP.qi+1),'spRec()',true)+'<div style="height:10px;"></div>'+spBtn('← К заданиям','spStopAll();initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_prompt'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#317485;background:#E3F1F5;padding:5px 10px;border-radius:20px;">ВОПРОС '+(SP.qi+1)+' ИЗ 5</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:10px;">Сначала прозвучит вопрос</div>'
      +'<div lang="en" style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:9px;">'+ui.escapeHtml(SP.set.qs[SP.qi])+'</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:8px;">Запись и 40-секундный таймер начнутся после окончания вопроса.</div></div>';
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Ответ '+(SP.qi+1)+' записан</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только безопасные метаданные.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать ответ '+(SP.qi+1),'spPlayTask3Answer('+(SP.qi+1)+')',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Получился полный ответ из 2–3 предложений?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask3Answer(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать ответ','spRec()');
    spAnim('win','.32s');return}
  if(officialTask3Active()&&SP.phase==='task3_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">5 отдельных записей завершены</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Все пять локальных записей готовы. По твоей команде они будут отправлены в защищённый контур оценки и связаны с точными вопросами интервью.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('✨ Оценить по критериям ЕГЭ','spEval(this)',true)+'<div id="sp_evalbox"></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(3)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_review'){
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:20px;text-align:center;">'+wDeco()
      +'<div style="font-size:40px;">🎙️</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Монолог записан</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;margin-top:5px;">Послушай локальную запись. На сервер уйдут только длительность, проверка микрофона, факт локального прослушивания и самооценка.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('▶ Послушать монолог','spPlay()',true)
      +'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Получилось раскрыть все четыре пункта плана?</div><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px;">'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Повторить</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
      +'<button type="button" class="sq" onclick="spCompleteTask4(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>'
      +'<div style="height:10px;"></div>'+spBtn('Перезаписать монолог','spRec()');
    spAnim('win','.32s');return}
  if(officialTask4Active()&&SP.phase==='task4_complete'){
    area.innerHTML='<div id="s9_card" class="clayCard" role="status" aria-live="polite" style="position:relative;overflow:hidden;padding:22px;text-align:center;">'+wDeco()
      +'<div style="font-size:42px;">✅</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:20px;color:#2B2B2B;margin-top:8px;">Тренировка задания 4 завершена</div>'
      +'<div style="font-weight:600;font-size:13px;color:#777163;line-height:1.55;margin-top:7px;">Локальная запись готова. По твоей команде она будет отправлена в защищённый контур и проверена по трём критериям задания 4.</div></div>'
      +'<div style="height:10px;"></div>'+spBtn('✨ Оценить по критериям ЕГЭ','spEval(this)',true)+'<div id="sp_evalbox"></div>'
      +'<div style="height:10px;"></div>'+spBtn('Новая тренировка','spOpen(4)',true)+'<div style="height:10px;"></div>'+spBtn('К заданиям','initSpeaking()');
    spAnim('win','.32s');return}
  /* ---- интро ---- */
  if(SP.phase==='intro'){
    var body='';
    if(t===1)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Прочитай назначенный сервером текст вслух. Подготовка — '+spFmt(c.prep)+', чтение — до '+spFmt(c.rec)+'.</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>';
    if(t===2)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Изучи назначенное сервером объявление и задай <b>4 прямых вопроса</b> по пунктам. Подготовка — '+spFmt(c.prep)+', на каждый вопрос — 20 секунд.</div>'
      +'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
      +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>';
    if(t===3)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Интервью на тему «'+ui.escapeHtml(set.topic)+'». Услышишь 5 вопросов — на каждый отвечай 2–3 предложениями, до 40 секунд. Подготовки нет, как на экзамене.</div>'
      +(officialTask3Active()?'<div lang="en" style="margin-top:10px;padding:11px 13px;border-radius:13px;background:#FAF6F1;font-weight:700;font-size:12.5px;color:#4A453E;line-height:1.55;">'+ui.escapeHtml(set.instruction)+'</div>':'')
      +(officialTask3Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
        +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед первым вопросом проверь разрешение и уровень микрофона')+'</div>':'');
    if(t===4)body='<div style="font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;">Подготовь проектное высказывание по двум фотографиям и четырём пунктам плана. Подготовка — '+spFmt(c.prep)+', монолог — до '+spFmt(c.rec)+'.</div>'
      +(officialTask4Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:#EAF7F0;color:#1D7F4A;font-weight:700;font-size:12px;">Фотопара полностью загружена и декодирована до запуска таймера.</div>':'')
      +(officialTask4Active()?'<div role="status" aria-live="polite" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:'+(SP.mic?(SP.mic.status==='passed'?'#EAF7F0':'#FFF4DE'):'#F4EFE9')+';font-weight:700;font-size:12px;color:#4A453E;">'
        +(SP.mic?(SP.mic.status==='passed'?'Микрофон готов · уровень '+Math.round((SP.mic.level||0)*100)+'%':'Сигнал тихий · подвинь микрофон ближе'):'Перед таймером проверь разрешение и уровень микрофона')+'</div>':'');
    area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
      +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">'+c.sub.toUpperCase()+'</span>'
      +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:10px;">'+c.name+'</div>'
      +'<div style="margin-top:8px;">'+body+'</div>'
      +(officialTask4Active()?spTaskBody():'')
      +'<div style="margin-top:11px;display:flex;gap:8px;">'
      +(SP.adaptiveContentRef||officialTask4Active()?'':'<button type="button" class="clk sq iconbtn" onclick="'+(t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)')+'" style="flex:1;text-align:center;background:#FFEDE4;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#C2421B;cursor:pointer;">Другой вариант</button>')
      +(SP.adaptiveContentRef||officialTask3Active()||officialTask4Active()?'':'<button type="button" class="clk sq iconbtn" onclick="spToggleSheet()" style="flex:1;text-align:center;background:#EAF7F0;border-radius:13px;padding:9px 0;font-weight:800;font-size:12px;color:#1D7F4A;cursor:pointer;">'+(SP_sheet?'Скрыть шпаргалку':'Шпаргалка')+'</button>')+'</div>'
      +(SP_sheet&&!officialTask3Active()&&!officialTask4Active()?'<div style="margin-top:11px;background:#F2F8F4;border-radius:14px;padding:11px 13px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.65;">'+SP_SHEET[t]+'</div>':'')
      +'</div>'
      +((t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())?spBtn(SP.mic?'Проверить микрофон ещё раз':'Проверить микрофон','spMicCheck(this)',!SP.mic)+'<div style="height:10px;"></div>':'')
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
       +(officialTask3Active()?'':'<div style="margin-top:10px;"><button type="button" class="clk sq iconbtn" onclick="lPlayRaw([{s:1,t:SP.set.qs[SP.qi]}])" style="display:inline-flex;align-items:center;gap:7px;background:#E3F1F5;border-radius:13px;padding:9px 14px;font-weight:800;font-size:12px;color:#317485;cursor:pointer;">🔊 Озвучить вопрос</button></div>')
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
    var assessmentAction=SP.accentCalibration?'spAccentFinishUnknown(this)':'spEval(this)';
    var assessmentLabel=SP.accentCalibration?'Определить вариант произношения':'✨ Оценить по критериям ЕГЭ';
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
      +(SP.blob&&(SP.accentCalibration||t!==1||SP.task1Completed)?'<div style="height:10px;"></div><button type="button" class="sq" onclick="'+assessmentAction+'" style="'+WBTN.replace('background:#fff','background:linear-gradient(135deg,#1D6944,#155235)').replace('color:#2B2B2B','color:#fff').replace('border:1px solid #F0EAE2','border:none')+'box-shadow:0 12px 24px rgba(21,82,53,.28);">'+assessmentLabel+'</button>':'')
      +(SP.blob?'<div style="height:10px;"></div>'+spBtn('Удалить запись','spDeleteRecording()'):'')
      +(SP.blob&&t===1&&!SP.task1Completed?'<div class="clayCard" style="padding:14px 16px;margin-top:12px;"><div style="font-weight:800;font-size:12px;color:#4A453E;">Как ощущалось чтение?</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;">'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'weak\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FDEDEA;color:#A83226;font-weight:800;">Нужно повторить</button>'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'steady\',this)" style="min-height:44px;border:0;border-radius:12px;background:#FFF4DE;color:#8A641A;font-weight:800;">Нормально</button>'
        +'<button type="button" class="sq" onclick="spCompleteTask1(\'strong\',this)" style="min-height:44px;border:0;border-radius:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;">Уверенно</button></div></div>':'')
      +(t===1&&SP.task1Completed?'<div role="status" aria-live="polite" style="margin-top:12px;padding:10px 12px;border-radius:13px;background:#EAF7F0;color:#1D7F4A;font-weight:800;font-size:12px;">Безопасная история тренировки сохранена.</div>':'')
      +(SP.t>1&&!SP.adaptiveContentRef?'<div style="height:10px;"></div>'+spBtn('Образец ответа от ИИ','spSample(this)'):'')
      +'<div id="sp_evalbox"></div>'
      +extra
      +(SP.adaptiveContentRef
        ?'<div style="height:10px;"></div><div style="text-align:center;font-weight:700;font-size:12.5px;color:#777163;line-height:1.5;">В персональном занятии закреплено это задание. Оцени ответ или перезапиши тот же вариант.</div><div style="height:10px;"></div><button id="adaptive_speaking_retry" class="sq" style="'+WBTN+'" onclick="spRestartAdaptive()">Записать этот вариант ещё раз</button>'
        :'<div style="height:10px;"></div>'+spBtn('Ещё раз',t===1?'spOpen(1)':'spNextSet(SP.t);spOpen(SP.t)')
          +'<div style="height:10px;"></div>'+spBtn('К заданиям','spStopAll();initSpeaking()'));
    spAnim('win','.32s');setTxt('s9_today',SP_CONF[t].name);return}}
function spTargetFocusBanner(){var target=SP&&SP.session&&SP.session.targetedPractice;if(!target)return '';var focus=target.focus;var detail=focus?(focus.kind==='phoneme'?'/'+focus.value+'/ · '+focus.anchorWord:focus.value):target.label;return '<div role="status" style="margin-top:10px;padding:10px 12px;border-radius:13px;background:#EAF7F0;color:#1D6944;font-size:12px;font-weight:750;"><b>Цель этой проверки:</b> '+ui.escapeHtml(detail||target.label)+'</div>'}
function spTaskBody(){var t=SP.t,set=SP.set,focus=spTargetFocusBanner();
  if(t===1)return focus+'<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+ui.escapeHtml(set.tx)+'</div>';
  if(t===2)return focus+'<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+ui.escapeHtml(set.ad)+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">Задай прямые вопросы о:</div>'
    +set.points.map(function(p,i){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:'+(officialTask2Active()&&i===SP.qi?'#A83226':'#C2421B')+';">'+(i+1)+'. '+ui.escapeHtml(p)+'</div>'}).join('');
  if(t===4&&officialTask4Active()){var photoAsset=task4PhotoAsset(set.photoPair.src);return focus+'<div lang="en" style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">'+ui.escapeHtml(set.projectTitle)+'</div>'
    +'<figure style="margin:12px 0 0;max-width:920px;">'
    +'<img loading="lazy" decoding="async" src="'+ui.escapeHtml(set.photoPair.src)+'" alt="'+ui.escapeHtml(set.photoPair.alt)+'" width="'+(photoAsset?photoAsset.width:1536)+'" height="'+(photoAsset?photoAsset.height:1024)+'" style="display:block;width:100%;height:auto;border-radius:16px;background:#F4EFE9;">'
    +'<figcaption style="margin-top:7px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">Две оригинальные фотографии для сравнения: слева и справа.</figcaption></figure>'
    +'<div lang="en" style="margin-top:10px;font-weight:600;font-size:12px;color:#777163;line-height:1.5;">'+ui.escapeHtml(set.instruction)+'</div>'
    +'<div style="margin-top:9px;font-weight:700;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div lang="en" style="margin-top:5px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">'+(i+1)+'. '+ui.escapeHtml(p)+'</div>'}).join('')}
  if(t===4)return focus+'<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Тема: '+set.topic+'</div>'
    +set.ph.map(function(p){return '<div style="margin-top:8px;background:#FAF6F1;border-radius:14px;padding:10px 13px;font-weight:600;font-size:12.5px;color:#4A453E;font-style:italic;">'+p+'</div>'}).join('')
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +set.plan.map(function(p,i){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(i+1)+'. '+p+'</div>'}).join('');
  return focus}
async function spMicCheck(btn){if(!SP||!((SP.t===1&&SP_TASK1_FLOW)||officialTask2Active()||officialTask3Active()||officialTask4Active()))return false;if(btn)btn.disabled=true;
  try{SP.mic=await (SP.t===1?SP_TASK1_FLOW:(officialTask2Active()?SP_TASK2_FLOW:(officialTask3Active()?SP_TASK3_FLOW:SP_TASK4_FLOW))).checkMicrophone();spRender();return true}
  catch(error){SP.mic=null;try{toast(error&&error.code==='MICROPHONE_PERMISSION_DENIED'?'Нет доступа к микрофону. Разреши его в настройках браузера.':'Микрофон не готов. Проверь подключение и попробуй снова.')}catch(_){}spRender();return false}}
function spPrep(){var c=SP_CONF[SP.t];
  if((SP.t===1||officialTask2Active()||officialTask3Active()||officialTask4Active())&&!SP.mic){try{toast('Сначала проверь микрофон — официальный таймер ещё не запущен.')}catch(_){}return}
  if(officialTask4Active()&&!SP.assetReady){try{toast('Дождись полной загрузки фотопары — таймер ещё не запущен.')}catch(_){}return}
  if(!c.prep)return spRec();
  SP.phase='prep';SP.left=c.prep;spRender();
  spTick(c.prep,function(){spRec()})}
async function spRec(){var c=SP_CONF[SP.t];
  clearInterval(SP_tm);
  spReleaseRecording();
  if(SP.t===1&&SP_TASK1_FLOW){try{await SP_TASK1_FLOW.startRecording();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return}
    catch(error){SP.phase='intro';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись. Проверь разрешение на микрофон.')}catch(_){}return}}
  if(officialTask2Active()){try{await SP_TASK2_FLOW.startQuestion();SP.phase='rec';SP.qi=SP.session.currentQuestion-1;SP.left=c.per;spRender();spTick(c.per,function(){spFinish()});return}
    catch(error){SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись вопроса.')}catch(_){}return}}
  if(officialTask3Active()){var task3SessionId=SP.session.id;SP.qi=SP.session.currentQuestion-1;var task3Question=SP.set.qs[SP.qi];SP.phase='task3_prompt';spRender();
    try{await Promise.resolve(lPlayRaw([{s:1,t:task3Question}]))}catch(_){}
    if(!SP||!SP_TASK3_FLOW||SP.session.id!==task3SessionId||SP.session.currentQuestion-1!==SP.qi)return false;
    try{await SP_TASK3_FLOW.startAnswer();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){SP.phase=SP.session.status==='assigned'?'intro':'question';spRender();try{toast(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись ответа.')}catch(_){}return}}
  if(officialTask4Active()){try{await SP_TASK4_FLOW.startRecording();SP.phase='rec';SP.left=c.rec;spRender();spTick(c.rec,function(){spFinish()});return true}
    catch(error){SP.phase='intro';spRender();try{toast(error&&error.code==='SPEAKING_TASK4_ASSET_NOT_READY'?'Дождись полной загрузки фотопары.':(error&&error.code==='MIC_CHECK_REQUIRED'?'Сначала проверь микрофон.':'Не удалось начать запись монолога.'))}catch(_){}return false}}
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
async function spFinish(){if(!SP)return;clearInterval(SP_tm);try{lStop()}catch(e){}
  if(officialTask2Active()){try{var task2Recording=await SP_TASK2_FLOW.stopQuestion();SP.blob=task2Recording.blob;SP.url=task2Recording.url;SP.phase='task2_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return}
  if(officialTask3Active()){try{var task3Recording=await SP_TASK3_FLOW.stopAnswer();SP.blob=task3Recording.blob;SP.url=task3Recording.url;SP.phase='task3_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase=SP.session.status==='assigned'?'intro':'question'}spRender();return}
  if(officialTask4Active()){try{var task4Recording=await SP_TASK4_FLOW.stopRecording();SP.blob=task4Recording.blob;SP.url=task4Recording.url;SP.phase='task4_review'}
    catch(error){SP.blob=null;SP.url=null;SP.phase='intro'}spRender();return}
  var r=spSt();r['t'+SP.t].n++;if(!SP.adaptiveContentRef)spNextSet(SP.t);
  SP.phase='done';
  if(SP.t===1&&SP_TASK1_FLOW){try{var localRecording=await SP_TASK1_FLOW.stopRecording();SP.blob=localRecording.blob;SP.url=localRecording.url}
    catch(error){SP.blob=null;SP.url=null}spSync();save();spRender();return}
  if(SP_rec&&SP_rec.state!=='inactive'){try{SP_rec.stop()}catch(e){}}
  spSync();save();spRender()}
var SP_audio=null;
async function spPlay(){if(!SP||!SP.url)return;
  if(officialTask2Active())return spPlayTask2Question(SP.qi+1);
  if(officialTask3Active())return spPlayTask3Answer(SP.qi+1);
  if(officialTask4Active()){try{await SP_TASK4_FLOW.playRecording();SP.played=true;return true}catch(error){try{toast('Локальная запись монолога недоступна.')}catch(_){}return false}}
  if(SP.t===1&&SP_TASK1_FLOW){try{await SP_TASK1_FLOW.playRecording();SP.played=true;return}catch(error){try{toast('Не удалось воспроизвести запись — попробуй ещё раз')}catch(_){}return}}
  try{lStop()}catch(e){}
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  SP_audio=new Audio(SP.url);
  SP_audio.onerror=function(){try{toast('Не удалось воспроизвести запись — попробуй записать ещё раз')}catch(e){}};
  SP_audio.play().catch(function(){try{toast('Браузер не дал воспроизвести — нажми ещё раз')}catch(e){}})}
function spDeleteRecording(){if(!SP)return;if(SP.t===1&&SP_TASK1_FLOW)SP_TASK1_FLOW.dispose();else if(SP.url)try{URL.revokeObjectURL(SP.url)}catch(e){}SP.url=null;SP.blob=null;SP_chunks=[];spRender();try{toast('Запись удалена')}catch(e){}}
async function spCompleteTask1(selfRating,btn){if(!SP||SP.t!==1||!SP_TASK1_FLOW||SP.task1Completed)return false;if(btn)btn.disabled=true;
  try{SP.completedSession=await SP_TASK1_FLOW.complete(selfRating);SP.task1Completed=true;spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spPlayTask2Question(questionNumber){if(!SP||SP.t!==2||!SP_TASK2_FLOW)return false;
  try{await SP_TASK2_FLOW.playQuestion(questionNumber);return true}catch(error){try{toast('Локальная запись этого вопроса недоступна.')}catch(_){}return false}}
async function spCompleteTask2Question(selfRating,btn){if(!SP||SP.t!==2||!SP_TASK2_FLOW||SP.task2Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK2_FLOW.completeQuestion(selfRating);SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task2Completed=true;SP.phase='task2_complete';delete S.speakingTask2SessionId;var r=spSt();r.t2.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spPlayTask3Answer(questionNumber){if(!SP||SP.t!==3||!SP_TASK3_FLOW)return false;
  try{await SP_TASK3_FLOW.playAnswer(questionNumber);return true}catch(error){try{toast('Локальная запись этого ответа недоступна.')}catch(_){}return false}}
async function spCompleteTask3Answer(selfRating,btn){if(!SP||SP.t!==3||!SP_TASK3_FLOW||SP.task3Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK3_FLOW.completeAnswer(selfRating);SP.blob=null;SP.url=null;
    if(SP.session.status==='completed'){SP.task3Completed=true;SP.phase='task3_complete';delete S.speakingTask3SessionId;var r=spSt();r.t3.n++;spSync();save()}
    else{SP.qi=SP.session.currentQuestion-1;SP.phase='question';save()}
    spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spCompleteTask4(selfRating,btn){if(!SP||SP.t!==4||!SP_TASK4_FLOW||SP.task4Completed)return false;if(btn)btn.disabled=true;
  try{SP.session=await SP_TASK4_FLOW.complete(selfRating);SP.task4Completed=true;SP.phase='task4_complete';
    delete S.speakingTask4SessionId;var r=spSt();r.t4.n++;spSync();save();spRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function spEtalon(){if(!SP||SP.t!==1)return;
  if(SP_audio){try{SP_audio.pause()}catch(e){}}
  var parts=speakingModule.sentences(SP.set.tx).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 2: расшифровка и оценка ИИ ---- */
async function spSTT(blob){
  var j=await apiPostBinary('/api/v1/stt',blob,blob.type||'application/octet-stream');
  return j.text||''}
function spAssignment(t,set){return speakingModule.assignment(t,set)}
function spOfficialRecordings(){
  if(!SP||!SP.session||!SP.session.id)return null;
  if(SP.t===1&&SP_TASK1_FLOW&&SP.blob)return [{blob:SP.blob,itemNumber:null}];
  if(SP.t===2&&SP_TASK2_FLOW)return SP_TASK2_FLOW.assessmentRecordings().map(function(item){return {blob:item.blob,itemNumber:item.positionNumber}});
  if(SP.t===3&&SP_TASK3_FLOW)return SP_TASK3_FLOW.assessmentRecordings().map(function(item){return {blob:item.blob,itemNumber:item.positionNumber}});
  if(SP.t===4&&SP_TASK4_FLOW&&SP.blob)return [{blob:SP.blob,itemNumber:null}];
  return null}
async function spUploadPronunciation(taskType,sessionId,recording,idempotencyKey,locale){
  if(!window.crypto||typeof window.crypto.randomUUID!=='function')throw new Error('безопасный ключ загрузки недоступен — обнови браузер');
  var wav=await convertRecordingToPcm16Wav(recording.blob);
  var speechLocale=locale||(SP&&SP.session&&SP.session.accentProfile&&SP.session.accentProfile.locale)||(SP_ACCENT&&SP_ACCENT.locale)||'en-GB';
  var headers={
    'Idempotency-Key':idempotencyKey||window.crypto.randomUUID(),
    'X-Speech-Locale':speechLocale,
    'X-Audio-Duration-Seconds':String(wav.durationSeconds)
  };
  if(recording.itemNumber!=null)headers['X-Speaking-Item']=String(recording.itemNumber);
  var result=await apiPostBinary('/api/v1/speaking/task-'+taskType+'/sessions/'+sessionId+'/pronunciation-assessment',wav.blob,'audio/wav',headers);
  if(!result||!result.billing||!result.billing.assessmentId||result.assessment&&result.assessment.status!=='success'){
    var unavailable=new Error('автоматическая оценка записи сейчас недоступна — попробуй позже');unavailable.code='SPEAKING_PRONUNCIATION_UNAVAILABLE';throw unavailable}
  return {key:headers['Idempotency-Key'],transcript:result.assessment&&result.assessment.transcript||'',wavBlob:wav.blob,locale:speechLocale}}
async function spAccentFinishUnknown(btn){
  if(!SP||SP.t!==1||!SP.blob||!SP.session||!SP.accentCalibration)return false;
  if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.textContent='Сравниваю en-GB и en-US…'}
  try{
    var recording={blob:SP.blob,itemNumber:null};
    var cache=SP.accentCalibrationUploadCache;
    if(!cache){cache={enGB:{key:window.crypto.randomUUID(),result:null},enUS:{key:window.crypto.randomUUID(),result:null}};SP.accentCalibrationUploadCache=cache}
    if(!cache.enGB.result)cache.enGB.result=await spUploadPronunciation(1,SP.session.id,recording,cache.enGB.key,'en-GB');
    if(!cache.enUS.result)cache.enUS.result=await spUploadPronunciation(1,SP.session.id,recording,cache.enUS.key,'en-US');
    var result=await apiPost('/api/v1/speaking/accent-profile/calibration/'+encodeURIComponent(SP.accentCalibration.id)+'/complete',{
      enGbAssessmentKey:cache.enGB.result.key,enUsAssessmentKey:cache.enUS.result.key
    });
    SP_ACCENT=result.profile;SP_ACCENT_SETUP=null;SP.accentCalibration=null;
    spHub();toast('Профиль '+result.profile.locale+' предложен и сохранён. Его можно изменить в любой момент.');return true
  }catch(error){if(btn){btn.disabled=false;btn.textContent='Повторить определение варианта';delete btn.dataset.busy}try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spContributeCalibration(btn){
  if(!SP||!SP.calibrationCandidate||!SP_CALIBRATION_CONSENT||!SP_CALIBRATION_CONSENT.granted)return false;
  if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.textContent='Передаю анонимную запись…'}
  try{await apiPostBinary('/api/v1/speaking/calibration-samples',SP.calibrationCandidate.wavBlob,'audio/wav',{'X-Speaking-Assessment-Key':SP.calibrationCandidate.key});SP.calibrationCandidate=null;if(btn){btn.textContent='Запись передана для двойной проверки'}toast('Спасибо. Эксперты не увидят имя или VK ID, а сырой звук будет удалён по правилам хранения.');return true}
  catch(error){if(btn){btn.disabled=false;btn.textContent='Повторить передачу для калибровки';delete btn.dataset.busy}try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function spEval(btn){
  if(!SP)return false;
  if(SP.t===1&&SP_TASK1_FLOW&&!SP.task1Completed)return false;
  var officialRecordings=spOfficialRecordings();
  if(!officialRecordings&& !SP.blob)return;
  var adaptiveRetry=document.getElementById('adaptive_speaking_retry');SP.evaluating=true;if(adaptiveRetry)adaptiveRetry.disabled=true;
  if(btn){if(btn.dataset.busy)return;btn.dataset.busy=1;btn.textContent=officialRecordings?'Готовлю аудио…':'Расшифровываю запись…';btn.style.pointerEvents='none'}
  try{
    var tr='';var evaluationRequest;
    if(officialRecordings){var uploaded=[];
      var uploadCache=SP.pronunciationUploadCache;
      if(!uploadCache||uploadCache.sessionId!==SP.session.id||uploadCache.taskType!==SP.t||uploadCache.items.length!==officialRecordings.length){
        uploadCache={sessionId:SP.session.id,taskType:SP.t,items:officialRecordings.map(function(){return {key:window.crypto.randomUUID(),result:null}})};
        SP.pronunciationUploadCache=uploadCache}
      for(var recordingIndex=0;recordingIndex<officialRecordings.length;recordingIndex++){
        if(btn)btn.textContent='Проверяю запись '+(recordingIndex+1)+' из '+officialRecordings.length+'…';
        var cachedUpload=uploadCache.items[recordingIndex];
        if(!cachedUpload.result)cachedUpload.result=await spUploadPronunciation(SP.t,SP.session.id,officialRecordings[recordingIndex],cachedUpload.key);
        uploaded.push(cachedUpload.result)}
      tr=uploaded.map(function(item){return item.transcript}).filter(Boolean).join('\n');
      evaluationRequest={taskType:SP.t,sessionId:SP.session.id};
      if(SP.t===2||SP.t===3)evaluationRequest.pronunciationAssessmentKeys=uploaded.map(function(item){return item.key});
      else evaluationRequest.pronunciationAssessmentKey=uploaded[0].key
    }else{throw new Error('серверная запись не найдена — начни тренировку заново')}
    if(btn)btn.textContent='Оцениваю по критериям…';
    var response=await apiPost('/api/v1/ai/evaluate-speaking',evaluationRequest,true);
    var d=response.review;
    if(!d||typeof d.got==='undefined')throw new Error('ИИ вернул неожиданный ответ, попробуй ещё раз');
    if(d.status==='needs_retry'){
      SP.pronunciationUploadCache=null;
      if(btn){btn.style.display='none';btn.style.pointerEvents='';delete btn.dataset.busy}
      SP.evaluating=false;if(adaptiveRetry)adaptiveRetry.disabled=false;spShowEval(d,tr,null);return}
    var score=speakingModule.clampScore(d,SP.t);d.got=score.got;d.max=score.max;
    S.spkScores=speakingModule.appendScore(S.spkScores,{t:SP.t,g:d.got,m:d.max,ts:Date.now()});
    SP.calibrationCandidate=SP_CALIBRATION_CONSENT&&SP_CALIBRATION_CONSENT.granted&&uploaded.length===1&&(SP.t===1||SP.t===4)
      ?{key:uploaded[0].key,wavBlob:uploaded[0].wavBlob}:null;
    spSync();save();
    if(btn){btn.style.display='none'}
    var freshVoiceTutor=null;
    try{
      var freshVoiceReport=await apiGet('/api/v1/speaking/learning-report');
      var freshVoicePointer=freshVoiceReport&&freshVoiceReport.premium&&freshVoiceReport.premium.voiceTutor;
      var freshVoiceOptions=spVoiceTutorOptions(freshVoicePointer);var freshVoiceReady=Boolean(freshVoiceOptions);
      if(freshVoiceReady&&String(freshVoicePointer.attemptId)===String(response.attemptId)){
        freshVoiceTutor=freshVoiceOptions
      }
    }catch(_){}
    spShowEval(d,tr,freshVoiceTutor);
    completeAdaptiveServerAttempt('speaking',response.attemptId).then(function(result){if(result)showAdaptiveSpeakingReturn()}).catch(function(error){
      try{toast('Оценка сохранена, но план пока не обновлён: '+apiMessage(error,'request'))}catch(_){}});
  }catch(e){
    if(SP)SP.evaluating=false;if(adaptiveRetry)adaptiveRetry.disabled=false;
    if(btn){btn.textContent='✨ Оценить с ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'stt'))}catch(_){}}}
function spShowEval(d,tr,voiceTutor){var box=document.getElementById('sp_evalbox');if(!box)return;
  /* всё, что пришло от модели или STT, попадает в DOM только экранированным */
  var safe=ui.escapeHtml;
  if(d.status==='needs_retry'){
    box.innerHTML='<div class="clayCard" role="status" style="padding:18px;margin-top:12px;background:#FFF4E6;color:#714515;">'
      +'<div style="font-weight:900;font-size:18px;">Нужна ещё одна запись</div>'
      +'<div style="font-weight:600;font-size:13px;line-height:1.5;margin-top:6px;">'+safe(d.verdict||'Запись или расшифровка недостаточно надёжна для честного балла. Попробуй записать ответ ещё раз.')+'</div>'
      +'<div style="font-weight:600;font-size:11.5px;line-height:1.5;margin-top:8px;">Ноль не поставлен: автоматическая система не уверена в доказательствах.</div></div>';return}
  var pct=d.got/(d.max||1);
  var col=pct>=0.7?'#1F8A50':(pct>=0.4?'#C77400':'#C0392B');
  var h='<div class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-top:12px;animation:wflip .5s cubic-bezier(.25,.75,.35,1) both;">'
    +'<div style="text-align:center;">'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:30px;color:'+col+';">'+d.got+' из '+d.max+'</div>'
    +(speakingModule.isExperimentalTask(SP.t)||SP.t===1||SP.t===2?'<div class="ai-disclaimer" style="margin-top:6px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">'+ui.escapeHtml(ui.AI_DISCLAIMER)+'</div>':'')
    +'<div style="font-weight:700;font-size:13.5px;color:#2B2B2B;margin-top:4px;">'+safe(d.verdict||'')+'</div></div>';
  if(Array.isArray(d.criteria)&&d.criteria.length)
    h+='<div style="margin-top:12px;">'+d.criteria.map(function(c){
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #F4EFE9;font-weight:600;font-size:12.5px;color:#4A453E;"><span>'+safe(c.name)+'</span><b style="flex:none;color:'+((+c.got||0)>=(+c.max||1)?'#1F8A50':'#C77400')+';">'+safe(c.got)+' / '+safe(c.max)+'</b></div>'}).join('')+'</div>';
  if(Array.isArray(d.good)&&d.good.length)
    h+='<div style="margin-top:12px;background:#F2F8F4;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#1D7F4A;">ЧТО ПОЛУЧИЛОСЬ</div>'
      +d.good.map(function(g){return '<div style="margin-top:5px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">• '+safe(g)+'</div>'}).join('')+'</div>';
  if(Array.isArray(d.fix)&&d.fix.length)
    h+='<div style="margin-top:10px;background:#FDF3EC;border-radius:14px;padding:11px 13px;">'
      +'<div style="font-weight:800;font-size:10px;letter-spacing:1.2px;color:#C2421B;">НАД ЧЕМ ПОРАБОТАТЬ</div>'
      +d.fix.map(function(f){return '<div style="margin-top:7px;font-weight:600;font-size:12.5px;color:#4A453E;line-height:1.5;">'
        +(f.wrong?'<s style="color:#A83226;">'+safe(f.wrong)+'</s> → ':'')+(f.right?'<b style="color:#1D7F4A;">'+safe(f.right)+'</b><br>':'')+safe(f.note||'')+'</div>'}).join('')+'</div>';
  var evidenceNote=SP.t===1
    ?'Автоматическая оценка учла распознанный текст, полноту чтения, беглость распознавания и отмеченные системой грубые ошибки в словах. Интонация и отдельные фонемы в балл не входили.'
    :'Автоматическая оценка учла распознанное содержание ответа и отмеченные системой грубые ошибки в словах. Интонация, отдельные фонемы и естественность пауз в балл не входили.';
  h+='<div style="margin-top:10px;font-weight:600;font-size:11.5px;color:#777163;line-height:1.5;">'+safe(evidenceNote)+'</div>';
  if(SP.calibrationCandidate)h+='<div style="margin-top:10px;padding:11px 13px;border-radius:14px;background:#F2F8F4;font-size:11.5px;line-height:1.5;color:#4A453E;"><b>Добровольная калибровка точности</b><br>Можно отдельно передать эту запись для двух независимых слепых оценок. Имя и VK ID экспертам не показываются.<button type="button" class="sq" onclick="spContributeCalibration(this)" style="display:block;width:100%;margin-top:9px;border:0;border-radius:11px;padding:10px;background:#E3F1F5;color:#317485;font-weight:800;cursor:pointer;">Передать анонимную запись</button></div>';
  h+='<details style="margin-top:12px;"><summary style="font-weight:700;font-size:12px;color:#777163;cursor:pointer;">Расшифровка твоей речи</summary>'
    +'<div style="margin-top:8px;font-weight:500;font-size:12.5px;color:#4A453E;line-height:1.6;font-style:italic;">'+safe(tr)+'</div><button class="sq" onclick="spFlagTranscript()" style="margin-top:8px;border:0;background:#F4EFE9;padding:7px 10px;border-radius:10px;font-weight:700;font-size:11px;">Расшифровка неточная</button></details>'
    +(voiceTutor?voiceTutorButton(voiceTutor):'')
    +'</div>';
  box.innerHTML=h;
  try{box.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}}
function showAdaptiveSpeakingReturn(){var box=document.getElementById('sp_evalbox');if(!box||document.getElementById('adaptive_speaking_return'))return;var retry=document.getElementById('adaptive_speaking_retry');if(retry)retry.style.display='none';var button=document.createElement('button');button.id='adaptive_speaking_return';button.type='button';button.className='sq';button.textContent='Вернуться к персональному плану';button.setAttribute('style','width:100%;margin-top:12px;border:0;border-radius:14px;padding:12px;background:#EAF7F0;color:#1D7F4A;font-weight:800;cursor:pointer;');button.addEventListener('click',openAdaptivePlan);box.appendChild(button)}
function spFlagTranscript(){S.sttFeedback=(S.sttFeedback||0)+1;save();try{toast('Спасибо, отметка сохранена')}catch(e){}}
async function spSample(btn){
  if(!SP)return;var t=SP.t,set=SP.set;
  if(officialTask2Active()||officialTask3Active()||officialTask4Active())return;
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
      +'<div style="margin-top:9px;font-weight:500;font-size:13px;color:#2B2B2B;line-height:1.65;">'+ui.escapeHtml(SP.sample)+'</div></div>');
    if(btn){btn.style.display='none'}
  }catch(e){
    if(btn){btn.textContent='Образец ответа от ИИ · повторить';btn.style.pointerEvents='';delete btn.dataset.busy}
    try{toast(apiMessage(e,'ai'))}catch(_){}}}
function spVoiceSample(){if(!SP||!SP.sample)return;
  var parts=speakingModule.sentences(SP.sample).map(function(x){return {s:0,t:x}});
  try{lPlayRaw(parts)}catch(e){}}
/* ---- этап 3: экзамен устной части целиком ---- */
let SPE=null,SPE_FLOW=null,SPE_TM=null,SPE_STARTING=false,SPE_PROMPT_SEQUENCE=0,SPE_FULL_RESULT=null,SPE_FULL_UPLOAD_CACHE=null;
function speFullDispose(){clearInterval(SPE_TM);SPE_TM=null;SPE_STARTING=false;SPE_PROMPT_SEQUENCE++;try{lStop()}catch(_){}if(SPE_FLOW){SPE_FLOW.dispose();SPE_FLOW=null}SPE=null;SPE_FULL_RESULT=null;SPE_FULL_UPLOAD_CACHE=null}
function speFullPointerInvalid(error){return Number(error&&error.status)===404
  ||String(error&&error.code)==='SPEAKING_FULL_CATALOG_REVISION_MISMATCH'}
function spExam(){var area=document.getElementById('s9_area');if(!area)return;spStopAll();SP=null;
  var lock=adaptiveSpeakingLock();if(lock){launchAdaptiveSpeakingLock(lock);return}
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">КАК НА ЕГЭ</span>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:19px;color:#2B2B2B;margin-top:12px;">Устная часть целиком</div>'
    +'<div style="font-weight:600;font-size:13.5px;color:#4A453E;line-height:1.6;margin-top:8px;">Чтение → 4 прямых вопроса → 5 ответов интервью → монолог. Сервер закрепляет один вариант и ведёт по официальным таймерам. Аудио остаётся только на этом устройстве.</div>'
    +'<div style="margin-top:12px;font-weight:700;font-size:12.5px;color:#777163;">Максимум: 20 баллов · после сдачи доступна примерная автоматическая оценка</div>'
    +'</div>'
    +'<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'
    +spBtn(S.speakingFullSessionId?'Продолжить экзамен':'Начать экзамен','speStart()',true)
    +spBtn('← К заданиям','initSpeaking()')+'</div>';
  spAnim('win','.32s')}
async function speStart(){return speFullStart()}
async function speFullStart(){var area=document.getElementById('s9_area');if(!area)return false;speFullDispose();
  area.innerHTML='<div class="clayCard" role="status" aria-live="polite" style="padding:20px;text-align:center;font-weight:700;color:#777163;">Сервер закрепляет полный вариант…</div>';
  SPE_FLOW=createSpeakingFullBrowserFlow({api:{post:function(path,body){return apiPost(path,body)},get:function(path){return apiGet(path)}},prepareAssessmentRecording:spePrepareAssessmentRecording});
  try{var session=null;
    if(S.speakingFullSessionId){try{session=await SPE_FLOW.restoreSession(S.speakingFullSessionId)}catch(error){
      if(!speFullPointerInvalid(error))throw error;delete S.speakingFullSessionId;save()}}
    if(!session||session.status==='submitted')session=await SPE_FLOW.loadAssignment();
    S.speakingFullSessionId=session.id;save();SPE=SPE_FLOW.state();
    if(session.task&&session.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    SPE=SPE_FLOW.state();speRender();return true
  }catch(error){speFullDispose();try{toast(apiMessage(error,'request'))}catch(_){}spExam();return false}}
async function speFullMicCheck(btn){if(!SPE_FLOW)return false;if(btn)btn.disabled=true;try{await SPE_FLOW.checkMicrophone();SPE=SPE_FLOW.state();speRender();return true}
  catch(error){if(btn)btn.disabled=false;try{toast(apiMessage(error,'request'))}catch(_){}SPE=SPE_FLOW.state();speRender();return false}}
async function speFullBeginStage(){if(!SPE_FLOW)return false;var current=SPE_FLOW.state().session;
  if(current.task.taskType===3&&current.phase==='ready')return speFullStartRecording();
  try{await SPE_FLOW.beginStage();SPE=SPE_FLOW.state();
    if(SPE.session.phase==='recording')return speFullStartRecording();speRender();return true}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullStartRecording(){if(!SPE_FLOW||SPE_STARTING)return false;SPE_STARTING=true;try{
    var promptSequence=++SPE_PROMPT_SEQUENCE,before=SPE_FLOW.state(),beforeSession=before.session;
    var beforePosition=beforeSession.current?{taskType:beforeSession.current.taskType,responseNumber:beforeSession.current.responseNumber,phase:beforeSession.phase}:null;
    if(beforeSession.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    if(beforeSession.task.taskType===3&&beforeSession.phase!=='recording'){
      var question=beforeSession.task.questions[beforeSession.current.responseNumber-1];
      try{await Promise.resolve(lPlayRaw([{s:1,t:question}]))}catch(_){}
      if(!SPE_FLOW||promptSequence!==SPE_PROMPT_SEQUENCE)return false;var afterPrompt=SPE_FLOW.state().session;
      if(afterPrompt.id!==beforeSession.id||afterPrompt.phase!==beforePosition.phase
        ||afterPrompt.current.taskType!==beforePosition.taskType
        ||afterPrompt.current.responseNumber!==beforePosition.responseNumber)return false}
    await SPE_FLOW.startRecording();SPE=SPE_FLOW.state();
    speRender();return true
  }catch(error){SPE=SPE_FLOW?SPE_FLOW.state():null;try{toast(apiMessage(error,'request'))}catch(_){}if(SPE)speRender();return false}
  finally{SPE_STARTING=false}}
async function speFullStopRecording(){if(!SPE_FLOW)return false;try{await SPE_FLOW.stopRecording();SPE=SPE_FLOW.state();speRender();return true}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullComplete(status,issue){if(!SPE_FLOW)return false;try{
    SPE_PROMPT_SEQUENCE++;try{lStop()}catch(_){}
    while(['ready','preparing'].includes(SPE_FLOW.state().session.phase))await SPE_FLOW.beginStage();
    await SPE_FLOW.completeResponse(status,issue||null);SPE=SPE_FLOW.state();
    if(SPE.session.task&&SPE.session.task.taskType===4)await SPE_FLOW.prepareCurrentAssets();
    SPE=SPE_FLOW.state();speRender();return true
  }catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullTimeout(){if(!SPE_FLOW||!SPE)return;var state=SPE_FLOW.state();
  if(state.session.phase==='preparing'){await speFullStartRecording();return}
  if(state.session.phase==='recording'){
    if(state.isRecording)await SPE_FLOW.stopRecording();
    state=SPE_FLOW.state();await speFullComplete(state.recording?'completed':'technical_issue',state.recording?null:'recording_failed')}}
function speFullArmTimer(){clearInterval(SPE_TM);SPE_TM=null;if(!SPE||!SPE.session.current||!SPE.session.current.stageDeadlineAt)return;
  var update=function(){if(!SPE_FLOW)return;var current=SPE_FLOW.state().session.current;if(!current||!current.stageDeadlineAt)return;
    var left=Math.max(0,Math.ceil((new Date(current.stageDeadlineAt).getTime()-Date.now())/1000));setTxt('s9_timer',spFmt(left));
    setTxt('s9_today','задание '+current.taskType+' · ответ '+current.responseNumber+' · '+spFmt(left));
    if(left<=0){clearInterval(SPE_TM);SPE_TM=null;void speFullTimeout()}};
  update();if(SPE_TM===null)SPE_TM=setInterval(update,1000)}
function speTaskBody(){var task=SPE.session.task,pos=SPE.session.current,safe=ui.escapeHtml;if(!task||!pos)return '';
  if(task.taskType===1)return '<div style="font-weight:500;font-size:13.5px;line-height:1.7;color:#2B2B2B;margin-top:10px;">'+safe(task.text)+'</div>';
  if(task.taskType===2){var preparing=SPE.session.phase==='preparing';var supportBody=preparing
    ?task.supports.map(function(support,index){return '<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+(index+1)+'. '+safe(support)+'</div>'}).join('')
    :'<div style="margin-top:5px;font-weight:700;font-size:13px;color:#C2421B;">'+safe(task.supports[pos.responseNumber-1])+'</div>';
    return '<div style="margin-top:10px;background:#FAF6F1;border-radius:14px;padding:11px 13px;font-weight:600;font-size:13px;color:#4A453E;line-height:1.6;font-style:italic;">'+safe(task.advertisement)+'</div>'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">'+(preparing?'Подготовь четыре прямых вопроса:':'Задай прямой вопрос о пункте '+pos.responseNumber+':')+'</div>'+supportBody}
  if(task.taskType===3){if(SPE.session.phase==='ready')return '<div role="status" style="margin-top:10px;padding:12px;border-radius:14px;background:#E3F1F5;color:#317485;font-weight:700;font-size:13px;line-height:1.5;">Вопрос прозвучит после запуска. Отдельного времени на подготовку нет; затем начнутся запись и 40 секунд ответа.</div>';
    var question=task.questions[pos.responseNumber-1];return '<div style="font-weight:600;font-size:12px;color:#777163;margin-top:10px;">Вопрос '+pos.responseNumber+' из 5</div>'
    +'<div style="font-family:Nunito,Manrope,sans-serif;font-weight:800;font-size:17px;color:#2B2B2B;line-height:1.5;margin-top:6px;">'+safe(question)+'</div>'
    }
  return '<div style="margin-top:10px;font-weight:700;font-size:13.5px;color:#2B2B2B;">Проект: '+safe(task.projectTitle)+'</div>'
    +'<img src="'+safe(task.photoPair.src)+'" alt="'+safe(task.photoPair.alt)+'" style="display:block;width:100%;height:auto;margin-top:10px;border-radius:16px;">'
    +'<div style="margin-top:9px;font-weight:600;font-size:12.5px;color:#2B2B2B;">План:</div>'
    +task.plan.map(function(point,index){return '<div style="margin-top:4px;font-weight:600;font-size:12.5px;color:#4A453E;">'+(index+1)+'. '+safe(point)+'</div>'}).join('')}
function speFullProgress(){return SPE.session.progress.map(function(item){return '<span style="font-weight:800;font-size:11px;color:'+(item.completedResponses===item.responseCount?'#1D7F4A':'#777163')+';background:'+(item.completedResponses===item.responseCount?'#EAF7F0':'#F4EFE9')+';padding:6px 9px;border-radius:12px;">'+item.taskType+': '+item.completedResponses+'/'+item.responseCount+'</span>'}).join('')}
function speFullControls(){var state=SPE,session=state.session,phase=session.phase;
  if(phase==='ready_to_submit')return spBtn('Сдать устную часть','speFullSubmit()',true);
  var mic='<button type="button" class="sq" onclick="speFullMicCheck(this)" style="'+WBTN+'min-height:44px;color:#317485;">'+(state.micCheck==='passed'?'✓ Микрофон готов':'Проверить микрофон')+'</button>';
  var skip='<div style="height:10px;"></div>'+spBtn('Пропустить ответ','speFullComplete(\'skipped\')');
  if(phase==='ready')return mic+'<div style="height:10px;"></div>'+spBtn(session.task.preparationSeconds&&session.current.responseNumber===1?'Начать подготовку':'Начать запись','speFullBeginStage()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Не могу записать','speFullComplete(\'technical_issue\',\'recording_failed\')');
  if(phase==='preparing')return mic+'<div style="height:10px;"></div>'+spBtn('Готово — к записи','speFullStartRecording()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\')');
  if(state.recording)return '<div role="status" style="font-weight:800;font-size:13px;color:#1D7F4A;margin-bottom:10px;">Ответ записан локально · '+state.recording.durationSeconds+' сек.</div>'
    +spBtn('Сохранить ответ','speFullComplete(\'completed\')',true)+'<div style="height:10px;"></div>'+spBtn('Перезаписать','speFullStartRecording()')+skip;
  if(state.isRecording)return spBtn('Стоп — закончить запись','speFullStopRecording()',true);
  return (state.recordingLostOnRestore?'<div role="alert" style="font-weight:700;font-size:12.5px;color:#A83226;margin-bottom:10px;">После перезагрузки локальная запись недоступна. Начни её заново или отметь проблему.</div>':'')
    +mic+'<div style="height:10px;"></div>'+spBtn('Начать запись','speFullStartRecording()',true)
    +skip+'<div style="height:10px;"></div>'+spBtn('Техническая проблема','speFullComplete(\'technical_issue\',\'recording_failed\')')}
function speRender(){var area=document.getElementById('s9_area');if(!area||!SPE)return;var session=SPE.session;
  if(session.status==='submitted'){speFullFinal(session.submission);return}
  var current=session.current,phase=session.phase,chip=phase==='preparing'?'ПОДГОТОВКА':phase==='recording'?'● ЗАПИСЬ':'ГОТОВО';
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:18px;margin-bottom:12px;">'+wDeco()
    +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#B54E2F;background:#FFEDE4;padding:5px 10px;border-radius:20px;">ЭКЗАМЕН · '+(current?current.taskType:4)+' ИЗ 4</span>'
    +'<span style="font-weight:700;font-size:10px;letter-spacing:1.2px;color:#A56000;background:#FFF4DE;padding:5px 10px;border-radius:20px;">'+chip+'</span></div>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">'+speFullProgress()+'</div>'+speTaskBody()
    +(current&&current.stageDeadlineAt?'<div id="s9_timer" aria-live="polite" style="text-align:center;font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:34px;color:#2B2B2B;margin-top:12px;">—</div>':'')
    +'</div><div style="display:flex;flex-direction:column;gap:0;">'+speFullControls()+'</div>';
  setTxt('s9_today',current?'задание '+current.taskType+' · ответ '+current.responseNumber:'готово к сдаче');speFullArmTimer()}
async function speFullSubmit(){if(!SPE_FLOW)return false;try{var idempotencyKey=globalThis.crypto.randomUUID();
    var result=await SPE_FLOW.submit(idempotencyKey);SPE_FULL_RESULT=result;delete S.speakingFullSessionId;save();speFullFinal(result);return true
  }catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
async function speFullPlay(taskType,responseNumber){if(!SPE_FLOW)return false;try{return await SPE_FLOW.playRecording(taskType,responseNumber)}
  catch(error){try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function speFullExpectedAssessmentSeconds(result,recordings){var completed=new Set((result.taskResults||[]).filter(function(item){return item.recordingStatus==='completed'}).map(function(item){return item.taskType}));return recordings.filter(function(item){return completed.has(item.taskType)}).reduce(function(total,item){return total+Math.ceil(item.durationSeconds)},0)}
async function spePrepareAssessmentRecording(recording){if(!globalThis.crypto||!globalThis.crypto.subtle)throw new Error('безопасная привязка записи недоступна — обнови браузер');var wav=await convertRecordingToPcm16Wav(recording.blob);var bytes=await wav.blob.arrayBuffer();var digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);var sha256=Array.from(new Uint8Array(digest)).map(function(value){return value.toString(16).padStart(2,'0')}).join('');return {blob:wav.blob,durationSeconds:wav.durationSeconds,sha256:sha256}}
async function speFullLoadAssessmentStatus(result){var box=document.getElementById('spe_full_assessment_status');if(!box||!SPE_FLOW||result.assessment&&result.assessment.available)return;var recordings=SPE_FLOW.assessmentRecordings();var expected=speFullExpectedAssessmentSeconds(result,recordings);
  try{var payload=await apiGet('/api/v1/speaking/pronunciation-assessments/status');if(!document.getElementById('spe_full_assessment_status'))return;var quota=payload&&payload.quota||{};var provider=payload&&payload.provider||{};
    if(provider.available){box.innerHTML='<b>До отправки:</b> ожидаемое списание до '+spFmt(expected)+' · осталось '+spFmt(Number(quota.remainingSeconds||0))+'. Локальное прослушивание лимит не расходует. Записи обработает внешний сервис Azure Speech; обычный исходный звук не сохраняется.';box.style.background='#EAF7F0';box.style.color='#1D6944'}
    else{box.innerHTML='<b>Автоматическая оценка сейчас недоступна.</b> Записи остаются локально до ухода с экрана.'}}
  catch(_){if(box)box.innerHTML='<b>Не удалось проверить лимит.</b> Повтори перед отправкой записей.'}}
async function spUploadFullPronunciation(sessionId,recording,cacheItem,locale){var headers={
    'Idempotency-Key':cacheItem.key,'X-Speech-Locale':locale,'X-Audio-Duration-Seconds':String(recording.durationSeconds),
    'X-Speaking-Task':String(recording.taskType)};
  if(recording.taskType===2||recording.taskType===3)headers['X-Speaking-Item']=String(recording.responseNumber);
  var result=await apiPostBinary('/api/v1/speaking/full-sessions/'+sessionId+'/pronunciation-assessment',recording.blob,'audio/wav',headers);
  if(!result||!result.billing||!result.billing.assessmentId||result.assessment&&result.assessment.status!=='success'){var unavailable=new Error('автоматическая оценка записи сейчас недоступна — попробуй позже');unavailable.code='SPEAKING_PRONUNCIATION_UNAVAILABLE';throw unavailable}
  return {key:cacheItem.key}}
async function speFullEvaluate(btn){if(!SPE_FLOW||!SPE_FULL_RESULT)return false;if(btn){if(btn.dataset.busy)return false;btn.dataset.busy=1;btn.disabled=true;btn.textContent='Проверяю лимит и записи…'}
  try{var flowState=SPE_FLOW.state(),session=flowState.session,result=SPE_FULL_RESULT,recordings=SPE_FLOW.assessmentRecordings();var completedTasks=(result.taskResults||[]).filter(function(item){return item.recordingStatus==='completed'}).map(function(item){return item.taskType});var counts={1:1,2:4,3:5,4:1};
    if(completedTasks.some(function(taskType){return recordings.filter(function(item){return item.taskType===taskType&&item.sha256}).length!==counts[taskType]}))throw new Error('часть локальных записей не удалось безопасно привязать при сдаче — общий балл нельзя рассчитать надёжно');
    var locale=session.accentProfile&&session.accentProfile.locale||(SP_ACCENT&&SP_ACCENT.locale)||'en-GB';
    if(!SPE_FULL_UPLOAD_CACHE||SPE_FULL_UPLOAD_CACHE.sessionId!==session.id)SPE_FULL_UPLOAD_CACHE={sessionId:session.id,items:{}};
    var attemptIds=[];
    for(var taskIndex=0;taskIndex<completedTasks.length;taskIndex++){var taskType=completedTasks[taskIndex];var taskRecordings=recordings.filter(function(item){return item.taskType===taskType}).sort(function(a,b){return a.responseNumber-b.responseNumber});var keys=[];
      for(var recordingIndex=0;recordingIndex<taskRecordings.length;recordingIndex++){var recording=taskRecordings[recordingIndex];var cacheKey=taskType+':'+recording.responseNumber;var cacheItem=SPE_FULL_UPLOAD_CACHE.items[cacheKey];if(!cacheItem){cacheItem={key:window.crypto.randomUUID(),result:null};SPE_FULL_UPLOAD_CACHE.items[cacheKey]=cacheItem}
        if(btn)btn.textContent='Проверяю задание '+taskType+' · запись '+(recordingIndex+1)+' из '+taskRecordings.length+'…';if(!cacheItem.result)cacheItem.result=await spUploadFullPronunciation(session.id,recording,cacheItem,locale);keys.push(cacheItem.result.key)}
      var request={taskType:taskType,sessionMode:'full_section',sessionId:session.id};if(taskType===2||taskType===3)request.pronunciationAssessmentKeys=keys;else request.pronunciationAssessmentKey=keys[0];
      if(btn)btn.textContent='Рассчитываю примерный результат задания '+taskType+'…';var evaluated=await apiPost('/api/v1/ai/evaluate-speaking',request,true);if(!evaluated||!Number.isSafeInteger(Number(evaluated.attemptId)))throw new Error('сервер не вернул сохранённую попытку');attemptIds.push(Number(evaluated.attemptId))}
    if(btn)btn.textContent='Собираю общий результат…';var fullResult=await apiPost('/api/v1/speaking/full-sessions/'+session.id+'/evaluation',{attemptIds:attemptIds});SPE_FULL_RESULT=fullResult;speFullFinal(fullResult);return true
  }catch(error){if(btn){btn.disabled=false;btn.textContent='Получить примерную автоматическую оценку';delete btn.dataset.busy}try{toast(apiMessage(error,'request'))}catch(_){}return false}}
function speFullFinal(result){var area=document.getElementById('s9_area');if(!area||!result)return;clearInterval(SPE_TM);SPE_TM=null;SPE_FULL_RESULT=result;
  var recordings=SPE_FLOW?SPE_FLOW.state().localRecordings:[];
  var plan=result.improvementPlan||{available:false,message:'План улучшения пока недоступен.'};
  var rows=result.taskResults.map(function(item){var local=recordings.filter(function(recording){return recording.taskType===item.taskType});return '<div style="padding:10px 2px;border-bottom:1px solid #F4EFE9;">'
    +'<div style="display:flex;justify-content:space-between;gap:10px;font-weight:700;font-size:13px;color:#2B2B2B;"><span>'+SP_CONF[item.taskType].name+'</span><span>'+(item.earnedScore==null?'—':item.earnedScore)+' / '+item.maximumScore+' · '+item.recordingStatus+' · '+Math.round(item.usedSeconds)+' сек.</span></div>'
    +(item.recordingQuality?'<div style="margin-top:4px;font-size:11.5px;color:#777163;">Качество записи: '+ui.escapeHtml(item.recordingQuality)+'</div>':'')
    +local.map(function(recording){return '<button type="button" class="sq" onclick="speFullPlay('+recording.taskType+','+recording.responseNumber+')" style="min-width:44px;min-height:44px;margin-top:7px;border:0;border-radius:12px;background:#E3F1F5;color:#317485;font-weight:800;">▶ Ответ '+recording.responseNumber+'</button>'}).join('')+'</div>'}).join('');
  var assessed=result.assessment&&result.assessment.status;var score=Number.isInteger(result.earnedScore)?'<div style="font-weight:900;font-size:19px;color:#1D7F4A;margin-top:7px;">Примерный результат: '+result.earnedScore+' из 20</div>':'<div style="font-weight:800;font-size:13px;color:#A56000;margin-top:7px;">Примерная автоматическая оценка запускается отдельно</div>';
  var planMarkup=plan.available?'<div role="status" style="margin-top:12px;padding:11px 13px;border-radius:14px;background:#EAF7F0;color:#1D6944;font-weight:700;font-size:12.5px;"><b>Общий план:</b><ul style="margin:6px 0 0;padding-left:18px;">'+(plan.items||[]).map(function(item){return '<li>'+ui.escapeHtml(item)+'</li>'}).join('')+'</ul></div>':'<div role="status" style="margin-top:12px;padding:11px 13px;border-radius:14px;background:#FFF4DE;color:#8A641A;font-weight:700;font-size:12.5px;">'+ui.escapeHtml(plan.message||'План появится после примерной оценки.')+'</div>';
  var assessmentAction=assessed?'':'<div id="spe_full_assessment_status" role="status" aria-live="polite" style="margin-top:12px;padding:11px 13px;border-radius:14px;background:#FFF4DE;color:#714515;font-weight:650;font-size:12px;line-height:1.5;"><b>Перед отправкой:</b> проверяем ожидаемое списание и остаток лимита. Записи обработает внешний сервис Azure Speech; обычный исходный звук не сохраняется.</div><div style="height:10px;"></div>'+spBtn('Получить примерную автоматическую оценку','speFullEvaluate(this)',true);
  area.innerHTML='<div id="s9_card" class="clayCard" style="position:relative;overflow:hidden;padding:22px;">'+wDeco()
    +'<div style="text-align:center;"><div style="font-size:42px;">✓</div><div style="font-family:Nunito,Manrope,sans-serif;font-weight:900;font-size:21px;color:#2B2B2B;margin-top:8px;">Устная часть сдана</div>'
    +score+'<div style="font-weight:600;font-size:12px;color:#777163;line-height:1.5;margin-top:5px;">'+(assessed?ui.escapeHtml(result.assessment.warning||'Результат тренировочный и примерный.'):'Локальное прослушивание доступно только до ухода с этой страницы.')+'</div></div>'
    +'<div style="margin-top:12px;">'+rows+'</div>'+planMarkup+'</div><div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">'+assessmentAction
    +spBtn('Новый вариант','speStart()',true)+spBtn('К заданиям','initSpeaking()')+'</div>';setTxt('s9_today',Number.isInteger(result.earnedScore)?('примерно '+result.earnedScore+' из 20'):'сдано · максимум 20');spAnim('win','.32s');if(!assessed)void speFullLoadAssessmentStatus(result)}
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
    if(SP){spStopAll();SP=null}spDisposeTask1Flow();spDisposeTask2Flow();spDisposeTask3Flow();spDisposeTask4Flow();
    speFullDispose()}});
registerRouteHook(function(id){if(id==='scr9')initSpeaking()});

/* Имена для обработчиков этого экрана: загрузчик кладёт их на window вместе с чанком. */
export {
  SP,SPE,
  initSpeaking,spAccentFinishUnknown,spAccentSetup,spAccentStartUnknown,spCalibrationConsentSetup,spChooseAccent,spCompleteTask1,spCompleteTask2Question,spCompleteTask3Answer,spCompleteTask4,spContributeCalibration,spDeleteRecording,spEtalon,spEval,spExam,spFinish,spFlagTranscript,spMicCheck,spNextQ,spSaveCalibrationConsent,
  launchSpeakingTask,spHub,spNextSet,spOpen,spPlay,spPlayTask2Question,spPlayTask3Answer,spPrep,spRec,spRestartAdaptive,spSample,spStartTargetedPractice,spStopAll,spToggleSheet,spVoiceSample,
  speFullBeginStage,speFullComplete,speFullEvaluate,speFullMicCheck,speFullPlay,speFullStartRecording,speFullStopRecording,speFullSubmit,speStart,
};
