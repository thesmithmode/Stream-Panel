import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createHostedApplication } from "../../dist/apps/daemon/src/hosted.js";
import { launchBrowser } from "../helpers/browser.mjs";
import { goto, saveCoverage } from "../helpers/browser-coverage.mjs";

test("profile selector switches isolated data without login", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-hosted-browser-"));
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const origin = `http://127.0.0.1:${port}`;
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
      await page.getByLabel("Профиль").waitFor();
      if(profile === "gulnaz") await page.getByLabel("Профиль").selectOption("gulnaz");
      await page.getByRole("button", {name:"Обзор",exact:true}).click();
      await page.getByText(`Private ${profile}`, { exact: true }).waitFor();
      assert.equal(await page.getByText(`Private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`, { exact: true }).count(), 0);
      assert.equal(await page.title(), "Stream Panel");
      assert.equal(await page.getByLabel("Профиль").inputValue(), profile);
      await page.getByRole("button", {name:"YouTube",exact:true}).click();
      await page.getByRole("heading",{name:`YouTube Own ${profile}`}).waitFor();
      await page.getByText(`YouTube private ${profile}`,{exact:false}).waitFor();
      assert.equal(await page.getByText(`YouTube private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`,{exact:false}).count(),0);
      await page.getByRole("button", {name:"Обзор",exact:true}).click();
      await page.route('**/api/v1/youtube/data',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'WORKER_UNAVAILABLE'})}));
      await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('button',{name:'YouTube',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'WORKER_UNAVAILABLE'}).waitFor();
      assert.equal(await page.getByText(`YouTube private ${profile}`,{exact:false}).count(),0);
      await page.unroute('**/api/v1/youtube/data');
      const db=h.runtimes.get(profile).db;
      await db.call('youtubeSnapshot','channel','channel',{snippet:{title:`Own ${profile}`},statistics:{hiddenSubscriberCount:true}});
      await db.call('youtubeSnapshot','channel','report',{});
      await db.call('youtubeMessages','channel','chat',[{id:'minimal',snippet:{publishedAt:'2026-10-07T12:00:01Z',type:'textMessageEvent'},authorDetails:{}}]);
      await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('button',{name:'YouTube',exact:true}).click();
      await page.getByText('Подписчики: скрыты · Просмотры канала: нет данных',{exact:true}).waitFor();
      await db.call('youtubeSnapshot','channel','channel',{snippet:{title:`Own ${profile}`}});
      await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('button',{name:'YouTube',exact:true}).click();
      await page.getByText('Подписчики: нет данных · Просмотры канала: нет данных',{exact:true}).waitFor();
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.setViewportSize({width:1280,height:800});
      assert.equal(await page.getByLabel("Профиль").inputValue(),profile);
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      assert.ok(await page.getByLabel("Профиль").isVisible());
      assert.deepEqual(errors, []);
      await saveCoverage(page);
    }
  } finally { await Promise.all(contexts.map((c) => c.close())); await browser.close(); await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});
