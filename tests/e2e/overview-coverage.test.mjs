import test from "node:test";
import assert from "node:assert/strict";
import { application, seed } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto, reload } from "../helpers/browser-coverage.mjs";

test("Overview insights render loading, empty, error and person paths; close on Escape and outside click", { timeout: 60000 }, async () => {
  const app = await application();
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requestCount = 0;
    let personId = "";
    const insightUrls = [];
    await page.route("**/api/v1/status", (route) => route.fulfill({ json: {
      twitch: { state: "error", detail: "" },
      donationalerts: { state: "connected", detail: "" },
      device: null,
      config: {},
      csrf: "fixture-csrf",
      gaps: [],
    } }));
    await page.route("**/api/v1/insights**", async (route) => {
      requestCount++;
      insightUrls.push(route.request().url());
      if (requestCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ json: [] });
      } else if (requestCount === 2) {
        await route.fulfill({ status: 500, json: { error: "INSIGHTS_UNAVAILABLE" } });
      } else {
        await route.fulfill({
          json: [{ kind: "person", title: "Активный участник", detail: "Тестовый паттерн", personId, sessionId: null, metrics: {} }],
        });
      }
    });

    const sessionId = await seed(app);
    const persons = await app.db.call("persons");
    personId = persons.find((person) => person.display_name === "Тестовый зритель")?.id;
    assert.ok(personId);
    await startCoverage(page);
    await goto(page, app.bootstrap());

    await page.getByRole("button", { name: "Обзор", exact: true }).waitFor();
    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    await page.getByRole("button", { name: "Открыть", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Показать паттерны", exact: true });
    await trigger.click();
    const insightDialog = page.getByRole("dialog", { name: "Инсайты" });
    await page.getByText("Считаем…", { exact: true }).waitFor();
    await page.getByText("Пока нет заметных паттернов по текущим данным.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await insightDialog.count(), 0);

    await page.getByRole("button", { name: "Показать паттерны", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "INSIGHTS_UNAVAILABLE" }).waitFor();
    await page.getByRole("heading", { name: /Аудитория в чате/ }).click();
    assert.equal(await insightDialog.count(), 0);

    await reload(page);
    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    await page.getByRole("button", { name: "Открыть", exact: true }).click();
    await page.getByRole("button", { name: "Показать паттерны", exact: true }).click();
    await page.getByText("Активный участник", { exact: true }).waitFor();
    assert.match(insightUrls[2], new RegExp(`[?&]session=${sessionId}$`));
    await page.getByRole("button", { name: "Открыть человека", exact: true }).click();
    await page.getByRole("heading", { name: "Тестовый зритель", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Инсайты" }).count(), 0);
    assert.deepEqual(errors, []);

    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await app.close();
  }
});
