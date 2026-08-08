const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

function safeErrorCode(error) {
  const code = String(error?.code || 'RETENTION_FAILED');
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'RETENTION_FAILED';
}

export function createSpeakingCalibrationRetentionService({
  purgeExpiredSamples,
  now = () => new Date(),
  logger = { info() {}, error() {} },
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = DEFAULT_RETENTION_INTERVAL_MS,
}) {
  let timer = null;

  async function runOnce() {
    const timestamp = now();
    try {
      const result = await purgeExpiredSamples({ now: timestamp });
      if (result.deletedAudio > 0) logger.info({
        timestamp: timestamp.toISOString(),
        level: 'info',
        type: 'speaking_calibration_retention',
        deletedAudio: result.deletedAudio,
      });
      return result;
    } catch (error) {
      logger.error({
        timestamp: timestamp.toISOString(),
        level: 'error',
        type: 'speaking_calibration_retention_failed',
        errorCode: safeErrorCode(error),
      });
      return null;
    }
  }

  function start() {
    if (timer !== null) return;
    timer = setIntervalFn(() => {
      void runOnce();
    }, intervalMs);
    timer?.unref?.();
    void runOnce();
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return Object.freeze({ runOnce, start, stop });
}
