// Migration 1. All times are UTC epoch milliseconds; names are never unique identifiers.

export const schemaV1 = `
CREATE TABLE persons (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('twitch', 'donationalerts')),
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id),
  UNIQUE(source, account_id, external_id)
) STRICT;
CREATE INDEX identities_candidate ON identities(candidate_key);
CREATE INDEX identities_person ON identities(person_id);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('twitch', 'donationalerts')),
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  type TEXT NOT NULL,
  identity_id TEXT REFERENCES identities(id),
  occurred_at_ms INTEGER,
  received_at_ms INTEGER NOT NULL,
  source_time TEXT,
  time_quality TEXT NOT NULL CHECK(time_quality IN ('provider','configured','unknown')),
  transport TEXT NOT NULL CHECK(transport IN ('eventsub','centrifugo','rest','streamerbot')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  CHECK((time_quality = 'unknown' AND occurred_at_ms IS NULL)
     OR (time_quality != 'unknown' AND occurred_at_ms IS NOT NULL)),
  UNIQUE(source, account_id, type, external_id)
) STRICT;
CREATE INDEX events_time ON events(occurred_at_ms, id);
CREATE INDEX events_identity_time ON events(identity_id, occurred_at_ms);
CREATE TABLE person_merges (
  id TEXT PRIMARY KEY,
  source_person_id TEXT NOT NULL REFERENCES persons(id),
  target_person_id TEXT NOT NULL REFERENCES persons(id),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
  created_at_ms INTEGER NOT NULL,
  undone_at_ms INTEGER
) STRICT;
PRAGMA user_version = 1;
`;

export const schemaV2 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, stream_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('platform','manual')),
  started_at_ms INTEGER NOT NULL, recording_started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER, end_quality TEXT NOT NULL DEFAULT 'unknown',
  UNIQUE(account_id, stream_id)
) STRICT;
CREATE UNIQUE INDEX sessions_one_open ON sessions(account_id) WHERE ended_at_ms IS NULL;
CREATE TABLE event_sessions (event_id TEXT PRIMARY KEY REFERENCES events(id), session_id TEXT NOT NULL REFERENCES sessions(id)) STRICT;
CREATE INDEX event_sessions_session ON event_sessions(session_id, event_id);
CREATE TABLE presence_polls (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), account_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL, completed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','partial','failed'))
) STRICT;
CREATE INDEX presence_polls_session_time ON presence_polls(session_id, completed_at_ms);
CREATE TABLE presence_members (
  poll_id TEXT NOT NULL REFERENCES presence_polls(id), identity_id TEXT NOT NULL REFERENCES identities(id),
  PRIMARY KEY(poll_id, identity_id)
) WITHOUT ROWID;
CREATE INDEX presence_members_identity ON presence_members(identity_id, poll_id);
CREATE TABLE identity_aliases (
  identity_id TEXT NOT NULL REFERENCES identities(id), name TEXT NOT NULL, candidate_key TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL, PRIMARY KEY(identity_id, name)
) WITHOUT ROWID;
CREATE TABLE collection_gaps (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, reason TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER
) STRICT;
CREATE TABLE membership_operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 2;
`;

// match_key: login-style key for high-confidence auto-link (strip @/#).
export const schemaV3 = `
ALTER TABLE identities ADD COLUMN match_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS identities_match ON identities(match_key);
PRAGMA user_version = 3;
`;

// YouTube data stays separate from Twitch/DA identity matching and currencies.
export const schemaV4 = `
CREATE TABLE youtube_snapshots (
  account_id TEXT NOT NULL, key TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  updated_at_ms INTEGER NOT NULL, PRIMARY KEY(account_id, key)
) WITHOUT ROWID;
CREATE TABLE youtube_messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  author_id TEXT NOT NULL, published_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX youtube_messages_time ON youtube_messages(account_id, published_at_ms);
PRAGMA user_version = 4;
`;

export const schemaV5 = `
CREATE TABLE stream_samples (
  session_id TEXT NOT NULL REFERENCES sessions(id), observed_at_ms INTEGER NOT NULL,
  category_id TEXT NOT NULL, category_name TEXT NOT NULL, title TEXT NOT NULL,
  twitch_viewers INTEGER, youtube_viewers INTEGER,
  PRIMARY KEY(session_id, observed_at_ms)
) WITHOUT ROWID;
PRAGMA user_version = 5;
`;

export const schemaV6 = `
CREATE TABLE platform_streams (
  platform TEXT NOT NULL CHECK(platform IN ('twitch','youtube')),
  account_id TEXT NOT NULL, external_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  last_observed_at_ms INTEGER NOT NULL,
  offline_checks INTEGER NOT NULL DEFAULT 0,
  first_missing_at_ms INTEGER,
  url TEXT, title TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(platform, account_id, external_id)
) STRICT;
CREATE INDEX platform_streams_session_end ON platform_streams(session_id, ended_at_ms);
INSERT INTO platform_streams
  (platform,account_id,external_id,session_id,started_at_ms,ended_at_ms,last_observed_at_ms,offline_checks,first_missing_at_ms,url,title)
