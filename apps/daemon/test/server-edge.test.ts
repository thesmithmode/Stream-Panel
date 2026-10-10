import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
