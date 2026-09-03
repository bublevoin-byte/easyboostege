# Aisy ЕГЭ — style lab and design-system approval prototype

Status: ready-for-agent
Owner: product owner
Mode: `/autopilot semi`
Parent context: approved learner UX redesign

## Problem Statement

The product already has a promising phone-first brand opening — logo, onboarding and login — but the
authenticated learner experience still speaks a different visual language and its production UX is spread
across legacy screens, a newer five-destination shell and isolated prototypes. The owner cannot safely approve
a full UI implementation from one decorative Today mockup: there is no shared design system, no like-for-like
comparison of stylistic directions, no representative end-to-end learning contour and no evidence for motion,
component states or small-phone behavior.

The production shell also turns the bottom navigation into a side rail on wide viewports. That behavior is not
appropriate for this portrait-primary PWA and must not appear in the approval prototypes. The approval result
must be a phone interface even when viewed in a desktop browser.

## Solution

Build an isolated, clickable **Aisy Style Lab** that leaves production UI and domain logic untouched. It will
turn the approved logo/onboarding/login into a shared visual foundation, publish a three-layer design system,
and present three comparable art directions on the same realistic learner contour:

`Сегодня → задание ЕГЭ → разбор ответа → прогресс`.

Every direction uses the same content, information architecture, five bottom destinations and semantic states.
Only composition, surface language and signature motion differ:

- **A — Бумажный маршрут:** the closest continuation of the approved onboarding; soft paper layers and route
  markers.
- **B — Тактильные виджеты:** physical pastel instruments inspired by the attached widget reference, translated
  into the Aisy palette and kept outcome-first rather than becoming a dashboard grid.
- **C — Сюжетный маршрут:** vertically staged illustrated journey inspired by the attached story-screen
  reference, with a drawn route and expressive progress landmarks.

A comparison hub, component gallery and motion lab make the directions assessable side by side. The owner
selects one base direction and may borrow at most two specific components or motion mechanics from the other
directions before production implementation begins.

## User Stories

1. As the product owner, I want to open one comparison hub, so that I can evaluate all three directions without hunting through URLs.
2. As the product owner, I want every direction shown inside the same portrait phone canvas, so that viewport differences do not bias the decision.
3. As the product owner, I want the same learner data and copy in A, B and C, so that I compare design rather than content quality.
4. As the product owner, I want to move through Today, an EGE task, answer review and Progress in every direction, so that I can judge a real product contour.
5. As the product owner, I want obvious previous/next and direction-switch controls in the lab, so that comparison takes seconds rather than explanation.
6. As the product owner, I want each direction named by a concrete design idea, so that feedback can refer to a stable vocabulary.
7. As the product owner, I want the approved Aisy logo, warm paper, plum ink and coral action color retained, so that exploration does not discard the brand already approved.
8. As the product owner, I want the approved onboarding and login linked from the lab, so that I can inspect the complete visual story from first launch to learning.
9. As the product owner, I want the login clearly labelled as a visual prototype, so that a VK/Telegram backend decision is not implied by a clickable mock.
10. As a learner, I want Today to tell me what to do now in one glance, so that I can start studying without scanning a module dashboard.
11. As a learner, I want one primary start/continue action on Today, so that competing actions do not slow me down.
12. As a learner, I want to choose 10, 20, 30 or 40 minutes, so that the daily route fits my available time.
13. As a learner, I want to know why a task was selected, so that personalization feels understandable rather than arbitrary.
14. As a learner returning to an unfinished session, I want the same hero to become a continue state, so that I do not accidentally restart work.
15. As a learner, I want an EGE task to show section, task number and current step, so that I understand the exam context.
16. As a learner, I want answer choices to have clear default, selected, submitted, correct and incorrect states, so that feedback is unambiguous.
17. As a keyboard or assistive-technology user, I want every actionable control to expose a visible focus and meaningful accessible name, so that the prototype is operable beyond touch.
18. As a learner, I want submission to be an explicit action, so that selecting an option does not unexpectedly finish the task.
19. As a learner, I want the review to explain both why my answer failed and what rule to reuse, so that the result teaches rather than merely scores.
20. As a learner, I want assisted and independent evidence to be visually distinguishable, so that progress remains honest.
21. As a learner, I want one clear next action after review, so that I can continue the route without returning to a menu.
22. As a learner, I want Progress to lead with improvement, weak point and next step, so that percentages have a useful meaning.
23. As a learner, I want the five destinations Today, Practice, EGE, Progress and Profile to stay in the same order in every direction, so that style changes do not change navigation semantics.
24. As a learner, I want top-level navigation to remain at the bottom even in a desktop browser preview, so that the PWA never becomes a side-oriented product.
25. As a learner on a 360×720 phone, I want primary content and actions to remain usable without horizontal scrolling, so that the design is not limited to a tall showcase device.
26. As a learner with a display cutout or home indicator, I want safe-area spacing around navigation and actions, so that controls are not obstructed.
27. As a motion-sensitive learner, I want a reduced-motion version of every transition, so that the visual language remains usable without route drawing or layered movement.
28. As the product owner, I want a component gallery with buttons, choices, cards, badges, progress, navigation and alerts, so that I can approve reusable elements rather than only composed screens.
29. As the product owner, I want every component shown in relevant interaction states, so that implementation does not invent hover, focus, disabled, loading or error behavior later.
30. As the product owner, I want a motion lab that replays each direction's signature transition, so that animation can be approved deliberately rather than inferred from screenshots.
31. As the product owner, I want one prominent motion effect at a time, so that the product feels authored without becoming restless.
32. As a developer, I want primitive, semantic and component tokens separated, so that a palette adjustment does not require editing every screen.
33. As a developer, I want components to consume semantic/component tokens instead of raw color values, so that the chosen direction can become a maintainable product theme.
34. As a developer, I want the three directions to share semantic fixtures and a small state projector, so that comparison remains consistent as copy changes.
35. As a developer, I want prototype state represented in the URL, so that any exact direction and screen can be reloaded or shared for review.
36. As a reviewer, I want screenshots at 390×844 and 360×720, so that claims about portrait composition can be verified visually.
37. As a reviewer, I want an explicit state gallery for loading, offline, error, diagnostic and resume, so that the design system is not approved only on the happy path.
38. As a reviewer, I want contrast, target size, overflow and reduced-motion checks, so that accessibility requirements are observable before production work.
39. As the product owner, I want a concise selection worksheet, so that I can name one base direction and no more than two borrowed mechanics.
40. As the product owner, I want all work isolated from the production shell, so that a style experiment cannot break existing learners.

