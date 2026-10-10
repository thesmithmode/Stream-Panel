import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';

test('stream history exposes only confirmed source URLs and latest nonempty title',()=>{
 const store=new StreamStore(':memory:');
 try {
  const id=store.observePlatformStream('youtube','yt-channel','yt-video',1000,1100,'https://youtube.com/watch?v=yt-video','Video title')!;
  let row=store.sessions().find(s=>s.id===id)!;
  assert.deepEqual(row.platforms,['youtube']);
  assert.deepEqual(row.confirmedUrls,[{platform:'youtube',url:'https://youtube.com/watch?v=yt-video'}]);
  assert.equal(row.primaryTitle,'Video title');
  store.observePlatformStream('twitch','twitch-account','twitch-stream',1050,1200,'https://www.twitch.tv/channel','Latest title');
  row=store.sessions().find(s=>s.id===id)!;
  assert.deepEqual(row.platforms,['twitch','youtube']);
  assert.equal(row.primaryTitle,'Latest title');
  assert.equal((row.confirmedUrls as unknown[]).length,2);
  store.observePlatformStream('youtube','yt-channel','yt-video',1000,1250,'https://youtube.com/watch?v=yt-video','');
  assert.equal(store.sessions().find(s=>s.id===id)!.primaryTitle,'Latest title');
  const legacy=store.startSession('legacy-account','arbitrary-not-a-url',2000,'platform',2100);
  assert.deepEqual(store.sessions().find(s=>s.id===legacy)!.confirmedUrls,[]);
  const manual=store.startSession('manual-account','manual-id',3000,'manual',3100);
  const manualRow=store.sessions().find(s=>s.id===manual)!;
  assert.deepEqual(manualRow.platforms,[]);
  assert.deepEqual(manualRow.confirmedUrls,[]);
  assert.equal(manualRow.primaryTitle,null);
 } finally {store.close();}
});
