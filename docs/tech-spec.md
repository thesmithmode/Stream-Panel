> Исторический документ desktop v0.0.4. Актуальные серверная архитектура и условия выпуска: [readiness-checklist.md](readiness-checklist.md), [ops/server.md](ops/server.md), [api-contract.md](api-contract.md). Требования Windows/локального демона/sync двух БД ниже заменены серверным решением.

# Техническая спецификация: Stream Panel

Стадия: продумывание. Код продукта не пишется в этом коммите — только документация.

Связанные документы: [prd.md](./prd.md), [user-requirements.md](./user-requirements.md), [research-notes.md](./research-notes.md).

---

## 1. Выбранный стек и обоснование

| Слой | Выбор | Почему |
|------|--------|--------|
| Язык / рантайм | **TypeScript на Node.js 22 LTS** | Зрелые клиенты Twitch (EventSub WebSocket), удобный JSON, один язык для демона и UI-тулинга; проще нанять/продолжить, чем Rust на этапе аналитики. |
| Процесс | Долгоживущий **daemon** + локальный HTTP | Должен работать весь стрим; перезапуск без потери подписок (reconnect). |
| UI | **Vite + Svelte 5** (SPA на `localhost`) | Лёгкий дашборд; без Electron на MVP. Позже опционально Tauri-обёртка (tray), если понадобится «как приложение». |
| БД | **SQLite** (драйвер `better-sqlite3` или libsql) | Локальность из требований; один файл; достаточно для одного канала. |
| Миграции | `drizzle-orm` + drizzle-kit | Типобезопасная схема рядом с TS. |
| Remote backup | **Litestream** → бесплатный object storage (**Cloudflare R2** free tier или Backblaze B2) | Непрерывная репликация SQLite без своего сервера БД; соответствует «бесплатный удалённый бэкап/sync». |
| Секреты | `.env` / OS credential store, **не в git** | Публичный репозиторий. |
| Упаковка | `pnpm` monorepo (`apps/daemon`, `apps/web`, `packages/shared`); бинарники позже через `pkg`/`node-sea` или просто `pnpm start` | Win + Linux без двух кодовых баз. |
| Тесты | `vitest` + контрактные фикстуры событий | Детерминированные тесты матчинга Person. |

**Почему не Python:** хуже единый деплой UI+демона и типизация контрактов событий.  
**Почему не чистый Rust/Go на MVP:** дольше до Working Dashboard; при необходимости hot-path presence можно вынести позже.  
**Почему не Electron сразу:** тяжелее и не нужен для localhost-дашборда.

---

## 2. Высокоуровневая архитектура

```
┌─────────────────────────────────────────────────────────┐
│  apps/daemon (Node/TS)                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────┐ │
│  │ Twitch   │ │ Donationalerts │ │ Streamer.bot │ │ …    │ │
│  │ adapter  │ │ adapter        │ │ (future)     │ │      │ │
│  └────┬─────┘ └──────┬─────────┘ └──────┬───────┘ └────┘ │
│       └──────────────┼──────────────────┘                │
│                      ▼                                   │
│              Event Normalizer                            │
│                      ▼                                   │
│         Person Matcher (auto + manual rules)             │
│                      ▼                                   │
│              SQLite (local file)                         │
│                      │                                   │
│              Litestream ──► R2/B2 backup                 │
│                      ▲                                   │
│              Query API (HTTP localhost)                  │
└──────────────────────┼──────────────────────────────────┘
                       ▼
                 apps/web (Svelte)
```

Работа ведётся в ветке **`dev`**. В `main` — только релизы.

---

## 3. Модули

### 3.1. Ingest adapters

Единый внутренний контракт `NormalizedEvent`:

```ts
type NormalizedEvent = {
  id: string;              // idempotency key (source + external id)
  source: 'twitch' | 'donationalerts' | 'streamerbot';
  type: string;            // chat.message | donation | bits | sub | presence.sample | …
  occurredAt: string;      // ISO-8601 UTC
  sessionId?: string;
  rawRef?: string;         // optional pointer to raw payload store
  actor?: {
    source: string;
    externalId?: string;   // twitch user id
    login?: string;
    displayName?: string;
  };
  payload: Record<string, unknown>;
};
```

**Twitch (MVP)** — факты: [research-notes.md](./research-notes.md)

