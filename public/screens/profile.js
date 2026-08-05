/*
 * Экран «Профиль» (scr11). Загружается с оболочкой, чтобы настройки открывались уже при первом офлайн-запуске.
 * Подписку, согласия и ключи дописывают хуки профиля: их регистрируют оболочка и privacy.js,
 * поэтому экран только рисует шапку и зовёт хуки.
 */
import {nav,registerRouteHook} from '../router.js';
import {SRV,S,TOKEN,apiGet,currentUser,profileModule,runProfileHooks,save,setTxt} from '../app.js';

let profileGoal=null;
let profileGoalAvailable=true;
let profileGoalOwner=null;

function drawStudySettings(){
  const preferences=profileModule.studyPreferences(S&&S.learnerPreferences);
  const grade=document.getElementById('profile_school_grade');const minutes=document.getElementById('profile_session_minutes');
  const summary=document.getElementById('pf_study_summary');const goalValue=document.getElementById('pf_goal_value');
  if(grade)grade.value=preferences.schoolGrade==null?'':String(preferences.schoolGrade);
  if(minutes)minutes.value=String(preferences.preferredSessionMinutes);
  if(summary)summary.textContent=profileModule.studySummary(preferences,profileGoal,profileGoalAvailable);
  if(goalValue)goalValue.textContent=!profileGoalAvailable?'Временно недоступна':profileGoal?'Цель: '+profileGoal.targetScore+'+':'Не настроена';
}

function bindStudySettings(){
  const form=document.getElementById('profile_preferences_form');const editGoal=document.getElementById('profile_goal_edit');
  const notice=document.getElementById('profile_preferences_notice');
  if(form&&!form.dataset.bound){form.dataset.bound='true';form.addEventListener('submit',function(event){
    event.preventDefault();const grade=document.getElementById('profile_school_grade');const minutes=document.getElementById('profile_session_minutes');
    const preferences=profileModule.createStudyPreferences(grade&&grade.value,minutes&&minutes.value);
    if(!preferences){if(notice)notice.textContent='Выберите класс 8–11 или «Не указан» и длительность 15–120 минут с шагом 5.';return}
    if(!S){if(notice)notice.textContent='Настройки пока недоступны.';return}
    S.learnerPreferences=preferences;save({queueNow:true});drawStudySettings();
    if(notice)notice.textContent=navigator.onLine===false?'Сохранено на устройстве. Синхронизируем после восстановления сети.':'Настройки сохранены.';
  })}
  if(editGoal&&!editGoal.dataset.bound){editGoal.dataset.bound='true';editGoal.addEventListener('click',function(){
    nav('scr10',function(){window.dispatchEvent(new CustomEvent('adaptive-goal-edit'))});
  })}
}

async function loadAdaptiveGoal(owner){
  try{
    const payload=await apiGet('/api/v1/adaptive-learning/goal');
    if(currentUser!==owner)return;profileGoal=payload&&payload.goal||null;profileGoalAvailable=true;drawStudySettings();
  }catch(_){if(currentUser!==owner)return;profileGoal=null;profileGoalAvailable=false;drawStudySettings()}
}

function renderProfile(){
  const u=profileModule.displayName(currentUser);setTxt('pf_ava',profileModule.initial(u));setTxt('pf_name',u);setTxt('pf_ai','через сервер ✓');
  if(profileGoalOwner!==currentUser){profileGoalOwner=currentUser;profileGoal=null;profileGoalAvailable=true}
  bindStudySettings();drawStudySettings();if(SRV&&TOKEN)loadAdaptiveGoal(currentUser);runProfileHooks();
}

registerRouteHook(function(id){if(id==='scr11')renderProfile()});

export {drawStudySettings,renderProfile};
