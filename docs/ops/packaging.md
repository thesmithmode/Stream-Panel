# Packaging — Windows installer / Linux `.deb`

Дата: **2026-10-07** (МСК). Ветка работ: `feat/desktop-gui-launch`.

## GitHub Release assets (HARD POLICY)

Publish **exactly two** binary assets — nothing else:

| # | Asset | Notes |
| --- | --- | --- |
| 1 | `stream-panel_<ver>_amd64.deb` | Linux Debian installer + Applications menu (`.desktop`) |
| 2 | `StreamPanel-Setup-<ver>.exe` | Windows Inno Setup installer (Start Menu shortcut) |

**Do not** upload to the GitHub Release: `*.zip`, `*.tar.gz`, `*-source.zip`, `SHA256SUMS*`, `manifest*.json`, or other text sidecars.

Build those two with:

```sh
# Linux runner / local with dpkg-deb:
node scripts/package-release.mjs --skip-build --github-assets

# Windows runner (needs csc + Inno Setup ISCC):
node scripts/package-release.mjs --skip-build --github-assets
```

Upload example (after downloading CI artifacts):

```sh
gh release upload vX.Y.Z \
  stream-panel_X.Y.Z_amd64.deb \
  StreamPanel-Setup-X.Y.Z.exe \
  --clobber
# Then delete any stray assets if editing an existing release:
# gh release delete-asset vX.Y.Z <extra-name> --yes
```

## What else the script can build (local / CI debug only)

| Артефакт | Когда | Содержимое |
| --- | --- | --- |
| `stream-panel_<ver>_amd64.deb` | Linux + `dpkg-deb` | `/opt/stream-panel` + `/usr/bin/stream-panel` + `/usr/share/applications/stream-panel.desktop`, bundled Node |
| `stream-panel-<ver>-linux-x64.tar.gz` | Linux **without** `--github-assets` | Portable tree: `runtime/` + `app/` + launcher |
| `StreamPanel-Setup-<ver>.exe` | Windows + `--github-assets` + ISCC | Inno installer → Start Menu «Stream Panel» → `StreamPanel.exe` |
| `stream-panel-<ver>-win-x64.zip` | Windows **without** `--github-assets` | Portable tree + `StreamPanel.exe` + `StreamPanel.cmd` |
| `stream-panel-<ver>-source.zip` | `--source` (ignored with `--github-assets`) | `git archive` snapshot |
| `SHA256SUMS` / `manifest.json` | Always written under `artifacts/release/` | Local verify only — **never** Release assets |

Native `better-sqlite3` ставится в staging под целевую ОС (не SEA). Electron не используется. При запуске демон слушает localhost и **сам открывает системный браузер** на одноразовый URL панели (отключить: `STREAM_PANEL_NO_BROWSER=1`).

## Локально

```sh
pnpm build
pnpm package                 # полный цикл (portable + platform pkgs)
# GitHub Release binaries only:
node scripts/package-release.mjs --skip-build --github-assets
```

Опции:

- `--skip-build` — уже есть `dist/`
- `--skip-runtime` — не скачивать Node (только для отладки layout)
- `--source` — добавить source zip (not for GitHub Release)
- `--github-assets` — only `.deb` (linux) or Setup `.exe` (win); skip portable tar.gz / zip / source
- `STREAM_PANEL_VERSION` / `STREAM_PANEL_NODE_VERSION` — переопределения

Linux `.deb` требует `dpkg-deb`. Windows Setup собирается через **Inno Setup 6** (`ISCC`) на `windows-latest` после `csc` (`StreamPanel.exe`, `/t:winexe`). Job падает, если Setup `.exe` нет.

## CI

Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml)

- push в `codex-init-grok` / `release-assets-slim` / `feat/desktop-gui-launch` при изменении packaging-файлов
- push tag `v*`
- `workflow_dispatch` (после попадания workflow на default branch)

CI uploads **only** the two publishable binaries as Actions artifacts (`stream-panel-linux` = `.deb`, `stream-panel-windows` = Setup `.exe`). GitHub Release upload is manual (or a future write-enabled job) and must keep the same two-asset policy.

## Установка и запуск

**Debian/Ubuntu:** `sudo dpkg -i stream-panel_*_amd64.deb` → пункт меню **Stream Panel** или команда `stream-panel`. Интерфейс откроется в браузере сам (терминал не обязателен).

**Windows:** запустить `StreamPanel-Setup-*.exe` → Start Menu **Stream Panel**. Интерфейс откроется в браузере сам.

Данные по-прежнему в `%LOCALAPPDATA%\StreamPanel` / `~/.local/share/stream-panel`.
