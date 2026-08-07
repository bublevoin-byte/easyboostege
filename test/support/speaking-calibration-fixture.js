import { speakingCalibrationRubric } from '../../speaking/accent-calibration.js';

export function speakingCalibrationSampleMaterial(taskType, taskRef) {
  const match = /^task[1-4]:[a-zA-Z0-9._-]+:([a-zA-Z0-9._-]+)@(\d+)$/u.exec(taskRef);
  if (!match) throw new Error('TEST_SPEAKING_CALIBRATION_TASK_REF_INVALID');
  const rubricSnapshot = speakingCalibrationRubric(taskType);
  return {
    taskSnapshot: {
      id: match[1],
      revision: Number(match[2]),
      taskType: Number(taskType),
      maxScore: rubricSnapshot.maximumScore,
      instruction: 'Server-owned calibration fixture.',
    },
    rubricSnapshot,
  };
}
