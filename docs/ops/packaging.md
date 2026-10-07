# Packaging — Windows zip / Linux `.deb`

Дата: **2026-10-07** (МСК). Ветка работ: `release-assets-slim`.

## GitHub Release assets (HARD POLICY)

Publish **exactly two** binary assets — nothing else:

| # | Asset | Notes |
| --- | --- | --- |
| 1 | `stream-panel_<ver>_amd64.deb` | Linux Debian installer |
| 2 | `stream-panel-<ver>-win-x64.zip` | Single Windows package (contains `StreamPanel.exe`) |

**Do not** upload to the GitHub Release: `*.tar.gz`, `*-source.zip`, `SHA256SUMS*`, `manifest*.json`, or other text sidecars.

Build those two with:

```sh
# Linux runner / local with dpkg-deb:
node scripts/package-release.mjs --skip-build --github-assets

# Windows runner:
node scripts/package-release.mjs --skip-build --github-assets
```

Upload example (after downloading CI artifacts):

```sh
gh release upload vX.Y.Z \
  stream-panel_X.Y.Z_amd64.deb \
  stream-panel-X.Y.Z-win-x64.zip \
  --clobber
# Then delete any stray assets if editing an existing release:
# gh release delete-asset vX.Y.Z <extra-name> --yes
```

## What else the script can build (local / CI debug only)

| Артефакт | Когда | Содержимое |
| --- | --- | --- |
| `stream-panel_<ver>_amd64.deb` | Linux + `dpkg-deb` | `/opt/stream-panel` + `/usr/bin/stream-panel`, bundled Node |
| `stream-panel-<ver>-linux-x64.tar.gz` | Linux **without** `--github-assets` | Portable tree: `runtime/` + `app/` + launcher |
| `stream-panel-<ver>-win-x64.zip` | Windows | Portable tree + `StreamPanel.exe` (csc) + `StreamPanel.cmd` |
| `stream-panel-<ver>-source.zip` | `--source` (ignored with `--github-assets`) | `git archive` snapshot |
| `SHA256SUMS` / `manifest.json` | Always written under `artifacts/release/` | Local verify only — **never** Release assets |

Native `better-sqlite3` ставится в staging под целевую ОС (не SEA). Electron не используется. Inno/NSIS installer not required yet: the win zip with `StreamPanel.exe` is the single Windows Release asset.

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
- `--github-assets` — only `.deb` (linux) or win zip; skip portable tar.gz / source
- `STREAM_PANEL_VERSION` / `STREAM_PANEL_NODE_VERSION` — переопределения

Linux `.deb` требует `dpkg-deb`. Windows `.exe` собирается через `csc` (.NET Framework / vswhere Roslyn) на `windows-latest`; job падает, если `StreamPanel.exe` нет в zip (без silent cmd-only).

## CI

Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml)

- push в `codex-init-grok` / `release-assets-slim` при изменении packaging-файлов
- push tag `v*`
- `workflow_dispatch` (после попадания workflow на default branch)

CI uploads **only** the two publishable binaries as Actions artifacts (`stream-panel-linux` = `.deb`, `stream-panel-windows` = win zip). GitHub Release upload is manual (or a future write-enabled job) and must keep the same two-asset policy.

## Установка (кратко)

**Debian/Ubuntu:** `sudo dpkg -i stream-panel_*_amd64.deb` → `stream-panel` → открыть URL из терминала.

**Windows:** распаковать zip → `StreamPanel.exe` (или `.cmd`) → открыть URL.

Данные по-прежнему в `%LOCALAPPDATA%\StreamPanel` / `~/.local/share/stream-panel`.
