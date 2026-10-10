import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {schemaV1} from '../../../packages/core/src/schema.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {migrateLegacy,prepareLocal} from '../src/legacy-import.js';

test('legacy import keeps every table, WAL events and credentials, leaves source intact, and refuses overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-import-')),source=join(root,'old'),dest=join(root,'new');await mkdir(source);
 const store=new StreamStore(join(source,'data.sqlite'));store.startSession('channel','stream',1000,'platform',1000);store.close();
 const old=new Database(join(source,'data.sqlite'));old.pragma('journal_mode=WAL');old.exec("INSERT INTO persons VALUES ('p','Viewer',0)");
 const session=(old.prepare('SELECT id FROM sessions').get() as any).id;
 old.prepare('INSERT INTO identities VALUES (?,?,?,?,?,?,?,?)').run('i','twitch','channel','external','Viewer','viewer','p','viewer');
 old.exec(`INSERT INTO events VALUES ('e','twitch','channel','event','chat','i',1001,1001,NULL,'provider','rest','{}');
 INSERT INTO person_merges VALUES ('merge','p','p','{}','{}',1002,NULL);
 INSERT INTO identity_aliases VALUES ('i','PreviousName','previousname',1000,1001);
 INSERT INTO collection_gaps VALUES ('gap','twitch','network',1000,1001);
 INSERT INTO membership_operations VALUES ('op','merge','{}','{}',1002);
 INSERT INTO youtube_snapshots VALUES ('channel','broadcast','{}',1001);
 INSERT INTO youtube_messages VALUES ('yt','channel','chat','author',1001,'{}');`);
 old.prepare('INSERT INTO event_sessions VALUES (?,?)').run('e',session);
 old.prepare('INSERT INTO presence_polls VALUES (?,?,?,?,?,?)').run('poll',session,'channel',1000,1001,'complete');
 old.exec("INSERT INTO presence_members VALUES ('poll','i')");
 old.prepare('INSERT INTO stream_samples VALUES (?,?,?,?,?,?,?)').run(session,1001,'123','Game','Title',10,5);
 const secrets={version:1,twitchClientId:'same-client',twitch:{access:'fixture-access',refresh:'fixture-refresh'},daClientId:'same-da',daClientSecret:'fixture-secret'};
 await writeFile(join(source,'secrets.json'),JSON.stringify(secrets));
 try{
 const result=await migrateLegacy(source,dest);assert.equal(result.tables.persons,1);
 for(const [table,n] of Object.entries(result.tables))assert.equal(n,(old.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n);
 const migrated=new Database(join(dest,'data.sqlite'));
 try{
 for(const table of Object.keys(result.tables))assert.deepEqual(migrated.prepare(`SELECT * FROM p_ruslan_${table}`).all(),old.prepare(`SELECT * FROM ${table}`).all());
 assert.equal((migrated.prepare('SELECT display_name FROM p_ruslan_persons').get() as any).display_name,'Viewer');assert.equal(migrated.prepare('SELECT * FROM p_ruslan_sessions').all().length,1);assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name='persons'").all().length,0);assert.equal(migrated.pragma('integrity_check',{simple:true}),'ok');assert.equal((migrated.pragma('foreign_key_check') as unknown[]).length,0);}finally{migrated.close();}
 assert.deepEqual(JSON.parse(await readFile(join(dest,'profiles/ruslan/secrets.json'),'utf8')),secrets);
 assert.equal(old.prepare('SELECT * FROM persons').all().length,1);assert.equal((await stat(join(dest,'profiles/ruslan/secrets.json'))).mode&0o777,0o600);
 assert.ok((await stat(join(dest,'legacy-backup/data.sqlite'))).size>0);
 await assert.rejects(migrateLegacy(source,dest),/DESTINATION_EXISTS/);
 await assert.rejects(migrateLegacy(source,source),/DESTINATION_EXISTS/);
 }finally{old.close();await rm(root,{recursive:true,force:true});}
});

