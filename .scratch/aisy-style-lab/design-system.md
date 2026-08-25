# Aisy ЕГЭ — design system for style approval

Status: candidate foundation
Scope: portrait learner PWA and isolated approval prototype
Canonical visual source: approved `logo → onboarding → login`

## 1. Design intent

Aisy is a calm personal route through English EGE, not a catalogue of modules and not a generic AI
dashboard. The shared identity is built from warm paper, dark plum editorial ink, one coral action, small
goal-orange landmarks, tactile down-right depth and a route that visibly advances. The three directions test
composition and motion while remaining one brand.

The two attached references contribute mechanics only:

- the widget reference contributes nested physical controls, compact meters and visibly pressable surfaces;
- the story-screen reference contributes a tall staged route, landmarks and a sense of moving through a day;
- neither reference supplies Aisy's palette, characters, icon family or information architecture.

## 2. Token architecture

The executable source is `styles/tokens.css` and follows three layers.

| Layer | Responsibility | Allowed dependencies |
|---|---|---|
| Primitive | Literal color, spacing, type, radius, duration and size values | none |
| Semantic | Product meaning: canvas, surface, text, primary, status, focus, depth and motion | primitive only |
| Component | Hero, card, button, choice, badge, progress, alert and nav contracts | semantic and non-color primitives |

Literal palette values are allowed only in the primitive section. Direction A/B/C changes happen by semantic
aliases, never by scattering color values inside components.

## 3. Shared primitive palette

| Family | Key values | Role |
|---|---|---|
| Paper | `#FFFDF9`, `#FFF9F3`, `#FFF4EC`, `#FFEDE4`, `#FBE8DF` | canvas and nested surfaces |
| Ink/plum | `#35263D`, `#402341`, `#6D365F`, `#8F6B8A` | copy, outline, secondary information |
| Coral | `#B9433A`, `#D94F45`, `#F15C4F`, `#FF7563` | the single primary action and active route |
| Goal orange | `#C56F22`, `#F58B3D`, `#FFC36A` | milestones, not a second CTA |
| Support aqua | `#326B68`, `#72AAA2`, `#DCECE8` | calm informational/support state |
| Status | green, amber and red families with pale surface pairs | explicit success/warning/error |

The darker coral `#D94F45` is the default button surface because warm white text on the previously used
`#FF7563` did not meet normal-text contrast. The lighter coral remains illustration and soft-state material.

## 4. Typography

| Role | Family | Size / leading | Weight | Rules |
|---|---|---|---|---|
| Display title | Aisy Nunito | 32 px / 1.08 | 800 | one per screen, 30–34 px responsive window |
| Emphasis number | Aisy Nunito | 34 px / tight | 800 | score, duration or route landmark only |
| Body/interface | Aisy Acrom | 15–16 px / 1.5 | 500 | sentence case, maximum readable line ≈ 36 chars on phone |
| Label/eyebrow | Aisy Acrom | 12 px / 1.2 | 700 | optional uppercase, tracking 0.09 em |

There are three hierarchy sizes on a composed screen. Captions may use the label role, never a new tiny role.
Controls inherit the interface family. Numerals may use Nunito when they are the visual subject, not in ordinary
copy. No network font request is allowed.

## 5. Spacing, canvas and safe areas

- Base rhythm is 4 px; composed spacing favors 8, 12, 16, 20, 24 and 32 px.
- Learner canvas is `min(100vw, 390px)`. The compact proof is 360×720.
- Phone horizontal padding is 20 px; no learner content crosses it except decorative clipped art.
- Touch targets are at least 44×44 px. Primary button height is 58 px.
- Top-level content reserves bottom padding equal to nav height + safe-area inset + 16 px.
- Bottom nav stays in the phone canvas on every viewport. A desktop-only side rail is prohibited.
- A wide browser may show a neutral review stage and reviewer controls outside the phone, but it cannot alter the
  learner layout.

## 6. Depth and shape

Only three depth levels exist:

1. **Canvas:** flat warm paper or a restrained vertical paper gradient.
2. **Hero/sheet:** one dominant raised surface with 8–13 px down-right shadow and optional light inset.
3. **Control:** smaller nested surface with 3–8 px down-right shadow; pressed state shortens that shadow and adds a
   shallow inset.

Hero area is at least 1.6 times the area of any helper card visible beside it. Today cannot become a uniform bento
grid. Surface radius is 20–32 px; nested control radius is 14–16 px; pills are reserved for compact state and
progress controls. Direction B may sharpen surfaces slightly, while C may round scene sheets more, but levels and
shadow direction remain shared.

## 7. Color and emphasis rules

- Each screen has at most one solid coral primary CTA. Selection uses plum; coral nav/step indicators stay compact.
- Above the fold, at most two extra chromatic accents are visible beyond the primary action.
- Goal orange marks a target/milestone. Aqua marks explanation/info. Neither becomes a primary action.
- State never relies on color alone: icon/shape and copy accompany correct, incorrect, offline and error states.
- Normal copy targets WCAG 4.5:1; large display and non-text UI targets 3:1; focus indicator targets 3:1.

## 8. Components

### 8.1 Primary action

