# Speaking 2.0 release evidence

Status: local release candidate; no push or deploy

Date: 2026-08-08
Branch: `feature/speaking-2-pilot`
Audit base: `8e977a9`
Ticket-10 start: `1ff7cdc`

## Automated evidence

All automated assessment tests use injected fakes. No provider or paid call was made.

| Gate | Result |
|---|---|
| `npm.cmd run lint` | PASS |
| `npm.cmd run check` | PASS: 351 JavaScript files; 204 inline handlers (20 markup, 184 runtime); 122 handler names |
| `npm.cmd run build:frontend` | PASS: 482 assets; 378.5 KB shell JavaScript; 9 lazy chunks |
| `npm.cmd test` | PASS: 1,270 tests; 1,229 passed; 41 expected PostgreSQL skips; 0 failed |
| `npm.cmd run test:postgres` | PASS on clean disposable PostgreSQL 17: migrations 001–052; 41 passed; 0 failed; 0 skipped; disposable container, network and volume removed |
| `npm.cmd run test:e2e` | PASS: desktop critical flows and full Speaking at 375 px and 1,440 px; explicit fake-only PCM16 upload/evaluation; task-4 responsive/reduced-motion coverage at 375, 768, 1,024 and 1,440 px |
| `npm.cmd run test:e2e:performance` | PASS: LCP 288 ms / 2,500 ms; CLS 0.000 / 0.1; INP 96 ms / 200 ms; initial JS 116.3 KB / 150 KB; AI status 34 ms; plan 94 ms; preview 34 ms |
| `npm.cmd run security:secrets` | PASS: 1,089 tracked files |
| untracked secret-pattern scan | PASS: 5 ticket-10 files |
| `npm.cmd run security:history` | PASS: 299 commits |
| `git diff --check` | PASS |
| Speaking feature-diff audio scan | PASS: no WAV, WebM, Ogg, MP3, M4A, AAC or FLAC file was added or changed since audit base `8e977a9` (the pre-existing static Listening corpus is out of scope) |

Ticket-10 targeted RED/GREEN evidence covers the persisted approximate 0–20 full-section result, exact owner/session/task/catalog binding, cross-owner refusal, all-skipped/technical zero-provider aggregation, file/PostgreSQL repository parity, post-submit-only pronunciation upload, idempotent paid-request keys, client-local recording custody, lifecycle-owned calibration retention, computed 4.5:1 primary-action contrast, OpenAPI paths, mobile/desktop browser behavior and honest privacy/cost copy.

## Storage, security and commercial assertions

- Ordinary recordings exist only in browser/process memory and are not written to file or PostgreSQL storage. The voluntary calibration path remains the sole separately consented raw-audio retention path.
- Full-section assessment is locked until all 11 positions have been submitted. A bounded SHA-256 fingerprint fixes each completed response to its canonical in-memory PCM16 WAV. Upload atomically rechecks that fingerprint and submitted duration and pins the first assessment idempotency key to the owner, full-session UUID, task/revision, accent and response position; replacement takes and fresh-key substitution fail before provider work.
- The final result is stored as automatic training feedback, explicitly approximate and not methodically validated. A low-quality task produces `needs_retry` and no confident overall score.
- Base and Premium use the existing 3,600- and 14,400-second monthly server ledgers. Recording and local playback remain unlimited; only explicit provider submission consumes seconds.
- Exact assessment and evaluation replays use canonical idempotency records and do not charge or call a provider twice.
- OpenAPI documents the post-submit upload, task evaluation with `sessionMode=full_section`, and the persisted full-section evaluation operation.
- The file and PostgreSQL repositories share the same owner-bound finalization contract. No new migration is needed because migration 045 already stores the canonical `submission_response` JSON document.

## Owner-only manual actions

No package was installed during this ticket. Real credentials must never be placed in this document, an issue, a command transcript, a fixture, a screenshot or an application log.

1. Review the current official release and security advisories for `microsoft-cognitiveservices-speech-sdk`, then pin an owner-approved exact version in a separate dependency change. Re-run every offline gate above after the lockfile change.
2. Create a separate staging Speech resource with its own budget alert and hard spending cap. Do not reuse a production resource or key.
3. Put values only in the staging secret/config system under these existing environment names:
   - `SPEAKING_PRONUNCIATION_ENABLED`
   - `AZURE_SPEECH_KEY`
   - `AZURE_SPEECH_REGION`
   - `SPEAKING_PRONUNCIATION_TIMEOUT_MS`
   - `SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES`
   - `SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS`
4. Keep the switch disabled until the separate test resource and secret injection are confirmed. Then perform an owner-approved paid smoke in staging only, separately from the offline suite:
   - one scripted task-1 assessment and one unscripted task-2/3/4 assessment across the intended `en-GB` and `en-US` coverage;
   - one complete full-section assessment after submit;
   - one exact replay proving no second charge;
   - ledger/context verification and log review proving there is no credential, raw audio, transcript, reference text, idempotency key or full provider payload.
5. Disable the switch after the smoke. Record only bounded outcome, duration and billing/context confirmation. Obtain explicit product-owner approval for cost, privacy copy, methodological status and production rollout before any push, deploy or production enablement.

The Azure SDK install, separate staging resource, secret values, paid smoke, external methodological release gate, push and deploy remain manual owner actions and were not performed here.
