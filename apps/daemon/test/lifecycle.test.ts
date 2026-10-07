import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLock,
  parseLock,
  isProcessAlive,
  requestReopen,
  startReopenWatcher,
  wantsStop,
  LOCK_NAME,
  REOPEN_RESPONSE,
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
});

test("reopen watcher answers requestReopen with matching nonce URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-reopen-"));
  try {
    let n = 0;
    const stop = startReopenWatcher(
      dir,
      () => {
        n += 1;
        return `http://127.0.0.1:47831/#key=deadbeef${n}`;
      },
      50,
    );
    const url = await requestReopen(dir, 3000, (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    );
    stop();
    assert.ok(url);
    assert.match(url!, /^http:\/\/127\.0\.0\.1:47831\/#key=deadbeef/);
    // stale response file should be cleaned by successful request
    await assert.rejects(readFile(join(dir, REOPEN_RESPONSE)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requestReopen times out when no daemon answers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-reopen-miss-"));
  try {
    const url = await requestReopen(dir, 300, async () => {});
    assert.equal(url, null);
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
