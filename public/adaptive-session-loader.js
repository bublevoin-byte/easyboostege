/* Small first-load seam for the adaptive runtime used only after a learner starts or clears a session. */
let runtime=null,pending=null;

function loadAdaptiveSessionRuntime(){
  if(runtime)return Promise.resolve(runtime);
  if(pending)return pending;
  pending=import('./adaptive-session-runtime.js').then(function(module){runtime=module;pending=null;return module},function(error){pending=null;throw error});
  return pending
}

async function advanceAdaptiveBreak(...args){return(await loadAdaptiveSessionRuntime()).advanceAdaptiveBreak(...args)}
async function beginAdaptiveBlock(...args){return(await loadAdaptiveSessionRuntime()).beginAdaptiveBlock(...args)}
async function clearAdaptiveRuntime(...args){return(await loadAdaptiveSessionRuntime()).clearAdaptiveRuntime(...args)}
async function completeAdaptiveModuleActivity(...args){return(await loadAdaptiveSessionRuntime()).completeAdaptiveModuleActivity(...args)}
async function finishAdaptiveSession(...args){return(await loadAdaptiveSessionRuntime()).finishAdaptiveSession(...args)}
async function resumeAdaptiveExecution(...args){return(await loadAdaptiveSessionRuntime()).resumeAdaptiveExecution(...args)}

export{
  advanceAdaptiveBreak,beginAdaptiveBlock,clearAdaptiveRuntime,completeAdaptiveModuleActivity,
  finishAdaptiveSession,loadAdaptiveSessionRuntime,resumeAdaptiveExecution,
};