## Implementation Decisions

- The style lab is an isolated native HTML/CSS/ES-module prototype served with the existing app. It does not
  introduce React, a new package or a network dependency.
- Production screen markup, router, storage, APIs and service worker are not changed during the approval stage.
- The canonical comparison viewport is 390×844, with a mandatory compact proof at 360×720. Wider viewports
  center the same phone canvas and may show lab controls outside it; the learner UI never reflows into a wide
  dashboard or side rail.
- The shared flow has four screens: Today ready/resume, one adaptive EGE grammar task, answer review and
  Progress next action. A compact state gallery covers first-run/diagnostic, loading, offline, recoverable error
  and resume without duplicating full flows.
- The authenticated information architecture keeps exactly five bottom destinations in this order: Today,
  Practice, EGE, Progress, Profile. Asya remains contextual and is not a sixth tab.
- The public session-duration component uses 10/20/30/40 minutes for this approval contour. Reconciliation with
  the legacy 15–120 minute composer is a later production migration decision.
- The approved splash/onboarding/login remains the brand reference. Its VK action is a visual placeholder and
  is not presented as a completed authentication integration.
- The attached references are sources of mechanics, not skins to copy. Their pale tactile relief and tall story
  staging are translated into Aisy's own warm-paper, plum, coral, peach and goal-orange language.
- Typography uses local Nunito for expressive headings/numerals and Acrom for interface/body copy. System
  fallbacks remain defined; no font is fetched from the network.
- The token source follows primitive → semantic → component layers. Direction themes override semantic and
  selected component tokens; individual components do not hard-code palette values.
- The motion system defines press feedback at 160–220 ms and screen transitions at 320–520 ms. Direction A
  moves soft paper layers, B seats/releases tactile controls, and C draws/advances a route. Reduced motion
  replaces spatial movement with a short opacity change and preserves state communication.
- URL parameters identify direction, screen and fixture state. Browser refresh must preserve the reviewed state.
- The prototype uses a single realistic fixture contract for recommendation, task, submitted answer, evidence
  and next action. It demonstrates semantics but does not persist or mutate production learner data.
- Selection is constrained to one base direction plus at most two named borrowed components or motion mechanics.
  A fourth blended direction is not created before that decision.
- Accessibility minimums are 44×44 px touch targets, visible focus, semantic buttons/radios/navigation,
  non-color-only state cues, meaningful status announcements and no horizontal overflow.

## Testing Decisions

- The primary test seam is the rendered, URL-addressable prototype using shared semantic fixtures. Tests assert
  externally visible behavior: screen transitions, selected/submitted states, reload persistence, navigation
  semantics and reduced-motion behavior. They do not assert private helper functions or CSS implementation.
- Browser tests exercise the complete Today → task → review → Progress contour once per direction and verify that
  all three consume the same fixture values.
- Visual QA captures each core screen at 390×844 and the densest screens at 360×720. The comparison checks canvas
  width, bottom navigation, safe areas, clipping and hierarchy.
- Component QA covers default, pressed/focus, disabled, loading, success and error where applicable.
- Automated static checks scan prototype component rules for raw hex colors outside the primitive token layer and
  flag any learner-shell media rule that introduces a side rail.
- Accessibility QA verifies semantic roles/labels, tab traversal, focus visibility, touch target dimensions,
  contrast and `prefers-reduced-motion` behavior.
- The existing Playwright prototype and screenshot QA patterns are prior art; no paid provider, live learner data,
  production database or authentication call is exercised.
- Each completed design-loop part is judged from rendered output by three independent critics: requirement,
  system and craft. Any failure returns one largest visible gap to the builder before another render.

## Out of Scope

- Replacing the production learner shell or migrating all existing screens.
- Implementing or choosing VK ID, Telegram Login or another authentication backend.
- Changing databases, API contracts, subscription logic, EGE engines or adaptive-learning domain logic.
- Reconciling every legacy duration control beyond the approved 10/20/30/40 prototype choice.
- Parent/teacher experiences, payment, deployment, service-worker rollout and production analytics.
- Dark mode as a competing style direction; the approval set focuses on one coherent light brand system.
- Copying the attached references' brand, icons, characters or colors literally.

## Further Notes

- UX audit confirms that production currently has two parallel startup stories and a non-URL router. These are
  production follow-ups; the prototype uses a canonical demonstrable story without pretending the integration
  is already complete.
- Existing raster onboarding assets are presentation-heavy and oversized. The lab may reuse a small approved
  subset, but production asset optimization/licensing remains a separate hardening task.
- The final approval handoff records the selected base, borrowed mechanics, rejected directions and any unresolved
  production contracts so later implementation does not reopen the entire visual search.

