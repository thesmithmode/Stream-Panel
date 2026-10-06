import Database from "better-sqlite3";
import { schemaV1 } from "../src/schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { StreamStore, priorModerationQuery } from "../src/store.js";
import type { EventInput } from "../src/domain.js";
const message = (
  id: string,
  at: number,
  user = "one",
  account = "channel",
): EventInput => ({
  source: "twitch",
  accountId: account,
  externalId: id,
  type: "chat.message",
  actor: { externalId: user, displayName: user },
  occurredAtMs: at,
  receivedAtMs: at + 1000,
  sourceTime: null,
  timeQuality: "provider",
  transport: "eventsub",
  payload: { text: "private text" },
});
const moderation = (
  type: string,
  id: string,
  at: number,
  payload: Record<string, unknown>,
  account = "channel",
): EventInput => ({
  ...message(id, at, "one", account),
  type,
  actor: null,
  payload,
});
for (const kind of [
  "chat.message_delete",
  "chat.clear",
  "chat.clear_user_messages",
])
  test(`${kind}: delayed moderation and delayed messages preserve deletion after database restart`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-moderation-")),
      path = join(dir, "data.sqlite");
    let db = new StreamStore(path);
    try {
      db.ingest(message("newer", 180000));
      db.ingest(message("other-user", 60000, "two"));
      db.ingest(message("other-account", 60000, "one", "other-channel"));
      db.ingest(
        moderation(kind, "deletion", 120000, {
          targetMessageId: "old",
          targetUserId: "one",
        }),
      );
      db.close();
      db = new StreamStore(path);
      db.ingest(message("old", 60000));
      const rows = db.events();
      assert.equal(
        (rows.find((x) => x.external_id === "old")!.payload as any).text,
        "[сообщение удалено]",
      );
      assert.equal(
        (rows.find((x) => x.external_id === "newer")!.payload as any).text,
        "private text",
        "later messages must not be removed by an older clear",
      );
      assert.equal(
        (rows.find((x) => x.external_id === "other-account")!.payload as any)
          .text,
        "private text",
      );
      if (kind !== "chat.clear")
        assert.equal(
          (rows.find((x) => x.external_id === "other-user")!.payload as any)
            .text,
          "private text",
        );
      assert.equal(db.ingest(message("old", 60000)).inserted, false);
      assert.equal(db.eventCount(), 5);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("checking prior moderation uses a type-indexed lookup without walking message history", () => {
  const db = new Database(":memory:");
  try {
    db.exec(schemaV1);
    const plan = db
      .prepare("EXPLAIN QUERY PLAN " + priorModerationQuery)
      .all("channel", "message", 60000, "user") as { detail: string }[];
    assert.ok(
      plan.some((row) => row.detail.includes("type=?")),
      JSON.stringify(plan),
    );
  } finally {
    db.close();
  }
});
