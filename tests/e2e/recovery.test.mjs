import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../../dist/apps/daemon/src/server.js";
import { application, seed } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import {
  startCoverage,
  saveCoverage,
  goto,
  reload,
} from "../helpers/browser-coverage.mjs";
test(
  "browser conflict, failed worker and daemon restart retain data and require a fresh bootstrap",
  { timeout: 45000 },
  async () => {
    const a = await application(),
      browser = await launchBrowser();
    let restarted;
    try {
      const context = await browser.newContext(),
        page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(12000);
      page.on("pageerror", (e) => errors.push(e.message));
      await startCoverage(page);
      await goto(page, a.bootstrap());
      await page
        .getByRole("button", { name: "Открыть интеграции", exact: true })
        .waitFor();
      const sessionId = await a.db.call(
        "startSession",
        "test-channel",
        "outside-ui",
        Date.now() - 600000,
        "platform",
        Date.now(),
      );
      assert.equal(await page.locator(".record-button").count(), 0);
      assert.equal(await page.getByRole("button", { name: /запись/i }).count(), 0);
      await seed(a);
      await a.db.stop();
      await page
        .getByRole("alert")
        .filter({ hasText: "DB_WORKER_STOPPED" })
        .waitFor();
      await reload(page);
      await page
        .getByRole("heading", { name: "Вход в Stream Panel" })
        .waitFor();
      await page.getByText("DB_WORKER_STOPPED", { exact: true }).waitFor();
      await a.app.close();
      const port = Number(new URL(a.origin).port);
      restarted = await createApplication(a.dir, port, false);
      await restarted.app.listen({ host: "127.0.0.1", port });
      await reload(page);
      await page.getByText("Войдите в свой профиль", { exact: true }).waitFor();
      await goto(page, restarted.bootstrap());
      assert.equal(await page.locator(".record-button").count(), 0);
      assert.equal(await page.getByRole("button", { name: /запись/i }).count(), 0);
      const summary = await page.evaluate(() =>
        fetch("/api/v1/summary").then((r) => r.json()),
      );
      assert.equal(summary.messages, 8);
      assert.equal(summary.donations, 1);
      assert.equal(summary.totals.RUB, "25000");
      const sessions = await restarted.db.call("sessions");
      const recoveredSession = sessions.find((session) => session.id === sessionId);
      assert.ok(recoveredSession);
      assert.equal(recoveredSession.ended_at_ms, null);
      await restarted.db.call("endSession", recoveredSession.id, Date.now(), "observed");
      assert.notEqual(
        (await restarted.db.call("sessions")).find((session) => session.id === recoveredSession.id).ended_at_ms,
        null,
      );
      assert.deepEqual(errors, []);
      await saveCoverage(page);
      await context.close();
    } finally {
      await browser.close();
      if (restarted) await restarted.app.close();
      await a.close();
    }
  },
);
