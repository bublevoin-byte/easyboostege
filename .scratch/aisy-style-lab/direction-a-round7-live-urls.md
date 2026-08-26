# Direction A · round 7 live-browser matrix

Use a fresh background in-app Browser tab, inspect all exact URLs at prescribed viewport, then close/reset. Judge
direct screenshots and DOM/computed styles; do not edit files.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar7d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar7d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar7d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar7d4`

Expected phone/document `360×720`, no overflow; surface bottoms approximately `609/621/602/594`.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar7k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar7k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar7k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar7k4`

Expected phone `x=180,y=20,w=390,h=844`; document `750×884`, no overflow.

## Required evidence

- Enabled inactive flow-stepper labels/numerals compute to `rgb(123,73,111)` (`#7B496F`) at `11px`; contrast is
  `≈6.11:1` on `#FFEDE4` and `≈6.64:1` on `#FFF9F3`. Active step and disabled controls retain distinct tokens.
- Primary CTA remains warm white on `#B9433A`, `≈5.26:1`; one solid CTA per screen.
- Preserve full flow, Back/reload, opaque paper/CTA sequencing, control/programmatic focus split, targets,
  `180/180/220ms` deep press and reduced-motion behavior from round 6.
- Verify darker subtle text improves legibility without making all four steps compete with the active step.
