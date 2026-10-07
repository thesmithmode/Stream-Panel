import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { AccountStore } from "../../dist/apps/daemon/src/auth.js";
import { createHostedApplication } from "../../dist/apps/daemon/src/hosted.js";
import { launchBrowser } from "../helpers/browser.mjs";
import { goto, saveCoverage } from "../helpers/browser-coverage.mjs";

test("two browser accounts see only their own data; logout in demo revokes the real session", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-browser-"));
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const origin = `http://127.0.0.1:${port}`;
  const auth = new AccountStore(join(dir, "data.sqlite"));
  await auth.createUser("ruslan", "ruslan", "Руслан", "ruslan-browser-password");
  await auth.createUser("gulnaz", "gulnaz", "Гульназ", "gulnaz-browser-password"); auth.close();
  const h = await createHostedApplication(dir, origin, false);
  await h.app.listen({ host: "127.0.0.1", port });
  for (const profile of ["ruslan", "gulnaz"]) await h.runtimes.get(profile).db.call("ingest", {
    source: "twitch", accountId: "same-channel", externalId: "same-id", type: "chat.message",
    actor: { externalId: "viewer", displayName: "Viewer" }, occurredAtMs: Date.now(), receivedAtMs: Date.now(), sourceTime: null,
    timeQuality: "provider", transport: "eventsub", payload: { text: `Private ${profile}` },
  });
  for (const profile of ["ruslan", "gulnaz"]) {
    const runtime = h.runtimes.get(profile);
    runtime.configuration.value.youtube = {userId: "channel",access:"fixture",refresh:"fixture",expiresAt:Date.now()+3600000,scopes:[]};
    await runtime.db.call("youtubeSnapshot", "channel", "channel", {snippet:{title:`Own ${profile}`},statistics:{subscriberCount:"10",viewCount:"100"}});
    await runtime.db.call("youtubeSnapshot", "channel", "report", {start:"2026-09-09",end:"2026-10-06",columnHeaders:[{name:"day"},{name:"views"}],rows:[["2026-10-06",profile==="ruslan"?42:17]]});
    await runtime.db.call("youtubeMessages", "channel", "chat", [{id:"same-yt-id",snippet:{publishedAt:"2026-10-07T12:00:00Z",displayMessage:`YouTube private ${profile}`},authorDetails:{displayName:"Viewer"}}]);
  }
  const browser = await launchBrowser();
  const contexts = [];
  try {
    for (const profile of ["ruslan", "gulnaz"]) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      await goto(page, origin);
      await page.getByRole("heading", { name: "Вход в Stream Panel" }).waitFor();
      await page.getByLabel("Логин", { exact: true }).fill(profile);
      await page.getByLabel("Пароль", { exact: true }).fill("bad");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.getByText("Неверный логин или пароль", { exact: true }).waitFor();
      await page.getByLabel("Пароль", { exact: true }).fill(`${profile}-browser-password`);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.getByText(`Private ${profile}`, { exact: true }).waitFor();
      assert.equal(await page.getByText(`Private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`, { exact: true }).count(), 0);
      assert.equal(await page.title(), "Stream Panel");
      await page.getByRole("button", {name:"YouTube",exact:true}).click();
      await page.getByRole("heading",{name:`YouTube Own ${profile}`}).waitFor();
      await page.getByText(`YouTube private ${profile}`,{exact:false}).waitFor();
      assert.equal(await page.getByText(`YouTube private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`,{exact:false}).count(),0);
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.setViewportSize({width:1280,height:800});
      await page.getByRole("button", { name: "Демо", exact: true }).click();
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      await page.getByRole("heading", { name: "Вход в Stream Panel" }).waitFor();
      assert.equal(await page.evaluate(() => fetch("/api/v1/events").then((r) => r.status)), 401);
      assert.deepEqual(errors, []);
      await saveCoverage(page);
    }
  } finally { await Promise.all(contexts.map((c) => c.close())); await browser.close(); await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});
