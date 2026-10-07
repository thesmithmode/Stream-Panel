import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { StreamStore } from "../src/store.js";

test("profiles share one SQLite but isolate identical provider keys, mutations and history after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-profiles-"));
  const path = join(dir, "data.sqlite");
  const a = new StreamStore(path, "ruslan");
  const b = new StreamStore(path, "gulnaz");
  try {
    const input = { source: "twitch" as const, accountId: "channel", externalId: "same-id", type: "chat.message", actor: { externalId: "viewer", displayName: "Viewer" }, occurredAtMs: 100, receivedAtMs: 100, sourceTime: null, timeQuality: "provider" as const, transport: "eventsub" as const, payload: { text: "Руслан" } };
    const first = a.ingest(input);
    const other = b.ingest({ ...input, payload: { text: "Гульназ" } });
    assert.notEqual(first.personId, other.personId);
    assert.equal(a.summary().events, 1);
    assert.equal(b.summary().messages, 1);
    assert.equal((a.events()[0]!.payload as any).text, "Руслан");
    assert.equal((b.events()[0]!.payload as any).text, "Гульназ");
    assert.throws(() => b.person(first.personId!), /NOT_FOUND/);
    assert.throws(() => b.renamePerson(first.personId!, "Hacked"), /NOT_FOUND/);
    a.renamePerson(first.personId!, "Only A");
    assert.equal(b.person(other.personId!).display_name, "Viewer");
    const sa = a.startSession("channel", "same-stream", 100, "platform", 100);
    const sb = b.startSession("channel", "same-stream", 100, "platform", 100);
    assert.notEqual(sa, sb);
    assert.equal(a.sessions().length, 1);
    assert.equal(b.sessions().length, 1);
  } finally { a.close(); b.close(); }
  const reopened = new StreamStore(path, "ruslan");
  const raw = new Database(path);
  try {
    assert.equal(reopened.persons()[0]!.display_name, "Only A");
    assert.equal((raw.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
    assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.throws(() => new StreamStore(path, "../escape"), /INVALID_PROFILE/);
  } finally { reopened.close(); raw.close(); await rm(dir, { recursive: true, force: true }); }
});
