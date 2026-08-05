# Active Vocabulary System — Specification

Status: done
Date: 2026-08-04
Base branch: `feature/adaptive-learning-plan`

## Problem Statement

The current Words screen is a useful offline flashcard loop, but it is not yet a complete vocabulary-learning system. Learners are dropped directly into a queue, cannot browse every word they have started, cannot see why a word is due, and receive one coarse learned count instead of an honest picture of receptive, productive, contextual and listening knowledge. Personal words added from Reading are not normalized or managed as a real library. Ordinary vocabulary work also provides little structured evidence to the adaptive learning plan.

The learner needs one dependable place to discover, practise, review and inspect EGE vocabulary without paid AI calls. The system must reward delayed retrieval rather than guessing, preserve existing progress, work offline, and communicate uncertainty without fake precision.

## Solution

Replace the direct-to-card Words entry with an Active Vocabulary home that explains today's work and opens a permanent vocabulary library. A versioned mastery model chooses a suitable exercise for each word, prioritises due and weak words, limits new material, records separate learning dimensions and produces an honest session summary. Core EGE vocabulary remains available to Base learners offline; Premium adds Voice Tutor and deeper adaptive reporting, not the ability to learn effectively.

The normal flow is deterministic and does not require an LLM. Russian free-recall uses reveal-and-self-rating because synonyms cannot be graded reliably from one stored string. Objective evidence comes from English spelling, contextual completion and listening tasks. Existing SRS records migrate conservatively and are recalibrated by future retrievals.

## User Stories

1. As a learner, I want to see how many reviews and new words are proposed today, so that I understand the session before starting.
2. As a learner, I want an estimated session duration, so that I can decide whether to start now.
3. As a learner, I want 10 new words proposed by default, so that review debt does not become overwhelming.
4. As a learner, I want to choose 5, 10, 15 or 20 new words, so that the daily load matches my capacity.
5. As a learner with overdue work, I want the system to reduce new material automatically, so that old knowledge is protected first.
6. As a learner, I want to browse every core word and every word I have started, so that nothing disappears before the final SRS stage.
7. As a learner, I want search, theme and mastery filters, so that I can find a useful subset quickly.
8. As a learner, I want words grouped by broad EGE themes and reusable tags, so that one word may appear in every relevant context.
9. As a learner, I want clear states New, Learning, Review and Strong, so that I do not have to interpret fake exact percentages.
10. As a learner, I want a detailed card with pronunciation, part of speech, level, meanings and contextual examples, so that I learn usage rather than an isolated translation.
11. As a learner, I want example translations hidden until requested, so that I first try to understand the English.
12. As a learner, I want to hear the headword and each example, so that sound is part of the memory trace.
13. As a learner, I want to open a word without increasing mastery, so that browsing cannot falsify progress.
14. As a learner, I want the session to introduce an unfamiliar word before testing it, so that the first encounter is instruction rather than punishment.
15. As a learner, I want recognition used only as an early step, so that repeated guessing cannot produce strong mastery.
16. As a learner, I want to recall and type English from a Russian cue or English context, so that I build productive vocabulary for EGE writing and speaking.
17. As a learner, I want a listening task once a word is ready for it, so that written recognition is not confused with listening knowledge.
18. As a learner, I want to type a Russian meaning and then self-rate against accepted meanings, so that valid synonyms are not falsely rejected.
19. As a learner, I want a visible Not known action, so that I can reveal instruction without inventing an answer.
20. As a learner, I want a failed word to return after intervening items rather than immediately, so that the recheck measures more than echo memory.
21. As a learner, I want hard words to return more often and strong words less often, so that time follows need.
22. As a learner, I want minor English typos distinguished from total ignorance where safe, so that feedback is proportional.
23. As a learner, I want the answer state to show the correct form, pronunciation and context, so that every error becomes instruction.
24. As a learner, I want a compact correct-answer state and an optional detailed view, so that confident reviews remain fast.
25. As a learner, I want an end-of-session summary separating unique words, attempts, new introductions, reviews, independent successes, hints and errors, so that the report is honest.
26. As a learner, I want an immediate list of difficult words with a practise action, so that the next useful step is obvious.
27. As a learner, I want a simple 7/30-day trend, so that I can see whether independent recall is improving.
28. As a learner, I want a word from Reading to keep its sentence and real part of speech where known, so that my personal library is useful.
29. As a learner, I want Mark as known in Reading to affect vocabulary state consistently, so that screens do not contradict one another.
30. As a learner, I want core verified vocabulary separated from personal or generated words, so that EGE coverage is not inflated by unreviewed content.
31. As a Base subscriber, I want the full deterministic vocabulary system, so that effective learning is not a Premium-only mechanic.
32. As a Premium subscriber, I want Voice Tutor after a meaningful error and deeper adaptive reporting, so that paid AI adds explanation rather than basic access.
33. As a returning learner, I want old SRS progress retained as preliminary evidence, so that an upgrade does not reset months of work.
34. As an adaptive-plan learner, I want ordinary vocabulary sessions to produce bounded evidence by exercise mode, so that my plan reacts to real practice.
35. As an offline learner, I want the core library, queue, grading and summary to continue working, so that study does not depend on xAI or network availability.
36. As a keyboard or screen-reader user, I want every filter, card, answer state and dynamic result to be operable and announced, so that the module is accessible.

