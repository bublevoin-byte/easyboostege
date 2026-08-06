import { z } from 'zod';

import { normalizeVocabularyWord, personalVocabularyCardId } from '../public/vocabulary-domain.js';

const timestamp = z.number().int().min(0).max(8_640_000_000_000);
const optionalText = (maximum) => z.string().trim().min(1).max(maximum).nullable();
const context = z.object({
  text: z.string().trim().min(1).max(600),
  source: z.literal('reading'),
  readingProvenance: z.enum(['canonical', 'technical']).optional(),
  readingSetId: z.string().trim().min(4).max(140).optional(),
  readingSetRevision: z.number().int().min(1).max(10_000).optional(),
  readingKind: z.enum(['task10', 'task11', 'task12_18']).optional(),
  position: z.string().trim().min(1).max(20).optional(),
  questionId: z.string().trim().min(4).max(180).optional(),
}).strict().superRefine((value, issue) => {
  if (value.readingProvenance !== 'canonical') return;
  if (!value.readingSetId || !value.readingSetRevision || !value.readingKind || !value.position) {
    issue.addIssue({ code: 'custom', message: 'canonical Reading context references are incomplete' });
  }
  if (!value.readingSetId?.startsWith(`reading-pilot-v1.${value.readingKind}.`)) {
    issue.addIssue({ code: 'custom', path: ['readingSetId'], message: 'canonical Reading set id is invalid' });
  }
});

const personalVocabularyCard = z.object({
  cardVersion: z.literal(1),
  id: z.string().min(10).max(140),
  canonicalWord: z.string().trim().min(1).max(120),
  word: z.string().trim().min(1).max(120),
  provenance: z.literal('personal'),
  meanings: z.array(z.string().trim().min(1).max(240)).max(8),
  pronunciation: optionalText(120),
  partOfSpeech: z.enum(['n', 'v', 'adj', 'adv', 'ph', 'id']).nullable(),
  level: optionalText(24),
  contexts: z.array(context).min(1).max(8),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((value, issue) => {
  if (value.canonicalWord !== value.word
    || value.word !== normalizeVocabularyWord(value.word)
    || value.id !== personalVocabularyCardId(value.word)) {
    issue.addIssue({ code: 'custom', message: 'personal word identity is not canonical', path: ['id'] });
  }
  if (value.createdAt > value.updatedAt) {
    issue.addIssue({ code: 'custom', message: 'personal word timestamps are out of order', path: ['updatedAt'] });
  }
  const contexts = new Set(value.contexts.map((item) => item.text.toLocaleLowerCase('en')));
  if (contexts.size !== value.contexts.length) {
    issue.addIssue({ code: 'custom', message: 'duplicate personal word context', path: ['contexts'] });
  }
});

export const personalVocabularyCardsSchema = z.array(personalVocabularyCard).max(500)
  .superRefine((cards, issue) => {
    const ids = new Set();
    cards.forEach((card, index) => {
      if (ids.has(card.id)) issue.addIssue({
        code: 'custom', message: 'duplicate personal word', path: [index, 'id'],
      });
      ids.add(card.id);
    });
  });

const personalVocabularyTombstone = z.string().trim().min(10).max(140)
  .superRefine((value, issue) => {
    const word = value.startsWith('personal:') ? value.slice('personal:'.length) : '';
    if (!word || value !== personalVocabularyCardId(word)) {
      issue.addIssue({ code: 'custom', message: 'personal word tombstone is not canonical' });
    }
  });

export const personalVocabularyTombstonesSchema = z.array(personalVocabularyTombstone).max(500)
  .superRefine((tombstones, issue) => {
    if (new Set(tombstones).size !== tombstones.length) {
      issue.addIssue({ code: 'custom', message: 'duplicate personal word tombstone' });
    }
  });
