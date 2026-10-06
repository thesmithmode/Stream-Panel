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
