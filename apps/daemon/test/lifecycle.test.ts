import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  formatLock,
  parseLock,
  isProcessAlive,
  readLock,
  stopLockedDaemon,
  wantsStop,
  looksLikeStreamPanelDaemon,
  LOCK_NAME,
} from "../src/lifecycle.js";

const ourInspect = {
  cmdline: () => "node dist/apps/daemon/src/index.js",
};
const foreignInspect = {
  cmdline: () => "/usr/bin/python3 /tmp/unrelated.py",
};
const unknownInspect = {
  cmdline: () => null,
};

test("parseLock accepts pid-only and pid+port; rejects garbage", () => {
  assert.deepEqual(parseLock("12345"), { pid: 12345, port: null });
  assert.deepEqual(parseLock("12345\n47831\n"), { pid: 12345, port: 47831 });
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("nope"), null);
  assert.deepEqual(parseLock("12\n99"), { pid: 12, port: null });
});

test("formatLock round-trips", () => {
  assert.deepEqual(parseLock(formatLock(42, 47831)), { pid: 42, port: 47831 });
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
});

test("looksLikeStreamPanelDaemon matches daemon cmdline", () => {
  assert.equal(
    looksLikeStreamPanelDaemon(1, 47831, ourInspect),
    true,
  );
  assert.equal(
    looksLikeStreamPanelDaemon(1, 47831, foreignInspect),
    false,
  );
  assert.equal(
    looksLikeStreamPanelDaemon(1, 47831, unknownInspect),
    null,
  );
});

test("readLock returns null when missing; parses when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-readlock-"));
  try {
    assert.equal(await readLock(dir), null);
    await writeFile(join(dir, LOCK_NAME), formatLock(7, 47831), { mode: 0o600 });
    assert.deepEqual(await readLock(dir), { pid: 7, port: 47831 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: not_running when no lock or dead pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-miss-"));
  try {
    assert.equal(
      await stopLockedDaemon(dir, 200, async () => {}, () => {}, ourInspect),
      "not_running",
    );
    await writeFile(join(dir, LOCK_NAME), formatLock(2_147_483_646, 47831), {
      mode: 0o600,
    });
    assert.equal(
      await stopLockedDaemon(dir, 200, async () => {}, () => {}, ourInspect),
      "not_running",
    );
    await assert.rejects(readFile(join(dir, LOCK_NAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: stale lock with foreign PID clears lock without kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-stale-"));
  try {
    await writeFile(join(dir, LOCK_NAME), formatLock(process.pid, 47831), {
      mode: 0o600,
    });
    let killed = false;
    const result = await stopLockedDaemon(
      dir,
      200,
      async () => {},
      () => {
        killed = true;
      },
      foreignInspect,
    );
    assert.equal(result, "not_running");
    assert.equal(killed, false);
    await assert.rejects(readFile(join(dir, LOCK_NAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopLockedDaemon: stopped when kill succeeds and pid dies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-stop-ok-"));
  try {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    await writeFile(join(dir, LOCK_NAME), formatLock(child.pid!, 47831), {
      mode: 0o600,
    });
    const result = await stopLockedDaemon(
      dir,
      5000,
      undefined,
      undefined,
      ourInspect,
    );
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
    const result = await stopLockedDaemon(
      dir,
      150,
      async () => {},
      () => {},
      ourInspect,
    );
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
      await stopLockedDaemon(dir, 200, async () => {}, killFn, ourInspect),
      "not_running",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
