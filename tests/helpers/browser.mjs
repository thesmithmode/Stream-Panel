import { chromium } from "playwright";
export async function launchBrowser() {
  const executablePath = process.env.STREAM_PANEL_TEST_CHROMIUM;
  return chromium.launch({
    headless: true,
    ...(executablePath
      ? {
          executablePath,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        }
      : {}),
  });
}
