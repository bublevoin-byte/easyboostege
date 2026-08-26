# Direction C · round 1 live-browser matrix

Use a fresh background in-app Browser tab and inspect every exact URL at the prescribed viewport. Judge the live
phone, computed styles and transition; do not edit files. Direction C is a portrait-phone story route, not a wide
illustration or a desktop side layout.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=today&state=ready&panel=flow&embed=1&cache=cr1d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=task&state=ready&panel=flow&embed=1&cache=cr1d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=review&state=ready&panel=flow&embed=1&cache=cr1d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=progress&state=ready&panel=flow&embed=1&cache=cr1d4`

Expected direct geometry: Today surface/proof end near `548.8/600.8`, Task surface `619.6`, Review `602.6`,
Progress surface/proof near `542.4/594.4`; nav begins `y=644`, docks `y=646`. All four scroll containers have
`scrollHeight == clientHeight`, document is exactly `360×720`, and no artwork adds flow height.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr1k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr1k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr1k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr1k4`

Expected canonical phone is `x=180,y=20,w=390,h=844`; nav begins `y=787`, docks `y=789`; no overflow or side
rail. Direct C nav buttons sit inside the phone at `y=656.5…712.5`; deep primary at `650.5…708.5`, so the common
`3px/4px` focus treatment remains contained. The stepper uses an equivalent inset focus treatment.

## Required interaction and story proof

- Content, answer, numbers, duration sums and order exactly match A/B and the shared foundation fixture.
- Each screen is one raised story surface. The absolute Aisy paper scene contributes zero layout height; only the
  current stage landmark is shown, differs across Today/Task/Review/Progress, is `aria-hidden`, and intersects no
  painted content/control. It must not read as a dashboard grid or copied mountain/forest brand.
- Forward adjacent legs only set `data-c-route-transition="forward"`. Route progress moves `1→.67`, `.67→.33`,
  `.33→0` over `480ms`; the new content settles upward by `8px/420ms`. There is exactly one journey, one CTA and no
  outgoing clone. Back, skipped step, direct load, duration change and Progress→Today are static.
- Representative Today→Task live samples: around `45ms`, route ≈`.96`, opacity ≈`.44`, y≈`7px`; around `115ms`,
  route ≈`.77`, opacity ≈`.85`, y≈`2px`; by `525ms`, route `.67`, opacity `1`, transform identity. Other adjacent
  legs must be monotonic and settle at `.33/0`.
- Reduced motion removes route drawing and translate entirely: final dash offset is immediate, content uses only
  the tokenized `0.86→1` opacity settlement within `120ms`.
- All visible actions are `≥44×44`, labels `≥12px`, body/CTA `≥15px`; URL/reload, Back, keyboard radios, live
  duration projection, safe focus, contrasts, five-item nav and deep dock semantics remain intact.
