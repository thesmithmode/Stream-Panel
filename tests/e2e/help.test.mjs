import test from "node:test";
import assert from "node:assert/strict";
import { application, seed } from "../helpers/application.mjs";
import { launchBrowser } from "../helpers/browser.mjs";
import { startCoverage, saveCoverage, goto, reload } from "../helpers/browser-coverage.mjs";

test("presence help popover supports click, Escape, outside click, and mobile viewport", { timeout: 60000 }, async () => {
  const a = await application();
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await startCoverage(page);
    await goto(page, a.bootstrap());
    await page.getByRole("button", { name: "Открыть интеграции", exact: true }).waitFor();
    await seed(a);
    await reload(page);
    await page.getByRole("button",{name:"Стримы",exact:true}).click();await page.getByRole("button",{name:"Открыть",exact:true}).click();

    const trigger = page.getByRole("button", { name: "Об аудитории стрима" });
    const popover = page.getByRole("dialog", { name: "Об аудитории стрима" });
    await trigger.click();
    await assertPopover(trigger, popover, true);
    assert.match(await popover.textContent(), /не подтверждение просмотра видео/);
    await page.keyboard.press("Escape");
    await assertPopover(trigger, popover, false);

    await trigger.click();
    await popover.waitFor();
    await page.getByRole("heading", { name: "Стрим", exact: true }).click();
    await assertPopover(trigger, popover, false);

    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    const box = await popover.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `popover horizontal bounds ${JSON.stringify(box)}`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844, `popover vertical bounds ${JSON.stringify(box)}`);
    await assertPopover(trigger, popover, true);
    assert.deepEqual(errors, []);

    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await a.close();
  }
});

async function assertPopover(trigger, popover, expectedOpen) {
  assert.equal(await trigger.getAttribute("aria-expanded"), String(expectedOpen));
  assert.equal(await popover.count(), expectedOpen ? 1 : 0);
}
