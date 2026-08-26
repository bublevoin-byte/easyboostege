# Aisy Style Lab · final comparison round 3

Use a fresh background in-app Browser tab. Read `.scratch/aisy-style-lab/spec.md`, Issue 06 and this file. Judge
only the live URLs/current exact artifacts; do not edit files.

## Sole round-2 blocker

Open:
`http://127.0.0.1:4319/prototypes/aisy-style-lab/opening.html?cache=final-r3-opening`

Inside the portrait iframe select the control labelled `Шаг 4 — вход` (or progress to login). The outer page may
scroll to keep the focused iframe control visible, but the reviewer disclosure must remain fully visible:

- `Визуальный прототип первого запуска`;
- `VK — placeholder; backend авторизации ещё не подключён.`

Expected live geometry after direct step-4 selection at 1000×900: outer `scrollY=66`, sticky note `top=8`,
`bottom=78`, login CTA `Войти через VK` visible. The reviewer note stays outside the unchanged learner phone.

## Regression URLs

- Invalid base fail-closed:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=z&borrow=b-tactile-controls&borrow=c-route-draw&embed=1&cache=final-r3-invalid`
- Filled 2/2 compact decision:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision&base=a&borrow=b-tactile-controls&borrow=c-route-draw&embed=1&cache=final-r3-filled`
- Clickable hub:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow`
- Exact artifacts remain the 26 actual PNGs in `.scratch/aisy-style-lab/final-renders/`, dimensions only
  `360×720` and `390×844`.

## Required final verdict

- Confirm the sticky disclosure closes the sole round-2 blocker without regressing phone-only A/B/C comparison,
  one-base/max-two normalization, URL/reload/keyboard/focus, same fixture or production isolation.
- Final static QA, lint, syntax/inline-handler check, unit `1914/1866/48/0` and diff-check are green.
- Return only `PASS` with short evidence or `FAIL` with one largest concrete blocker.
