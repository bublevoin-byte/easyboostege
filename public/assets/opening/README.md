# Opening artwork derivatives

Production-sized derivatives for the approved logo, onboarding, and login sequence. The source PNG files remain unchanged under `public/prototypes/onboarding-v1/assets/`.

| Output | Canvas | Bytes | Source PNG | Source SHA-256 |
| --- | ---: | ---: | --- | --- |
| `logo.webp` | 448×448 | 18,354 | `aisy-mark-primary-color-transparent.png` | `e05b59753264c41b1a27bd296873ebc4de6c2cc63b9a1dd5c5976f2e53cc3961` |
| `map.webp` | 638×600 | 24,634 | `onboarding-raster-direction-a-map.png` | `7e79c526c4aae4569d9a65252ca391f93e5857f8f59f605465fd52191fca3504` |
| `practice.webp` | 640×585 | 32,234 | `onboarding-raster-practice.png` | `1d5ea69007682482ee921483e49bd32b182f91e64c4f1f6067a17e1ae40de633` |
| `answer.webp` | 600×600 | 25,646 | `onboarding-raster-answer-ribbon-final.png` | `67d15a382cc341824114532c6a83f1a23d45d25100ed10784f74b4a9facbf5b3` |
| `login.webp` | 640×591 | 31,642 | `login-raster-continue.png` | `c95c167e14656601d5751e3c58db0741f0bea1a3c903673cd7e0d9abd748eb61` |

The images were fitted without cropping into transparent canvases at the dimensions above and encoded locally as lossy WebP (quality 82; logo quality 84). Decoding verification confirms alpha in every derivative.

Asset budget: 132,510 bytes total (about 129.4 KiB), including 42,988 bytes (about 42.0 KiB) for `logo.webp` and `map.webp` together. This is below the 700 KiB total and 250 KiB logo-plus-map limits.

Publishing rights for the source artwork must be confirmed before release.
