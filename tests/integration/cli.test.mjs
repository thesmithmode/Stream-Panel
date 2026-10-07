import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, unlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
async function port() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}
function start(dir, p, extraEnv = {}) {
  const child = spawn(process.execPath, ["dist/apps/daemon/src/index.js"], {
    env: {
      ...process.env,
      STREAM_PANEL_DATA_DIR: dir,
      STREAM_PANEL_PORT: String(p),
      STREAM_PANEL_NO_BROWSER: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const exit = new Promise((r) =>
    child.on("exit", (code, signal) => r({ code, signal, stdout, stderr })),
  );
  return {
    child,
    exit,
    getStdout: () => stdout,
    ready: async () => {
      const deadline = Date.now() + 20000;
      while (!stdout.includes("Stream Panel: ")) {
        if (child.exitCode !== null) throw new Error(stderr || stdout);
        if (Date.now() > deadline) throw new Error("CLI_START_TIMEOUT");
        await new Promise((r) => setTimeout(r, 10));
      }
      return stdout.split("Stream Panel: ")[1].split("\n")[0];
    },
  };
}
test(
  "real entrypoint: protected UI, kill-on-relaunch, IPC graceful shutdown and restart",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-cli-"));
    const p = await port();
    const running = start(dir, p);
    const children = [running];
    let deadline;
    try {
      const url = await running.ready();
      const key = new URL(url).hash.slice(5);
      const response = await fetch(`http://127.0.0.1:${p}/api/v1/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      assert.equal(response.status, 200);
      const html = await fetch(`http://127.0.0.1:${p}/`);
      assert.match(await html.text(), /<title>Stream Panel<\/title>/);

      // Second start: graceful kill old → new process + fresh bootstrap (same port).
      const duplicate = start(dir, p);
      children.push(duplicate);
      const relaunchedUrl = await duplicate.ready();
      assert.match(relaunchedUrl, /^http:\/\/127\.0\.0\.1/);
      assert.match(duplicate.getStdout(), /Останавливаю старый процесс/);

      const oldExit = await Promise.race([
        running.exit,
        new Promise(
          (_, reject) =>
            (deadline = setTimeout(
              () => reject(new Error("OLD_DAEMON_STOP_TIMEOUT")),
              10000,
            )),
        ),
      ]);
      clearTimeout(deadline);
      assert.ok(oldExit.code === 0 || oldExit.signal === "SIGTERM");

      await access(join(dir, "daemon.lock"));
      await access(join(dir, "data.sqlite"));

      // Explicit stop via STREAM_PANEL_STOP
      const stopper = start(dir, p, { STREAM_PANEL_STOP: "1" });
      children.push(stopper);
      const stopResult = await stopper.exit;
      assert.equal(stopResult.code, 0);
      assert.match(stopResult.stdout, /остановлен|не запущен/i);
      await assert.rejects(access(join(dir, "daemon.lock")));

      const again = start(dir, p);
      children.push(again);
      await again.ready();
      again.child.send("shutdown");
      assert.equal((await again.exit).code, 0);
    } finally {
      clearTimeout(deadline);
      for (const child of children) child.child.kill();
      await Promise.all(children.map((child) => child.exit));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "entrypoint rejects invalid port, recovers stale lock and fails safely on corrupt configuration",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-cli-fault-"));
    try {
      const invalid = start(dir, 80);
      assert.equal((await invalid.exit).code, 1);
      assert.match((await invalid.exit).stderr, /INVALID_PORT/);
      await writeFile(join(dir, "daemon.lock"), String(invalid.child.pid));
      const recovered = start(dir, await port());
      try {
        await recovered.ready();
        recovered.child.send("ignored");
        recovered.child.send("shutdown");
        assert.equal((await recovered.exit).code, 0);
      } finally {
        recovered.child.kill();
        await recovered.exit;
      }
      await writeFile(join(dir, "daemon.lock"), "not-a-pid");
      const locked = start(dir, await port());
      assert.match((await locked.exit).stderr, /DATA_DIR_ALREADY_IN_USE/);
      await unlink(join(dir, "daemon.lock"));
      await writeFile(join(dir, "secrets.json"), "{");
      const bad = start(dir, await port());
      assert.equal((await bad.exit).code, 1);
      assert.match((await bad.exit).stderr, /SyntaxError/);
      await assert.rejects(access(join(dir, "daemon.lock")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
