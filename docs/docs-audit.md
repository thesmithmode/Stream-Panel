# Docs audit — developer comprehension (`codex-init-grok`)

Дата: **2026-10-07** (МСК). Прочитаны: `docs/prd.md`, `tech-spec.md`, `user-requirements.md`, `research-notes.md`, `readiness-checklist.md`, `live-validation-checklist.md`, `implementation-plan.md`, `ops/litestream.md`, `README.md`; публичная страница [Stream Tools](https://b1trat3.ru/products/stream-tools).

**Вердикт:** **разработчик поймёт** целевую архитектуру, честный контракт presence и текущий offline/live статус *если* читает README → readiness → research → tech-spec Implementation decisions. **Без** этой цепочки легко запутаться: в шапках tech-spec / user-requirements ещё «код не пишется», стек в §1 устарел (Node 22 / drizzle / vitest). FR07 wording aligned with unique Twitch↔DA auto-link (product decision 2026-10-07).

Формат строк: **Fact** (источник) / **Hypothesis** / **Blind spot** / **Contradiction**.

---

## DA transport

| Вид | Содержание |
| --- | --- |
| **Fact** | Realtime = Centrifugo WS `wss://centrifugo.donationalerts.com/connection/websocket`; scopes `oauth-user-show`, `oauth-donation-subscribe`, `oauth-donation-index`; REST `/alerts/donations` = backfill. Источник: [DA apidoc](https://www.donationalerts.com/apidoc), зафиксировано в [research-notes.md](./research-notes.md) §1. |
| **Fact** | HTTP API: 60 req/min на приложение. |
| **Blind spot** | Числовой WS rate limit / keepalive contract в apidoc не задан; продукт опирается на ping/reconnect (tech-spec Implementation decisions §5). |
| **Hypothesis** | Legacy handshake/heartbeat на живом аккаунте ведёт себя как в offline mocks (live G3/G4). |

## Twitch Chatters scopes / limits

| Вид | Содержание |
| --- | --- |
| **Fact** | `GET helix/chat/chatters`, scope `moderator:read:chatters`; `moderator_id` = broadcaster или мод; `first` ≤ 1000; список = chat session, не все viewers; delay join/leave→list без числа. [Helix reference](https://dev.twitch.tv/docs/api/reference#get-chatters). |
| **Fact** | Helix token-bucket ~800/min example; отдельного points-cost у Get Chatters нет → default 1. Poll продукта 60–120s. |
| **Contradiction** | User-requirements «кто сейчас смотрит» vs PRD honesty «не все смотрящие» / Chatters-only — закрыто контрактом PRD §2, но формулировка UR остаётся желанием, не API-фактом. |

## EventSub

| Вид | Содержание |
| --- | --- |
| **Fact** | Локальный транспорт = WebSocket `wss://eventsub.wss.twitch.tv/ws`; welcome → subscribe; keepalive; `session_reconnect` с `reconnect_url` (не закрывать старый сокет до welcome на новом). [Handling WebSocket Events](https://dev.twitch.tv/docs/eventsub/handling-websocket-events). |
| **Fact** | MVP types/scopes в research-notes §3; chat.message → `user:read:chat` (не legacy `chat:read`). |
| **Fact** | Notifications at-least-once (same `message_id` on resend) → dedupe обязателен. [WebSocket reference](https://dev.twitch.tv/docs/eventsub/websocket-reference/). |
| **Hypothesis** | Опциональные subscriptions (bits/subs/followers), отклонённые каналом, остаются observably degraded без teardown EventSub (код + offline tests; live G1). |

## Twitch OAuth refresh (связан с Job A)

| Вид | Содержание |
| --- | --- |
| **Fact** | Refresh: POST `id.twitch.tv/oauth2/token` `grant_type=refresh_token`; public client **без** `client_secret`. Fail example HTTP **400** `message: Invalid refresh token`; docs также: fail может быть **401** → re-prompt. Public refresh tokens **истекают через 30 дней**. [Refresh tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/). |
| **Fact (код 2026-10-07)** | Clear tokens + `TWITCH_REAUTH_REQUIRED` только при definitive auth failure (HTTP 400/401 и/или OAuth `invalid_grant` / revoked equivalents). 429/5xx/network: токены **сохраняются**, transient error → reconnect/backoff. |

## Streamer.bot outbound

| Вид | Содержание |
| --- | --- |
| **Fact** | Outbound events = WebSocket Server + `@streamerbot/client`; UDP = DoAction inbound, не analytics bus. [SB WS events](https://docs.streamer.bot/api/websocket/guide/events), [UDP](https://docs.streamer.bot/api/udp/guide/configuration). |
| **Fact** | В продукте: stub + map + test; live client = P3 (implementation-plan). |
| **Blind spot** | Полный список event names / duplicate suppression vs direct Twitch — только после live SB. |

## Litestream / R2

| Вид | Содержание |
| --- | --- |
| **Fact** | S3-compatible R2/B2; yaml + env keys; restore → новая папка; токены OAuth не в DB snapshot. [Litestream S3-compatible](https://litestream.io/guides/s3-compatible/), [ops/litestream.md](./ops/litestream.md). |
| **Hypothesis** | Free-tier R2 квоты достаточны для одного канала (не измерено; P2). |

## Person vs Stream Tools

| Вид | Содержание |
| --- | --- |
| **Fact** | Публичная страница Stream Tools: виджеты OBS, мультичат, донаты/события площадок; FAQ: «Аналитическая база и история остаются на вашем компьютере». Есть видео «Аналитический раздел». [b1trat3 Stream Tools](https://b1trat3.ru/products/stream-tools). |
| **Blind spot** | Публично **нет** описания сущности Person / auto-merge / UI склейки донат↔чат. Модель Stream Panel — своя (tech-spec §3.3). |
| **Fact (resolved 2026-10-07)** | FR07: unique Twitch↔DA `matchKey` **auto-link KEEP**; ambiguous → suggestions; different nicks → required manual merge (past+future). PRD/UR/tech-spec/readiness wording updated. YouTube analytics video **out of scope**. |

## Minute-grid honesty bounds

| Вид | Содержание |
| --- | --- |
| **Fact** | Три состояния: observed / not_observed / unknown; partial/failed ≠ отсутствие; интервал полного poll = от предыдущего успешного до текущего; без интерполяции v1. PRD §2, tech-spec §5, `presence.ts`. |
| **Fact** | Chatters ≠ viewers; боты могут быть в списке; исключение из агрегатов без удаления events. |
| **Blind spot** | Числовая latency Twitch cache для Chatters официально не задана → 60s = продуктовый default, не SLA freshness. |

## Stale docs (comprehension hazards)

| Вид | Содержание |
| --- | --- |
| **Contradiction** | tech-spec шапка / user-requirements: «код не пишется» vs README/readiness: working early version на `codex-init-grok`. |
| **Contradiction** | tech-spec §1: Node 22, drizzle-orm, vitest vs факт репо: Node 24.19+, SQL schema в core, `node:test` + coverage gate. |
| **Contradiction** | tech-spec §2: «Работа ведётся в ветке `dev`» vs README: клонировать `codex-init-grok`. |

---

## Closed holes this pass (official research → docs)

1. Twitch refresh failure classification (400/401 / invalid_grant vs transient) — research-notes + tech-spec Implementation decisions; код Job A.
2. EventSub WS reconnect/keepalive/at-least-once — уточнение в research-notes.
3. Stream Tools: публично подтверждена **локальная аналитическая БД**; Person-merge по-прежнему неизвестен.
4. Stale stack/status отмечены в audit; Implementation decisions tech-spec обновлены (не выдумывая новых product requirements).
5. FR07 wording + four product decisions (auto-link KEEP, manual merge past+future, YouTube out, explicit reauth UI / no 30d advance warn) — prd/UR/tech-spec/readiness/research/audit + Connections/Overview.

## Remaining hypotheses

- Live DA Centrifugo handshake/heartbeat и source-time offset (G3/G4).
- Live EventSub optional-scope degradation и mid-stream session stability (G1/G2).
- 8h soak Win+Mint memory/queues (G5/G6).
- R2 free-tier sufficiency (P2).
- Streamer.bot duplicate suppression strategy (P3).

## Closed product decisions (orphanator / user 2026-10-07)

1. **FR07 vs auto-link:** **KEEP** unique Twitch↔DA nick auto-link; fix FR07 wording (not suggestions-only). Ambiguous names stay suggestions. Code already correct — no behavior change.
2. **Twitch reauth UI (clarified):** **Do not** advance-warn about ~30-day public refresh expiry. **Required:** on definitive auth failure (HTTP 400/401) show **explicit** reauth («Войди снова») — Connections `notice error` + Overview source alert/button; daemon `state=error` / detail «Требуется повторный вход в Twitch». No silent connected look.
3. **YouTube «Аналитический раздел Stream Tools»:** **out of scope** — not a Person requirements source; product is Twitch + DonationAlerts only.
4. **Manual merge:** **required** for different nicks («донатер X = зритель Y»); merges all past **and** future donations/activity into one Person; undo/split unchanged.

See also tech-spec Implementation decisions §19, user-requirements Implementation decisions, research-notes.
