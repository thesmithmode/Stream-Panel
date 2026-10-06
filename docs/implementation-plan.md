# Дальнейшая реализация

2026-10-06: ранняя программа уже запускается. Ветка codex-init от dev, без merge в main. PRD остаётся целевой v1; следующие задачи не скрыты как «готово».

## Сделано

Локальный daemon +worker+SQLite migrations, adapters Twitch/DA, DCF/Authorization Code, HTTP local auth/CSRF, сессии, exact money/dedupe, aliases, candidate suggestions, merge/undo/split, Svelte screens, minute grid и verified local backup.27 автотестов, strict build, production UI и реальные browser actions проходят на Linux. CI matrix Ubuntu/Windows настроена.

## Очередь с зависимостями

| Приоритет | Задача                       | Условие готовности                                                                                                                                                                                                               |
| --------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0        | Живой Twitch test            | Public DCF/refresh/validate, chat+moderation, rights, полный Chatters, stream detection, reconnect handoff, unexpected break. Fixtures обезличены, IDs в базе сверены                                                            |
| P0        | Живой DA test                | Localhost redirect+state, token rotation, legacy connect/ACK/heartbeat, REST+WS одного alert, timezone calibration, missed-event backfill. Если callback запрещён — отдельное решение по auth distribution, не встроенный secret |
| P0        | Windows/Mint install и 8hsoak | Native addon/build/start, права папки, второй writer, shutdown/sleep/network,1000chatters и ratebudget. CI не заменяет целевой ПК                                                                                                 |
| P0        | Hardening                    | Все POST schemas, internal503/500 mapping, durable gaps при worker overflow/disk errors, generation races auth/reconnect, shutdown timeout, moderation reordered/delete-before-message                                           |
| P1        | История и отчёты             | Cursor pagination, interval/currency/identity filters, shared query contract, bot exclusions, tops и person/session totals. Годовой dataset с p95 ипамятью; materialized rollups только по измерению                               |
| P1        | Сопоставления                | Отказ пары; owner rules(scope,exact normalized name,target,validity), preview и apply-history; коллизия не склеивает; revisions/audit/undo tests                                                                                  |
| P1        | Время DA                     | Проверенный source timezone, DST ambiguity и preview historical reprojection; неизвестный rawtime остаётся доступным                                                                                                              |
| P1        | Backup automation и restore   | Scheduler5min/rotation3copies как цель; verified restore вновую папку, interrupteddiskfailure; read-only validation CLI                                                                                                          |
| P1        | Секреты                      | OS credential store илиизмеренный безопасный fallback; WindowsACL, экспортбез секретов, reauthmigration                                                                                                                           |
| P2        | Optionalcloud                | Encrypted snapshots→upload илипроверенная Litestreamstrategy; actualR2quotausage/restore/keyrecovery; singlewriter                                                                                                               |
| P2        | Поставка                     | Автостарт под пользователем, installer Win/Linux, reproducible signed builds при необходимости                                                                                                                                    |
| P3        | Streamer.bot                 | Официальный WSclient, реальные IDfixtures; запрет unsafe direct+bridge duplicate path                                                                                                                                            |

## Как начать разработчику

Установить README версии, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm start`. В браузере открыть напечатанную ссылку. Бизнес-логику писать в core, provider parsing — в adapter; SQL не пробрасывать в UI. Изменение schema — следующая транзакционная migration, существующие БДнеудалять. Реальные токены/чаты/backup не коммитить.

Каждый PR описывает конкретное новое поведение и проверку. Подключения, облако и Windows отмечаются доказанными только после соответствующего эксперимента. Срок до полной v1 сейчас не оценивается по догадке.

## Решения владельца

Новых продуктовых ответов для продолжения локальной реализации не требуется: исходные требования есть в docs/user-requirements.md. Аккаунтные gates требуют входа владельца/контрольного эфира и доната, а не передачи секретов в переписке. Точный donor identity API непредоставляет — это ограничение платформы, не вопрос, который владелец может исправить ответом.
