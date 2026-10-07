import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { moneyToMinor, candidateKey, matchKey,
  daDonorExternalId, type EventInput } from "../src/domain.js";
import {
  botExclusionSet,
  WELL_KNOWN_TWITCH_BOTS,
  isExcludedBot,
  normalizeBotLogin,
} from "../src/bots.js";
import {
  StreamerBotStubAdapter,
  mapStreamerBotTwitchChatMessage,
} from "../src/streamerbot.js";
import { presenceMinutes, pollCoveredMinutes } from "../src/presence.js";
import { collectChatters } from "../src/chatters.js";
import { StreamStore } from "../src/store.js";

const base: EventInput = {
  source: "twitch",
  accountId: "channel-1",
  externalId: "message-1",
  type: "chat.message",
  actor: { externalId: "user-1", displayName: "Vasya" },
  occurredAtMs: 60_000,
  receivedAtMs: 61_000,
  sourceTime: "1970-01-01T00:01:00Z",
  timeQuality: "provider",
  transport: "eventsub",
  payload: { text: "hello" },
};
const donation: EventInput = {
  ...base,
  source: "donationalerts",
  accountId: "recipient-1",
  externalId: "donation-1",
  type: "donation",
  actor: { externalId: daDonorExternalId("Vasya"), displayName: "Vasya" },
  transport: "rest",
  sourceTime: "2026-10-06 20:00:00",
  occurredAtMs: null,
  timeQuality: "unknown",
  payload: { amountMinor: "1234", currency: "RUB" },
};

test("money has exact cents, large integers and separate currencies", () => {
  assert.equal(moneyToMinor("0.29", "RUB"), "29");
  assert.equal(moneyToMinor("123.4", "USD"), "12340");
  assert.equal(
    moneyToMinor("9007199254740993.01", "EUR"),
    "900719925474099301",
  );
  for (const value of ["1.001", "-1", "NaN", "1e3", "01.2"])
    assert.throws(() => moneyToMinor(value, "RUB"));
  assert.throws(() => moneyToMinor("10", "XYZ"), /UNSUPPORTED_CURRENCY/);
});

test("name normalization is only candidate discovery; does not fold confusables", () => {
  assert.equal(candidateKey(" ＶＡＳＹＡ "), "vasya");
  assert.notEqual(candidateKey("Вася"), candidateKey("Bacя"));
  assert.notEqual(candidateKey("@Vasya"), candidateKey("Vasya"));
});

test("unique cross-source login match auto-links; ambiguous names stay separate; DA actor key still enforced", () => {
  const store = new StreamStore(":memory:");
  try {
    const first = store.ingest(base);
    const second = store.ingest(donation);
    // High-confidence unique Twitch↔DA match_key → same person.
    assert.equal(first.personId, second.personId);
    const third = store.ingest({
      ...donation,
      externalId: "donation-2",
      actor: { externalId: daDonorExternalId("Vasya"), displayName: "Vasya" },
    });
    // Second DA donation with same name also links to the unique Twitch person.
    assert.equal(second.personId, third.personId);
    assert.equal(store.candidatePersons("Vasya").length, 1);
    // Ambiguous: two Twitch identities with same match key → DA does not auto-link.
    store.ingest({
      ...base,
      externalId: "message-amb-1",
      actor: { externalId: "user-amb-1", displayName: "Twin" },
    });
    store.ingest({
      ...base,
      externalId: "message-amb-2",
      actor: { externalId: "user-amb-2", displayName: "Twin" },
    });
    const daTwin = store.ingest({
      ...donation,
      externalId: "donation-twin",
      actor: { externalId: daDonorExternalId("Twin"), displayName: "Twin" },
    });
    assert.equal(store.candidatePersons("Twin").length, 3);
    const twinDetail = store.person(String(daTwin.personId)) as {
      identities: { source: string }[];
    };
    assert.ok(!twinDetail.identities.some((i) => i.source === "twitch"));
    assert.throws(
      () =>
        store.ingest({
          ...donation,
          externalId: "donation-bad-actor",
          actor: { externalId: "Vasya", displayName: "Vasya" },
        }),
      /DA_ACTOR_MUST_BE_DONOR_NAME/,
    );
    assert.equal(matchKey("@Vasya"), "vasya");
    assert.equal(matchKey("#Vasya"), "vasya");
    assert.notEqual(candidateKey("@Vasya"), candidateKey("Vasya"));
  } finally {
    store.close();
  }
});

