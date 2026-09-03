# Direction A · round 2 live-browser matrix

Use a new background in-app Browser tab. Open every URL exactly as written and judge direct browser screenshots;
do not use saved-image viewers. Close the tab and reset its viewport after the verdict.

## Direct phone PWA — viewport 360×720

Expected phone rect: `x=0, y=0, w=360, h=720`; expected document: `scrollWidth=clientWidth=360`,
`scrollHeight=clientHeight=720`. Top-level screens use the five-item bottom nav; task/review use the deep dock.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar2d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar2d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar2d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar2d4`

Expected surface bottoms at rest: Today `≈609`, Task `≈621` before dock `646`, Review `≈602` before dock
`646`, Progress `≈594`; exposed week tails end before top-level nav `644`.

## Canonical padded carrier — viewport 750×884

Expected phone rect: `x=180, y=20, w=390, h=844`; expected document: `scrollWidth=clientWidth=750`,
`scrollHeight=clientHeight=884`.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar2k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar2k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar2k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar2k4`

## Interaction proof

From direct Today, click `Начать маршрут`. During the transition the outgoing and incoming sheets must both stay
at `opacity: 1`: the outgoing sheet moves left/up from `0/0` to approximately `−340px/−8px`, physically revealing
the incoming sheet as it settles from `+16px` to `0`. The duration is `420ms`; there must be no translucent overlap,
double headings, double choices or double CTA. After `≤620ms` the outgoing clone count is `0`, URL screen is `task`,
and focus is on `.flow-screen`. Continue through Review → Progress → Today and test Back once.

For keyboard radio behavior, focus duration `20` and press ArrowRight: `30` becomes checked, the sole `tabindex=0`
radio, and retains focus. On task, focus answer `c` and press ArrowLeft: `b` becomes checked and retains focus.
Every visible phone button must measure at least `44×44`.

Reduced-motion contract: the matching media rule sets paper enter/exit offsets to `0`, applies `transform:none` to
incoming/outgoing layers, and uses the semantic opacity transition at `120ms`.
