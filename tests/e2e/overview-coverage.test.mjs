import test from "node:test";
import assert from "node:assert/strict";
import { application, seed } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto, reload } from "../helpers/browser-coverage.mjs";

test("Overview insights render loading, empty, error and person paths; expand inline and cache until navigation", { timeout: 60000 }, async () => {
  const app = await application();
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requestCount = 0,releaseInitial;
    const initialLoading=new Promise(resolve=>{releaseInitial=resolve;});
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
        await initialLoading;
        await route.fulfill({ json: {preparing:true,comparisonToMs:12345} });
      } else if(requestCount===2){
        await route.fulfill({json:{insights:[]}});
      } else if (requestCount === 3) {
        await route.fulfill({ status: 500, json: { error: "INSIGHTS_UNAVAILABLE" } });
      } else {
        await route.fulfill({
          json: {insights:[{ id:"person",kind: "person",group:"people",title: "Активный участник", detail: "Тестовый паттерн", personId,basis:"Четыре эфира",action:"Посмотри историю",sampleSize:4,evidence:[] }]},
        });
      }
    });

    const sessionId = await seed(app);
    const persons = await app.db.call("persons");
    personId = persons.find((person) => person.display_name === "Тестовый зритель")?.id;
    assert.ok(personId);
    await startCoverage(page);
    await goto(page, app.bootstrap());

    await page.getByRole("button", { name: "Стримы", exact: true }).waitFor();
    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    await page.locator('.stream-open').click();
    const trigger = page.getByRole("button", { name: "Инсайты", exact: true });
    await trigger.click();
    const insightDialog = page.locator(".insight-body");
    await page.locator(".insight-body").getByText("Ищем закономерности…", { exact: true }).waitFor();releaseInitial();
    await page.getByText("Заметных особенностей этого эфира пока не найдено.", { exact: true }).waitFor();
    await page.locator(".insights-section").getByRole("button",{name:"Инсайты",exact:true}).click();
    assert.equal(await insightDialog.count(), 0);

    await reload(page);
    await page.getByRole("button", { name: "Инсайты", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "INSIGHTS_UNAVAILABLE" }).waitFor();
    await page.locator(".insights-section").getByRole("button",{name:"Инсайты",exact:true}).click();
    assert.equal(await insightDialog.count(), 0);

    await reload(page);
    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    await page.locator('.stream-open').click();
    await page.getByRole("button", { name: "Инсайты", exact: true }).click();
    await page.getByText("Активный участник", { exact: true }).waitFor();
    assert.equal(new URL(insightUrls[1]).searchParams.get('to'),'12345');
    assert.match(insightUrls[3], new RegExp(`[?&]session=${sessionId}$`));
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