test("DA same display name + same account is one Donor identity / one Person; Twitch viewers stay separate", () => {
  const store = new StreamStore(":memory:");
  try {
    const a = store.ingest({
      ...donation,
      externalId: "donation-egor-1",
      actor: { externalId: daDonorExternalId("Егор4ик"), displayName: "Егор4ик" },
    });
    const b = store.ingest({
      ...donation,
      externalId: "donation-egor-2",
      actor: { externalId: daDonorExternalId("Егор4ик"), displayName: "Егор4ик" },
    });
    const c = store.ingest({
      ...donation,
      externalId: "donation-egor-3",
      actor: { externalId: daDonorExternalId("Егор4ик"), displayName: "Егор4ик" },
    });
    assert.equal(a.personId, b.personId);
    assert.equal(b.personId, c.personId);
    assert.equal(a.identityId, b.identityId);
    assert.equal(b.identityId, c.identityId);
    const detail = store.person(String(a.personId)) as {
      identities: { source: string; external_id: string }[];
    };
    assert.equal(detail.identities.length, 1);
    assert.equal(detail.identities[0]!.source, "donationalerts");
    assert.equal(detail.identities[0]!.external_id, daDonorExternalId("Егор4ик"));
    // Different DA account keeps separate people even with same nick.
    const other = store.ingest({
      ...donation,
      accountId: "recipient-other",
      externalId: "donation-egor-x",
      actor: { externalId: daDonorExternalId("Егор4ик"), displayName: "Егор4ик" },
    });
    assert.notEqual(other.personId, a.personId);
    // Twitch stable ids with same display name stay separate persons.
    const t1 = store.ingest({
      ...base,
      externalId: "msg-t1",
      actor: { externalId: "twitch-a", displayName: "SameNick" },
    });
    const t2 = store.ingest({
      ...base,
      externalId: "msg-t2",
      actor: { externalId: "twitch-b", displayName: "SameNick" },
    });
    assert.notEqual(t1.personId, t2.personId);
    // FR07 still links unique Twitch↔DA same nick.
    const linked = store.ingest({
      ...donation,
      externalId: "donation-samenick",
      actor: { externalId: daDonorExternalId("UniqueLink"), displayName: "UniqueLink" },
    });
    const twitch = store.ingest({
      ...base,
      externalId: "msg-unique",
      actor: { externalId: "twitch-unique", displayName: "UniqueLink" },
    });
    // Order: DA first then Twitch — Twitch should auto-link to DA person.
    assert.equal(twitch.personId, linked.personId);
  } finally {
    store.close();
  }
});


