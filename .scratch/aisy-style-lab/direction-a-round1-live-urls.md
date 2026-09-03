# Direction A · round 1 live-browser matrix

Use a new background in-app Browser tab. Open every URL exactly as written and judge direct browser screenshots;
do not use saved-image viewers. Close the tab and reset its viewport after the verdict.

## Direct phone PWA — viewport 360×720

Expected phone rect: `x=0, y=0, w=360, h=720`; expected document: `scrollWidth=clientWidth=360`,
`scrollHeight=clientHeight=720`. Top-level screens use the five-item bottom nav; task/review use the deep dock.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar1d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar1d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar1d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar1d4`

Expected surface bottoms at rest: Today `≈609`, Task `≈621` before dock `646`, Review `≈602` before dock
`646`, Progress `≈594`; exposed week tails end before top-level nav `644`.

## Canonical padded carrier — viewport 750×884

Expected phone rect: `x=180, y=20, w=390, h=844`; expected document: `scrollWidth=clientWidth=750`,
`scrollHeight=clientHeight=884`.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar1k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar1k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar1k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar1k4`

## Interaction proof

From direct Today, click `Начать маршрут`. During the transition (sample around `70–110ms`) one inert
`.a-paper-outgoing` must move toward `−16px/−8px`, while the incoming `.a-paper-surface` settles from `+16px`;
computed duration is `420ms`. After `≤620ms` the outgoing clone count is `0`, URL screen is `task`, and focus is
on `.flow-screen`. Continue through Review → Progress → Today and test Back once.

For keyboard radio behavior, focus duration `20` and press ArrowRight: `30` becomes checked, the sole `tabindex=0`
radio, and retains focus. On task, focus answer `c` and press ArrowLeft: `b` becomes checked and retains focus.
Every visible phone button must measure at least `44×44`.

Reduced-motion contract: the matching media rule sets paper enter/exit offsets to `0`, applies `transform:none` to
incoming/outgoing layers, and retains the semantic opacity transition at `120ms`.
