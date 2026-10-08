Linux amd64 release for local testing of the browser UI. Ubuntu 22.04+/Debian 12+.

1. Stop the old Stream Panel before upgrading (`stream-panel --stop` in the old installation, or stop its running terminal/service).
2. Download the `.deb` asset and run `sudo apt install ./stream-panel_0.1.3_amd64.deb`.
3. Launch Stream Panel from the application menu or run `stream-panel`. The panel opens directly with no login or password prompt. Keep the terminal open while using the app.

The first launch copies the old SQLite database (including WAL) and DA/Twitch configuration from `~/.local/share/stream-panel` to `~/.local/share/stream-panel-local`. The original directory is untouched. An additional original snapshot is kept in `legacy-backup/`; imports refuse an active old collector or an existing destination. Package installation/removal never edits user data as root. Subsequent launches retain history and settings. At the bottom left, select Руслан or Гульназ. Руслан keeps the existing Twitch/DonationAlerts profile; Гульназ has separate history and credentials ready for later setup.

Local backups are encrypted using `stream-panel-local/backup-key`. Keep that key with your backups. Supabase upload requires a configured private Storage bucket and service key; a Postgres database password alone does not enable it. The old partial table export is not a complete history backup.

DA client ID/secret remain unchanged. For local testing the callback remains `http://127.0.0.1:47831/oauth/donationalerts/callback`; register the exact callback shown in Settings in the existing DA application. A VPS needs its HTTPS callback registered there.

This release does not promote an unverified VPS installation. Production deployment requires `STREAM_PANEL_PRODUCTION_ENABLED=true` after the separate live connectivity/backup/rollback gates pass.

The panel opens directly without a login prompt. Use the profile selector at the bottom left to switch between Руслан and Гульназ. Руслан retains the existing Twitch and DonationAlerts connections; Гульназ has separate history and connection settings for a future account.
