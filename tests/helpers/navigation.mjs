/** Use the main navigation for every section on desktop and mobile. */
export async function navigate(page, name) {
  if (name === 'Итоги канала') name = 'Обзор';
  await page
    .getByRole('navigation', { name: 'Разделы', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}
export async function analyticsTab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
}
export async function openFilters(page) {
  if (!(await page.getByRole('dialog', { name: 'Фильтры аналитики', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
}
export async function closeFilters(page) {
  if (await page.getByRole('dialog', { name: 'Фильтры аналитики', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
}
export async function setFilter(page, label, value) {
  if (label === 'Период аналитики') {
    await closeFilters(page);
    await page
      .locator('.analytics-toolbar')
      .getByRole('button', {
        name: value === 'custom' ? 'Свои даты' : value === 'all' ? 'Всё время' : `${value} дней`,
        exact: true,
      })
      .click();
    await closeFilters(page);
    return;
  }
  await openFilters(page);
  if (label === 'Часовой пояс сравнения' && !(await page.getByLabel(label).isVisible()))
    await page.getByText('Отображение и часовой пояс', { exact: true }).click();
  await page.getByLabel(label, { exact: true }).selectOption(value);
  await closeFilters(page);
}
export async function clockSettings(page) {
  const details = page.locator('.clock-settings');
  if (!(await details.getAttribute('open').then((x) => x !== null))) await details.locator('summary').click();
}
function refreshControls(page) {
  return page.viewportSize().width > 720
    ? page.locator('.sidebar-refresh')
    : page.getByRole('dialog', { name: 'Обновление данных', exact: true });
}
export async function withRefresh(page, work) {
  if (page.viewportSize().width > 720) {
    await page.locator('.sidebar-refresh').waitFor({ state: 'visible' });
    return await work();
  }
  const sheet = page.getByRole('dialog', { name: 'Обновление данных', exact: true });
  const isOpen = async () => (await sheet.getAttribute('open').catch(() => null)) !== null;
  if (!(await isOpen())) await page.getByRole('button', { name: 'Обновление данных', exact: true }).click();
  try {
    return await work();
  } finally {
    if (await isOpen()) await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
}
export async function refreshData(page) {
  await withRefresh(page, async () => {
    const button = refreshControls(page).locator('.manual-refresh');
    const refreshed = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/changes');
    await button.click();
    await refreshed;
  });
}
export async function setRefreshInterval(page, value) {
  await withRefresh(page, () => refreshControls(page).getByLabel('Интервал автообновления').selectOption(value));
}
