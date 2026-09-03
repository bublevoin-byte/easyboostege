const LEARNER_DESTINATIONS=Object.freeze([
  Object.freeze({id:'today',label:'Сегодня',screenId:'scr1'}),
  Object.freeze({id:'practice',label:'Практика',screenId:'aisy-practice'}),
  Object.freeze({id:'ege',label:'ЕГЭ',screenId:'aisy-ege'}),
  Object.freeze({id:'progress',label:'Прогресс',screenId:'scr10'}),
  Object.freeze({id:'profile',label:'Профиль',screenId:'scr11'}),
]);

const TOP_LEVEL_BY_SCREEN=new Map(LEARNER_DESTINATIONS.map(destination=>[destination.screenId,destination]));
const DESTINATION_BY_ID=new Map(LEARNER_DESTINATIONS.map(destination=>[destination.id,destination]));
const DEEP_DESTINATION_BY_SCREEN=new Map([
  ['scr2','practice'],['scr3','practice'],['scr4','practice'],['scr7','practice'],
  ['scr8','practice'],['scr9','practice'],['scr12','practice'],['scr13','practice'],
  ['scr14','practice'],['scr15','practice'],['scr16','ege'],['scr17','progress'],
]);
const CONTEXTUAL_LEARNING_SCREENS=new Set(['scr2','scr3','scr4','scr7','scr8','scr9','scr12','scr13','scr14','scr15']);
const EXAM_CHROME_SCREENS=new Set(['scr16']);
const ICON_PATHS={
  back:['M19 12H5','m11 7-5 5 5 5'],
  today:['M3 11.5 12 4l9 7.5','M5.5 10.5V20h13v-9.5'],
  practice:['M5 5.5h5.5A3.5 3.5 0 0 1 14 9v10H8.5A3.5 3.5 0 0 0 5 22V5.5Z','M19 5.5h-5.5A3.5 3.5 0 0 0 10 9v10h5.5A3.5 3.5 0 0 1 19 22V5.5Z'],
  ege:['M5 4h14v16H5z','M8 8h8M8 12h5M8 16h7'],
  progress:['M5 19v-6M12 19V6M19 19v-9'],
  profile:['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M5 21a7 7 0 0 1 14 0'],
};

function projectLearnerShell(screenId,{entryDestination=null}={}){
  const destination=TOP_LEVEL_BY_SCREEN.get(screenId);
  if(destination)return{activeDestination:destination.id,backTarget:null,topLevel:true};
  const contextual=CONTEXTUAL_LEARNING_SCREENS.has(screenId)&&DESTINATION_BY_ID.has(entryDestination)
    ?entryDestination:null;
  const activeDestination=contextual||DEEP_DESTINATION_BY_SCREEN.get(screenId)||null;
  const hub=DESTINATION_BY_ID.get(activeDestination);
  return{activeDestination,backTarget:hub?.screenId||null,topLevel:false};
}

function navigationIcon(document,id){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');
  svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');
  svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
  ICON_PATHS[id].forEach(data=>{const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',data);svg.appendChild(path)});
  return svg;
}

function installLearnerShell({document,navigateTopLevel,navigateBackToHub,currentScreen,registerRouteHook,registerBackAdapter}){
  const frame=document.getElementById('frame');
  if(!frame)throw new Error('Learner shell requires #frame');
  LEARNER_DESTINATIONS.forEach(destination=>{
    const screen=document.getElementById(destination.screenId);
    if(screen&&!screen.querySelector('main[tabindex], [data-aisy-shell-focus]')){
      screen.tabIndex=-1;screen.dataset.aisyShellFocus='';
    }
  });
  let navigation=document.getElementById('aisy-shell-nav');
  if(!navigation){
    navigation=document.createElement('nav');navigation.id='aisy-shell-nav';navigation.className='aisy-shell-nav';
    navigation.setAttribute('aria-label','Основные разделы');navigation.hidden=true;
    const list=document.createElement('div');list.className='aisy-shell-nav__list';
    LEARNER_DESTINATIONS.forEach(destination=>{
      const button=document.createElement('button');button.type='button';button.className='aisy-shell-nav__item';
      button.dataset.destination=destination.id;button.setAttribute('aria-label',destination.label);
      const label=document.createElement('span');label.className='aisy-shell-nav__label';label.textContent=destination.label;
      button.append(navigationIcon(document,destination.id),label);
      button.addEventListener('click',()=>navigateTopLevel(destination.screenId));list.appendChild(button);
    });
    navigation.appendChild(list);frame.appendChild(navigation);
  }
  let backControl=document.getElementById('aisy-shell-back');
  if(!backControl){
    backControl=document.createElement('button');backControl.id='aisy-shell-back';backControl.className='aisy-shell-back';
    backControl.type='button';backControl.hidden=true;backControl.appendChild(navigationIcon(document,'back'));
    const backLabel=document.createElement('span');backLabel.className='aisy-shell-back__label';backControl.appendChild(backLabel);
    backControl.addEventListener('click',()=>navigateBackToHub());frame.appendChild(backControl);
  }

  let entryDestination=null;
  let currentProjection=projectLearnerShell(currentScreen());
  function sync(screenId,previousScreenId=null){
    const previousTop=projectLearnerShell(previousScreenId);
    const direct=projectLearnerShell(screenId);
    if(direct.topLevel)entryDestination=direct.activeDestination;
    else if(previousTop.topLevel)entryDestination=previousTop.activeDestination;
    currentProjection=projectLearnerShell(screenId,{entryDestination});
    const authorized=document.body?.dataset.learningAccess==='active';
    const ownsDeepChrome=EXAM_CHROME_SCREENS.has(screenId);
    navigation.hidden=!authorized||!currentProjection.topLevel;
    navigation.inert=!authorized||!currentProjection.topLevel;
    const backDestination=DESTINATION_BY_ID.get(currentProjection.activeDestination);
    backControl.hidden=!authorized||!currentProjection.backTarget||ownsDeepChrome;
    backControl.inert=!authorized||!currentProjection.backTarget||ownsDeepChrome;
    if(backDestination){
      const backLabel=`Назад в раздел ${backDestination.label}`;
      backControl.setAttribute('aria-label',backLabel);
      backControl.querySelector('.aisy-shell-back__label').textContent=backLabel;
    }
    navigation.dataset.activeDestination=currentProjection.activeDestination||'';
    frame.dataset.aisyShellTopLevel=String(currentProjection.topLevel);
    frame.dataset.aisyExamChrome=String(ownsDeepChrome);
    document.body.classList.toggle('aisy-shell-top-level',currentProjection.topLevel);
    document.body.classList.toggle('aisy-shell-deep',Boolean(currentProjection.backTarget)&&!ownsDeepChrome);
    navigation.querySelectorAll('[data-destination]').forEach(button=>{
      if(button.dataset.destination===currentProjection.activeDestination)button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    if(currentProjection.topLevel&&previousScreenId){
      const screen=document.getElementById(screenId);
      const content=screen?.querySelector('main[tabindex], [data-aisy-shell-focus]')||screen;
      if(content)queueMicrotask(()=>{if(currentScreen()===screenId)content.focus({preventScroll:true})});
    }
    return currentProjection;
  }
  registerBackAdapter(screenId=>projectLearnerShell(screenId,{entryDestination}).backTarget);
  registerRouteHook(sync);sync(currentScreen());
  return Object.freeze({navigation,projection:()=>currentProjection,sync});
}

export {LEARNER_DESTINATIONS,installLearnerShell,projectLearnerShell};
