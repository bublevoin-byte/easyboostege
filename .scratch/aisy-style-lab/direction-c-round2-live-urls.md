# Direction C · round 2 live-browser matrix

Use a fresh background in-app Browser tab. Inspect the exact URL at the prescribed viewport; then exercise the
same four-screen route. Judge the live phone, computed geometry and transition. Do not edit files.

## Direct phone — viewport 360×720

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=today&state=ready&panel=flow&embed=1&cache=cr2d1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=task&state=ready&panel=flow&embed=1&cache=cr2d2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=review&state=ready&panel=flow&embed=1&cache=cr2d3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=progress&state=ready&panel=flow&embed=1&cache=cr2d4`

Expected direct geometry: Today current landmark is `x=295…331,y=139…175`; title starts at `y=186`, leaving
11px clear. Today surface/proof end near `556.8/608.8`; Review ends near `611.3`; nav begins `y=644`, docks
`y=646`. Every document is exactly `360×720`, and all scroll widths equal their client widths.

## Canonical carrier — viewport 750×884

- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=today&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr2k1`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=task&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr2k2`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=review&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr2k3`
- `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=c&screen=progress&state=ready&panel=flow&embed=1&carrier=canonical&cache=cr2k4`

Expected phone is `x=180,y=20,w=390,h=844`; Today landmark ends at `y=208`, title starts at `y=223`; Today
surface/proof end near `680.1/760.1`, Review near `692.9`; nav begins `y=787`, docks `y=789`.

## Acceptance proof

- The sole round-1 blocker is closed: no current landmark touches painted title, eyebrow, control or card.
- The same foundation fixture/order/answers, one raised surface, four distinct landmarks, dotted continuation,
  one CTA, five-item bottom nav/deep dock, `≥44px` targets, focus containment and no side rail remain intact.
- Shared decorative SVGs are `aria-hidden` and `focusable=false`; the Review example is body copy at `15px`.
- Adjacent forward legs alone draw `1→.67→.33→0` within `480ms` and settle content by `420ms`; Back, skip,
  reload, duration changes and Progress→Today are static. Reduced motion removes route draw/translate and keeps
  only the bounded opacity settlement.
