import type Database from 'better-sqlite3';
import {schemaV2} from '../src/schema.js';
/** Recreate the real pre-v20 layout before an older-version migration fixture. */
export function restoreLegacyPresence(db:Database.Database){
 db.transaction(()=>{
  db.exec(`CREATE TEMP TABLE fixture_presence_links AS SELECT * FROM presence_members;
   DROP VIEW presence_members;DROP TABLE presence_members_compact;
   DROP TRIGGER presence_poll_keys_insert;DROP TRIGGER presence_identity_keys_insert;
   DROP TRIGGER presence_poll_keys_delete;DROP TRIGGER presence_identity_keys_delete;
   DROP TABLE presence_poll_keys;DROP TABLE presence_identity_keys;`);
  db.exec(schemaV2.slice(schemaV2.indexOf('CREATE TABLE presence_members'),schemaV2.indexOf('CREATE TABLE identity_aliases')));
  db.exec('INSERT INTO presence_members SELECT * FROM fixture_presence_links;DROP TABLE fixture_presence_links');
 }).immediate();
}
