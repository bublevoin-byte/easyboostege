# Production pronunciation assessment operations

The feature is an optional, paid, server-only Azure Speech dependency. It fails closed: local recording and playback remain available, while provider assessment reports `provider_not_configured`, `sdk_not_installed`, or `provider_unavailable` without reserving quota.

## Exact environment contract

| Name | Purpose | Default / bound |
|---|---|---|
| `SPEAKING_PRONUNCIATION_ENABLED` | Cost and incident kill switch | `false` |
| `AZURE_SPEECH_KEY` | Server-only Azure Speech subscription key | blank; never return or log |
| `AZURE_SPEECH_REGION` | Azure Speech resource region | blank |
| `SPEAKING_PRONUNCIATION_TIMEOUT_MS` | Continuous recognition timeout | `30000`; 1000–120000 |
| `SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES` | Raw request ceiling | `10485760`; 1024–52428800 |
| `SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS` | Per-assessment reservation ceiling | `180`; 1–180 |

The production adapter dynamically imports the official `microsoft-cognitiveservices-speech-sdk` package. This ticket deliberately does not install the SDK, create an Azure resource, place values in env files, or make a paid call. The owner must install and pin the package only after dependency/security review.

The verified Node input seam is `AudioConfig.fromWavFileInput(Buffer)`. Assessment accepts only a structurally validated RIFF/WAVE container with one PCM16 mono 16 kHz `fmt ` chunk and one bounded `data` chunk. Browser `MediaRecorder` output is decoded locally with `AudioContext`, downmixed, resampled and encoded as PCM16 mono 16 kHz WAV before the learner explicitly requests assessment. WebM, MP4, MP3 and Ogg are still rejected by the server before reservation; there is no server-side transcoder. Never write encoded bytes to the SDK's default push stream: its default format is 16 kHz, 16-bit mono PCM, not an encoded-container decoder.

For continuous scripted task-1 recognition, the adapter sets automatic `EnableMiscue` to `false`, aligns the bounded recognized word sequence against the server-owned reference after all segments, and derives whole-recording accuracy, fluency, completeness, prosody and overall score from the complete bounded alignment using the official Microsoft Node sample rules. Tasks 2–4 use unscripted assessment; task 2 and 3 upload one bounded recording per position and task 4 uploads the complete monologue. The adapter never averages phrase-level full-text scores. The public word-detail list remains capped independently; `word_details_truncated` and `status=partial` report when scoring used additional aligned words that are not returned. In that case `isFinal=true` means the bounded result is settled and no later continuation will arrive; provider interruption instead returns `status=partial, isFinal=false`.

Every official assessment reservation also stores a bounded `context_id` derived by the server as
`taskN:<session UUID>:<catalog task id>@<task revision>`; tasks 2 and 3 append `:itemN`. It is included in the request fingerprint.
The combined Speaking score accepts only the same owner's finalized `status=success,isFinal=true`
assessment with an exact context match. A standalone settled `partial` result can still be shown as
provider feedback, but it is deliberately not promoted to an exact 1/0 FIPI-combiner input.
The provider does not prove whether a mispronunciation is meaning-changing. The task-1 combined
scorer therefore uses an explicitly approximate deterministic proxy: omission/insertion is gross,
mispronunciation with `accuracyScore < 50` is gross, and a missing accuracy score produces
`needs_retry` instead of inventing criticality. Product copy must keep the result labelled as an
automatic approximate training score until the external calibration gate is passed.

## Quota and settlement

- Base: 3,600 provider seconds per UTC calendar month.
- Premium (active `voice_tutor` entitlement): 14,400 seconds per UTC calendar month.
- Local record/playback: zero provider seconds.
- The server derives duration from trusted PCM data bytes, checks the informational header against that fact and `min(server-owned task bound, SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS)`, then atomically reserves `ceil(derived duration)` and persists `dispatching` before entering provider code. The SDK start callback advances that row to `started`. Concurrent requests cannot exceed the current tier limit.
- A successful settlement bills the derived duration of audio actually handed to Azure. If a timeout/provider error follows start, settlement conservatively bills the reservation. Failure before start releases it.
- Every nonterminal row has a five-minute server lease, which is longer than the maximum provider timeout plus SDK cleanup. The next quota read, exact replay, or reservation reconciles an expired `reserved` row to a canonical zero-bill release and an expired `dispatching` or `started` row to a canonical conservative full-reservation settlement. `dispatch_started_at` starts its own lease and does not alter the meaning of nullable `provider_started_at`. This recovers safely after process termination without leaving monthly quota held indefinitely or underbilling an indeterminate paid dispatch.
- If the provider exits while its already-attempted durable start claim is still indeterminate, the request returns bounded `processing/assessment_in_progress` with the `dispatching` reservation held instead of issuing a duplicate database start. The original claim may still advance it to `started`; otherwise the five-minute dispatch lease settles it conservatively on the next owner operation.
- `(username, Idempotency-Key)` identifies one exact, owner/session-bound request. Replay returns the canonical settlement; a different request with the same key is a conflict.

## Safe rollout and paid manual gate

1. Keep `SPEAKING_PRONUNCIATION_ENABLED=false` in production and staging.
2. Re-check the current price and regional availability in the chosen Azure region. Configure a separate staging Speech resource, budget alert, and hard Azure spending cap.
3. Pin and install the official SDK. Run the full offline suite; it uses injected fakes and must make no network call.
4. Put staging key/region only in the secret store. Never paste values into issues, commands, screenshots, fixtures, or logs.
5. Set the staging switch to `true`. Verify status is available, then make owner-approved paid `en-GB` and `en-US` smokes covering scripted task 1 and unscripted task 2/3/4 bindings. Confirm one ledger row per intentional recording, correct seconds/context, no audio/provider payload in application logs, and no second charge on exact replay.
6. Exercise timeout with a fake/injected provider, not by intentionally burning a paid request. Verify the documented conservative settlement.
7. The product owner must explicitly approve cost, privacy copy, and rollout before production enablement. Enabling the flag is not itself that approval.

## Incident response

Set `SPEAKING_PRONUNCIATION_ENABLED=false` and restart/redeploy. This immediately makes assessment unavailable while preserving local recording. Do not delete ledger rows: they are the billing audit and user export source. Investigate only bounded status codes, route HTTP metrics, and the `speaking_pronunciation` dependency aggregate. Rotate the Azure key if disclosure is suspected.

Application logs allow only provider event, locale, segment count, and bounded error code. They must never contain subscription keys, raw audio, transcript/reference text, idempotency values, or full Azure JSON. Raw audio exists only in request/process memory and is not persisted.

Official references: [Pronunciation Assessment](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment), [SpeechRecognizer JavaScript API](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechrecognizer?view=azure-node-latest), [AudioConfig JavaScript API](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/audioconfig?view=azure-node-latest), [AudioInputStream JavaScript API](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/audioinputstream?view=azure-node-latest), [language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=pronunciation-assessment), and [Speech data privacy](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security).
