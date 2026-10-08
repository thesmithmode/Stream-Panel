import test from "node:test";
import assert from "node:assert/strict";
import { application } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto } from "../helpers/browser-coverage.mjs";
import { formatDuration } from "../../apps/web/src/duration.ts";

const minute = 60_000;

test("People duration cards render the session and average observations as hours", { timeout: 60_000 }, async () => {
  const app = await application();
  let browser;
  try {
    browser = await launchBrowser();
    const endedAt = Math.floor((Date.now() - minute) / minute) * minute;
    const startedAt = endedAt - 120 * minute;
    const sessionId = await app.db.call(
      "startSession",
      "test-channel",
      "duration-fixture",
      startedAt,
      "platform",
      startedAt,
    );
    await app.db.call("ingest", {
      source: "twitch",
      accountId: "test-channel",
      externalId: "duration-fixture-message",
      type: "chat.message",
      actor: { externalId: "duration-viewer", displayName: "Duration Viewer" },
      occurredAtMs: startedAt + minute,
      receivedAtMs: startedAt + minute,
      sourceTime: null,
      timeQuality: "provider",
      transport: "eventsub",
      payload: { text: "fixture" },
    });
    await app.db.call("recordPoll", sessionId, "test-channel", {
      startedAtMs: startedAt,
      completedAtMs: endedAt,
      status: "complete",
      userIds: ["duration-viewer"],
    });
    await app.db.call("endSession", sessionId, endedAt, "observed");

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await startCoverage(page);
    await goto(page, app.bootstrap());
    await page.getByRole("button", { name: "Люди", exact: true }).waitFor();
    await page.getByRole("button", { name: "Люди", exact: true }).click();
    await page.getByRole("button", { name: "Duration Viewer", exact: true }).waitFor();
    await page.getByLabel("Период аналитики").selectOption(sessionId);
    await page.getByRole("button", { name: "Duration Viewer", exact: true }).click();
    await page.getByLabel("Показатели человека").waitFor();

    const person = await page.evaluate(() =>
      fetch("/api/v1/persons").then((response) => response.json()).then((rows) =>
        rows.find((row) => row.display_name === "Duration Viewer"),
      ),
    );
    const stats = await page.evaluate(async ({ personId, selectedSession }) => {
      const response = await fetch(
        `/api/v1/persons/${encodeURIComponent(personId)}/stats?session=${encodeURIComponent(selectedSession)}`,
      );
      return response.json();
    }, { personId: person.id, selectedSession: sessionId });
    assert.equal(stats.observedMinutesThisSession, 120);
    assert.equal(stats.avgObservedMinutes, 120);

    const rendered = await page.getByLabel("Показатели человека").locator(".kpi").evaluateAll((cards) =>
      Object.fromEntries(cards.map((card) => [
        card.querySelector("span")?.textContent?.trim(),
        card.querySelector("strong")?.textContent?.trim(),
      ])),
    );
    assert.equal(rendered["Набл. минуты (сессия)"], formatDuration(stats.observedMinutesThisSession));
    assert.equal(rendered["Сред. набл. мин / сессия"], formatDuration(stats.avgObservedMinutes));
    assert.equal(rendered["Набл. минуты (сессия)"], "2 ч");
    assert.equal(rendered["Сред. набл. мин / сессия"], "2 ч");

    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await app.close();
  }
});
