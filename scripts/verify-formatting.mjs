import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const current = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'stream-panel-format-qa-'));
const baseline = join(temp, 'baseline');
const head = 'aae13387c8c5e7113762bd1ca94c5c0df31fe3eb';
const fixture = 'packages/core/test/fixtures/analytics-characterization.json';
const browserTest = 'tests/e2e/partial-viewers.test.mjs';
const browserCopy = 'tests/e2e/prettier-screenshot-check.test.mjs';
const shotPaths = ['sp-partial-stream-390.png', 'sp-partial-analytics-390.png', 'sp-partial-analytics-1280.png'];
const take = (dir, command, args, env = {}) =>
  execFileSync(command, args, { cwd: dir, stdio: 'inherit', env: { ...process.env, ...env } });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  mkdirSync(baseline);
  take(current, 'git', ['fetch', '--depth=1', 'origin', head]);
  const archive = join(temp, 'baseline.tar');
  take(current, 'git', ['archive', '--output', archive, head]);
  take(baseline, 'tar', ['-xf', archive]);
  symlinkSync(resolve('node_modules'), join(baseline, 'node_modules'), 'dir');
  const browser = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
  if (!browser) take(current, 'pnpm', ['exec', 'playwright', 'install', '--with-deps', 'chromium']);
  const screenshotTest = readFileSync(join(baseline, browserTest), 'utf8')
    .replace('page.setDefaultTimeout(8000);', "page.setDefaultTimeout(8000);await page.clock.setFixedTime(new Date('2026-11-21T21:45:00Z'));")
    .replaceAll('fullPage:true', "fullPage:true,animations:'disabled',caret:'hide'");
  const shots = [];
  for (const dir of [baseline, current]) {
    take(dir, 'pnpm', ['build'], { STREAM_PANEL_RELEASE: 'prettier-validation' });
    const expected = readFileSync(join(dir, fixture));
    take(dir, process.execPath, ['--test', 'dist/packages/core/test/analytics-characterization.test.js'], {
      STREAM_PANEL_WRITE_CHARACTERIZATION: '1',
    });
    const generated = readFileSync(join(dir, fixture));
    assert.ok(generated.equals(expected), 'Characterization bytes changed at ' + dir);
    console.log('CHARACTERIZATION', digest(generated), Object.keys(JSON.parse(generated)).length, 'cases');
    writeFileSync(join(dir, browserCopy), screenshotTest);
    try {
      take(dir, process.execPath, ['--test', browserCopy], {
        STREAM_PANEL_QA_SCREENSHOTS: '1',
        ...(browser ? { STREAM_PANEL_TEST_CHROMIUM: browser } : {}),
      });
      shots.push(shotPaths.map((name) => readFileSync('/tmp/' + name)));
    } finally {
      rmSync(join(dir, browserCopy), { force: true });
    }
  }
  let equal = true;
  for (const [index, name] of shotPaths.entries()) {
    const [before, after] = [shots[0][index], shots[1][index]];
    const matches = before.equals(after);
    console.log('SCREENSHOT', name, matches ? 'MATCH' : 'DIFF', digest(before), digest(after));
    equal &&= matches;
  }
  assert.ok(equal, 'Screenshot bytes changed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
