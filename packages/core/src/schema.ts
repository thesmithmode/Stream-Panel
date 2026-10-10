// Migration 1. All times are UTC epoch milliseconds; names are never unique identifiers.
export const CURRENT_SCHEMA_VERSION = 12;

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
CREATE TABLE provider_snapshots (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL,
 observed_at_ms INTEGER NOT NULL, session_id TEXT REFERENCES sessions(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX provider_snapshots_session_time ON provider_snapshots(session_id,observed_at_ms);
CREATE INDEX provider_snapshots_account_time ON provider_snapshots(source,account_id,key,observed_at_ms);
PRAGMA user_version = 12;
`;
