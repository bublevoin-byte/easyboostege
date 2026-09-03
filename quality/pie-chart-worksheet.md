# Круговые диаграммы задания 38 — цифры со сканов

Работ в этом листе: **3**.

В этих работах данные опроса нарисованы картинкой: в текстовом слое PDF их нет, и никакая
программа их оттуда не достанет. Проценты нужно один раз переписать с диаграммы глазами —
иначе эти три работы не попадут в проверку ИИ.

## Что делать

1. Если методичек ещё нет на диске, скачайте их: `npm run quality:sources` — PDF лягут
   в `quality/sources/`.
2. Откройте указанный у работы PDF на указанной странице. Номер страницы — тот, что стоит
   в поле «страница» у просмотрщика, а не напечатанный внизу листа.
3. Найдите круговую диаграмму. У каждого сектора подписаны название (по-английски)
   и процент.
4. Перепишите их в блок этой работы — тот, что между строками ``` ниже.
5. Сохраните файл и запустите `npm run quality:merge-charts`. Скрипт перенесёт цифры
   в набор и скажет, что получилось.

## Как заполнять

- **Одна строка — один сектор диаграммы**, всего от 3 до 8 строк.
- В строке: сначала подпись сектора, потом вертикальная черта `|`, потом процент.
  Подсказка с этим порядком уже стоит первой строкой в каждом блоке.
- **Подпись — ровно как на диаграмме**, по-английски, без перевода и без сокращений.
- **Процент — целое число от 0 до 100**, без знака `%`. Написано `27%` — пишите `27`.
  Попалось дробное — округлите до целого.
- **Сумма процентов может не равняться 100, и подгонять её не нужно.** В части опросов
  можно выбрать несколько вариантов ответа, и там сумма больше ста — это нормально.
- Строки, начинающиеся с `#`, скрипт не читает: это подсказки, их можно оставить как есть.
- Метки вида `<!-- w38-... -->` не удаляйте — по ним скрипт понимает, к какой работе
  относятся цифры.

## Если что-то пойдёт не так

- Заполнять можно по частям: работы без цифр скрипт молча пропустит и напомнит о них.
- Если строка не понравится проверке, скрипт **ничего не запишет в набор** и назовёт работу
  и строку, в которой ошибка. Поправьте её и запустите `npm run quality:merge-charts` снова.
- Заново собрать этот файл можно командой `npm run quality:charts` — уже вписанные строки
  она сохраняет.

---
## 1. w38-fipi-2023-006

- **Файл:** `quality/sources/fipi-pch-2023.pdf`, страница **115**
- **Работа:** номер бланка не указан — ищите по теме проекта
- **Тема проекта:** what people use their smartphones for in Zetland

Диаграмма нарисована картинкой, поэтому в тексте её не видно: смотрите на страницу глазами.
Если на указанной странице диаграммы нет, она на следующей — условие иногда переносится.

<details><summary>Условие задания (для сверки, что нашли нужную диаграмму)</summary>

```
Imagine that you are doing a project on what people use their smartphones for in Zetland. You have
found some data on the subject – the results of the opinion polls (see the diagram below). Comment
on the data in the pie chart and give your opinion on the subject of the project. Write 200–250
words.
```

</details>

Перепишите подписи и проценты с диаграммы — по одной строке на сектор, от 3 до 8 строк:

<!-- w38-fipi-2023-006 -->
```text
# подпись сектора | процент
Email | 30
Making phone calls | 27
Surfing the Internet | 17
Playing games | 16
Paying for purchases | 10
```

## 2. w38-fipi-2026-3896

- **Файл:** `quality/sources/fipi-pch-2026.pdf`, страница **140**
- **Работа:** № 3896
- **Тема проекта:** Zetland teenagers’ preparation for final exams
- **Вопрос опроса:** What helped you the most in preparing for final exams?

Диаграмма нарисована картинкой, поэтому в тексте её не видно: смотрите на страницу глазами.
Если на указанной странице диаграммы нет, она на следующей — условие иногда переносится.

<details><summary>Условие задания (для сверки, что нашли нужную диаграмму)</summary>

```
Imagine that you are doing a project on Zetland teenagers’ preparation for final exams. You have
found some data on the subject – the results of a survey conducted among Zetland teenagers (see the
pie chart below). Comment on the survey data and give your opinion on the subject of the project.
The survey question: What helped you the most in preparing for final exams? 1. Choose one option
Write 200–250 words.
```

</details>

Перепишите подписи и проценты с диаграммы — по одной строке на сектор, от 3 до 8 строк:

<!-- w38-fipi-2026-3896 -->
```text
# подпись сектора | процент
Regular study routine | 34
Parents’ support | 26
Practice and review | 20
Time management | 11
Positive mindset | 9
```

## 3. w38-fipi-2026-3468

- **Файл:** `quality/sources/fipi-pch-2026.pdf`, страница **152**
- **Работа:** № 3468
- **Тема проекта:** Zetlanders’ priorities in reading and discussing the news in social networks
- **Вопрос опроса:** What is your priority in reading and discussing the news in social networks?

Диаграмма нарисована картинкой, поэтому в тексте её не видно: смотрите на страницу глазами.
Если на указанной странице диаграммы нет, она на следующей — условие иногда переносится.

<details><summary>Условие задания (для сверки, что нашли нужную диаграмму)</summary>

```
Imagine that you are doing a project on Zetlanders’ priorities in reading and discussing the news in
social networks. You have found some data on the subject – the results of a survey conducted among
Zetland social network users (see the pie chart below). Comment on the survey data and give your
opinion on the subject of the project. The survey question: What is your priority in reading and
discussing the news in social networks? Choose one option Write 200–250 words.
```

</details>

Перепишите подписи и проценты с диаграммы — по одной строке на сектор, от 3 до 8 строк:

<!-- w38-fipi-2026-3468 -->
```text
# подпись сектора | процент
Reliable information | 34
Internet security | 26
Volume of information | 20
Discussing information with other social network users | 11
Friendly attitude of other social network users | 9
```
