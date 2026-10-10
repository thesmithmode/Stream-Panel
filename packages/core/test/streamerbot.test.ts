import test from 'node:test';
import assert from 'node:assert/strict';
import {mapStreamerBotTwitchChatMessage,StreamerBotStubAdapter} from '../src/streamerbot.js';

test('Streamer.bot mapper applies identity, display-name, message-text and timestamp fallbacks',()=>{
 const mapped=mapStreamerBotTwitchChatMessage({
  messageId:'message-1',user:{id:42,displayName:'',name:'',login:'login-name'},
  message:{},timeStamp:'not a date',
 },'channel',500);
 assert.ok(mapped);
 assert.equal(mapped.actor?.externalId,'42');
 assert.equal(mapped.actor?.displayName,'login-name');
 assert.equal(mapped.occurredAtMs,null);
 assert.equal(mapped.timeQuality,'unknown');
 assert.equal(mapped.payload.text,'');

 const numeric=mapStreamerBotTwitchChatMessage({messageId:'message-2',userId:99,displayName:'Top Name',message:'hello',timeStamp:1234},'channel',600);
 assert.ok(numeric);
 assert.equal(numeric.actor?.displayName,'Top Name');
 assert.equal(numeric.occurredAtMs,1234);
 assert.equal(numeric.sourceTime,new Date(1234).toISOString());
 assert.equal(numeric.timeQuality,'provider');
 assert.equal(numeric.payload.text,'hello');

 const objectText=mapStreamerBotTwitchChatMessage({messageId:'message-3',user:{id:'viewer',name:'Name'},message:{text:'object text'},timeStamp:'2026-10-01T12:00:00Z'},'channel',700);
 assert.ok(objectText);
 assert.equal(objectText.actor?.displayName,'Name');
 assert.equal(objectText.payload.text,'object text');
});

test('Streamer.bot fails closed for missing identifiers and adapter inject delivers only valid events',async()=>{
 assert.equal(mapStreamerBotTwitchChatMessage({messageId:'m',userId:'viewer'},'',1),null);
 assert.equal(mapStreamerBotTwitchChatMessage({userId:'viewer'},'channel',1),null);
 assert.equal(mapStreamerBotTwitchChatMessage({messageId:'m'},'channel',1),null);

 const adapter=new StreamerBotStubAdapter('channel'),received:any[]=[];
 adapter.subscribe(event=>{received.push(event);});
 await adapter.start();
 await adapter.start();
 await adapter.inject({messageId:'missing-user'},1000);
 assert.equal(received.length,0);
 await adapter.inject({messageId:'valid',user:{id:'viewer'},message:'delivered'},1001);
 assert.equal(received.length,1);
 assert.equal(received[0].externalId,'valid');
 assert.equal(received[0].receivedAtMs,1001);
 await adapter.stop();
});
