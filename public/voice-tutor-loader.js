/*
 * Small first-load adapter for the optional Voice Tutor runtime.
 *
 * Subject screens can render honest entitlement-aware buttons without downloading media,
 * realtime transport and the dialog implementation. The full runtime is fetched only when a
 * learner records an eligible error or explicitly opens its explanation.
 */
import {
  canStartVoiceTutor,eventForVoiceTutorState,prepareVoiceTutorContextResult,
  voiceTutorButton,voiceTutorResultSlot,
} from './voice-tutor-contract.js';

let configuredOptions={};
let loadedRuntime=null;
let pendingRuntime=null;

function loadVoiceTutor(){
  if(loadedRuntime)return Promise.resolve(loadedRuntime);
  if(pendingRuntime)return pendingRuntime;
  pendingRuntime=import('./voice-tutor.js').then(function(runtime){
    loadedRuntime=runtime;pendingRuntime=null;runtime.configureVoiceTutor(configuredOptions);return runtime
  },function(error){pendingRuntime=null;throw error});
  return pendingRuntime
}

function configureVoiceTutor(options={}){
  configuredOptions={...configuredOptions,...options};
  if(loadedRuntime)loadedRuntime.configureVoiceTutor(configuredOptions)
}

async function registerVoiceTutorError(details){return(await loadVoiceTutor()).registerVoiceTutorError(details)}
async function registerVoiceTutorContextResult(details){return(await loadVoiceTutor()).registerVoiceTutorContextResult(details)}
async function openVoiceTutorError(details){return(await loadVoiceTutor()).openVoiceTutorError(details)}
async function finishVoiceTutor(){return(await loadVoiceTutor()).finishVoiceTutor()}

export{
  canStartVoiceTutor,configureVoiceTutor,eventForVoiceTutorState,finishVoiceTutor,loadVoiceTutor,
  openVoiceTutorError,prepareVoiceTutorContextResult,registerVoiceTutorContextResult,
  registerVoiceTutorError,voiceTutorButton,voiceTutorResultSlot,
};
