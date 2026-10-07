import { createApplication } from "./server.js";
import { defaultDataDir } from "./config.js";
import { openBrowser, shouldOpenBrowser } from "./browser-launch.js";
import {
  formatLock,
  isProcessAlive,
  LOCK_NAME,
  parseLock,
  stopLockedDaemon,
  wantsStop,
} from "./lifecycle.js";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  describeRemoteDb,
  resolveDatabaseUrls,
  startRemoteSync,
} from "./remote-db.js";

const dir = defaultDataDir();
const port = Number(process.env.STREAM_PANEL_PORT ?? 47831);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("INVALID_PORT");

await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = join(dir, LOCK_NAME);

if (wantsStop()) {
  const result = await stopLockedDaemon(dir);
  if (result === "not_running") {
    console.log("Stream Panel не запущен.");
    process.exit(0);
  }
  if (result === "timeout") {
    console.error(
      "Не дождались остановки. Проверьте процесс вручную и удалите daemon.lock при необходимости.",
    );
    process.exit(1);
  }
  console.log("Stream Panel остановлен.");
  process.exit(0);
}

// The local listening port prevents a second app instance; the file also guards a shared data-dir on another port.
let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  const raw = await readFile(lockPath, "utf8");
  const info = parseLock(raw);
  const pid = info?.pid ?? Number(raw.trim().split(/\r?\n/)[0]);
  const active =
    info !== null
      ? isProcessAlive(info.pid)
      : Number.isInteger(pid) && pid > 0
        ? isProcessAlive(pid)
        : true;
  if (active && info) {
    console.log(
      `Stream Panel уже запущен (PID ${info.pid}). Останавливаю старый процесс и поднимаю новый…`,
    );
    const stopped = await stopLockedDaemon(dir);
    if (stopped === "timeout") {
      console.error(
        "Не дождались остановки предыдущего процесса. Остановите его вручную и повторите запуск.",
      );
      throw new Error("DATA_DIR_ALREADY_IN_USE");
    }
  } else if (active || !info) {
    throw new Error("DATA_DIR_ALREADY_IN_USE");
  } else {
    await unlink(lockPath).catch(() => {});
  }
  lock = await open(lockPath, "wx", 0o600);
}
await lock.writeFile(formatLock(process.pid, port));
await lock.close();

try {
  const remoteUrls = await resolveDatabaseUrls(process.env);
  const remote = describeRemoteDb(process.env, remoteUrls);
  if (remote.configured)
    console.log(
      `Удалённая БД: ${remote.kind}${remote.hostHint ? " @ " + remote.hostHint : ""} (prefer pooler; sync lean).`,
    );
  const application = await createApplication(dir, port);
  await application.app.listen({ host: "127.0.0.1", port });
  const stopRemoteSync = startRemoteSync({ dataDir: dir });
  const url = application.bootstrap();
  console.log(`Stream Panel: ${url}`);
  console.log(
    "Интерфейс открывается в браузере. Токен одноразовый; повторный запуск остановит старый процесс и откроет новую ссылку.",
  );
  console.log(
    "Закрытие вкладки не останавливает сбор. Остановка: Ctrl+C здесь или STREAM_PANEL_STOP=1 pnpm start",
  );
  if (shouldOpenBrowser()) openBrowser(url);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    stopRemoteSync();
    void application.app
      .close()
      .then(() => unlink(lockPath))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, shutdown);
  // A desktop launcher can request the same graceful shutdown on Windows via IPC.
  if (process.connected)
    process.on("message", (message) => {
      if (message === "shutdown") shutdown();
    });
} catch (error) {
  await unlink(lockPath).catch(() => {});
  throw error;
}
