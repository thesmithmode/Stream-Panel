import { createApplication } from "./server.js";
import { defaultDataDir } from "./config.js";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
const dir = defaultDataDir();
const port = Number(process.env.STREAM_PANEL_PORT ?? 47831);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("INVALID_PORT");
// The local listening port prevents a second app instance; the file also guards a shared data-dir on another port.
const { mkdir } = await import("node:fs/promises");
await mkdir(dir, { recursive: true, mode: 0o700 });
const lockPath = join(dir, "daemon.lock");
let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  const pid = Number(await readFile(lockPath, "utf8"));
  let active = true;
  try {
    process.kill(pid, 0);
  } catch (check) {
    if ((check as NodeJS.ErrnoException).code === "ESRCH") active = false;
  }
  if (active || !Number.isInteger(pid) || pid < 1)
    throw new Error("DATA_DIR_ALREADY_IN_USE");
  await unlink(lockPath);
  lock = await open(lockPath, "wx", 0o600);
}
await lock.writeFile(String(process.pid));
await lock.close();
try {
  const application = await createApplication(dir, port);
  await application.app.listen({ host: "127.0.0.1", port });
  console.log(`Stream Panel: ${application.bootstrap()}`);
  console.log(
    "Откройте ссылку в браузере. Токен одноразовый; повторный запуск выдаст новую ссылку.",
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
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
