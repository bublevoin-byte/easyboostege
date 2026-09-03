const LEARNING_ACCESS_STATES=Object.freeze({
  NO_SESSION:'no-session',
  INACTIVE:'inactive',
  NETWORK_UNKNOWN:'network-unknown',
  ACTIVE:'active',
});

function classifyLearningAccess(session,error=null){
  if(error){
    const status=Number(error.status)||0;
    if(status===401)return{state:LEARNING_ACCESS_STATES.NO_SESSION,session:null};
    return{state:LEARNING_ACCESS_STATES.NETWORK_UNKNOWN,session:null};
  }
  if(!session||session.authenticated!==true){
    return{state:LEARNING_ACCESS_STATES.NO_SESSION,session:null};
  }
  if(session.active!==true){
    return{state:LEARNING_ACCESS_STATES.INACTIVE,session};
  }
  return{state:LEARNING_ACCESS_STATES.ACTIVE,session};
}

export {classifyLearningAccess,LEARNING_ACCESS_STATES};
