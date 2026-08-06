(function initializeSpeakingModule(global) {
  'use strict';

  const CONFIG = {
    1: { name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' },
    2: { name: 'Вопросы к объявлению', prep: 60, rec: 80, per: 20, max: 4, sub: 'задание 2 · 4 балла' },
    3: { name: 'Интервью', prep: 0, rec: 40, max: 5, sub: 'задание 3 · 5 баллов' },
    4: { name: 'Монолог по фото', prep: 60, rec: 150, max: 10, sub: 'задание 4 · 10 баллов' },
  };

  const TASKS = [1, 2, 3, 4];
  const EXAM_MAX = TASKS.reduce((total, task) => total + CONFIG[task].max, 0);
  const SCORE_LIMIT = 30;
  const AVERAGE_WINDOW = 5;
  const MIN_TRANSCRIPT_WORDS = 3;
  const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  // The oral exam rewards a lower share of the maximum than the written sections.
  const BADGES = { gold: 0.8, silver: 0.5 };

  function config(task) {
    return CONFIG[task] || CONFIG[1];
  }

  function isExperimentalTask(task) {
    return task === 3 || task === 4;
  }

  function normalizeState(state) {
    const target = state && typeof state === 'object' ? state : {};
    TASKS.forEach((task) => {
      const key = 't' + task;
      target[key] = target[key] || { n: 0 };
      target[key].n = Math.max(0, Number(target[key].n) || 0);
    });
    return target;
  }

  function trainingTotal(state) {
    const value = normalizeState(state);
    return TASKS.reduce((total, task) => total + value['t' + task].n, 0);
  }

  function summary(scores, state) {
    const history = scores || [];
    const trainings = trainingTotal(state);
    if (!history.length) return { count: 0, average: 0, trainings, progress: Math.min(100, trainings * 4), rated: false };
    const last = history.slice(-AVERAGE_WINDOW);
    const ratio = last.reduce((total, score) => total + ((Number(score.g) || 0) / (Number(score.m) || 1)), 0);
    const average = Math.round(ratio / last.length * 100);
    return { count: history.length, average, trainings, progress: average, rated: true };
  }

  function appendScore(scores, entry, limit = SCORE_LIMIT) {
    return (scores || []).concat([entry]).slice(-limit);
  }

  function preferredMimeType(recorder) {
    if (!recorder || typeof recorder.isTypeSupported !== 'function') return '';
    for (const candidate of MIME_CANDIDATES) {
      try {
        if (recorder.isTypeSupported(candidate)) return candidate;
      } catch (error) {
        return '';
      }
    }
    return '';
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(value / 60) + ':' + ('0' + (value % 60)).slice(-2);
  }

  function pool(base, generated) {
    return (base || []).concat(generated || []);
  }

  function select(items, index) {
    const list = items || [];
    if (!list.length) return null;
    const size = list.length;
    return list[(((Math.floor(Number(index) || 0) % size) + size) % size)];
  }

  function assignment(task, set) {
    const value = set || {};
    if (task === 1) return { tx: value.tx };
    if (task === 2) return { ad: value.ad, points: value.points };
    if (task === 3) return { topic: value.topic, qs: value.qs };
    return { topic: value.topic, plan: value.plan, ph: value.ph };
  }

  function isTranscriptUsable(transcript) {
    const value = String(transcript == null ? '' : transcript).trim();
    return value ? value.split(/\s+/).filter(Boolean).length >= MIN_TRANSCRIPT_WORDS : false;
  }

  function clampScore(review, task) {
    const max = config(task).max;
    const got = Math.max(0, Math.min(max, Number(review && review.got) || 0));
    return { got, max };
  }

  function sentences(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value) return [];
    const parts = value.match(/[^.!?]+[.!?]+/g) || [value];
    return parts.map((part) => part.trim()).filter(Boolean);
  }

  function examTotal(results) {
    return TASKS.reduce((total, task) => total + (Number(results && results[task] && results[task].got) || 0), 0);
  }

  function weakestTask(results) {
    return TASKS.slice().sort((left, right) => (
      ((Number(results[left] && results[left].got) || 0) / config(left).max)
      - ((Number(results[right] && results[right].got) || 0) / config(right).max)
    ))[0];
  }

  function normalizeGenerated(task, data) {
    if (!data) return null;
    if (task === 1) {
      const text = String(data.tx || '');
      if (text.split(/\s+/).filter(Boolean).length < 60) return null;
      return { tx: text };
    }
    if (task === 2) {
      if (!data.ad || !Array.isArray(data.points) || data.points.length !== 4) return null;
      if (!Array.isArray(data.exq) || data.exq.length !== 4) return null;
      return { ad: String(data.ad), points: data.points.map(String), exq: data.exq.map(String) };
    }
    if (task === 3) {
      if (!data.topic || !Array.isArray(data.qs) || data.qs.length !== 5) return null;
      return { topic: String(data.topic), qs: data.qs.map(String) };
    }
    if (!data.topic || !Array.isArray(data.ph) || data.ph.length !== 2) return null;
    return {
      topic: String(data.topic),
      ph: data.ph.map(String),
      plan: [
        'кратко опиши обе фотографии',
        'скажи, что общего у фотографий',
        'скажи, чем они различаются',
        'скажи, что ближе тебе, и объясни почему',
      ],
    };
  }

  function serverTask1Set(session) {
    const task = session && session.task;
    const assessment = session && session.pronunciationAssessment;
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || Object.keys(task).sort().join(',') !== 'cefr,id,instruction,maxScore,preparationSeconds,responseSeconds,revision,taskType,text,topic'
      || !/^speaking-pilot-v1\.task1\.[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(task.id || ''))
      || task.revision !== 1 || task.taskType !== 1
      || task.preparationSeconds !== 90 || task.responseSeconds !== 90 || task.maxScore !== 1
      || !['B1', 'B2', 'B2+/C1'].includes(task.cefr)
      || typeof task.topic !== 'string' || !task.topic.trim()
      || typeof task.text !== 'string' || !task.text.trim()
      || assessment?.available !== false || assessment.reason !== 'provider_not_connected') return null;
    return { id: task.id, revision: task.revision, tx: task.text, topic: task.topic, cefr: task.cefr };
  }

  function serverTask2Set(session) {
    const task = session && session.task;
    const assessment = session && session.assessment;
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || Object.keys(task).sort().join(',') !== 'advertisement,cefr,id,instruction,maxScore,preparationSeconds,questionSeconds,revision,supports,taskType,topic'
      || !/^speaking-pilot-v1\.task2\.[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(task.id || ''))
      || task.revision !== 1 || task.taskType !== 2
      || task.preparationSeconds !== 60 || task.questionSeconds !== 20 || task.maxScore !== 4
      || !['B1', 'B2', 'B2+/C1'].includes(task.cefr)
      || typeof task.topic !== 'string' || !task.topic.trim()
      || typeof task.advertisement !== 'string' || !task.advertisement.trim()
      || !Array.isArray(task.supports) || task.supports.length !== 4
      || task.supports.some((support) => typeof support !== 'string' || !support.trim())
      || assessment?.available !== false || assessment.reason !== 'deferred_to_tickets_06_07') return null;
    return {
      id: task.id,
      revision: task.revision,
      ad: task.advertisement,
      points: task.supports.slice(),
      topic: task.topic,
      cefr: task.cefr,
    };
  }

  function serverTask3Set(session) {
    const task = session && session.task;
    const assessment = session && session.assessment;
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || Object.keys(task).sort().join(',') !== 'cefr,id,instruction,maxScore,preparationSeconds,questionSeconds,questions,revision,taskType,topic'
      || !/^speaking-pilot-v1\.task3\.[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(task.id || ''))
      || task.revision !== 1 || task.taskType !== 3
      || task.preparationSeconds !== 0 || task.questionSeconds !== 40 || task.maxScore !== 5
      || !['B1', 'B2', 'B2+/C1'].includes(task.cefr)
      || typeof task.topic !== 'string' || !task.topic.trim()
      || !Array.isArray(task.questions) || task.questions.length !== 5
      || task.questions.some((question) => typeof question !== 'string' || !question.trim())
      || assessment?.available !== false || assessment.reason !== 'deferred_to_tickets_06_07') return null;
    return {
      id: task.id,
      revision: task.revision,
      topic: task.topic,
      instruction: task.instruction,
      qs: task.questions.slice(),
      cefr: task.cefr,
    };
  }

  global.EasyBoostSpeaking = Object.freeze({
    config,
    isExperimentalTask,
    normalizeState,
    trainingTotal,
    summary,
    appendScore,
    preferredMimeType,
    formatTime,
    pool,
    select,
    assignment,
    isTranscriptUsable,
    clampScore,
    sentences,
    examTotal,
    weakestTask,
    normalizeGenerated,
    serverTask1Set,
    serverTask2Set,
    serverTask3Set,
    TASKS,
    EXAM_MAX,
    BADGES,
    SCORE_LIMIT,
    AVERAGE_WINDOW,
  });
})(window);
