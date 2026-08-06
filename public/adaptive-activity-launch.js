import { isAdaptiveLaunchDescriptor } from './adaptive-activity-contract.js';
import { nav } from './router.js';

async function consumeDescriptor(launch, contentRef, options = {}) {
  switch (launch.kind) {
    case 'vocabulary_practice':
      return typeof window.launchVocabularyPractice === 'function'
        && window.launchVocabularyPractice(launch.mode, launch.topicId) === true;
    case 'grammar_practice':
      if (typeof window.gStart !== 'function') return false;
      window.gStart(launch.topicId);
      return true;
    case 'exam_workflow':
      return typeof window.launchGrammarExam === 'function'
        && window.launchGrammarExam(contentRef) === true;
    case 'reading_mode':
      return typeof window.launchReadingPractice === 'function'
        && await window.launchReadingPractice(launch.mode, launch.cefr, contentRef, options) === true;
    case 'listening_mode':
      if (launch.mode === 'matching' && typeof window.lMt === 'function') window.lMt();
      else if (launch.mode === 'interview' && typeof window.lIq === 'function') window.lIq();
      else return false;
      return true;
    case 'writing_task':
      return typeof window.launchWritingTask === 'function'
        && window.launchWritingTask(launch.taskType, launch.taskId) === true;
    case 'speaking_task':
      return typeof window.launchSpeakingTask === 'function'
        && window.launchSpeakingTask(launch.taskNumber, contentRef) === true;
    case 'voice_tutor_recovery': {
      const screen = document.getElementById(launch.screenId);
      if (!screen) return false;
      screen.dataset.adaptiveRecoverySkillId = launch.skillId;
      screen.dataset.adaptiveRecoveryRepeatId = launch.repeatId;
      screen.dataset.adaptiveRecoveryTaskId = launch.taskId;
      window.dispatchEvent(new CustomEvent('adaptive-recovery-launch', {
        detail: { skillId: launch.skillId, repeatId: launch.repeatId, taskId: launch.taskId },
      }));
      return true;
    }
    default:
      return false;
  }
}

export function launchAdaptiveActivity(launch, contentRef) {
  if (!isAdaptiveLaunchDescriptor(launch) || typeof contentRef !== 'string') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        controller.abort();
        resolve(false);
      }
    }, 8_000);
    nav(launch.screenId, async () => {
      let launched = false;
      try { launched = await consumeDescriptor(launch, contentRef, { signal: controller.signal }); } catch { launched = false; }
      if (launched) {
        const screen = document.getElementById(launch.screenId);
        if (screen) {
          screen.dataset.adaptiveLaunchKind = launch.kind;
          screen.dataset.adaptiveLaunchContentRef = contentRef;
        }
      }
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve(launched);
      }
    });
  });
}