## Implementation Decisions

- The frontend remains in the current frameworkless ES-module/Vite architecture. React migration is not part of this feature.
- A single deterministic vocabulary domain module owns normalization, migration, mastery dimensions, state labels, queue composition, answer outcomes, delayed same-session relearning and summary calculations.
- Mastery is multidimensional: meaning, spelling, context and listening. The list shows a derived state; the detail screen may show rounded dimension values but does not imply calibrated psychometric precision.
- Existing stage/error/review/due records migrate to preliminary multidimensional records. Migration is idempotent and never upgrades old client data to trusted independent mastery.
- The default new-word budget is 10 with learner choices 5/10/15/20. Due debt can reduce the effective new count but never discard due work.
- The exercise ladder is introduction, receptive meaning, Russian reveal/self-rating, English production, contextual production and listening. Recognition alone cannot produce Strong.
- Russian free text is never judged by exact equality as authoritative evidence. The learner sees accepted meanings and chooses Knew, Almost or Did not know. This result is stored as self-reported/weak evidence.
- Objective English grading normalizes case, whitespace and optional leading `to`; a bounded near-typo outcome is feedback, not automatically a full independent success.
- Failed or Not known words are reinserted after a minimum number of intervening items and with a per-session cap. Long-term due time is still updated separately.
- The visible topic system uses broad stable topic IDs and multiple tags. The first release maps the existing ten core groups into a broader EGE-oriented taxonomy without claiming official exhaustive coverage.
- Core verified cards and personal/generated cards have explicit provenance. Generated content is not silently promoted to core and does not increase verified EGE coverage.
- Detailed cards support missing enrichment explicitly; no IPA, CEFR level, translation or source is fabricated. Core content enrichment is schema-validated and can be extended without changing learner progress identity.
- Audio uses the existing TTS path with the browser speech fallback. Opening a card or playing audio does not change mastery.
- The Words home has one primary Start action, a compact today summary, library entry, topic overview and one accessible trend. Detailed analytics remain secondary.
- Ordinary completed vocabulary sessions record one bounded module attempt with per-mode summary metadata. Adaptive-session launches continue to consume their exact execution claim; ordinary work remains client-reported evidence and cannot claim unseen/timed/retention quality.
- Base receives the complete offline vocabulary system. Premium gates only live Voice Tutor, deep reports and already-existing premium adaptive depth.
- All public API changes remain under `/api/v1/`, use strict validation, owner isolation, bounded batches, export/delete parity and file/PostgreSQL parity.
- No paid provider call, deploy, push or production mutation is part of implementation.

## Testing Decisions

The agreed public seams are:

1. the deterministic vocabulary domain API for a worked legacy migration, dimension update, due ordering and delayed relearning example;
2. authenticated `/api/v1/word-progress` and `/api/v1/module-attempts` behaviour for richer progress, owner isolation and backward compatibility;
3. browser behaviour from Words home through library/card, an offline-capable mixed session and its final summary;
4. adaptive activity completion through the existing module-attempt/session boundary.

Tests assert external behaviour rather than private helper calls. Every vertical slice follows red → green at the highest available seam. Existing tests are not deleted or weakened. File/PostgreSQL persistence, account export/deletion, keyboard access, 375px layout and reduced motion receive explicit coverage. External TTS/AI is faked or blocked in automated runs.

## Out of Scope

- Official IELTS or CEFR certification claims.
- A calibrated FSRS/IRT claim before real outcome data exists; the initial scheduler is transparent and rule-based.
- Automatic authoritative grading of arbitrary Russian synonyms by an LLM.
- Unlimited autonomous curriculum generation or silent promotion of generated cards to verified EGE content.
- Full React migration.
- Teacher, parent, classroom or social leaderboard features.
- Push notifications, deploy, push, merge, paid calls or production rollout.

## Further Notes

- UI work follows the existing Easy Boost visual language rather than replacing it with a new generic design system. The review priorities are mobile-first information hierarchy, visible progress, 44px touch targets, non-colour-only states, keyboard focus, live-region feedback and reduced motion.
- A chart is useful only after at least four time points. Before that the home shows stat cards and an explanatory empty state.
- Content provenance and learner mastery are separate domains: changing examples or metadata must not reset the word's stable identity.