SELECT 'twitch',s.account_id,s.stream_id,s.id,s.started_at_ms,s.ended_at_ms,
  COALESCE((SELECT MAX(observed_at_ms) FROM stream_samples WHERE session_id=s.id),s.recording_started_at_ms),
  0,NULL,NULL,
  COALESCE((SELECT title FROM stream_samples WHERE session_id=s.id ORDER BY observed_at_ms DESC LIMIT 1),'')
FROM sessions s WHERE s.kind='platform';
PRAGMA user_version = 6;
`;

export const schemaV7 = `
CREATE TABLE person_notes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX person_notes_person_created ON person_notes(person_id, created_at_ms);
CREATE TABLE person_tags (
  person_id TEXT NOT NULL REFERENCES persons(id),
  label TEXT NOT NULL,
  PRIMARY KEY(person_id, label)
) WITHOUT ROWID;
CREATE TABLE person_preferences (
  person_id TEXT PRIMARY KEY REFERENCES persons(id),
  manual_core INTEGER CHECK(manual_core IN (0, 1))
) STRICT;
PRAGMA user_version = 7;
`;

// YouTube membership is separate from legacy identity constraints, but shares Person.
export const schemaV8 = `
CREATE TABLE youtube_identities (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, external_id TEXT NOT NULL,
 display_name TEXT NOT NULL, match_key TEXT NOT NULL,
 person_id TEXT NOT NULL REFERENCES persons(id), is_owner INTEGER NOT NULL DEFAULT 0,
 UNIQUE(account_id,external_id)
) STRICT;
CREATE INDEX youtube_identities_person ON youtube_identities(person_id);
CREATE TABLE youtube_identity_aliases (
 identity_id TEXT NOT NULL REFERENCES youtube_identities(id), name TEXT NOT NULL,
 match_key TEXT NOT NULL, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
 PRIMARY KEY(identity_id,name)
) WITHOUT ROWID;
INSERT OR IGNORE INTO persons(id,display_name,revision)
 SELECT 'youtube:'||author_id,coalesce(max(nullif(json_extract(payload_json,'$.authorDetails.displayName'),'')),author_id),1
 FROM youtube_messages WHERE author_id<>'' AND length(author_id)<=256 AND author_id NOT GLOB '*[^A-Za-z0-9_-]*'
 GROUP BY author_id;
INSERT INTO youtube_identities(id,account_id,external_id,display_name,match_key,person_id,is_owner)
 SELECT 'youtube:'||account_id||':'||author_id,account_id,author_id,
 coalesce(max(nullif(json_extract(payload_json,'$.authorDetails.displayName'),'')),author_id),
 lower(ltrim(trim(coalesce(max(nullif(json_extract(payload_json,'$.authorDetails.displayName'),'')),author_id)),'@#')),
 'youtube:'||author_id,max(coalesce(json_extract(payload_json,'$.authorDetails.isChatOwner'),0)=1)
 FROM youtube_messages WHERE author_id<>'' AND length(author_id)<=256 AND author_id NOT GLOB '*[^A-Za-z0-9_-]*'
 GROUP BY account_id,author_id;
