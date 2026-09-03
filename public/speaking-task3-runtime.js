import { createSpeakingSequentialBrowserFlow } from './speaking-sequential-runtime.js';

const TASK3_BROWSER_CONTRACT = Object.freeze({
  sessionPath: '/api/v1/speaking/task-3/sessions',
  completionPath: (sessionId, questionNumber) => (
    `/api/v1/speaking/task-3/sessions/${sessionId}/answers/${questionNumber}/complete`
  ),
  positionCount: 5,
  positionNumberKey: 'questionNumber',
  currentPublicKey: 'currentQuestion',
  collectionPublicKey: 'answers',
  completedCode: 'SPEAKING_TASK3_COMPLETED',
  completedMessage: 'All five answers are complete',
  invalidResponseCode: 'SPEAKING_TASK3_RESPONSE_INVALID',
  invalidResponseMessage: 'Speaking task 3 response is invalid',
  acceptTask(task) {
    return task?.taskType === 3 && task?.questions?.length === 5
      && task?.preparationSeconds === 0 && task?.questionSeconds === 40 && task?.maxScore === 5;
  },
});

export function createSpeakingTask3BrowserFlow(options = {}) {
  const flow = createSpeakingSequentialBrowserFlow(options, TASK3_BROWSER_CONTRACT);
  return Object.freeze({
    state: flow.state,
    loadAssignment: flow.loadAssignment,
    restoreSession: flow.restoreSession,
    checkMicrophone: flow.checkMicrophone,
    startAnswer: flow.startPosition,
    stopAnswer: flow.stopPosition,
    playAnswer: flow.playPosition,
    completeAnswer: flow.completePosition,
    assessmentRecordings: flow.assessmentRecordings,
    dispose: flow.dispose,
  });
}
