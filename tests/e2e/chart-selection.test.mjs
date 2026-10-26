import test from 'node:test';
import assert from 'node:assert/strict';
import {application,seed} from '../helpers/application.mjs';
import {launchBrowser} from '../helpers/browser.mjs';
import {goto,saveCoverage} from '../helpers/browser-coverage.mjs';

// SVG group outlines used to lose three edges to the plot clip. Check the painted
// overlay, boundary buckets, and selection state independently of keyboard focus.
test('stream bar selection has four unclipped edges and survives focus changes',{timeout:60000},async()=>{
 const app=await application();let browser;
 try{
  const id=await seed(app);await app.db.call('streamSample',id,Date.now()-300000,'game','Game','',9);await app.db.call('endSession',id,Date.now());
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await goto(page,app.bootstrap());assert.equal(await page.title(),'Stream Panel');
  await page.getByRole('button',{name:'Стримы',exact:true}).click();await page.locator(`[data-session-id="${id}"] .stream-open`).click();
  const chart=page.locator('.series-panel'),bars=chart.locator('.chart-bar'),outline=chart.locator('.bar-highlight');
  const detail=page.getByRole('region',{name:'Детали выбранного столбца'});
  async function visibleOutline(){
   await outline.waitFor();
   assert.equal(await outline.evaluate(el=>{
    const box=el.getBoundingClientRect(),svg=el.ownerSVGElement.getBoundingClientRect(),style=getComputedStyle(el);
    const clipped=el.closest('[clip-path]');
    const lastBar=el.ownerSVGElement.querySelector('.chart-bar:last-child');
    return !clipped&&Boolean(lastBar.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)&&style.fill==='none'&&style.stroke!=='none'&&parseFloat(style.strokeWidth)>=2&&style.pointerEvents==='none'&&box.width>0&&box.height>0&&box.left>svg.left+2&&box.right<svg.right-2&&box.top>svg.top+2&&box.bottom<svg.bottom-2;
   }),true,'all four stroke edges fit inside the SVG and paint above the clipped bars');
  }
  for(const width of [1280,1920,390]){
   await page.setViewportSize({width,height:900});
   for(const resolution of ['1 мин','5 мин','15 мин']){
    await page.getByRole('button',{name:resolution,exact:true}).click();
    for(const metric of ['viewers','messages']){
     await page.getByLabel('Показатель графика стрима').selectOption(metric);
     if(metric==='viewers')assert.deepEqual(await chart.locator('.count-axis-tick').allTextContents(),['0','2','4','6','8','10']);
     for(const index of [0,Math.floor(await bars.count()/2),await bars.count()-1]){
      const target=await bars.nth(index).evaluate(el=>{const box=el.getBBox(),svg=el.ownerSVGElement,clip=svg.querySelector('clipPath rect').getBBox();const point=new DOMPoint((Math.max(box.x,clip.x)+Math.min(box.x+box.width,clip.x+clip.width))/2,100).matrixTransform(svg.getScreenCTM());return {x:point.x,y:point.y};});
      await page.mouse.click(target.x,target.y);await detail.waitFor();await visibleOutline();assert.equal(await bars.nth(index).getAttribute('aria-pressed'),'true');
      await chart.getByLabel('Показатель графика стрима').focus();await visibleOutline();
      await page.getByRole('button',{name:'Закрыть детализацию',exact:true}).click();assert.equal(await outline.count(),0);
     }
    }
   }
  }
  await page.getByRole('button',{name:'1 мин',exact:true}).click();
  await bars.first().focus();await visibleOutline();assert.equal(await detail.count(),0);
  await page.keyboard.press('Enter');await detail.waitFor();assert.equal(await bars.first().getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Tab');await visibleOutline();await page.keyboard.press('Space');await detail.waitFor();assert.equal(await bars.nth(1).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);await saveCoverage(page);
 }finally{await browser?.close();await app.close();}
});
