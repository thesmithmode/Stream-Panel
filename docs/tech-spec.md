# Техническая спецификация: Stream Panel

Стадия: продумывание. Код продукта не пишется в этом коммите — только документация.

Связанные документы: [prd.md](./prd.md), [user-requirements.md](./user-requirements.md).

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

**Twitch (MVP)**

- EventSub (WebSocket transport):  
  `channel.chat.message`, `channel.subscribe` / `channel.subscription.gift`,  
  `channel.cheer`, `channel.follow`, `channel.raid`,  
  `stream.online`, `stream.offline`.
- Helix **Get Chatters** poll во время `stream.online` (см. §5).
- OAuth user token стримера (broadcaster), scope включая `moderator:read:chatters`, chat read, и нужные EventSub scopes.

**DonationAlerts (MVP)**

- OAuth / socket или polling API донатов (уточнить актуальный endpoint на старте кода).
- Событие `donation` с amount, currency, username, message, timestamp, external id.

**Streamer.bot (post-MVP, заложить интерфейс)**

- Adapter `source: 'streamerbot'` за тем же `NormalizedEvent`.
- Транспорт: WebSocket/HTTP server actions — выбрать по доке SB, когда пользователь поставит ПО.
- Цель: не дублировать подписки, если SB уже агрегирует Twitch/DA.

### 3.2. Sessions

- Сессия стрима открывается по `stream.online` (или ручной «начать запись»), закрывается по `stream.offline`.
- Все события и presence-сэмплы привязываются к `session_id`.

### 3.3. Person / Identity

Таблицы (логически):

- `persons` — канонический человек (`id`, `display_name`, `notes`, timestamps).
- `person_identities` — `(person_id, source, external_id?, login_normalized, display_normalized)`, unique по source+external_id / source+login.
- `person_merges` — аудит ручных склеек/разделений.

**Автоматч (MVP rules, по приоритету)**

1. Точный `external_id` уже привязан → тот Person.
2. Одинаковый `login_normalized` на Twitch + совпадение с DA username после нормализации (lowercase, trim, убрать `#`/`@`, уникод NFKC).
3. Одинаковый `display_normalized`, если однозначен (ровно один кандидат) — пометить `confidence=low`, показать в UI «предложение».

**Ручное редактирование**

- Merge: выбрать identity A и B → один Person (перенос ссылок, запись аудита).
- Unmerge: вернуть identity на нового/старого Person.
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

1. **Во время online** опрашивать Get Chatters с интервалом **60 секунд** (не чаще: cache/rate; для одного канала этого достаточно). Пагинация `first=1000`.
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
- Опциональный более частый poll **не** делать — бессмысленно из-за cache и ToS.

---

## 6. DonationAlerts

- Нормализовать username → identity `source=donationalerts`.
- Суммы хранить в минорных единицах + currency; в UI — агрегаты по Person (после merge с Twitch identity).
- Идемпотентность по id уведомления DA.

---

## 7. Безопасность и приватность

- Публичный GitHub: никаких токенов, `.env.example` только с пустыми ключами.
- Слушать API по умолчанию на `127.0.0.1`.
- Политика данных: аналитика локальна; remote backup — опционален и под контролем пользователя (свой R2/B2).
- Не логировать полные OAuth-токены.

---

## 8. Кроссплатформа и «всегда во время стрима»

- Один TS-код для Win/Linux.
- Systemd user unit (Linux) / Task Scheduler или NSSM (Windows) — в docs запуска, не обязательно в MVP-бинарнике.
- Авто-reconnect EventSub с backoff; watchdog на poll chatters.
- Graceful shutdown: flush SQLite.

---

## 9. Порядок реализации (когда разрешат код)

1. Схема SQLite + Person merge API (без сети) + фикстуры.
2. Twitch OAuth + EventSub chat/online + sessions.
3. Get Chatters poll + минутная сетка.
4. DonationAlerts donations + автоматч.
5. Web UI дашборд.
6. Litestream + инструкция R2.
7. Заглушка интерфейса Streamer.bot adapter.

---

## 10. Открытые технические решения (не блокеры docs)

- Точный транспорт DA (websocket vs REST) — проверить по актуальной доке на старте кода.
- LibSQL vs better-sqlite3 — выбрать при первом scaffold.
- Нужен ли отдельный raw event log на диск — решить по объёму чата.
