import { isAdaptiveLaunchDescriptor } from './adaptive-activity-contract.js';
import { nav } from './router.js';

async function consumeDescriptor(launch, contentRef, options = {}) {
  if (typeof options.authorityCurrent === 'function' && options.authorityCurrent() !== true) return false;
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

export function launchAdaptiveActivity(launch, contentRef, authorityCurrent = null) {
  if (!isAdaptiveLaunchDescriptor(launch) || typeof contentRef !== 'string') {
    return Promise.resolve(false);
  }
  const ownerAuthorized = () => {
    try { return typeof authorityCurrent !== 'function' || authorityCurrent() === true; } catch { return false; }
  };
  if (!ownerAuthorized()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    let navigation = null;
    const authorized = () => !settled && !controller.signal.aborted && ownerAuthorized();
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        controller.abort();
        if (navigation && typeof navigation.cancel === 'function') navigation.cancel();
        resolve(false);
      }
    }, 8_000);
    const cancel = () => {
      controller.abort();
      clearTimeout(timeout);
      if (!settled) { settled = true; resolve(false); }
    };
    navigation = nav(launch.screenId, async (navigationCurrent) => {
      const commitAllowed = () => authorized()
        && (typeof navigationCurrent !== 'function' || navigationCurrent() === true);
      if (!commitAllowed()) {
        clearTimeout(timeout);
        settled = true;
        resolve(false);
        return;
      }
      let launched = false;
      try { launched = await consumeDescriptor(launch, contentRef, { signal: controller.signal, authorityCurrent: commitAllowed }); } catch { launched = false; }
      if (!commitAllowed()) launched = false;
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
    }, { beforeCommit: authorized, onCancel: cancel, signal: controller.signal });
  });
}
