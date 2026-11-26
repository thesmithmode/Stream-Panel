import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers/application.mjs';
import { goto, reload, saveCoverage } from '../helpers/browser-coverage.mjs';
import { launchBrowser } from '../helpers/browser.mjs';

test('stream history switches views, restores the calendar and handles Moscow days', { timeout: 60000 }, async () => {
  const app = await application();
  let browser;
  try {
    const seed = async (external, start) => {
      const at = Date.parse(start);
      const id = await app.db.call('startSession', 'owner', external, at, 'platform', at);
      await app.db.call('endSession', id, at + 60 * 60000);
      return id;
    };
    const first = await seed('Первый эфир', '2025-11-01T20:30:00Z');
    const second = await seed('Второй эфир', '2025-11-01T21:00:00Z');
    const third = await seed('Третий эфир', '2025-11-02T17:00:00Z');
    const deleted = await seed('Удалённый эфир', '2025-11-03T17:00:00Z');
    await app.db.call('deleteSession', deleted, Date.now());
    let latest;
    for (let i = 0; i < 100; i++)
      latest = await seed('Эфир из нового месяца ' + i, new Date(Date.UTC(2025, 11, i + 1)).toISOString());

    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 320, height: 780 } });
    page.setDefaultTimeout(10000);
    await goto(page, app.bootstrap());
    await page.getByRole('button', { name: 'Стримы', exact: true }).click();
    await page.locator('.stream-card').first().waitFor();
    const reads = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/sessions') reads.push(url.search);
    });
    await page.getByRole('button', { name: 'Список', exact: true }).focus();
    await page.keyboard.press('Enter');
    const rows = page.locator('.history-row');
    await rows.first().waitFor();
    assert.equal(await rows.first().getAttribute('data-session-id'), latest);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Плитки', exact: true }).click();
    await page.locator('.stream-card').first().waitFor();
    assert.deepEqual(reads, []);
    await page.getByRole('button', { name: 'Календарь', exact: true }).click();
    await page.getByRole('button', { name: 'Предыдущий месяц' }).waitFor();
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' }).format(
      new Date(),
    );
    assert.equal(new URL(page.url()).searchParams.get('day'), today);

    const url = new URL(page.url());
    url.searchParams.set('mode', 'calendar');
    url.searchParams.set('month', '2025-11');
    url.searchParams.set('day', '2025-11-02');
    await goto(page, url.href);
    const day = page.getByRole('button', { name: '2 ноября, эфиров: 2', exact: true });
    await day.waitFor();
    assert.equal(await day.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(
      await page
        .locator('.stream-history [data-session-id]')
        .evaluateAll((entries) => entries.map((entry) => entry.dataset.sessionId)),
      [third, second],
    );
    await page.locator(`[data-session-id="${third}"]`).getByRole('link').click();
    await page.locator('.stream-facts').waitFor();
    await page.goBack();
    await day.waitFor();
    await reload(page);
    await day.waitFor();
    assert.equal(await day.getAttribute('aria-pressed'), 'true');

    // Keep one request unresolved while choosing another day.
    let unblock;
    const blocked = new Promise((resolve) => (unblock = resolve));
    let requested;
    const requestStarted = new Promise((resolve) => (requested = resolve));
    await page.route(
      '**/api/v1/sessions?day=2025-11-01',
      async (route) => {
        requested();
        await blocked;
        await route.continue().catch(() => {});
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: '1 ноября, эфиров: 1', exact: true }).click();
    try {
      await requestStarted;
      await page.getByRole('button', { name: '3 ноября, без эфиров', exact: true }).click();
      await page.getByText('В этот день стримов не было').waitFor();
    } finally {
      unblock();
    }
    assert.equal(new URL(page.url()).searchParams.get('day'), '2025-11-03');
    await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
    await page.getByRole('button', { name: '1 октября, без эфиров', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('day'), '2025-10-01');
    await page.getByRole('button', { name: 'Следующий месяц' }).click();
    await page.getByRole('button', { name: '1 ноября, эфиров: 1', exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await app.db.call('mergeSessions', [first, second]);
    const read = (path) => page.request.get(app.origin + '/api/v1/' + path);
    assert.deepEqual(await (await read('sessions/calendar?month=2025-11')).json(), [
      { day: '2025-11-01', count: 1 },
      { day: '2025-11-02', count: 1 },
    ]);
    assert.deepEqual(await (await read('sessions/calendar?month=2025-10')).json(), []);
    assert.equal((await read('sessions/calendar?month=2025-13')).status(), 400);
    assert.equal((await read('sessions?day=2025-02-30')).status(), 400);
    await saveCoverage(page);
  } finally {
    await browser?.close();
    await app.close();
  }
});
