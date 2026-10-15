import { createHostedApplication } from "./hosted.js";
import { parseHostedNetworkConfig } from "./hosted-network.js";
import { mkdir, access, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FrontendProcess} from './frontend-process.js';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {analyticsSettings} from './analytics-settings.js';
import {activatePendingRestore} from './restore-service.js';

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
  ...(process.env.STREAM_PANEL_SUPABASE_URL ? {url: process.env.STREAM_PANEL_SUPABASE_URL,cloudBudgetBytes:Number(process.env.STREAM_PANEL_CLOUD_BACKUP_BUDGET_BYTES??1000000000)} : {}),
  ...(process.env.STREAM_PANEL_SUPABASE_KEY_FILE ? {serviceKeyFile: process.env.STREAM_PANEL_SUPABASE_KEY_FILE} : {}),
} : undefined;
if(existsSync(join(dir,'restore-pending'))||existsSync(join(dir,'restoring'))){
  const reservation=createServer();
  await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(collectorPort,collectorNetwork.bindHost,resolve);});
  try{await activatePendingRestore(dir);}finally{await new Promise<void>(resolve=>reservation.close(()=>resolve()));}
}
const hosted = await createHostedApplication(dir, origin, false, backupOptions, collectorNetwork,!split,()=>{setTimeout(()=>void shutdown(75),250);});
const frontend=split?new FrontendProcess(join(dirname(fileURLToPath(import.meta.url)),'../../../../apps/web/dist'),collectorPort,port,origin,network):undefined;
const runBackup = async () => {
  try {
    for(const marker of ['deploying','initializing','restoring','restore-pending']){
      try{await access(join(dir,marker));return;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    await hosted.backup?.retryPending();
    const result = await hosted.backup?.runIfDue();
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
  // Promotion can clear maintenance between scheduler ticks; recheck backup immediately.
  void runBackup();
  await Promise.all([...hosted.runtimes.values()].map(runtime=>runtime.db.call("collectionLifecycle","start",Date.now())));
  for (const runtime of hosted.runtimes.values()) {
    void runtime.twitch.start(); void runtime.da.start(); void runtime.youtube.start();
  }
};
await startCollectors();
void runBackup();
// Check persisted due time and retry backoff; collecting platforms is independent.
const backupTimer = setInterval(() => { if(!closing)void runBackup(); }, 60000);
const retentionTimer=setInterval(()=>{void hosted.backup?.purgeLocal().catch(()=>console.error('Local backup cleanup failed'));},60*60*1000);
const heartbeatTimer=setInterval(()=>{if(collectorsStarted&&!closing)for(const runtime of hosted.runtimes.values())void runtime.db.call("collectionLifecycle","heartbeat",Date.now()).catch(()=>console.error("Collector heartbeat failed"));},30000);
const analyticsTimer=setInterval(()=>{
 if(closing||!collectorsStarted)return;
 for(const runtime of hosted.runtimes.values()){
  const cfg=runtime.configuration.value;
  void runtime.db.call('warmAnalytics',{...analyticsSettings(cfg.analyticsSettings),fromMs:0,toMs:Date.now(),excludedLogins:cfg.excludedBotLogins,ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''}).catch(()=>console.error('Historical analytics preparation failed'));
 }
},60000);
const timer = setInterval(() => void startCollectors(), 2000);
const shutdown = async (code=0) => {
  if (closing) return;
  closing = true; clearInterval(timer); clearInterval(backupTimer);clearInterval(retentionTimer);clearInterval(heartbeatTimer);clearInterval(analyticsTimer);
  const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
  try { if(collectorsStarted)await Promise.allSettled([...hosted.runtimes.values()].map(runtime=>runtime.db.call("collectionLifecycle","stop",Date.now())));await frontend?.stop();await hosted.app.close(); clearTimeout(timeout); process.exit(code); }
  catch { process.exit(1); }
};
for(const runtime of hosted.runtimes.values())runtime.db.setFatalHandler(()=>{console.error('Database worker stopped; restarting service');void shutdown(1);});

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());

// Readiness includes installed signal handlers, so immediate shutdown closes SQLite.
console.log(`Stream Panel server listening on ${network.bindHost}:${port}`);
