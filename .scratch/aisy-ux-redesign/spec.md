# Aisy.space — learner UX redesign

Status: approved
Owner: product owner
Mode: `/autopilot semi`
Implementation scope: learner experience first

## 1. Outcome

Replace the current feature-led Easy Boost shell with a coherent mobile-first learner experience under
the platform brand **Aisy.space** (Russian pronunciation: «Эйси») and the product name
**Aisy ЕГЭ — Английский**.

The redesign must answer three questions on every top-level screen:

1. What should I do now?
2. Why is this the right activity for me?
3. What happens when I finish it?

Existing vocabulary, grammar, reading, listening, writing, speaking, adaptive-learning and full EGE
engines stay authoritative. This feature changes their entry points, hierarchy, language and interaction
shell; it must not reimplement their domain logic.

## 2. Learner and context

- Primary learner: grade 10–11, preparing for English EGE.
- Starting level: A0/A1 through C1; the product chooses a different route rather than hiding the product
  from weak or strong learners.
- Main device: phone.
- Typical study window: 20–40 minutes per day; the learner may choose 10, 20, 30 or 40 minutes for a
  particular session.
- Usage: independently or together with a teacher.
- Payer: usually a parent.
- The experience must remain usable at 320 px, at 1440 px, with keyboard, screen reader and reduced
  motion, and after an offline reload wherever the existing product already promises offline use.

## 3. Product architecture

### 3.1 Brand hierarchy

- Platform/wordmark: `Aisy.space`.
- Public Russian pronunciation: «Эйси».
- Current product: `Aisy ЕГЭ — Английский`.
- Voice assistant: `Ася`.
- Internal compatibility identifiers (`EasyBoost*`, database fields, storage keys, headers and API paths)
  are not renamed in this feature. They are technical contracts, not public brand copy.

### 3.2 Roles

The information architecture reserves three roles, but this release implements the learner only.

- Learner: owns study data, confirms and revokes future connections.
- Parent (future release): sees study time, regularity, general progress/results and subscription; never
  raw answers, audio or private Asya dialogue.
- Teacher (future release): sees skill statistics, errors, recent tests/mocks and can assign work;
  recordings/private dialogue require explicit learner consent.

No fake or disabled parent/teacher dashboard is shown in the learner UI. The later roles receive separate
specification, authorization and storage tickets.

### 3.3 Commercial language

- Public plans: **Free** and **Premium** only.
- The existing internal `base` tier may remain for storage/API compatibility, but public copy must not
  present Base as a third purchasable plan.
- This redesign does not choose or integrate a payment provider and does not collect payment details.

## 4. Information architecture

The authenticated learner shell has exactly five top-level destinations:

1. **Сегодня** — the recommended daily route and the single primary CTA.
2. **Практика** — deliberate extra work by skill.
3. **ЕГЭ** — section training, full mock, continuation, result and history.
4. **Прогресс** — evidence, weak skills, plan progress and recent EGE result.
5. **Профиль** — study preferences, privacy, subscription and account actions.

`Ася` is contextual and is not a sixth navigation tab. Deep learning screens preserve predictable back
navigation to the hub that opened them. The bottom navigation appears on top-level destinations and has
no more than five items.

## 5. Core learner journeys

### 5.1 First meaningful start

1. Show Aisy.space and the product name, not a catalogue of features.
2. Explain the value in one sentence: a personal daily route to English EGE.
3. Collect only information already supported safely by the product: preferred session time and learning
   goal. Do not invent server-persisted profile fields.
4. Offer a resumable 10–15 minute diagnostic as the recommended action, with an explicit “skip for now”.
5. When skipped, mark the plan as provisional and explain that it will improve from completed work.

### 5.2 Today

- Greeting and date/context.
- One current plan card with duration control (10/20/30/40 minutes), estimated completion and a single
  CTA: start/continue.
- Compact reason: which evidence or provisional assumption selected the activity.
- Small weekly rhythm and EGE countdown, not a dashboard of every module.
- Secondary actions: change duration, open practice, run/continue the diagnostic.
- Loading, empty, offline, expired-access and error states are explicit and recoverable.

### 5.3 Practice

- Skills are grouped by EGE meaning: vocabulary, grammar, reading, listening, writing, speaking.
- Each row shows one honest state (recommended, continue, review, available) and one action.
- No emoji as structural icons; use a consistent SVG stroke family.
- Opening a skill uses the existing module route and does not reset active work.

### 5.4 EGE

- Separate hub from the running mock interface.
- Primary actions: continue an active attempt, start full mock, open latest result.
- Section practice links to the existing grammar/listening/reading/writing/speaking flows.
- Explain strict timing and offline/recovery behavior before start.
- A running mock keeps its current server-authoritative state machine and does not expose answer help.

### 5.5 Progress

- Lead with “what improved / what needs work / what to do next”, not incompatible percentages.
- Clearly distinguish independent evidence from assisted work and approximate AI assessment.
- Preserve existing exact result, history, error-focus and adaptive evidence contracts.
- Do not imply IELTS or official EGE scoring where the current contract says approximate/experimental.

### 5.6 Profile

- Group settings into study, Asya and microphone/privacy, subscription, account/data.
- Show only Free/Premium public terminology while retaining honest capability differences.
- Destructive actions remain separated and confirmed.
- Future linked people are not presented as working functionality.

## 6. Asya interaction contract

### 6.1 Character and visual form

- Mature, calm modern EdTech tone.
- Abstract voice form/wave; no human avatar and no childlike mascot.
- Asya is concise, supportive and specific. It does not shame, overpraise or pretend certainty.

