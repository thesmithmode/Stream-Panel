/** Seek once per distinct payload, not once per repeated provider check.
 * Check time and check ID retain the existing latest-observation tie break.
 * Only follower payloads participate; pending donations are a separate archive.
 */
export const latestFollowerChecksSql = `WITH versions AS MATERIALIZED (
 SELECT p.source,p.account_id,p.id AS snapshot_id,
  (SELECT c.id FROM follower_checks c WHERE c.snapshot_id=p.id ORDER BY c.observed_at_ms DESC,c.id DESC LIMIT 1) AS check_id
 FROM provider_snapshots p WHERE p.key='followers'
), ranked AS (
 SELECT v.source,v.account_id,v.snapshot_id,c.id,c.observed_at_ms,
  row_number() OVER(PARTITION BY v.source,v.account_id ORDER BY c.observed_at_ms DESC,c.id DESC) AS position
 FROM versions v JOIN follower_checks c ON c.id=v.check_id
)
SELECT source,account_id,snapshot_id,id,observed_at_ms FROM ranked WHERE position=1`;

export const latestFollowerSnapshotsSql = `SELECT p.source,p.account_id,p.payload_json
 FROM (${latestFollowerChecksSql}) latest JOIN provider_snapshots p ON p.id=latest.snapshot_id`;

/** Keep every check during the stream plus the current check for each account.
 * The read-side observation view still handles linked streams and profile scope.
 */
export const streamFollowerObservationsSql = `WITH latest AS MATERIALIZED (${latestFollowerChecksSql})
 SELECT source,account_id AS account,observed_at_ms AS at,payload_json
 FROM follower_observations p WHERE key='followers' AND
  ((observed_at_ms>=? AND observed_at_ms<=?) OR id IN(SELECT id FROM latest))
 ORDER BY observed_at_ms`;
