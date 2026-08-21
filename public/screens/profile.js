/*
 * Экран «Профиль» (scr11). Загружается с оболочкой, чтобы настройки открывались уже при первом офлайн-запуске.
 * Подписку, согласия и ключи дописывают хуки профиля: их регистрируют оболочка и privacy.js,
 * поэтому экран только рисует шапку и зовёт хуки.
 */
import {nav,registerRouteHook} from '../router.js';
import {SRV,S,TOKEN,apiGet,apiIsAuthorityFailure,apiResponseOwner,currentUser,invalidateLearningAuthority,profileModule,registerAuthorityReset,runProfileHooks,save,setTxt} from '../app.js';
import {presentProfilePlan} from '../commercial-copy.js';

let profileGoal=null;
let profileGoalAvailable=true;
let profileGoalAuthority=null;
function sameProfileAuthority(a,b){return Boolean(a&&b&&a.owner===b.owner&&a.ownerGeneration===b.ownerGeneration)}
function currentProfileAuthority(){const owner=currentUser,generation=window.EasyBoostSync?.ownerBoundGeneration?.(owner);return owner&&Number.isSafeInteger(generation)?{owner:owner,ownerGeneration:generation}:null}
function resetProfileAuthority(authority){if(authority&&!sameProfileAuthority(authority,profileGoalAuthority))return false;profileGoal=null;profileGoalAvailable=false;profileGoalAuthority=null;drawStudySettings();return true}

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

function drawProfilePlan(session){
  const plan=presentProfilePlan(session);setTxt('pf_plan_name',plan.label);setTxt('pf_plan_summary',plan.summary);
}

async function loadAdaptiveGoal(authority){
  const owner=authority&&authority.owner,generation=authority&&authority.ownerGeneration;if(!owner||!Number.isSafeInteger(generation))return;
  try{
    const payload=await apiGet('/api/v1/adaptive-learning/goal',{headers:{'X-EasyBoost-Expected-Owner':owner}});
    if(currentUser!==owner||window.EasyBoostSync?.ownerBoundGeneration?.(owner)!==generation)return;
    if(!payload||apiResponseOwner(payload)!==owner){await invalidateLearningAuthority({owner:owner,ownerGeneration:generation});return}
    profileGoal=payload.goal||null;profileGoalAvailable=true;drawStudySettings();
  }catch(error){if(currentUser!==owner||window.EasyBoostSync?.ownerBoundGeneration?.(owner)!==generation)return;if(apiIsAuthorityFailure(error)){await invalidateLearningAuthority({owner:owner,ownerGeneration:generation});return}profileGoal=null;profileGoalAvailable=false;drawStudySettings()}
}

function renderProfile(){
  const u=profileModule.displayName(currentUser);setTxt('pf_ava',profileModule.initial(u));setTxt('pf_name',u);setTxt('pf_ai','через сервер ✓');
  drawProfilePlan(window.__sub);
  const authority=currentProfileAuthority();if(!sameProfileAuthority(profileGoalAuthority,authority)){profileGoalAuthority=authority;profileGoal=null;profileGoalAvailable=true}
  bindStudySettings();drawStudySettings();if(SRV&&TOKEN&&authority)loadAdaptiveGoal(authority);runProfileHooks();
}

registerAuthorityReset(function(authority){resetProfileAuthority(authority)});
registerRouteHook(function(id){if(id==='scr11')renderProfile()});

export {drawProfilePlan,drawStudySettings,renderProfile};
