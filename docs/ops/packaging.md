# Packaging — Windows `.exe` / Linux `.deb`

Дата: **2026-10-07** (МСК). Ветка работ: `codex-init-grok`.

## Что собирается

| Артефакт | Где | Содержимое |
| --- | --- | --- |
| `stream-panel_<ver>_amd64.deb` | Ubuntu runner / локальный Linux | `/opt/stream-panel` + `/usr/bin/stream-panel`, bundled Node |
| `stream-panel-<ver>-linux-x64.tar.gz` | Linux | Portable tree: `runtime/` + `app/` + `stream-panel` launcher |
| `stream-panel-<ver>-win-x64.zip` | Windows runner | Portable tree: `runtime/node.exe` + `app/` + `StreamPanel.exe` (csc) + `StreamPanel.cmd` |
| `stream-panel-<ver>-source.zip` | Linux job (`--source`) | `git archive` snapshot |

Checksums: `artifacts/release/SHA256SUMS` + `manifest.json`.

Native `better-sqlite3` ставится в staging под целевую ОС (не SEA). Electron не используется.

## Локально

```sh
pnpm build
pnpm package                 # полный цикл (build внутри, если без --skip-build)
# или
node scripts/package-release.mjs --skip-build --source
```

Опции:

- `--skip-build` — уже есть `dist/`
- `--skip-runtime` — не скачивать Node (только для отладки layout)
- `--source` — добавить source zip
- `STREAM_PANEL_VERSION` / `STREAM_PANEL_NODE_VERSION` — переопределения

Linux `.deb` требует `dpkg-deb`. Windows `.exe` собирается через `csc` (.NET Framework) на `windows-latest`.

## CI

Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml)

- `workflow_dispatch` — ручной запуск с ветки `codex-init-grok`
- push tag `v*` — артефакты к прогону

Артефакты GitHub Actions: `stream-panel-linux`, `stream-panel-windows` (retention 14d). GitHub Release upload не делается автоматически на этой стадии (нет write `contents` / merge в `main`).

## Установка (кратко)

**Debian/Ubuntu:** `sudo dpkg -i stream-panel_*_amd64.deb` → `stream-panel` → открыть URL из терминала.

**Windows:** распаковать zip → `StreamPanel.exe` (или `.cmd`) → открыть URL.

Данные по-прежнему в `%LOCALAPPDATA%\StreamPanel` / `~/.local/share/stream-panel`.
