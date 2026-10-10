import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTwitch} from '../src/twitch.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {extraTwitchEvents} from '../src/twitch-events.js';
test('channel point events preserve reward, cost, input, status and complete provider fields across deduplication',()=>{
 const raw={metadata:{message_type:'notification',message_id:'envelope',message_timestamp:'2026-10-10T10:00:00Z'},payload:{subscription:{type:'channel.channel_points_custom_reward_redemption.add',version:'1'},event:{id:'reward-use',user_id:'viewer',user_name:'Viewer',user_input:'Play a song',status:'unfulfilled',reward:{id:'reward',title:'Song',cost:500},broadcaster_user_id:'owner'}}};
 const event=normalizeTwitch(raw,'owner')!;assert.equal(event.actor?.externalId,'viewer');assert.equal(event.payload.text,'Play a song');assert.deepEqual(event.payload.raw,raw);
 const s=new StreamStore(':memory:');try{assert.equal(s.ingest(event).inserted,true);assert.equal(s.ingest(event).inserted,false);assert.deepEqual((s.events()[0]!.payload as any).raw,raw);}finally{s.close();}
});
test('every supported supplementary event retains its full notification instead of being silently discarded',()=>{
 for(const [type,version] of extraTwitchEvents){
  const raw={metadata:{message_type:'notification',message_id:type,message_timestamp:'2026-10-10T10:00:00Z'},payload:{subscription:{type,version},event:{broadcaster_user_id:'owner',future_field:{nested:'retained'}}}};
  assert.deepEqual(normalizeTwitch(raw,'owner')!.payload.raw,raw);
 }
});
