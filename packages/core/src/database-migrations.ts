import type Database from 'better-sqlite3';
import {matchKey} from './domain.js';
import {ProviderStorage} from './provider-storage.js';
import {CURRENT_SCHEMA_VERSION,schemaMigrations} from './schema.js';

/** The profile database adapter owns version storage; every migration is atomic. */
export function migrateDatabase(db:Database.Database):void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version=db.pragma('user_version',{simple:true});
  if(typeof version!=='number'||!Number.isInteger(version)||version<0||version>CURRENT_SCHEMA_VERSION)
    throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('secure_delete = ON');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864');
  for(const [index,sql] of schemaMigrations.entries()) {
    const target=index+1;
    // This shared quota table is independent of profile versions and must also
    // be present when opening an already migrated database.
    if(target===13)db.exec('CREATE TABLE IF NOT EXISTS sp_youtube_quota (day TEXT NOT NULL, profile TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(day,profile)) WITHOUT ROWID');
    if(version>=target)continue;
    db.transaction(()=>{
      if(target===16)new ProviderStorage(db).migrate();
      db.exec(sql);
      if(target===17)new ProviderStorage(db).migrateFollowers();
      if(target===3) {
        const rows=db.prepare('SELECT id, display_name FROM identities').all() as {id:string;display_name:string}[];
        const update=db.prepare('UPDATE identities SET match_key = ? WHERE id = ?');
        for(const row of rows)update.run(matchKey(row.display_name),row.id);
      }
    }).immediate();
  }
}
