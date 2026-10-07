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