- EventSub (**WebSocket** transport), subscription types:
  - `channel.chat.message` v1 — scope **`user:read:chat`** (не legacy `chat:read`); condition `broadcaster_user_id` + `user_id` (MVP: оба = стример); idempotency: `message_id`
  - `channel.subscribe` / `channel.subscription.gift` / `channel.subscription.message` v1 — `channel:read:subscriptions`
  - `channel.cheer` v1 — `bits:read`
  - `channel.follow` **v2** — `moderator:read:followers` (+ `moderator_user_id` в condition)
  - `channel.raid` v1 — auth не требуется (`to_broadcaster_user_id` или `from_…`)
  - `stream.online` / `stream.offline` v1
- Helix **Get Chatters** poll во время `stream.online` (см. §5): scope **`moderator:read:chatters`**; `moderator_id` = broadcaster **или** мод (совпадает с user в токене); `first` ≤ 1000; documented delay обновления списка.
- Рекомендуемый MVP user-token scopes (broadcaster):  
  `user:read:chat`, `moderator:read:chatters`, `moderator:read:followers`, `channel:read:subscriptions`, `bits:read`.  
  Legacy `chat:read` для EventSub **не** использовать.

**DonationAlerts (MVP)** — факты: [research-notes.md](./research-notes.md)

- **Realtime:** Centrifugo WebSocket `wss://centrifugo.donationalerts.com/connection/websocket`.
  1. OAuth → `GET /api/v1/user/oauth` (scope `oauth-user-show`) → `socket_connection_token` + user `id`
  2. Connect WS → Centrifugo client UUID
  3. `POST /api/v1/centrifuge/subscribe` на канал `$alerts:donation_<user_id>` (scope `oauth-donation-subscribe`)
  4. Subscribe на канале по WS
- **Scopes:** `oauth-user-show`, `oauth-donation-subscribe`, `oauth-donation-index` (REST backfill `GET /api/v1/alerts/donations`).
- **Idempotency:** целочисленный donation `id` → `NormalizedEvent.id = donationalerts:{id}`.
- **HTTP rate limit:** 60 req/min на приложение.
- Payload: amount, currency, username, message, created_at, …

**Streamer.bot (post-MVP, заложить интерфейс)** — факты: [research-notes.md](./research-notes.md)

- Adapter `source: 'streamerbot'` → тот же `NormalizedEvent`.
- **Транспорт исходящих событий:** WebSocket Server (default `127.0.0.1:8080`) + официальный клиент **`@streamerbot/client`** (`StreamerbotClient`, `on('Twitch.ChatMessage')` / `subscribe: { Twitch: ['ChatMessage'] }`).
- **UDP Server** в доке SB — для **DoAction** (входящие команды *в* SB), **не** шина аналитических событий → не использовать как ingest.
- Цель: не дублировать Twitch/DA, если SB уже их агрегирует; адаптер реалистичен.


### 3.2. Sessions

- Сессия стрима открывается по `stream.online` (или ручной «начать запись»), закрывается по `stream.offline`.
- Все события и presence-сэмплы привязываются к `session_id`.

### 3.3. Person / Identity

Публичная модель «человек/склейка» у Stream Tools **не задокументирована** → ниже — наш дизайн, не reverse-engineer.

Таблицы (логически):

- `persons` — канонический человек (`id`, `display_name`, `notes`, timestamps).
- `person_identities` — `(person_id, source, external_id?, login_normalized, display_normalized)`, unique по source+external_id / source+login.
- `person_merges` — аудит ручных склеек/разделений.

**Автоматч (MVP rules, по приоритету)**

1. Точный `external_id` уже привязан → тот Person.
2. Одинаковый `matchKey` (NFKC, trim, lower, strip leading `@`/`#`) на Twitch и DA, и ровно один Person на другой стороне → **auto-link** новой identity к этому Person (не suggestion). Owner: `ensureOwnerIdentity` на Twitch validate.
3. Неоднозначные / ambiguous имена (`candidateKey`) → только UI-предложения; без автосклейки.

**Ручное редактирование**

- Merge «донатер X = зритель Y»: выбрать identity A и B → один Person; прошлое **и** будущее (донаты/активность) атрибутируется на этого Person; запись аудита + revision.
- Undo / split: вернуть состав / выделить identities (как реализовано); fact log не удаляется.
- Rename канонического `display_name` («Петя»).

