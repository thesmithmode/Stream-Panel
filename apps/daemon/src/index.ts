import { createApplication } from "./server.js";
import { defaultDataDir } from "./config.js";
import { openBrowser, shouldOpenBrowser } from "./browser-launch.js";
import {
  formatLock,
  isProcessAlive,
  LOCK_NAME,
  parseLock,
  requestReopen,
  startReopenWatcher,
  stopLockedDaemon,
  wantsStop,
} from "./lifecycle.js";
import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

const dir = defaultDataDir();
const port = Number(process.env.STREAM_PANEL_PORT ?? 47831);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("INVALID_PORT");

await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = join(dir, LOCK_NAME);

function printRunningHelp(pid: number): void {
  console.log(
    `Панель уже работает в фоне (PID ${pid}). Закрытие вкладки браузера её не останавливает.`,
  );
  console.log(
    "Остановка: Ctrl+C в том терминале, где запущен Stream Panel, либо:",
  );
  console.log("  STREAM_PANEL_STOP=1 pnpm start");
  console.log("  # или: node dist/apps/daemon/src/index.js --stop");
}

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
      `Stream Panel уже запущен (PID ${info.pid}). Запрашиваю новую ссылку входа…`,
    );
    const url = await requestReopen(dir);
    if (url) {
      console.log(`Stream Panel: ${url}`);
      printRunningHelp(info.pid);
      if (shouldOpenBrowser()) openBrowser(url);
      process.exit(0);
    }
    printRunningHelp(info.pid);
    console.error(
      "Не удалось получить новую ссылку от работающего процесса. Остановите его и запустите снова.",
    );
    throw new Error("DATA_DIR_ALREADY_IN_USE");
  }
  if (active || !info) throw new Error("DATA_DIR_ALREADY_IN_USE");
  await unlink(lockPath);
  lock = await open(lockPath, "wx", 0o600);
}
await lock.writeFile(formatLock(process.pid, port));
await lock.close();

try {
  const application = await createApplication(dir, port);
  await application.app.listen({ host: "127.0.0.1", port });
  const stopReopen = startReopenWatcher(dir, () => application.bootstrap());
  const url = application.bootstrap();
  console.log(`Stream Panel: ${url}`);
  console.log(
    "Интерфейс открывается в браузере. Токен одноразовый; повторный запуск при живом процессе откроет новую ссылку.",
  );
  console.log(
    "Закрытие вкладки не останавливает сбор. Остановка: Ctrl+C здесь или STREAM_PANEL_STOP=1 pnpm start",
  );
  if (shouldOpenBrowser()) openBrowser(url);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    stopReopen();
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
