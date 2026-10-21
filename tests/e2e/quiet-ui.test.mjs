import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';
import {navigate,openFilters,closeFilters} from '../helpers/navigation.mjs';
import {assertUiLayout} from '../helpers/ui-layout.mjs';
test('quiet navigation preserves secondary functions, keyboard tabs, filters and phone scroll access',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const sid=await seed(a);await a.db.call('endSession',sid,Date.now());browser=await launchBrowser();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());await page.locator('.stream-card').waitFor();assert.equal(new URL(page.url()).searchParams.get('view'),'sessions');assert.equal(await page.locator('.sidebar nav button').count(),5);assert.equal(await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).count(),0);
  await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).check();assert.equal(await page.getByRole('button',{name:'Объединить выбранные',exact:true}).isDisabled(),true);await page.getByRole('checkbox',{name:'Выбрать стрим',exact:true}).uncheck();await page.getByRole('button',{name:'Отмена',exact:true}).click();
  await page.getByLabel('Показать эфиры').selectOption('live');await page.getByText('Нет эфиров по выбранному фильтру.',{exact:true}).waitFor();await page.getByLabel('Показать эфиры').selectOption('ended');await page.locator('.stream-card').waitFor();await page.getByLabel('Показать эфиры').selectOption('all');
  await page.locator('.donation-total').click();await page.getByRole('region',{name:'Все донаты',exact:true}).waitFor();
  for(const name of ['Итоги канала','Интеграции','Настройки']){await navigate(page,name);await page.locator('main h1').waitFor();}
  await page.getByRole('button',{name:'Ещё',exact:true}).click();const more=page.getByRole('dialog',{name:'Ещё',exact:true});await assertUiLayout(page);await more.getByRole('button',{name:'Автообновление Вкл',exact:true}).click();assert.equal(await more.getByLabel('Интервал автообновления').count(),0);await more.getByRole('button',{name:'Автообновление Выкл',exact:true}).click();await more.getByLabel('Интервал автообновления').selectOption('300');await more.getByLabel('Интервал автообновления').selectOption('900');await more.getByLabel('Интервал автообновления').selectOption('60');await page.keyboard.press('Escape');assert.equal(await more.isVisible(),false);
  await navigate(page,'Стримы');await page.locator('.stream-open').click();await page.locator('.stream-kpis').waitFor();
  await page.getByRole('tab',{name:'Итоги',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Участники',exact:true}).getAttribute('aria-selected'),'true');await page.locator('.audience-ranking').waitFor();await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'События',exact:true}).getAttribute('aria-selected'),'true');await page.keyboard.press('Home');await page.keyboard.press('ArrowLeft');assert.equal(await page.getByRole('tab',{name:'События',exact:true}).getAttribute('aria-selected'),'true');await page.keyboard.press('Home');await page.keyboard.press('z');
  await navigate(page,'Аналитика');await page.locator('.growth-plot').waitFor();await openFilters(page);await page.getByLabel('Период аналитики',{exact:true}).selectOption('custom');await page.getByLabel('Начало периода').waitFor();await closeFilters(page);await page.getByRole('button',{name:'30 дней',exact:true}).click();await page.getByRole('button',{name:'7 дней',exact:true}).click();await page.getByRole('button',{name:'Всё время',exact:true}).click();
  for(const width of [320,390,768,1440,1920]){
   await page.setViewportSize({width,height:900});
   for(const name of ['Динамика','Время','Аудитория']){await page.getByRole('tab',{name,exact:true}).click();await assertUiLayout(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
   await openFilters(page);await assertUiLayout(page);await closeFilters(page);
  }
  await navigate(page,'Стримы');await page.route('**/api/v1/overview',route=>route.fulfill({status:400,json:{error:'UNAVAILABLE'}}));await page.reload();await page.locator('.donation-total').getByText('Недоступно',{exact:true}).first().waitFor();await page.unroute('**/api/v1/overview');await page.evaluate(()=>window.dispatchEvent(new Event('sp:data-refresh')));await page.locator('.donation-total').getByText('250,00 RUB',{exact:true}).waitFor();assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});

test('overflow sheets do not stretch cards; disclosure controls remain aligned when expanded',{timeout:60000},async()=>{
 const a=await application();let browser;
 try{
  const id=await seed(a),now=Date.now();await a.db.call('streamSample',id,now-600000,'dota','Dota 2','Агент Габена 219 вышел на охоту',8);await a.db.call('endSession',id,now);
  browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,a.bootstrap());const card=page.locator(`[data-session-id="${id}"]`);
  for(const width of [320,390,768,1440,1920]){
   await page.setViewportSize({width,height:900});await card.waitFor();const height=(await card.boundingBox()).height;
   const trigger=card.locator('.stream-actions summary');await trigger.click();const menu=card.getByRole('dialog',{name:'Детали эфира',exact:true});await menu.waitFor();await assertUiLayout(page);
   assert.equal((await card.boundingBox()).height,height);assert.equal(await trigger.getAttribute('aria-haspopup'),'dialog');
   await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
   await trigger.click();await menu.waitFor();await menu.getByRole('button',{name:'Закрыть',exact:true}).click();await menu.waitFor({state:'hidden'});
  }
  await page.keyboard.press('Tab');await card.locator('.stream-open').focus();assert.equal(await card.locator('.stream-open').evaluate(e=>e.matches(':focus-visible')),true);assert.equal(await card.locator('.stream-open').evaluate(e=>getComputedStyle(e).outlineOffset),'-3px');
  await card.locator('.stream-open').click();await page.locator('.series-panel svg').waitFor();assert.equal(await page.getByRole('button',{name:'5 мин',exact:true}).getAttribute('aria-pressed'),'true');
  for(const width of [320,390,768,1440,1920]){
   await page.setViewportSize({width,height:900});const toolbar=page.locator('.stream-chart-toolbar');await toolbar.scrollIntoViewIfNeeded();const before=await toolbar.boundingBox();
   let axis;const metric=page.getByLabel('Показатель графика стрима');await metric.focus();assert.equal(await metric.evaluate(e=>getComputedStyle(e).outlineOffset),'-3px');await metric.selectOption('messages');for(const step of [1,15,5]){await toolbar.getByRole('button',{name:`${step} мин`,exact:true}).click();assert.equal(await toolbar.getByRole('button',{name:`${step} мин`,exact:true}).getAttribute('aria-pressed'),'true');const after=await toolbar.boundingBox();assert.equal(after.x,before.x);assert.equal(after.width,before.width);assert.equal(after.height,before.height);const ticks=await page.locator('.series-panel svg text[y="213"]').evaluateAll(es=>es.map(e=>[e.textContent,e.getAttribute('x')]));if(axis)assert.deepEqual(ticks,axis);else axis=ticks;}await assertUiLayout(page);
   const insights=page.getByRole('button',{name:'Инсайты',exact:true});await insights.click();assert.equal(await insights.getAttribute('aria-expanded'),'true');await insights.click();assert.equal(await insights.getAttribute('aria-expanded'),'false');
   await page.locator('.section-disclosure>summary').filter({hasText:/^Подписчики$/}).click();await page.getByRole('region',{name:'Подписчики за стрим',exact:true}).getByText('Новых подписок не зафиксировано.',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Подписчики за стрим',exact:true}).count(),0);await page.locator('.section-disclosure>summary').filter({hasText:/^Подписчики$/}).click();
  }
  await page.getByRole('button',{name:'15 мин',exact:true}).click();await page.reload();await page.locator('.series-panel svg').waitFor();assert.equal(await page.getByRole('button',{name:'15 мин',exact:true}).getAttribute('aria-pressed'),'true');
  await page.locator('.metadata-menu>summary').click();const metadata=page.getByRole('dialog',{name:'История названий и категорий',exact:true});await metadata.waitFor();await metadata.getByText(/Dota 2/).waitFor();await assertUiLayout(page);await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await a.close();}
});
