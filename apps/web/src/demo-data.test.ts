import test from "node:test";
import assert from "node:assert/strict";
import { getDataMode, setDataMode, demoApi } from "./demo-data.ts";

test("data mode toggles between real and demo", () => {
  setDataMode("real");
  assert.equal(getDataMode(), "real");
  setDataMode("demo");
  assert.equal(getDataMode(), "demo");
  setDataMode("real");
});

test("demoApi serves persons, events, status without touching secrets", async () => {
  setDataMode("demo");
  const persons = (await demoApi("persons")) as unknown[];
  assert.ok(Array.isArray(persons));
  assert.ok(persons.length >= 1);
  const events = (await demoApi("events")) as unknown[];
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 1);
  const status = (await demoApi("status")) as {
    twitch: { state: string };
    donationalerts: { state: string };
  };
  assert.equal(status.twitch.state, "connected");
  assert.equal(status.donationalerts.state, "connected");
  const insights = (await demoApi("insights")) as unknown[];
  assert.ok(Array.isArray(insights));
  const tops = (await demoApi("persons/tops?by=messages")) as unknown[];
  assert.ok(Array.isArray(tops));
  const summary = await demoApi("summary");
  assert.ok(summary);
  setDataMode("real");
});

test('demo uses one core classification in summary, audience, categories and chart segments',async()=>{
 for(const query of ['', '&minSessions=1','&minSessions=1&regularThresholdPercent=100']){
  const data=await demoApi(`analytics?from=${Date.now()-7200000}&to=${Date.now()}${query}`) as any;
  assert.equal(data.summary.core,data.summary.regulars);
  assert.ok(data.audience.every((person:any)=>person.core===person.regular));
  assert.equal(data.categories[0].core,data.summary.core);
  assert.ok(data.timeline.every((point:any)=>point.regularObserved<=data.summary.core));
 }
});

test('demo analytics respects source and strict audience thresholds',async()=>{
 const range=`from=${Date.now()-7200000}&to=${Date.now()}`;
 const empty=await demoApi(`analytics?${range}&source=youtube`) as any;
 assert.deepEqual(empty.audience,[]);
 assert.equal(empty.summary.regularShare,null);
 assert.equal(empty.summary.core,0);
 assert.ok(empty.timeline.every((point:any)=>point.messages===0&&point.regularMessages===0&&point.observed===0));
 const threshold=await demoApi(`analytics?${range}&source=twitch&minSessions=1&regularThresholdPercent=100`) as any;
 assert.equal(threshold.audience.length,3);
 assert.ok(threshold.audience.every((person:any)=>person.core===false&&person.regular===false));
 assert.equal(threshold.summary.regularShare,0);
 assert.equal(threshold.categories[0].core,0);
 const qualified=await demoApi(`analytics?${range}&source=all&minSessions=1&regularThresholdPercent=49&minMinutes=999&minMessages=20`) as any;
 assert.equal(qualified.summary.core,1,'message threshold qualifies only the first eligible audience member');
 assert.equal(qualified.summary.regulars,1);
 assert.ok(qualified.timeline.some((point:any)=>point.regularObserved>0&&point.regularMessages>0));
});

test('demo blocks mutations and handles empty lookups without changing real data',async()=>{
 for(const path of ['persons','persons/demo/metadata','persons/demo/notes','persons/demo/notes/n/update','persons/demo/notes/n/delete','donations','donations/d/update','twitch/connect','donationalerts/rescan','merges/m/undo','splits/s/undo'])
  await assert.rejects(demoApi(path,{}));
 assert.deepEqual(await demoApi('persons/demo/metadata'),{revision:0,tags:[],manualCore:null});
 assert.deepEqual(await demoApi('persons/demo/notes'),[]);
 assert.deepEqual(await demoApi('merges'),[]);assert.deepEqual(await demoApi('splits'),[]);
 assert.deepEqual(await demoApi('donations'),{items:[],total:0,offset:0,limit:10});
 const people=await demoApi('/persons') as any[];
 assert.deepEqual(await demoApi('persons?search=unmatchable-demo-name'),[]);
 assert.ok((await demoApi(`persons?search=${encodeURIComponent(people[0].display_name)}`) as any[]).length);
 assert.ok(await demoApi(`persons/${people[0].id}`));
 assert.ok(await demoApi(`persons/${people[0].id}/stats`));
 await assert.rejects(demoApi('persons/missing'),/PERSON_NOT_FOUND/);
 await assert.rejects(demoApi('persons/missing/stats'),/PERSON_NOT_FOUND/);
 assert.ok((await demoApi(`persons/${people[0].id}/candidates`) as string[]).every(id=>id!==people[0].id));
 const events=await demoApi('events') as any[];
 const at=events[0].occurred_at_ms;
 const filtered=await demoApi(`events?person=${events[0].person_id}&from=${at}&to=${at+1}`) as any[];
 assert.ok(filtered.length);assert.ok(filtered.every(e=>e.person_id===events[0].person_id&&e.occurred_at_ms===at));
 assert.deepEqual(await demoApi('events?to=1'),[]);
 const messages=await demoApi('persons/tops') as any[],minutes=await demoApi('persons/tops?by=observed_minutes') as any[],donors=await demoApi('persons/tops?by=donations') as any[];
 for(const [rows,key] of [[messages,'messageCount'],[minutes,'observedMinutes'],[donors,'donationCount']] as const)assert.ok(rows.every((row:any,i:number)=>!i||rows[i-1][key]>=row[key]));
 const grid=await demoApi(`presence?from=${at}&to=${at+600000}`) as any[];assert.equal(grid.length,10);
 assert.ok(grid.every(cell=>['observed','not_observed','unknown'].includes(cell.state)));
 assert.equal((await demoApi('backup',{}) as any).filename,'demo-backup-not-written.sqlite');
 await assert.rejects(demoApi('unknown'),/DEMO_UNHANDLED/);
 await assert.rejects(demoApi('persons/missing/rename',{name:'Name'}),/INVALID_NAME/);
 await assert.rejects(demoApi(`persons/${people[0].id}/rename`,{name:''}),/INVALID_NAME/);
 const original=people[0].display_name;
 try{assert.deepEqual(await demoApi(`persons/${people[0].id}/rename`,{name:'Demo edited'}),{ok:true});assert.equal((await demoApi(`persons/${people[0].id}`) as any).display_name,'Demo edited');}
 finally{await demoApi(`persons/${people[0].id}/rename`,{name:original});}
 const sessions=await demoApi('sessions') as any[];
 await assert.rejects(demoApi('sessions/start',{}),/SESSION_ALREADY_OPEN/);
 await assert.rejects(demoApi('sessions/missing/stop',{}),/SESSION_NOT_FOUND/);
 await assert.rejects(demoApi(`sessions/${sessions[0].id}/stop`,{}),/PLATFORM_SESSION_MANAGED_AUTOMATICALLY/);
});
