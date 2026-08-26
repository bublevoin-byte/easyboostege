# Direction A · round 3 live-browser matrix

Use a new background in-app Browser tab. Open every URL exactly as written and judge direct browser screenshots;
do not use saved-image viewers. Close the tab and reset its viewport after the verdict.

## Direct phone PWA — viewport 360×720

Expected phone rect: `x=0, y=0, w=360, h=720`; expected document: `scrollWidth=clientWidth=360`,
`scrollHeight=clientHeight=720`. Top-level screens use the five-item bottom nav; task/review use the deep dock.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar3d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar3d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar3d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar3d4`

Expected surface bottoms at rest: Today `≈609`, Task `≈621` before dock `646`, Review `≈602` before dock
`646`, Progress `≈594`; exposed week tails end before top-level nav `644`.

## Canonical padded carrier — viewport 750×884

Expected phone rect: `x=180, y=20, w=390, h=844`; expected document: `scrollWidth=clientWidth=750`,
`scrollHeight=clientHeight=884`.

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar3k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar3k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar3k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar3k4`

## Interaction proof

From direct Today, click `Начать маршрут`. Normal motion keeps both paper sheets at `opacity: 1`: outgoing moves
fully left/up to approximately `−340px/−8px`, incoming settles `+16px → 0` over `420ms`, without doubled text.
While the outgoing sheet and its old CTA exist, the new bottom nav/deep dock must remain `opacity: 0` and
non-interactive. Only after outgoing count reaches `0` may new chrome appear over `220ms`; old and new CTA must
never be visible together. URL/focus settle on Task. Continue Review → Progress → Today and test Back.

For keyboard radio behavior, focus duration `20` and press ArrowRight. `30` must become checked, the sole
`tabindex=0` radio and active element with `:focus-visible=true`; computed focus is plum outline `3px`, offset `4px`
plus token focus-shadow. On task, `c` ArrowLeft → `b` with the same contract. Every visible phone button is
at least `44×44`.

Reduced-motion contract: paper offsets and chrome transform are zero/none; semantic opacity uses `120ms` for
screen state, while visible focus remains unchanged.
