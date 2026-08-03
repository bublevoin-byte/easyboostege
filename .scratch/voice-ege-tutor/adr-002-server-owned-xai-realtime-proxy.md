# ADR-002: Server-owned xAI Realtime proxy

Status: accepted on 2026-08-03; supersedes ADR-001.

## Context

xAI supports server WebSocket authentication at
`wss://api.x.ai/v1/realtime?model=<versioned-model>` with `Authorization: Bearer <API key>`.
The official realtime schema supports server-owned `session.update`, PCM16 audio, server VAD,
function tools, cancel and truncate events. Its `response.done.response.usage` documents token
counts but no authoritative input/output audio duration. Provider frame/body maxima are not
published. Direct ephemeral browser credentials were unbound bearer tokens and made the browser
responsible for security-relevant prompt/model/tool configuration.

Verified official sources on 2026-08-03:

- https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
- https://docs.x.ai/developers/rest-api-reference/inference/voice
- https://docs.x.ai/voice-realtime.ws.json

The documentation currently conflicts about which version the `latest` alias selects. Production
therefore pins explicit `grok-voice-think-fast-1.0`; alias migration requires a separate review.

## Decision

- The browser connects only to same-origin `/api/v1/voice-tutor/realtime` with a random one-use app
  ticket in a WebSocket subprotocol. The HTTP API stores only its SHA-256 hash.
- A lost session-creation response may rotate ticket and pedagogy nonce exactly once using the
  original Idempotency-Key. Text/local recovery rotates one nonce without another AI call. Ticket
  consume is atomic and rejects replay/expiry. A partial null-delivery capsule is atomically completed
  as zero-billable local delivery rather than retaining an active reservation.
  A provisional voice row with no ticket or activation either rotates its nonce while atomically
  issuing the first ticket, or becomes the same zero-billable local recovery when realtime is unavailable.
  If the single replacement response is also lost, repeating that same-key reissue atomically ends the
  unactivated reservation as zero-bill local delivery and returns one fallback nonce.
  Every ticket expiry is clamped to the reserved session deadline, including recovery in the final TTL window.
- The proxy owns xAI Authorization, URL, immutable model, voice, prompt, PCM16 24 kHz mono JSON
  transport, server VAD and the only allowed function `advance_pedagogy`.
- Raw provider JSON never crosses the proxy: private session/configuration frames are dropped and
  public lifecycle/audio/caption/error events are reconstructed from explicit validated fields.
- Browser microphone access starts only after xAI `session.updated`, repository activation and the
  proxy's `easyboost.ready` event.
- The proxy caps handshake response, frames, JSON/base64 audio, tool output, event rate and total
  audio bytes. It rechecks feature/cost/ZDR switches, current voice consent and Premium entitlement,
  and enforces the reserved-session deadline.
- Remote-IP (resolved with the deployed one-trusted-proxy policy) and authenticated-user upgrade
  budgets use bounded maps of process-local HMAC identities with periodic TTL cleanup. One deadline
  covers slot acquisition through auth/repository/capsule work and repository-backed provider ACK,
  failure or timeout.
- Provider function calls are correlated in bounded server memory. Every voice HTTP transition must
  claim the exact call/event, rotate the nonce successfully and authorize one strict output; only
  text/local delivery permits an uncorrelated transition. Invention and replay fail closed.
- Each provider response may request at most one pedagogy transition. Automatic continuation cannot
  request another transition until server VAD observes a fresh learner turn.
- Authenticated session creation has a separate per-user hourly limit, including zero-bill local
  fallbacks, so durable free reservations cannot be generated without bound.
- Clean confirmed billing is derived from decoded PCM bytes at 48,000 bytes/second and rounded up,
  capped by the reservation. Any abnormal, missing or invalid evidence charges the full reservation.
- Audio, captions and full transcripts are never persisted or logged. Provider/model/prompt and
  bounded usage/finalization evidence are exportable; secrets, ticket/nonce hashes and counters are not.
- Every finalization persistence attempt has a timeout; PostgreSQL statement/lock deadlines terminate
  or destroy the current attempt before a retry, so attempts cannot overlap. Retries are bounded and PII-free. Unsuccessful
  or hung persistence remains unsuccessful for
  settlement and relies on durable consumed/unfinalized state for conservative recovery. Shutdown
  rejects new upgrades first and bounds cleanup of both active and pre-active sockets.
- Primary and bounded finalization PostgreSQL pools handle idle-client failures with fixed PII-free
  code/pool telemetry, rather than allowing an uncaught process error.
- Automated tests use only local fake HTTP/WebSocket providers. Paid and staging calls remain human
  release gates.

## Consequences

Kill switches can terminate active proxy sessions, replay has one atomic recovery path, and copied
browser tickets cannot authorize provider calls after consume. The server becomes an audio processing
boundary and must be capacity-monitored, but it now owns every security-relevant provider frame.
Because xAI does not expose authoritative audio duration, abnormal billing deliberately favors quota
and cost safety over optimistic refunds.
