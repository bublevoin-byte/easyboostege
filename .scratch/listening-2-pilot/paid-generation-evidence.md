# Аудирование 2.0 — evidence платной генерации

- Дата: 2026-08-05.
- Исходный коммит генератора и каталога: `f42c749`.
- Каталог: `listening-pilot-v1@r1`, 60 комплектов (20 matching, 20 true/false/not stated, 20 interview).
- xAI TTS: 400 последовательных запросов, 56 914 символов, ставка $15 за 1 млн символов, расчётная стоимость $0.853710.
- Результат: 400 MP3, 54 879 623 байта вместе с manifest; максимальный файл 255 744 байта.
- Параметры: `language: en`, MP3 24 kHz / 128 kbps, lowercase built-in voice IDs.
- Server-side dry-run после генерации: `requests=0`, `missing_assets=0`.
- Архив результата: SHA-256 `1525cb61ff0365abe1594074a9da7982b331cdff37e0a2a9cb7013a85f99c99e`; локальная копия совпала.
- Локальный dry-run после импорта: `requests=0`, `missing_assets=0`.
- Локальный полный набор: 795 тестов, 780 pass, 15 штатных PostgreSQL skip, 0 fail.
- Frontend build после импорта: 419 проверенных assets, включая 400 MP3; MP3 исключены из стартового APP_SHELL, listening manifest остаётся в оболочке и runtime Range-cache загружает аудио по требованию.
- Lint, syntax/inline-handler check и secret scan после импорта прошли.
- Секрет `XAI_API_KEY` использовался только в окружении процесса на VPS, в команды, логи, manifest и проект не записывался.
- Запущенный staging-контейнер не изменялся; push и deploy не выполнялись.
- Перед deploy остаётся субъективная ручная проверка выбранных голосов и произношения на нескольких образцах.
