import { spawn, type ChildProcess } from "node:child_process";

/** Whether the daemon should auto-open the UI in a system browser after listen. */
export function shouldOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.STREAM_PANEL_NO_BROWSER === "1") return false;
  if (env.STREAM_PANEL_HEADLESS === "1") return false;
  const ci = env.CI;
  if (ci === "1" || ci === "true") return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    detached: boolean;
    stdio: "ignore";
    windowsHide?: boolean;
  },
) => ChildProcess;

/** Best-effort open of `url` in the platform default browser. */
export function openBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    spawnFn?: SpawnFn;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  try {
    let child: ChildProcess;
    if (platform === "win32") {
      child = spawnFn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (platform === "darwin") {
      child = spawnFn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawnFn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    /* browser open is best-effort */
  }
}
