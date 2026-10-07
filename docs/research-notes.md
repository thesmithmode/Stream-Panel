# Research notes (официальные доки)

Дата проверки: **2026-10-06** (МСК); доп. сверка **2026-10-07** (OAuth refresh / EventSub WS / Stream Tools FAQ). Код продукта не писался — только факты для закрытия слепых пятен в спецификации.

| Тема | Источник | Статус |
|------|----------|--------|
| DonationAlerts realtime | [apidoc](https://www.donationalerts.com/apidoc) | Факт |
| Twitch Get Chatters | [Helix reference](https://dev.twitch.tv/docs/api/reference#get-chatters) | Факт |
| Twitch EventSub types | [Subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) | Факт |
| Twitch rate limits | [API guide](https://dev.twitch.tv/docs/api/guide#twitch-rate-limits) | Факт |
| Streamer.bot outbound events | [WS events](https://docs.streamer.bot/api/websocket/guide/events), [WS config](https://docs.streamer.bot/api/websocket/guide/configuration), [UDP](https://docs.streamer.bot/api/udp/guide/configuration) | Факт |
| Litestream → R2/B2 | [S3-compatible](https://litestream.io/guides/s3-compatible/), [S3 guide](https://litestream.io/guides/s3/) | Факт |
| Stream Tools Person-merge | [Stream Tools](https://b1trat3.ru/products/stream-tools) | Локальная БД — факт; Person/merge — **неизвестно** |

---

## 1. DonationAlerts — realtime донаты

**Источник:** https://www.donationalerts.com/apidoc (проверено 2026-10-06).

### Как получать донаты в realtime

Официальный путь — **Centrifugo WebSocket**, не long-poll как основной канал.  
**Гипотеза «websocket vs REST» закрыта:** WS — основной realtime; REST `/alerts/donations` — только history/backfill.

1. OAuth 2.0 Authorization Code → `access_token`.
2. `GET https://www.donationalerts.com/api/v1/user/oauth` (scope `oauth-user-show`) → в ответе `data.socket_connection_token` и `data.id` (user id).
3. Открыть `wss://centrifugo.donationalerts.com/connection/websocket`, отправить connect с `socket_connection_token` → получить Centrifugo **UUIDv4 client id**.
4. `POST https://www.donationalerts.com/api/v1/centrifuge/subscribe` с `Authorization: Bearer <token>`, body `{"channels":["$alerts:donation_<user_id>"], "client":"<uuidv4>"}`.
5. По тому же WebSocket подписаться на канал (`method: 1`) с выданным channel token.
6. События донатов приходят в канал `$alerts:donation_<user_id>`; payload — тот же donation resource, что в REST-списке.

**Fallback / backfill:** `GET /api/v1/alerts/donations` (scope `oauth-donation-index`), пагинация `page`.

### OAuth scopes (из таблицы Scopes)

| Scope | Зачем нам |
|-------|-----------|
| `oauth-user-show` | Профиль + `socket_connection_token` |
| `oauth-donation-subscribe` | Подписка на realtime `$alerts:donation_*` |
| `oauth-donation-index` | REST-список донатов (бэкап/догон) |

Также в доке есть `oauth-goal-subscribe`, `oauth-poll-subscribe` — не MVP.

### Idempotency

- У доната есть целочисленный **`id`** («unique donation alert identifier») в REST и в том же resource в Centrifugo.
- Использовать `donationalerts:{id}` как `NormalizedEvent.id`.
- Поля: `username`, `message`, `amount`, `currency`, `created_at`, `message_type`, `is_shown`, …

### Rate limits

- HTTP API: **60 запросов в минуту на приложение** («1 request per second») — раздел Limitations.
- На WebSocket отдельного числового лимита в apidoc нет; HTTP subscribe/OAuth укладывать в 60/min.

---

## 2. Twitch Get Chatters

**Источник:** https://dev.twitch.tv/docs/api/reference#get-chatters

| Параметр | Факт |
|----------|------|
| URL | `GET https://api.twitch.tv/helix/chat/chatters` |
| Scope | **`moderator:read:chatters`** (user token; либо app token с prior user auth на этого модератора) |
| `broadcaster_id` | Канал |
| `moderator_id` | **Broadcaster или один из его модераторов**; должен совпадать с user id в токене |
| Pagination | `first` min 1 / max **1000** / default 100; `after` cursor |
| Latency | Официально: *«There is a delay between when users join and leave a chat and when the list is updated accordingly.»* Числовой latency в доке **не** указан. |
| Что возвращает | Users **connected to the chat session** (`user_id`, `user_login`, `user_name`) + `total` — это **не** полный список viewers стрима |

### Rate limit и poll 60–120s

- Общий Helix: token-bucket, типичный пример заголовков `Ratelimit-Limit: 800` / минуту на client+user ([guide](https://dev.twitch.tv/docs/api/guide#twitch-rate-limits)). У Get Chatters отдельного «points» в reference нет → default 1 point.
- Official: есть **delay** между join/leave и обновлением списка (без числовой latency в reference).
- Community practice: poll примерно **1–3 мин** из‑за cache; **60s на нижней грани**, разумный дефолт продукта **60–120s** (конфиг).
- При `first=1000` один канал ≈0.5–1 req/min — далеко внутри Helix bucket.
- **Не использовать** устаревший/недокументированный TMI chatters endpoint.

**Broadcaster as mod:** да — `moderator_id` = владелец user-токена; может быть ID самого broadcaster («broadcaster or one of the broadcaster’s moderators»).

---

## 3. EventSub — типы и scopes для MVP

**Источник:** https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/  
Транспорт для локального демона: **WebSocket** (session), см. примеры в тех же страницах.

| Type | Version | Scope / auth (по доке типа) | Condition notes |
|------|---------|-----------------------------|-----------------|
| `channel.chat.message` | 1 | User-token WS: **`user:read:chat`** (не legacy `chat:read` — он не для EventSub). App token: ещё `user:bot` + `channel:bot`/mod | `broadcaster_user_id` + `user_id` (MVP: оба = стример) |
| `channel.subscribe` | 1 | `channel:read:subscriptions` | `broadcaster_user_id` |
| `channel.subscription.gift` | 1 | `channel:read:subscriptions` | `broadcaster_user_id` |
| `channel.subscription.message` | 1 | `channel:read:subscriptions` | resub chat message |
| `channel.cheer` | 1 | `bits:read` | `broadcaster_user_id` |
| `channel.follow` | **2** | `moderator:read:followers` | `broadcaster_user_id` + `moderator_user_id` |
| `channel.raid` | 1 | **No authorization required** | `to_broadcaster_user_id` *или* `from_…` (не оба) |
| `stream.online` | 1 | (в таблице типов; app/user token без особого scope в listing) | `broadcaster_user_id` |
| `stream.offline` | 1 | аналогично | `broadcaster_user_id` |

**Идемпотентность чата:** `event.message_id` у `channel.chat.message`.

**Практический MVP-токен стримера:** один user token broadcaster с суммой scopes:  
`user:read:chat`, `moderator:read:chatters`, `moderator:read:followers`, `channel:read:subscriptions`, `bits:read`  
(+ при bot-модели отдельные bot scopes — post-MVP).

Для `channel.chat.message` в condition обычно `broadcaster_user_id` = `user_id` = id стримера. Legacy IRC scope `chat:read` **не** заменяет `user:read:chat` для EventSub.

Опционально позже: `channel.bits.use` (новый, `bits:read`) — шире чем cheer; MVP достаточно `channel.cheer`.

---

## 4. Streamer.bot — как отдать события наружу

**Источники:**  
- https://docs.streamer.bot/api/websocket/guide/configuration  
- https://docs.streamer.bot/api/websocket/guide/events  
- https://docs.streamer.bot/api/websocket/requests  
- https://docs.streamer.bot/api/udp/guide/configuration  

| Механизм | Роль для нашего адаптера |
|----------|---------------------------|
| **WebSocket Server** | **Основной:** клиент коннектится к `Address:Port` (default `127.0.0.1:8080`), шлёт `Subscribe` с нужными `events`, получает JSON `{ timeStamp, event: { source, type }, data }` |
| **Официальный клиент** | npm/pnpm **`@streamerbot/client`** (`StreamerbotClient`); docs: [Using the Client](https://docs.streamer.bot/api/websocket/guide/client), [events](https://streamerbot.github.io/client/guide/events). Пример: `client.on('Twitch.ChatMessage', …)` / `subscribe: { Twitch: ['ChatMessage'] }` |
| **UDP Server** | В доке — **DoAction** / триггер действий *в* Streamer.bot, не шина исходящих событий аналитики |
| HTTP webhook «из коробки как EventSub» | Не описан как общий outbound event bus в проверенных страницах |

Конфиг WS: Servers/Clients → WebSocket Server; Auto Start default true; опционально Authentication / Enforce + Password (client передаёт `password`).

**Вывод для адаптера:** адаптер **реалистичен** — `StreamerBotAdapter` на `@streamerbot/client` → события вида `Twitch.ChatMessage` и др. → map в `NormalizedEvent`. UDP не использовать как ingest.

---

## 5. Litestream → Cloudflare R2 / Backblaze B2

**Источники:** https://litestream.io/guides/s3-compatible/ , https://litestream.io/guides/s3/

### Минимальный путь (рекомендуем R2 — zero egress)

От пользователя нужно:

1. Аккаунт Cloudflare.
2. R2 bucket (имя).
3. **Account ID** (dashboard → R2).
4. R2 API token с **Object Read & Write**.
5. Установить Litestream рядом с SQLite-файлом демона.
6. `litestream.yml` (пример):

```yaml
dbs:
  - path: /path/to/stream-panel.sqlite
    replica:
      type: s3
      bucket: YOUR_BUCKET
      path: stream-panel
      endpoint: https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
      region: auto
      access-key-id: ${R2_ACCESS_KEY}
      secret-access-key: ${R2_SECRET_KEY}
```

7. Запуск: `litestream replicate -config litestream.yml`  
8. Restore: `litestream restore -o …` по тому же endpoint/bucket.

Litestream v0.5+ автодетектит `*.r2.cloudflarestorage.com` (`sign-payload`, `concurrency: 2`).

### Альтернатива B2

- Endpoint вида `s3.<region>.backblazeb2.com`, application key с доступом к bucket.
- Auto-detect `*.backblazeb2.com` (`force-path-style`, `sign-payload`).

Секреты — только локально / env, не в git.

---

## 6. Stream Tools — модель «человек / склейка»

Публичная страница продукта: https://b1trat3.ru/products/stream-tools (проверено 2026-10-07).

**Факт с публички:** FAQ подтверждает, что «аналитическая база и история остаются на вашем компьютере» (локальная БД есть). Есть видео «Аналитический раздел Stream Tools». Интеграции: Twitch/YouTube/VK/Kick/GoodGame + DonationAlerts/DonatePay; продукт ориентирован на OBS-виджеты и интерактив эфира (Windows-only).

**Слепое пятно:** публично **нет** описания сущности «человек», автоматча донат↔чат или UI merge.

**Вывод:** Person / Identity проектируем сами (tech-spec §3.3), независимо от внутренней реализации Stream Tools. Не обещаем совместимость схем/файлов.

---

## Гипотеза → факт (сводка для оркестратора)

| Было в docs (гипотеза / дыра) | Стало |
|-------------------------------|--------|
| DA: «уточнить websocket vs REST на старте кода» | **Факт:** Centrifugo WS + scopes; REST `/alerts/donations` для backfill; id для идемпотентности; 60 req/min HTTP |
| Get Chatters scopes / broadcaster | **Факт:** `moderator:read:chatters`; broadcaster может быть `moderator_id` |
| Pagination / delay | **Факт:** first≤1000; delay задокументирован без числа |
| 60s poll «ок?» | **Факт-вывод:** 60s на грани; продукт **60–120s** (не TMI); official delay + community cache |
| EventSub types/scopes списком | **Факт:** таблица выше; chat.message → `user:read:chat` (не legacy `chat:read`); condition оба id = стример на MVP |
| Streamer.bot «WS/UDP/HTTP» | **Факт:** ingest = WebSocket + `@streamerbot/client` (`Twitch.ChatMessage`…); UDP = DoAction inbound |
| Litestream R2/B2 «набросать» | **Факт:** минимальный checklist + yaml |
| Stream Tools person merge | **Факт:** локальная аналитическая БД на публичке есть; Person/merge UI **неизвестно** — проектируем сами |

---

## 7. Twitch OAuth refresh — definitive vs transient failure

**Источник:** https://dev.twitch.tv/docs/authentication/refresh-tokens/ (проверено 2026-10-07).

| Случай | HTTP / body | Поведение продукта |
|--------|-------------|-------------------|
| Invalid / revoked refresh | **400** (пример docs: `message: Invalid refresh token`) или **401**; OAuth `error` `invalid_grant` / unauthorized equivalents | Clear tokens → `TWITCH_REAUTH_REQUIRED` (без reconnect loop) |
| Rate limit / upstream | **429**, **5xx** | **Keep** tokens; transient error → существующий reconnect/backoff |
| Network / timeout | нет HTTP ответа | **Keep** tokens; transient |

Дополнительно (docs): public-client refresh tokens **истекают через 30 дней**; concurrent refresh — лимит ~50 access tokens на один refresh (single-flight в коде).

## 8. EventSub WebSocket — reconnect / keepalive

**Источники:** https://dev.twitch.tv/docs/eventsub/handling-websocket-events , https://dev.twitch.tv/docs/eventsub/websocket-reference/

| Факт | Деталь |
|------|--------|
| Endpoint | `wss://eventsub.wss.twitch.tv/ws` (+ опц. `keepalive_timeout_seconds` 10–600) |
| Keepalive | Если нет notification/keepalive дольше `keepalive_timeout_seconds` → считать соединение мёртвым, reconnect + resubscribe |
| `session_reconnect` | Сразу открыть `reconnect_url`; **не** закрывать старый сокет до Welcome на новом (~30s окно) |
| Delivery | At-least-once; повтор с тем же `message_id` → dedupe по provider id |

---

## Implementation decisions

Дата: **2026-10-07** (МСК). Решения оркестратора для ветки `codex-init-grok` (не заменяют research выше).

### Presence / Get Chatters

- Интервал опроса по умолчанию **60s**; поле конфигурации `chattersPollSeconds` ограничено **60–120**.
- Успешный полный poll записывает присутствие на **интервал от предыдущего успешного poll** до завершения текущего (не только минутный bucket по `completedAtMs`).
- `partial` / `failed` **не** дают `not_observed` — только `unknown` для минут без полного наблюдения.

### Модерация чата

- Текст сообщения **не** затирается и не переписывается плейсхолдером.
- Ставится флаг **`redacted`** в payload; область действия — **текущая сессия** (при отсутствии сессии — узкое окно по времени).
- UI по умолчанию **скрывает** текст с `redacted`; исходный текст остаётся в SQLite.

### Ветки и документация

- Текущая рабочая ветка реализации: **`codex-init-grok`**.
- `dev` — долгосрочная интеграция; `main` — релизы.
- README не должен указывать пользователям клонировать `codex-init`.

### Person auto-link / Litestream / Streamer.bot (codex-init-grok)

- Auto-link uses `matchKey` (strip `@`/`#`) for unique cross-source matches only; `candidateKey` stays suggestion-only without stripping.
- Litestream example checked against research checklist; script no-ops without credentials.
- Streamer.bot: interface + stub; live client deferred.

### Twitch refresh failure classification (2026-10-07)

- Definitive auth failure (clear + reauth): HTTP **400/401** and/or body `error` `invalid_grant` (unauthorized / invalid_token / «Invalid refresh token»).
- Transient (keep tokens): **429**, **5xx**, network/timeout → `TWITCH_REFRESH_HTTP_*` / underlying error for reconnect/backoff.
- Full audit trail: [docs-audit.md](./docs-audit.md).

