# Соответствие NikaS UI Standard v2.2 / Navigation Contract v1.3

Версия интеграции и UI `0.3.0-beta004`. Верхнее меню сверено с [ревизией NikaS `f04fdc8`](https://github.com/NikaSir/ha-contract-generated-ui/tree/f04fdc8904472008878a81dceaca39066f11cf75).

| Требование | Статус | Реализация / свидетельство |
| --- | --- | --- |
| Host-bound Shell v2.1 | PASS (static/runtime) | Канонический source kit включён build-time в автономный bundle; корень не использует `position: fixed`, `100vh` или `100dvh`. |
| Header 60 px и Bottom Tab Bar 64 px | PASS (static/runtime) | Каноническая оболочка, плашка заголовка 52 px, пять вкладок, MDI-иконки вкладок 26 px. Safe area принадлежит оболочке. |
| Плашка заголовка, вариант Б | PASS (static/Chromium) | Строка `UI vX.Y.Z / A.B.C` берёт версию UI из сборки, а версию интеграции из конфигурации панели. Обе версии помещаются на одной строке от 320 px. |
| Единственный рабочий viewport | PASS (static/runtime) | `.nikas-shell__viewport` содержит `.nikas-shell__canvas` и frame до 1280 px; оболочка монтируется один раз. |
| Граничная прокрутка iOS | PASS (unit/runtime) | Capture-phase non-passive guard v2.1 подключается к host и очищается при disconnect. |
| Масштаб рабочей области | PASS (unit/runtime) | Gesture-only 75–200%; при 100% работает нативная прокрутка, масштабируется только canvas. |
| Возврат с заголовка | PASS (unit/runtime) | Плашка использует объявленный `parent_route` `/home/overview`. Параметры URL, источник открытия и история не переопределяют маршрут. |
| Refresh v1.3 | PASS (production harness/Chromium) | Цвет стрелки следует теме HA. Вращение 900 мс на оборот, busy не менее 900 мс, результат 1400 мс. Повтор отменяет таймер результата. Отказ HA и ошибка Recorder отображаются как ошибка обновления. |
| Стабильное обновление телеметрии | PASS (unit/runtime) | `set hass()` объединяет обновления в animation frame и меняет только существующие текст/классы. |
| Кэш посещённых вкладок | PASS (unit/runtime) | Каждая вкладка создаётся один раз и остаётся в `Map`. |
| Явная недоступность данных | PASS (unit/runtime) | `unknown`, `unavailable`, отсутствие и нечисловые значения отображаются как «Нет данных». |
| Безопасность команд | PASS (unit/runtime) | Нет управления водой; Refresh вызывает только `homeassistant.update_entity` и чтение Recorder. |
| Автономный production bundle | PASS | Один детерминированный JS без runtime-импортов; входные файлы отмечены и закреплены в профиле. |
| Lifecycle / ownership маршрута | PASS (static) | При коллизии чужой `/dashboard-water` не присваивается интеграции и не удаляется при unload. |
| Полнота расхода | PASS (29 production tests) | Итог только при покрытии всех завершённых часов обоих счётчиков и наличии соседнего исходного часа; пропуски не становятся нулями. |
| Геометрия заголовка в браузере | PASS (Chromium, тестовые данные) | 12 сочетаний размера и боковой панели в каждой из двух тем. Проверены размеры и положение заголовка и кнопок, одна строка версий, прокрутка и смена состояния Refresh. |
| Фактическая HA/iPhone-приёмка | GAP | Нужны установка опубликованной версии, проверка Recorder, pinch/reset, длинных и коротких вкладок, offline/recovery и маршрутов возврата. |

Копии нормативных документов и `templates/shell_v2/nikas-specialized-shell.js` проверяются по SHA-256. Статический PASS не заменяет browser/device acceptance и не подтверждает внешнюю доступность источников данных.
