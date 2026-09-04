# 03 — Вызывать разрешённый staging launcher напрямую

Status: implemented; publish/live verification pending
Blocked by: —
Spec: .scratch/staging-v4-cutover/spec.md

## Наблюдаемый сбой

GitHub Actions run `33733692821` загрузил корректный release archive, но SSH-команда запускала
`sudo timeout ... /usr/local/sbin/easyboost-staging-deploy`. Sudo policy разрешает только точный
root-owned deploy launcher, поэтому операция остановилась до запуска helper.

## Что сделать

- Workflow вызывает `/usr/local/sbin/easyboost-staging-deploy` напрямую через `sudo`.
- Moving Node `22` заменён на точный producer `22.23.2`, совпадающий с установленной server authority;
  это исключает изменение canonical gzip из-за другой patch/zlib версии.
- Workflow остаётся ограничен `timeout-minutes: 60`, а transaction/recovery bounds обеспечивает
  проверенный root-owned launcher.
- Regression проверяет exact Node pin, прямой allowlisted executable и отсутствие `sudo timeout`.

## Definition of Done

- [x] Workflow вызывает allowlisted helper напрямую.
- [x] Canonical archive producer pin равен Node.js `22.23.2`.
- [x] Targeted workflow regression и diff-check проходят.
- [ ] Изменение опубликовано и новый staging run проходит sudo boundary.
- [ ] Коммит выполняет координатор после проверки общего diff.
