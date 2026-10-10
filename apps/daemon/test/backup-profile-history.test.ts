import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {StreamStore} from '../../../packages/core/src/store.js';
import {AccountStore} from '../src/auth.js';
import {BackupService,restoreBackup} from '../src/backup.js';

test('encrypted restore retains isolated person metadata, raw events and unfinished platform lifecycle',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-backup-profile-history-'));
 const key=randomBytes(32),path=join(dir,'data.sqlite'),auth=new AccountStore(path);
 const stores=['ruslan','gulnaz'].map(profile=>new StreamStore(path,profile));
 const now=Date.now(), started=now-60000;
 await writeFile(join(dir,'key'),key.toString('hex'));
 const backup=new BackupService(dir,{keyFile:join(dir,'key')});
 const restored:StreamStore[]=[];
 try {
  const expected=stores.map((store,index)=>{
   const session=store.observePlatformStream('youtube','same-youtube-channel','same-video',started,started,'https://youtube.com/watch?v=same-video',`Profile ${index}`)!;
   assert.equal(store.observePlatformStream('twitch','same-twitch-account','same-stream',started,started,'https://twitch.tv/streamer','Twitch stream'),session);
   const event=store.ingest({source:'twitch',accountId:'same-twitch-account',externalId:'same-message',type:'chat.message',actor:{externalId:'same-viewer',displayName:'Viewer'},occurredAtMs:started+1000,receivedAtMs:started+1000,sourceTime:new Date(started+1000).toISOString(),timeQuality:'provider',transport:'eventsub',payload:{text:`Profile ${index} message`}});
   const person=event.personId!;
   const created=store.createPersonNote(person,`Profile ${index} note`,started+2000) as {id:string;revision:number};
   const note=store.updatePersonNote(person,created.id,`Profile ${index} edited`,created.revision,started+3000);
   const metadata=store.setPersonMetadata(person,[`profile-${index}`],index===0,store.personRevision(person));
   store.recordPoll(session,'same-twitch-account',{startedAtMs:started,completedAtMs:started+60000,status:'complete',userIds:['same-viewer']});
   store.platformMissing('youtube','same-youtube-channel',[],now);
   return {session,person,note,metadata,events:store.events(session),stats:store.personStats(person),platforms:store.platformStreams(session)};
  });
  const {filename}=await backup.run();
  const destination=join(dir,'restored');
  await restoreBackup(await readFile(join(dir,'backups',filename)),key,destination);
  for(let index=0;index<stores.length;index++){
   const store=new StreamStore(join(destination,'data.sqlite'),index===0?'ruslan':'gulnaz');restored.push(store);
   const original=expected[index]!;
   assert.deepEqual(store.personNotes(original.person),[original.note]);
   assert.deepEqual(store.personMetadata(original.person),original.metadata);
   assert.deepEqual(store.events(original.session),original.events);
   assert.deepEqual(store.personStats(original.person),original.stats);
   assert.deepEqual(store.platformStreams(original.session),original.platforms);
   assert.equal(store.activeLogicalStream()!.id,original.session);
   const other=expected[1-index]!;
   assert.throws(()=>store.personNotes(other.person),/PERSON_NOT_FOUND/);
   assert.deepEqual(store.platformStreams(other.session),[]);
   store.platformMissing('youtube','same-youtube-channel',[],now+60000);
   assert.equal(store.platformStreams(original.session).find(row=>row.platform==='youtube')!.ended_at_ms,now);
   assert.equal(store.activeLogicalStream()!.id,original.session,'Twitch keeps the shared stream open after restored YouTube missing confirmation');
   store.platformMissing('twitch','same-twitch-account',[],now+60000);
   store.platformMissing('twitch','same-twitch-account',[],now+120000);
   assert.equal(store.activeLogicalStream(),null);
   assert.deepEqual(store.personNotes(original.person),[original.note]);
   assert.deepEqual(store.events(original.session),original.events);
   assert.equal(stores[index]!.activeLogicalStream()!.id,original.session,'restore operations do not alter the source database');
  }
 }finally{await backup.stop();for(const store of [...restored,...stores])store.close();auth.close();await rm(dir,{recursive:true,force:true});}
});
