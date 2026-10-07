import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_NAME = "daemon.lock";
export const REOPEN_REQUEST = "reopen.request";
export const REOPEN_RESPONSE = "reopen.response";

export type LockInfo = { pid: number; port: number | null };

/** Parse lock file: "pid" or "pid\\nport". */
export function parseLock(content: string): LockInfo | null {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid < 1) return null;
  let port: number | null = null;
  if (lines[1] !== undefined) {
    const p = Number(lines[1]);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) port = p;
  }
  return { pid, port };
}

export function formatLock(pid: number, port: number): string {
  return `${pid}\n${port}\n`;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readLock(dataDir: string): Promise<LockInfo | null> {
  try {
    return parseLock(await readFile(join(dataDir, LOCK_NAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Ask a running daemon (same data dir) for a fresh bootstrap URL.
 * Protocol: write reopen.request with nonce; daemon writes reopen.response "nonce\\nurl".
 */
export async function requestReopen(
  dataDir: string,
  timeoutMs = 8000,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
  const nonce = randomBytes(16).toString("hex");
  const reqPath = join(dataDir, REOPEN_REQUEST);
  const resPath = join(dataDir, REOPEN_RESPONSE);
  await unlink(resPath).catch(() => {});
  await writeFile(reqPath, `${nonce}\n`, { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(resPath, "utf8");
      const [got, urlLine] = raw.split(/\r?\n/);
      const url = (urlLine ?? "").trim();
      if (got?.trim() === nonce && /^https?:\/\/127\.0\.0\.1:\d+\/#key=/.test(url)) {
        await unlink(resPath).catch(() => {});
        return url;
      }
    } catch {
      /* not ready */
    }
    await sleep(100);
  }
  await unlink(reqPath).catch(() => {});
  return null;
}

/** Poll reopen.request and answer with a fresh bootstrap URL. */
export function startReopenWatcher(
  dataDir: string,
  bootstrap: () => string,
  intervalMs = 250,
): () => void {
  let stopped = false;
  const reqPath = join(dataDir, REOPEN_REQUEST);
  const resPath = join(dataDir, REOPEN_RESPONSE);
  const tick = async () => {
    if (stopped) return;
    try {
      const raw = await readFile(reqPath, "utf8");
      const nonce = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (!/^[a-f0-9]{16,64}$/i.test(nonce)) {
        await unlink(reqPath).catch(() => {});
        return;
      }
      await unlink(reqPath).catch(() => {});
      const url = bootstrap();
      await writeFile(resPath, `${nonce}\n${url}\n`, { mode: 0o600 });
    } catch {
      /* no request */
    }
  };
  const id = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

/** Signal the locked daemon to exit; wait until lock is gone or PID dies. */
export async function stopLockedDaemon(
  dataDir: string,
  timeoutMs = 10000,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<"stopped" | "not_running" | "timeout"> {
  const info = await readLock(dataDir);
  if (!info) return "not_running";
  if (!isProcessAlive(info.pid)) {
    await unlink(join(dataDir, LOCK_NAME)).catch(() => {});
    return "not_running";
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      await unlink(join(dataDir, LOCK_NAME)).catch(() => {});
      return "not_running";
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      await unlink(join(dataDir, LOCK_NAME)).catch(() => {});
      return "stopped";
    }
    const still = await readLock(dataDir);
    if (!still || still.pid !== info.pid) return "stopped";
    await sleep(100);
  }
  return "timeout";
}

export function wantsStop(argv = process.argv, env = process.env): boolean {
  if (env.STREAM_PANEL_STOP === "1" || env.STREAM_PANEL_STOP === "true")
    return true;
  return argv.slice(2).includes("--stop");
}