- Full content width when it advances the route; 58 px high; 20 px horizontal padding.
- Default: dark coral, warm-white label, visible down-right depth.
- Pressed: translate down by at most 2 px, shorter shadow, 180 ms.
- Focus: two-ring plum focus outside the component; focus never depends on shadow alone.
- Loading: label remains meaningful and includes a spinner/status announcement; width does not change.
- Disabled: pale plum surface, muted plum copy, `disabled` plus `aria-disabled=true`.

### 8.2 Secondary action

Warm raised paper, plum label, one-pixel boundary. It never has equal visual weight with the route-advancing CTA.
Ghost actions are used for back/skip only and retain a 44 px hit area.

### 8.3 Duration control

One `radiogroup` with 10/20/30/40 minute options. Exactly one option is selected. A selected option uses plum
outline/raised fill and a text/shape cue. Changing duration updates estimated route content in-place and does not
navigate.

### 8.4 Recommendation hero

Contains eyebrow, one title, concise reason, duration control, up to three route blocks and one primary action.
Ready and resume share anatomy; only progress, copy and action label change. Diagnostic/offline/error use the same
semantic slot so layout does not jump to a different template.

### 8.5 Answer choice

Native radio semantics inside a group. Minimum 48 px high.

| State | Observable treatment |
|---|---|
| Default | raised paper, plum boundary |
| Selected | plum boundary + soft plum surface + selected marker |
| Submitted correct | green surface + check + “Верно” text |
| Submitted incorrect | red surface + cross + selected/correct labels both remain visible |
| Focus | shared external focus ring |
| Disabled | muted surface and semantic disabled state |

Selection never auto-submits. The primary action explicitly advances to review.

### 8.6 Review sheet

Starts with the verdict, then correct form, reusable rule, one example, evidence provenance and a single next
action. Incorrect feedback is calm and precise; success is not confetti. Independent/assisted evidence is always
labelled in text.

### 8.7 Progress landmark

Leads with what changed, then weak point and what happens next. The before/after bar has textual values. A score
delta cannot be the only explanation. Direction C may place the landmark on its drawn path, but content order is
unchanged.

### 8.8 Bottom navigation

Exactly five items, ordered Сегодня / Практика / ЕГЭ / Прогресс / Профиль. Each is a button/link at least 44 px
wide with icon + label. Active item uses coral plus a non-color surface/marker and `aria-current=page`. Top-level
screens show nav; deep task/review screens use a back control and may keep a quiet route indicator, not a side bar.

### 8.9 Alert/state strip

Info, success, warning and error use support/status soft backgrounds, an icon, title and optional action. Loading
has `aria-live=polite`; error action is repeatable; offline copy distinguishes cached content from unavailable work.

## 9. Direction contracts

### A — Бумажный маршрут

Closest to onboarding. Soft offset sheets form one route; current sheet moves left/up out and next sheet settles
from the right by 16 px. Small route dots and goal star may connect stages. No torn-paper gimmick or scrapbook
clutter.

### B — Тактильные виджеты

The hero behaves like one learning instrument: inset duration slots, a tangible progress rail and small supporting
meters. Press shortens the down-right shadow and seats the control. It borrows physical clarity, not a homescreen
icon grid; the hero must remain dominant.

### C — Сюжетный маршрут

The learner moves upward through a restrained illustrated route. Each screen is one stage/landmark with content
anchored to the current point. The route stroke reveals forward during transition. Nature/scene shapes remain
abstract Aisy paper forms rather than copying the reference landscape.

## 10. Motion system

| Motion | Duration | Purpose |
|---|---|---|
| Press | 160–220 ms (default 180) | acknowledge direct manipulation |
| Local feedback | 220 ms | selected/submitted/status change |
| Screen change | 320–520 ms (default 420) | preserve route continuity |
| Signature | max 500 ms | one direction-specific story effect |

Only transform and opacity move during transitions. A runs horizontal paper-layer displacement, B runs a shallow
vertical seat/release, C reveals one route stroke while content fades upward. One signature effect runs at a time.
Ambient looping motion is not required for approval.

With `prefers-reduced-motion: reduce`, spatial offsets and route drawing are removed. State changes use a 80–120 ms
opacity transition, focus/pressed feedback remains visible, and no information disappears.

## 11. Shared state and fixture contract

`data/fixtures.js` is the one comparison source. It exports:

- `DIRECTIONS`, `FLOW_SCREENS`, `NAV_ITEMS`;
- one frozen realistic fixture for Today, EGE grammar task, incorrect review and Progress;
- semantic gallery states for ready, resume, diagnostic, loading, offline, access and recoverable error;
- pure `normalizeLabState`, `projectScreen`, `stateFromSearch` and `searchFromState` seams.

Every direction must project this contract rather than copy numbers or copy into variant-specific markup. URL state
is `direction`, `screen`, `state`; invalid values normalize to `a / today / ready`.

## 12. Acceptance checklist

- [ ] Same data, answer and order in A/B/C.
- [ ] 390×844 and 360×720 have no horizontal overflow or safe-area collision.
- [ ] Five destinations remain bottom navigation at every browser width.
- [ ] One primary CTA and no more than three depth levels per screen.
- [ ] All actionable targets are at least 44×44 px with visible focus.
- [ ] Component color rules reference tokens, not literal palette values.
- [ ] Reload preserves exact direction/screen/state.
- [ ] Reduced motion removes spatial signature movement.
- [ ] Login is labelled as a visual authentication placeholder.
