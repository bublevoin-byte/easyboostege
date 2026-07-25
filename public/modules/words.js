(function initializeWordsModule(global) {
  'use strict';

  function baseForm(word) {
    return String(word || '').replace(/^to /u, '').toLowerCase().trim();
  }

  function modeFor(record) {
    const stage = Math.max(0, Number(record?.s) || 0);
    if (stage <= 1) return 'c1';
    if (stage === 2) return 'c2';
    return 'type';
  }

  function calculateStats(catalog, records) {
    let learned = 0;
    let learning = 0;
    for (const item of catalog || []) {
      const stage = Math.max(0, Number(records?.[item.w]?.s) || 0);
      if (!stage) continue;
      if (stage >= 5) learned += 1;
      else learning += 1;
    }
    const total = (catalog || []).length;
    return { learned, learning, fresh: total - learned - learning, total };
  }

  function buildDailyQueue(catalog, records, options = {}) {
    const now = Number(options.now) || Date.now();
    const newLimit = Math.max(0, Number(options.newLimit) || 0);
    const due = [];
    const fresh = [];
    for (const item of catalog || []) {
      const record = records?.[item.w];
      if (record && Number(record.s) > 0) {
        if ((Number(record.due) || 0) <= now) due.push(item);
      } else {
        fresh.push(item);
      }
    }
    due.sort((left, right) => (Number(records[left.w]?.due) || 0) - (Number(records[right.w]?.due) || 0));
    return due.concat(fresh.slice(0, newLimit));
  }

  function migrateLegacy(catalog, box, records, now = Date.now()) {
    const target = records && typeof records === 'object' ? records : {};
    for (const item of catalog || []) {
      const legacyStage = Math.max(0, Number(box?.[item.w]) || 0);
      if (legacyStage && !target[item.w]) {
        target[item.w] = { s: Math.min(3, legacyStage), e: 0, n: legacyStage, due: now };
      }
    }
    return target;
  }

  function distractors(catalog, item, field, random = Math.random) {
    const pool = (catalog || []).filter(
      (candidate) => candidate.w !== item.w && (candidate.p === item.p || random() < 0.25),
    );
    pool.sort(() => random() - 0.5);
    const output = [];
    const seen = new Set([item[field]]);
    for (const candidate of pool) {
      const value = candidate[field];
      if (seen.has(value)) continue;
      seen.add(value);
      output.push(value);
      if (output.length === 3) break;
    }
    return output;
  }

  function mergeGenerated(catalog, generated) {
    const known = new Set((catalog || []).map((item) => item.w));
    const added = [];
    for (const item of generated || []) {
      if (!item?.w || !item?.tr || known.has(item.w)) continue;
      catalog.push(item);
      known.add(item.w);
      added.push(item);
    }
    return added;
  }

  global.EasyBoostWords = Object.freeze({
    baseForm,
    modeFor,
    calculateStats,
    buildDailyQueue,
    migrateLegacy,
    distractors,
    mergeGenerated,
  });
})(window);
