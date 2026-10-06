# HTTP API ранней версии

Это контракт реализованных routes в `apps/daemon/src/server.ts`, а не список будущих endpoints. База URL: `http://127.0.0.1:47831/api/v1`. Ответы JSON, времена UTC epoch milliseconds; отсутствующее время — null, деньги в minor units — **строки**. UI отображает время в зоне браузера.

## Вход и защита

Первый адрес приложения содержит `#key=…` (одноразовый nonce, TTL10min). UI отправляет `POST /bootstrap {"key":"…"}`, получает `{csrf}` и HttpOnly SameSite=Strict cookie `sp_session` на `/api` на 24h, удаляет fragment. Все остальные API требуют cookie; каждый POST — `Content-Type: application/json` и `X-CSRF-Token`. `GET /status` возвращает текущий CSRF для восстановления вкладки. Cookie и CSRF сбрасываются при перезапуске демона.

Точный Host localhost/127.0.0.1 с портом; Origin допускает только эти адреса этого порта; CORS отсутствует. Не открывать LAN. Bootstrap не является постоянным bearer token. OAuth callback DA расположен вне `/api`: проверяет отдельный short-lived state, после успеха возвращает на 127.0.0.1.

## Чтение

| GET path                  | Параметры                             | Ответ                                                                                                                        |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| `/status`                 | —                                     | twitch,donationalerts `{state,detail,account?,capabilities,lastEventAt?}`, device?, публичная config,csrf,gaps. Секретов нет |
| `/sessions`               | —                                     | До 100 последних: id,account_id,stream_id,kind,started_at_ms,recording_started_at_ms,ended_at_ms,end_quality,event_count      |
| `/summary`                | `session?`                            | `{messages,donations,totals:{RUB:"25000"},chatters:number                                                                    | null,lastPollAtMs:number | null,events}`. Без session — вся история         |
| `/events`                 | `session?`, `person?`, `from?`, `to?` | До 200 событий, по времени убывание. `[from,to)` фильтрует только known occurred_at; unknown не попадает в time range         |
| `/persons`                | `search?`                             | До 500 групп с identity, search по имени/aliases; id,display_name,revision,event_count,sources                                |
| `/persons/:id`            | —                                     | Person + identities, aliases, последние 200events                                                                             |
| `/persons/:id/candidates` | —                                     | Массив Person IDs по нормализованному имени группы и сохранённым identity aliases; это предложение, не подтверждение         |
| `/presence`               | `session`, `person`, `from`, `to`     | `{minuteStartMs,state}`[], state=`observed                                                                                   | not_observed             | unknown`; UTC minute boundaries, диапазон≤31days |
| `/merges`                 | —                                     | До 100 аудитов объединений: id,source_person_id,target_person_id,created_at_ms,undone_at_ms                                   |

Event содержит id (JSON tuple string, не UUID),source,account_id,external_id,type,identity_id,display_name,person_id,occurred_at_ms,received_at_ms,source_time,time_quality,transport,payload. В API нет raw payload_json. В donation payload: amountMinor,currency,text,actorName. Неподтверждённое время видно явно. Person IDs / identity IDs / session IDs — UUID.

## Изменения

| POST path                    | JSON body                                                                    | Результат / инвариант                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sessions/start`            | `{}`                                                                         | `{id}`; manual session; существующая открытая запись →409                                               |
| `/sessions/:id/stop`         | `{}`                                                                         | `{ok:true}`; только manual. Platform сессией управляет Twitch reconcile                                 |
| `/persons/:id/rename`        | `{name}`                                                                     | `{ok:true}`; непустое имя≤200 символов                                                                   |
| `/persons/merge`             | `{sourceId,targetId,sourceRevision,targetRevision}`                          | `{id:mergeId}`; оба состава проверяются; конфликт 409                                                    |
| `/merges/:id/undo`           | `{}`                                                                         | `{ok:true}`; составы и ожидаемые ревизии должны совпасть                                                |
| `/persons/split`             | `{identityIds:string[],name,revision}`                                       | `{id:newPersonId}`; все identity из одной группы, ревизия совпадает, новый Person. Fact IDs сохраняются |
| `/twitch/connect`            | `{clientId,extended:boolean}`                                                | `{verificationUri,userCode,expiresAt}`; async DCF. Состояние через/status                               |
| `/twitch/disconnect`         | `{}`                                                                         | `{ok:true}`; остановка и удаление сохранённых access/refresh                                            |
| `/donationalerts/connect`    | `{clientId?,clientSecret?,accessToken?,refreshToken?,utcOffsetMinutes:number | null}`                                                                                                  | При accessToken `{ok:true}`, иначе `{url}` для Authorization Code. Пустые Client ID/secret сохраняют предыдущие. null offset оставляет время unknown |
| `/donationalerts/disconnect` | `{}`                                                                         | `{ok:true}`; удаляет access/refresh                                                                     |
| `/donationalerts/rescan`     | `{}`                                                                         | `{ok:true}` означает запуск, не завершение; результат в capabilities.history                             |
| `/backup`                    | `{}`                                                                         | `{filename}` после online backup + verification + atomic rename в data-dir/backups                      |

DA OAuth callback: `GET /oauth/donationalerts/callback?code=…&state=…`. Отсутствующий/неверный state отвергается, обмен кода не происходит. Это штатный redirect провайдера; не хранить его URL в отчётах.

## Ошибки и ограничения

`{error:"UPPERCASE_CODE"}`:401 вход,403Host/Origin/CSRF,409 конфликт,404 не найдено,400 некорректный запрос/остальные санитизированные ошибки. В текущей версии не все внутренние DB/provider ошибки имеют отдельный 503/500; UI показывает ошибку, не подменяет её успехом. Ошибки валидации Fastify не выводят тело/секреты.

Нет cursor pagination, общего currency/excluded-identity фильтра, экспорта и durable rejection/owner rules. Лента честно показывает лимит 200. Для выбранной минуты UI делает отдельный запрос к базе, поэтому старые минуты доступны независимо от последних 200 глобальных событий. Person-list ограничен 500, поиск выполняется сервером.

Same-origin policy и ошибки проверены HTTP injection tests и работающим браузером. JSON schema пока есть на bootstrap; остальные routes используют guards и domain checks. Полная схема каждого POST — задача hardening, не заявленная как уже выполненная.
