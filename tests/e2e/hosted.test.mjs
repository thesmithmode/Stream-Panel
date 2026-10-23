import {navigate,refreshData} from '../helpers/navigation.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { AccountStore } from "../../dist/apps/daemon/src/auth.js";
import { createHostedApplication } from "../../dist/apps/daemon/src/hosted.js";
import { launchBrowser } from "../helpers/browser.mjs";
import { goto, saveCoverage, reload, startCoverage } from "../helpers/browser-coverage.mjs";

test("two browser accounts see only their own data; logout revokes the session", { timeout: 30000 }, async () => {
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
    const owner=profile==='ruslan'?'ruslan-id':'gulnaz-id',at=Date.now()-180000;
    runtime.configuration.value.twitch={userId:owner,access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:[]};
    const sid=await runtime.db.call('startSession',owner,'owner-exclusion',at,'platform',at);
    for(const [id,name] of [['ruslan-id','FullRandomName_Twitch'],['gulnaz-id','AmaliaMelina']])await runtime.db.call('ingest',{source:'twitch',accountId:owner,externalId:id,type:'chat.message',actor:{externalId:id,displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Viewer in the other profile'}});
    await runtime.db.call('recordPoll',sid,owner,{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:['ruslan-id','gulnaz-id']});await runtime.db.call('endSession',sid,at+120000);
    runtime.configuration.value.youtube = {userId: "channel",access:"fixture",refresh:"fixture",expiresAt:Date.now()+3600000,scopes:[]};
    await runtime.db.call("youtubeSnapshot", "channel", "channel", {snippet:{title:`Own ${profile}`},statistics:{subscriberCount:"10",viewCount:"100"}});
    await runtime.db.call("youtubeSnapshot", "channel", "report", {start:"2026-09-09",end:"2026-10-06",columnHeaders:[{name:"day"},{name:"views"}],rows:[["2026-10-06",profile==="ruslan"?42:17]]});
    await runtime.db.call("youtubeMessages", "channel", "chat", [{id:"same-yt-id",snippet:{publishedAt:"2026-10-07T12:00:00Z",displayMessage:`YouTube private ${profile}`},authorDetails:{displayName:"Viewer"}}]);
  }
  let browser;
  const contexts = [];
  try {
    browser = await launchBrowser();
    for (const profile of ["ruslan", "gulnaz"]) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      await page.clock.install();
      await goto(page, origin);
      await page.getByRole("heading", { name: "Вход в Stream Panel" }).waitFor();
      await page.getByLabel("Логин", { exact: true }).fill(profile);
      await page.getByLabel("Пароль", { exact: true }).fill("bad");
      // Returning from the password manager must keep the same form and focus.
      const loginInput = await page.getByLabel("Пароль", { exact: true }).elementHandle();
      let authPolls = 0;
      const trackAuth = request => { if (request.url().includes('/api/v1/status')) authPolls++; };
      page.on('request', trackAuth);
      await page.clock.fastForward(16000);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(200);
      assert.equal(authPolls, 0, 'unauthenticated timer and focus must not restart initialization');
      assert.equal(await loginInput.evaluate(input => input.isConnected && input === document.activeElement), true);
      assert.equal(await page.getByLabel("Пароль", { exact: true }).inputValue(), "bad");
      page.off('request', trackAuth);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.getByText("Неверный логин или пароль", { exact: true }).waitFor();
      await page.getByLabel("Пароль", { exact: true }).fill(`${profile}-browser-password`);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await navigate(page,"Обзор");await page.locator(".channel-metrics").waitFor();
      await page.getByRole("button",{name:"Люди",exact:true}).click();
      await page.locator(".person-row").filter({hasText:"Viewer"}).waitFor();
      assert.equal(await page.getByText(`Private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`, { exact: true }).count(), 0);
      assert.equal(await page.title(), "Stream Panel");
      const ownName=profile==='ruslan'?'FullRandomName_Twitch':'AmaliaMelina',guestName=profile==='ruslan'?'AmaliaMelina':'FullRandomName_Twitch';
      await page.getByRole('button',{name:'Люди',exact:true}).click();await page.locator('.person-row').filter({hasText:guestName}).waitFor();assert.equal(await page.locator('.person-row').filter({hasText:ownName}).count(),0);
      await page.getByRole('button',{name:'Аналитика',exact:true}).click();await page.getByRole('tab',{name:'Аудитория',exact:true}).click();await page.getByRole('button',{name:guestName,exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:ownName,exact:true}).count(),0);
      await navigate(page,'Интеграции');
      assert.equal(await page.getByRole("button",{name:"YouTube",exact:true}).count(),0);
      await page.getByRole("heading",{name:`YouTube Own ${profile}`}).waitFor();
      await page.getByText('Подписчики: 10 · Просмотры канала: 100',{exact:true}).waitFor();
      assert.equal(await page.getByText(`YouTube private ${profile === "ruslan" ? "gulnaz" : "ruslan"}`,{exact:false}).count(),0);
      assert.equal(await page.getByRole("button",{name:"Демо",exact:true}).count(),0);
      assert.equal(await page.getByText(`YouTube private ${profile}`,{exact:false}).count(),0);

      await page.getByRole("heading",{name:`YouTube Own ${profile}`}).waitFor();
      await page.route('**/api/v1/youtube/data',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'WORKER_UNAVAILABLE'})}));
      await navigate(page,'Обзор');await navigate(page,'Интеграции');
      await page.getByRole('alert').filter({hasText:'WORKER_UNAVAILABLE'}).waitFor();
      assert.equal(await page.getByText(`YouTube private ${profile}`,{exact:false}).count(),0);
      await page.unroute('**/api/v1/youtube/data');
      const db=h.runtimes.get(profile).db;
      await db.call('youtubeSnapshot','channel','channel',{snippet:{title:`Own ${profile}`},statistics:{hiddenSubscriberCount:true}});
      await db.call('youtubeSnapshot','channel','report',{});
      await db.call('youtubeMessages','channel','chat',[{id:'minimal',snippet:{publishedAt:'2026-10-07T12:00:01Z',type:'textMessageEvent'},authorDetails:{}}]);
      await navigate(page,'Обзор');await navigate(page,'Интеграции');
      await page.getByText('Подписчики: скрыты · Просмотры канала: нет данных',{exact:true}).waitFor();
      await db.call('youtubeSnapshot','channel','channel',{snippet:{title:`Own ${profile}`}});
      await navigate(page,'Обзор');await navigate(page,'Интеграции');
      await page.getByText('Подписчики: нет данных · Просмотры канала: нет данных',{exact:true}).waitFor();
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.setViewportSize({width:1280,height:800});

      assert.equal(await page.getByRole("button", { name: "Выйти", exact: true }).count(),0);
      await page.evaluate(async()=>{const {csrf}=await fetch("/api/v1/auth/me").then(r=>r.json());await fetch("/api/v1/auth/logout",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:"{}"});});
      await reload(page);
      await page.getByRole("heading", { name: "Вход в Stream Panel" }).waitFor();
      assert.equal(await page.evaluate(() => fetch("/api/v1/events").then((r) => r.status)), 401);
      assert.deepEqual(errors, []);
      await saveCoverage(page);
    }
  } finally { await Promise.all(contexts.map((c) => c.close())); await browser?.close(); await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("profile switch reloads all views, preserves other clients and remains visible on mobile", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-profile-browser-"));
  const h = await createHostedApplication(dir, "http://127.0.0.1:47839", false);
  let browser;
  const contexts = [];
  try {
    await h.accounts.createUser("ruslan", "ruslan", "Руслан", "profile-browser-password");
    for (const profile of ["ruslan", "gulnaz"]) {
      await h.runtimes.get(profile).db.call("ingest", { source: "twitch", accountId: "same-channel", externalId: "same-event", type: "chat.message", actor: { externalId: "viewer", displayName: `Viewer ${profile}` }, occurredAtMs: Date.now(), receivedAtMs: Date.now(), sourceTime: null, timeQuality: "provider", transport: "eventsub", payload: { text: `Message ${profile}` } });
    }
    for(const profile of ['ruslan','gulnaz']){
      const sid=await h.runtimes.get(profile).db.call('startSession','same-channel',`stream-${profile}`,Date.now()-120000,'platform',Date.now()-120000);await h.runtimes.get(profile).db.call('endSession',sid,Date.now()-60000);
    }
    await h.app.listen({ host: "127.0.0.1", port: 47839 });
    browser = await launchBrowser();
    const pages = [],warmups=[];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      const warmed=new Set();let finish;const ready=new Promise(resolve=>{finish=resolve;});warmups.push(ready);
      page.on('response',async response=>{if(new URL(response.url()).pathname!=='/api/v1/analytics'||response.status()!==200)return;const data=await response.json();if(!data.preparing){warmed.add(response.request().headers()['x-stream-panel-profile']);if(warmed.size===2)finish();}});
      await goto(page, "http://127.0.0.1:47839");
      await page.getByLabel("Логин", { exact: true }).fill("ruslan");
      await page.getByLabel("Пароль", { exact: true }).fill("profile-browser-password");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.getByRole("button",{name:"Люди",exact:true}).click();await page.locator(".person-row").filter({hasText:"Viewer ruslan"}).waitFor();
    }
    await Promise.all(warmups);
    const [a, b] = pages;
    let reloads=0;await a.route('**/api/v1/analytics?*',route=>{reloads++;return route.abort();});
    for(const selected of ['gulnaz','ruslan']){
      await a.getByLabel('Профиль',{exact:true}).selectOption(selected);await a.getByRole('button',{name:'Аналитика',exact:true}).click();await a.locator('.analytics-kpis').waitFor();assert.equal(await a.getByRole('alert').count(),0);assert.equal(reloads,0,'both profiles have reports ready before opening analytics');
      await a.getByRole('button',{name:'Люди',exact:true}).click();await a.getByText(`Viewer ${selected}`,{exact:true}).first().waitFor();
    }
    await a.unroute('**/api/v1/analytics?*');
    await a.getByLabel("Профиль", { exact: true }).selectOption("gulnaz");
    await a.locator(".person-row").filter({hasText:"Viewer gulnaz"}).waitFor();
    assert.equal(await a.getByText("Message ruslan", { exact: true }).count(), 0);
    assert.equal(await b.locator(".person-row").filter({hasText:"Viewer ruslan"}).count(),1);
    await a.getByRole("button", { name: "Люди", exact: true }).click();
    await a.getByText("Viewer gulnaz", { exact: true }).first().waitFor();
    assert.equal(await a.getByText("Viewer ruslan", { exact: true }).count(), 0);
    await a.getByLabel("Профиль", { exact: true }).selectOption("ruslan");
    await a.getByText("Viewer ruslan", { exact: true }).first().waitFor();
    assert.equal(await a.getByText("Viewer gulnaz", { exact: true }).count(), 0);
    const headers=[];
    for(const profile of ['ruslan','gulnaz']){
      await a.getByLabel('Профиль',{exact:true}).selectOption(profile);
      await a.getByRole('button',{name:'Стримы',exact:true}).click();
      await a.locator('.stream-card').waitFor();headers.push(await a.locator('.stream-card-metrics dt').allTextContents());
    }
    assert.deepEqual(headers[0],headers[1]);assert.deepEqual(headers[0],['Длительность','Средние зрители','Донаты','Сообщения']);
    await a.getByLabel('Профиль',{exact:true}).selectOption('ruslan');await a.getByRole('button',{name:'Аналитика',exact:true}).click();await a.getByRole('tab',{name:'Аудитория',exact:true}).click();await a.getByLabel('Только ядро',{exact:true}).check();
    await a.getByRole('button',{name:'Фильтры',exact:true}).click();await a.getByText('Отображение и часовой пояс',{exact:true}).click();await a.getByLabel('Сравнение категорий',{exact:true}).uncheck();await a.getByRole('button',{name:'Готово',exact:true}).click();
    await a.getByLabel('Профиль',{exact:true}).selectOption('gulnaz');await a.getByRole('button',{name:'Фильтры',exact:true}).click();await a.getByText('Отображение и часовой пояс',{exact:true}).click();assert.equal(await a.getByLabel('Сравнение категорий',{exact:true}).isChecked(),true);await a.getByRole('button',{name:'Готово',exact:true}).click();await a.getByRole('tab',{name:'Аудитория',exact:true}).click();assert.equal(await a.getByLabel('Только ядро',{exact:true}).isChecked(),false);
    await a.getByLabel('Профиль',{exact:true}).selectOption('ruslan');await a.getByRole('tab',{name:'Аудитория',exact:true}).click();assert.equal(await a.getByLabel('Только ядро',{exact:true}).isChecked(),true);
    await a.getByRole('button',{name:'Люди',exact:true}).click();await a.getByText('Viewer ruslan',{exact:true}).first().waitFor();
    await a.setViewportSize({ width: 390, height: 844 });
    await a.evaluate(() => window.scrollTo(0,0));
    const box = await a.getByLabel("Профиль", { exact: true }).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844);
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.getByLabel("Профиль", { exact: true }).selectOption("gulnaz");
    await a.getByText("Viewer gulnaz", { exact: true }).first().waitFor();
    await a.reload();
    await a.getByLabel("Профиль", { exact: true }).waitFor();
    assert.equal(await a.getByLabel("Профиль", { exact: true }).inputValue(), "gulnaz");
    assert.equal(await a.getByRole("button", { name: "Выйти", exact: true }).count(),0);
    let fakeRemaining=2;
    await a.route('**/api/v1/status',async route=>{const response=await route.fetch();const data=await response.json();if(fakeRemaining-->0)data.release='a'.repeat(40);await route.fulfill({response,json:data});});
    await refreshData(a);await a.getByRole('button',{name:'Обновить панель',exact:true}).waitFor();
    await saveCoverage(a);await startCoverage(a);const nextDocument=a.waitForEvent('load');await a.getByLabel('Профиль',{exact:true}).selectOption('ruslan');await nextDocument;
    await a.getByText('Viewer ruslan',{exact:true}).first().waitFor();assert.equal(await a.getByRole('button',{name:'Обновить панель',exact:true}).count(),0);await a.unroute('**/api/v1/status');
    await a.evaluate(async()=>{const {csrf}=await fetch("/api/v1/auth/me").then(r=>r.json());await fetch("/api/v1/auth/logout",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:"{}"});});
    await a.reload();
    await a.getByRole("heading", { name: "Вход в Stream Panel" }).waitFor();
    assert.equal(await a.evaluate(() => fetch("/api/v1/events").then(r => r.status)), 401);
    for (const page of pages) await saveCoverage(page);
  } finally {
    await Promise.all(contexts.map(c => c.close()));
    await browser?.close(); await h.app.close(); await rm(dir, { recursive: true, force: true });
  }
});
