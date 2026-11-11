import {WELL_KNOWN_TWITCH_BOTS,normalizeBotLogin} from './bots.js';

// Operational accounts are never audience, even if marked human or bot display is on.
// Retain all original identities, messages and polls for repairs and rollback.
const names=JSON.stringify(WELL_KNOWN_TWITCH_BOTS.map(normalizeBotLogin));
export const serviceAccountsSchema=`
CREATE VIEW IF NOT EXISTS service_people AS
 SELECT person_id FROM identities WHERE source='twitch' AND
  (external_id=account_id OR match_key IN(SELECT value FROM json_each('${names}')))
 UNION SELECT i.person_id FROM identities i JOIN identity_aliases a ON a.identity_id=i.id
  WHERE i.source='twitch' AND ltrim(a.candidate_key,'@#') IN(SELECT value FROM json_each('${names}'))
 UNION SELECT person_id FROM youtube_identities WHERE is_owner=1 OR external_id=account_id
  OR match_key IN('streamelements','streemelements')
 UNION SELECT y.person_id FROM youtube_identities y JOIN youtube_identity_aliases a ON a.identity_id=y.id
  WHERE a.match_key IN('streamelements','streemelements');
-- Repair only streams whose audience arithmetic changes. Period replies are small,
-- disposable projections; unchanged per-stream facts and reductions remain reusable.
CREATE TEMP TABLE service_repair_sessions(session_id TEXT PRIMARY KEY) WITHOUT ROWID;
INSERT OR IGNORE INTO service_repair_sessions
 SELECT es.session_id FROM service_people p JOIN identities i ON i.person_id=p.person_id JOIN events e ON e.identity_id=i.id JOIN event_sessions es ON es.event_id=e.id
 UNION SELECT poll.session_id FROM service_people p JOIN identities i ON i.person_id=p.person_id JOIN presence_members m ON m.identity_id=i.id JOIN presence_polls poll ON poll.id=m.poll_id
 UNION SELECT ps.session_id FROM service_people p JOIN youtube_identities y ON y.person_id=p.person_id JOIN youtube_messages m ON m.account_id=y.account_id AND m.author_id=y.external_id JOIN platform_streams ps ON ps.platform='youtube' AND ps.account_id=m.account_id AND ps.started_at_ms<=m.published_at_ms AND coalesce(ps.ended_at_ms,9223372036854775807)>m.published_at_ms;
INSERT OR IGNORE INTO service_repair_sessions SELECT group_id FROM session_groups WHERE member_id IN(SELECT session_id FROM service_repair_sessions);
DELETE FROM analytics_reports;
DELETE FROM analytics_stream_facts WHERE session_id IN(SELECT session_id FROM service_repair_sessions);
DELETE FROM analytics_money_facts WHERE session_id IN(SELECT session_id FROM service_repair_sessions);
DELETE FROM analytics_activity_details WHERE session_id IN(SELECT session_id FROM service_repair_sessions);
DELETE FROM analytics_stream_cache WHERE session_id IN(SELECT session_id FROM service_repair_sessions);
UPDATE analytics_fact_versions SET activity=activity+1,money=money+1 WHERE session_id IN(SELECT session_id FROM service_repair_sessions);
DROP TABLE service_repair_sessions;
UPDATE analytics_global_revision SET revision=revision+1;
UPDATE ui_revisions SET revision=revision+1;
PRAGMA user_version=35;
`;
