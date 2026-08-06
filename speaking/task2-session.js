import {
  applySequentialSpeakingPositionCompletion,
  newSequentialSpeakingSession,
  publicSequentialSpeakingSession,
} from './sequential-session.js';

const TASK2_SEQUENCE = Object.freeze({
  positionCount: 4,
  positionNumberKey: 'questionNumber',
  currentStorageKey: 'current_question',
  collectionStorageKey: 'questions',
  currentPublicKey: 'currentQuestion',
  collectionPublicKey: 'questions',
  errorPrefix: 'SPEAKING_TASK2_QUESTION',
});

export function newSpeakingTask2Session({ username, catalogId, catalogRevision, selection, now = new Date() }) {
  return newSequentialSpeakingSession({
    username, catalogId, catalogRevision, selection, now, contract: TASK2_SEQUENCE,
  });
}

export function applySpeakingTask2QuestionCompletion(session, questionNumber, completion, now = new Date()) {
  return applySequentialSpeakingPositionCompletion(
    session, questionNumber, completion, now, TASK2_SEQUENCE,
  );
}

export function publicSpeakingTask2Session(session, task) {
  return publicSequentialSpeakingSession(session, task, TASK2_SEQUENCE);
}
