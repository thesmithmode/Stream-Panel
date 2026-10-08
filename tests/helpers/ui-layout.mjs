import assert from 'node:assert/strict';

// Check actual rendered controls, accounting for collapsed details and clipped scrollers.
export async function assertUiLayout(page) {
  const issues = await page.evaluate(() => {
    const problems = [];
    const rect = element => {
      if (!element.checkVisibility()) return null;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const bounds = {left: box.left, right: box.right, top: box.top, bottom: box.bottom};
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
          bounds.left = Math.max(bounds.left, clip.left); bounds.right = Math.min(bounds.right, clip.right);
        }
        if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
          bounds.top = Math.max(bounds.top, clip.top); bounds.bottom = Math.min(bounds.bottom, clip.bottom);
        }
      }
      return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
    };
    const name = element => (element.getAttribute('aria-label') || element.textContent || element.type).trim().slice(0, 70);
    for (const selector of ['button button', 'button a', 'a button', 'a a', 'form form', 'label label', 'p div', 'table>div', 'tr>div']) {
      if (document.querySelector(selector)) problems.push(`Invalid nesting: ${selector}`);
    }
    const controls = [...document.querySelectorAll('button,input,select,summary')].filter(element => rect(element));
    for (let i = 0; i < controls.length; i++) {
      const element = controls[i], box = element.getBoundingClientRect();
      if (!element.closest('.table-wrap,.table-scroll,.hour-heatmap,.event-list') && (box.left < -0.5 || box.right > innerWidth + 0.5)) {
        problems.push(`Control outside viewport: ${name(element)}`);
      }
      const a = rect(element);
      for (const other of controls.slice(i + 1)) {
        if (element.contains(other) || other.contains(element)) continue;
        const b = rect(other);
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
          problems.push(`Overlapping controls: ${name(element)} / ${name(other)}`);
        }
      }
    }
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = color => color.slice(0, 3).map(value => {
      value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    for (const element of document.querySelectorAll('button,label,p,h1,h2,h3,th,td,small,input,select')) {
      if (!rect(element) || element.closest('button:disabled') || (!element.matches('input,select') && ![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()))) continue;
      const style = getComputedStyle(element); let background;
      for (let parent = element; parent; parent = parent.parentElement) {
        const color = rgb(getComputedStyle(parent).backgroundColor);
        if (color.length === 3 || color[3] === 1) { background = color; break; }
      }
      if (!background || style.opacity !== '1') continue;
      const a = luminance(rgb(style.color)), b = luminance(background), contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (contrast < 3) problems.push(`Unreadable contrast ${contrast.toFixed(2)}: ${name(element)}`);
    }
    return problems;
  });
  assert.deepEqual(issues, [], `UI layout at ${page.viewportSize()?.width}px`);
}
