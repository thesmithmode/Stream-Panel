import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/server.js";

async function fixture(options: any = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sp-server-edge-"));
  const a = await createApplication(dir, 47841, false, {}, options);
  const host = { host: "127.0.0.1:47841" };
  let headers: Record<string, string>;
  if (options.session) headers = { ...host, "x-csrf-token": "edge-csrf" };
  else {
    const key = new URLSearchParams(a.bootstrap().split("#")[1]).get("key");
    const login = await a.app.inject({ method: "POST", url: "/api/v1/bootstrap", headers: host, payload: { key } });
    headers = { ...host, cookie: String(login.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": login.json().csrf };
  }
  return { a, dir, headers, close: async () => { await a.app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("analytics accepts omitted optional filters and uses documented defaults", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const r = await f.a.app.inject({ url: `/api/v1/analytics?from=${now - 60_000}&to=${now}`, headers: f.headers });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().filters.regularThresholdPercent, 50);
    const status = await f.a.app.inject({ url: "/api/v1/status", headers: { ...f.headers, host: "localhost:47841" } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().csrf, f.headers["x-csrf-token"]);
    const wrongHost = await f.a.app.inject({ url: "/api/v1/status", headers: { ...f.headers, host: "untrusted.invalid" } });
    assert.equal(wrongHost.statusCode, 403);
    assert.equal(wrongHost.json().error, "INVALID_HOST");
  } finally { await f.close(); }
});

test("hosted session and explicit profile are reflected in status", async () => {
  const f = await fixture({ profile: "ruslan", session: () => ({ csrf: "edge-csrf", expires: Date.now() + 60_000 }) });
  try {
    const status = await f.a.app.inject({ url: "/api/v1/status", headers: f.headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().serverMode, true);
    assert.equal(status.json().profile, "ruslan");
    assert.equal(status.json().csrf, "edge-csrf");
  } finally { await f.close(); }
});

test("person notes and donation reassignment preserve revisions and expose no implicit person links", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    await f.a.db.call("youtubeMessages", "channel", "chat", [{ id: "author-event", snippet: { type: "textMessageEvent", publishedAt: new Date(now).toISOString() }, authorDetails: { channelId: "author", displayName: "Author" } }]);
    const person = await f.a.db.call<any>("person", "youtube:author");
    const post = (url: string, payload: Record<string, unknown>) => f.a.app.inject({ method: "POST", url, headers: f.headers, payload });
    const note = await post(`/api/v1/persons/${person.id}/notes`, { body: "Initial context" });
    assert.equal(note.statusCode, 200, note.body);
    const noteId = note.json().id;
    assert.equal((await f.a.app.inject({ url: `/api/v1/persons/${person.id}/notes`, headers: f.headers })).json()[0].body, "Initial context");
    assert.equal((await post(`/api/v1/persons/${person.id}/notes/${noteId}/update`, { body: "Updated context", revision: 0 })).statusCode, 200);
    assert.equal((await post(`/api/v1/persons/${person.id}/notes/${noteId}/update`, { body: "Stale edit", revision: 0 })).statusCode, 409);
    assert.equal((await post(`/api/v1/persons/${person.id}/notes/${noteId}/delete`, { revision: 1 })).statusCode, 200);
    assert.deepEqual((await f.a.app.inject({ url: `/api/v1/persons/${person.id}/notes`, headers: f.headers })).json(), []);

    const second = await f.a.db.call<any>("createPerson", "Separate payee");
    const donation = { personId: person.id, amount: "4.25", currency: "RUB", occurredAtMs: now, message: "manual", sourceName: "cash" };
    const made = await post("/api/v1/donations", donation);
    assert.equal(made.statusCode, 200, made.body);
    const updated = await post(`/api/v1/donations/${encodeURIComponent(made.json().id)}/update`, { ...donation, personId: second.id, occurredAtMs: null, revision: 0 });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().personId, second.id);
    assert.equal(updated.json().occurredAtMs, null);
  } finally { await f.close(); }
});

test("unexpected non-Error failures are sanitized and null UTC offset is accepted", async (t) => {
  const f = await fixture();
  try {
    const mock = t.mock.method(f.a.db, "call", async () => { throw "private failure"; });
    const failed = await f.a.app.inject({ url: "/api/v1/persons", headers: f.headers });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { error: "INTERNAL_ERROR" });
    mock.mock.restore();
    const invalid = await f.a.app.inject({ method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers, payload: { utcOffsetMinutes: -841 } });
    assert.equal(invalid.statusCode, 400, "schema rejects offsets beyond fourteen hours");
    const nullable = await f.a.app.inject({ method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers, payload: { utcOffsetMinutes: null, clientId: "fixture-client", clientSecret: "fixture-secret" } });
    assert.equal(nullable.statusCode, 200, nullable.body);
    assert.equal(typeof nullable.json().url, "string");
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("DonationAlerts rejects a URL as the effective secret before stopping or mutating config", async (t) => {
  const f = await fixture();
  try {
    f.a.configuration.value.daClientId = "saved-client";
    f.a.configuration.value.daClientSecret = "saved-secret";
    await f.a.configuration.save();
    const before = await readFile(join(f.dir, "secrets.json"), "utf8");
    const stop = t.mock.method(f.a.da, "stop", async () => {});
    const result = await f.a.app.inject({
      method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers,
      payload: { clientSecret: " https://example.test/oauth/callback ", utcOffsetMinutes: null },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error, "DA_CLIENT_SECRET_IS_URL");
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(f.a.configuration.value.daClientSecret, "saved-secret");
    assert.equal(await readFile(join(f.dir, "secrets.json"), "utf8"), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("DonationAlerts requires effective OAuth credentials before stopping or saving", async (t) => {
  const f = await fixture();
  try {
    await f.a.configuration.save();
    const before = await readFile(join(f.dir, "secrets.json"), "utf8");
    const stop = t.mock.method(f.a.da, "stop", async () => {});
    const result = await f.a.app.inject({
      method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers,
      payload: { clientId: "  ", clientSecret: "  ", utcOffsetMinutes: null },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error, "DA_APP_CREDENTIALS_REQUIRED");
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(f.a.configuration.value.daClientId, "");
    assert.equal(f.a.configuration.value.daClientSecret, "");
    assert.equal(await readFile(join(f.dir, "secrets.json"), "utf8"), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("DonationAlerts trims new OAuth credentials and reuses saved credentials; manual token bypasses OAuth credentials", async (t) => {
  const f = await fixture();
  try {
    const stop = t.mock.method(f.a.da, "stop", async () => {});
    const start = t.mock.method(f.a.da, "start", async () => {});
    const first = await f.a.app.inject({
      method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers,
      payload: { clientId: "  fixture-client  ", clientSecret: "  fixture-secret  ", utcOffsetMinutes: null },
    });
    assert.equal(first.statusCode, 200, first.body);
    const authorization = new URL(first.json().url);
    assert.equal(authorization.searchParams.get("client_id"), "fixture-client");
    assert.equal(f.a.configuration.value.daClientId, "fixture-client");
    assert.equal(f.a.configuration.value.daClientSecret, "fixture-secret");

    const second = await f.a.app.inject({
      method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers,
      payload: { clientId: " ", clientSecret: " ", utcOffsetMinutes: null },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(new URL(second.json().url).searchParams.get("client_id"), "fixture-client");
    assert.equal(f.a.configuration.value.daClientSecret, "fixture-secret");

    const manual = await f.a.app.inject({
      method: "POST", url: "/api/v1/donationalerts/connect", headers: f.headers,
      payload: { accessToken: " manual-access ", refreshToken: "manual-refresh", utcOffsetMinutes: null },
    });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.deepEqual(manual.json(), { ok: true });
    assert.equal(f.a.configuration.value.daAccessToken, "manual-access");
    assert.equal(start.mock.callCount(), 1);
    assert.equal(stop.mock.callCount(), 3);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("DonationAlerts callback distinguishes rejected client credentials without exposing provider details",async(t)=>{
 const f=await fixture();
 try {
  const finish=t.mock.method(f.a.da,'finishAuth',async()=>{throw new Error('DA_OAUTH_HTTP_401');});
  const rejected=await f.a.app.inject({url:'/oauth/donationalerts/callback?code=code&state=state',headers:f.headers});
  assert.equal(rejected.statusCode,400);
  assert.match(rejected.body,/Client ID или Client Secret/);
  assert.match(rejected.body,/Redirect URI укажите отдельно/);
  finish.mock.restore();
  const generic=t.mock.method(f.a.da,'finishAuth',async()=>{throw new Error('private-provider-detail');});
  const failed=await f.a.app.inject({url:'/oauth/donationalerts/callback?code=code&state=state',headers:f.headers});
  assert.equal(failed.statusCode,400);
  assert.match(failed.body,/redirect URI и state/);
  assert.equal(failed.body.includes('private-provider-detail'),false);
  generic.mock.restore();
 } finally {t.mock.restoreAll();await f.close();}
});

test('single-stream analytics derives its bounds server-side and never includes overlapping recordings',async()=>{
 const f=await fixture();
 try{
  const base=Math.floor((Date.now()-3600000)/60000)*60000;
  const first=await f.a.db.call<string>('startSession','a','scoped-a',base,'platform',base);
  const other=await f.a.db.call<string>('startSession','b','scoped-b',base,'platform',base);
  for(const [id,account,user] of [[first,'a','silent'],[other,'b','other']]){
   await f.a.db.call('recordPoll',id,account,{startedAtMs:base,completedAtMs:base+120000,status:'complete',userIds:[user]});
   await f.a.db.call('endSession',id,base+600000,'observed');
  }
  const r=await f.a.app.inject({url:`/api/v1/analytics?session=${first}&from=0&to=1`,headers:f.headers});
  assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().summary.streams,1);
  assert.deepEqual(r.json().audience.map((p:any)=>p.name),['silent']);
  assert.equal(r.json().audience[0].observedMinutes,3);
  assert.equal(r.json().filters.fromMs,base);
  assert.equal(r.json().filters.toMs,base+600000);
  const missing=await f.a.app.inject({url:'/api/v1/analytics?session=missing',headers:f.headers});
  assert.notEqual(missing.statusCode,200);assert.equal(missing.json().error,'SESSION_NOT_FOUND');
 }finally{await f.close();}
});
