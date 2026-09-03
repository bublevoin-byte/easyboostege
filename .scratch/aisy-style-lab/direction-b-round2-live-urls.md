# Direction B · round 2 live-browser matrix

Use a fresh background in-app Browser tab, inspect every exact URL at the prescribed viewport, then close/reset.
Judge the live phone, DOM geometry and computed styles; do not edit files. Round 2 must verify every round-1 blocker
and retain the complete matrix rather than reviewing only the patched Today state.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=today&state=ready&panel=flow&embed=1&cache=br2d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&embed=1&cache=br2d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=review&state=ready&panel=flow&embed=1&cache=br2d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=flow&embed=1&cache=br2d4`

Expected phone/document `360×720`; no horizontal or recovery scroll. Instrument bottoms are approximately
`571/624/614/580`; Today/Progress attached readouts end near `607/616`, before nav at `644`. Task/Review dock starts
at `646`.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=br2k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=br2k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=br2k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=br2k4`

Expected phone `x=180,y=20,w=390,h=844`; document `750×884`; no overflow or side rail.

## Round-1 blocker proofs

- On Today, select each 10/20/30/40 radio. The route must update in place, remain on Today with B phase `idle`, and
  show estimates that sum exactly to the selection: `2+6+2`, `3+12+5`, `5+18+7`, `6+24+10`. The live region label
  must name the selected duration. A and C share the same projection; no direction may diverge.
- B `.bottom-nav` and `.deep-dock` use only down-right control shadow: computed outer offsets start `6px 8px`, not
  the former `0 -5px` shadow.
- B labels/captions in stepper, duration units, route rail, readout, nav and provenance compute to `12px`; deep dock
  CTA computes to `15px`; next-step body computes to `15px`. No patched `11px`/`13px` hierarchy remains.
- Keyboard-focus the deep primary without activating it. Button rect is approximately `y=651…709`; solid plum
  outline is `3px` with `4px` offset; focus outer bottom stays below `720`, never touching or crossing the phone edge.

## Preserved evidence

- Keep every round-1 requirement from `direction-b-round1-live-urls.md`: one vertical console, maximum three depth
  levels, exact nav/dock anatomy, targets `≥44px`, one CTA, contrast, full flow, keyboard radios, Back/reload,
  `180ms` seat + `220ms` release, no duplicate surface and reduced-motion transform removal.
