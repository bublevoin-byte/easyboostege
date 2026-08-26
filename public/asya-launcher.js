/* Lightweight launcher; the conversation module stays out of the first learner screen. */
function installAsyaLauncher({document,currentScreen,registerRouteHook,assistantOptions={}}={}){
  const frame=document?.getElementById('frame');
  if(!frame||typeof currentScreen!=='function'||typeof registerRouteHook!=='function')throw new Error('Asya launcher requires the learner shell');
  let launcher=document.getElementById('asya-launcher');
  if(!launcher){
    launcher=document.createElement('button');launcher.id='asya-launcher';launcher.className='asya-launcher';launcher.type='button';
    launcher.setAttribute('aria-label','Открыть Асю');launcher.setAttribute('aria-haspopup','dialog');launcher.setAttribute('aria-expanded','false');
    launcher.innerHTML='<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 17c3-8 6-8 9 0s6 8 9 0 6-8 8 0"/><path d="M4 12c3-5 6-5 9 0s6 5 9 0 6-5 8 0"/></svg><span>Ася</span>';
    frame.append(launcher)
  }
  let assistant=null,pending=null;
  function available(){const id=currentScreen();const screen=document.getElementById(id);
    return Boolean(document.body?.dataset.learningAccess==='active'
      &&id&&screen&&!screen.matches('[data-first-launch-screen]')&&id!=='scr6')}
  function onLauncherClick(){void open()}
  function ensureAssistant(){
    if(assistant)return Promise.resolve(assistant);
    if(pending)return pending;
    launcher.setAttribute('aria-busy','true');
    pending=import('./asya-assistant.js').then(function(module){
      assistant=module.installAsyaAssistant({document,currentScreen,registerRouteHook,...assistantOptions});
      launcher.removeEventListener('click',onLauncherClick);
      pending=null;launcher.removeAttribute('aria-busy');return assistant
    },function(error){pending=null;launcher.removeAttribute('aria-busy');throw error});
    return pending
  }
  async function open(){if(!available())return null;const installed=await ensureAssistant();installed?.open();return installed}
  launcher.addEventListener('click',onLauncherClick);
  document.addEventListener('keydown',function(event){
    if(event.altKey&&!event.ctrlKey&&!event.metaKey&&event.key.toLocaleLowerCase('en-US')==='a'&&!assistant){event.preventDefault();void open()}
  });
  function sync(){const enabled=available();launcher.hidden=!enabled;launcher.inert=!enabled}
  registerRouteHook(sync);sync();
  return Object.freeze({launcher,open,loaded:()=>Boolean(assistant)})
}

export{installAsyaLauncher};
