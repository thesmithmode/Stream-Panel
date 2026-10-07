# Readiness checklist — `codex-init-grok`

Дата: **2026-10-07** (МСК). Легенда:

| Символ | Смысл |
| --- | --- |
| ✅ | Закрыто **offline** (код + автотесты / локальный прогон) |
| ⏳ | Offline есть; **подтверждение только на живом** аккаунте/ОС |
| ❌ | Отложено / вне текущего среза (короткая причина) |

Источник требований: [user-requirements.md](./user-requirements.md), [prd.md](./prd.md), [tech-spec.md](./tech-spec.md). Доказательства — пути в репозитории.

## User requirements

| # | Требование | Статус | Evidence |
| --- | --- | --- | --- |
| U1 | Локальная аналитика людей (не разрозненные ники) | ✅ | `packages/core/src/store.ts` persons/identities/merge; UI `apps/web/src/People.svelte` |
| U2 | Twitch + DonationAlerts обязательны | ⏳ | Адаптеры `apps/daemon/src/twitch.ts`, `donationalerts.ts`; живой OAuth — G1/G3 |
| U3 | Streamer.bot заложить на будущее | ✅ stub / ❌ live | Stub `packages/core/src/streamerbot.ts`; полный `@streamerbot/client` — P3 |
| U4 | Автоматч + ручное merge/unmerge | ✅ / ❌ reject | Auto-link + merge/undo/split offline; **durable reject/owner rules — P1** |
| U5 | Данные локально (SQLite) | ✅ | `packages/core/src/schema.ts`, `store.ts`; путь `apps/daemon/src/config.ts` `defaultDataDir` |
| U6 | Бесплатный remote backup/sync | ✅ docs | Litestream docs `docs/ops/litestream.md`, `litestream.yml.example`; не обязателен для старта |
| U7 | Windows + Linux | ⏳ | Один TS-код; CI Ubuntu+Windows; native Win11/Mint install — G5 |
| U8 | Долгоживущий процесс / reconnect | ⏳ | Reconnect/backoff в twitch/DA; 8h soak — G6 |
| U9 | Presence: кто/как долго/когда + минуты | ✅ honest | Chatters poll + grid `presence.ts`/`store.ts`; честный контракт PRD §2 (не canonical watch) |
| U10 | UI аналитики (экраны v1) | ✅ MVP | Overview/Sessions/People/Connections/grid; расширенные топы — P1 |
| U11 | Вне скоупа: OBS-виджеты, SaaS, анонимы | ✅ | Не реализовано намеренно |

## PRD functional (FR01–FR14)

| ID | Поведение | Статус | Evidence |
| --- | --- | --- | --- |
| FR01 | Подключить Twitch | ⏳ | Device Code + scopes UI `Connections.svelte`; live owner DCF — G1 |
| FR02 | Подключить DA | ⏳ | OAuth/token + dedupe WS/REST offline; live callback — G3 |
| FR03 | История эфиров / stream ID | ⏳ | Session reconcile в `twitch.ts`; mid-stream live — G2 |
| FR04 | Сбор чата и событий | ✅ / ⏳ | Normalized ingest + gaps offline; live EventSub — G1/G2 |
| FR05 | Presence (полные страницы, не silent empty) | ✅ | `packages/core/src/chatters.ts`, poll status complete/partial/failed |
| FR06 | Person / Identity (rename, DA не unique account) | ✅ | Identity by platform id; DA alert occurrence key — core tests |
| FR07 | Автопредложения (не автосклейка физлиц) | ✅ | `candidatePersons`; ambiguous → suggestions; unique match_key auto-link only |
| FR08 | Ручные merge/undo/split + ревизии | ✅ | `store.merge` / `undoMerge` / `splitIdentities`; E2E People |
| FR09 | Донатная история / unknown TZ | ✅ / ⏳ | Unknown time quality; incremental backfill offline; live offset — G4 |
| FR10 | Согласованные фильтры экранов | ✅ partial | Session/person filters; cursor pagination / currency filter — P1 |
| FR11 | Сохранность после commit | ✅ | Worker + SQLite; disk errors → 503 |
| FR12 | Backup / restore | ✅ local / ❌ cloud schedule | In-app snapshot + verify; Litestream optional docs; scheduler rotation — P1 |
| FR13 | Локальная защита API | ✅ | Host/Origin/CSRF/nonce — `server.ts` + http tests |
| FR14 | Фон / SIGTERM / sleep gap | ✅ / ⏳ | SIGTERM/IPC shutdown offline; sleep/network на целевой ОС — G5/G6 |

## PRD screens & honesty

| Экран / контракт | Статус | Evidence |
| --- | --- | --- |
| Подключения и диагностика | ✅ / ⏳ | `Connections.svelte` + `/status`; live scopes freshness — G1/G3 |
| Сессии | ✅ | `/sessions`, start/stop manual |
| Эфир / Overview | ✅ | `/summary`, `/events` |
| Люди + карточка | ✅ | `/persons`, detail, aliases |
| Минутная сетка | ✅ | `/presence` observed/not_observed/unknown |
| Сопоставления (кандидаты) | ✅ suggest / ❌ durable reject | GET candidates + merge; нет POST reject / owner rules |
| Honesty table (не «все viewers») | ✅ | UI copy + PRD §2; bot disclaimer via filter |

## Tech-spec modules

| Модуль | Статус | Evidence |
| --- | --- | --- |
| Stack Node24 / pnpm / Svelte / SQLite | ✅ | `package.json`, `.node-version` |
| Twitch EventSub + Helix chatters | ⏳ | `twitch.ts`; live — G1/G2 |
| DA Centrifugo + REST | ⏳ | `donationalerts.ts`; live — G3/G4 |
| Person matcher auto + manual | ✅ / ❌ P1 reject | `store.resolveAutoLinkPerson`, `ensureOwnerIdentity` |
| Bot filter | ✅ | `packages/core/src/bots.ts` |
| Query API localhost | ✅ | `apps/daemon/src/server.ts`, `docs/api-contract.md` |
| Litestream path | ✅ docs | `docs/ops/litestream.md` |
| Streamer.bot adapter | ✅ stub / ❌ P3 live | `streamerbot.ts` |
| Secrets not in git | ✅ | `.gitignore`; `secrets.json` local only |
| CI hermetic | ✅ | `.github/workflows/core.yml` |

## Explicit deferred (not blocking live validation start)

| Item | Why |
| --- | --- |
| Durable merge rejection + owner rules TTL | Schema/API/UI/coverage; P1 — tech-spec §16 |
| Historical auto-merge of already-split persons | Deferred with auto-link slice |
| Full Streamer.bot live client | P3; needs SB + duplicate suppression |
| OS credential store, installer, autostart | P1/P2 |
| OBS widgets / other platforms / SaaS | Out of v1 |

## Verdict for orchestrator

Offline product surface for Twitch+DA analytics is ready for **manual live validation** (OAuth, soak, Win+Mint). Remaining holes are live gates G1–G8 and documented P1+ items — not offline blockers for starting that validation.
