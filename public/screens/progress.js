/*
 * Экран «Прогресс» (scr10). Раздел 6.1 ТЗ обещает просмотр сохранённого прогресса без сети,
 * поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 * Числа он берёт из того же состояния, что и плитки главного экрана, — считать заново нечего.
 */
import {registerRouteHook} from '../router.js';
import {S,apiGet,apiMessage,apiPost,apiPostIdempotent,apiPut,progressModule,setTxt,setW} from '../app.js';

const BAR_IDS={words:'pb_words',gram:'pb_gram',read:'pb_read',listen:'pb_listen',speak:'pb_speak'};
function renderProgress(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('p_streak',progressModule.streakLabel(view.streak));setTxt('p_words',view.learned);
  Object.keys(BAR_IDS).forEach(function(name){setW(BAR_IDS[name],view.modules[name])});renderAdaptivePlan();renderRecoveryMap()}

function text(tag,value,style){const node=document.createElement(tag);node.textContent=value;if(style)node.setAttribute('style',style);return node}
function recoveryStateLabel(state){return state==='recovered'?'Восстановлено':state==='relapsed'?'Ошибка проявилась снова':'В работе'}
function repeatAttemptId(){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'?globalThis.crypto.randomUUID():('00000000-0000-4000-8000-'+Date.now().toString(16).padStart(12,'0').slice(-12))}
function goalIdempotencyKey(){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'?globalThis.crypto.randomUUID():('adaptive-goal-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2))}
function diagnosticIdempotencyKey(kind){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'?globalThis.crypto.randomUUID():('adaptive-'+kind+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2))}

const adaptiveModuleLabels={vocabulary:'Лексика',grammar:'Грамматика',reading:'Чтение',listening:'Аудирование',writing:'Письмо',speaking:'Говорение'};
const adaptiveReasonLabels={high_uncertainty:'нужно уточнить уровень',due_review:'пора проверить сохранение навыка',critical_retention_expiry:'срочное повторение скоро потеряет актуальность',target_gap:'есть разрыв до цели',high_ege_impact:'сильно влияет на ЕГЭ',deadline_pressure:'экзамен уже близко',maintenance:'поддерживаем навык'};
function drawAdaptiveForecast(plan){
  const section=document.getElementById('adaptive_forecast');const range=document.getElementById('adaptive_forecast_range');const confidence=document.getElementById('adaptive_forecast_confidence');const allocation=document.getElementById('adaptive_weekly_allocation');const choices=document.getElementById('adaptive_plan_choices');if(!section||!range||!confidence||!allocation||!choices)return;
  if(!plan||!plan.forecast||!plan.allocation){section.hidden=true;allocation.replaceChildren();choices.replaceChildren();return}
  section.hidden=false;const forecast=plan.forecast;
  if(forecast.status==='exam_date_expired'){range.textContent='Дата экзамена уже наступила. Обновите дату цели, чтобы построить новый прогноз.';confidence.textContent='Прогноз баллов и недельное распределение не рассчитываются для прошедшей даты.';allocation.replaceChildren();choices.replaceChildren();choices.appendChild(text('div','Обновить дату экзамена в цели','border-left:3px solid #F2683F;padding-left:8px;font-weight:700;font-size:10.5px;line-height:1.4;color:#3E4248;'));return}
  range.textContent='Ориентир: '+plan.forecast.lowScore+'–'+plan.forecast.highScore+' баллов. Для цели нужно около '+forecast.requiredWeeklyMinutes+' минут в неделю.';
  confidence.textContent='Уверенность прогноза '+forecast.confidence+'%. Это диапазон, а не обещание результата; расчёт уточняется по новым самостоятельным ответам.';
  allocation.replaceChildren();(plan.allocation.modules||[]).slice().sort(function(first,second){return second.percentage-first.percentage}).forEach(function(module){const reasons=Array.isArray(module.reasonCodes)?module.reasonCodes.map(function(code){return adaptiveReasonLabels[code]||code}).slice(0,2):[];const row=document.createElement('div');row.setAttribute('style','display:flex;justify-content:space-between;gap:10px;border-top:1px solid #E9E5DE;padding-top:6px;');row.appendChild(text('span',(adaptiveModuleLabels[module.id]||module.id)+(reasons.length?' — '+reasons.join(', '):''),'font-weight:650;font-size:10.5px;line-height:1.35;color:#52565E;'));row.appendChild(text('strong',module.percentage+'%','flex:none;font-weight:800;font-size:11px;color:#B54E2F;'));allocation.appendChild(row)});
  choices.replaceChildren();(forecast.choices||[]).forEach(function(choice){let label='';if(choice.type==='increase_weekly_time')label=choice.constraintCode==='maximum_supported_weekly_time'?'Максимум поддерживаемого времени — '+choice.weeklyMinutes+' минут в неделю, но этого всё ещё меньше расчётной потребности. Цель нужно скорректировать.':'Увеличить время до '+choice.weeklyMinutes+' минут в неделю';else if(choice.type==='adjust_target_score')label='Скорректировать цель до '+choice.targetScore+' баллов';else if(choice.type==='update_exam_date')label='Обновить дату экзамена в цели';if(label)choices.appendChild(text('div',label,'border-left:3px solid #F2683F;padding-left:8px;font-weight:700;font-size:10.5px;line-height:1.4;color:#3E4248;'))});
}

function drawAdaptivePlan(payload){
  const root=document.getElementById('adaptive_plan');const summary=document.getElementById('adaptive_plan_summary');if(!root||!summary)return;
  const goal=payload&&payload.goal;const profile=payload&&payload.profile?payload.profile:{};
  if(goal){document.getElementById('adaptive_target_score').value=goal.targetScore;document.getElementById('adaptive_exam_date').value=goal.examDate;document.getElementById('adaptive_weekly_minutes').value=goal.weeklyMinutes}
  const observed=Math.max(0,Number(profile.evidenceCount)||0);const confidence=Math.max(0,Number(profile.confidence)||0);
  const establishedSkillCount=Math.max(0,Math.min(12,Number(profile.establishedSkillCount)||0));
  const modules=Array.isArray(profile.modules)?profile.modules.filter(function(module){return module.evidenceCount>0}).sort(function(first,second){return first.mastery-second.mastery}):[];
  const weakest=modules[0];const state=establishedSkillCount===12&&!profile.preliminary?'Профиль подтверждён':'Профиль предварительный';
  const diagnostic=profile.needsDiagnostic?' Нужна короткая диагностика для уточнения.':'';
  const assisted=Number(profile.assistedEvidenceCount)>0&&establishedSkillCount<12?' Результаты с подсказкой не подтверждают владение навыком.':'';
  summary.textContent=state+' · подтверждено навыков: '+establishedSkillCount+' из 12 · уверенность '+confidence+'% · данных: '+observed+'.'+(weakest?' Сейчас важнее всего: '+weakest.id+' ('+weakest.mastery+'%).':'')+assisted+diagnostic;
  drawAdaptiveForecast(payload&&payload.plan);
  const start=document.getElementById('adaptive_diagnostic_start');if(start)start.hidden=!profile.needsDiagnostic;
}

function drawAdaptiveDiagnostic(payload){
  const section=document.getElementById('adaptive_diagnostic');const start=document.getElementById('adaptive_diagnostic_start');const form=document.getElementById('adaptive_diagnostic_form');const fieldset=document.getElementById('adaptive_diagnostic_question');const prompt=document.getElementById('adaptive_diagnostic_prompt');const choices=document.getElementById('adaptive_diagnostic_choices');const audio=document.getElementById('adaptive_diagnostic_audio');const complete=document.getElementById('adaptive_diagnostic_complete');const notice=document.getElementById('adaptive_diagnostic_notice');const progress=document.getElementById('adaptive_diagnostic_progress');const label=document.getElementById('adaptive_diagnostic_progress_label');const timing=document.getElementById('adaptive_diagnostic_timing');
  if(!section||!start||!form||!fieldset||!prompt||!choices||!audio||!complete||!notice||!progress||!label||!timing)return;
  const diagnostic=payload&&payload.diagnostic;const item=payload&&payload.item;
  if(!diagnostic){section.hidden=true;return}
  section.hidden=false;section.dataset.diagnosticId=diagnostic.id;section.dataset.itemId=item&&item.id||'';
  const maxItems=Math.max(1,Number(diagnostic.maxItems)||1);const estimatedMinutes=Math.max(1,Number(diagnostic.estimatedMinutes)||1);const deadlineMinutes=Math.max(1,Number(diagnostic.deadlineMinutes)||1);
  progress.max=maxItems;progress.value=Math.max(0,Math.min(maxItems,Number(diagnostic.answeredItems)||0));label.textContent=progress.value+' из '+maxItems;
  timing.textContent='Около '+estimatedMinutes+' минут · ответы сохраняются. Вернуться нужно в течение '+deadlineMinutes+' минут после старта.';
  const expired=diagnostic.status==='expired';start.hidden=!expired;start.textContent=expired?'Начать диагностику заново · около '+estimatedMinutes+' минут':'Начать диагностику · около '+estimatedMinutes+' минут';
  complete.hidden=!diagnostic.canComplete;form.hidden=!item||diagnostic.status!=='in_progress';fieldset.disabled=form.hidden;
  if(expired){notice.textContent='Время этой попытки истекло. Начните новую — незавершённые ответы не считаются результатом.';choices.replaceChildren();audio.hidden=true;return}
  if(diagnostic.status==='completed'){notice.textContent='Диагностика завершена. Профиль пока предварительный и будет уточняться по занятиям.';choices.replaceChildren();audio.hidden=true;return}
  if(diagnostic.canComplete){notice.textContent='Данных достаточно для предварительного результата.';choices.replaceChildren();audio.hidden=true;return}
  if(!item){notice.textContent='Загружаем следующий вопрос…';return}
  prompt.textContent=item.prompt;choices.replaceChildren();
  item.choices.forEach(function(choice,index){const option=document.createElement('label');option.setAttribute('style','display:flex;align-items:flex-start;gap:8px;border:1px solid #E5E1DA;border-radius:11px;padding:9px 10px;font-weight:650;font-size:11px;line-height:1.4;color:#3E4248;cursor:pointer;');const input=document.createElement('input');input.type='radio';input.name='adaptive_diagnostic_choice';input.value=choice.id;input.required=true;if(index===0)input.setAttribute('aria-describedby','adaptive_diagnostic_prompt');option.appendChild(input);option.appendChild(document.createTextNode(choice.label));choices.appendChild(option)});
  audio.hidden=item.presentation!=='audio'||!item.speechText;audio.dataset.speechText=item.speechText||'';notice.textContent=(item.measurementNotice?item.measurementNotice+' ':'')+'Выберите один ответ. Подсказок и повторной попытки в диагностике нет.';
}

function bindAdaptiveDiagnostic(){
  const section=document.getElementById('adaptive_diagnostic');const start=document.getElementById('adaptive_diagnostic_start');const form=document.getElementById('adaptive_diagnostic_form');const complete=document.getElementById('adaptive_diagnostic_complete');const audio=document.getElementById('adaptive_diagnostic_audio');const notice=document.getElementById('adaptive_diagnostic_notice');if(!section||!start||!form||!complete||!audio||!notice||section.dataset.bound)return;
  section.dataset.bound='true';
  start.addEventListener('click',async function(){start.disabled=true;notice.textContent='Начинаем диагностику…';const key=start.dataset.pendingKey||diagnosticIdempotencyKey('start');start.dataset.pendingKey=key;try{const result=await apiPostIdempotent('/api/v1/adaptive-learning/diagnostics/start',{},key);delete start.dataset.pendingKey;drawAdaptiveDiagnostic(result)}catch(error){notice.textContent=apiMessage(error,'request')}finally{start.disabled=false}});
  form.addEventListener('change',function(){delete form.dataset.pendingKey});
  form.addEventListener('submit',async function(event){event.preventDefault();const selected=form.querySelector('input[name="adaptive_diagnostic_choice"]:checked');if(!selected){notice.textContent='Выберите один ответ.';return}const button=form.querySelector('button[type="submit"]');button.disabled=true;notice.textContent='Сохраняем ответ…';const key=form.dataset.pendingKey||diagnosticIdempotencyKey('answer');form.dataset.pendingKey=key;try{const result=await apiPostIdempotent('/api/v1/adaptive-learning/diagnostics/'+encodeURIComponent(section.dataset.diagnosticId)+'/answers',{itemId:section.dataset.itemId,choiceId:selected.value},key);delete form.dataset.pendingKey;drawAdaptiveDiagnostic(result)}catch(error){notice.textContent=apiMessage(error,'request')}finally{button.disabled=false}});
  complete.addEventListener('click',async function(){complete.disabled=true;notice.textContent='Собираем предварительный профиль…';const key=complete.dataset.pendingKey||diagnosticIdempotencyKey('complete');complete.dataset.pendingKey=key;try{const result=await apiPostIdempotent('/api/v1/adaptive-learning/diagnostics/'+encodeURIComponent(section.dataset.diagnosticId)+'/complete',{},key);delete complete.dataset.pendingKey;await renderAdaptivePlan();drawAdaptiveDiagnostic(result)}catch(error){notice.textContent=apiMessage(error,'request')}finally{complete.disabled=false}});
  audio.addEventListener('click',function(){if(!audio.dataset.speechText||!window.speechSynthesis||!window.SpeechSynthesisUtterance){notice.textContent='Озвучка недоступна в этом браузере.';return}window.speechSynthesis.cancel();const utterance=new window.SpeechSynthesisUtterance(audio.dataset.speechText);utterance.lang='en-US';window.speechSynthesis.speak(utterance)});
}

async function resumeAdaptiveDiagnostic(){try{drawAdaptiveDiagnostic(await apiGet('/api/v1/adaptive-learning/diagnostics/current'))}catch(error){const notice=document.getElementById('adaptive_diagnostic_notice');if(notice)notice.textContent='Не удалось восстановить диагностику. Проверьте сеть и повторите попытку.'}}

async function renderAdaptivePlan(){
  const root=document.getElementById('adaptive_plan');const form=document.getElementById('adaptive_goal_form');const notice=document.getElementById('adaptive_goal_notice');if(!root||!form||!notice)return;
  root.hidden=!(window.__sub?.features?.adaptive_learning===true);if(root.hidden)return;
  bindAdaptiveDiagnostic();
  if(!form.dataset.bound){
    form.dataset.bound='true';form.addEventListener('input',function(){delete form.dataset.pendingKey});
    form.addEventListener('submit',async function(event){event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;notice.textContent='Сохраняем цель…';
      const payload={targetExam:'ege_english',targetScore:Number(document.getElementById('adaptive_target_score').value),examDate:document.getElementById('adaptive_exam_date').value,weeklyMinutes:Number(document.getElementById('adaptive_weekly_minutes').value)};
      const key=form.dataset.pendingKey||goalIdempotencyKey();form.dataset.pendingKey=key;
      try{const saved=await apiPut('/api/v1/adaptive-learning/goal',payload,{'Idempotency-Key':key});delete form.dataset.pendingKey;drawAdaptivePlan(saved);notice.textContent='Цель сохранена.'}
      catch(error){notice.textContent=apiMessage(error,'request')}finally{button.disabled=false}
    });
  }
  try{const payload=await apiGet('/api/v1/adaptive-learning/overview');drawAdaptivePlan(payload);notice.textContent='';if(payload.profile&&payload.profile.needsDiagnostic)await resumeAdaptiveDiagnostic();else drawAdaptiveDiagnostic(null)}catch(error){notice.textContent='План сейчас недоступен онлайн. Сохранённый прогресс остаётся на устройстве.'}
}

async function submitRepeat(repeat,input,button,notice){
  const answer=String(input.value||'').trim();if(!answer){notice.textContent='Введите ответ.';input.focus();return}
  button.disabled=true;notice.textContent='Проверяем новый пример…';
  try{
    const result=await apiPost('/api/v1/voice-tutor/repeats/'+encodeURIComponent(repeat.id)+'/attempts',{attemptId:repeatAttemptId(),taskId:repeat.task_id,answer:answer});
    input.value='';notice.textContent=result.attempt&&result.attempt.passed?'Верно — перенос подтверждён.':'Навык нужно повторить ещё раз.';await renderRecoveryMap();
  }catch(error){notice.textContent=apiMessage(error,'request')}finally{button.disabled=false}
}

function drawRecoveryMap(payload){
  const root=document.getElementById('voice_recovery_map');if(!root)return;
  const view=progressModule.recoveryOverview(payload);root.replaceChildren();
  root.appendChild(text('div','Карта освоенных ошибок','font-weight:800;font-size:15px;color:#2B2B2B;'));
  const counts=text('div','В работе '+view.counts.open+' · восстановлено '+view.counts.recovered+' · снова проявилось '+view.counts.relapsed,'margin-top:8px;font-weight:650;font-size:12px;color:#52565E;');root.appendChild(counts);
  const stats=document.createElement('div');stats.setAttribute('style','display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;');
  [view.rateLabel,view.voiceLabel,view.dueLabel,view.potentialLabel].forEach(function(label){stats.appendChild(text('span',label,'border-radius:999px;background:#F6F2EC;padding:6px 9px;font-weight:700;font-size:10.5px;color:#5B5147;'))});root.appendChild(stats);
  const skills=Array.isArray(payload&&payload.skills)?payload.skills:[];
  if(!skills.length)root.appendChild(text('div','После проверенного разбора здесь появятся навыки и повторы через 1 и 7 дней.','margin-top:12px;font-weight:600;font-size:12px;line-height:1.5;color:#6A6E75;'));
  skills.forEach(function(skill){const row=document.createElement('div');row.setAttribute('style','display:flex;justify-content:space-between;gap:10px;margin-top:11px;padding-top:11px;border-top:1px solid #F0EEE9;');const copy=document.createElement('div');copy.appendChild(text('div',skill.skill_label,'font-weight:750;font-size:12px;color:#2B2B2B;'));copy.appendChild(text('div','Потенциал: '+skill.potential_ege_points+' · '+recoveryStateLabel(skill.state),'font-weight:600;font-size:10.5px;color:#73767A;margin-top:3px;'));row.appendChild(copy);row.appendChild(text('span',recoveryStateLabel(skill.state),'align-self:flex-start;border-radius:999px;background:'+(skill.state==='recovered'?'#E5F4EC':skill.state==='relapsed'?'#FFE8E4':'#FFF4DE')+';padding:5px 8px;font-weight:750;font-size:9.5px;color:#4D4D4D;'));root.appendChild(row)});
  if(skills.length){const micro=text('div','Микропроверка: '+skills.map(function(skill){return skill.skill_label+' — '+(skill.initial_micro_check_passed?'пройдена':'нужна работа')}).join(' · '),'margin-top:11px;font-weight:650;font-size:10.5px;line-height:1.45;color:#52565E;');root.appendChild(micro)}
  if(view.nextBest){const nextLabel=view.nextBest.skill_label||view.nextBest.skill_id;const nextAction=view.nextBest.type==='repeat'?'готовый повтор':'разбор навыка';root.appendChild(text('div','Следующий полезный разбор: '+nextLabel+' · '+nextAction,'margin-top:11px;border-left:3px solid #F2683F;padding-left:9px;font-weight:750;font-size:11px;line-height:1.4;color:#3E4248;'))}
  const repeat=Array.isArray(payload&&payload.due_repeats)?payload.due_repeats.find(function(item){return item.status==='due'||item.status==='overdue'}):null;
  if(repeat){const form=document.createElement('form');form.setAttribute('style','margin-top:13px;padding:12px;border-radius:15px;background:#F8F7F4;');form.appendChild(text('div','Следующий полезный повтор · '+(repeat.stage==='day_1'?'через 1 день':'через 7 дней'),'font-weight:800;font-size:11px;color:#B54E2F;'));form.appendChild(text('div',repeat.prompt,'margin-top:6px;font-weight:650;font-size:12px;line-height:1.45;color:#2B2B2B;'));const input=document.createElement('input');input.type='text';input.maxLength=200;input.autocomplete='off';input.setAttribute('aria-label','Ответ на новый пример');input.setAttribute('style','width:100%;margin-top:9px;border:1px solid #DDD8CF;border-radius:11px;padding:9px 10px;font:600 12px Manrope;background:#fff;');form.appendChild(input);const button=document.createElement('button');button.type='submit';button.textContent='Проверить новый пример';button.setAttribute('style','margin-top:8px;border:0;border-radius:11px;background:#F2683F;color:#fff;padding:9px 11px;font:750 11px Manrope;cursor:pointer;');form.appendChild(button);const notice=text('div','','min-height:16px;margin-top:6px;font-weight:600;font-size:10.5px;color:#6A6E75;');form.appendChild(notice);form.addEventListener('submit',function(event){event.preventDefault();submitRepeat(repeat,input,button,notice)});root.appendChild(form)}
  root.appendChild(text('div',view.notice,'margin-top:10px;font-weight:550;font-size:9.5px;line-height:1.35;color:#6A6E75;'));
}

async function renderRecoveryMap(){const root=document.getElementById('voice_recovery_map');if(!root)return;try{drawRecoveryMap(await apiGet('/api/v1/voice-tutor/recovery-map'))}catch(error){root.replaceChildren(text('div','Карта освоенных ошибок','font-weight:800;font-size:15px;color:#2B2B2B;'),text('div',apiMessage(error,'request'),'margin-top:8px;font-weight:600;font-size:12px;color:#6A6E75;'))}}

registerRouteHook(function(id){if(id==='scr10')renderProgress()});

export {drawAdaptiveDiagnostic,drawAdaptiveForecast,drawAdaptivePlan,drawRecoveryMap,renderAdaptivePlan,renderProgress,renderRecoveryMap};
