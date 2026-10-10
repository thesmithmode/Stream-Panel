import test from "node:test";
import assert from "node:assert/strict";
import { StreamStore } from "../src/store.js";
test("standalone YouTube viewer samples are scoped to their logical stream without a Twitch sample", () => {
 const store = new StreamStore(":memory:"); const at = Date.UTC(2026,9,1);
 try {
  const id = store.observePlatformStream("youtube","channel","video",at,at,"https://www.youtube.com/watch?v=video","Live")!;
  store.youtubeViewers(at,7,id);
  const report:any = store.analytics({fromMs:at,toMs:at+60000,youtubeAccount:"channel"});
  assert.equal(report.timeline[0].youtubeViewers,7);
  assert.equal(report.timeline[0].twitchViewers,null);
  assert.throws(()=>store.youtubeViewers(at,8,"missing"),/INVALID_YOUTUBE_SESSION/);
 } finally { store.close(); }
});

test("YouTube samples do not overwrite Twitch categories or attribute unknown-start broadcasts", () => {
 const store = new StreamStore(":memory:"); const at = Date.UTC(2026,9,1);
 try {
  const id = store.observePlatformStream("twitch","owner","t",at,at,"https://www.twitch.tv/owner","Live")!;
  store.observePlatformStream("youtube","channel","video",at,at,"https://www.youtube.com/watch?v=video","Live");
  store.streamSample(id,at,"dota","Dota 2","Live",10);
  store.youtubeViewers(at+60000,7,id);
  store.youtubeViewers(at+120000,99,null);
  const report:any = store.analytics({fromMs:at,toMs:at+180000,youtubeAccount:"channel"});
  assert.deepEqual(report.categories.map((row:any)=>row.name),["Dota 2"]);
  assert.equal(report.timeline.find((row:any)=>row.at===at+60000).youtubeViewers,7);
  assert.equal(report.timeline.some((row:any)=>row.youtubeViewers===99),false);
  store.youtubeViewers(at+120000,null,id);
  assert.equal((store.analytics({fromMs:at,toMs:at+180000}) as any).timeline.find((row:any)=>row.at===at+120000).youtubeViewers,null);
 } finally {store.close();}
});
