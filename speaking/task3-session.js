import {
  applySequentialSpeakingPositionCompletion,
  newSequentialSpeakingSession,
  publicSequentialSpeakingSession,
} from './sequential-session.js';

const TASK3_SEQUENCE = Object.freeze({
  positionCount: 5,
  positionNumberKey: 'questionNumber',
  currentStorageKey: 'current_question',
  collectionStorageKey: 'answers',
  currentPublicKey: 'currentQuestion',
  collectionPublicKey: 'answers',
  errorPrefix: 'SPEAKING_TASK3_ANSWER',
});

export function newSpeakingTask3Session({
  username, catalogId, catalogRevision, selection, accentProfile = null, now = new Date(),
}) {
  return newSequentialSpeakingSession({
    username, catalogId, catalogRevision, selection, accentProfile, now, contract: TASK3_SEQUENCE,
  });
}

export function applySpeakingTask3AnswerCompletion(session, questionNumber, completion, now = new Date()) {
  return applySequentialSpeakingPositionCompletion(
    session, questionNumber, completion, now, TASK3_SEQUENCE,
  );
}

export function publicSpeakingTask3Session(session, task) {
  return publicSequentialSpeakingSession(session, task, TASK3_SEQUENCE);
}