### 3.4. Storage

- Файл по умолчанию: `~/.stream-panel/data.sqlite` (или путь из конфига).
- Append-only `events`; агрегаты можно материализовать позже.
- `presence_samples`: `(session_id, sampled_at, chatter_user_id, login, …)` или сжатое хранение diff’ов между сэмплами (оптимизация post-MVP).
- Raw payloads — опциональная таблица/каталог для отладки (ротация).

### 3.5. Query API + UI

Локальный HTTP `127.0.0.1` (порт из конфига):

- `GET /sessions`, `GET /sessions/:id/summary`
- `GET /persons`, `GET /persons/:id` (события, минуты, донаты)
- `POST /persons/merge`, `POST /persons/unmerge`
- `GET /sessions/:id/presence?from&to` — минутная сетка

UI-экраны MVP: список сессий, дашборд сессии (топы + таймлайн), карточка Person, очередь предложений матчинга, экран минутной сетки.

---

## 4. Модель данных (черновик)

```text
sessions(id, started_at, ended_at, platform_stream_id, title, …)
events(id, session_id, source, type, occurred_at, person_id?, identity_id?, payload_json)
identities(id, source, external_id, login_normalized, display_name, …)
persons(id, display_name, notes, created_at, updated_at)
person_identities(person_id, identity_id, linked_how, confidence)
presence_samples(session_id, sampled_at, identity_id)  -- или bitmap/diff later
donations(…)  -- может быть проекцией events type=donation
```

---

## 5. Presence: требование vs реальность Twitch API

### 5.1. Требование

Знать доподлинно, кто смотрит, как долго, когда приходит/уходит, и ответ вида: «смотрел ли Вася в пн DD.MM в 12:03», плюс сообщения и частота.

### 5.2. Что Twitch реально даёт

| Механизм | Что даёт | Чего не даёт |
|----------|----------|--------------|
| **EventSub** | Чат, биты, сабы, фоллоу, рейды, online/offline | Списка зрителей; join/leave произвольного viewer |
| **Helix Get Chatters** | Список пользователей, **подключённых к чат-сессии** канала; нужен `moderator:read:chatters` | Не «все viewers» стрима; есть задержка обновления; анонимы/без чата не видны; боты в списке есть |
| **IRC JOIN/PART** | Исторически join/part; на практике для крупных каналов и современных клиентов **нельзя** строить полный presence | Не замена Get Chatters |
| **Устаревший TMI chatters** | Недокументирован, ломается | Не использовать в продукте |
| **Get Streams `viewer_count`** | Одно число | Без имён |

**Итог:** платформа **не предоставляет** поминутный канонический лог «viewer X смотрел поток». Доступен proxy: **кто был в chatters в момент опроса** + точные timestamps чата/донатов.

### 5.3. Как закрываем требование (честный контракт продукта)

1. **Во время online** опрашивать Get Chatters с интервалом **60–120 с** (дефолт конфига **60s**; community часто 1–3 мин из‑за cache; official delay join/leave→list). Helix bucket ~800/min — не узкое место. Пагинация `first` до **1000**, cursor `after`. Не TMI.
2. Каждый ответ → `presence_samples` с `sampled_at` (время локального получения, UTC).
3. **Минутная сетка:** минута `HH:MM` считается «смотрел», если существует сэмпл в этой минуте (или соседней — политика интерполяции ниже), где identity присутствует.
4. **Интерполяция (документированная):** если пользователь был в сэмпле T и T+2мин, но пропущен T+1 из-за сбоя сети — UI помечает минуту как `inferred` vs `observed`. По умолчанию MVP: только `observed` (строже, честнее).
5. **Приход:** первый `observed` сэмпл в сессии (или после паузы отсутствия ≥ N минут). **Уход:** первый пробел после последнего сэмпла длительностью ≥ N (дефолт N=2 мин).
6. **Минуты просмотра:** count(observed minutes) × 1 мин; не претендуем на субминутную точность.
7. **Сообщения:** точные `occurred_at` из EventSub — без интерполяции.
8. **Оговорка в UI:** «По данным Twitch Chatters (нужен мод-токен). Не учитывает зрителей вне чата и может включать ботов.»

### 5.4. Что не обещаем

- Учёт logged-out / embed viewers.
- Субминутный join/leave как у внутренней телеметрии Twitch.
- Presence без прав модератора на канале.

