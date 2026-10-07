# HTTP API ранней версии

Это контракт реализованных routes в `apps/daemon/src/server.ts`, а не список будущих endpoints. База URL: `<HTTPS origin>/api/v1`. Ответы JSON, времена UTC epoch milliseconds; отсутствующее время — null, деньги в minor units — **строки**. UI отображает время в зоне браузера.

## Вход и защита

Серверный вход: POST /auth/login {username,password} → {csrf,user}; публичной регистрации и /bootstrap нет. Secure HttpOnly SameSite=Lax cookie sp_session на / действует 24 часа, хранится в SQLite в виде хэша. GET /auth/me возвращает свой профиль; POST /auth/logout требует CSRF и отзывает текущую сессию. Перезапуск не отзывает сессии автоматически. Все записи требуют точный Origin и X-CSRF-Token, точный Host проверяется для всех запросов. API профиля выбирается сервером из сессии, клиент не передаёт profile ID для доступа к чужой базе.

Публичный URL — HTTPS за reverse proxy; backend слушает только 127.0.0.1. GET /healthz проверяет workers без токенов/учётных данных, возвращает ok и release. Во время maintenance API возвращает 503 SERVER_UPDATING. OAuth callbacks DA/YouTube требуют ту же парольную сессию и short-lived одноразовый state. Утилита createApplication сохраняет старый локальный bootstrap только для низкоуровневых fixture-тестов; production entrypoint использует createHostedApplication.

YouTube: POST /youtube/connect {clientId,clientSecret?} → {url}, GET /oauth/youtube/callback, POST /youtube/disconnect {}, GET /youtube/data → {snapshots,messages}. Секреты и токены никогда не выдаются; snapshots/report, channel, broadcasts и ограниченные последние 200 сообщений принадлежат подключённому каналу текущего профиля. Денежные значения YouTube amountMicros хранятся в исходном строковом формате, не суммируются с minor units DA. POST /backup — общий шифрованный снимок обоих профилей, возвращает только имя закрытого серверного файла. Не чаще 1 запроса/10 минут, без настроенного backup key — 503 BACKUP_NOT_CONFIGURED; скачивания базы через API нет.

## Чтение

