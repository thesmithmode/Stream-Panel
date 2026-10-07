import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { moneyToMinor, candidateKey, matchKey, type EventInput } from "../src/domain.js";
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
import { presenceMinutes } from "../src/presence.js";
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
  actor: { externalId: "donation-1", displayName: "Vasya" },
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
      actor: { externalId: "donation-2", displayName: "Vasya" },
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
      actor: { externalId: "donation-twin", displayName: "Twin" },
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
      /DA_ACTOR/,
    );
    assert.equal(matchKey("@Vasya"), "vasya");
    assert.equal(matchKey("#Vasya"), "vasya");
    assert.notEqual(candidateKey("@Vasya"), candidateKey("Vasya"));
  } finally {
    store.close();
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
      actor: { externalId: "donation-1", displayName: "OtherNick" },
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
      actor: { externalId: "donation-1", displayName: "OtherNick" },
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
        actor: { externalId: "donation-1", displayName: "OtherNick" },
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
      actor: { externalId: "known", displayName: "Vasya" },
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
      actor: { externalId: "second", displayName: "Vasya" },
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
      actor: { externalId: "donation-owner", displayName: "@Streamer" },
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
