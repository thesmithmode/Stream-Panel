# Следующие задачи

2026-10-06: ранняя программа запускается в `codex-init`, созданной от `dev`. В `main` изменения не объединены. PRD остаётся целью v1; таблица показывает оставшуюся работу.

## Реализовано

Локальные daemon, worker и SQLite migrations; адаптеры Twitch/DA; OAuth; защищённый HTTP; сессии; точные деньги и dedupe; aliases и предложения по имени; merge/undo/split; Svelte UI; минутная сетка; проверенный локальный backup.27 тестов, production build и браузерный цикл проходят на Linux. CI проверяет Ubuntu и Windows.

## Очередь

| Приоритет | Задача                         | Условие завершения                                                                                                                                                                                     |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0        | Живой Twitch                   | DCF/refresh/validate, чат/модерация, права, полная пагинация Chatters, stream detection и оба сценария reconnect; сверка platform IDs с БД                                                             |
| P0        | Живой DA                       | Localhost callback и state, ротация токенов, legacy handshake/heartbeat, REST+WS одного alert, проверка source time. Если callback запрещён — отдельное решение по auth, без встроенного общего secret |
| P0        | Целевые ОС и длительная запись | Win11/Mint: чистая установка, native addon, права, второй writer, shutdown/sleep/network;8h и rate budgets PRD                                                                                         |
| P0        | Обработка отказов              | JSON schemas всех POST, отдельные503/500, сохранение gaps при overflow/disk fault, auth lifecycle races, timeout shutdown, reordered moderation                                                        |
| P1        | История и отчёты               | Cursor pagination; единые interval/currency/identity filters; bot exclusions и tops; годовой dataset с измеренными p95/RSS. Rollups добавлять по результатам измерения                                 |
| P1        | Сопоставления                  | Сохранённый отказ пары; owner rules с scope/сроком; preview и apply-to-history; безопасные коллизии, ревизии и аудит                                                                                   |
| P1        | Время DA                       | Проверенная зона источника, DST ambiguity, preview исторической перепроекции; rawtime сохраняется                                                                                                      |
| P1        | Backup/restore                 | Scheduler с целью5min и rotation последних3 snapshot; restore в новую папку; disk failure и interruption tests                                                                                         |
| P1        | Секреты                        | Хранилище ОС или проверенный fallback; Windows ACL; миграция и reauth без экспорта секретов                                                                                                            |
| P2        | Облако                         | Проверенная схема encrypted snapshot upload или Litestream; измеренные квоты R2; восстановление ключа и базы; один writer                                                                              |
| P2        | Поставка                       | Автостарт под пользователем, installer Win/Linux, воспроизводимые сборки                                                                                                                               |
| P3        | Streamer.bot                   | Официальный WS client и реальные fixtures; исходные provider IDs, безопасное исключение дублей direct+bridge                                                                                           |

## Разработчику

Установить версии из README, выполнить `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm start`. Открыть напечатанную ссылку. Бизнес-логика — в core, provider parsing — в adapter; UI не получает SQL/секреты. Новая схема — отдельная транзакционная миграция; существующие БД не удалять. Реальные токены, чат и backup не коммитить.

Каждый PR описывает конкретное поведение и проверку. Документация протокола, mock-тест и живое подключение имеют разные уровни доказательства. Срок полной v1 не оценивается по догадке.

Новых продуктовых ответов для продолжения локальной реализации не требуется: требования есть в `docs/user-requirements.md`. Аккаунтные проверки требуют локального входа владельца и контрольного эфира/доната, а не передачи секретов в переписке. Отсутствие stable donor ID в DA — ограничение API.
