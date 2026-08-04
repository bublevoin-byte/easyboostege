import {
  mergeLegacyVocabularyProgress,
  migrateVocabularyProgress,
} from '../public/vocabulary-domain.js';

function timestamp(value) {
  if (value == null || value === '') return null;
  const instant = value instanceof Date ? value.getTime() : Number(value);
  return Number.isSafeInteger(instant) && instant >= 0 ? instant : null;
}

export function wordProgressApiDto(input) {
  return migrateVocabularyProgress(input);
}

export function wordProgressPersistenceCandidate(existing, input) {
  const legacyInput = input?.legacyInput === true
    || Number(input?.masteryVersion ?? input?.mastery_version) !== 1;
  return legacyInput && existing
    ? mergeLegacyVocabularyProgress(existing, input)
    : migrateVocabularyProgress(input);
}

export function wordProgressStorageDto(input, updatedAt = input?.updated_at ?? input?.updatedAt ?? null) {
  const progress = migrateVocabularyProgress(input);
  return {
    word: progress.word,
    stage: progress.stage,
    error_count: progress.errorCount,
    review_count: progress.reviewCount,
    due_at: progress.dueAt,
    updated_at: timestamp(updatedAt),
    mastery_version: progress.masteryVersion,
    dimensions: structuredClone(progress.dimensions),
    last_mode: progress.lastMode,
    last_outcome: progress.lastOutcome,
  };
}

export function wordProgressExportDto(input) {
  return wordProgressStorageDto(input);
}

export function migrateFileWordProgress(progressByUser) {
  let changed = false;
  const migratedByUser = {};
  for (const [username, words] of Object.entries(progressByUser || {})) {
    const migratedWords = {};
    for (const [key, row] of Object.entries(words && typeof words === 'object' ? words : {})) {
      const migrated = wordProgressStorageDto(row);
      if (key !== migrated.word || JSON.stringify(row) !== JSON.stringify(migrated)) changed = true;
      const existing = migratedWords[migrated.word];
      if (!existing || Number(existing.updated_at || 0) <= Number(migrated.updated_at || 0)) {
        migratedWords[migrated.word] = migrated;
      }
    }
    if (Object.keys(migratedWords).length !== Object.keys(words || {}).length) changed = true;
    migratedByUser[username] = migratedWords;
  }
  return { changed, wordProgress: migratedByUser };
}
