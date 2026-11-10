import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('viewer correction covers historical and future samples once, preserving YouTube, raw facts, zero and unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-viewer-adjustment-')),path=join(dir,'db');let s=new StreamStore(path,'ruslan');
 try{
  const at=Date.now()-3600000,id=s.startSession('owner','history',at,'platform',at);
  const db=(s as any).db;
  // Restore the preceding read projection and schema to exercise a real upgrade.
  db.exec(`DROP VIEW logical_stream_samples; CREATE VIEW logical_stream_samples AS SELECT * FROM stream_samples; PRAGMA user_version=${32};`);
  s.streamSample(id,at,'','','',1);s.streamSample(id,at+60000,'','','',0);s.streamSample(id,at+120000,'','','',null);s.youtubeViewers(at+120000,1);
  s.endSession(id,at+180000);s.channelOverview();s.close();s=new StreamStore(path,'ruslan');
  assert.equal(s.sessions()[0]!.viewerKnownPeak,0);assert.equal(s.channelOverview().records.peakOnline?.value,0);
  const reads=(s as any).reads,rows=reads.prepare('SELECT twitch_viewers,youtube_viewers FROM stream_samples ORDER BY observed_at_ms').all();
  assert.deepEqual(rows,[{twitch_viewers:0,youtube_viewers:null},{twitch_viewers:0,youtube_viewers:null},{twitch_viewers:null,youtube_viewers:1}]);
  assert.equal((s as any).db.prepare('SELECT twitch_viewers FROM stream_samples ORDER BY observed_at_ms LIMIT 1').get().twitch_viewers,1);
  const next=s.startSession('owner','future',at+240000,'platform',at+240000);s.streamSample(next,at+240000,'','','',5);s.endSession(next,at+300000);
  assert.equal(s.sessions(next)[0]!.viewerKnownPeak,4);s.close();s=new StreamStore(path,'ruslan');assert.equal(s.sessions(next)[0]!.viewerKnownPeak,4);
  const root=s.mergeSessions([id,next]);assert.equal(s.sessions(root)[0]!.viewerKnownPeak,4);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
