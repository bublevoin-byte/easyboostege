# Direction A · round 6 live-browser matrix

Use a fresh background in-app Browser tab, inspect every exact URL at the prescribed viewport, then close the tab
and reset the viewport. Judge direct browser screenshots and DOM/computed styles; do not edit files.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar6d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar6d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar6d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar6d4`

Expected phone/document `360×720`, no overflow; surface bottoms approximately `609/621/602/594`.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar6k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar6k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar6k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar6k4`

Expected phone `x=180,y=20,w=390,h=844`; document `750×884`, no overflow.

## Required evidence

- Shared primary CTA computes to warm white `rgb(255,253,249)` on deep coral `rgb(185,67,58)` (`#B9433A`),
  WCAG contrast `≈5.26:1` for `15px` normal copy. Hover token is `#9F342F`; one solid coral CTA remains.
- Preserve full flow, Back/reload, opaque paper/CTA sequencing, radio focus, calm programmatic focus, targets,
  deep CTA press `180/180/220ms`, and reduced-motion behavior from round 5.
- Verify the deeper coral still belongs to the approved warm-paper/plum art direction and does not overpower content.
