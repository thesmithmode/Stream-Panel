# Последовательный план до стабильного выпуска
- Последние указания пользователя: работать маленькими шагами по порядку; оба аккаунта видят оба профиля; Aeza не трогать; сервер меняется только GitHub Actions из main; код только dev/side; релизы только main; итоговые ветки только dev/main.
- После каждой микрозадачи: содержательная проверка, исправление ошибок, отдельный связный коммит. Следующий этап не прикрывает незавершённость предыдущего.
## 1. GitHub, ветки и данные
- Завершить GitHub CLI авторизацию, проверить аккаунт/права, обновить refs/CI/releases. Все запросы GitHub вне песочницы.
- Проверить каждую ветку через историю, patch equivalence и diff дерева; сохранить полезные несмердженные изменения. Аудит уже записан в audit-branches.md; удаление после выпуска.
- Проверить Supabase eyverhyrhibwyiipgozn, сохранить имеющиеся данные, найти настоящую Linux SQLite/config/ключи, сверить counts и integrity/FK. Старый экспорт сохранён; Storage пуст; настоящая история пока отсутствует.
- Закрыть публичный доступ к старым таблицам, проверить anon CRUD deny и сохранность service_role/data. Выполнено и проверено; SQL supabase-privacy.sql.
- Сопоставить каждый пункт исходной постановки, бэклога и фактического кода/тестов; исправить ложные DONE и 90% gate. Аудит audit-product-requirements.md, текущий порог до исправления90%.
## 2. Авторизация и профили — A01–A06
- Сохранить серверный парольный вход/сессии, защитить все API и файлы копий; проверить CSRF, logout, expiry, rate limit и неверные credentials.
- Разделить account identity и request profile; обоим аккаунтам разрешить оба профиля без глобальной области. Связать OAuth state с профилем/инициатором.
- Проверить profile tables/FK/migrations, одинаковые внешние ID, два клиента, concurrent read/write.
- Добавить UI-переключение, сброс/remount всех страниц и ошибок, отбрасывание поздних ответов/действий, сохранение выбора; закрепить sidebar на ПК/телефоне.
## 3. Автоматический сбор — B01–B10
- Стартовать оба профиля без браузера; удалить ручную запись из UI.
- Twitch/YouTube offline5мин, online минутные метрики; online notification проверяет сразу. Чат принимает события по лимитам платформ.
- Общий logical stream с отдельными platform IDs/URLs/samples; закрытие после окончания всех площадок, malformed/error не offline.
- Рестарт сохраняет активный stream без дубликата, gaps отражают реальные пропуски.
- DA работает во время эфира; отдельные history import/manual actions; дедупликация.
- Безопасно удалить ошибочную manual session, сохранить/перепривязать реальные события; группировать повторные ошибки и сбрасывать текущую ошибку после recovery.
## 4. Данные и люди — C01–C14
- Категории Twitch и channel.update по времени, backfill только подтверждённых исторических значений.
- Исключить owners/bots/frankie_showman из персональных агрегатов, сохранить сырые события.
- Общий Person: Twitch/DA/YouTube identities; однозначный nick auto-link Twitch/DA, ручной YouTube link, manual link/unlink без потери событий.
- Manual donations: amount/currency/date/time/message/source, CRUD, аудит и tombstones против повторного импорта.
- Anonymous entity и привязка одного donation к Person; согласованные donation counts/totals и неизвестные времена/валюты.
- Profile-scoped tags/manual core; атомарные timestamp notes CRUD с сохранением createdAt.
- Подтверждённые first observation/follow, без подмены донатом; полезные исходные сигналы без дубликатов метрик.
## 5. Метрики — D01–D09
- Total observed duration, avg только visited streams, attendance visited/recorded без donation-only, observed intervals before follow; unknown остаётся unknown.
- Unique/peak/mean chatters и отдельные platform viewers; messages/hour, donations/hour по валютам, activity/viewer с корректными знаменателями.
- Одно core audience: правило регулярности плюс manual tag, без конкурирующих постоянников.
- Category/hour effectiveness с exposure/coverage; gaps не0 viewers, среднее только covered intervals.
## 6. Основные экраны — E01–E11
- Сессии→Стримы; Overview aggregate channel/period, stream detail открывается из истории.
- Полезный список streams: date/duration/category/state/metrics, platform hyperlinks только подтверждённые.
- Ровные responsive KPI, крупный минутный chart activity/presence/peaks, event filters и список chatters/message counts без ботов.
- Убрать technical clutter/status duplicates/последние200/ненужные Person fields; help popover click/Escape/outside и phone readability.
## 7. Аналитика — F01–F12
- Arbitrary start/end +7/30/90/180/365/all; независимый category catalog; filters auto apply, убрать Apply/auto checkbox/timezone/display clutter.
- Dynamics stream duration/frequency/messages; individual time-of-day intervals через midnight, обрезать только общий unused gap.
- Absolute и per-hour presence/messages/donations; days/hours mean activity map с легендой.
- Stream comparison category/peak/mean viewers/chatters/messages/donations/new/returning; audience search/sort и один core filter.
## 8. Интеграции и бэкапы — G01–G07
- YouTube только integration рядом Twitch/DA; общий stream/person/analytics UI. Подробные guides с official clickable links и текущими redirects.
- Проверить YouTube OAuth/live counters/chat/quota/pollingIntervalMillis; не выдумывать скрытых viewers.
- Backup directory/files/authenticated download; local OS folder action только локально, на VPS browser download.
- Local и Supabase результаты раздельно; cloud failure не скрывает local success. Encryption/private bucket/service key только backend, rotation+restore и внешний AES key copy.
## 9. CI/CD, приёмка и релиз — H01–H05
- Для fixes regression tests; types/lint/detect cheap gates; N>0 каждой группы, unit/integration/E2E, combined lines/branches/functions≥95%, без exclusions для скрытия провала.
- Desktop/mobile rendered QA: login/profile/long page/filters/graphs/Person/popovers/download.
- Main-only bootstrap/configure/import/deploy через Actions. Существующий RackNerd Traefik получает отдельный route; не заменить чужой proxy, не трогать Aeza. Accounts/secrets/env/service/TLS/data только workflow.
- Подготовить закрытую конфигурацию Supabase Storage и перенос истории; healthcheck точного SHA, согласованный snapshot и rollback.
- Push рабочей ветки/сведение dev только после локальных проверок; дождаться terminal dev CI, исправить failures.
- Squash dev→main после green gates; только main собирает stable/latest release и деплой. Дождаться terminal CI/release/deploy.
- Проверить публичный HTTPS/сертификат, оба accounts/profiles, anonymous deny, phone access, отсутствие secret exposure, server restart/collection/backup/restore/rollback. Реальный OAuth+эфир отдельно от fixtures.
- Актуализировать PRD/spec/API и честный backlog; сохранить память с коммитом. Синхронизировать итоговый код dev/main, удалить все ненужные side branches, проверить clean status.
## Что означает завершение
- Пользователь открывает проверенный HTTPS URL с ПК/телефона без туннеля; входит в один из двух accounts и выбирает оба раздельных профиля.
- Посторонний не читает статистику/файлы/секреты и не меняет данные; серверные проверки подтверждены.
- Сбор переживает закрытие браузера и рестарт, ошибки не создают ложное завершение/дубли.
- Local+private Supabase backup проверены восстановлением; история перенесена либо отсутствие исходника явно обозначено как незавершённое требование.
- Только актуальные dev/main, green CI, stable main release и здоровый exact-SHA deployment. Не подтверждённый live test не объявляется выполненным.
## Почему такое решение, даже если кажется странным:
- Основа dev сохраняет авторизацию, которую main удалил. При итоговом squash вернуть защиту и сохранить необходимые release изменения; напрямую main не редактировать.
- Бесплатное DNS-имя на IP заменяет покупку домена; приватность обеспечивает backend auth. Существующий Traefik использовать, поскольку80/443 заняты.
- Присутствие в чате и YouTube chat estimate не являются доказанным просмотром видео; неизвестность нельзя заменить нулём или выдуманной точностью.
