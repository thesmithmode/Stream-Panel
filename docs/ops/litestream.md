# Litestream → R2 / B2 (optional remote backup)

Continuous SQLite replication without a managed database. **Optional** — the app runs fully offline with local snapshots. No secrets belong in git.

## Prerequisites

1. Cloudflare account + R2 bucket (preferred: zero egress) **or** Backblaze B2 bucket.
2. Object Read & Write API token / application key.
3. [Litestream](https://litestream.io/) installed on the same machine as the daemon.
4. Example config: [`litestream.yml.example`](../../litestream.yml.example) at the repo root.

## Environment (no secrets in repo)

| Variable | Purpose |
| --- | --- |
| `STREAM_PANEL_DB_PATH` | Absolute path to `data.sqlite` |
| `AWS_ACCESS_KEY_ID` / `LITESTREAM_ACCESS_KEY_ID` | R2/B2 access key |
| `AWS_SECRET_ACCESS_KEY` / `LITESTREAM_SECRET_ACCESS_KEY` | Secret |
| `R2_ACCOUNT_ID` | Cloudflare account id (R2 endpoint) |
| `LITESTREAM_CONFIG` | Optional path to your local `litestream.yml` |

## Run

```sh
cp litestream.yml.example /path/to/litestream.yml
# edit path/endpoint/bucket; keep keys in env only
export STREAM_PANEL_DB_PATH="$HOME/.local/share/stream-panel/data.sqlite"
export R2_ACCOUNT_ID=...
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
./scripts/litestream-replicate.sh
```

`scripts/litestream-replicate.sh` exits **0** with a skip message when Litestream or credentials are unset (graceful no-op for local/dev).

Restore on a new machine:

```sh
litestream restore -config /path/to/litestream.yml -o ./data.sqlite "$STREAM_PANEL_DB_PATH"
```

Then point `STREAM_PANEL_DATA_DIR` at the restored folder and re-login to Twitch/DA (tokens are not in the DB snapshot).

## Safety

- One writer: do not run two daemons against the same live DB.
- Prefer restore into a **new** data directory, then validate with the app.
- Local «Создать резервную копию» remains the supported in-app snapshot path.
