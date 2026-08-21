# Aisy.space — visual system v2 and Today concept

Status: approved from product conversation
Mode: `/autopilot semi`
Prototype branch: `prototype/aisy-today-visual-v1`

## Problem Statement

The learner UX is now structurally coherent, accessible and fast, but its visual foundation is still the
restrained indigo design created for the first Aisy release. The product owner wants Aisy.space to feel
immediately recognisable, emotionally engaging and visually premium without becoming childish, noisy or
less trustworthy as an exam-preparation product.

The future visual language must be fixed before it is propagated through Progress, Practice, Asya and the
strict EGE runner. Today is the right first surface because it combines the daily recommendation, duration,
reason, outcome, study rhythm and contextual information in one mobile-first screen.

## Solution

Create a candidate **Aisy visual system v2** called **Coral Editorial Intelligence** and an isolated,
throwaway Today concept that demonstrates it in the real product density without changing production Today.

The candidate system uses a three-layer token model (primitive → semantic → component), a warm light canvas,
selective coral energy, editorial typography, soft geometry, original abstract compositions with small soft
3D study objects, and contextual violet reserved for Asya. It defines different colour intensity for emotional,
working and strict-exam surfaces instead of covering every screen in coral.

The Today prototype provides three structurally different variants on one local route, switchable through a
URL parameter and a floating evaluation control:

1. **A — Coral Route:** one expressive coral daily-route hero and a drawn route through the session.
2. **B — Living Canvas:** an editorial warm canvas with asymmetric information and object collage.
3. **C — Progress Pulse:** a data-led daily decision with a prominent weekly rhythm and evidence explanation.

All variants use the same realistic read-only learner state and the same candidate tokens. The prototype is
captured on a dedicated prototype branch. No variant becomes production UI until the owner chooses what to
keep; the winning decisions will later be rewritten into production code and the losing prototype code will
not remain on main.

## User Stories

1. As a learner, I want Today to look recognisably Aisy, so that the product feels memorable rather than generic.
2. As a learner, I want one visually dominant daily action, so that I know what to do without scanning a catalogue.
3. As a learner, I want the coral colour to guide me without filling every surface, so that the app stays energetic but comfortable.
4. As a learner, I want to see why an activity was selected, so that personalisation feels earned rather than arbitrary.
5. As a learner, I want to see what completion will change, so that starting a session has a clear payoff.
6. As a learner, I want duration choices to remain obvious and touch-friendly, so that I can fit study into 10–40 minutes.
7. As a learner, I want a small weekly rhythm visual, so that regularity is visible without fake XP or coins.
8. As a learner, I want contextual English/EGE information, so that Today can teach something even before I start.
9. As a learner, I want charts and indicators to carry labels and explanations, so that colour is never the only meaning.
10. As a learner, I want large progress numbers to be readable as part of the composition, so that evidence feels important.
11. As a learner, I want calm task and EGE surfaces, so that the brand does not compete with concentration.
12. As a learner, I want meaningful motion, so that changes are understandable rather than decorative.
13. As a learner using reduced motion, I want the same information without animated movement, so that the concept remains usable.
14. As a keyboard user, I want every concept control reachable with visible focus, so that visual exploration is not pointer-only.
15. As a mobile learner, I want every control at least 44×44 px, so that the interface is comfortable on a phone.
16. As a mobile learner, I want no horizontal overflow at 320 and 375 px, so that the visual composition never breaks the task.
17. As a desktop learner, I want a bounded composition rather than a stretched phone screen, so that Today still feels intentional at 1440 px.
18. As a learner in dark mode, I want accessible tonal mapping rather than inverted colours, so that the brand stays coherent.
19. As a learner speaking with Asya, I want violet and a dark particle atmosphere to signal a special AI moment, so that Asya feels distinct from ordinary navigation.
20. As a learner, I want abstract editorial forms and small soft 3D study objects, so that the app feels alive without a mascot.
21. As a learner, I do not want stock photographs of students in the daily interface, so that Aisy has its own visual world.
22. As a product owner, I want three genuinely different Today compositions, so that I can choose hierarchy rather than merely choose colours.
23. As a product owner, I want all variants to use identical content, so that the comparison is fair.
24. As a product owner, I want the candidate system written down before implementation spreads, so that later screens inherit one visual language.
25. As a product owner, I want the prototype isolated from production, so that an experiment cannot silently ship.

