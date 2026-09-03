# Aisy production UI A — progress

| Ticket | Status | Evidence |
|---|---|---|
| 01 — Production A foundation | done | Standards/Spec re-review zero findings; 1919 tests / 0 fail; build + Aisy E2E passed |
| 02 — First launch + VK ID | done | ZERO×2 review; 1966 unit / 0 fail; build + three Aisy E2E + security gates green; live VK not called |
| 03 — Access + Today shell | done | ZERO×2 re-review; 101 focused tests / 0 fail; build + affected Chromium E2E green; one full-suite run documented in ticket |
| 04 — Practice + Words | done | Direction A Practice/Words; 50 focused + 6 Reading contract tests green; production browser matrix green; ZERO×2 re-review |
| 05 — Grammar | done | Paper A catalog/runner/exam; owner-bound async seams; Chromium matrix; ZERO×2 review |
| 06 — Reading + Listening | done | Paper A responsive matrix + owner-safe Reading/Listening; 120 focused tests and affected Chromium green; ZERO×2; full suite run once with 4 HEAD-proven inherited failures |
| 07 — Writing + AI review | done | Paper A route + canonical CTA; durable owner-bound exactly-once evaluation and authoritative progress; Writing/SW-offline Chromium green; ZERO×2; one full-suite run documented in ticket; deploy gated by Ticket 11 controlled SW activation |
| 08 — Speaking + Asya | done | Paper A Speaking 1–4/full + contextual Asya/Voice Tutor; ZERO×2 review; 69 focused + affected tests green; responsive Chromium matrix and 390×844 visual QA; one full-suite run documented in ticket |
| 09 — EGE + full mock | done | Paper A strict EGE hub/runners/result; exact exam-only offline boundary; ZERO×2; focused + full EGE Chromium release contour green; responsive dark/reduced matrix |
| 10 — Progress + Profile | done | Paper A Progress/Profile + strict active/owner-bound account actions; ZERO×2; 249 focused + full 2085 pass/0 fail/51 skip; five Chromium contours green |
| 11 — PWA + release evidence | done | Reviewed source freeze `379956516483fb5d734a90a5b0e29e1f94e4988d1400b9bdf2f0087f88f4ce9c`: 175 files / 9,545,896 bytes; fresh Product/UI `160/160` and Engineering/Release `67/67`. Sole final wrapper green: 3,130 total / 3,055 pass / 0 fail / 75 skips; artifact `d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290`; 26 unique Chromium scenarios; first-load JS 90.0 KB / 150 KB, LCP 108 ms, CLS 0.000, INP 64 ms. Phone 390×844 and centered 390 px desktop-stage browser proof has zero overflow/rail/console errors. Retained DB marker is byte-identical; no Docker/DB/provider/network, deploy, push or live VK. |

## Owner decisions already locked

- Base: A — «Бумажный маршрут», без автоматических заимствований B/C.
- Learner UI: один portrait phone; desktop side rail запрещён.
- Auth: production learner entry через VK ID; local fake до создания VK application.
- Access: только active subscription; без Free/demo promise.
- Theme: light + warm dark, system-aware.
- CTA: утверждённая onboarding anatomy с AA-safe dark coral.
- Fonts: local Nunito + Manrope; Acrom не используется без лицензии.
