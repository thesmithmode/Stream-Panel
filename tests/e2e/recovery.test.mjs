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
      await a.db.call(
        "startSession",
        "local",
        "outside-ui",
        Date.now() - 600000,
        "manual",
        Date.now(),
      );
      await page
        .getByRole("button", { name: "Начать запись", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "SESSION_ALREADY_OPEN" })
        .waitFor();
      await seed(a);
      await page
        .getByRole("button", { name: "Завершить запись", exact: true })
        .waitFor();
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
      await page
        .getByRole("button", { name: "Завершить запись", exact: true })
        .waitFor();
      const summary = await page.evaluate(() =>
        fetch("/api/v1/summary").then((r) => r.json()),
      );
      assert.equal(summary.messages, 8);
      assert.equal(summary.donations, 1);
      assert.equal(summary.totals.RUB, "25000");
      await page
        .getByRole("button", { name: "Завершить запись", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Начать запись", exact: true })
        .waitFor();
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
