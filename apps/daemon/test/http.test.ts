import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.js";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sp-http-"));
  const a = await createApplication(dir, 47831, false);
  const host = { host: "127.0.0.1:47831" };
  const key = new URLSearchParams(a.bootstrap().split("#")[1]).get("key");
  const login = await a.app.inject({
    method: "POST",
    url: "/api/v1/bootstrap",
    headers: host,
    payload: { key },
  });
  const headers = {
    ...host,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": login.json().csrf,
  };
  return {
    a,
    headers,
    dir,
    close: async () => {
      await a.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("mutation API rejects extra properties and number/boolean coercion before side effects", async () => {
  const f = await fixture();
  try {
    for (const [url, payload] of [
      ["/api/v1/sessions/start", { unexpected: true }],
      [
        "/api/v1/persons/merge",
        {
          sourceId: "a",
          targetId: "b",
          sourceRevision: "1",
          targetRevision: 1,
        },
      ],
      [
        "/api/v1/twitch/connect",
        { clientId: "valid-client", extended: "true" },
      ],
      [
        "/api/v1/donationalerts/connect",
        { utcOffsetMinutes: "180", accessToken: "do-not-save" },
      ],
    ] as const) {
      const r = await f.a.app.inject({
        method: "POST",
        url,
        headers: f.headers,
        payload,
      });
      assert.equal(r.statusCode, 400, `${url}: ${r.body}`);
    }
    assert.equal((await f.a.db.call<any[]>("sessions")).length, 0);
    assert.equal(f.a.configuration.value.daAccessToken, "");
  } finally {
    await f.close();
  }
});
test("unavailable DB is a service failure rather than a successful empty result or client validation error", async () => {
  const f = await fixture();
  try {
    await f.a.db.stop();
    const r = await f.a.app.inject({
      method: "GET",
      url: "/api/v1/persons",
      headers: f.headers,
    });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, "DB_WORKER_STOPPED");
  } finally {
    await f.a.app.close().catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("HTTP contracts: missing entities, conflicts, bounded grids, callback rejection and SPA fallback", async () => {
  const f = await fixture();
  const get = (url: string) => f.a.app.inject({ url, headers: f.headers });
  const post = (url: string, payload: Record<string, unknown> = {}) =>
    f.a.app.inject({ method: "POST", url, headers: f.headers, payload });
  try {
    assert.equal((await get("/api/v1/not-found")).statusCode, 404);
    assert.equal((await get("/missing-spa-route")).statusCode, 200);
    assert.equal((await get("/api/v1/persons/missing")).statusCode, 404);
    assert.equal(
      (await get("/oauth/donationalerts/callback?state=wrong&code=untrusted"))
        .statusCode,
      400,
    );
    assert.equal((await post("/api/v1/sessions/missing/stop")).statusCode, 404);
    const session = (await post("/api/v1/sessions/start")).json().id;
    assert.equal((await post("/api/v1/sessions/start")).statusCode, 409);
    assert.equal(
      (await post(`/api/v1/sessions/${session}/stop`)).statusCode,
      200,
    );
    const id = await f.a.db.call<string>(
      "startSession",
      "owner",
      "stream",
      Date.now(),
      "platform",
      Date.now(),
    );
    assert.equal(
      (await post(`/api/v1/sessions/${id}/stop`)).json().error,
      "PLATFORM_SESSION_MANAGED_AUTOMATICALLY",
    );
    assert.equal((await get("/api/v1/events?from=bad&to=20")).statusCode, 400);
    assert.equal(
      (
        await get(
          "/api/v1/presence?session=missing&person=missing&from=0&to=2678460000",
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await post("/api/v1/donationalerts/connect", { utcOffsetMinutes: 841 }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await post("/api/v1/persons/split", {
          identityIds: ["id", "id"],
          revision: 0,
          name: "group",
        })
      ).statusCode,
      400,
    );
    assert.equal((await post("/api/v1/twitch/disconnect")).statusCode, 200);
    assert.equal(
      (await post("/api/v1/donationalerts/disconnect")).statusCode,
      200,
    );
    assert.equal((await post("/api/v1/donationalerts/rescan")).statusCode, 200);
    const backup = await post("/api/v1/backup");
    assert.equal(backup.statusCode, 200);
    assert.match(backup.json().filename, /\.sqlite$/);
    const status = (await get("/api/v1/status")).json();
    assert.equal(JSON.stringify(status).includes("accessToken"), false);
  } finally {
    await f.close();
  }
});
test("bootstrap expires, invalidates previous nonce and bounds local sessions; expired sessions are evicted", async (t) => {
  const f = await fixture();
  try {
    const bootstrap = () =>
      new URLSearchParams(f.a.bootstrap().split("#")[1]).get("key");
    const login = (key: string | null) =>
      f.a.app.inject({
        method: "POST",
        url: "/api/v1/bootstrap",
        headers: { host: "127.0.0.1:47831" },
        payload: { key },
      });
    let key = bootstrap();
    bootstrap();
    assert.equal((await login(key)).statusCode, 401);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    key = bootstrap();
    t.mock.timers.tick(600001);
    assert.equal((await login(key)).statusCode, 401);
    for (let i = 0; i < 20; i++)
      assert.equal((await login(bootstrap())).statusCode, 200);
    assert.equal((await login(bootstrap())).statusCode, 429);
    t.mock.timers.tick(86400001);
    assert.equal(
      (await f.a.app.inject({ url: "/api/v1/status", headers: f.headers }))
        .statusCode,
      401,
    );
    assert.equal((await login(bootstrap())).statusCode, 200);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
test("unexpected internal errors return 500, filesystem failures return 503 and body limit remains 413", async (t) => {
  const f = await fixture();
  try {
    let r;
    for (const message of [
      "internal details: private path and SQL",
      "UNEXPECTED_INTERNAL_FAILURE",
    ]) {
      const mock = t.mock.method(f.a.db, "call", async () => {
        throw new Error(message);
      });
      r = await f.a.app.inject({ url: "/api/v1/persons", headers: f.headers });
      assert.equal(r.statusCode, 500);
      assert.equal(
        r.json().error,
        message.includes(" ") ? "REQUEST_FAILED" : message,
      );
      mock.mock.restore();
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(f.dir, "backups"), "not a directory");
    r = await f.a.app.inject({
      method: "POST",
      url: "/api/v1/backup",
      headers: f.headers,
      payload: {},
    });
    assert.equal(r.statusCode, 503);
    assert.deepEqual(r.json(), { error: "STORAGE_UNAVAILABLE" });
    r = await f.a.app.inject({
      method: "POST",
      url: "/api/v1/persons/merge",
      headers: { ...f.headers, "content-type": "application/json" },
      payload: JSON.stringify({ large: "x".repeat(40000) }),
    });
    assert.equal(r.statusCode, 413);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
test("person stats, tops and insights endpoints return shaped aggregates", async () => {
  const f = await fixture();
  try {
    const get = (url: string) => f.a.app.inject({ url, headers: f.headers });
    const personId = await f.a.db.call<string>(
      "ensureOwnerIdentity",
      "owner",
      "owner",
      "Owner",
      Date.now(),
    );
    const session = await f.a.db.call<string>(
      "startSession",
      "owner",
      "http-analytics",
      Date.now() - 120_000,
      "platform",
      Date.now() - 120_000,
    );
    await f.a.db.call("ingest", {
      source: "twitch",
      accountId: "owner",
      externalId: "http-msg-1",
      type: "chat.message",
      actor: { externalId: "owner", displayName: "Owner" },
      occurredAtMs: Date.now() - 60_000,
      receivedAtMs: Date.now() - 59_000,
      sourceTime: null,
      timeQuality: "provider",
      transport: "eventsub",
      payload: { text: "hi" },
    });
    await f.a.db.call("recordPoll", session, "owner", {
      startedAtMs: Date.now() - 120_000,
      completedAtMs: Date.now() - 60_000,
      status: "complete",
      userIds: ["owner"],
    });
    const stats = await get(`/api/v1/persons/${personId}/stats?session=${session}`);
    assert.equal(stats.statusCode, 200);
    assert.equal(typeof stats.json().messageCount, "number");
    assert.ok("observedMinutesThisSession" in stats.json());
    const tops = await get(
      `/api/v1/persons/tops?by=messages&session=${session}`,
    );
    assert.equal(tops.statusCode, 200);
    assert.ok(Array.isArray(tops.json()));
    assert.equal(
      (await get(`/api/v1/persons/tops?by=donations&limit=10`)).statusCode,
      200,
    );
    assert.equal(
      (
        await get(
          `/api/v1/persons/tops?by=observed_minutes&session=${session}&limit=5`,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await get(`/api/v1/persons/tops?by=bogus`)).statusCode,
      200,
    );
    const insights = await get(`/api/v1/insights?session=${session}`);
    assert.equal(insights.statusCode, 200);
    assert.ok(Array.isArray(insights.json()));
    assert.equal((await get("/api/v1/insights")).statusCode, 200);
    const summary = await get(`/api/v1/summary?session=${session}`);
    assert.equal(summary.statusCode, 200);
    assert.ok("coverage" in summary.json());
    assert.ok("gapCount" in summary.json());
    assert.equal(
      (await get(`/api/v1/persons/${personId}/stats`)).statusCode,
      200,
    );
    assert.equal((await get("/api/v1/persons/missing/stats")).statusCode, 404);
  } finally {
    await f.close();
  }
});


test("manual stream deletion requires authentication, CSRF and strict payload, and preserves automatic streams",async()=>{
 const f=await fixture();
 try{
  const now=Date.now(),manual=await f.a.db.call<string>('startSession','local','mistake',now,'manual',now);
  const url=`/api/v1/sessions/${manual}/delete`;
  const inject=(headers:Record<string,string>,payload:Record<string,unknown>={})=>f.a.app.inject({method:'POST',url,headers,payload});
  assert.equal((await inject({host:f.headers.host})).statusCode,401);
  assert.equal((await inject({...f.headers,'x-csrf-token':'wrong'})).statusCode,403);
  assert.equal((await inject(f.headers,{unexpected:true})).statusCode,400);
  assert.equal((await f.a.db.call<any[]>('sessions')).length,1);
  assert.equal((await inject(f.headers)).statusCode,200);
  assert.equal((await inject(f.headers)).statusCode,200);
  assert.equal((await f.a.db.call<any[]>('sessions')).length,0);
  const real=await f.a.db.call<string>('observePlatformStream','twitch','channel','real',now,now,null,'Actual stream');
  const denied=await f.a.app.inject({method:'POST',url:`/api/v1/sessions/${real}/delete`,headers:f.headers,payload:{}});
  assert.equal(denied.statusCode,400);assert.equal(denied.json().error,'PLATFORM_SESSION_MANAGED_AUTOMATICALLY');
  assert.equal((await f.a.db.call<any[]>('sessions')).length,1);
 }finally{await f.close();}
});

test('split history and guarded undo are available only through protected API',async()=>{
 const f=await fixture();
 try{
  const now=Date.now();await f.a.db.call('youtubeMessages','channel','chat',[{id:'message',snippet:{type:'textMessageEvent',publishedAt:new Date(now).toISOString()},authorDetails:{channelId:'author',displayName:'Author'}}]);
  const person=await f.a.db.call<any>('person','youtube:author'),identity=person.identities[0];
  const split=await f.a.app.inject({method:'POST',url:'/api/v1/persons/split',headers:f.headers,payload:{identityIds:[identity.id],name:'Separate',revision:person.revision}});assert.equal(split.statusCode,200);
  const audit=await f.a.app.inject({url:'/api/v1/splits',headers:f.headers});assert.equal(audit.statusCode,200);const id=audit.json()[0].id;
  const url=`/api/v1/splits/${id}/undo`;
  assert.equal((await f.a.app.inject({method:'POST',url,headers:{host:f.headers.host},payload:{}})).statusCode,401);
  assert.equal((await f.a.app.inject({method:'POST',url,headers:{...f.headers,'x-csrf-token':'wrong'},payload:{}})).statusCode,403);
  assert.equal((await f.a.app.inject({method:'POST',url,headers:f.headers,payload:{unexpected:true}})).statusCode,400);
  assert.equal((await f.a.app.inject({method:'POST',url,headers:f.headers,payload:{}})).statusCode,200);
  assert.equal((await f.a.db.call<any>('person','youtube:author')).identities.length,1);
  assert.equal((await f.a.app.inject({method:'POST',url,headers:f.headers,payload:{}})).statusCode,400);
 }finally{await f.close();}
});

test('donation API enforces auth, CSRF, strict exact-money payloads and optimistic revisions',async()=>{
 const f=await fixture();
 try{
  const now=Date.now();await f.a.db.call('youtubeMessages','channel','chat',[{id:'viewer',snippet:{type:'textMessageEvent',publishedAt:new Date(now).toISOString()},authorDetails:{channelId:'author',displayName:'Author'}}]);
  const input={personId:'youtube:author',amount:'12.34',currency:'RUB',occurredAtMs:now,message:'Manual donation',sourceName:'Cash'};
  const post=(url:string,payload:Record<string,unknown>)=>f.a.app.inject({method:'POST',url,headers:f.headers,payload});
  assert.equal((await f.a.app.inject({method:'POST',url:'/api/v1/donations',headers:{host:f.headers.host},payload:input})).statusCode,401);
  assert.equal((await f.a.app.inject({method:'POST',url:'/api/v1/donations',headers:{...f.headers,'x-csrf-token':'wrong'},payload:input})).statusCode,403);
  for(const body of [{...input,amount:12.34},{...input,amount:'1e3'},{...input,amount:'12.345'},{...input,currency:'XXX'},{...input,occurredAtMs:null},{...input,extra:true}])assert.equal((await post('/api/v1/donations',body)).statusCode,400);
  const made=await post('/api/v1/donations',input);assert.equal(made.statusCode,200);assert.equal(made.json().amountMinor,'1234');
  const id=encodeURIComponent(made.json().id);
  const updated=await post(`/api/v1/donations/${id}/update`,{...input,amount:'5.00',revision:0});assert.equal(updated.statusCode,200);assert.equal(updated.json().revision,1);
  assert.equal((await post(`/api/v1/donations/${id}/delete`,{revision:0})).statusCode,409);
  assert.equal((await post(`/api/v1/donations/${id}/delete`,{revision:1})).statusCode,200);
  assert.equal((await f.a.app.inject({url:'/api/v1/donations?person=youtube%3Aauthor',headers:f.headers})).json().total,0);
  assert.equal((await f.a.app.inject({url:'/api/v1/donations?person=youtube%3Aauthor&includeDeleted=true',headers:f.headers})).json().total,1);
  assert.equal((await post(`/api/v1/donations/${id}/restore`,{revision:2})).json().revision,3);
  assert.equal((await f.a.app.inject({url:`/api/v1/donations/${id}/audit`,headers:f.headers})).json().length,4);
  assert.equal((await f.a.app.inject({url:'/api/v1/donations?limit=101',headers:f.headers})).statusCode,400);
  assert.equal((await f.a.app.inject({url:'/api/v1/donations?includeDeleted=yes',headers:f.headers})).statusCode,400);
 }finally{await f.close();}
});