INSERT INTO youtube_identity_aliases
 SELECT i.id,json_extract(m.payload_json,'$.authorDetails.displayName'),
 lower(ltrim(trim(json_extract(m.payload_json,'$.authorDetails.displayName')),'@#')),
 min(m.published_at_ms),max(m.published_at_ms)
 FROM youtube_messages m JOIN youtube_identities i ON i.account_id=m.account_id AND i.external_id=m.author_id
 WHERE json_type(m.payload_json,'$.authorDetails.displayName')='text'
 GROUP BY i.id,json_extract(m.payload_json,'$.authorDetails.displayName');
PRAGMA user_version = 8;
`;

export const schemaV9 = `
CREATE TABLE session_tombstones (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id), deleted_at_ms INTEGER NOT NULL,
 before_event_ids_json TEXT NOT NULL CHECK(json_valid(before_event_ids_json))
) STRICT;
PRAGMA user_version = 9;
`;

export const schemaV10 = `
CREATE TABLE split_guards (
 operation_id TEXT PRIMARY KEY REFERENCES membership_operations(id),
 source_person_id TEXT NOT NULL REFERENCES persons(id),
 target_person_id TEXT NOT NULL REFERENCES persons(id),
 expected_json TEXT NOT NULL CHECK(json_valid(expected_json)), undone_at_ms INTEGER
) STRICT;
PRAGMA user_version = 10;
`;

export const schemaV11 = `
CREATE TABLE donation_corrections (
 event_id TEXT PRIMARY KEY REFERENCES events(id), identity_id TEXT REFERENCES identities(id),
 occurred_at_ms INTEGER, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 deleted INTEGER NOT NULL CHECK(deleted IN(0,1)), revision INTEGER NOT NULL CHECK(revision>=1), updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE donation_audit (
 id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),revision INTEGER NOT NULL,kind TEXT NOT NULL,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at_ms INTEGER NOT NULL,
 UNIQUE(event_id,revision)
) STRICT;
CREATE INDEX donation_audit_event ON donation_audit(event_id,revision);
CREATE TABLE anonymous_donors (account_id TEXT PRIMARY KEY,identity_id TEXT NOT NULL REFERENCES identities(id)) STRICT;
INSERT OR IGNORE INTO persons(id,display_name,revision) SELECT DISTINCT 'anonymous:person:'||account_id,'Аноним',1 FROM events WHERE source='donationalerts' AND type='donation' AND identity_id IS NULL;
INSERT OR IGNORE INTO identities(id,source,account_id,external_id,display_name,candidate_key,person_id,match_key)
 SELECT DISTINCT 'anonymous:identity:'||account_id,'donationalerts',account_id,'anonymous:donor','Аноним','','anonymous:person:'||account_id,'anonymous:'||account_id FROM events WHERE source='donationalerts' AND type='donation' AND identity_id IS NULL;
INSERT INTO anonymous_donors SELECT DISTINCT account_id,'anonymous:identity:'||account_id FROM events WHERE source='donationalerts' AND type='donation' AND identity_id IS NULL;
CREATE VIEW effective_events AS SELECT e.id,e.source,e.account_id,e.external_id,e.type,coalesce(c.identity_id,e.identity_id,a.identity_id) AS identity_id,
 CASE WHEN c.event_id IS NULL THEN e.occurred_at_ms ELSE c.occurred_at_ms END AS occurred_at_ms,
 e.received_at_ms,e.source_time,CASE WHEN c.event_id IS NULL THEN e.time_quality WHEN c.occurred_at_ms IS NULL THEN 'unknown' ELSE 'configured' END AS time_quality,
 e.transport,coalesce(c.payload_json,e.payload_json) AS payload_json
 FROM events e LEFT JOIN donation_corrections c ON c.event_id=e.id LEFT JOIN anonymous_donors a ON a.account_id=e.account_id AND e.source='donationalerts' AND e.type='donation' WHERE coalesce(c.deleted,0)=0;
