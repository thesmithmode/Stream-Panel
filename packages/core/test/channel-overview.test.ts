import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
test('all-history overview has compact real totals and excludes breaks, deleted streams and bot participants',()=>{
 const s=new StreamStore(':memory:');try{
 const at=Date.now()-7200000,id=s.startSession('owner','one',at,'platform',at);
 s.ingest({source:'twitch',accountId:'owner',externalId:'msg',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+60000,receivedAtMs:at+60000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}});
 s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['viewer','silent','bot'],userNames:{bot:'jeetbot'}});s.endSession(id,at+3600000);
 const data=s.channelOverview();assert.equal(data.streams,1);assert.equal(data.durationMinutes,60);assert.equal(data.messages,1);assert.equal(data.attendees,2);assert.deepEqual(data.totals,{});assert.equal('timeline' in data,false);
 }finally{s.close();}
});