### 5.5. Усиления позже

- Фильтр ботов (список известных login).
- Сжатие presence (хранит diff in/out вместо полного списка каждый раз).
- Подмешивание Streamer.bot events, если там появятся дополнительные сигналы.
- Poll чаще **60s** не делать — бессмысленно из-за documented delay / community cache; верх конфига 120s достаточен.

---

## 6. DonationAlerts

- Ingest: Centrifugo WS (основной) + REST `/alerts/donations` для backfill при старте/gap.
- Нормализовать username → identity `source=donationalerts`.
- Суммы хранить в минорных единицах + currency; в UI — агрегаты по Person (после merge с Twitch identity).
- Идемпотентность по donation `id` из API.
- Укладывать HTTP (OAuth refresh, subscribe, REST) в **60 req/min**.

---

## 7. Litestream → R2/B2 (минимальный путь)

Один канал бэкапа на MVP: **Cloudflare R2** (zero egress). Альтернатива: Backblaze B2. Детали и yaml — [research-notes.md](./research-notes.md).

От пользователя нужно:

1. Аккаунт Cloudflare + R2 bucket.
2. Account ID + API token **Object Read & Write**.
3. Установленный Litestream рядом с файлом SQLite.
4. `litestream.yml` с `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `region: auto`, ключи из env.
5. `litestream replicate` во время работы демона; restore — `litestream restore` на новой машине.

Секреты R2/B2 только в env / локальном конфиге, не в git.

## 8. Безопасность и приватность

- Публичный GitHub: никаких токенов, `.env.example` только с пустыми ключами.
- Слушать API по умолчанию на `127.0.0.1`.
- Политика данных: аналитика локальна; remote backup — опционален и под контролем пользователя (свой R2/B2).
- Не логировать полные OAuth-токены.

---

## 9. Кроссплатформа и «всегда во время стрима»

- Один TS-код для Win/Linux.
- Systemd user unit (Linux) / Task Scheduler или NSSM (Windows) — в docs запуска, не обязательно в MVP-бинарнике.
- Авто-reconnect EventSub с backoff; watchdog на poll chatters.
- Graceful shutdown: flush SQLite.

---

## 10. Порядок реализации (когда разрешат код)

1. Схема SQLite + Person merge API (без сети) + фикстуры.
2. Twitch OAuth + EventSub chat/online + sessions.
3. Get Chatters poll + минутная сетка.
4. DonationAlerts donations + автоматч.
5. Web UI дашборд.
6. Litestream + инструкция R2.
7. Заглушка интерфейса Streamer.bot adapter.

---

## 11. Открытые технические решения (не блокеры docs)

- ~~Точный транспорт DA~~ — **закрыто** (Centrifugo WS + REST backfill); см. §3.1 / research-notes.
- LibSQL vs better-sqlite3 — выбрать при первом scaffold.
- Нужен ли отдельный raw event log на диск — решить по объёму чата.
- Модель Person-merge у Stream Tools из публички **неизвестна** — проектируем свою (§3.3).

---

## Implementation decisions

Дата: **2026-10-07** (МСК). Уточнения к спецификации по решениям оркестратора (`codex-init-grok`).

1. **Chatters poll:** `chattersPollSeconds` ∈ [60, 120], default 60. `presenceMinutes` / `recordPoll` покрывают окно `[previousSuccessfulCompletedAt, completedAtMs]` для `status=complete`.
2. **Moderation:** `payload.redacted=1` без изменения `payload.text`; scope = open session для account (fallback: сообщения с `occurred_at_ms` в пределах 6 часов до события модерации). UI скрывает redacted text by default.
3. **Twitch token refresh:** если provider не вернул `refresh_token`, сохранить предыдущий (как в DonationAlerts).
4. **DA history:** инкрементальный backfill — останавливаться после N подряд полностью известных страниц; битые строки — skip + log, без abort всего скана.
5. **DA WS liveness:** после subscribe — ping/keepalive и reconnect при тишине.
6. **EventSub isolation:** сбой chatters/reconcile не должен рвать здоровый EventSub (отдельный catch; reconnect только при ошибках auth/connect).
7. **Static UI root:** путь к `apps/web/dist` от `import.meta.url`, не от `process.cwd()`.
8. **Resub text:** для `channel.subscription.message` брать `event.message.text` из объекта message.
9. **CI:** параллельные jobs types / unit / integration / e2e / coverage-gate; concurrency cancel-in-progress; без live OAuth.

10. **Person auto-link (2026-10-07):** exact `source+account+external_id` unchanged. High-confidence auto-link attaches a **new** identity to an existing person when `matchKey` (NFKC, trim, lower, strip leading `@`/`#`) uniquely matches exactly one person on the other platform (Twitch↔DA). Owner: `ensureOwnerIdentity` on Twitch validate. Manual merge/undo/split kept. Deferred: historical backfill merge of already-split persons.
11. **Bot filter:** well-known Twitch bot logins + `excludedBotLogins` in secrets; marked `is_bot` on `/persons`; excluded from summary message/chatter counts. Events not deleted.
12. **Twitch refresh failure:** clear tokens + `TWITCH_REAUTH_REQUIRED` **only** on definitive auth failure (HTTP 400/401 and/or OAuth `invalid_grant` / revoked equivalents). On 429/5xx/network/timeout: **keep** tokens and throw transient error for existing reconnect/backoff. Dead `watchdog` timer field (present on `codex-init`) remains absent on this branch. Product: UI shows **explicit** reauth («Войди снова») when `state=error` / reauth required; **no** advance ~30-day expiry warning (see §19).
13. **summary/persons:** SQL aggregates / JOIN counts — no per-request JS parse of every event row for summary totals.
14. **Litestream:** docs + `litestream.yml.example` + graceful `scripts/litestream-replicate.sh` (skip if unset). No secrets in repo.
15. **Streamer.bot:** stub adapter + `mapStreamerBotTwitchChatMessage` + test; full `@streamerbot/client` WS deferred to P3 (needs live SB + duplicate suppression).
16. **Durable rejection / owner rules (P1, stays deferred — 2026-10-07 readiness tick):** not a quick slice. Needs schema migration (persisted pair rejections + scoped owner rules with TTL), API + UI reject/apply, candidate filtering, collision/revision audit, and ≥90% coverage on new paths. Current offline path already has suggestions (`candidatePersons`), manual merge/undo/split, and owner bind — enough for live validation without durable reject. Tracked in [implementation-plan.md](./implementation-plan.md) P1 «Сопоставления».