PRAGMA user_version = 11;
`;

export const schemaV12 = `
CREATE TABLE collector_state (id INTEGER PRIMARY KEY CHECK(id=1),last_seen_ms INTEGER NOT NULL,running INTEGER NOT NULL CHECK(running IN(0,1))) STRICT;
CREATE TABLE provider_snapshots (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL,
 observed_at_ms INTEGER NOT NULL, session_id TEXT REFERENCES sessions(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX provider_snapshots_session_time ON provider_snapshots(session_id,observed_at_ms);
CREATE INDEX provider_snapshots_account_time ON provider_snapshots(source,account_id,key,observed_at_ms);
PRAGMA user_version = 12;
`;

export const schemaV13 = `
CREATE TABLE donor_bindings (
 name_key TEXT PRIMARY KEY,name TEXT NOT NULL,person_id TEXT NOT NULL REFERENCES persons(id),
 identity_id TEXT REFERENCES identities(id),updated_at_ms INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 13;
`;

/** Time-range donation/chat reads and author lookups must stay indexed as history grows. */
export const schemaV14 = `
CREATE INDEX events_type_time ON events(type,occurred_at_ms,id);
CREATE INDEX events_type_received ON events(type,received_at_ms,id);
CREATE INDEX youtube_messages_author_time ON youtube_messages(account_id,author_id,published_at_ms);
PRAGMA user_version = 14;
`;

/** Chat content is not a product feature. Retain only counting/deduplication metadata. */
export const schemaV15 = `
UPDATE events SET payload_json=json_object('count',1,
 'originChannelId',json_extract(payload_json,'$.originChannelId'),
 'redacted',coalesce(json_extract(payload_json,'$.redacted'),0)) WHERE type='chat.message';
UPDATE events SET payload_json=json_object(
 'targetMessageId',json_extract(payload_json,'$.targetMessageId'),
 'targetUserId',json_extract(payload_json,'$.targetUserId'))
 WHERE type IN ('chat.message_delete','chat.clear','chat.clear_user_messages');
UPDATE youtube_messages SET payload_json=json_object(
 'snippet',json_object('type',json_extract(payload_json,'$.snippet.type'),'publishedAt',json_extract(payload_json,'$.snippet.publishedAt')),
 'authorDetails',json_object('channelId',json_extract(payload_json,'$.authorDetails.channelId'),
 'displayName',json_extract(payload_json,'$.authorDetails.displayName'),
 'isChatOwner',coalesce(json_extract(payload_json,'$.authorDetails.isChatOwner'),0)));
DELETE FROM provider_snapshots WHERE source='youtube' AND substr(key,1,5)='chat:';
DELETE FROM youtube_snapshots WHERE substr(key,1,5)='chat:';
PRAGMA user_version = 15;
`;

/** Diagnostic API copies are unused; follower history and unparsed money must survive. */
export const schemaV16 = `
UPDATE provider_snapshots SET payload_json=json_object(
 'followers',json((SELECT coalesce(json_group_array(json_object('id',json_extract(f.value,'$.id'),'name',json_extract(f.value,'$.name'),'followedAtMs',json_extract(f.value,'$.followedAtMs'))),'[]') FROM json_each(provider_snapshots.payload_json,'$.followers') f)),
 'complete',json(CASE WHEN json_extract(payload_json,'$.complete') THEN 'true' ELSE 'false' END),
 'total',json_extract(payload_json,'$.total')) WHERE key='followers';
DELETE FROM provider_snapshots WHERE key NOT IN('followers','donation_unparsed');
DELETE FROM youtube_snapshots WHERE substr(key,1,4)='api:';
PRAGMA user_version = 16;
`;

/** Compact access indexes and share unchanged follower payloads without dropping poll times. */
export const schemaV17=`
CREATE INDEX IF NOT EXISTS sessions_start ON sessions(started_at_ms DESC,id DESC);
DROP INDEX events_time;
CREATE INDEX events_time ON events(occurred_at_ms);
DROP INDEX events_type_time;
CREATE INDEX events_type_time ON events(type,occurred_at_ms);
DROP INDEX events_type_received;
CREATE INDEX events_type_received ON events(type,received_at_ms);
DROP INDEX event_sessions_session;
CREATE INDEX event_sessions_session ON event_sessions(session_id);
CREATE INDEX IF NOT EXISTS events_identity_activity ON events(identity_id,coalesce(occurred_at_ms,received_at_ms)) WHERE type!='donation';
CREATE TABLE IF NOT EXISTS follower_checks (
 id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES provider_snapshots(id),observed_at_ms INTEGER NOT NULL,session_id TEXT REFERENCES sessions(id)
) STRICT;
CREATE INDEX IF NOT EXISTS follower_checks_snapshot_time ON follower_checks(snapshot_id,observed_at_ms);
CREATE INDEX IF NOT EXISTS follower_checks_time ON follower_checks(observed_at_ms);
INSERT OR IGNORE INTO follower_checks SELECT id,id,observed_at_ms,session_id FROM provider_snapshots p WHERE key='followers' AND NOT EXISTS(SELECT 1 FROM follower_checks c WHERE c.snapshot_id=p.id);
CREATE VIEW IF NOT EXISTS follower_observations AS SELECT c.id,p.source,p.account_id,p.key,c.observed_at_ms,c.session_id,p.payload_json
 FROM follower_checks c JOIN provider_snapshots p ON p.id=c.snapshot_id;
PRAGMA user_version=17;
`;

/** Closed-stream reports are derived and invalidated by factual mutations. */
export const schemaV18=`
CREATE TABLE IF NOT EXISTS analytics_stream_revisions(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
INSERT OR IGNORE INTO analytics_stream_revisions SELECT id,0 FROM sessions;
CREATE TABLE IF NOT EXISTS analytics_global_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
INSERT OR IGNORE INTO analytics_global_revision VALUES(1,0);
CREATE TABLE IF NOT EXISTS analytics_stream_cache(session_id TEXT NOT NULL,cache_key TEXT NOT NULL,revision INTEGER NOT NULL,global_revision INTEGER NOT NULL,payload BLOB NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(session_id,cache_key)) STRICT;
CREATE TRIGGER IF NOT EXISTS analytics_sessions_insert AFTER INSERT ON sessions BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_sessions_update AFTER UPDATE ON sessions BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_sessions_delete AFTER DELETE ON sessions BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_stream_samples_insert AFTER INSERT ON stream_samples BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_stream_samples_update AFTER UPDATE ON stream_samples BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_stream_samples_delete AFTER DELETE ON stream_samples BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_platform_streams_insert AFTER INSERT ON platform_streams BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_platform_streams_update AFTER UPDATE ON platform_streams BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_platform_streams_delete AFTER DELETE ON platform_streams BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_polls_insert AFTER INSERT ON presence_polls BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_polls_update AFTER UPDATE ON presence_polls BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_polls_delete AFTER DELETE ON presence_polls BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_event_sessions_replace BEFORE INSERT ON event_sessions BEGIN
 UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=NEW.event_id);
END;
CREATE TRIGGER IF NOT EXISTS analytics_event_sessions_insert AFTER INSERT ON event_sessions BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_event_sessions_update AFTER UPDATE ON event_sessions BEGIN
 UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id=OLD.session_id;
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_event_sessions_delete AFTER DELETE ON event_sessions BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_session_tombstones_insert AFTER INSERT ON session_tombstones BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_session_tombstones_update AFTER UPDATE ON session_tombstones BEGIN
   INSERT INTO analytics_stream_revisions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_session_tombstones_delete AFTER DELETE ON session_tombstones BEGIN
   INSERT INTO analytics_stream_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
  END;
CREATE TRIGGER IF NOT EXISTS analytics_events_insert AFTER INSERT ON events BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=NEW.id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_events_update AFTER UPDATE ON events BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=NEW.id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_events_delete AFTER DELETE ON events BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=OLD.id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_members_insert AFTER INSERT ON presence_members BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM presence_polls WHERE id=NEW.poll_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_members_update AFTER UPDATE ON presence_members BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM presence_polls WHERE id=NEW.poll_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_presence_members_delete AFTER DELETE ON presence_members BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM presence_polls WHERE id=OLD.poll_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_donation_corrections_insert AFTER INSERT ON donation_corrections BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=NEW.event_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_donation_corrections_update AFTER UPDATE ON donation_corrections BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=NEW.event_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_donation_corrections_delete AFTER DELETE ON donation_corrections BEGIN
   UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM event_sessions WHERE event_id=OLD.event_id);
  END;
CREATE TRIGGER IF NOT EXISTS analytics_identities_rename AFTER UPDATE ON identities WHEN OLD.person_id IS NOT NEW.person_id OR OLD.display_name IS NOT NEW.display_name OR OLD.match_key IS NOT NEW.match_key BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_identities_rename AFTER UPDATE ON youtube_identities WHEN OLD.is_owner IS NOT NEW.is_owner OR OLD.person_id IS NOT NEW.person_id OR OLD.display_name IS NOT NEW.display_name OR OLD.match_key IS NOT NEW.match_key BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_identity_aliases_insert AFTER INSERT ON identity_aliases WHEN EXISTS(SELECT 1 FROM events WHERE identity_id=NEW.identity_id) BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_identity_aliases_update AFTER UPDATE ON identity_aliases WHEN OLD.candidate_key IS NOT NEW.candidate_key BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_identity_aliases_delete AFTER DELETE ON identity_aliases BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_identity_aliases_insert AFTER INSERT ON youtube_identity_aliases WHEN EXISTS(SELECT 1 FROM youtube_messages m JOIN youtube_identities i ON i.account_id=m.account_id AND i.external_id=m.author_id WHERE i.id=NEW.identity_id) BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_identity_aliases_update AFTER UPDATE ON youtube_identity_aliases WHEN OLD.match_key IS NOT NEW.match_key BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_identity_aliases_delete AFTER DELETE ON youtube_identity_aliases BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_anonymous_donors_insert AFTER INSERT ON anonymous_donors BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_anonymous_donors_update AFTER UPDATE ON anonymous_donors BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_anonymous_donors_delete AFTER DELETE ON anonymous_donors BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_persons_rename AFTER UPDATE ON persons WHEN OLD.display_name IS NOT NEW.display_name BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_messages_insert AFTER INSERT ON youtube_messages BEGIN
  UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM platform_streams WHERE platform='youtube' AND account_id=NEW.account_id AND started_at_ms<=NEW.published_at_ms AND (ended_at_ms IS NULL OR ended_at_ms>NEW.published_at_ms));
 END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_messages_update AFTER UPDATE ON youtube_messages BEGIN
  UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM platform_streams WHERE platform='youtube' AND account_id=NEW.account_id AND started_at_ms<=NEW.published_at_ms AND (ended_at_ms IS NULL OR ended_at_ms>NEW.published_at_ms));
 END;
