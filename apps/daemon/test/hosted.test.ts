import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountStore } from "../src/auth.js";
import { createHostedApplication } from "../src/hosted.js";

test("hosted logins isolate two profiles and simultaneous writes; login, CSRF, origin and logout fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-"));
  const accounts = new AccountStore(join(dir, "data.sqlite"));
  await accounts.createUser("ruslan", "ruslan", "Руслан", "ruslan-long-password");
  await accounts.createUser("gulnaz", "gulnaz", "Гульназ", "gulnaz-long-password");
  accounts.close();
  const h = await createHostedApplication(dir, "https://panel.example.test", false);
  const base = { host: "panel.example.test", origin: "https://panel.example.test" };
  async function login(username: string, password: string) {
    const response = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: base, payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers["set-cookie"]), /Secure/);
    return { ...base, cookie: String(response.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": response.json().csrf };
  }
  try {
    assert.equal((await h.app.inject({ url: "/api/v1/persons", headers: base })).statusCode, 401);
    assert.equal((await h.app.inject({ url: "/api/v1/persons", headers: { host: "evil.test" } })).statusCode, 403);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: base, payload: { username: "ruslan", password: "bad" } })).statusCode, 401);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { ...base, origin: "https://evil.test" }, payload: { username: "ruslan", password: "ruslan-long-password" } })).statusCode, 403);
    const [a, b] = await Promise.all([login("ruslan", "ruslan-long-password"), login("gulnaz", "gulnaz-long-password")]);
    const period = "from=1&to=100000";
    assert.equal((await h.app.inject({url:`/api/v1/analytics?${period}`,headers:a})).json().summary.entities,0);
    for (const query of ["from=bad&to=100000",`${period}&timezone=Bad/Zone`,`${period}&source=unknown`,`${period}&chatWindowMinutes=0`]) {
      const response=await h.app.inject({url:`/api/v1/analytics?${query}`,headers:a});
      assert.equal(response.statusCode,400,response.body);
      assert.match(response.json().error,/^INVALID_/);
    }
    const input = { source: "twitch", accountId: "channel", externalId: "same-event", type: "chat.message", actor: { externalId: "viewer", displayName: "Viewer" }, occurredAtMs: 100, receivedAtMs: 100, sourceTime: null, timeQuality: "provider", transport: "eventsub", payload: { text: "A" } };
    const [ea, eb] = await Promise.all([h.runtimes.get("ruslan")!.db.call<any>("ingest", input), h.runtimes.get("gulnaz")!.db.call<any>("ingest", { ...input, payload: { text: "B" } })]);
    assert.notEqual(ea.personId, eb.personId);
    const list = (headers: any) => h.app.inject({ url: "/api/v1/events", headers });
    assert.equal((await list(a)).json()[0].payload.text, "A");
    assert.equal((await list(b)).json()[0].payload.text, "B");
    assert.equal((await h.app.inject({ url: `/api/v1/persons/${ea.personId}`, headers: b })).statusCode, 404);
    assert.equal((await h.app.inject({ method: "POST", url: `/api/v1/persons/${ea.personId}/rename`, headers: b, payload: { name: "Stolen" } })).statusCode, 404);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/twitch/disconnect", headers: { ...a, "x-csrf-token": "wrong" }, payload: {} })).statusCode, 403);
    const writes = await Promise.all(Array.from({ length: 10 }, (_, i) => h.app.inject({ method: "POST", url: `/api/v1/persons/${i % 2 ? ea.personId : eb.personId}/rename`, headers: i % 2 ? a : b, payload: { name: `Name ${i}` } })));
    assert.equal(writes.every((r) => r.statusCode === 200), true);
    assert.equal((await h.app.inject({ url: "/api/v1/auth/me", headers: a })).json().user.profile, "ruslan");
    assert.equal((await h.app.inject({ url: "/healthz", headers: { host: "panel.example.test" } })).statusCode, 200);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: a, payload: {} })).statusCode, 200);
    assert.equal((await list(a)).statusCode, 401);
    assert.equal((await list(b)).statusCode, 200);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/bootstrap", headers: b, payload: { key: "anything" } })).statusCode, 404);
  } finally { await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("hosted server exposes safe errors, enforces maintenance, backs up privately and restores durable logins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-boundaries-"));
  const {writeFile,unlink} = await import("node:fs/promises");
  const {randomBytes} = await import("node:crypto");
  await writeFile(join(dir,"key"),randomBytes(32).toString("hex"));
  const base={host:"panel.example.test",origin:"https://panel.example.test"};
  let h=await createHostedApplication(dir,"https://panel.example.test",false,{keyFile:join(dir,"key")});
  try {
    await h.accounts.createUser("ruslan","ruslan","Руслан","hosted-boundary-password");
    const invalid = await h.app.inject({method:"POST",url:"/api/v1/auth/login",headers:base,payload:{username:"ruslan",password:"x",unexpected:true}});
    assert.equal(invalid.statusCode,400);assert.equal(invalid.json().error,"INVALID_REQUEST");
    for(let i=0;i<5;i++)await h.app.inject({method:"POST",url:"/api/v1/auth/login",headers:base,payload:{username:"missing",password:"bad"}});
    const limited=await h.app.inject({method:"POST",url:"/api/v1/auth/login",headers:base,payload:{username:"missing",password:"bad"}});
    assert.equal(limited.statusCode,429);assert.equal(limited.headers["retry-after"],"900");
    const login=await h.app.inject({method:"POST",url:"/api/v1/auth/login",headers:base,payload:{username:"ruslan",password:"hosted-boundary-password"}});
    const headers={...base,cookie:String(login.headers["set-cookie"]).split(";")[0]!,"x-csrf-token":login.json().csrf};
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:{...headers,"x-csrf-token":"wrong"},payload:{}})).statusCode,403);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/auth/logout",headers:{...headers,"x-csrf-token":"wrong"},payload:{}})).statusCode,403);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers,payload:{}})).statusCode,200);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers,payload:{}})).statusCode,429);
    await writeFile(join(dir,"deploying"),"");
    assert.equal((await h.app.inject({url:"/api/v1/status",headers})).json().error,"SERVER_UPDATING");
    assert.equal((await h.app.inject({url:"/healthz",headers})).statusCode,200);
    await unlink(join(dir,"deploying"));
    assert.equal((await h.app.inject({url:"/api/v1/status",headers})).json().user.profile,"ruslan");
    assert.equal((await h.app.inject({url:"/unknown/spa",headers})).statusCode,200);
    assert.equal((await h.app.inject({url:"/oauth/nope/callback",headers})).statusCode,404);
    await h.app.close();h=await createHostedApplication(dir,"https://panel.example.test",false);
    assert.equal((await h.app.inject({url:"/api/v1/auth/me",headers})).json().user.profile,"ruslan");
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers,payload:{}})).statusCode,503);
    await h.runtimes.get("ruslan")!.db.stop();
    assert.equal((await h.app.inject({url:"/healthz",headers})).statusCode,503);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,401);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/auth/logout",headers:base,payload:{}})).statusCode,401);
    assert.equal((await h.app.inject({url:"/api/v1/auth/me",headers:base})).statusCode,401);
  }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
  await assert.rejects(createHostedApplication(dir,"http://public.example.test",false),/INVALID_PUBLIC_ORIGIN/);
});
