# Remote database / Supabase (lean sync)

Local SQLite remains the source of truth. OAuth tokens and `secrets.json` **never** leave the machine.

## Connection order

1. `STREAM_PANEL_DATABASE_POOLER_URL` (Session pooler — preferred on IPv4-only hosts)
2. `STREAM_PANEL_DATABASE_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` (direct)
3. Files under `STREAM_PANEL_CREDS_DIR` (default unset): `supabase-pooler-url.txt`, then `supabase-database-url.txt`

Direct `db.<ref>.supabase.co` is often **IPv6-only**; use the pooler (`aws-0-<region>.pooler.supabase.com`, user `postgres.<ref>`).

## What syncs

Upsert into `sp_persons`, `sp_identities`, `sp_events`, `sp_presence_polls`, `sp_presence_members` on a timer (default 60s). Caps: recent events/presence only (free-tier lean).

## Secrets

Store URLs/passwords **outside** the git repo (e.g. `STREAM_PANEL_CREDS_DIR` with mode `600` files). Do not commit `stream-panel-live-creds/` or print URLs with passwords.
