# Калибровка автоматической оценки Speaking 2.0

Этот контур только офлайн считает метрики по уже собранным экспертным оценкам и сохранённым
результатам кандидата. Команда не вызывает xAI, Azure или другой внешний сервис. Пустой шаблон
намеренно выдаёт `not_validated`: в репозитории нет выдуманных ученических записей, экспертных
оценок или подписи методиста.

## Зафиксированный кандидат

Один набор относится ровно к одной комбинации версий каталога, semantic prompt, серверного
комбинатора, Azure-normalizer и semantic-модели. Смешивать версии в одном отчёте нельзя. Для
каждого ученика нужен уникальный псевдоним, `participantAgeGroup=minor|adult`, версия согласия на
калибровку и canonical UTC timestamp с миллисекундами (`YYYY-MM-DDTHH:mm:ss.sssZ`). Для minor
`guardianConfirmed` обязан быть `true`, для adult — `false`. ФИО, VK/Telegram ID, исходное аудио и
открытые ключи в набор не входят. Текущий кандидат фиксирует `speaking-semantic-v4` и
`speaking-fipi-combiner-v2`; остальные version fields также должны называть точные версии.

Минимум — 40 независимых случаев каждого задания, то есть не меньше 160 случаев. Каждый случай
имеет две независимые оценки разных экспертов. Для задания 1 любое расхождение 0/1 является
существенным; для остальных заданий существенна разница больше одного балла. Расхождение по
critical error всегда существенно. Его разрешает третий эксперт, отличный от первых двух.

Нужны как минимум два повторных запуска одного неизменного кандидата. Внутри каждого из четырёх
заданий каждый ожидаемый уровень B1/B2/B2+/C1, locale en-GB/en-US, device mobile/desktop и
environment quiet/ordinary_noise должен иметь минимум пять случаев: суммарное покрытие не может
скрыть task-specific провал. Фонетические critical recall и false-positive rate считаются только
по заданию 1, а не разбавляются заданиями 2–4.

## Первый проход: отчёт без подписи

Скопируйте `quality/speaking-calibration-template.json` в отдельный защищённый рабочий файл,
заполните его реальными разрешёнными данными и выполните:

```powershell
npm run quality:speaking-calibration -- C:\secure\speaking-dataset.json --report-version=2026-08-candidate-1 --output=C:\secure\speaking-report-unsigned.json
```

Команда создаёт новый файл и не перезаписывает существующий. Код завершения `2` означает, что
отчёт рассчитан, но release gate не пройден; для первого прохода без подписи это ожидаемо. Код
`1` означает ошибку чтения или параметров. В отчёте фиксируются canonical SHA-256 digest набора и
отчёта, общие, per-task и subgroup метрики, structural errors и причины fail. В canonical digest
входят в том числе `validationErrors`, `metricsStatus`, `expertGate`, `perTaskGate` и `subgroupGate`;
изменение любого из них делает прежнее approval недействительным.

Пороги fail-closed: structural validity 100%, MAE не больше 1, доля результатов в пределах ±1
не меньше 90%, stability в пределах одного балла не меньше 90%, task 1 exact agreement не меньше
90%, critical recall не меньше 90%, critical false-positive rate не больше 10%. Каждый task
проходит пороги отдельно; subgroup не может иметь продуктово значимую деградацию относительно
общего результата.

## Второй проход: внешняя методическая подпись

Методист проверяет неизменный отчёт и оформляет внешний approval JSON:

```json
{
  "signedBy": "methodologist-pseudonym",
  "signedAt": "2026-08-06T12:00:00.000Z",
  "statement": "I approve this exact candidate and report digest.",
  "reportDigest": "COPY_EXACT_DIGEST_FROM_UNSIGNED_REPORT",
  "signatureReference": "external-governance://speaking/2026-08-candidate-1/approval-001"
}
```

`signatureReference` — ссылка на подпись/решение во внешнем контуре управления, а не
криптографическая подпись, которую создаёт приложение. Повторите команду с тем же dataset и
`report-version`, новым output и `--approval=C:\secure\approval.json`. Любое изменение значения в
наборе или отчёте меняет canonical digest и делает старое approval недействительным.

Только одновременно прошедшие structural, expert, per-task, subgroup и quantitative gates плюс
approval точного digest дают `releaseStatus: validated` и код `0`. До реального прогона и такой
подписи продукт обязан показывать «автоматическая тренировочная оценка, примерный балл».