CREATE TRIGGER IF NOT EXISTS analytics_youtube_messages_delete AFTER DELETE ON youtube_messages BEGIN
  UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT session_id FROM platform_streams WHERE platform='youtube' AND account_id=OLD.account_id AND started_at_ms<=OLD.published_at_ms AND (ended_at_ms IS NULL OR ended_at_ms>OLD.published_at_ms));
 END;
PRAGMA user_version=18;
`;

// Redundant channel notifications have no analytical consumers. Lifecycle lives in platform_streams.
export const schemaV19 = `
DELETE FROM event_sessions WHERE event_id IN (
 SELECT id FROM events WHERE source='twitch' AND type NOT IN ('chat.message','chat.message_delete','chat.clear','chat.clear_user_messages','channel.update','follow','subscription','subscription.gift','subscription.message','raid','bits')
);
DELETE FROM events WHERE source='twitch' AND type NOT IN ('chat.message','chat.message_delete','chat.clear','chat.clear_user_messages','channel.update','follow','subscription','subscription.gift','subscription.message','raid','bits');
PRAGMA user_version=19;
`;

/** One ordered registry drives upgrades and profile SQL identifiers. Append new versions here. */
/** Exact membership facts use permanent numeric keys; the UUID interface stays stable. */
export const schemaV20 = `
CREATE TABLE presence_poll_keys (key INTEGER PRIMARY KEY AUTOINCREMENT,poll_id TEXT NOT NULL UNIQUE REFERENCES presence_polls(id)) STRICT;
CREATE TABLE presence_identity_keys (key INTEGER PRIMARY KEY AUTOINCREMENT,identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id)) STRICT;
INSERT INTO presence_poll_keys(poll_id) SELECT id FROM presence_polls ORDER BY rowid;
INSERT INTO presence_identity_keys(identity_id) SELECT id FROM identities ORDER BY rowid;
CREATE TABLE presence_members_compact (
 poll_key INTEGER NOT NULL REFERENCES presence_poll_keys(key) ON DELETE RESTRICT,
 identity_key INTEGER NOT NULL REFERENCES presence_identity_keys(key) ON DELETE RESTRICT,
 PRIMARY KEY(poll_key,identity_key)
) WITHOUT ROWID;
CREATE INDEX presence_members_compact_identity ON presence_members_compact(identity_key,poll_key);
INSERT INTO presence_members_compact SELECT p.key,i.key FROM presence_members m JOIN presence_poll_keys p ON p.poll_id=m.poll_id JOIN presence_identity_keys i ON i.identity_id=m.identity_id;
-- Equal counts plus inclusion prove exact equality because both relations are unique.
CREATE TABLE presence_transfer_check (valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
INSERT INTO presence_transfer_check SELECT
 (SELECT count(*) FROM presence_members)=(SELECT count(*) FROM presence_members_compact)
 AND NOT EXISTS(SELECT m.poll_id,m.identity_id FROM presence_members m EXCEPT SELECT p.poll_id,i.identity_id FROM presence_members_compact c JOIN presence_poll_keys p ON p.key=c.poll_key JOIN presence_identity_keys i ON i.key=c.identity_key);
DROP TABLE presence_transfer_check;
DROP TABLE presence_members;
CREATE VIEW presence_members AS SELECT p.poll_id,i.identity_id FROM presence_members_compact c JOIN presence_poll_keys p ON p.key=c.poll_key JOIN presence_identity_keys i ON i.key=c.identity_key;
CREATE TRIGGER presence_poll_keys_insert AFTER INSERT ON presence_polls BEGIN INSERT INTO presence_poll_keys(poll_id) VALUES(NEW.id); END;
CREATE TRIGGER presence_identity_keys_insert AFTER INSERT ON identities BEGIN INSERT INTO presence_identity_keys(identity_id) VALUES(NEW.id); END;
CREATE TRIGGER presence_poll_keys_delete BEFORE DELETE ON presence_polls BEGIN DELETE FROM presence_poll_keys WHERE poll_id=OLD.id; END;
CREATE TRIGGER presence_identity_keys_delete BEFORE DELETE ON identities BEGIN DELETE FROM presence_identity_keys WHERE identity_id=OLD.id; END;
CREATE TRIGGER presence_members_insert INSTEAD OF INSERT ON presence_members BEGIN
 INSERT INTO presence_members_compact VALUES((SELECT key FROM presence_poll_keys WHERE poll_id=NEW.poll_id),(SELECT key FROM presence_identity_keys WHERE identity_id=NEW.identity_id));
END;
CREATE TRIGGER presence_members_delete INSTEAD OF DELETE ON presence_members BEGIN
 DELETE FROM presence_members_compact WHERE poll_key=(SELECT key FROM presence_poll_keys WHERE poll_id=OLD.poll_id) AND identity_key=(SELECT key FROM presence_identity_keys WHERE identity_id=OLD.identity_id);
END;
CREATE TRIGGER presence_members_update INSTEAD OF UPDATE ON presence_members BEGIN
 UPDATE presence_members_compact SET poll_key=(SELECT key FROM presence_poll_keys WHERE poll_id=NEW.poll_id),identity_key=(SELECT key FROM presence_identity_keys WHERE identity_id=NEW.identity_id) WHERE poll_key=(SELECT key FROM presence_poll_keys WHERE poll_id=OLD.poll_id) AND identity_key=(SELECT key FROM presence_identity_keys WHERE identity_id=OLD.identity_id);
END;
CREATE TRIGGER analytics_presence_compact_insert AFTER INSERT ON presence_members_compact BEGIN
 UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT p.session_id FROM presence_polls p JOIN presence_poll_keys k ON k.poll_id=p.id WHERE k.key=NEW.poll_key);
