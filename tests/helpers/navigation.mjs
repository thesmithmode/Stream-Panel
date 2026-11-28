/** Exercise the same progressive navigation that users see, including the More sheet. */
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
export async function withMore(page, work) {
  await page.locator('.sidebar-refresh').waitFor({ state: 'visible' });
  return await work();
}
export async function refreshData(page) {
  await withMore(page, () => page.getByRole('button', { name: 'Обновить данные', exact: true }).click());
}
export async function setRefreshInterval(page, value) {
  await withMore(page, () => page.getByLabel('Интервал автообновления').selectOption(value));
}
