# Direction A · round 5 live-browser matrix

Use a fresh background in-app Browser tab, inspect every exact URL at the prescribed viewport, then close the tab
and reset the viewport. Judge direct browser screenshots and DOM/computed styles; do not edit files.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar5d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar5d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar5d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar5d4`

Expected phone/document `360×720`, no overflow. Direct surface bottoms remain approximately `609/621/602/594`.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar5k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar5k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar5k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar5k4`

Expected phone `x=180,y=20,w=390,h=844`; document `750×884`, no overflow.

## Required interaction evidence

- Full Today → Task → Review → Progress → Today flow, Back and reload.
- Paper motion: opaque old sheet fully exits left/up over `420ms`; new sheet settles from `+16px`; new chrome and
  child CTA remain `opacity:0` until outgoing is removed.
- Settled `.flow-screen` programmatic focus has no decorative outline; duration/choice keyboard focus has solid
  plum `3px/4px` outline plus token focus-shadow and correct roving-radio semantics.
- Task and Review `.deep-dock__primary` computed press transitions are `transform 180ms`, `box-shadow 180ms`,
  `background 220ms`, token easing. Active state moves at most `1px` and shortens the shadow.
- Targets are `≥44×44`; reduced motion removes spatial movement and keeps `120ms` semantic opacity.
