# Research notes (официальные доки)

Дата проверки: **2026-10-06** (МСК); доп. сверка оркестратора + официальные ссылки тем же днём. Код продукта не писался — только факты для закрытия слепых пятен в спецификации.

| Тема | Источник | Статус |
|------|----------|--------|
| DonationAlerts realtime | [apidoc](https://www.donationalerts.com/apidoc) | Факт |
| Twitch Get Chatters | [Helix reference](https://dev.twitch.tv/docs/api/reference#get-chatters) | Факт |
| Twitch EventSub types | [Subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) | Факт |
| Twitch rate limits | [API guide](https://dev.twitch.tv/docs/api/guide#twitch-rate-limits) | Факт |
| Streamer.bot outbound events | [WS events](https://docs.streamer.bot/api/websocket/guide/events), [WS config](https://docs.streamer.bot/api/websocket/guide/configuration), [UDP](https://docs.streamer.bot/api/udp/guide/configuration) | Факт |
| Litestream → R2/B2 | [S3-compatible](https://litestream.io/guides/s3-compatible/), [S3 guide](https://litestream.io/guides/s3/) | Факт |
| Stream Tools Person-merge | Публичные страницы b1trat3 | **Неизвестно** |

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

Публичная страница продукта: https://b1trat3.ru/products/stream-tools  

Упоминается локальная аналитическая БД и интеграции, **но нет** описания сущности «человек», автоматча донат↔чат или UI merge.

**Вывод:** из публичных источников **неизвестно**. Проектируем свою модель Person / Identity (уже в tech-spec) независимо от внутренней реализации Stream Tools.

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
| Stream Tools person merge | **Факт «неизвестно»** — проектируем сами |
