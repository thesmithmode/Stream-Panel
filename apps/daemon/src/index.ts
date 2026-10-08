import { createHostedApplication } from "./hosted.js";
import { mkdir, access, realpath } from "node:fs/promises";
import { join, basename } from "node:path";

const dir = process.env.STREAM_PANEL_DATA_DIR;
const origin = process.env.STREAM_PANEL_PUBLIC_ORIGIN;
const port = Number(process.env.STREAM_PANEL_PORT ?? 47831);
if (!dir) throw new Error("DATA_DIR_REQUIRED");
if (!origin) throw new Error("PUBLIC_ORIGIN_REQUIRED");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PORT");
const releaseName = basename(await realpath(process.cwd()));
process.env.STREAM_PANEL_RELEASE ??= /^[a-f0-9]{40}$/.test(releaseName) ? releaseName : "development";
await mkdir(dir, { recursive: true, mode: 0o700 });
const backupOptions = process.env.STREAM_PANEL_BACKUP_KEY_FILE ? {
  keyFile: process.env.STREAM_PANEL_BACKUP_KEY_FILE,
  ...(process.env.STREAM_PANEL_SUPABASE_URL ? {url: process.env.STREAM_PANEL_SUPABASE_URL} : {}),
  ...(process.env.STREAM_PANEL_SUPABASE_KEY_FILE ? {serviceKeyFile: process.env.STREAM_PANEL_SUPABASE_KEY_FILE} : {}),
} : undefined;
const hosted = await createHostedApplication(dir, origin, false, backupOptions);
try {
  await hosted.app.listen({ host: "127.0.0.1", port });
  console.log(`Stream Panel server listening on 127.0.0.1:${port}`);
} catch (error) { await hosted.app.close(); throw error; }
let closing = false, collectorsStarted = false;
const startCollectors = async () => {
  if (collectorsStarted || closing) return;
  try { await access(join(dir, "deploying")); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { console.error("Maintenance state unavailable; collectors remain stopped"); return; } }
  collectorsStarted = true;
  void hosted.backup?.run().catch(() => console.error("Backup failed; see protected status"));
  for (const runtime of hosted.runtimes.values()) {
    void runtime.twitch.start(); void runtime.da.start(); void runtime.youtube.start();
  }
};
await startCollectors();
const backupTimer = setInterval(() => { if (collectorsStarted) void hosted.backup?.run().catch(() => console.error("Backup failed; see protected status")); }, 12 * 60 * 60 * 1000);
const timer = setInterval(() => void startCollectors(), 2000);
const shutdown = async () => {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(backupTimer);
  const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
  try { await hosted.app.close(); clearTimeout(timeout); process.exit(0); }
  catch { process.exit(1); }
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());
