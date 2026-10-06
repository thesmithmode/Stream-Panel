import lib from "istanbul-lib-coverage";
import converter from "v8-to-istanbul";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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
    result.merge(c.toIstanbul());
  }
  await mkdir("coverage/browser", { recursive: true });
  await writeFile(
    `coverage/browser/${randomUUID()}.json`,
    JSON.stringify(result.toJSON()),
  );
}
