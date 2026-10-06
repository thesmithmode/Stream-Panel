import lib from "istanbul-lib-coverage";
import converter from "v8-to-istanbul";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
export async function startCoverage(page) {
  if (process.env.STREAM_PANEL_COVERAGE)
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
}
export async function saveCoverage(page) {
  if (!process.env.STREAM_PANEL_COVERAGE) return;
  const result = lib.createCoverageMap({});
  for (const entry of await page.coverage.stopJSCoverage()) {
    const pathname = new URL(entry.url).pathname;
    if (!pathname.startsWith("/assets/") || !pathname.endsWith(".js")) continue;
    const c = converter(resolve("apps/web/dist", "." + pathname), 0, {
      source: entry.source,
    });
    await c.load();
    c.applyCoverage(entry.functions);
    // Dependencies are outside the established runtime scope; avoid writing them
    // to every checkpoint (particularly expensive on Windows CI filesystems).
    const root = resolve("apps/web/src") + sep;
    for (const [path, data] of Object.entries(c.toIstanbul()))
      if (resolve(path).startsWith(root))
        result.addFileCoverage({ ...data, path: resolve(path) });
  }
  await mkdir("coverage/browser", { recursive: true });
  await writeFile(
    `coverage/browser/${randomUUID()}.json`,
    JSON.stringify(result.toJSON()),
  );
}
// Recent Chromium can discard precise-coverage data with a destroyed document.
// Persist before navigation, then instrument the next document from its first script.
export async function goto(page, url) {
  await saveCoverage(page);
  await startCoverage(page);
  return page.goto(url);
}
export async function reload(page) {
  await saveCoverage(page);
  await startCoverage(page);
  return page.reload();
}
