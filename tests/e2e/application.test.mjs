import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser } from "../helpers/browser.mjs";
import {
  startCoverage,
  saveCoverage,
  goto,
  reload,
} from "../helpers/browser-coverage.mjs";
import { application, seed } from "../helpers/application.mjs";
test(
  "real browser: recording, person attribution, alias search, minute grid, backup and responsive navigation",
  { timeout: 60000 },
  async () => {
    const a = await application();
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext({
          viewport: { width: 1536, height: 1024 },
        }),
        page = await context.newPage(),
        errors = [],
        checks = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await startCoverage(page);
      await goto(page, a.bootstrap());
      await page
        .getByRole("button", { name: "Открыть интеграции", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).hash, "");
      await page.getByRole("button", { name: "Демо", exact: true }).click();
      await page.getByText("Алиса").first().waitFor({ state: "visible", timeout: 5000 });
      await page.getByRole("button", { name: "Реальные", exact: true }).click();
      checks.push("bootstrap exchanges nonce and removes fragment");

      await page
        .getByRole("button", { name: "Открыть интеграции", exact: true })
        .click();
      await page.getByLabel("Client secret", { exact: true }).waitFor();
      checks.push("empty-state CTA opens real connection forms");
      await page.getByRole("button", { name: "Обзор", exact: true }).click();
      await page
        .getByRole("button", { name: "Начать запись", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Завершить запись", exact: true })
        .waitFor();
      checks.push("start manual recording");
      await seed(a);
      await reload(page);
      await page
        .getByText("Нет данных", { exact: true })
        .waitFor({ state: "hidden" });
      const persons = await page.evaluate(() =>
        fetch("/api/v1/persons").then((r) => r.json()),
      );
      assert.equal(persons.length, 3);
      checks.push(
        "reload preserves cookie; distinct Twitch/DA names stay separate until merge (auto-link covered in unit tests)",
      );

      await page.getByRole("button", { name: "Люди", exact: true }).click();
      await page.getByLabel("Поиск человека").fill("Тестовый зритель");
      await page.waitForFunction(
        () => document.querySelectorAll(".person-row").length === 1,
      );
      await page.getByLabel("Поиск человека").fill("");
      await page.waitForFunction(
        () => document.querySelectorAll(".person-row").length === 3,
      );
      checks.push("server-side people search");
      const da = persons.find((p) => String(p.sources).includes("donationalerts"));
      await page
        .locator(".person-row")
        .filter({ hasText: "Тестовый зритель" })
        .first()
        .click();
      await page.getByLabel("Целевой человек").selectOption(da.id);
      await page
        .getByRole("button", { name: "Объединить", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".person-row").length === 2,
      );
      checks.push("merge persists and updates people list");
      await page.getByRole("button", { name: "Отменить", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll(".person-row").length === 3,
      );
      checks.push("undo restores memberships");
      await page
        .locator(".person-row")
        .filter({ hasText: "Тестовый зритель" })
        .first()
        .click();
      await page.locator(".identity-row input").first().check();
      await page.getByLabel("Имя новой группы").fill("Выделенная группа");
      await page
        .getByRole("button", { name: "Разъединить выбранные", exact: true })
        .click();
      await page
        .locator(".person-row")
        .filter({ hasText: "Выделенная группа" })
        .waitFor();
      checks.push("split selected identity");
      await page.getByLabel("Имя группы").fill("Проверенный зритель");
      await page
        .getByRole("button", { name: "Сохранить", exact: true })
        .click();
      await page
        .locator(".person-row")
        .filter({ hasText: "Проверенный зритель" })
        .waitFor();
      checks.push("rename group");
      await page.getByLabel("Поиск человека").fill("Тестовый зритель");
      await page.waitForFunction(
        () => document.querySelectorAll(".person-row").length === 1,
      );
      assert.equal(
        await page
          .locator(".person-row")
          .filter({ hasText: "Проверенный зритель" })
          .count(),
        1,
      );
      await page.getByLabel("Поиск человека").fill("");
      checks.push("historical alias search after group rename");
      const sessions = await page.evaluate(() =>
        fetch("/api/v1/sessions").then((r) => r.json()),
      );
      await page.getByLabel("Сессия наблюдений").selectOption(sessions[0].id);
      await page.getByRole("button", { name: "Показать", exact: true }).click();
      await page.locator(".minute-grid button").first().waitFor();
      await page.locator(".minute-grid button").first().click();
      await page.getByText("Выбрана минута:", { exact: false }).waitFor();
      checks.push("presence grid and persisted minute event query");

      await page.getByRole("button", { name: "Обзор", exact: true }).click();
      await page
        .getByRole("button", { name: "Завершить запись", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Начать запись", exact: true })
        .waitFor();
      checks.push("stop manual recording");
      await page
        .getByRole("navigation").getByRole("button", { name: "Интеграции", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Создать резервную копию", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Резервная копия:" })
        .waitFor();
      checks.push("SQLite backup through UI");
      for (const width of [390, 768, 1536]) {
        await page.setViewportSize({ width, height: 844 });
        await page.getByRole("button", { name: "Обзор", exact: true }).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        if (overflow) {
          console.log(
            await page.locator("body *").evaluateAll((es) =>
              es
                .filter((e) => e.getBoundingClientRect().right > innerWidth)
                .map((e) => ({
                  tag: e.tagName,
                  class: e.className,
                  width: e.getBoundingClientRect().width,
                  right: e.getBoundingClientRect().right,
                }))
                .slice(0, 20),
            ),
          );
        }
        assert.equal(overflow, false, "overview overflow at " + width);
        await page.getByRole("button", { name: "Люди", exact: true }).click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          "people overflow at " + width,
        );
        await page
          .getByRole("navigation").getByRole("button", { name: "Интеграции", exact: true })
          .click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          "connections overflow at " + width,
        );
      }
      checks.push("390/768/1536 layouts without horizontal overflow");
      assert.deepEqual(errors, []);
      checks.push("no browser runtime or console errors");
      await saveCoverage(page);
      await context.close();
    } finally {
      await browser.close();
      await a.close();
    }
  },
);
