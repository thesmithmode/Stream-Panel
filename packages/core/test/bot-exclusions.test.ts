import test from "node:test";
import assert from "node:assert/strict";
import { botExclusionSet, isExcludedBot, normalizeBotLogin } from "../src/bots.js";
import { StreamStore } from "../src/store.js";

test("known bot aliases are excluded from metrics while raw events remain stored", () => {
  const exclusions = botExclusionSet(["CustomBot"]);

  assert.equal(normalizeBotLogin("  @ＦＲＡＮＫＩＥ＿ＳＨＯＷＭＡＮ  "), "frankie_showman");
  assert.equal(isExcludedBot("@FRANKIE_SHOWMAN", exclusions), true);
  assert.equal(isExcludedBot("CustomBot", exclusions), true);
  assert.equal(isExcludedBot("RegularViewer", exclusions), false);

  const store = new StreamStore(":memory:");
  const fromMs = Date.UTC(2026, 9, 1, 12);
  try {
    store.startSession("channel", "bot-exclusion", fromMs, "platform", fromMs);
    for (const [externalId, displayName] of [
      ["bot-message", "Frankie_Showman"],
      ["viewer-message", "RegularViewer"],
    ] as const) {
      store.ingest({
        source: "twitch",
        accountId: "channel",
        externalId,
        type: "chat.message",
        actor: { externalId: displayName, displayName },
        occurredAtMs: fromMs + 60_000,
        receivedAtMs: fromMs + 60_000,
        sourceTime: null,
        timeQuality: "provider",
        transport: "eventsub",
        payload: { text: "hello" },
      });
    }

    const summary = store.summary();
    const analytics = store.analytics({
      fromMs,
      toMs: fromMs + 10 * 60_000,
      minSessions: 1,
      minMinutes: 0,
      minMessages: 1,
    });

    assert.equal(store.eventCount(), 2);
    assert.equal(summary.events, 2);
    assert.equal(summary.messages, 1);
    assert.deepEqual(analytics.audience.map((entry) => entry.name), ["RegularViewer"]);
  } finally {
    store.close();
  }
});
