import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {ChannelRecords} from '../src/channel-records.js';
import {logicalReadDatabase} from '../src/session-groups.js';
import {openProfileDatabase} from '../src/profile-db.js';
test('records reuse unchanged stream facts across restarts and revisit only revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-records-')),path=join(dir,'db.sqlite');const store=new StreamStore(path,'ruslan');const db=logicalReadDatabase(openProfileDatabase(path,'ruslan'));
 try{
  const base=Date.now()-3600000;const a=store.startSession('a','a',base,'platform',base);store.endSession(a,base+60000);
  const b=store.startSession('b','b',base+120000,'platform',base);store.endSession(b,base+180000);
  let calls=0;
  const read=(id:string)=>{calls++;return {viewerKnownMean:id===a?5:3,messageCount:id===a?10:12};};
  const records=new ChannelRecords(db,read);
  assert.deepEqual(records.read('[]'),{online:{value:5,at:base},messages:{value:12,at:base+120000}});assert.equal(calls,2);
  records.read('[]');assert.equal(calls,2,'unchanged history does not load samples or messages');
  new ChannelRecords(db,read).read('[]');assert.equal(calls,2,'persisted projection survives a new reader');
  store.streamSample(b,base+120000,'','','',8);records.read('[]');assert.equal(calls,3,'only the modified stream is recomputed');
  records.read('["bot"]');assert.equal(calls,5,'bot filter changes invalidate both metrics');
  store.mergeSessions([a,b]);const merged=records.read('[]');assert.equal(calls,6);assert.equal(merged.messages?.value,10,'old group members cannot remain record holders');
  store.unmergeSessions(a);records.read('[]');assert.equal(calls,8);
 }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('overview returns accurate online and message records and keeps the earliest tie',()=>{
 const store=new StreamStore(':memory:');try{
  const at=Date.now()-3600000;
  for(let n=0;n<2;n++){const id=store.startSession('owner',String(n),at+n*120000,'platform',at);store.streamSample(id,at+n*120000,'','','',5);store.endSession(id,at+n*120000+60000);}
  assert.deepEqual(store.channelOverview().records,{online:{value:5,at},messages:{value:0,at}});
 }finally{store.close();}
});