END;
CREATE TRIGGER analytics_presence_compact_delete AFTER DELETE ON presence_members_compact BEGIN
 UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT p.session_id FROM presence_polls p JOIN presence_poll_keys k ON k.poll_id=p.id WHERE k.key=OLD.poll_key);
END;
CREATE TRIGGER analytics_presence_compact_update AFTER UPDATE ON presence_members_compact BEGIN
 UPDATE analytics_stream_revisions SET revision=revision+1 WHERE session_id IN(SELECT p.session_id FROM presence_polls p JOIN presence_poll_keys k ON k.poll_id=p.id WHERE k.key IN(OLD.poll_key,NEW.poll_key));
END;
PRAGMA user_version=20;
`;

/** Grouping is a read-side projection: original facts and foreign keys are unchanged. */
export const schemaV21 = `
CREATE TABLE IF NOT EXISTS session_groups(member_id TEXT PRIMARY KEY REFERENCES sessions(id),group_id TEXT NOT NULL REFERENCES sessions(id)) STRICT;
CREATE INDEX IF NOT EXISTS session_groups_root ON session_groups(group_id,member_id);
CREATE TRIGGER IF NOT EXISTS session_groups_insert AFTER INSERT ON session_groups BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS session_groups_update AFTER UPDATE ON session_groups BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS session_groups_delete AFTER DELETE ON session_groups BEGIN UPDATE analytics_global_revision SET revision=revision+1 WHERE id=1; END;
CREATE VIEW IF NOT EXISTS logical_sessions AS
 SELECT s.id,s.account_id,s.stream_id,s.kind,s.started_at_ms,s.recording_started_at_ms,
 CASE WHEN EXISTS(SELECT 1 FROM session_groups g JOIN sessions x ON x.id=g.member_id WHERE g.group_id=s.id AND x.ended_at_ms IS NULL) THEN NULL
 ELSE coalesce((SELECT max(x.ended_at_ms) FROM session_groups g JOIN sessions x ON x.id=g.member_id WHERE g.group_id=s.id),s.ended_at_ms) END AS ended_at_ms,s.end_quality
 FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=s.id AND g.group_id<>s.id);
