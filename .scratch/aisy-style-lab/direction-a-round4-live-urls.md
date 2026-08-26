# Direction A · round 4 live-browser matrix

Use a new background in-app Browser tab. Open every URL exactly as written and judge direct browser screenshots;
do not use saved-image viewers. Close the tab and reset its viewport after the verdict.

## Direct phone PWA — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&cache=ar4d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&cache=ar4d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&cache=ar4d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&cache=ar4d4`

Expected phone/document: exactly `360×720`, no overflow. Top-level screens use the five-item bottom nav;
task/review use the deep dock. Surface bottoms remain Today `≈609`, Task `≈621`, Review `≈602`, Progress `≈594`.

## Canonical padded carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar4k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar4k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar4k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=ar4k4`

Expected phone: `x=180, y=20, w=390, h=844`; document exactly `750×884`, no overflow.

## Interaction proof

Today → Task keeps two opaque sheets; outgoing exits to about `−340px/−8px`, incoming settles `+16px → 0` over
`420ms`. In every frame with `.a-paper-outgoing`, both the new dock and its child `.deep-dock__primary` must compute
to `opacity: 0`; old sheet CTA remains `opacity: 1`. New chrome appears only after outgoing count is `0`.

After screen settle, focus is programmatically on `.flow-screen` for assistive navigation, but this noninteractive
container has `outline-style:none` and no shadow/oversized frame. Interactive keyboard focus remains explicit:
duration `20` ArrowRight → `30` and task `c` ArrowLeft → `b` give checked, sole `tabindex=0`, active element,
`:focus-visible=true`, solid plum outline `3px`, offset `4px`, and token focus-shadow.

Continue the full flow, Back and reload. Every visible target is `≥44×44`; reduced motion removes spatial offsets
and keeps the semantic `120ms` opacity transition.