### 6.2 Wake behavior

- Wake name: **«Ася»**. Other names must not intentionally activate the assistant.
- The learner does **not** repeat «Ася» before every sentence. The name starts or resumes one conversation;
  follow-up turns remain active until explicit finish, leaving the context, microphone off or bounded timeout.
- In a browser/PWA this is not an operating-system-wide wake word. It only works while the Aisy app is open
  and the learner has deliberately enabled the microphone session.
- The interface always shows microphone/listening state and provides button/keyboard alternatives.
- A future local wake-word detector may listen before provider streaming. Until that detector exists, the UI
  must not claim background/private wake-word detection and must clearly explain when audio is transmitted.

### 6.3 Pedagogical permissions

- Learning/explanation: examples, explanations, navigation, plan and progress are allowed.
- Practice: hints are allowed, but assisted evidence stays marked assisted and gives no independent mastery.
- Diagnostic/full EGE: no answer help; only technical recovery, timer and navigation.
- Confirmation is required before submit, goal changes, external links, payment and deletion.

## 7. Visual system

Direction: mature modern EdTech with AI-native restraint.

- Keep existing locally available Manrope/Nunito stack to avoid a new font/network cost; use Manrope for
  interface/body and Nunito sparingly for friendly display numbers/headlines.
- Replace feature-specific raw colors with semantic tokens for light and dark themes.
- Initial palette direction: deep indigo/violet primary, quiet lavender surfaces, near-slate text, restrained
  cyan/rose accents; semantic success/warning/danger remain distinct and never rely on color alone.
- Use an 8 px spacing rhythm, 16 px minimum body/input text, 44 px minimum touch targets, consistent 2 px
  outline SVG icons, one primary CTA per screen and controlled elevation.
- Motion is 150–300 ms, uses transform/opacity, conveys state and respects `prefers-reduced-motion`.
- Desktop uses a bounded reading canvas; it must not stretch mobile cards edge to edge.
- Support light and dark modes from shared tokens, not per-screen inversion.

## 8. Technical strategy

- Stay on the accepted native ES-module + Vite architecture. React remains a later ADR direction and is not
  introduced during this redesign.
- Add a small shared learner-shell module and lazy top-level hub modules instead of growing `app.js` or
  the monolithic inline markup.
- Keep legacy screen IDs and domain entry functions as adapters where they are tested contracts.
- Add new public modules to the service-worker closure intentionally and keep the EGE executable boundary lazy.
- Public brand copy changes do not rename API headers, local-storage/database keys or provenance values.
- No server/storage/migration changes are expected for the learner-first UX. If a ticket discovers one, it
  stops at a fresh explicit Docker approval boundary before live PostgreSQL tests.

## 9. Performance and quality budgets

- Do not worsen the current first-load gzip baseline while migrating the shell.
- By final release, bring initial JavaScript to **150 KB gzip or less**, or document a separately approved
  blocker with a measured route-splitting plan; loading EGE lazily alone is not enough.
- LCP <= 2.5 s, CLS <= 0.1, INP <= 200 ms on the existing local performance contour.
- No horizontal overflow at 320/375/768/1440 px.
- All top-level controls >= 44 x 44 px.
- Full keyboard route and visible focus.
- Screen-reader headings, selected navigation state and live async state are meaningful.
- Existing unit, E2E, offline, EGE, adaptive, privacy and security contracts stay green.

## 10. Delivery slices

1. Brand/design tokens and public identity.
2. Five-destination learner shell and route-safe hubs.
3. Today and first-start/diagnostic route.
4. Practice hub.
5. EGE hub.
6. Progress/profile information hierarchy and two-plan language.
7. Contextual Asya conversation shell and honest wake/microphone states.
8. Accessibility, dark/offline/responsive and first-load performance hardening.
9. End-to-end learner release contour and operating documentation.

Each slice is one local ticket, one fresh implementation context and one commit. Tickets touching the same
shell files run sequentially.

## 11. Acceptance criteria

- [ ] All authenticated top-level navigation exposes exactly Сегодня / Практика / ЕГЭ / Прогресс / Профиль.
- [ ] Home opens a usable daily route in <= 2 decisions; it no longer starts with the six-module grid.
- [ ] Practice and EGE are distinct hubs and preserve existing deep flows.
- [ ] Public surfaces consistently say Aisy.space / Aisy ЕГЭ — Английский / Ася.
- [ ] Public subscription copy exposes Free and Premium only.
- [ ] Asya states accurately disclose listening/transmission and never claim OS-wide wake behavior.
- [ ] Diagnostic and full EGE receive no answer assistance.
- [ ] The learner experience is usable at 320–1440 px, keyboard, reduced motion, light/dark and offline states.
- [ ] Initial JavaScript meets the 150 KB gzip budget or stops for an explicit product decision rather than
      silently accepting the inherited breach.
- [ ] `npm test`, `npm run lint`, `npm run check`, `npm run build:frontend`, relevant Chromium contours,
      security scans and diff-check pass.
- [ ] Fresh independent Standards and Spec reviews return no actionable findings before closeout.

## 12. Explicit non-goals

- Parent or teacher accounts, permissions, dashboards and invitation storage.
- Payment-provider integration, VK ID implementation or new secrets.
- Global/background wake word outside the open Aisy app.
- A new speech provider or paid provider calls during tests.
- React migration or wholesale rewrite of domain modules.
- New EGE content/forms (the existing Ticket 99 remains the content-bank follow-up).
- Push, deploy or production configuration changes without separate owner approval.
