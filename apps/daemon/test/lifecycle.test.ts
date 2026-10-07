import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLock,
  parseLock,
  isProcessAlive,
  readLock,
  stopLockedDaemon,
  wantsStop,
  LOCK_NAME,
} from "../src/lifecycle.js";

test("parseLock accepts pid-only and pid+port; rejects garbage", () => {
  assert.deepEqual(parseLock("12345"), { pid: 12345, port: null });
  assert.deepEqual(parseLock("12345\n47831\n"), { pid: 12345, port: 47831 });
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("nope"), null);
  // Invalid port line is ignored; pid still usable for alive-check / stop.
  assert.deepEqual(parseLock("12\n99"), { pid: 12, port: null });
});

test("formatLock round-trips", () => {
  const raw = formatLock(42, 47831);
  assert.deepEqual(parseLock(raw), { pid: 42, port: 47831 });
});

test("isProcessAlive sees current pid and not a dead one", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2_147_483_646), false);
});

test("wantsStop reads env and argv", () => {
  assert.equal(wantsStop(["node", "index.js"], {}), false);
  assert.equal(wantsStop(["node", "index.js", "--stop"], {}), true);
  assert.equal(
    wantsStop(["node", "index.js"], { STREAM_PANEL_STOP: "1" }),
    true,
  );
  assert.equal(
    wantsStop(["node", "index.js"], { STREAM_PANEL_STOP: "true" }),
    true,
  );
});

test("readLock returns null when missing; parses when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-readlock-"));
  try {
    assert.equal(await readLock(dir), null);
    await writeFile(join(dir, LOCK_NAME), formatLock(7, 47831), {
      mode: 0o600,
    });
    assert.deepEqual(await readLock(dir), { pid: 7, port: 47831 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock file written shape matches formatLock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-lock-"));
  try {
    await writeFile(join(dir, LOCK_NAME), formatLock(7, 47831), {
      mode: 0o600,
    });
    const raw = await readFile(join(dir, LOCK_NAME), "utf8");
    assert.deepEqual(parseLock(raw), { pid: 7, port: 47831 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: not_running when no lock or dead pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-miss-"));
  try {
    assert.equal(await stopLockedDaemon(dir, 200, async () => {}), "not_running");
    await writeFile(join(dir, LOCK_NAME), formatLock(2_147_483_646, 47831), {
      mode: 0o600,
    });
    assert.equal(await stopLockedDaemon(dir, 200, async () => {}), "not_running");
    await assert.rejects(readFile(join(dir, LOCK_NAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: stopped when kill succeeds and pid dies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-ok-"));
  try {
    const fakePid = 424242;
    await writeFile(join(dir, LOCK_NAME), formatLock(fakePid, 47831), {
      mode: 0o600,
    });
    // Override alive check by using a real child that exits on SIGTERM.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    await writeFile(join(dir, LOCK_NAME), formatLock(child.pid!, 47831), {
      mode: 0o600,
    });
    const result = await stopLockedDaemon(dir, 5000);
    assert.equal(result, "stopped");
    await assert.rejects(readFile(join(dir, LOCK_NAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: timeout when process stays alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-to-"));
  try {
    await writeFile(join(dir, LOCK_NAME), formatLock(process.pid, 47831), {
      mode: 0o600,
    });
    const killFn = () => {
      /* do not actually kill the test runner */
    };
    const result = await stopLockedDaemon(dir, 150, async () => {}, killFn);
    assert.equal(result, "timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: ESRCH from killFn treated as not_running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-esrch-"));
  try {
    await writeFile(join(dir, LOCK_NAME), formatLock(process.pid, 47831), {
      mode: 0o600,
    });
    const killFn = () => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };
    assert.equal(
      await stopLockedDaemon(dir, 200, async () => {}, killFn),
      "not_running",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
