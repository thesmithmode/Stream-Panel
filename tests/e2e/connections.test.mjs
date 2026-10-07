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
import { provider, until } from "../helpers/provider.mjs";
test(
  "browser connections: strict forms, device code, DA OAuth callback, secret persistence and token import",
  { timeout: 45000 },
  async () => {
    let failDevice = true;
    const p = await provider(
      (req, body) => {
        if (req.url.endsWith("/device")) {
          if (failDevice) return { status: 503, data: {} };
          assert.match(new URLSearchParams(body).get("scopes"), /bits:read/);
          return {
            data: {
              device_code: "device",
              user_code: "ABCD",
              verification_uri: "https://twitch.tv/activate",
              expires_in: 600,
              interval: 5,
            },
          };
        }
        if (req.url.endsWith("/oauth2/token"))
          return { status: 400, data: { message: "authorization_pending" } };
        if (req.url.endsWith("/oauth/token"))
          return {
            data: {
              access_token: "oauth-secret-access",
              refresh_token: "oauth-secret-refresh",
            },
          };
        if (req.url.endsWith("/user/oauth"))
          return {
            data: {
              data: {
                id: 7,
                name: "Owner",
                socket_connection_token: "socket-token",
              },
            },
          };
        if (req.url.includes("/donations"))
          return { data: { data: [], links: { next: null } } };
        if (req.url.endsWith("/centrifuge/subscribe"))
          return {
            data: {
              channels: [
                { channel: "$alerts:donation_7", token: "channel-token" },
              ],
            },
          };
        assert.fail(req.url);
      },
      (s) =>
        s.on("message", (raw) => {
          const msg = JSON.parse(raw);
          s.send(
            JSON.stringify(
              msg.id === 1
                ? { id: 1, result: { client: "client" } }
                : { id: 2, result: {} },
            ),
          );
        }),
    );
    const a = await application({
      twitch: { request: p.request, socket: p.socket },
      donationalerts: { request: p.request, socket: p.socket },
    });
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext(),
        page = await context.newPage();
      await startCoverage(page);
      await goto(page, a.bootstrap());
      await page
        .getByRole("button", { name: "Подключить сервисы", exact: true })
        .click();
      const twitch = page.locator("section.settings").filter({
        has: page.getByRole("heading", { name: "Twitch", exact: true }),
      });
      const da = page.locator("section.settings").filter({
        has: page.getByRole("heading", {
          name: "DonationAlerts",
          exact: true,
        }),
      });
      await twitch.getByRole("button", { name: "Войти через Twitch" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "REQUEST_FAILED" })
        .waitFor();
      await twitch.getByRole("textbox").fill("client123");
      await twitch.getByRole("checkbox").check();
      await twitch.getByRole("button", { name: "Войти через Twitch" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "TWITCH_DEVICE_HTTP_503" })
        .waitFor();
      failDevice = false;
      await twitch.getByRole("button", { name: "Войти через Twitch" }).click();
      await page.getByText("Код: ABCD", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("link", { name: "Открыть страницу входа" })
          .getAttribute("href"),
        "https://twitch.tv/activate",
      );
      await twitch
        .getByRole("button", { name: "Отключить", exact: true })
        .click();
      await page
        .getByText("Код: ABCD", { exact: true })
        .waitFor({ state: "hidden" });
      await da
        .getByRole("button", { name: "Подключить DonationAlerts" })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "DA_APP_CREDENTIALS_REQUIRED" })
        .waitFor();
      await da.getByLabel("Client ID", { exact: true }).fill("da-app");
      await da.getByLabel("Client secret", { exact: true }).fill("secret-app");
      await da
        .getByLabel("Подтверждённый UTC offset времени DA, в минутах")
        .fill("180");
      await context.route(
        "https://www.donationalerts.com/oauth/authorize?**",
        (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<p>OAuth provider fixture</p>",
          }),
      );
      const popupPromise = page.waitForEvent("popup");
      await da
        .getByRole("button", { name: "Подключить DonationAlerts" })
        .click();
      const popup = await popupPromise;
      await popup.waitForURL(
        "https://www.donationalerts.com/oauth/authorize?**",
      );
      const oauth = new URL(popup.url());
      assert.equal(oauth.searchParams.get("client_id"), "da-app");
      assert.equal(
        oauth.searchParams.get("redirect_uri"),
        `http://127.0.0.1:${new URL(a.origin).port}/oauth/donationalerts/callback`,
      );
      await popup.close();
      assert.equal(
        await da.getByLabel("Client secret", { exact: true }).inputValue(),
        "",
      );
      await goto(
        page,
        `${a.origin}/oauth/donationalerts/callback?code=provider-code&state=${oauth.searchParams.get("state")}`,
      );
      await page
        .getByRole("button", { name: "Подключения", exact: true })
        .click();
      await until(() => a.da.status.state === "connected", 8000);
      await reload(page);
      await page
        .getByRole("button", { name: "Подключения", exact: true })
        .click();
      await page.getByText("Сбор донатов включён", { exact: true }).waitFor();
      const publicStatus = await page.evaluate(() =>
        fetch("/api/v1/status").then((r) => r.json()),
      );
      assert.equal(publicStatus.config.hasDaSecret, true);
      assert.equal(publicStatus.config.hasDaToken, true);
      assert.equal(publicStatus.config.daUtcOffsetMinutes, 180);
      assert.equal(
        JSON.stringify(publicStatus).includes("oauth-secret"),
        false,
      );
      await da
        .getByRole("button", { name: "Повторить импорт истории" })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Повторный импорт запущен" })
        .waitFor();
      await da.getByRole("button", { name: "Отключить", exact: true }).click();
      assert.equal(a.configuration.value.daAccessToken, "");
      await da.locator("summary").click();
      await da
        .getByLabel("Access token", { exact: true })
        .fill("manual-access");
      await da.getByLabel("Refresh token (если есть)").fill("manual-refresh");
      await da
        .getByLabel("Подтверждённый UTC offset времени DA, в минутах")
        .fill("");
      await da
        .getByRole("button", { name: "Подключить DonationAlerts" })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "Подключение запущено" })
        .waitFor();
      assert.equal(
        await da.getByLabel("Access token", { exact: true }).inputValue(),
        "",
      );
      assert.equal(
        await da.getByLabel("Refresh token (если есть)").inputValue(),
        "",
      );
      assert.equal(a.configuration.value.daUtcOffsetMinutes, null);
      assert.equal(a.configuration.value.daAccessToken, "manual-access");
      await a.db.call("gap", "twitch", "fixture_gap", Date.now(), null);
      await reload(page);
      await page
        .getByRole("button", { name: "Подключения", exact: true })
        .click();
      await page.getByText("twitch: fixture_gap", { exact: true }).waitFor();
      await saveCoverage(page);
      await context.close();
    } finally {
      await browser.close();
      await a.close();
      await p.close();
    }
  },
);
test(
  "browser sessions, event filters, person links, platform recording and local login failure",
  { timeout: 30000 },
  async () => {
    const a = await application(),
      browser = await launchBrowser();
    try {
      const context = await browser.newContext(),
        page = await context.newPage();
      page.setDefaultTimeout(5000);
      await startCoverage(page);
      await goto(page, a.origin);
      await page
        .getByRole("heading", { name: "Откройте ссылку из терминала" })
        .waitFor();
      await goto(page, a.bootstrap());
      await page
        .getByRole("button", { name: "Подключить сервисы", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Сессии", exact: true }).click();
      await page.getByText("Записей пока нет", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Перейти к записи" }).click();
      await page.getByRole("button", { name: "Люди", exact: true }).click();
      await page.getByText("Пока никого нет", { exact: true }).waitFor();
      const s = await seed(a);
      await reload(page);
      await page
        .getByRole("button", { name: "Эфир идёт", exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Эфир идёт" }).isDisabled(),
        true,
      );
      await page.getByLabel("Фильтр событий").selectOption("donation");
      assert.equal(await page.locator(".event-row").count(), 1);
      await page.getByLabel("Фильтр событий").selectOption("chat.message");
      assert.equal(await page.locator(".event-row").count(), 8);
      await page.locator(".event-title button").first().click();
      await page.getByLabel("Имя группы").waitFor();
      await page.getByRole("button", { name: "Сессии", exact: true }).click();
      await page.getByRole("button", { name: "Открыть", exact: true }).click();
      assert.equal(await page.getByLabel("Период аналитики").inputValue(), s);
      await page.getByLabel("Фильтр событий").selectOption("donation");
      await page.getByText("Событий этого типа нет", { exact: true }).waitFor();
      await page.getByLabel("Период аналитики").selectOption("");
      await page.getByLabel("Фильтр событий").selectOption("all");
      await a.db.call("endSession", s, Date.now(), "estimated");
      await reload(page);
      await page.getByRole("button", { name: "Сессии", exact: true }).click();
      await page
        .getByText("Граница приблизительная", { exact: true })
        .waitFor();
      await saveCoverage(page);
      await context.close();
    } finally {
      await browser.close();
      await a.close();
    }
  },
);
