import { createSpeakingSequentialBrowserFlow } from './speaking-sequential-runtime.js';

const TASK2_BROWSER_CONTRACT = Object.freeze({
  sessionPath: '/api/v1/speaking/task-2/sessions',
  completionPath: (sessionId, questionNumber) => (
    `/api/v1/speaking/task-2/sessions/${sessionId}/questions/${questionNumber}/complete`
  ),
  positionCount: 4,
  positionNumberKey: 'questionNumber',
  currentPublicKey: 'currentQuestion',
  collectionPublicKey: 'questions',
  completedCode: 'SPEAKING_TASK2_COMPLETED',
  completedMessage: 'All four questions are complete',
  invalidResponseCode: 'SPEAKING_TASK2_RESPONSE_INVALID',
  invalidResponseMessage: 'Speaking task 2 response is invalid',
  acceptTask(task) {
    return task?.taskType === 2 && task?.supports?.length === 4
      && task?.preparationSeconds === 60 && task?.questionSeconds === 20 && task?.maxScore === 4;
  },
});

export function createSpeakingTask2BrowserFlow(options = {}) {
  const flow = createSpeakingSequentialBrowserFlow(options, TASK2_BROWSER_CONTRACT);
  return Object.freeze({
    state: flow.state,
    loadAssignment: flow.loadAssignment,
    restoreSession: flow.restoreSession,
    checkMicrophone: flow.checkMicrophone,
    startQuestion: flow.startPosition,
    stopQuestion: flow.stopPosition,
    playQuestion: flow.playPosition,
    completeQuestion: flow.completePosition,
    dispose: flow.dispose,
  });
}
