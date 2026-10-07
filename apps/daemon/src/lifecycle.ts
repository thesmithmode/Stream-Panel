import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_NAME = "daemon.lock";

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

export type ProcessInspector = {
  cmdline: (pid: number) => string | null;
};

/** Default: read /proc/<pid>/cmdline on Linux; null if unavailable. */
export function defaultCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return null;
  }
}

/**
 * True when cmdline looks like this daemon (stream-panel / apps/daemon entry).
 * If cmdline cannot be read, returns null (unknown) — caller decides.
 */
export function looksLikeStreamPanelDaemon(
  pid: number,
  port: number | null,
  inspect: ProcessInspector = { cmdline: defaultCmdline },
): boolean | null {
  const cmd = inspect.cmdline(pid);
  if (cmd == null) return null;
  const lower = cmd.toLowerCase();
  if (
    lower.includes("stream-panel") ||
    lower.includes("streampanel") ||
    lower.includes("apps/daemon") ||
    lower.includes("dist/apps/daemon")
  )
    return true;
  // Port alone is weak; only accept when cmdline mentions node and our lock port.
  if (
    port != null &&
    lower.includes("node") &&
    (lower.includes(String(port)) || lower.includes("stream_panel_port"))
  )
    return true;
  return false;
}

/**
 * Signal the locked daemon to exit; wait until lock is gone or PID dies.
 * Verifies process image before SIGTERM; stale lock + PID reuse → clear lock.
 */
export async function stopLockedDaemon(
  dataDir: string,
  timeoutMs = 10000,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  killFn: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) =>
    process.kill(pid, signal),
  inspect: ProcessInspector = { cmdline: defaultCmdline },
): Promise<"stopped" | "not_running" | "timeout"> {
  const info = await readLock(dataDir);
  if (!info) return "not_running";
  if (!isProcessAlive(info.pid)) {
    await unlink(join(dataDir, LOCK_NAME)).catch(() => {});
    return "not_running";
  }
  const ours = looksLikeStreamPanelDaemon(info.pid, info.port, inspect);
  if (ours === false) {
    // Stale lock: PID reused by unrelated process — do not kill.
    await unlink(join(dataDir, LOCK_NAME)).catch(() => {});
    return "not_running";
  }
  try {
    killFn(info.pid, "SIGTERM");
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
