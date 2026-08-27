/* Startup policy probe and lazy adapter for the secondary privacy sheet. */
import {
  SRV, apiIsAuthorityFailure, apiResponseOwner, currentUser, invalidateLearningAuthority,
  registerProfileHook, registerStartHook,
} from './app.js';

let loaded=null,pending=null;
function loadPrivacyControls(){
  if(loaded)return Promise.resolve(loaded);
  if(pending)return pending;
  pending=import('./privacy.js').then(function(module){loaded=module;pending=null;return module},function(error){pending=null;throw error});
  return pending
}

async function openPrivacy(){return(await loadPrivacyControls()).openPrivacy()}
async function openCalibrationPrivacy(){return(await loadPrivacyControls()).openCalibrationPrivacy()}

function currentPrivacyProbeAuthority(){
  const owner=currentUser;
  const ownerGeneration=window.EasyBoostSync?.ownerBoundGeneration?.(owner);
  return owner&&Number.isSafeInteger(ownerGeneration)?{owner,ownerGeneration}:null
}

function privacyProbeAuthorityCurrent(authority){
  return Boolean(authority&&currentUser===authority.owner
    &&window.EasyBoostSync?.ownerBoundGeneration?.(authority.owner)===authority.ownerGeneration)
}

window.openPrivacy=openPrivacy;
window.openCalibrationPrivacy=openCalibrationPrivacy;

registerProfileHook(async function(){return(await loadPrivacyControls()).addProfileControls()});
registerStartHook(async function(){
  if(!SRV)return;
  const authority=currentPrivacyProbeAuthority();
  if(!authority)return;
  try{
    const current=await window.EasyBoostApi.get('/api/v1/privacy/consent',{
      headers:{'X-EasyBoost-Expected-Owner':authority.owner},
    });
    if(!privacyProbeAuthorityCurrent(authority))return;
    if(apiResponseOwner(current)!==authority.owner){await invalidateLearningAuthority(authority);return}
    if(current?.policy_version!==current?.current_policy_version){
      const controls=await loadPrivacyControls();await controls.loadPrivacy(true);await controls.loadCalibrationConsent()
    }
  }catch(error){
    if(privacyProbeAuthorityCurrent(authority)&&apiIsAuthorityFailure(error)){
      await invalidateLearningAuthority(authority)
    }
    /* Consent remains fail-closed and can be opened explicitly. */
  }
});

export{loadPrivacyControls,openCalibrationPrivacy,openPrivacy};
