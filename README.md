# Stream Panel

Локальная программа для аналитики Twitch + DonationAlerts: чат, донаты, сессии, люди и наблюдения по минутам. Данные хранятся на вашем компьютере в SQLite. Интерфейс открывается в браузере, сбор работает в отдельном процессе.

**Стадия: работающая ранняя версия в ветке `codex-init-grok`.** Долгосрочная интеграция — `dev`; релизы — `main`. Не клонируйте `codex-init` для этой линии работ. Локальный цикл проверен тестами и браузером. Адаптеры Twitch/DA написаны; вход в реальные аккаунты и живые события ещё требуют ручной проверки. Наблюдение участника в чате не означает просмотр видео. Готовность по требованиям — [docs/readiness-checklist.md](docs/readiness-checklist.md); живой прогон — [docs/live-validation-checklist.md](docs/live-validation-checklist.md).

![Первый запуск Stream Panel](docs/assets/overview.png)

## Установка и запуск (Windows и Linux)

**Готовые сборки:** скачайте GitHub Release — Linux `.deb` или Windows `StreamPanel-Setup-*.exe`. После установки откройте **Stream Panel** из меню приложений / Start Menu: интерфейс (обзор, сессии, люди, подключения) откроется в системном браузере сам.

**Из исходников** нужны **Node.js 24.19.0+** (ветка 24), **pnpm 11.25.0** и Git. На Linux/macOS Node можно поставить в `~/.local/node24` и добавить в `PATH`. Если pnpm ещё нет: `npm install -g pnpm@11.25.0`.

**Linux / macOS (bash):**

```sh
git clone --branch codex-init-grok https://github.com/thesmithmode/Stream-Panel.git
cd Stream-Panel
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

**Windows (PowerShell):**

```powershell
git clone --branch codex-init-grok https://github.com/thesmithmode/Stream-Panel.git
cd Stream-Panel
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

При запуске панель сама открывается в браузере (одноразовая ссылка ≈10 мин; после входа ключ удаляется из адреса). Вкладку можно закрыть — процесс продолжит работать. Остановка: Ctrl+C в терминале (или завершите процесс Stream Panel). После перезапуска откроется новая ссылка. Программа не заполняет базу выдуманными событиями. Без браузера: `STREAM_PANEL_NO_BROWSER=1`.

Native addon `better-sqlite3` собирается при `pnpm install`. На Windows нужны Build Tools for Visual Studio (C++); на Linux — обычный toolchain (`build-essential` / эквивалент). CI проверяет Ubuntu и Windows.

В «Подключениях»:

