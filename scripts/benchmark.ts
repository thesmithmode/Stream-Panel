import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { StreamStore } from "../packages/core/src/store.js";

const directory = await mkdtemp(join(tmpdir(), "stream-panel-benchmark-"));
const path = join(directory, "benchmark.sqlite");
const store = new StreamStore(path);
const delay = monitorEventLoopDelay({ resolution: 10 });
const timings: number[] = [];
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * q))
  ]!;
let probe: Database.Database | undefined;
let firstPersonId = "";
delay.enable();
try {
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) {
    const before = performance.now();
    const inserted = store.ingest({
      source: "twitch",
      accountId: "synthetic-channel",
      externalId: `m${i}`,
      type: "chat.message",
      actor: { externalId: `u${i % 1000}`, displayName: `User${i % 1000}` },
      occurredAtMs: 1_790_000_000_000 + i * 100,
      receivedAtMs: 1_790_000_000_001 + i * 100,
      sourceTime: null,
      timeQuality: "provider",
      transport: "eventsub",
      payload: { text: "synthetic message" },
    });
    if (i === 0) firstPersonId = inserted.personId!;
    timings.push(performance.now() - before);
    if (i % 100 === 99) await setImmediate();
  }
  const ingestionElapsedMs = performance.now() - started;
  probe = new Database(path);
  probe.pragma("foreign_keys = ON");
  probe.pragma("synchronous = FULL");
  const sampleStart = Math.floor(1_790_000_000_000 / 60_000) * 60_000;
  const sessionId = store.startSession(
    "synthetic-channel",
    "synthetic-stream",
    sampleStart,
    "platform",
    sampleStart,
  );
  const userIds = Array.from({ length: 1000 }, (_, i) => `u${i}`);
  const batches: number[] = [];
  for (let minute = 0; minute < 480; minute++) {
    const before = performance.now();
    store.recordPoll(sessionId, "synthetic-channel", {
      startedAtMs: sampleStart + minute * 60000,
      completedAtMs: sampleStart + minute * 60000 + 1000,
      status: "complete",
      userIds,
    });
    batches.push(performance.now() - before);
    await setImmediate();
  }
  const queryStarted = performance.now();
  const grid = store.grid(
    sessionId,
    firstPersonId,
    sampleStart,
    sampleStart + 480 * 60000,
  );
  const observed = grid.filter((cell) => cell.state === "observed").length;
  assert.equal(
    observed,
    480,
    "Every complete sample must remain visible in the real grid",
  );
  const presenceQueryMs = performance.now() - queryStarted;
  const integrity = probe.pragma("integrity_check", { simple: true });
  assert.equal(integrity, "ok");
  probe.pragma("wal_checkpoint(TRUNCATE)");
  delay.disable();
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        sqlite: probe.prepare("SELECT sqlite_version() AS version").get(),
        caveat:
          "Synthetic local scratch filesystem; not a stream-machine, Windows, network or 8-hour soak benchmark.",
        eventRows: store.eventCount(),
        ingestionElapsedMs,
        eventInsertP50Ms: quantile(timings, 0.5),
        eventInsertP95Ms: quantile(timings, 0.95),
        eventInsertP99Ms: quantile(timings, 0.99),
        presenceRows: userIds.length * 480,
        presencePolls: 480,
        presenceBatchP95Ms: quantile(batches, 0.95),
        observedMinutesForOnePerson: observed,
        presenceQuery: "StreamStore.grid, 480 minutes, one person",
        presenceQueryMs,
        databaseBytes: (await stat(path)).size,
        rssBytes: process.memoryUsage().rss,
        eventLoopP99Ms: delay.percentile(99) / 1e6,
        integrity,
      },
      null,
      2,
    ),
  );
} finally {
  delay.disable();
  probe?.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
