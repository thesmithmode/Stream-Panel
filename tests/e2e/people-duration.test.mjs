import test from "node:test";
import assert from "node:assert/strict";
import { application } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto } from "../helpers/browser-coverage.mjs";
import { formatDuration } from "../../apps/web/src/duration.ts";

const minute = 60_000;

test("People duration cards render the period and average observations as hours", { timeout: 60_000 }, async () => {
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
    const personRow = page.locator(".person-row").filter({ hasText: "Duration Viewer" });
    await personRow.waitFor();
    await personRow.click();
    await page.getByLabel("Показатели человека").waitFor();
    assert.equal(await page.getByText("Наблюдаемое время", {exact:true}).locator("..").locator("strong").textContent(), "2 ч");
    assert.equal(await page.getByText("Посещаемость", {exact:true}).locator("..").locator("strong").textContent(), "100%");
    assert.deepEqual(await page.getByLabel("Период аналитики").locator("option").allTextContents(), ["Вся история", "Последние 7 дней", "Последние 30 дней"]);
    await page.getByLabel("Период аналитики").selectOption("7");
    await personRow.click();
    await page.getByLabel("Показатели человека").waitFor();

    const person = await page.evaluate(() =>
      fetch("/api/v1/persons").then((response) => response.json()).then((rows) =>
        rows.find((row) => row.display_name === "Duration Viewer"),
      ),
    );
    const stats = await page.evaluate(async ({ personId }) => {
      const response = await fetch(
        `/api/v1/persons/${encodeURIComponent(personId)}/stats?period=7`,
      );
      return response.json();
    }, { personId: person.id });
    assert.equal(stats.totalObservedMinutes, 120);
    assert.equal(stats.avgObservedMinutes, 120);

    const rendered = await page.getByLabel("Показатели человека").locator(".kpi").evaluateAll((cards) =>
      Object.fromEntries(cards.map((card) => [
        card.querySelector("span")?.textContent?.trim(),
        card.querySelector("strong")?.textContent?.trim(),
      ])),
    );
    assert.equal(rendered["Наблюдаемое время"], formatDuration(stats.totalObservedMinutes));
    assert.equal(rendered["Среднее за посещённый стрим"], formatDuration(stats.avgObservedMinutes));
    assert.equal(rendered["Наблюдаемое время"], "2 ч");
    assert.equal(rendered["Среднее за посещённый стрим"], "2 ч");

    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await app.close();
  }
});