## Implementation Decisions

- The candidate visual direction is named **Coral Editorial Intelligence**.
- The candidate is recorded separately from the accepted production design contract. It does not claim that
  production has already adopted v2.
- The token system has three layers: raw primitives, semantic roles for light/dark/intensity contexts, and
  component tokens used by the Today concept.
- The starting brand palette is warm canvas, coral primary, deep coral action, near-black ink, Asya violet,
  verified-success teal and semantic warning/danger colours. Exact accessible pairs are validated before use.
- Coral intensity is contextual: expressive surfaces may use roughly 15–25%, working hubs 5–12%, and strict
  EGE surfaces 2–5%. This is a composition guideline, not a pixel-count test.
- Typography combines large editorial headings and display numbers with a calm, readable interface face.
  Existing locally available Manrope/Nunito contracts remain the starting point; the concept adds no external
  font request.
- Cards are mostly flat tonal surfaces with 20–28 px radii. Shadows are rare, soft and systematic.
- Illustration language is a hybrid of abstract editorial composition and small soft 3D objects. No mascot,
  structural emoji or stock learner photography is used.
- An original project-bound raster object may be generated for the prototype. It must contain no text, logo,
  watermark or recognisable copyrighted character.
- Motion follows “fast response + soft continuation”: tap feedback in 150–250 ms, route/chart reveals that
  explain sequence, and a reduced-motion form with the same final information.
- Only one or two elements may animate prominently in a view. Continuous ambient motion is reserved for the
  special Asya moment, which is demonstrated only as a small concept cue in this phase.
- Charts provide direct labels or accessible summaries; independent/assisted/approximate evidence is never
  differentiated by colour alone.
- The Today concept is read-only and uses representative state shaped like the existing Today projection. It
  does not call production mutations, write preferences or fabricate new backend fields.
- The concept is a separate local prototype surface with `?variant=A|B|C`, a clearly non-product switcher and
  keyboard left/right switching. It is not included in the PWA application shell.
- Production Today, Progress, Practice, Asya and EGE screens remain unchanged during this concept phase.
- The prototype is built with the repository's current vanilla HTML/CSS/ES-module stack and no new dependency.

## Testing Decisions

- The candidate token contract is tested at its public CSS/document seam: three layers exist, the agreed roles
  are present, critical foreground/background pairs meet WCAG AA, focus and touch tokens remain explicit, and
  reduced-motion rules are documented.
- The prototype itself follows the prototype exception: it is not unit-tested as production behaviour. It is
  inspected in a real browser with its three URL-stable variants.
- Browser verification covers 320/375/768/1440 widths, light and dark themes, keyboard switching, visible
  focus, 44 px controls, no horizontal overflow, reduced motion and absence of network/provider calls.
- Static verification confirms the prototype is outside the service-worker application shell and does not
  replace the current Today route.
- Existing `npm run lint`, `npm run check`, build and focused production Today contracts remain green because
  the prototype must not weaken the released learner UX.

## Out of Scope

- Selecting the winning Today variant or merging it into production.
- Redesigning production Progress, Practice, Profile or the strict EGE runner.
- Implementing the full dark Asya conversation surface.
- Changing adaptive-learning, storage, authentication, subscription, API or database behaviour.
- Adding a new framework, package, remote font, analytics service or paid/provider call.
- Copying source artwork, layouts or branded assets from the supplied references.
- Deployment, publishing or pushing the prototype branch.

## Further Notes

- Visual references discussed with the owner: Jeton for coral editorial impact; Cosmos for warm gallery canvas;
  Apple for restraint and large flat radii; Dala for a special dark AI moment; the Medical e-Learning kit for
  familiar mobile learning anatomy and small educational objects.
- The direction intentionally combines those principles rather than imitating any single product.
- The UI design search suggested a generic AI-purple system; that palette was rejected in favour of the owner's
  explicit coral decision. Its accessibility, responsive and motion guidance remains applicable.
