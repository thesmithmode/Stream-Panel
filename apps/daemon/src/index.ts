import { createHostedApplication } from "./hosted.js";
import { parseHostedNetworkConfig } from "./hosted-network.js";
import { mkdir, access, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FrontendProcess} from './frontend-process.js';

const dir = process.env.STREAM_PANEL_DATA_DIR;
const origin = process.env.STREAM_PANEL_PUBLIC_ORIGIN;
const port = Number(process.env.STREAM_PANEL_PORT ?? 47831);
if (!dir) throw new Error("DATA_DIR_REQUIRED");
if (!origin) throw new Error("PUBLIC_ORIGIN_REQUIRED");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PORT");
const network = parseHostedNetworkConfig(
  process.env.STREAM_PANEL_BIND_HOST,
  process.env.STREAM_PANEL_TRUSTED_PROXY,
);
const split=process.env.NODE_ENV==='production'||process.env.STREAM_PANEL_SPLIT_PROCESSES==='true';
const collectorPort=split?Number(process.env.STREAM_PANEL_COLLECTOR_PORT??port+1):port;
if(!Number.isInteger(collectorPort)||collectorPort<1024||collectorPort>65535||(split&&collectorPort===port))throw new Error('INVALID_COLLECTOR_PORT');
const collectorNetwork=split?{bindHost:'127.0.0.1',trustedProxies:[...new Set([...network.trustedProxies,'127.0.0.1'])]}:network;
const releaseName = basename(await realpath(process.cwd()));
process.env.STREAM_PANEL_RELEASE ??= /^[a-f0-9]{40}$/.test(releaseName) ? releaseName : "development";
await mkdir(dir, { recursive: true, mode: 0o700 });
const backupOptions = process.env.STREAM_PANEL_BACKUP_KEY_FILE ? {
  keyFile: process.env.STREAM_PANEL_BACKUP_KEY_FILE,
  ...(process.env.STREAM_PANEL_SUPABASE_URL ? {url: process.env.STREAM_PANEL_SUPABASE_URL} : {}),
  ...(process.env.STREAM_PANEL_SUPABASE_KEY_FILE ? {serviceKeyFile: process.env.STREAM_PANEL_SUPABASE_KEY_FILE} : {}),
} : undefined;
const hosted = await createHostedApplication(dir, origin, false, backupOptions, collectorNetwork,!split);
const frontend=split?new FrontendProcess(join(dirname(fileURLToPath(import.meta.url)),'../../../../apps/web/dist'),collectorPort,port,origin,network):undefined;
const runBackup = async () => {
  try {
    const result = await hosted.backup?.run();
    if (result?.cloudError) console.error("Cloud backup failed; local copy saved; see protected status");
  } catch { console.error("Backup failed; see protected status"); }
};
try {
  await hosted.app.listen({ host: collectorNetwork.bindHost, port:collectorPort });
  await frontend?.start();
} catch (error) { await frontend?.stop();await hosted.app.close(); throw error; }
let closing = false, collectorsStarted = false;
const startCollectors = async () => {
  if (collectorsStarted || closing) return;
  for (const marker of ["deploying", "initializing"]) {
    try { await access(join(dir, marker)); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { console.error("Maintenance state unavailable; collectors remain stopped"); return; } }
  }
  collectorsStarted = true;
  await Promise.all([...hosted.runtimes.values()].map(runtime=>runtime.db.call("collectionLifecycle","start",Date.now())));
  void runBackup();
  for (const runtime of hosted.runtimes.values()) {
    void runtime.twitch.start(); void runtime.da.start(); void runtime.youtube.start();
  }
};
await startCollectors();
const backupTimer = setInterval(() => { if (collectorsStarted) void runBackup(); }, 12 * 60 * 60 * 1000);
const retentionTimer=setInterval(()=>{void hosted.backup?.purgeLocal().catch(()=>console.error('Local backup cleanup failed'));},60*60*1000);
const heartbeatTimer=setInterval(()=>{if(collectorsStarted&&!closing)for(const runtime of hosted.runtimes.values())void runtime.db.call("collectionLifecycle","heartbeat",Date.now()).catch(()=>console.error("Collector heartbeat failed"));},30000);
const timer = setInterval(() => void startCollectors(), 2000);
const shutdown = async () => {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(backupTimer);clearInterval(retentionTimer);clearInterval(heartbeatTimer);
  const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
  try { if(collectorsStarted)await Promise.all([...hosted.runtimes.values()].map(runtime=>runtime.db.call("collectionLifecycle","stop",Date.now())));await frontend?.stop();await hosted.app.close(); clearTimeout(timeout); process.exit(0); }
  catch { process.exit(1); }
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());

// Readiness includes installed signal handlers, so immediate shutdown closes SQLite.
console.log(`Stream Panel server listening on ${network.bindHost}:${port}`);
