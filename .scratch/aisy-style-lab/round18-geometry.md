# Round 18 carrier geometry

Live browser measurements captured after every screenshot. The outer viewport is QA padding; the product surface
inside it remains the exact portrait phone.

| Carrier | Outer viewport | Phone rect | Document width | Result |
|---|---:|---:|---:|---|
| compact | 720×760 | x=180, y=20, w=360, h=720 | scrollWidth=720, clientWidth=720 | no overflow |
| canonical | 750×884 | x=180, y=20, w=390, h=844 | scrollWidth=750, clientWidth=750 | no overflow |

The same measurements passed for Today, Task, Review, Progress, Components, Motion and Nav. A compact browser
audit also found zero visible buttons below 44×44 px. Task/Review use a 74 px deep dock; all other screens use a
76 px five-item bottom nav. The 180 px left/right QA padding is not navigation and contains no UI.
