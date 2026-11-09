/** Keep provider samples intact; subtract the Twitch streamer's baseline on every read.
 * NULL is an unknown measurement, while zero must stay zero. */
export const viewerAdjustmentSchema=`
DROP VIEW logical_stream_samples;
CREATE VIEW logical_stream_samples AS
 SELECT p.session_id,p.observed_at_ms,p.category_id,p.category_name,p.title,
 max(0,p.twitch_viewers-1) AS twitch_viewers,p.youtube_viewers
 FROM stream_samples p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.observed_at_ms,p.category_id,p.category_name,p.title,
 max(0,p.twitch_viewers-1),p.youtube_viewers
 FROM session_groups g JOIN stream_samples p ON p.session_id=g.member_id;
DELETE FROM analytics_reports;
DELETE FROM analytics_stream_facts;
DELETE FROM analytics_activity_details;
DELETE FROM analytics_stream_cache;
UPDATE analytics_fact_versions SET activity=activity+1;
UPDATE analytics_stream_revisions SET revision=revision+1;
UPDATE analytics_global_revision SET revision=revision+1;
UPDATE ui_revisions SET revision=revision+1;
PRAGMA user_version=33;
`;
