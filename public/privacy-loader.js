/* Startup policy probe and lazy adapter for the secondary privacy sheet. */
import {SRV,registerProfileHook,registerStartHook} from './app.js';

let loaded=null,pending=null;
function loadPrivacyControls(){
  if(loaded)return Promise.resolve(loaded);
  if(pending)return pending;
  pending=import('./privacy.js').then(function(module){loaded=module;pending=null;return module},function(error){pending=null;throw error});
  return pending
}

async function openPrivacy(){return(await loadPrivacyControls()).openPrivacy()}
async function openCalibrationPrivacy(){return(await loadPrivacyControls()).openCalibrationPrivacy()}

window.openPrivacy=openPrivacy;
window.openCalibrationPrivacy=openCalibrationPrivacy;

registerProfileHook(async function(){return(await loadPrivacyControls()).addProfileControls()});
registerStartHook(async function(){
  if(!SRV)return;
  try{
    const current=await window.EasyBoostApi.get('/api/v1/privacy/consent');
    if(current?.policy_version!==current?.current_policy_version){
      const controls=await loadPrivacyControls();await controls.loadPrivacy(true);await controls.loadCalibrationConsent()
    }
  }catch(_){/* Consent remains fail-closed and can be opened explicitly. */}
});

export{loadPrivacyControls,openCalibrationPrivacy,openPrivacy};
