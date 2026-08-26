# Aisy Style Lab · final comparison round 2

Use a fresh background in-app Browser tab. Read `.scratch/aisy-style-lab/spec.md`, Issue 06 and this file. Judge
only the live URLs/current exact artifacts; do not edit files.

## Sole round-1 blockers

1. Invalid base must clear the whole decision:
   `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=z&borrow=b-tactile-controls&borrow=c-route-draw&embed=1&cache=final-r2-invalid`
   Expected after normalization: no checked base, no checked borrowing, `0 из 2`, six disabled borrowing controls,
   URL contains neither `base` nor `borrow`.
2. Login placeholder must be visible before and after interaction:
   `http://127.0.0.1:4319/prototypes/aisy-style-lab/opening.html`
   Expected: persistent reviewer note `Визуальный прототип первого запуска` and `VK — placeholder; backend
   авторизации ещё не подключён` above one `390px` portrait frame running the unchanged logo/onboarding/login.

## Regression URLs

- Filled 2/2 compact decision:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=a&borrow=b-tactile-controls&borrow=c-route-draw&embed=1&cache=final-r2-filled`
- Clickable hub:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow`
- Exact artifacts remain the 26 actual PNGs in `.scratch/aisy-style-lab/final-renders/`, dimensions only
  `360×720` and `390×844`.

## Required final verdict

- Confirm both blockers are closed without regressing phone-only A/B/C comparison, one-base/max-two normalization,
  URL/reload/keyboard/focus, opening link, same fixture and production isolation.
- Final static QA, lint, syntax/inline-handler check, unit `1914/1866/48/0` and diff-check are green.
- Return only `PASS` with short evidence or `FAIL` with one largest concrete blocker.