test('migration rejects active or corrupt locks, bad configs and broken databases without publishing partial data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-import-errors-')),source=join(root,'old');await mkdir(source);const store=new StreamStore(join(source,'data.sqlite'));store.close();
 try{
 for(const lock of [String(process.pid),'broken']){await writeFile(join(source,'daemon.lock'),lock);await assert.rejects(migrateLegacy(source,join(root,'new')),/LEGACY_RUNNING|INVALID_LEGACY_LOCK/);}
 await writeFile(join(source,'daemon.lock'),'2147483647\n47831');await writeFile(join(source,'secrets.json'),'broken');await assert.rejects(migrateLegacy(source,join(root,'new')),/LEGACY_CONFIG/);
 await writeFile(join(source,'secrets.json'),'{"version":2}');await assert.rejects(migrateLegacy(source,join(root,'new')),/LEGACY_CONFIG/);
 await rm(join(source,'secrets.json'));await writeFile(join(source,'data.sqlite'),'not sqlite');await assert.rejects(migrateLegacy(source,join(root,'new')));
 await assert.rejects(stat(join(root,'new')),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('local preparation requires a password, provisions once, preserves it and validates the backup key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-local-')),dir=join(root,'local'),old=join(root,'absent');
 try{
 await assert.rejects(prepareLocal(dir,old),/LOCAL_PASSWORD_REQUIRED/);
 await assert.rejects(prepareLocal(dir,old,'short'),/INVALID_PASSWORD/);
 await prepareLocal(dir,old,'local-password-for-tests');
 assert.match(await readFile(join(dir,'backup-key'),'utf8'),/^[a-f0-9]{64}$/);
 assert.equal((await stat(join(dir,'backup-key'))).mode&0o777,0o600);
 const key=await readFile(join(dir,'backup-key'));await prepareLocal(dir,old);assert.deepEqual(await readFile(join(dir,'backup-key')),key);
 await writeFile(join(dir,'backup-key'),'bad');await assert.rejects(prepareLocal(dir,old),/INVALID_BACKUP_KEY/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('old schema is upgraded only in the copy and missing config is supported',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-old-schema-')),source=join(root,'old'),dest=join(root,'new');await mkdir(source);
 const old=new Database(join(source,'data.sqlite'));old.exec(schemaV1);old.exec("INSERT INTO persons VALUES ('p','Old Viewer',0)");old.close();
 try{
 await prepareLocal(dest,source,'local-password-for-tests');
 const imported=new Database(join(dest,'data.sqlite'));assert.equal(imported.prepare('SELECT * FROM p_ruslan_persons').all().length,1);imported.close();
 const original=new Database(join(source,'data.sqlite'));assert.equal(original.pragma('user_version',{simple:true}),1);original.close();
 await assert.rejects(readFile(join(dest,'profiles/ruslan/secrets.json')),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('current schema import preserves notes, deleted donation audit, stream categories and source bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sp-import-current-')),source=join(root,'old'),dest=join(root,'new');
 await mkdir(source);
 const path=join(source,'data.sqlite'),store=new StreamStore(path);
 try {
  const person=store.ingest({source:'twitch',accountId:'channel',externalId:'chat-message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;
  store.createPersonNote(person,'Keep this note',1001);
  const stream=store.observePlatformStream('twitch','channel','live-stream',900,1000,'https://www.twitch.tv/channel','Live')!;
  store.streamSample(stream,1002,'game-42','Game 42','Live title',17);
  const donation=store.createDonation({personId:person,amount:'12.34',currency:'USD',occurredAtMs:1003,message:'Original donation',sourceName:'Cash'},1004);
  const updated=store.updateDonation(String(donation.id),{personId:person,amount:'15.00',currency:'USD',occurredAtMs:1005,message:'Corrected donation',sourceName:'Cash'},Number(donation.revision),1006);
  store.deleteDonation(String(donation.id),Number(updated.revision),1007);
 } finally {store.close();}

 try {
  const sourceHash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const before=sourceHash();
  const result=await migrateLegacy(source,dest);
  const after=sourceHash();
  assert.equal(after,before);
  for(const table of ['person_notes','donation_corrections','donation_audit','stream_samples','platform_streams','youtube_identities','session_tombstones','split_guards','anonymous_donors'])
   assert.ok(table in result.tables,`missing inventory table ${table}`);
  assert.equal(result.tables.person_notes,1);
  assert.equal(result.tables.donation_corrections,1);
  assert.equal(result.tables.donation_audit,3);
  assert.equal(result.tables.stream_samples,1);

  const imported=new Database(join(dest,'data.sqlite'));
  try {
   assert.equal((imported.prepare('SELECT body FROM p_ruslan_person_notes').get() as any).body,'Keep this note');
   assert.equal((imported.prepare('SELECT deleted FROM p_ruslan_donation_corrections').get() as any).deleted,1);
   assert.deepEqual((imported.prepare('SELECT kind FROM p_ruslan_donation_audit ORDER BY revision').all() as any[]).map(row=>row.kind),['create','update','delete']);
   assert.equal((imported.prepare('SELECT category_id FROM p_ruslan_stream_samples').get() as any).category_id,'game-42');
   assert.equal(imported.pragma('integrity_check',{simple:true}),'ok');
   assert.equal((imported.pragma('foreign_key_check') as unknown[]).length,0);
  } finally {imported.close();}
  await assert.rejects(migrateLegacy(source,dest),/DESTINATION_EXISTS/);
 } finally {await rm(root,{recursive:true,force:true});}
});
