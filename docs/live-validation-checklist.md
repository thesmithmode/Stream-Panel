> Исторический документ desktop v0.0.4. Актуальные серверная архитектура и условия выпуска: [readiness-checklist.md](readiness-checklist.md), [ops/server.md](ops/server.md), [api-contract.md](api-contract.md). Требования Windows/локального демона/sync двух БД ниже заменены серверным решением.

# Live validation checklist (owner)

Короткий чеклист после offline readiness на `codex-init-grok`. Токены и секреты **не** присылать в чат/git — только локальный UI.

## Подготовка

- [ ] Node 24.19+, pnpm 11.25.0 на **Windows 11** и **Linux Mint** (или целевой Mint)
- [ ] `git clone --branch codex-init-grok …` → `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm start`
- [ ] Открыта одноразовая ссылка из терминала; вкладку можно закрыть — демон продолжает работу
- [ ] Каталог данных известен (Linux `~/.local/share/stream-panel`, Windows `%LOCALAPPDATA%\StreamPanel`); `secrets.json` не копировать в облако/чат

## Twitch OAuth + права

- [ ] Своё Twitch application (public client), Client ID в панели
- [ ] Device Code вход **владельцем канала**
- [ ] В диагностике отдельно видны: чат, chatters (mod), optional subscriptions/bits/followers
- [ ] Отказ в scope не ломает остальные источники
- [ ] Refresh / повторный вход после revoke; нет бесконечного reconnect на expired refresh

## DonationAlerts OAuth + realtime

- [ ] Своё DA OAuth app; redirect `http://127.0.0.1:47831/oauth/donationalerts/callback` (или свой порт)
- [ ] Callback + state успешны; либо безопасный import access/refresh token
- [ ] REST history и WS одного alert **не** удваивают сумму
- [ ] Контрольный донат с независимо записанным UTC; offset выставить только после сверки; unknown не приписывать минуте

## Сбор во время эфира

- [ ] Запуск посреди эфира сохраняет тот же stream ID после рестарта демона
- [ ] Chatters poll 60–120 с; partial/failed ≠ «человека не было»
- [ ] Сообщения EventSub появляются в ленте; gap виден при обрыве
- [ ] Merge / undo / split на живых identity; кандидаты по имени; **отклонённая пара пока может появиться снова** (durable reject — P1)

## Soak 8h (Win + Mint)

- [ ] Непрерывная запись ≥8 часов на каждой ОС
- [ ] Sleep / смена сети: gap виден, после пробуждения сбор возобновляется
- [ ] Память/очередь без unbounded роста; UI остаётся отзывчивым
- [ ] Ctrl+C / штатное завершение: lock снят, БД цела; локальный backup из UI открывается

## Backup (optional Litestream)

- [ ] In-app snapshot → restore в **новую** папку через `STREAM_PANEL_DATA_DIR`
- [ ] (Опционально) Litestream → R2/B2 по [ops/litestream.md](./ops/litestream.md); секреты только в env

## Не требуется на этом этапе

- Полный Streamer.bot client (P3)
- Durable rejection / owner rules (P1)
- OBS-виджеты, installer, OS keychain

Отметьте результаты в issue/заметке с датой и ОС; ссылки на Actions — только public CI, без токенов.
