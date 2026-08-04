(function initializeWordsModule(global) {
  'use strict';

  const newWordBudgets = Object.freeze([5, 10, 15, 20]);

  function normalizeNewWordBudget(value) {
    const candidate = Number(value);
    return newWordBudgets.includes(candidate) ? candidate : 10;
  }

  function estimateSessionMinutes({ due = 0, weak = 0, fresh = 0 } = {}) {
    const reviewCount = Math.max(0, Number(due) || 0) + Math.max(0, Number(weak) || 0);
    const freshCount = Math.max(0, Number(fresh) || 0);
    return Math.ceil(reviewCount * 0.5 + freshCount);
  }

  function topicIdsFor(item) {
    const candidates = [item?.t]
      .concat(Array.isArray(item?.topics) ? item.topics : [])
      .concat(Array.isArray(item?.tags) ? item.tags : []);
    return [...new Set(candidates
      .filter((value) => value !== undefined && value !== null && String(value).trim())
      .map((value) => String(value)))];
  }

  function buildLibraryEntries(catalog, records, { stateFor } = {}) {
    const progress = records && typeof records === 'object' ? records : {};
    const deriveState = typeof stateFor === 'function'
      ? stateFor
      : (record) => record?.state || 'new';
    return (catalog || []).map((item) => {
      const record = progress[item.w] || progress[baseForm(item.w)] || null;
      const provenance = ['core', 'personal', 'generated', 'unknown'].includes(item.provenance)
        ? item.provenance
        : Number(item.t) === 0 ? 'generated' : 'core';
      const state = deriveState(record, item);
      return {
        item,
        word: String(item.w || ''),
        translation: String(item.tr || ''),
        topicIds: topicIdsFor(item),
        state: ['new', 'learning', 'review', 'strong'].includes(state) ? state : 'new',
        provenance,
        started: Boolean(record) || state !== 'new',
      };
    });
  }

  function selectedValues(values) {
    return new Set((Array.isArray(values) ? values : []).map((value) => String(value)));
  }

  function filterLibraryEntries(entries, filters = {}) {
    const query = String(filters.query || '').trim().toLocaleLowerCase('ru');
    const topics = selectedValues(filters.topics);
    const states = selectedValues(filters.states);
    const provenances = selectedValues(filters.provenances);
    return (entries || []).filter((entry) => {
      const searchable = `${entry.word} ${entry.translation}`.toLocaleLowerCase('ru');
      if (query && !searchable.includes(query)) return false;
      if (topics.size && !entry.topicIds.some((topic) => topics.has(topic))) return false;
      if (states.size && !states.has(entry.state)) return false;
      return !provenances.size || provenances.has(entry.provenance);
    });
  }

  function metadataText(value) {
    const text = String(value ?? '').trim();
    return text || null;
  }

  function wordDetails(item = {}) {
    const rawMeanings = Array.isArray(item.meanings) ? item.meanings : [item.tr];
    const meanings = rawMeanings.map(metadataText).filter(Boolean);
    const rawExamples = Array.isArray(item.examples)
      ? item.examples
      : (metadataText(item.ex) ? [{ text: item.ex }] : []);
    const examples = rawExamples.map((example) => {
      if (typeof example === 'string') return { text: metadataText(example), translation: null };
      return {
        text: metadataText(example?.text ?? example?.example),
        translation: metadataText(example?.translation ?? example?.tr ?? example?.ru),
      };
    }).filter((example) => example.text);
    return {
      word: metadataText(item.w) || '',
      pronunciation: metadataText(item.ipa ?? item.pronunciation),
      partOfSpeech: metadataText(item.pos ?? item.p),
      level: metadataText(item.level ?? item.cefr),
      meanings,
      examples,
      source: metadataText(item.source ?? item.sourceTitle),
    };
  }

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
    newWordBudgets,
    normalizeNewWordBudget,
    estimateSessionMinutes,
    buildLibraryEntries,
    filterLibraryEntries,
    wordDetails,
    baseForm,
    modeFor,
    calculateStats,
    buildDailyQueue,
    migrateLegacy,
    distractors,
    mergeGenerated,
  });
})(window);
