/*
 * Экран «Прогресс» (scr10). Раздел 6.1 ТЗ обещает просмотр сохранённого прогресса без сети,
 * поэтому этот экран, в отличие от пяти ленивых, входит в оболочку и грузится сразу.
 * Числа он берёт из того же состояния, что и плитки главного экрана, — считать заново нечего.
 */
import {registerRouteHook} from '../router.js';
import {S,apiGet,apiMessage,apiPost,progressModule,setTxt,setW} from '../app.js';

const BAR_IDS={words:'pb_words',gram:'pb_gram',read:'pb_read',listen:'pb_listen',speak:'pb_speak'};
function renderProgress(){if(!S)return;const view=progressModule.overview(S,Date.now());
  setTxt('p_streak',progressModule.streakLabel(view.streak));setTxt('p_words',view.learned);
  Object.keys(BAR_IDS).forEach(function(name){setW(BAR_IDS[name],view.modules[name])});renderRecoveryMap()}

function text(tag,value,style){const node=document.createElement(tag);node.textContent=value;if(style)node.setAttribute('style',style);return node}
function recoveryStateLabel(state){return state==='recovered'?'Восстановлено':state==='relapsed'?'Ошибка проявилась снова':'В работе'}
function repeatAttemptId(){return globalThis.crypto&&typeof globalThis.crypto.randomUUID==='function'?globalThis.crypto.randomUUID():('00000000-0000-4000-8000-'+Date.now().toString(16).padStart(12,'0').slice(-12))}

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

export {drawRecoveryMap,renderProgress,renderRecoveryMap};
