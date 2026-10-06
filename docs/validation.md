# Проверки и открытые gates

Дата 2026-10-06, Linux x64, Node24.19.0, pnpm11.25.0, SQLite3.53.4. Результаты относятся к ранней программе. Целевой PRD шире текущего кода.

## Выполнено

| Проверка                         | Результат                    | Что доказывает                                                                                                                               |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | PASS                         | Lockfile соответствует workspace; выбранный native addon реально загружается на Linux                                                        |
| `pnpm check`                     | 27/27PASS                    | Strict TS, реальные SQLite/HTTP/worker тесты, Svelte0errors/0warnings, production build                                                      |
| Деньги/identity                  | PASS                         | Точные cents/large ID; отдельные валюты; одинаковое имя не склеивает, Twitch rename не меняет ID; DA identity соответствует alert occurrence |
| Attribution/audit                | PASS                         | Дедуп WS/REST и transport; merge historical queries, undo, stale revision conflict, split без потери событий                                 |
| Presence                         | PASS                         | Полная пагинация/dedup, partial/failed/cursor cycle; неизвестность отдельно от complete empty; merged union без двойных минут                |
| Сессии/минуты                    | PASS                         | Persisted stream ID, полуоткрытый end, known-time DA→Twitch session, unknown вне сессии, доступ к минуте старше последних 200                 |
| DB persistence/backup            | PASS                         | Файл переживает reopen; snapshot живого writer восстанавливается; integrity/FK/version destination; future schema отвергается                |
| Auth mocks                       | PASS                         | Single-flight rotating public Twitch refresh без secret;429reset блокирует запрос; DA missing/wrong state не вызывает token exchange         |
| Local HTTP protection            | PASS                         | 401 без bootstrap,403Host/Origin/CSRF, nonce reuse401, duplicate recording409, config без секретов                                              |
| Moderation                       | PASS дляполученного удаления | Сохранённый chat text редактируется вБД, анепросто скрывается CSS. Reordered/delete-before-message ещё не gate closed                        |
| CLI launch                       | PASS                         | Настоящий entrypoint открывает staticUI, второй writer на другомпорту отвергается, SIGTERM exit0 и lockcleanup                                   |
| Browser workflow                 | PASS                         | Реальный HTTP+worker+SQLite+productionUI, 13 проверок: запись, merge/undo/split/rename, minutequery, backup, reload, responsive               |

[Browser evidence](browser-results.json): Chromium133 / Playwright, проверены 390/768/1536px, runtime/console errors отсутствуют. Использовалась отдельная временная БД, внешние adapters выключены; Twitch/DA fixtures внедрены тестовым harness, который **не входит в productionAPI**. Никаких real credentials. Это доказывает внутренний цикл, а не подключение к сервису.

## Проверка UI

[Экран первого запуска](assets/overview.png) — реальный render, без seed данных. Перед кодом создан и просмотрен концепт; после сборки просмотрены actual desktop / people / mobile screenshots.

| Критерий    | Оценка / наблюдение                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Layout      | PASS: sidebar, heading, metrics, feed и source rail совпадают с выбранной структурой; на mobile nav переключён в icon+label rows            |
| Typography  | PASS: крупный title, спокойная secondary hierarchy, readablebody; системный sans, без внешнего fontrequest                                    |
| Color       | PASS: graphite background, lavender actions, teal presence; цвета взяты из conceptpalette                                                  |
| States      | PASS: пустые/unknown/disconnected состояния честные, без фиктивных чисел; errors видимы, destructive membership actions требуют явного выбора |
| Interaction | PASS: CTA ведётв forms, кнопки вызываютнастоящий API, merge→undo→split и backup проверены, focusvisible/reducedmotion CSS есть                |

Осознанные отличия от concept: нет desktopwindowtitlebar вобычномбраузере; вместо brandbitmapsnativeTW/DAmarks; обязательные sessions/people/settings добавлены как реальные экраны. Accessibility audit screen-reader/contrast иразные browserengines ещёне проведены; не выдавать наличие focusCSS за полный audit.

## Синтетическая нагрузка

Полный отчёт: [benchmark-results.json](benchmark-results.json).10 000events,480 полных polls по 1000identities =480000memberships, WAL/FULL. В последнем запуске eventinsertp95≈0.395ms, pollbatchp95≈9.26ms, indexedpresencequery≈0.35ms, DB≈54.3MB,RSS≈156.5MB, integrityok.

Это локальный storage smoke, исполненный в одном тестовом процессе; eventloop measurement относится к нему, а не HTTPdaemonworker. Не является 8hsoak, Windowsbenchmark, networktest, годовым reportdataset илидоказательством UIp95<500ms. Сам benchmark невыводитточные 8h приходы/уходы иудаляетвременную БД.

## Открытые release gates

| Gate                    | Нужный эксперимент                                                                                          | Готово когда                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G1 Twitchlive           | Publicapp, ownerDCF, validate/refreshrotation, actualchatters/chat/optionalscopes                           | PlatformIDs/scopes/events сверены с БД; deniedpermissions показываютсяотдельно                                              |
| G2 EventSubrecovery     | Controlledsession_reconnect, abruptdisconnect, restartmidstream, revocation                                 | Handoff бездублей subscriptions; unexpectedgap виден; live-sessionIDstable; lostchat необещаетсявосстановить                    |
| G3 DAauth/protocol      | Ownapp, localhostredirect/state, legacyhandshake/ACK/heartbeat, expiry                                      | Нет embeddedsecret; безопасный state; WS событие и RESTalert не удваиваютсумму; protocoltrace обезличен                          |
| G4 DAtime/history       | Controlleddonation с независимым UTC часом, многопагиннаяистория/reconnect                                      | Sourceoffset подтверждён; unknown неприсваиваетсяпо receivedAt; backfill completeness видна; timezone/DSTpolicy основана на данных |
| G5 Platforms            | CleanWin11x64/Mint22.1x64, nativeinstall, permissions, process/sleep/network                                | Install/build/start/testplusactualstreamrecording; inheritedWindowsACL проверены                                             |
| G6 Soak/performance     | 8h,1000chatters,50events/s и 200/s10sburst; затемгодовой dataset                                              | boundedqueue/memory, errors/gaps, deadlines, queryp95; budgetsPRD измеренына целевом ПК                                        |
| G7 Backup/restore/cloud | Interruptedwrite/full disk, snapshotrestore вновуюпапку, futurescheduler/remoteusage                        | Recovery не портиттекущую БД; confirmedintegrity; cloudkeys/quotas/restore измерены                                             |
| G8 Hardening/data use   | Runtimeinputschemas, diskfaults, auth lifecycle races, reorderedmoderation, Twitchdataretentionrequirements | Проверяемые fail-safe сценарии иофициальныеусловияхранениядо distribution                                                      |

CI matrix Ubuntu/Windows настроена в.github/workflows/core.yml. Результаты workflow проверяются после push отдельно; наличие YAML само по себе не доказывает Windows support. Live OAuth/WS gates требуют входа владельца влокальном UI — токены нельзя передавать в git/переписку.
