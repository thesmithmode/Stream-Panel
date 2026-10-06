import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { StreamStore } from "../src/store.js";
import { schemaV1 } from "../src/schema.js";
import { assertTimestamp, type EventInput } from "../src/domain.js";
import { collectChatters } from "../src/chatters.js";
import { presenceMinutes } from "../src/presence.js";
const event: EventInput = {
  source: "twitch",
  accountId: "channel",
  externalId: "one",
  type: "chat.message",
  actor: { externalId: "one", displayName: "Old" },
  occurredAtMs: 60000,
  receivedAtMs: 61000,
  sourceTime: null,
  timeQuality: "provider",
  transport: "eventsub",
  payload: { text: "hello", originChannelId: "channel" },
};
test("invalid timestamps, pagination limits and bad provider pages fail closed", async () => {
  for (const n of [-1, NaN, Infinity, 0.1, 8640000000000001])
    assert.throws(() => assertTimestamp(n), /INVALID_TIMESTAMP/);
  for (const max of [0, -1, 0.5])
    await assert.rejects(
      collectChatters(
        async () => ({ data: [], pagination: {} }),
        () => 0,
        max,
      ),
      /INVALID_PAGE_LIMIT/,
    );
  for (const page of [
    { data: null, pagination: {} },
    { data: [] },
    { data: [{ user_id: "" }], pagination: {} },
    { data: [{ user_id: "one" }], pagination: { cursor: 123 } },
  ]) {
    const poll = await collectChatters(
      async () => page as never,
      () => 0,
    );
    assert.notEqual(poll.status, "complete");
  }
  let now = 2;
  await assert.rejects(
    collectChatters(
      async () => ({ data: [], pagination: {} }),
      () => now--,
    ),
    /CLOCK_MOVED_BACKWARDS/,
  );
  assert.throws(
    () =>
      presenceMinutes(
        [
          {
            startedAtMs: 60000,
            completedAtMs: 0,
            status: "complete",
            userIds: [],
          },
        ],
        "one",
        0,
        60000,
      ),
    /INVALID_POLL_WINDOW/,
  );
  assert.deepEqual(presenceMinutes([], "one", 0, 0), []);
});
test("invalid ingestion is atomic; anonymous duplicates and shared-chat exclusion retain honest totals", () => {
  const db = new StreamStore(":memory:");
  try {
    for (const bad of [
      { ...event, accountId: "" },
      { ...event, externalId: "" },
      { ...event, timeQuality: "unknown" as const },
      { ...event, actor: { externalId: "", displayName: "bad" } },
    ])
      assert.throws(() => db.ingest(bad));
    assert.equal(db.eventCount(), 0);
    assert.deepEqual(db.persons(), []);
    const anon = { ...event, actor: null };
    assert.equal(db.ingest(anon).personId, null);
    assert.equal(db.ingest(anon).inserted, false);
    db.ingest({
      ...event,
      externalId: "shared",
      payload: { originChannelId: "foreign", text: "shared" },
    });
    assert.equal(db.summary().messages, 1);
    const person = db.persons()[0]!;
    assert.equal(db.candidatePersons(" ").length, 0);
    assert.throws(() => db.person("missing"), /PERSON_NOT_FOUND/);
    assert.throws(() => db.personRevision("missing"), /PERSON_NOT_FOUND/);
    assert.throws(() => db.renamePerson("missing", "Name"), /PERSON_NOT_FOUND/);
    assert.throws(
      () => db.renamePerson(String(person.id), " "),
      /INVALID_NAME/,
    );
    assert.throws(
      () => db.merge(String(person.id), String(person.id), 0, 0, 0),
      /SAME_PERSON/,
    );
    assert.throws(() => db.undoMerge("missing", 0), /MERGE_NOT_FOUND/);
    db.renamePerson(String(person.id), "Group");
    assert.equal(db.person(String(person.id)).display_name, "Group");
    for (const ids of [[], ["missing"], [String(person.id), String(person.id)]])
      assert.throws(
        () => db.splitIdentities(ids, "Name", 0, 0),
        /INVALID_SPLIT/,
      );
    const session = db.startSession("channel", "stream", 0, "platform", 0);
    assert.throws(
      () =>
        db.recordPoll(session, "channel", {
          startedAtMs: 100,
          completedAtMs: 0,
          status: "complete",
          userIds: [],
        }),
      /INVALID_POLL_WINDOW/,
    );
    db.recordPoll(session, "channel", {
      startedAtMs: 0,
      completedAtMs: 100,
      status: "complete",
      userIds: ["new"],
    });
    db.updateChatterNames(
      "channel",
      [
        { user_id: "missing", user_name: "Missing" },
        { user_id: "new", user_name: "Renamed" },
      ],
      200,
    );
    assert.equal(db.persons("renamed").length, 1);
    db.gap("twitch", "network", 100, null);
    db.gap("twitch", "network", 100, 200);
    assert.equal(db.gaps().length, 2);
    assert.equal(db.merges().length, 0);
  } finally {
    db.close();
  }
});
test("v1 migration preserves data and backup rejects a semantically corrupted snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-migrate-"));
  const path = join(dir, "db.sqlite");
  let store: StreamStore | undefined;
  try {
    const old = new Database(path);
    old.exec(schemaV1);
    old
      .prepare("INSERT INTO persons VALUES (?,?,?)")
      .run("legacy", "Legacy", 0);
    old.close();
    store = new StreamStore(path);
    assert.equal(store.person("legacy").display_name, "Legacy");
    const inserted = store.ingest(event);
    const p = new Database(path);
    p.pragma("foreign_keys=OFF");
    p.prepare("UPDATE identities SET person_id=? WHERE id=?").run(
      "missing",
      inserted.identityId,
    );
    p.close();
    await assert.rejects(
      store.backup(join(dir, "bad.sqlite")),
      /BACKUP_VALIDATION_FAILED/,
    );
    assert.equal(store.eventCount(), 1);
    await assert.rejects(store.backup(join(dir, "missing", "backup.sqlite")));
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
