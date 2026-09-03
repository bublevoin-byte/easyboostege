# Direction B · round 1 live-browser matrix

Use a fresh background in-app Browser tab, inspect every exact URL at the prescribed viewport, then close/reset.
Judge the live phone, DOM geometry and computed styles; do not edit files.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=today&state=ready&panel=flow&embed=1&cache=br1d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&embed=1&cache=br1d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=review&state=ready&panel=flow&embed=1&cache=br1d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=flow&embed=1&cache=br1d4`

Expected phone/document `360×720`; no horizontal or recovery scroll. Instrument bottoms are approximately
`571/623/596/569`; Today/Progress attached readouts end near `607/605`, before nav at `644`. Task/Review dock starts
at `646`.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=br1k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=br1k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=br1k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=br1k4`

Expected phone `x=180,y=20,w=390,h=844`; document `750×884`; no overflow or side rail.

## References and required evidence

- Product/brand reference: `design/onboarding/renders/lower-style-a-reference-r6-source.jpg`.
- Tactile/widget reference: `C:\Users\Ригер\Downloads\92c25a71d74dd8ddb6b4d1298cb13ac8.jpg`.
- Mobile story reference: `C:\Users\Ригер\Downloads\832b40cc2d2ef2b836bba9f4182b483d.jpg`.
- Direction B must read as one vertical learning console per screen, never a bento/dashboard. Maximum material
  depth is canvas → instrument → key/readout; all shadows fall down-right.
- Today remains the dominant hero; duration is a recessed tuner, the route is one continuous rail, and weekly proof
  is an attached narrow readout. Task uses one inset prompt and a physical key bank. Review uses one recessed answer
  comparison plus an engraved rule plate. Progress uses a central calibration readout and an inset next-step slot.
- Top-level Today/Progress have the same five-item bottom nav. Deep Task/Review have only the common bottom dock.
- Visible controls are `≥44px`; exactly one enabled solid coral CTA. CTA contrast is `≈5.264:1`; enabled inactive
  step text is `≈6.644:1` on canvas.
- Full flow, dock Back, browser Back/reload and roving-radio keyboard behavior must work. Local duration/choice changes
  must not animate the screen.
- Signature motion is one physical `seat → release`: current instrument seats about `2px` over `180ms`, incoming
  instrument releases from about `4px` over `220ms`; nav/dock do not travel and no duplicate readable surface exists.
  Reduced motion removes spatial movement and keeps an `80ms` opacity/material response.