CREATE VIEW IF NOT EXISTS logical_event_sessions AS
 SELECT p.session_id,p.event_id FROM event_sessions p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.event_id FROM session_groups g JOIN event_sessions p ON p.session_id=g.member_id;
CREATE VIEW IF NOT EXISTS logical_presence_polls AS
 SELECT p.session_id,p.id,p.account_id,p.started_at_ms,p.completed_at_ms,p.status FROM presence_polls p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.id,p.account_id,p.started_at_ms,p.completed_at_ms,p.status FROM session_groups g JOIN presence_polls p ON p.session_id=g.member_id;
CREATE VIEW IF NOT EXISTS logical_platform_streams AS
 SELECT p.session_id,p.platform,p.account_id,p.external_id,p.started_at_ms,p.ended_at_ms,p.last_observed_at_ms,p.offline_checks,p.first_missing_at_ms,p.url,p.title FROM platform_streams p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.platform,p.account_id,p.external_id,p.started_at_ms,p.ended_at_ms,p.last_observed_at_ms,p.offline_checks,p.first_missing_at_ms,p.url,p.title FROM session_groups g JOIN platform_streams p ON p.session_id=g.member_id;
CREATE VIEW IF NOT EXISTS logical_stream_samples AS
 SELECT p.session_id,p.observed_at_ms,p.category_id,p.category_name,p.title,p.twitch_viewers,p.youtube_viewers FROM stream_samples p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.observed_at_ms,p.category_id,p.category_name,p.title,p.twitch_viewers,p.youtube_viewers FROM session_groups g JOIN stream_samples p ON p.session_id=g.member_id;
