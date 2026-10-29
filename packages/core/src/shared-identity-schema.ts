/** First profile schema that carries the shared identity journal hooks. */
export const SHARED_IDENTITY_VERSION=29;
/** Physical-file tables shared by every profile. Created outside profile migrations, so
 * profile views never rename them (like sp_youtube_quota). One row per linked account key;
 * an account without a row is linked to nothing. */
export const sharedIdentityTables=`CREATE TABLE IF NOT EXISTS sp_identity_links(link_key TEXT PRIMARY KEY,cluster TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sp_identity_links_cluster ON sp_identity_links(cluster,link_key);
CREATE TABLE IF NOT EXISTS sp_identity_sync_profiles(profile TEXT PRIMARY KEY,joined_at_ms INTEGER NOT NULL) STRICT;`;
// Global account keys: Twitch user id, YouTube channel id, normalized DonationAlerts nickname
// (the same match_key the donor binding and auto-link code use). Manual/correction ledger
// identities and the anonymous donor are profile bookkeeping, never shared.
/** DonationAlerts rows that are a real nickname (not anonymous, not a manual/correction ledger row). */
export const sharedDonorFilter="match_key NOT IN ('','аноним','anonymous','anon') AND external_id<>'anonymous:donor' AND account_id NOT LIKE 'manual:%' AND account_id NOT LIKE 'correction:%'";
const changed=(table:'identities'|'youtube_identities')=>['person_id','external_id','account_id',...(table==='identities'?['source','match_key']:[])].map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR ');
export const sharedIdentitySchema=`
CREATE TABLE IF NOT EXISTS identity_sync_queue(person_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS identities_external ON identities(external_id);
CREATE INDEX IF NOT EXISTS youtube_identities_external ON youtube_identities(external_id);
CREATE VIEW IF NOT EXISTS identity_link_keys AS
 SELECT id,person_id,'twitch:'||external_id AS link_key FROM identities WHERE source='twitch'
 UNION ALL SELECT id,person_id,'da:'||match_key FROM identities WHERE source='donationalerts' AND ${sharedDonorFilter}
 UNION ALL SELECT id,person_id,'youtube:'||external_id FROM youtube_identities;
${(['identities','youtube_identities'] as const).map(table=>`CREATE TRIGGER IF NOT EXISTS identity_sync_${table}_insert AFTER INSERT ON ${table} BEGIN INSERT OR IGNORE INTO identity_sync_queue VALUES(NEW.person_id); END;
CREATE TRIGGER IF NOT EXISTS identity_sync_${table}_update AFTER UPDATE ON ${table} WHEN ${changed(table)} BEGIN INSERT OR IGNORE INTO identity_sync_queue VALUES(OLD.person_id),(NEW.person_id); END;
CREATE TRIGGER IF NOT EXISTS identity_sync_${table}_delete AFTER DELETE ON ${table} BEGIN INSERT OR IGNORE INTO identity_sync_queue VALUES(OLD.person_id); END;`).join('\n')}
PRAGMA user_version=${SHARED_IDENTITY_VERSION};
`;
