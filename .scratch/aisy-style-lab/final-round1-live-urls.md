# Aisy Style Lab · final comparison round 1

Use a fresh background in-app Browser tab. Judge only the live URLs and exact files below; do not edit files.
The learner composition must stay a portrait phone. The toolbar is reviewer chrome outside that phone.

## Clickable hub

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=a&borrow=b-tactile-controls&borrow=c-route-draw`
- The toolbar must switch A/B/C and Screens / Components / Animations / Decision over one centered phone. The
  `Логотип → onboarding → вход` link must remain visible and point to the existing opening prototype.

## Exact phone worksheet

- Direct compact `360×720` filled 2/2:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=a&borrow=b-tactile-controls&borrow=c-route-draw&embed=1&cache=final-decision-d`
- Canonical `390×844` blank:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&embed=1&cache=final-decision-k`
- Selection is one base plus at most two mechanics. Unknown, duplicate, same-base and third borrowing values must
  fail closed. Changing base removes conflicting borrowings; reload and Back preserve URL truth. Radio arrows,
  checkbox state text, focus, `≥44px` targets and scroll-to-summary must remain usable.

## Exact artifacts

- Directory: `.scratch/aisy-style-lab/final-renders/`
- 26 actual PNG files: 12 core canonical flow screens, 6 compact task/review screens, 2 component galleries,
  3 motion labs, 1 nav proof and 2 decision states.
- Every filename contains its measured dimensions. Metadata must report only `390×844` or `360×720` and PNG.

## Required final proof

- Foundation, A, B and C already have independent `ПРОЙДЕНО ×3` verdicts recorded in
  `.scratch/aisy-style-lab/progress.md`.
- All three directions use the same Today → Task → Review → Progress fixture and five bottom destinations; deep
  screens use Back + one primary CTA. No side rail or wide learner layout exists.
- 24 live flow combinations across `360×720` and `390×844` have zero horizontal overflow, controls `≥44px`, one
  CTA and correct nav/dock semantics. A has only bounded 3–18px vertical scrolling on three compact states.
- Full A/B/C journeys and Back settle with URL, focus, one CTA and one current screen aligned.
- C Progress now masks the decorative trail behind improvement copy with one flat paper wash; the route remains
  visible between content blocks and does not cross text.
- Static token audit, lint, syntax/inline-handler check and diff-check are green. Production UI/API/storage/service
  worker are untouched.
