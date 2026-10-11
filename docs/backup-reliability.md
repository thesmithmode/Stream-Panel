# Backup reliability and recovery

Scheduled snapshots are independent of platform collectors. A one-minute scheduler checks persisted last success and creates a verified encrypted SQLite snapshot every 12 hours. Moscow calendar days determine retention: newest snapshot for each of today and the previous six days, then newest available points in days 7–13, 14–20 and 21–29. Sparse history is never fabricated. Future-dated copies are preserved until the clock catches up.

Each installation has a persisted random identifier under `stream-panel/<installationId>` in the private Storage bucket. Restoring an archive to a new directory creates a new identifier; local machines cannot rotate server archives. Existing unscoped remote archives remain untouched.

Pending uploads survive restart in atomic `backup-state.json`. Startup also recovers published archives whose queue registration was interrupted by a crash. Failed uploads retry after 1, 2, 4, 8, 16, 32, then 60 minutes, capped at one hour. Each scheduler tick uploads up to four oldest pending archives. Immutable duplicate uploads must pass a download/hash comparison. Pending local archives are never pruned, including while cloud credentials are absent. This may use extra disk space during a long outage; snapshot creation checks free space and fails visibly before exhausting the disk. Cloud errors and outstanding uploads are visible in the authenticated panel and Integrations.

Deployment forwards `STREAM_PANEL_SUPABASE_KEY` from the production GitHub environment to a root-owned, service-readable file. Missing credentials preserve existing settings but the final real cloud restore check fails. The AES recovery key is not rotated by this setup. Two fixed profiles, ruslan and gulnaz, remain supported as requested.

## Recovery procedure

GitHub Secrets cannot be read back through the settings/API. A trusted explicitly dispatched workflow can use the secret. `recovery-proof.yml` compares the GitHub AES key to the actual server key, restores a real local archive into a new temporary directory, checks SQLite integrity/foreign keys/profile schemas, and verifies the Gulnaz password against the live scrypt hash. Only then does it encrypt the requested values to the recipient public key. Neither plaintext credentials nor the private recipient key belong in git or workflow logs. The encrypted export expires after one day. If the recipient private key is lost, generate a new recipient pair before dispatch; this does not change the database recovery key.

Keep the verified AES key in a separate password manager and an independent emergency recovery method. GitHub Secrets alone do not provide an operator-readable recovery copy. A failed credential comparison must not silently reset a user password or rotate the AES key.

## Outstanding live checks

- Add the missing production `STREAM_PANEL_SUPABASE_KEY` for the existing project, then verify an actual upload/download/restore. The private bucket was confirmed empty during investigation.
- Dispatch the recovery proof on main and decrypt its verified export before handing the AES key and existing Gulnaz credentials to the owner. Dispatch was blocked by automatic approval review's usage limit; do not bypass that rejection with a different execution path.
- After successful export, remove the one-time recovery workflow, script and public recipient key.
- Confirm production is running the new commit, database integrity, Redis invalidation, RAM/disk headroom, pending queue and cloud freshness after deployment.
- Supabase Free may pause inactive projects. Regular uploads do not guarantee exemption. Paid-plan changes require the owner's choice; preserve local pending archives and visible alerts while paused.

Earlier login polling and responsive analytics fixes, Redis cache verification, and main/dev alignment are already in the repository. They must remain covered by the quality gate; do not report a local change as deployed until the server verification completes.
