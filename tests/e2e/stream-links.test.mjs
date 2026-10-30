import {navigate,refreshData} from '../helpers/navigation.mjs';
import {acceptConfirmation} from '../helpers/confirmation.mjs';
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
    const bothId = await a.db.call("observePlatformStream", "twitch", "twitch-channel", "twitch-stream", base, base + 60000, "https://www.twitch.tv/Fullrandomname_twitch", "Combined platform stream");
    assert.ok(bothId);
    assert.equal(await a.db.call("observePlatformStream", "youtube", "youtube-channel", "combined-video", base + 30000, base + 61000, "https://www.youtube.com/watch?v=combined-video", "Combined platform stream"), bothId);
    await a.db.call("endSession", bothId, base + 90000, "observed");
    await a.db.call('ensureOwnerIdentity','twitch-channel','twitch-channel','rlod',now,'rlod');

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
    await navigate(page,"Обзор");await page.locator(".channel-metrics").waitFor();
    const sessions = await page.evaluate(() => fetch("/api/v1/sessions").then(response => response.json()));
    const combined = sessions.find(session => session.id === bothId);
    assert.deepEqual(combined.platforms, ["twitch", "youtube"]);
    assert.equal(combined.primaryTitle, "Combined platform stream");
    assert.deepEqual(combined.confirmedUrls, [
      { platform: "twitch", url: "https://www.twitch.tv/rlod" },
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
    const bothRow = page.locator(".stream-card").filter({ hasText: "Combined platform stream" });
    assert.equal(await bothRow.locator(".stream-platforms").textContent(), "Twitch · YouTube");
    await bothRow.locator(".stream-actions summary").click();
    for (const [label, url] of [["Twitch", "https://www.twitch.tv/rlod"], ["YouTube", "https://www.youtube.com/watch?v=combined-video"]]) {
      const link = bothRow.getByRole("link", { name: label, exact: true });
      assert.equal(await link.getAttribute("href"), url);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    }
    await page.keyboard.press('Escape');
    const youtubeRow = page.locator(".stream-card").filter({ hasText: "YouTube only stream" });
    await youtubeRow.locator(".stream-actions summary").click();
    await youtubeRow.getByRole("link", { name: "YouTube", exact: true }).waitFor();
    assert.equal(await youtubeRow.getByRole("link", { name: "YouTube", exact: true }).count(), 1);
    assert.equal(await youtubeRow.getByRole("link", { name: "Twitch", exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    const legacyRow = page.locator(`[data-session-id="${legacyId}"]`);
    assert.equal(await legacyRow.locator(".stream-actions").getByRole("link").count(), 0);
    const manualRow = page.locator(`[data-session-id="${manualId}"]`);
    assert.equal(await manualRow.locator(".stream-platforms").textContent(), "Источник неизвестен");
    assert.equal(await manualRow.locator(".stream-actions").getByRole("link").count(), 0);
    assert.equal(await bothRow.getByRole("button",{name:"Удалить",exact:true}).count(),0);
    await manualRow.locator(".stream-actions summary").click();await manualRow.getByRole("button",{name:"Удалить",exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();assert.equal((await a.db.call('sessions')).some(s=>s.id===manualId),true);
    await manualRow.locator(".stream-actions summary").click();await manualRow.getByRole("button",{name:"Удалить",exact:true}).click();await acceptConfirmation(page,'Удалить');
    await manualRow.waitFor({state:"detached"});
    assert.equal((await a.db.call("sessions")).some(s=>s.id===manualId),false);
    assert.equal((await a.db.call("sessions")).some(s=>s.id===bothId),true);
    await page.route('**/api/v1/sessions',async route=>{const response=await route.fetch();const rows=await response.json();await route.fulfill({response,json:rows.map(({durationMs,breaks,confirmedUrls,viewerMean,viewerPeak,donationTotals,donationCount,...legacy})=>legacy)});});
    await navigate(page,'Обзор');await page.getByRole('button',{name:'Стримы',exact:true}).click();await bothRow.waitFor();await refreshData(page);await page.waitForFunction(()=>document.querySelectorAll('.stream-card .stream-actions a').length===0);await bothRow.locator('.stream-actions summary').click();assert.equal(await bothRow.locator('.stream-actions').getByRole('link').count(),0);assert.ok((await bothRow.textContent()).includes('Средние зрители—'));assert.ok((await bothRow.textContent()).includes('Донатов: 0'));
    assert.deepEqual(errors, []);
    await saveCoverage(page);
    await context.close();
  } finally {
    await browser?.close();
    await a.close();
  }
});

test('long stream titles and several YouTube recordings keep Open visible on desktop, tablet and mobile',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const at=Date.now()-120000;
  const id=await app.db.call('observePlatformStream','twitch','owner','stream',at,at,null,'Очень длинное название стрима '.repeat(15));
  for(const video of ['one','two'])await app.db.call('observePlatformStream','youtube','yt-owner',video,at,at,`https://youtube.com/watch?v=${video}`,'YouTube title');
  browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,app.bootstrap());await page.getByRole('button',{name:'Стримы',exact:true}).click();
  const row=page.locator(`[data-session-id="${id}"]`),open=row.locator('.stream-open');
  await row.locator('.stream-actions summary').click();await row.getByRole('link',{name:'YouTube · часть 1',exact:true}).waitFor();
  await row.getByRole('link',{name:'YouTube · часть 2',exact:true}).waitFor();
  for(const width of [1440,1024,820,390]){
   await page.setViewportSize({width,height:900});await open.scrollIntoViewIfNeeded();
   const rect=await open.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=width,JSON.stringify({width,rect}));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.keyboard.press('Escape');await open.click();await page.locator('.stream-page').waitFor();assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