test("collapseDuplicateDaDonors merges legacy per-tip DA identities into one Donor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-collapse-"));
  const dbPath = join(dir, "data.sqlite");
  try {
    const bootstrap = new StreamStore(dbPath);
    bootstrap.close();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    const personA = "person-legacy-a";
    const personB = "person-legacy-b";
    const idA = "id-legacy-a";
    const idB = "id-legacy-b";
    raw.prepare("INSERT INTO persons(id, display_name, revision) VALUES (?, ?, 1)").run(personA, "LegacyDonor");
    raw.prepare("INSERT INTO persons(id, display_name, revision) VALUES (?, ?, 1)").run(personB, "LegacyDonor");
    raw.prepare(
      `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key)
       VALUES (?, 'donationalerts', 'recipient-1', ?, 'LegacyDonor', 'legacydonor', ?, 'legacydonor')`,
    ).run(idA, "tip-1", personA);
    raw.prepare(
      `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key)
       VALUES (?, 'donationalerts', 'recipient-1', ?, 'LegacyDonor', 'legacydonor', ?, 'legacydonor')`,
    ).run(idB, "tip-2", personB);
    raw.prepare(
      `INSERT INTO events(id, source, account_id, external_id, type, identity_id, occurred_at_ms, received_at_ms, source_time, time_quality, transport, payload_json)
       VALUES ('e1','donationalerts','recipient-1','d1','donation',?,null,1,null,'unknown','rest','{}')`,
    ).run(idA);
    raw.prepare(
      `INSERT INTO events(id, source, account_id, external_id, type, identity_id, occurred_at_ms, received_at_ms, source_time, time_quality, transport, payload_json)
       VALUES ('e2','donationalerts','recipient-1','d2','donation',?,null,2,null,'unknown','rest','{}')`,
    ).run(idB);
    raw.prepare(
      `INSERT INTO identity_aliases(identity_id, name, candidate_key, first_seen_ms, last_seen_ms)
       VALUES (?, 'LegacyDonor', 'legacydonor', 1, 2)`,
    ).run(idB);
    raw.close();

    const inspect = new Database(dbPath);
    const store = new StreamStore(dbPath);
    try {
      store.collapseDuplicateDaDonors();
      const donors = inspect
        .prepare(
          `SELECT id, person_id, external_id FROM identities
           WHERE source='donationalerts' AND match_key='legacydonor'`,
        )
        .all() as { id: string; person_id: string; external_id: string }[];
      assert.equal(donors.length, 1);
      assert.equal(donors[0]!.external_id, daDonorExternalId("LegacyDonor"));
      const events = inspect
        .prepare("SELECT identity_id FROM events ORDER BY id")
        .all() as { identity_id: string }[];
      assert.equal(events[0]!.identity_id, donors[0]!.id);
      assert.equal(events[1]!.identity_id, donors[0]!.id);
      const aliases = inspect
        .prepare("SELECT identity_id, name FROM identity_aliases")
        .all() as { identity_id: string; name: string }[];
      assert.equal(aliases.length, 1);
      assert.equal(aliases[0]!.identity_id, donors[0]!.id);
    } finally {
      store.close();
      inspect.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collapseDuplicateDaDonors does not move DA tips across Twitch+DA person boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-collapse-safe-"));
  const dbPath = join(dir, "data.sqlite");
  try {
    // Twitch+DA linked person via normal ingest.
    {
      const store = new StreamStore(dbPath);
      store.ingest({
        ...base,
        actor: { externalId: "twitch-shared", displayName: "SharedNick" },
      });
      store.ingest({
        ...donation,
        externalId: "da-shared-1",
        actor: {
          externalId: daDonorExternalId("SharedNick"),
          displayName: "SharedNick",
        },
        timeQuality: "unknown",
        occurredAtMs: null,
      });
      store.close();
    }
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    const linked = raw
      .prepare(
        `SELECT i.id AS daId, i.person_id AS personId FROM identities i
         WHERE i.source='donationalerts' AND i.match_key='sharednick'`,
      )
      .get() as { daId: string; personId: string };
    assert.ok(linked);
    const twitch = raw
      .prepare(
        `SELECT id FROM identities WHERE source='twitch' AND person_id=?`,
      )
      .get(linked.personId) as { id: string };
    assert.ok(twitch);

    // Legacy tip-keyed DA identity under a different pure-DA person (same match_key).
    const purePerson = "person-pure-da";
    const tipId = "id-tip-legacy";
    raw.prepare("INSERT INTO persons(id, display_name, revision) VALUES (?, ?, 1)").run(
      purePerson,
      "SharedNick",
    );
    raw.prepare(
      `INSERT INTO identities(id, source, account_id, external_id, display_name, candidate_key, person_id, match_key)
       VALUES (?, 'donationalerts', 'recipient-1', 'tip-legacy-99', 'SharedNick', 'sharednick', ?, 'sharednick')`,
    ).run(tipId, purePerson);
    raw.prepare(
      `INSERT INTO events(id, source, account_id, external_id, type, identity_id, occurred_at_ms, received_at_ms, source_time, time_quality, transport, payload_json)
       VALUES ('e-tip','donationalerts','recipient-1','d-tip','donation',?,null,9,null,'unknown','rest','{"amountMinor":"1","currency":"RUB"}')`,
    ).run(tipId);
    raw.close();

    const store = new StreamStore(dbPath);
    try {
      store.collapseDuplicateDaDonors();
      const db = new Database(dbPath);
      const tipEvent = db
        .prepare("SELECT identity_id FROM events WHERE id='e-tip'")
        .get() as { identity_id: string };
      // Tip event must stay on the pure-DA side — not stolen onto Twitch+DA identity.
      assert.equal(tipEvent.identity_id, tipId);
      const tipIdent = db
        .prepare("SELECT person_id FROM identities WHERE id=?")
        .get(tipId) as { person_id: string };
      assert.equal(tipIdent.person_id, purePerson);
      const linkedDa = db
        .prepare("SELECT person_id FROM identities WHERE id=?")
        .get(linked.daId) as { person_id: string };
      assert.equal(linkedDa.person_id, linked.personId);
      // Twitch still on the linked person.
      const twitchStill = db
        .prepare("SELECT person_id FROM identities WHERE id=?")
        .get(twitch.id) as { person_id: string };
      assert.equal(twitchStill.person_id, linked.personId);
      db.close();
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dedupe covers WS/REST and direct/Streamer.bot; scope separates recipient accounts", () => {
  const store = new StreamStore(":memory:");
  try {
    assert.equal(store.ingest(base).inserted, true);
    assert.equal(
      store.ingest({ ...base, transport: "streamerbot" }).inserted,
      false,
    );
    assert.equal(store.ingest(donation).inserted, true);
    assert.equal(
      store.ingest({ ...donation, transport: "centrifugo" }).inserted,
      false,
    );
    assert.equal(
      store.ingest({ ...donation, accountId: "recipient-2" }).inserted,
      true,
    );
    assert.equal(store.eventCount(), 3);
  } finally {
    store.close();
  }
});

test("Twitch rename keeps identity, different user with reused name is independent", () => {
  const store = new StreamStore(":memory:");
  try {
    const first = store.ingest(base);
    const renamed = store.ingest({
      ...base,
      externalId: "message-2",
      actor: { externalId: "user-1", displayName: "NewName" },
    });
    const impostor = store.ingest({
      ...base,
      externalId: "message-3",
      actor: { externalId: "user-2", displayName: "Vasya" },
    });
    assert.equal(first.identityId, renamed.identityId);
    assert.notEqual(first.personId, impostor.personId);
    assert.deepEqual(store.candidatePersons("NewName"), [first.personId]);
  } finally {
    store.close();
  }
});

test("merge updates historical query; undo restores identities without rewriting events", () => {
  const store = new StreamStore(":memory:");
  try {
    const a = store.ingest(base).personId!;
    const b = store.ingest({
      ...donation,
      actor: { externalId: daDonorExternalId("OtherNick"), displayName: "OtherNick" },
    }).personId!;
    const merge = store.merge(
      b,
      a,
      store.personRevision(b),
      store.personRevision(a),
      70_000,
    );
    assert.equal(store.eventCount(a), 2);
    assert.equal(store.eventCount(b), 0);
    store.ingest({ ...base, externalId: "message-2" });
    store.undoMerge(merge, 80_000);
    assert.equal(store.eventCount(a), 2);
    assert.equal(store.eventCount(b), 1);
    assert.equal(store.eventCount(), 3);
    assert.throws(() => store.undoMerge(merge, 90_000), /ALREADY_UNDONE/);
  } finally {
    store.close();
  }
});

test("stale merge and undo after another membership change fail atomically", () => {
  const store = new StreamStore(":memory:");
  try {
    const a = store.ingest(base).personId!;
    const b = store.ingest({
      ...donation,
      actor: { externalId: daDonorExternalId("OtherNick"), displayName: "OtherNick" },
    }).personId!;
    const c = store.ingest({
      ...base,
      externalId: "message-3",
      actor: { externalId: "user-3", displayName: "Third" },
    }).personId!;
    assert.throws(() => store.merge(b, a, 0, 0, 70_000), /REVISION_CONFLICT/);
    const first = store.merge(
      b,
      a,
      store.personRevision(b),
      store.personRevision(a),
      70_000,
    );
    store.merge(c, a, store.personRevision(c), store.personRevision(a), 80_000);
    assert.throws(() => store.undoMerge(first, 90_000), /UNDO_CONFLICT/);
    assert.equal(store.eventCount(a), 3);
  } finally {
    store.close();
  }
});

test("invalid event rolls back identities as well as events", () => {
  const store = new StreamStore(":memory:");
  try {
    // Simulate a runtime value bypassing static typing at the adapter boundary.
    assert.throws(() =>
      store.ingest({
        ...base,
        transport: "invalid" as EventInput["transport"],
      }),
    );
    assert.equal(store.eventCount(), 0);
    assert.deepEqual(store.candidatePersons("Vasya"), []);
    assert.throws(
      () => store.ingest({ ...base, occurredAtMs: null }),
      /INVALID_TIME_QUALITY/,
    );
  } finally {
    store.close();
  }
});

test("pagination completes all pages and deduplicates changing page membership", async () => {
  const requested: (string | undefined)[] = [];
  const poll = await collectChatters(
    async (cursor) => {
      requested.push(cursor);
      return cursor === undefined
        ? {
            data: [{ user_id: "1", user_login: "a", user_name: "A" }],
            pagination: { cursor: "next" },
          }
        : {
            data: [
              { user_id: "1", user_login: "a", user_name: "A" },
              { user_id: "2", user_login: "b", user_name: "B" },
            ],
            pagination: {},
          };
    },
    () => 60_000,
  );
  assert.equal(poll.status, "complete");
  assert.deepEqual(poll.userIds, ["1", "2"]);
  assert.deepEqual(requested, [undefined, "next"]);
});

test("partial pagination, HTTP failure and cursor cycle never mean an empty complete poll", async () => {
  const partial = await collectChatters(
    async (cursor) => {
      if (cursor) throw new Error("HTTP 429");
      return {
        data: [{ user_id: "1", user_login: "a", user_name: "A" }],
        pagination: { cursor: "next" },
      };
    },
    () => 60_000,
  );
  const failed = await collectChatters(
    async () => {
      throw new Error("HTTP 401");
    },
    () => 120_000,
  );
  const cycle = await collectChatters(
    async () => ({ data: [], pagination: { cursor: "same" } }),
    () => 180_000,
  );
  assert.equal(partial.status, "partial");
  assert.equal(failed.status, "failed");
  assert.equal(cycle.status, "failed");
  assert.deepEqual(
    presenceMinutes(
      [partial, failed, cycle],
      "absent-user",
      60_000,
      240_000,
    ).map((x) => x.state),
    ["unknown", "unknown", "unknown"],
  );
});


test("complete poll covers every minute from startedAt through completedAt", () => {
  const polls = [
    {
      startedAtMs: 60_000,
      completedAtMs: 181_000,
      status: "complete" as const,
      userIds: ["1"],
    },
  ];
  assert.deepEqual(
    presenceMinutes(polls, "1", 60_000, 300_000).map((x) => x.state),
    ["observed", "observed", "observed", "unknown"],
  );
  assert.deepEqual(
    presenceMinutes(polls, "absent", 60_000, 180_000).map((x) => x.state),
    ["not_observed", "not_observed"],
  );
});

test("clampChattersPollSeconds defaults and clamps to 60–120", async () => {
  const { clampChattersPollSeconds } = await import("../src/presence.js");
  assert.equal(clampChattersPollSeconds(undefined), 60);
  assert.equal(clampChattersPollSeconds(30), 60);
  assert.equal(clampChattersPollSeconds(90), 90);
  assert.equal(clampChattersPollSeconds(180), 120);
});

test("minute grid preserves gaps, explicit empty poll and observation priority; interval is half-open", () => {
  const polls = [
    {
      startedAtMs: 60_000,
      completedAtMs: 61_000,
      status: "complete" as const,
      userIds: ["1"],
    },
    {
      startedAtMs: 120_000,
      completedAtMs: 121_000,
      status: "complete" as const,
      userIds: [],
    },
    {
      startedAtMs: 120_000,
      completedAtMs: 122_000,
      status: "complete" as const,
      userIds: ["1"],
    },
    {
      startedAtMs: 180_000,
      completedAtMs: 181_000,
      status: "complete" as const,
      userIds: [],
    },
  ];
  assert.deepEqual(
    presenceMinutes(polls, "1", 60_000, 300_000).map((x) => x.state),
    ["observed", "observed", "not_observed", "unknown"],
  );
  assert.throws(
    () => presenceMinutes(polls, "1", 60_001, 300_000),
    /INVALID_MINUTE_RANGE/,
  );
});

test("file persistence and online backup restore are usable while writer stays open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-"));
  const path = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  let source: StreamStore | undefined;
  let restored: StreamStore | undefined;
  try {
    source = new StreamStore(path);
    source.ingest(base);
    await source.backup(backup);
    restored = new StreamStore(backup);
    assert.equal(restored.eventCount(), 1);
    source.ingest(donation);
    assert.equal(restored.eventCount(), 1);
    restored.close();
    restored = undefined;
    source.close();
    source = new StreamStore(path);
    assert.equal(source.eventCount(), 2);
  } finally {
    source?.close();
    restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("future schema is rejected rather than modified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stream-panel-schema-"));
  const path = join(directory, "future.sqlite");
  try {
    const db = new Database(path);
    db.pragma("user_version = 99");
    db.close();
    assert.throws(() => new StreamStore(path), /UNSUPPORTED_SCHEMA_VERSION/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sessions survive restart, duplicate stream ID is stable, end interval is half-open", () => {
  const store = new StreamStore(":memory:");
  try {
    const session = store.startSession(
      "channel-1",
      "stream-1",
      60000,
      "platform",
      61000,
    );
    assert.equal(
      store.startSession("channel-1", "stream-1", 60000, "platform", 62000),
      session,
    );
    store.ingest(base);
    store.ingest({ ...base, externalId: "at-end", occurredAtMs: 120000 });
    store.endSession(session, 120000);
    assert.equal(store.summary(session).messages, 1);
    assert.equal(store.events(session).length, 1);
  } finally {
    store.close();
  }
});
test("stored minute grid distinguishes complete empty samples, gaps and merged identity union", () => {
  const store = new StreamStore(":memory:");
  try {
    const session = store.startSession(
      "channel-1",
      "stream-1",
      60000,
      "platform",
      60000,
    );
    const a = store.ingest(base).personId!;
    store.recordPoll(session, "channel-1", {
      startedAtMs: 60000,
      completedAtMs: 61000,
      status: "complete",
      userIds: ["user-1"],
    });
    store.recordPoll(session, "channel-1", {
      startedAtMs: 120000,
      completedAtMs: 121000,
      status: "complete",
      userIds: [],
    });
    assert.deepEqual(
      store.grid(session, a, 60000, 240000).map((x) => x.state),
      ["observed", "not_observed", "unknown"],
    );
  } finally {
    store.close();
  }
});
test("selective split preserves events and invalidates stale undo", () => {
  const store = new StreamStore(":memory:");
  try {
    const a = store.ingest(base),
      b = store.ingest({
        ...donation,
        actor: { externalId: daDonorExternalId("OtherNick"), displayName: "OtherNick" },
      });
    const merge = store.merge(
      b.personId!,
      a.personId!,
      store.personRevision(b.personId!),
      store.personRevision(a.personId!),
      70000,
    );
    const split = store.splitIdentities(
      [b.identityId!],
      "Separate",
      store.personRevision(a.personId!),
      80000,
    );
    assert.equal(store.eventCount(split), 1);
    assert.equal(store.eventCount(a.personId!), 1);
    assert.throws(() => store.undoMerge(merge, 90000), /UNDO_CONFLICT/);
  } finally {
    store.close();
  }
});

test("known-time DA donations join the single Twitch session; unknown time never does", () => {
  const store = new StreamStore(":memory:");
  try {
    const known = {
      ...donation,
      externalId: "known",
      actor: { externalId: daDonorExternalId("Vasya"), displayName: "Vasya" },
      occurredAtMs: 60000,
      timeQuality: "configured" as const,
    };
    store.ingest(known);
    store.ingest(donation);
    const session = store.startSession(
      "channel-1",
      "live",
      30000,
      "platform",
      45000,
    );
    assert.equal(store.summary(session).donations, 1);
    assert.equal(store.events(session)[0]!.external_id, "known");
    store.ingest({
      ...known,
      externalId: "second",
      actor: { externalId: daDonorExternalId("Vasya"), displayName: "Vasya" },
      occurredAtMs: 90000,
    });
    assert.equal(store.summary(session).donations, 2);
    store.endSession(session, 90000);
    assert.equal(store.summary(session).donations, 1);
  } finally {
    store.close();
  }
});

test("minute history queries older events beyond the latest 200 and keeps half-open bounds", () => {
  const store = new StreamStore(":memory:");
  try {
    const first = store.ingest(base);
    for (let i = 1; i <= 220; i++)
      store.ingest({
        ...base,
        externalId: `later-${i}`,
        occurredAtMs: 120000 + i * 60000,
      });
    assert.equal(store.events(undefined, first.personId!).length, 200);
    assert.equal(
      store.events(undefined, first.personId!, 60000, 120000).length,
      1,
    );
    assert.equal(store.events(undefined, first.personId!, 0, 60000).length, 0);
    assert.throws(
      () => store.events(undefined, undefined, 60000, 60000),
      /INVALID_EVENT_WINDOW/,
    );
  } finally {
    store.close();
  }
});


test("owner ensureOwnerIdentity binds channel owner; DA matching owner login auto-links", () => {
  const store = new StreamStore(":memory:");
  try {
    const ownerPerson = store.ensureOwnerIdentity(
      "channel-1",
      "channel-1",
      "Streamer",
      50_000,
    );
    const again = store.ensureOwnerIdentity(
      "channel-1",
      "channel-1",
      "Streamer",
      51_000,
    );
    assert.equal(ownerPerson, again);
    const tip = store.ingest({
      ...donation,
      actor: { externalId: daDonorExternalId("@Streamer"), displayName: "@Streamer" },
      externalId: "donation-owner",
    });
    assert.equal(tip.personId, ownerPerson);
  } finally {
    store.close();
  }
});

test("manual merge undo and split still work after auto-link", () => {
  const store = new StreamStore(":memory:");
  try {
    const twitch = store.ingest(base).personId!;
    const linked = store.ingest(donation).personId!;
    assert.equal(twitch, linked);
    const other = store.ingest({
      ...base,
      externalId: "message-other",
      actor: { externalId: "user-9", displayName: "Other" },
    }).personId!;
    const mergeId = store.merge(
      other,
      twitch,
      store.personRevision(other),
      store.personRevision(twitch),
      80_000,
    );
    assert.equal(store.eventCount(twitch), 3);
    store.undoMerge(mergeId, 90_000);
    assert.equal(store.eventCount(other), 1);
    const detail = store.person(twitch) as {
      identities: { id: string; source: string }[];
    };
    const twitchIdentity = detail.identities.find((i) => i.source === "twitch");
    const daIdentity = detail.identities.find(
      (i) => i.source === "donationalerts",
    );
    assert.ok(twitchIdentity && daIdentity);
    const splitId = store.splitIdentities(
      [String(daIdentity.id)],
      "DA only",
      store.personRevision(twitch),
      100_000,
    );
    assert.notEqual(splitId, twitch);
    assert.equal(store.eventCount(splitId), 1);
  } finally {
    store.close();
  }
});

test("summary uses SQL aggregates and excludes well-known bots from message counts", () => {
  const store = new StreamStore(":memory:");
  try {
    store.ingest(base);
    store.ingest({
      ...base,
      externalId: "bot-msg",
      actor: { externalId: "bot-1", displayName: "Nightbot" },
    });
    store.ingest(donation);
    const raw = store.summary();
    assert.equal(raw.messages, 1);
    assert.equal(raw.donations, 1);
    assert.equal(raw.events, 3);
    assert.ok(Number(raw.excludedBots) >= WELL_KNOWN_TWITCH_BOTS.length);
    const people = store.persons();
    const bot = people.find((p) => p.display_name === "Nightbot");
    assert.equal(bot?.is_bot, 1);
    assert.ok(botExclusionSet(["CustomBot"]).has("custombot"));
    assert.equal(normalizeBotLogin("  @NightBot "), "nightbot");
    assert.equal(isExcludedBot("Nightbot", botExclusionSet()), true);
    assert.equal(isExcludedBot("", botExclusionSet()), false);
    assert.equal(isExcludedBot("human", botExclusionSet()), false);
    assert.ok(botExclusionSet(["", "  "]).has("nightbot"));
  } finally {
    store.close();
  }
});

test("Streamer.bot stub maps Twitch.ChatMessage and dedupes against direct ingest", async () => {
  const store = new StreamStore(":memory:");
  try {
    const adapter = new StreamerBotStubAdapter("channel-1");
    const events: import("../src/domain.js").EventInput[] = [];
    adapter.subscribe((event) => {
      events.push(event);
      store.ingest(event);
    });
    await adapter.start();
    await adapter.inject({
      messageId: "message-1",
      message: "from sb",
      user: { id: "user-1", displayName: "Vasya" },
      timeStamp: "1970-01-01T00:01:00.000Z",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.transport, "streamerbot");
    assert.equal(store.ingest(base).inserted, false);
    assert.equal(
      mapStreamerBotTwitchChatMessage({}, "channel-1", 1),
      null,
    );
    await adapter.stop();
  } finally {
    store.close();
  }
});


test("Streamer.bot stub with client wires Twitch.ChatMessage and ignores bad payloads", async () => {
  const seen: import("../src/domain.js").EventInput[] = [];
  let connected = false;
  let disconnected = false;
  const client = {
    on(
      _event: "Twitch.ChatMessage",
      handler: (data: import("../src/streamerbot.js").StreamerBotTwitchChatMessage) => void,
    ) {
      Promise.resolve().then(() => {
        handler({});
        handler({
          messageId: "live-1",
          message: { text: "hi" },
          user: { id: "9", displayName: "X" },
          timeStamp: Date.now(),
        });
      });
    },
    async connect() {
      connected = true;
    },
    async disconnect() {
      disconnected = true;
    },
  };
  const adapter = new StreamerBotStubAdapter("channel-1", client);
  adapter.subscribe((event) => {
    seen.push(event);
  });
  await adapter.start();
  await adapter.start(); // idempotent
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(connected, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.payload.text, "hi");
  await adapter.stop();
  assert.equal(disconnected, true);
  assert.equal(
    mapStreamerBotTwitchChatMessage(
      { messageId: "t", userId: "1", message: "plain", timeStamp: "not-a-date" },
      "channel-1",
      1,
    )?.timeQuality,
    "unknown",
  );
});

test("personStats aggregates donations, messages, observed minutes and cross-session averages", () => {
  const store = new StreamStore(":memory:");
  try {
    const session = store.startSession(
      "channel-1",
      "stream-stats",
      60_000,
      "platform",
      60_000,
    );
    const person = store.ingest(base).personId!;
    store.ingest({
      ...donation,
      externalId: "donation-stats",
      actor: { externalId: daDonorExternalId("Vasya"), displayName: "Vasya" },
      occurredAtMs: 90_000,
      timeQuality: "configured",
      sourceTime: "1970-01-01T00:01:30Z",
      payload: { amountMinor: "5000", currency: "RUB" },
    });
    store.recordPoll(session, "channel-1", {
      startedAtMs: 60_000,
      completedAtMs: 61_000,
      status: "complete",
      userIds: ["user-1"],
    });
    store.recordPoll(session, "channel-1", {
      startedAtMs: 120_000,
      completedAtMs: 121_000,
      status: "complete",
      userIds: ["user-1"],
    });
    store.endSession(session, 180_000);
    const stats = store.personStats(person, session) as {
      messageCount: number;
      donationCount: number;
      donationTotals: Record<string, string>;
      observedMinutesThisSession: number;
      firstObservedMs: number | null;
      lastObservedMs: number | null;
      avgObservedMinutes: number | null;
      sessionsWithObservation: number;
    };
    assert.equal(stats.messageCount, 1);
    assert.equal(stats.donationCount, 1);
    assert.equal(stats.donationTotals.RUB, "5000");
    assert.equal(stats.observedMinutesThisSession, 2);
    assert.equal(stats.firstObservedMs, 60_000);
    assert.equal(stats.lastObservedMs, 120_000);
    assert.equal(stats.sessionsWithObservation, 1);
    assert.equal(stats.avgObservedMinutes, 2);
    assert.throws(() => store.personStats("missing"), /PERSON_NOT_FOUND/);
  } finally {
    store.close();
  }
});

test("summary session analytics expose coverage, msgs/min and chatters series", () => {
  const store = new StreamStore(":memory:");
  try {
    const session = store.startSession(
      "channel-1",
      "stream-analytics",
      60_000,
      "platform",
      60_000,
    );
    store.ingest(base);
    store.ingest({
      ...base,
      externalId: "message-2",
      occurredAtMs: 90_000,
      actor: { externalId: "user-2", displayName: "Petya" },
    });
    store.recordPoll(session, "channel-1", {
      startedAtMs: 60_000,
      completedAtMs: 61_000,
      status: "complete",
      userIds: ["user-1", "user-2"],
    });
    store.gap("twitch", "test-gap", 60_000, 90_000);
    store.endSession(session, 180_000);
    const raw = store.summary(session) as {
      messages: number;
      messagesPerMinuteOfSession: number | null;
      uniquePersons: number;
      uniquePersonsObserved: number | null;
      coverage: { knownMinutes: number; totalMinutes: number; ratio: number | null };
      chattersOverTime: { atMs: number; chatters: number }[];
      gapCount: number;
    };
    assert.equal(raw.messages, 2);
    assert.ok(raw.messagesPerMinuteOfSession !== null);
    assert.equal(raw.uniquePersons, 2);
    assert.equal(raw.uniquePersonsObserved, 2);
    assert.equal(raw.coverage.knownMinutes, 1);
    assert.equal(raw.coverage.totalMinutes, 2);
    assert.equal(raw.chattersOverTime.length, 1);
    assert.equal(raw.chattersOverTime[0]!.chatters, 2);
    assert.equal(raw.gapCount, 1);
  } finally {
    store.close();
  }
});

test("personsTop ranks by messages, donations and observed minutes for a session", () => {
  const store = new StreamStore(":memory:");
  try {
    const session = store.startSession(
      "channel-1",
      "stream-tops",
      60_000,
      "platform",
      60_000,
    );
    const a = store.ingest(base).personId!;
    store.ingest({
      ...base,
      externalId: "message-a2",
      occurredAtMs: 70_000,
    });
    const b = store.ingest({
      ...base,
      externalId: "message-b",
      occurredAtMs: 80_000,
      actor: { externalId: "user-2", displayName: "Petya" },
    }).personId!;
    store.ingest({
      ...donation,
      externalId: "donation-b",
      actor: { externalId: daDonorExternalId("Petya"), displayName: "Petya" },
      occurredAtMs: 85_000,
      timeQuality: "configured",
      sourceTime: "1970-01-01T00:01:25Z",
      payload: { amountMinor: "1000", currency: "USD" },
    });
    store.recordPoll(session, "channel-1", {
      startedAtMs: 60_000,
      completedAtMs: 120_000,
      status: "complete",
      userIds: ["user-2"],
    });
    store.endSession(session, 180_000);
    const byMessages = store.personsTop("messages", session);
    assert.equal(byMessages[0]!.id, a);
    assert.equal(byMessages[0]!.messageCount, 2);
    const byDonations = store.personsTop("donations", session);
    assert.equal(byDonations[0]!.id, b);
    assert.equal(byDonations[0]!.donationCount, 1);
    const byObserved = store.personsTop("observed_minutes", session);
    assert.equal(byObserved[0]!.id, b);
    assert.ok((byObserved[0]!.observedMinutes as number) >= 1);
  } finally {
    store.close();
  }
});

test("insights detectors surface first-timers, silent presence, donors without twitch and coverage", () => {
  const store = new StreamStore(":memory:");
  try {
    const old = store.startSession(
      "channel-1",
      "old-stream",
      60_000,
      "platform",
      60_000,
    );
    store.ingest(base);
    store.endSession(old, 120_000);

    const session = store.startSession(
      "channel-1",
      "new-stream",
      1_300_000_000_000, // far future so returning gap is large vs old session
      "platform",
      1_300_000_000_000,
    );
    // Silent presence: observed, no messages
    store.recordPoll(session, "channel-1", {
      startedAtMs: 1_300_000_000_000,
      completedAtMs: 1_300_000_600_000,
      status: "complete",
      userIds: ["silent-1"],
    });
    // Donor without twitch
    store.ingest({
      ...donation,
      externalId: "donation-only",
      actor: { externalId: daDonorExternalId("OnlyDA"), displayName: "OnlyDA" },
      occurredAtMs: 1_300_000_100_000,
      timeQuality: "configured",
      sourceTime: "2011-03-13T07:06:40Z",
      payload: { amountMinor: "2500", currency: "RUB" },
    });
    // First-timer chatter
    store.ingest({
      ...base,
      externalId: "newbie-msg",
      occurredAtMs: 1_300_000_120_000,
      actor: { externalId: "newbie-1", displayName: "Newbie" },
    });
    store.gap("twitch", "disconnect", 1_300_000_000_000, null);
    store.endSession(session, 1_300_001_200_000);

    const cards = store.insights(session) as {
      kind: string;
      personId: string | null;
    }[];
    const kinds = new Set(cards.map((c) => c.kind));
    assert.ok(kinds.has("silent_presence"));
    assert.ok(kinds.has("donor_no_twitch"));
    assert.ok(kinds.has("first_timer"));
    assert.ok(kinds.has("collection_gaps"));
    assert.ok(kinds.has("coverage_hole") || kinds.has("collection_gaps"));
  } finally {
    store.close();
  }
});

test("personsTop all-time observed minutes and invalid sort; insights chatty/regular/returning", () => {
  const store = new StreamStore(":memory:");
  try {
    assert.throws(() => store.personsTop("nope" as "messages"), /INVALID_SORT/);

    // Three sessions with the same chatter present >=5 min each → regular
    const personLogin = "regular-1";
    let personId = "";
    for (let s = 0; s < 3; s++) {
      const start = (s + 1) * 10_000_000;
      const session = store.startSession(
        "channel-1",
        `regular-stream-${s}`,
        start,
        "platform",
        start,
      );
      store.recordPoll(session, "channel-1", {
        startedAtMs: start,
        completedAtMs: start + 6 * 60_000,
        status: "complete",
        userIds: [personLogin],
      });
      if (!personId) {
        const people = store.persons() as { id: string; display_name: string }[];
        personId = String(
          people.find((p) => p.display_name === personLogin || p.id)?.id,
        );
        // resolve via presence identity
        const detail = store.persons() as { id: string; display_name: string }[];
        const hit = detail.find((p) => p.display_name === personLogin);
        personId = String(hit!.id);
      }
      store.endSession(session, start + 10 * 60_000);
    }

    const allTimeObserved = store.personsTop("observed_minutes");
    assert.ok(allTimeObserved.length >= 1);
    assert.ok((allTimeObserved[0]!.observedMinutes as number) >= 5);

    // Chatty absent + returning after gap on a new session
    const oldStart = 60_000;
    const old = store.startSession(
      "channel-1",
      "gap-old",
      oldStart,
      "platform",
      oldStart,
    );
    store.ingest({
      ...base,
      externalId: "old-chatty",
      occurredAtMs: oldStart + 1000,
      actor: { externalId: "chatty-1", displayName: "Chatty" },
    });
    store.endSession(old, oldStart + 120_000);

    const newStart = oldStart + 20 * 86_400_000; // 20 days later
    const neu = store.startSession(
      "channel-1",
      "gap-new",
      newStart,
      "platform",
      newStart,
    );
    for (let i = 0; i < 5; i++) {
      store.ingest({
        ...base,
        externalId: `chatty-msg-${i}`,
        occurredAtMs: newStart + 1000 + i * 1000,
        actor: { externalId: "chatty-1", displayName: "Chatty" },
      });
    }
    // No presence for chatty → chatty_absent; prior activity → returning_after_gap
    store.endSession(neu, newStart + 180_000);

    const cards = store.insights(neu) as { kind: string }[];
    const kinds = new Set(cards.map((c) => c.kind));
    assert.ok(kinds.has("chatty_absent"));
    assert.ok(kinds.has("returning_after_gap"));
    assert.ok(kinds.has("regular"));

    // summary without session still exposes gapCount
    store.gap("twitch", "x", 1, 2);
    const allSummary = store.summary() as { gapCount: number };
    assert.ok(allSummary.gapCount >= 1);

    // donations top without session
    store.ingest({
      ...donation,
      externalId: "top-don",
      actor: { externalId: daDonorExternalId("Chatty"), displayName: "Chatty" },
      occurredAtMs: newStart + 5000,
      timeQuality: "configured",
      sourceTime: "x",
      payload: { amountMinor: "999", currency: "EUR" },
    });
    const byDon = store.personsTop("donations");
    assert.ok(byDon.some((r) => (r.donationCount as number) >= 1));

    // personStats without session
    const chatty = (store.persons() as { id: string; display_name: string }[]).find(
      (p) => p.display_name === "Chatty",
    )!;
    const stats = store.personStats(chatty.id) as {
      observedMinutesThisSession: null;
      firstObservedMs: number | null;
    };
    assert.equal(stats.observedMinutesThisSession, null);
  } finally {
    store.close();
  }
});

test("pollCoveredMinutes clips to from/to and rejects inverted windows", () => {
  assert.deepEqual(pollCoveredMinutes(60_000, 180_000, 120_000, 180_000), [
    120_000,
  ]);
  assert.deepEqual(pollCoveredMinutes(0, 60_000), [0, 60_000]);
  assert.throws(() => pollCoveredMinutes(120_000, 60_000), /INVALID_POLL_WINDOW/);
});

test("insights empty without sessions; sessionCoverage ratio null on zero window", () => {
  const store = new StreamStore(":memory:");
  try {
    assert.deepEqual(store.insights(), []);
    const session = store.startSession(
      "channel-1",
      "instant",
      60_000,
      "platform",
      60_000,
    );
    // ended at same minute boundary stretch with zero duration minutes after ceil/floor?
    store.endSession(session, 60_000);
    const summary = store.summary(session) as {
      coverage: { totalMinutes: number; ratio: number | null };
      messagesPerMinuteOfSession: number | null;
      sessionDurationMs: number | null;
    };
    assert.equal(summary.sessionDurationMs, 0);
    assert.equal(summary.messagesPerMinuteOfSession, null);
    // tops with limit bounds
    assert.equal(store.personsTop("messages", undefined, [], 0).length, 0);
    const capped = store.personsTop("messages", undefined, [], 999);
    assert.ok(capped.length <= 100);
  } finally {
    store.close();
  }
});
