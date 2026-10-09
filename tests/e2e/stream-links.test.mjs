import test from "node:test";
import assert from "node:assert/strict";
import { application } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto } from "../helpers/browser-coverage.mjs";

test("stream history shows only confirmed Twitch and YouTube links from the platform ledger", { timeout: 60000 }, async () => {
  const a = await application();
  let browser;
  try {
    const now = Date.now(), base = now - 120000;
    const bothId = await a.db.call("observePlatformStream", "twitch", "twitch-channel", "twitch-stream", base, base + 60000, "https://www.twitch.tv/channel", "Combined platform stream");
    assert.ok(bothId);
    assert.equal(await a.db.call("observePlatformStream", "youtube", "youtube-channel", "combined-video", base + 30000, base + 61000, "https://www.youtube.com/watch?v=combined-video", "Combined platform stream"), bothId);
    await a.db.call("endSession", bothId, base + 90000, "observed");

    const youtubeOnlyId = await a.db.call("observePlatformStream", "youtube", "youtube-only-channel", "youtube-only-video", base + 120000, base + 180000, "https://www.youtube.com/watch?v=youtube-only-video", "YouTube only stream");
    assert.ok(youtubeOnlyId);
    await a.db.call("endSession", youtubeOnlyId, base + 200000, "observed");

    const legacyId = await a.db.call("startSession", "legacy-channel", "legacy-platform-stream", base + 210000, "platform", base + 210000);
    await a.db.call("endSession", legacyId, base + 220000, "observed");
    const manualId = await a.db.call("startSession", "manual-channel", "manual-session", base + 230000, "manual", base + 230000);
    await a.db.call("endSession", manualId, base + 240000, "manual");

    browser = await launchBrowser();
    const context = await browser.newContext(), page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await startCoverage(page);
    await goto(page, a.bootstrap());
    await page.getByRole("button", { name: "Открыть интеграции", exact: true }).waitFor();
    const sessions = await page.evaluate(() => fetch("/api/v1/sessions").then(response => response.json()));
    const combined = sessions.find(session => session.id === bothId);
    assert.deepEqual(combined.platforms, ["twitch", "youtube"]);
    assert.equal(combined.primaryTitle, "Combined platform stream");
    assert.deepEqual(combined.confirmedUrls, [
      { platform: "twitch", url: "https://www.twitch.tv/channel" },
      { platform: "youtube", url: "https://www.youtube.com/watch?v=combined-video" },
    ]);
    const youtubeOnly = sessions.find(session => session.id === youtubeOnlyId);
    assert.deepEqual(youtubeOnly.platforms, ["youtube"]);
    assert.deepEqual(youtubeOnly.confirmedUrls, [{ platform: "youtube", url: "https://www.youtube.com/watch?v=youtube-only-video" }]);
    const legacy = sessions.find(session => session.id === legacyId);
    assert.deepEqual(legacy.platforms, ["twitch"]);
    assert.deepEqual(legacy.confirmedUrls, []);
    const manual = sessions.find(session => session.id === manualId);
    assert.deepEqual(manual.platforms, []);
    assert.deepEqual(manual.confirmedUrls, []);

    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    const bothRow = page.locator("tbody tr").filter({ hasText: "Combined platform stream" });
    assert.equal(await bothRow.locator(".platform-labels").textContent(), "Twitch, YouTube");
    for (const [label, url] of [["Twitch", "https://www.twitch.tv/channel"], ["YouTube", "https://www.youtube.com/watch?v=combined-video"]]) {
      const link = bothRow.getByRole("link", { name: label, exact: true });
      assert.equal(await link.getAttribute("href"), url);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    }
    const youtubeRow = page.locator("tbody tr").filter({ hasText: "YouTube only stream" });
    assert.equal(await youtubeRow.getByRole("link", { name: "YouTube", exact: true }).count(), 1);
    assert.equal(await youtubeRow.getByRole("link", { name: "Twitch", exact: true }).count(), 0);
    const legacyRow = page.locator(`tbody tr[data-session-id="${legacyId}"]`);
    assert.equal(await legacyRow.getByRole("link").count(), 0);
    const manualRow = page.locator(`tbody tr[data-session-id="${manualId}"]`);
    assert.equal(await manualRow.locator(".platform-labels").textContent(), "Источник неизвестен");
    assert.equal(await manualRow.getByRole("link").count(), 0);
    assert.equal(await bothRow.getByRole("button",{name:"Удалить",exact:true}).count(),0);
    await manualRow.getByRole("button",{name:"Удалить",exact:true}).click();
    await manualRow.waitFor({state:"detached"});
    assert.equal((await a.db.call("sessions")).some(s=>s.id===manualId),false);
    assert.equal((await a.db.call("sessions")).some(s=>s.id===bothId),true);
    assert.deepEqual(errors, []);
    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await a.close();
  }
});