CREATE VIEW IF NOT EXISTS logical_follower_observations AS
 SELECT p.session_id,p.id,p.source,p.account_id,p.key,p.observed_at_ms,p.payload_json FROM follower_observations p WHERE NOT EXISTS(SELECT 1 FROM session_groups g WHERE g.member_id=p.session_id)
 UNION ALL SELECT g.group_id AS session_id,p.id,p.source,p.account_id,p.key,p.observed_at_ms,p.payload_json FROM session_groups g JOIN follower_observations p ON p.session_id=g.member_id;
CREATE VIEW IF NOT EXISTS logical_analytics_stream_revisions AS SELECT r.session_id,
 coalesce((SELECT sum(v.revision) FROM session_groups g JOIN analytics_stream_revisions v ON v.session_id=g.member_id WHERE g.group_id=r.session_id),r.revision) AS revision
 FROM analytics_stream_revisions r;
PRAGMA user_version=21;
`;

export const schemaMigrations=[schemaV1,schemaV2,schemaV3,schemaV4,schemaV5,schemaV6,schemaV7,schemaV8,schemaV9,schemaV10,schemaV11,schemaV12,schemaV13,schemaV14,schemaV15,schemaV16,schemaV17,schemaV18,schemaV19,schemaV20,schemaV21] as const;
export const CURRENT_SCHEMA_VERSION=schemaMigrations.length;