- **Twitch:** своё public OAuth-приложение в [Developer Console](https://dev.twitch.tv/console/apps), Client ID и Device Code вход владельцем канала. Client secret Twitch не нужен. Основные права: чтение чата и участников; подписки, Bits и фолловеры — отдельно.
- **DonationAlerts:** своё OAuth-приложение с Client ID / secret и redirect URI `http://localhost:47831/oauth/donationalerts/callback`, либо уже полученный access token. Для refresh нужны refresh token и реквизиты приложения. Localhost callback, state и legacy WS handshake ещё нужно проверить на аккаунте; REST и realtime имеют независимую диагностику.
- Время DA по умолчанию **неизвестно**: донаты сохраняются и входят в сумму, но не присваиваются минуте/сессии. UTC offset — только после проверки времени источника; применяется к новым фактам.

### Где лежат секреты и данные

| ОС | Каталог по умолчанию |
| --- | --- |
| Linux | `$XDG_DATA_HOME/stream-panel` или `~/.local/share/stream-panel` |
| Windows | `%LOCALAPPDATA%\StreamPanel` |

Внутри: `data.sqlite`, **`secrets.json`** (токены, client id/secret, offset, poll interval, `excludedBotLogins`), `backups/`. Переопределение: `STREAM_PANEL_DATA_DIR`. Порт: `STREAM_PANEL_PORT` (default **47831**); при смене порта обновите DA redirect URI.

Секреты вводятся в локальной панели. Их нет в HTTP API, git и snapshot базы. Файл `secrets.json` **незашифрован**; на POSIX пишется с mode `0600`, каталог данных `0700`. Интеграция с OS credential store — P1. Не коммитьте и не шарьте этот файл.

### Опционально: Litestream → R2/B2

Локальные snapshot через кнопку «Создать резервную копию» достаточны для старта. Непрерывная репликация в Cloudflare R2 или Backblaze B2 — опциональна: см. [docs/ops/litestream.md](docs/ops/litestream.md), пример `litestream.yml.example`, скрипт `scripts/litestream-replicate.sh` (тихо пропускает запуск, если Litestream или ключи не заданы). Секреты R2/B2 только в env.

## Что работает

- Обзор: сообщения, суммы по валютам, последний полный опрос участников, лента и состояние источников.
- Сессии: ручная запись; Twitch — обнаружение эфира, стабильный stream ID, опрос chatters каждые 60–120 с (default 60).
- Люди: Twitch ID и донатные события, кандидаты по имени, переименование, merge, undo и split с ревизиями; автопривязка по platform id и уникальному login-match Twitch↔DA; owner bind при входе Twitch.
- Фильтр известных ботов в summary/persons (+ `excludedBotLogins` в secrets); события не удаляются.
- Минутная сетка: «наблюдался / не наблюдался / нет данных».
- Локальный backup через SQLite API с проверкой integrity / FK / схемы.
- Заглушка адаптера Streamer.bot (полный live client — P3).

Ещё не реализованы: **durable отказ кандидатов / owner rules с TTL** (P1), полный Streamer.bot WS client, автостарт OS, OS credential store. OBS-виджеты — вне v1.

### Пакеты (Stage 3)

Сборка: `pnpm package`. **GitHub Release** — только `.deb` + Windows Setup `.exe` (`--github-assets`; см. [docs/ops/packaging.md](docs/ops/packaging.md)). CI: **Package release artifacts** (`workflow_dispatch` или tag `v*`).

**После установки из релиза:**

- **Linux (`.deb`):** `sudo dpkg -i stream-panel_*_amd64.deb` → пункт меню **Stream Panel** или команда `stream-panel`. Браузер с панелью откроется сам.
- **Windows:** `StreamPanel-Setup-*.exe` → Start Menu **Stream Panel**. Браузер с панелью откроется сам.

## Данные и восстановление

Кнопка «Создать резервную копию» пишет проверенный snapshot в `backups/`. Для восстановления: остановите программу, сохраните текущую папку отдельно, скопируйте snapshot в **новую** папку как `data.sqlite`, запустите с `STREAM_PANEL_DATA_DIR`. Вход в сервисы — заново. Не копируйте живую базу без WAL и не пишите в неё с двух машин сразу.

## Разработчику

1. [Требования](docs/user-requirements.md) и [PRD](docs/prd.md)
2. [Архитектура](docs/tech-spec.md) · [API](docs/api-contract.md)
3. [Readiness checklist](docs/readiness-checklist.md) · [Live validation](docs/live-validation-checklist.md)
4. [Research](docs/research-notes.md) · [Validation](docs/validation.md) · [Testing](docs/testing-strategy.md) · [Plan](docs/implementation-plan.md)

```sh
pnpm check
pnpm benchmark
```

Перед первой проверкой: `pnpm exec playwright install chromium` (на Linux CI — `--with-deps chromium`). `pnpm check` — TypeScript/Svelte, UI build, unit/integration/E2E и coverage ≥90% строк/ветвлений/функций (и ≥90% строк каждого runtime-файла). Живые аккаунты не нужны. CI: push во все ветки и PR на Ubuntu/Windows (`.github/workflows/core.yml`).

Структура: `packages/core` — домен/SQLite; `apps/daemon` — worker, HTTP, OAuth, адаптеры; `apps/web` — Svelte UI; `scripts` — измерения. В `allowBuilds` разрешён только `better-sqlite3`.

[Stream Tools](https://b1trat3.ru/products/stream-tools) — ориентир процесса; аналитическая модель — по требованиям владельца.
