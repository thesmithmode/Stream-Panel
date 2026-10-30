import test from "node:test";
import assert from "node:assert/strict";
import { botExclusionSet, isExcludedBot, normalizeBotLogin } from "../src/bots.js";
import { StreamStore } from "../src/store.js";

test('each profile excludes its own broadcaster while counting the other broadcaster as a viewer',()=>{
 const viewers=[['ruslan-id','rlod'],['gulnaz-id','AmaliaMelina']] as const;
 const at=Date.UTC(2026,9,11,12);
 for(const [profile,owner,guest] of [['ruslan',viewers[0],viewers[1]],['gulnaz',viewers[1],viewers[0]]] as const){
  const store=new StreamStore(':memory:',profile);
  try{
   store.ensureOwnerIdentity(owner[0],owner[0],owner[1],at);
   const sid=store.startSession(owner[0],'stream',at,'platform',at);
   const persons=new Map<string,string>();
   for(const [uid,name] of [...viewers,['bot-id','Nightbot']] as const){
    const row=store.ingest({source:'twitch',accountId:owner[0],externalId:uid,type:'chat.message',actor:{externalId:uid,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
    persons.set(uid,row.personId!);
   }
   store.recordPoll(sid,owner[0],{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:[owner[0],guest[0],'bot-id']});
   store.endSession(sid,at+120000);
   assert.deepEqual(store.persons().filter(p=>!p.is_bot).map(p=>p.display_name),[guest[1]],profile);
   assert.equal(store.summary(sid).messages,1);
   assert.equal(store.summary(sid).chatters,1);
   assert.deepEqual(store.analytics({fromMs:at,toMs:at+120000,ownerId:owner[0]}).audience.map(p=>p.name),[guest[1]]);
   assert.equal(store.personStats(persons.get(owner[0])!,sid).messageCount,0);
   assert.equal(store.personStats(persons.get(guest[0])!,sid).messageCount,1);
   assert.deepEqual(store.personsTop('observed_minutes',sid).map(p=>p.display_name),[guest[1]]);
   assert.equal(store.eventCount(),3);
  }finally{store.close();}
 }
});

test("known bot aliases are excluded from metrics while raw events remain stored", () => {
  const exclusions = botExclusionSet(["CustomBot"]);

  assert.equal(normalizeBotLogin("  @ＦＲＡＮＫＩＥ＿ＳＨＯＷＭＡＮ  "), "frankie_showman");
  assert.equal(isExcludedBot("@FRANKIE_SHOWMAN", exclusions), true);
  assert.equal(isExcludedBot("CustomBot", exclusions), true);
  assert.equal(isExcludedBot("RegularViewer", exclusions), false);

  const store = new StreamStore(":memory:");
  const fromMs = Date.UTC(2026, 9, 1, 12);
  try {
    store.startSession("channel", "bot-exclusion", fromMs, "platform", fromMs);
    for (const [externalId, displayName] of [
      ["bot-message", "Frankie_Showman"],
      ["viewer-message", "RegularViewer"],
    ] as const) {
      store.ingest({
        source: "twitch",
        accountId: "channel",
        externalId,
        type: "chat.message",
        actor: { externalId: displayName, displayName },
        occurredAtMs: fromMs + 60_000,
        receivedAtMs: fromMs + 60_000,
        sourceTime: null,
        timeQuality: "provider",
        transport: "eventsub",
        payload: { text: "hello" },
      });
    }

    const summary = store.summary();
    const analytics = store.analytics({
      fromMs,
      toMs: fromMs + 10 * 60_000,
      minSessions: 1,
      minMinutes: 0,
      minMessages: 1,
    });

    assert.equal(store.eventCount(), 2);
    assert.equal(summary.events, 2);
    assert.equal(summary.messages, 1);
    assert.deepEqual(analytics.audience.map((entry) => entry.name), ["RegularViewer"]);
  } finally {
    store.close();
  }
});
