import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchConnection,normalizeTwitch,messageText,isDefinitiveTwitchAuthFailure} from '../../dist/apps/daemon/src/twitch.js';
import {normalizeDonation,parseDonationTime,findDonation} from '../../dist/apps/daemon/src/donationalerts.js';
const envelope=(type,event={},metadata={})=>({metadata:{message_type:'notification',message_id:'envelope',message_timestamp:'2026-10-10T07:00:00Z',...metadata},payload:{subscription:{type},event}});
const config=()=>({value:{twitchClientId:'client123',twitch:{access:'old',refresh:'refresh',expiresAt:Date.now()+3600000,userId:'owner',scopes:[]}},save:async()=>{}});

test('Twitch notifications preserve anonymous and moderation provenance and reject malformed evidence',()=>{
 assert.equal(messageText('raw text'),'raw text');for(const value of [null,[],123,{text:123}])assert.equal(messageText(value),'');
 assert.equal(normalizeTwitch(envelope('channel.follow',{}, {message_type:'session_keepalive'}),'owner'),null);
 assert.equal(normalizeTwitch(envelope('unsupported.event'),'owner'),null);
 assert.throws(()=>normalizeTwitch(envelope('channel.follow',{}, {message_timestamp:'invalid'}),'owner'),/INVALID_PROVIDER_TIME/);
 assert.throws(()=>normalizeTwitch(envelope('channel.follow',{}, {message_id:''}),'owner'),/MISSING_PROVIDER_EVENT_ID/);
 assert.throws(()=>normalizeTwitch(envelope('channel.chat.message'),'owner'),/MISSING_PROVIDER_EVENT_ID/);
 const follow=normalizeTwitch(envelope('channel.follow',{user_id:'viewer',followed_at:'2026-10-09T12:00:00Z'}),'owner');
 assert.deepEqual(follow.actor,{externalId:'viewer',displayName:'viewer'});assert.equal(follow.payload.timeBasis,'event');assert.equal(follow.occurredAtMs,Date.parse('2026-10-09T12:00:00Z'));
 const anonymous=normalizeTwitch(envelope('channel.cheer',{user_id:'hidden',is_anonymous:true,bits:20}),'owner');assert.equal(anonymous.actor,null);assert.equal(anonymous.payload.bits,20);
 const moderation=normalizeTwitch(envelope('channel.chat.message_delete',{user_id:'mod',message_id:'deleted'}),'owner');assert.equal(moderation.actor,null);assert.equal(moderation.payload.targetMessageId,'deleted');
 const raid=normalizeTwitch(envelope('channel.raid',{from_broadcaster_user_id:'raider',from_broadcaster_user_name:'Raider'}),'owner');assert.deepEqual(raid.actor,{externalId:'raider',displayName:'Raider'});
 const shared=normalizeTwitch(envelope('channel.chat.message',{message_id:'chat-id',chatter_user_id:'viewer',message:'hi',source_broadcaster_user_id:'origin'}),'owner');assert.equal(shared.payload.originChannelId,'origin');assert.equal(shared.payload.text,'hi');assert.equal(shared.externalId,'chat-id');
});

test('DonationAlerts rejects invalid ids, money and dates; anonymous and unknown timestamps remain explicit',()=>{
 const row={id:'123',amount:'0.29',currency:'RUB',created_at:'2026-10-10 10:00:00',username:'',message:'anonymous'};
 const event=normalizeDonation(row,'owner','rest',180);assert.equal(event.actor,null);assert.equal(event.payload.amountMinor,'29');assert.equal(event.occurredAtMs,Date.parse('2026-10-10T07:00:00Z'));
 const unknown=normalizeDonation({...row,created_at:'not known'},'owner','centrifugo',null);assert.equal(unknown.occurredAtMs,null);assert.equal(unknown.timeQuality,'unknown');
 for(const id of [undefined,'abc','-1','1.5'])assert.throws(()=>normalizeDonation({...row,id},'owner','rest',180),/INVALID_DONATION_ID/);
 assert.throws(()=>normalizeDonation({...row,amount:undefined},'owner','rest',180));
 assert.throws(()=>parseDonationTime('invalid',0),/INVALID_DA_TIME/);assert.throws(()=>parseDonationTime('2026-02-30 12:00:00',0),/INVALID_DA_DATE/);
 for(const offset of [NaN,Infinity,841,-841,.5])assert.throws(()=>parseDonationTime(row.created_at,offset),/INVALID_UTC_OFFSET/);
 assert.equal(findDonation({result:{data:{publication:row}}}),row);assert.equal(findDonation({publication:row}),row);
 for(const value of [null,[],1,{data:{wrong:row}},{id:1,amount:1,currency:'RUB'}])assert.equal(findDonation(value),null);
 let deep=row;for(let n=0;n<8;n++)deep={data:deep};assert.equal(findDonation(deep),null);
});

test('Twitch refresh keeps credentials for network/non-JSON errors and clears only definitive failures',async()=>{
 for(const [status,body] of [[403,{error:'invalid_grant'}],[403,{error:'unauthorized'}],[403,{error:'invalid_token'}],[403,{message:'Invalid refresh token'}],[400,{}],[401,{}]])assert.equal(isDefinitiveTwitchAuthFailure(status,body),true);
 assert.equal(isDefinitiveTwitchAuthFailure(503,{message:'Temporary problem'}),false);
 for(const failure of [new Error('network'), 'untyped network']){
  const cfig=config(),c=new TwitchConnection(cfig,{call:async()=>{}},async()=>{throw failure});
  await assert.rejects(c.refresh(),failure instanceof Error?/network/:/TWITCH_REFRESH_TRANSIENT/);assert.equal(cfig.value.twitch.access,'old');
 }
 for(const status of [200,503,401]){
  const cfig=config(),c=new TwitchConnection(cfig,{call:async()=>{}},async()=>new Response('<html>bad gateway</html>',{status}));
  await assert.rejects(c.refresh(),status===200?/Unexpected token/:status===503?/TWITCH_REFRESH_HTTP_503/:/TWITCH_REAUTH_REQUIRED/);
  if(status===401){assert.equal(cfig.value.twitch,undefined);assert.equal(c.status.state,'error');}else assert.equal(cfig.value.twitch.refresh,'refresh');
 }
 const cfig=config();let requests=0;
 const c=new TwitchConnection(cfig,{call:async()=>{}},async()=>{requests++;return new Response(JSON.stringify({access_token:'rotated',expires_in:3600}),{status:200});});
 await Promise.all([c.refresh(),c.refresh()]);assert.equal(requests,1);assert.equal(cfig.value.twitch.refresh,'refresh');assert.equal(cfig.value.twitch.access,'rotated');
});

test('Twitch missing rate-limit reset blocks retry for one minute without an extra request',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,10)});
 const cfig=config();let requests=0;
 const c=new TwitchConnection(cfig,{call:async()=>{}},async()=>{requests++;return requests===1?new Response('{}',{status:429}):new Response('{"data":[]}',{status:200});});
 await assert.rejects(c.api('streams'),/TWITCH_RATE_LIMIT_UNTIL/);await assert.rejects(c.api('streams'),/TWITCH_RATE_LIMIT_UNTIL/);assert.equal(requests,1);
 t.mock.timers.tick(60000);assert.deepEqual(await c.api('streams'),{data:[]});assert.equal(requests,2);
});
