# Соответствие NikaS UI Standard v2.2 / Navigation Contract v1.2

Версия интеграции и UI: `0.1.5`. Каноническая ревизия: `4d229f38e2f75009263e904b52462cc232eefaba`.

| Требование | Статус | Реализация / свидетельство |
| --- | --- | --- |
| Host-bound Shell v2.1 | PASS (static/runtime) | Канонический source kit включён build-time в автономный bundle; корень не использует `position: fixed`, `100vh` или `100dvh`. |
| Header 60 px и Bottom Tab Bar 64 px | PASS (static/runtime) | Канонические классы Shell, title 52 px, четыре вкладки 52 px, MDI-иконки 26 px; safe area принадлежит оболочке один раз. |
| Единственный рабочий viewport | PASS (static/runtime) | `.nikas-shell__viewport` содержит `.nikas-shell__canvas` и frame до 1280 px; оболочка монтируется один раз. |
| Граничная прокрутка iOS | PASS (unit/runtime) | Capture-phase non-passive guard v2.1 подключается к host и очищается при disconnect. |
| Масштаб рабочей области | PASS (unit/runtime) | Gesture-only 75–200%; при 100% работает нативная прокрутка, масштабируется только canvas. |
| Безопасный Header return | PASS (unit/runtime) | Канонический приоритет `return_to`/`from`, one-shot hand-off, сохранённый маршрут в localStorage, referrer и fallback; поддержаны House v13, Rooms v11, Actions и Infrastructure. |
| Refresh v1.1 | PASS (production harness) | Single-flight; минимум 900 мс; success/error 1400 мс; retry отменяет прежний timer; Recorder/API failure не выдаётся за успех; ARIA, reduced motion и disconnect cleanup. |
| Стабильное обновление телеметрии | PASS (unit/runtime) | `set hass()` объединяет обновления в animation frame и меняет только существующие текст/классы. |
| Кэш посещённых вкладок | PASS (unit/runtime) | Каждая вкладка создаётся один раз и остаётся в `Map`. |
| Явная недоступность данных | PASS (unit/runtime) | `unknown`, `unavailable`, отсутствие и нечисловые значения отображаются как «Нет данных». |
| Безопасность команд | PASS (unit/runtime) | Нет управления водой; Refresh вызывает только `homeassistant.update_entity` и чтение Recorder. |
| Автономный production bundle | PASS | Один детерминированный JS без runtime-импортов; входные файлы отмечены и закреплены в профиле. |
| Lifecycle / ownership маршрута | PASS (static) | При коллизии чужой `/dashboard-water` не присваивается интеграции и не удаляется при unload. |
| Полнота расхода | PASS (29 production tests) | Итог только при покрытии всех завершённых часов обоих счётчиков и наличии соседнего исходного часа; пропуски не становятся нулями. |
| Геометрия в реальном браузере | GAP | Нужна проверка computed styles/rectangles на обязательной матрице viewport после установки в Home Assistant. |
| Фактическая HA/iPhone-приёмка | GAP | Нужны установка опубликованной версии, проверка Recorder, pinch/reset, длинных и коротких вкладок, offline/recovery и маршрутов возврата. |

Копии нормативных документов и `templates/shell_v2/nikas-specialized-shell.js` проверяются по SHA-256. Статический PASS не заменяет browser/device acceptance и не подтверждает внешнюю доступность источников данных.
