# Recent event content

Schema v23 adds a disposable `recent_events` table inside each profile namespace.
Permanent message observations, identities, deduplication keys, donations and analytical facts are unchanged. Twitch accepted notifications and YouTube chat events retain normalized payloads and author labels; redundant Twitch transport envelopes are omitted. Previously discarded content cannot be recovered.

Retention is a rolling 48 hours from the event occurrence time, falling back to receipt time when the occurrence time is unknown. Historical REST imports and duplicate deliveries do not resurrect expired content. Reads exclude expired rows immediately. Physical deletion processes at most 500 rows per profile per minute using the timestamp index; busy queues defer work, and there are no overlapping cleanup passes or catch-up loops. Under normal load, deletion can lag expiration by up to a minute; a busy or stopped service can delay physical cleanup. Freed SQLite pages are reused without periodic VACUUM.

Cleanup is a maintenance RPC: it has no analytics revision triggers and does not invalidate read caches. The archive endpoint is deliberately uncached so expiry remains accurate. `GET /api/v1/events/recent?offset=0&limit=100` uses the existing authenticated profile routing, returns newest first, and allows at most 200 rows per response. Existing history endpoints and the UI are unchanged.

Twitch moderation redacts archived message text, including messages received after their deletion notification. YouTube delete and ban notifications remove matching archived content for that account. The existing permanent moderation behavior is preserved.

Encrypted database backups may retain archived text beyond the live 48-hour window until those backups expire. Restored expired rows are invisible immediately and are cleaned in bounded passes when collection resumes. No changes are made to backup retention.