| GET path                  | Параметры                             | Ответ                                                                                                                                      |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/status`                 | —                                     | Twitch/DA `{state,detail,account?,capabilities,lastEventAt?}`, device, публичная config, csrf и gaps. Секретов нет                         |
| `/sessions`               | —                                     | До100 последних: id, account_id, stream_id, kind, started_at_ms, recording_started_at_ms, ended_at_ms, end_quality, event_count            |
| `/summary`                | `session?`                            | Базовые KPI + uniquePersons/Identities, messagesPerMinuteOfSession, coverage, chattersOverTime, gapCount, uniquePersonsObserved. Chatters — из последнего complete poll, не Twitch view count |
| `/events`                 | `session?`, `person?`, `from?`, `to?` | До200 событий, по времени убывание. `[from,to)` фильтрует known occurred_at; unknown не попадает в time range                              |
| `/persons`                | `search?`                             | До500 групп с identity; поиск по имени/aliases; id, display_name, revision, event_count, sources                                           |
| `/persons/:id`            | —                                     | Person, identities, aliases, последние200events                                                                                            |
| `/persons/:id/stats`      | `session?`                            | KPI: messageCount, donationTotals, first/last event & observed, observedMinutesThisSession, avgObservedMinutes, avgFirstObservedOffsetMs   |
| `/persons/tops`           | `by=messages\|donations\|observed_minutes`, `session?`, `limit?` | Топ людей (до100); честные метки messages/donations/observed minutes                                                       |
| `/insights`               | `session?`                            | Карточки паттернов (regular, chatty_absent, silent_presence, donor_no_twitch, first_timer, coverage_hole, collection_gaps, returning_after_gap); пустой массив если нет |
| `/persons/:id/candidates` | —                                     | Person IDs по имени группы и identity aliases; предложение, не подтверждение                                                               |
| `/presence`               | `session`, `person`, `from`, `to`     | `{minuteStartMs,state}[]`; state: observed / not_observed / unknown; UTC minute boundaries, диапазон≤31days                                |
| `/merges`                 | —                                     | До100 аудитов: id, source_person_id, target_person_id, created_at_ms, undone_at_ms                                                         |

Event содержит id (JSON tuple string, не UUID),source,account_id,external_id,type,identity_id,display_name,person_id,occurred_at_ms,received_at_ms,source_time,time_quality,transport,payload. В API нет raw payload_json. В donation payload: amountMinor,currency,text,actorName. Неподтверждённое время видно явно. Person IDs / identity IDs / session IDs — UUID.

## Изменения

| POST path                    | JSON body                                                               | Результат / инвариант                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sessions/start`            | `{}`                                                                    | `{id}`; manual session; существующая открытая запись →409                                                                                                   |
| `/sessions/:id/stop`         | `{}`                                                                    | `{ok:true}`; только manual; platform управляется Twitch reconcile                                                                                           |
| `/persons/:id/rename`        | `{name}`                                                                | `{ok:true}`; непустое имя≤200 символов                                                                                                                      |
| `/persons/merge`             | `{sourceId,targetId,sourceRevision,targetRevision}`                     | `{id:mergeId}`; ревизии обоих составов проверяются; конфликт409                                                                                             |
| `/merges/:id/undo`           | `{}`                                                                    | `{ok:true}`; состав и ревизии должны совпасть                                                                                                               |
| `/persons/split`             | `{identityIds:string[],name,revision}`                                  | `{id:newPersonId}`; все identity из одной группы, ревизия совпадает. Fact IDs сохраняются                                                                   |
| `/twitch/connect`            | `{clientId,extended?:boolean}`                                          | `{verificationUri,userCode,expiresAt}`; async DCF, состояние через status                                                                                   |
| `/twitch/disconnect`         | `{}`                                                                    | `{ok:true}`; остановка и удаление access/refresh                                                                                                            |
| `/donationalerts/connect`    | `{clientId?,clientSecret?,accessToken?,refreshToken?,utcOffsetMinutes}` | Offset — integer от−840 до840 или null. При accessToken `{ok:true}`, иначе `{url}`. Пустые Client ID/secret сохраняют прежнее; null оставляет время unknown |
| `/donationalerts/disconnect` | `{}`                                                                    | `{ok:true}`; удаляет access/refresh и отменяет OAuth state                                                                                                  |
| `/donationalerts/rescan`     | `{}`                                                                    | `{ok:true}` означает запуск, не завершение; результат в capabilities.history                                                                                |
| `/backup`                    | `{}`                                                                    | `{filename}` после online backup, verification и atomic rename в backups                                                                                    |

DA OAuth callback: `GET /oauth/donationalerts/callback?code=…&state=…`. Отсутствующий/неверный state отвергается, обмен кода не происходит. Это штатный redirect провайдера; не хранить его URL в отчётах.

## Ошибки и ограничения

`{error:"UPPERCASE_CODE"}`:401 вход,403Host/Origin/CSRF,409 конфликт,404 не найдено,400 некорректный запрос,413 превышение body limit,503 недоступность worker/хранилища,500 неизвестный внутренний отказ. Ошибки валидации Fastify не выводят тело/секреты; UI показывает ошибку, не подменяет её успехом.

Нет cursor pagination, общего currency/excluded-identity фильтра, экспорта и durable rejection/owner rules. Лента честно показывает лимит 200. Для выбранной минуты UI делает отдельный запрос к базе, поэтому старые минуты доступны независимо от последних 200 глобальных событий. Person-list ограничен 500, поиск выполняется сервером.

Same-origin policy и ошибки проверены HTTP injection tests и работающим браузером. JSON schema есть на каждом POST: лишние поля отвергаются, преобразование строк в числа/boolean отключено, массив split имеет ограничение и уникальные ID. Ошибка остановленного worker/очереди/SQLite возвращает 503; конфликт — 409, отсутствующий объект — 404. Ошибки проверки входных данных возвращают 400, превышение body limit — 413; известные файловые отказы — 503, неизвестные внутренние ошибки — 500. Пути файлов и SQL из сообщений ошибок не выдаются клиенту.
