import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedApplication } from "../src/hosted.js";

test("hosted profile selector isolates history and connections without login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-"));
  const h = await createHostedApplication(dir, "https://panel.example.test", false);
  const base = { host: "panel.example.test", origin: "https://panel.example.test" };
  const select = (profile:string) => h.app.inject({method:"POST",url:"/api/v1/profile",headers:base,payload:{profile}});
  try {
    assert.equal((await h.app.inject({url:"/api/v1/profile",headers:base})).json().profile,"ruslan");
    assert.equal((await h.app.inject({ url: "/api/v1/persons", headers: base })).statusCode, 200);
    assert.equal((await h.app.inject({ url: "/api/v1/persons", headers: { host: "evil.test" } })).statusCode, 403);
    const period = "from=1&to=100000";
    assert.equal((await h.app.inject({url:`/api/v1/analytics?${period}`,headers:base})).json().summary.entities,0);
    for (const query of ["from=bad&to=100000",`${period}&timezone=Bad/Zone`,`${period}&source=unknown`,`${period}&chatWindowMinutes=0`]) {
      const response=await h.app.inject({url:`/api/v1/analytics?${query}`,headers:base});
      assert.equal(response.statusCode,400,response.body);
      assert.match(response.json().error,/^INVALID_/);
    }
    const input = { source: "twitch", accountId: "channel", externalId: "same-event", type: "chat.message", actor: { externalId: "viewer", displayName: "Viewer" }, occurredAtMs: 100, receivedAtMs: 100, sourceTime: null, timeQuality: "provider", transport: "eventsub", payload: { text: "A" } };
    const [ea, eb] = await Promise.all([h.runtimes.get("ruslan")!.db.call<any>("ingest", input), h.runtimes.get("gulnaz")!.db.call<any>("ingest", { ...input, payload: { text: "B" } })]);
    assert.notEqual(ea.personId, eb.personId);
    const list = () => h.app.inject({ url: "/api/v1/events", headers: base });
    assert.equal((await list()).json()[0].payload.text, "A");
    assert.equal((await select("gulnaz")).statusCode,200);
    assert.equal((await h.app.inject({url:"/api/v1/profile",headers:base})).json().profile,"gulnaz");
    assert.equal((await list()).json()[0].payload.text, "B");
    assert.equal((await h.app.inject({url:`/api/v1/persons/${ea.personId}`,headers:base})).statusCode,404);
    assert.equal((await select("ruslan")).statusCode,200);
    assert.equal((await list()).json()[0].payload.text,"A");
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/profile",headers:{...base,origin:"https://evil.test"},payload:{profile:"gulnaz"}})).statusCode,403);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/profile",headers:base,payload:{profile:"unknown"}})).statusCode,400);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,503);
    const writes = await Promise.all(Array.from({ length: 10 }, (_, i) => h.app.inject({ method: "POST", url: `/api/v1/persons/${ea.personId}/rename`, headers: base, payload: { name: `Name ${i}` } })));
    assert.equal(writes.every((r) => r.statusCode === 200), true);
    assert.equal((await h.app.inject({ url: "/healthz", headers: { host: "panel.example.test" } })).statusCode, 200);
    assert.equal((await h.app.inject({ method: "POST", url: "/api/v1/bootstrap", headers: base, payload: { key: "anything" } })).statusCode, 404);
    await h.app.close();
    const reopened=await createHostedApplication(dir,"https://panel.example.test",false);
    assert.equal((await reopened.app.inject({url:"/api/v1/profile",headers:base})).json().profile,"ruslan");
    assert.equal((await reopened.app.inject({url:"/api/v1/events",headers:base})).json()[0].payload.text,"A");
    await reopened.app.close();
  } finally { await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("hosted server enforces maintenance and backup boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-boundaries-"));
  const {writeFile,unlink} = await import("node:fs/promises");
  const {randomBytes} = await import("node:crypto");
  await writeFile(join(dir,"key"),randomBytes(32).toString("hex"));
  const base={host:"panel.example.test",origin:"https://panel.example.test"};
  let h=await createHostedApplication(dir,"https://panel.example.test",false,{keyFile:join(dir,"key")});
  try {
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:{...base,origin:"https://evil.test"},payload:{}})).statusCode,403);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,200);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,429);
    await writeFile(join(dir,"deploying"),"");
    assert.equal((await h.app.inject({url:"/api/v1/status",headers:base})).json().error,"SERVER_UPDATING");
    assert.equal((await h.app.inject({url:"/healthz",headers:base})).statusCode,200);
    await unlink(join(dir,"deploying"));
    assert.equal((await h.app.inject({url:"/api/v1/status",headers:base})).json().profile,"ruslan");
    assert.equal((await h.app.inject({url:"/unknown/spa",headers:base})).statusCode,200);
    assert.equal((await h.app.inject({url:"/oauth/nope/callback",headers:base})).statusCode,404);
    await h.app.close();h=await createHostedApplication(dir,"https://panel.example.test",false);
    assert.equal((await h.app.inject({url:"/api/v1/profile",headers:base})).json().profile,"ruslan");
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,503);
    await h.runtimes.get("ruslan")!.db.stop();
    assert.equal((await h.app.inject({url:"/healthz",headers:base})).statusCode,503);
    assert.equal((await h.app.inject({method:"POST",url:"/api/v1/backup",headers:base,payload:{}})).statusCode,503);
  }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
  await assert.rejects(createHostedApplication(dir,"http://public.example.test",false),/INVALID_PUBLIC_ORIGIN/);
});
