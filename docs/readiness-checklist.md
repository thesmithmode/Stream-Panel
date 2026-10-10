# Готовность серверной Stream Panel 0.1

Текущая архитектура: постоянно работающий Linux-сервер, HTTPS-панель в браузере, два аккаунта с изолированными профилями и одна SQLite. Зашифрованные локальные резервные копии обязательны; загрузка в Supabase Storage включается отдельно. Десктопный v0.0.4 — исторический выпуск. Windows-установщики, синхронизация двух БД и остановка чужого desktop daemon больше не входят в план.

## Реализовано и проверяется автоматически

| Поведение | Где реализовано / проверено |
| --- | --- |
| Парольный вход, CSRF, отзыв и сохранение сессий, ограничения попыток, закрытые API | `auth.ts`, `hosted.ts`; auth/hosted tests, двухпрофильный browser E2E |
| Разделение Twitch/DA/YouTube, истории и записей Руслана и Гульназ | Profile DB proxy, отдельные workers/configs; profile isolation + hosted tests |
| Атомарные записи, ревизии merge/undo/split, SQLite WAL + busy timeout | Core transactions, worker queue; concurrency/conflict tests |
| Twitch и DA: подключение, refresh, reconnect, дедупликация и отмена поздних ответов | Provider tests + integration lifecycle/wire tests |
| YouTube: OAuth PKCE, live chat, история курсоров, отчёты своего канала, общая квота | YouTube tests; реальный вход ещё нужен |
| Категория, заголовок и счётчики эфира из Twitch | `stream_samples`, Twitch reconcile, analytics tests |
| Отдельная аналитика, ядро, категории, дни/часы, возвращения и минутные сигналы | `analytics.ts`, `Analytics.svelte`, `TrendChart.svelte`; core + browser tests |
| Исключения владельцев и ботов из персональной статистики | ID владельца + имена/aliases; тесты с переименованным owner, jeetbot, fullrandomname_twitch, обеими формами StreamElements |
| Полный пустой опрос отличается от сбоя/неизвестности; оценка YouTube помечена отдельно | Presence/analytics tests + UI; личного времени просмотра API не предоставляет |
| Шифрованная локальная копия обоих профилей и restore с отзывом сессий; cloud upload в Supabase — optional | `backup.ts`, backup tests; live restore ещё не подтверждён |
| Server-only Linux amd64 bundle, привязанный к SHA; Bootstrap и Deploy повторно используют CI artifact с retention 30 дней | Quality gate artifact + `ops/receive.py`; production deployment ещё не выполнен |
| Отдельные пользователи/каталоги/unit, ограничения ресурсов, существующий Traefik route и закреплённый SSH host key | `ops/bootstrap-traefik.sh`, `docs/ops/server.md`; настройка ждёт завершения CI |

## Что обязательно подтвердить на живой инфраструктуре

1. Повторить read-only preflight перед bootstrap. Последняя read-only инвентаризация подтвердила Ubuntu 24, около 3,4 GiB RAM, около 2 GiB доступной RAM, около 16 GiB свободного диска, существующий Traefik на 80/443, route directory `/root/traefik/config` и адреса bridge/proxy `172.21.0.1`/`172.21.0.2`. Свободный диск превышает bootstrap-порог 3 GiB в `/opt`; повторить проверку перед установкой.
2. Завершить CI на точном SHA текущей `main`, проверить server bundle artifact и вручную запустить Bootstrap private server. До этого сервис не развёрнут. Bootstrap добавляет отдельный Traefik route и не должен заменять существующую конфигурацию.
3. Проверить публичный HTTPS и закрытый API извне. Убедиться, что hostname и сертификат работают через имеющийся Traefik.
4. GitHub production secrets, первое обновление через CI/CD и rollback на самом VPS. Наличие workflow и artifact не означает выполненный deployment.
5. Перенос исходной пользовательской SQLite в нужный профиль до начала нового сбора. Тестовые данные не заменяют историю.
6. Реальные Twitch/DA/YouTube авторизации Руслана; Гульназ подключает свои аккаунты позже.
7. Проверить локальную encrypted копию и восстановление. Supabase Storage optional: для включения задать `STREAM_PANEL_CLOUD_BACKUP_ENABLED=true`, `STREAM_PANEL_SUPABASE_URL` и `STREAM_PANEL_SUPABASE_KEY`; без этого bootstrap проверяет локальную копию. Живые upload/download/restore не подтверждены.
8. Длительный одновременный эфир Twitch+YouTube, перезапуск/обрыв сети/refresh, два браузера и обоих профиля. Автотесты с fixtures не заменяют этот прогон.
9. Контроль роста данных: текущий backup ограничен SQLite 40 MiB и объектом 48 MiB; нужно расширить формат/потоковую обработку до превышения. Квоты и свободное место показывать и наблюдать в эксплуатации.

Политика качества: минимум 95% строк, ветвлений и функций в суммарном backend + браузерном отчёте, плюс отдельная проверка строк каждого учитываемого файла. Порог не снижать и исключения не добавлять. По прямому указанию пользователя от 2026-10-09 полезные изменения перенесены в `dev`, дальнейшая работа ведётся там. Перенос в `main`, релиз и production deployment требуют зелёного gate текущего SHA.

Предыдущий результат с порогом 90% не подтверждает готовность. Последний полный локальный прогон: 229 тестов приложения и 10 deploy-проверок проходят; lines 99,23%, functions 95,08%, branches 91,90% — gate красный. Текущий статус и оставшаяся работа: [development-checkpoint.md](development-checkpoint.md). Проведена read-only инвентаризация; bootstrap, deployment и live restore не выполнены.

Состояние deployment и актуального Quality gate проверяется по Actions для точного SHA текущей `main`. Исторические локальные coverage-результаты выше не подтверждают зелёный gate текущего кода. Bootstrap и production deployment остаются ожидающими до завершения CI и прохождения preflight по свободному месту.
