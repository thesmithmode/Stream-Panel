Linux amd64 preview for testing the browser UI locally. Ubuntu 22.04+/Debian 12+.

1. Stop the old Stream Panel before upgrading (`stream-panel --stop` in the old installation, or stop its running terminal/service).
2. Download the `.deb` asset and run `sudo apt install ./stream-panel_0.1.2_amd64.deb`.
3. Launch Stream Panel from the application menu or run `stream-panel`. First launch asks for a local password (14+ characters); browser login is `ruslan`. Keep the terminal open while using the app.

The first launch copies the old SQLite database (including WAL) and DA/Twitch configuration from `~/.local/share/stream-panel` to `~/.local/share/stream-panel-local`. The original directory is untouched. An additional original snapshot is kept in `legacy-backup/`; imports refuse an active old collector or an existing destination. Package installation/removal never edits user data as root. Subsequent launches retain accounts, history and settings.

Local backups are encrypted using `stream-panel-local/backup-key`. Keep that key with your backups. Supabase upload requires a configured private Storage bucket and service key; a Postgres database password alone does not enable it. The old partial table export is not a complete history backup.

DA client ID/secret remain unchanged. For local testing the callback remains `http://127.0.0.1:47831/oauth/donationalerts/callback`; register the exact callback shown in Settings in the existing DA application. A VPS needs its HTTPS callback registered there.

This release does not promote an unverified VPS installation. Production deployment requires `STREAM_PANEL_PRODUCTION_ENABLED=true` after the separate live connectivity/backup/rollback gates pass.

Password recovery: stop the app (Ctrl+C in its terminal), then run `stream-panel --reset-password`. Enter the new password twice. The command makes an encrypted backup first, resets only the ruslan password and revokes old login sessions; history and provider keys remain intact.