17. **Docs authenticity (2026-10-07 audit):** runtime stack is **Node 24.19+**, SQL schema in `packages/core` (not drizzle), tests via `node:test` + coverage gate (not vitest). Working branch for this line: **`codex-init-grok`**. Headers in §1–2 / user-requirements that still say «код не пишется» / Node 22 are historical; see [docs-audit.md](./docs-audit.md) and README.
18. **Stream Tools public FAQ:** local analytics DB confirmed on product page; Person-merge model still unpublished → keep independent Person design (§3.3).

19. **Product decisions (user / orphanator 2026-10-07):** (1) YouTube / Stream Tools analytics video **out of scope** — product is Twitch + DonationAlerts only. (2) FR07 **KEEP** unique Twitch↔DA nick auto-link; wording fixed (not suggestions-only). (3) Manual merge **required** for different nicks; merges all past **and** future donations/activity into one Person; undo/split unchanged. (4) Twitch auth drop: UI must show **explicit** reauth («Войди снова») on definitive failure HTTP **400/401** (`state=error`, `TWITCH_REAUTH_REQUIRED`) — no silent OK look. **Do not** advance-warn about ~30-day public refresh expiry (useless beforehand). Connections + Overview surface the alert; daemon detail «Требуется повторный вход в Twitch».

20. **Stage 2 analytics UI (2026-10-07):** `GET /persons/:id/stats`, extended `GET /summary`, `GET /persons/tops`, `GET /insights`. Labels stay honest: observed minutes / chatters — never Twitch watch time or view counts. **Insights is a dropdown/popover on Overview**, not a separate nav section. Bot filter respected in message/chatter/top/insight aggregates.

21. **Stage 3 packaging (2026-10-07):** `scripts/package-release.mjs` bundles production `dist` + deps + official Node runtime into Linux `.deb`/`tar.gz` and Windows zip + `StreamPanel.exe` (C# launcher). Workflow `.github/workflows/release.yml` (dispatch / `v*` tags) uploads artifacts. Not Electron/SEA; better-sqlite3 remains a native module installed per target OS. See [ops/packaging.md](./ops/packaging.md).

