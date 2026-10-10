import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_STREAM_MAX_SIZE, openBackupFile, sealBackupFile } from "../src/backup-stream.js";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function* chunks(data: Buffer, sizes = [1, 17, 4093, 31, 8192]): AsyncIterable<Uint8Array> {
  let offset = 0, index = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + sizes[index++ % sizes.length]!);
    yield data.subarray(offset, end);
    offset = end;
  }
}

async function* failedSource(): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial payload");
  throw new Error("SOURCE_FAILED");
}

test("stream backup round-trips many chunks, returns plaintext digests, and creates private files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-"));
  const key = randomBytes(32), payload = randomBytes(384 * 1024 + 73);
  const sealed = join(dir, "backup.spbk"), restored = join(dir, "restored.bin");
  try {
    assert.equal(await sealBackupFile(chunks(payload), sealed, key), digest(payload));
    assert.equal((await readFile(sealed)).subarray(0, 5).toString(), "SPBK2");
    assert.equal(await openBackupFile(sealed, restored, key), digest(payload));
    assert.deepEqual(await readFile(restored), payload);
    if (process.platform !== "win32") {
      assert.equal((await stat(sealed)).mode & 0o777, 0o600);
      assert.equal((await stat(restored)).mode & 0o777, 0o600);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stream writer and reader accept exact payload/blob limits and reject over-limit data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-limits-"));
  const key = randomBytes(32), payload = randomBytes(1024), baseline = join(dir, "baseline.spbk");
  try {
    const expectedDigest = digest(payload);
    assert.equal(await sealBackupFile(chunks(payload), baseline, key, { payload: payload.length, blob: BACKUP_STREAM_MAX_SIZE }), expectedDigest);
    const blob = await readFile(baseline), blobSize = blob.length;
    const exactCopy = join(dir, "exact.spbk");
    assert.equal(await sealBackupFile(chunks(payload), exactCopy, key, { payload: payload.length, blob: blobSize }), expectedDigest);
    const exactRestored = join(dir, "exact-restored.bin");
    assert.equal(await openBackupFile(baseline, exactRestored, key, { payload: payload.length, blob: blobSize }), expectedDigest);

    await assert.rejects(
      sealBackupFile(chunks(payload), join(dir, "too-much-payload.spbk"), key, { payload: payload.length - 1, blob: BACKUP_STREAM_MAX_SIZE }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      sealBackupFile(chunks(payload), join(dir, "too-large-blob.spbk"), key, { payload: payload.length, blob: blobSize - 1 }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      openBackupFile(baseline, join(dir, "reader-payload.spbk"), key, { payload: payload.length - 1, blob: blobSize }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      openBackupFile(baseline, join(dir, "reader-blob.spbk"), key, { payload: payload.length, blob: blobSize - 1 }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      sealBackupFile(chunks(payload), join(dir, "negative-limit.spbk"), key, { payload: -1, blob: blobSize }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      sealBackupFile(chunks(payload), join(dir, "nan-limit.spbk"), key, { payload: Number.NaN, blob: blobSize }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      openBackupFile(baseline, join(dir, "reader-negative-limit.out"), key, { payload: payload.length, blob: -1 }),
      /BACKUP_SIZE_LIMIT/,
    );
    await assert.rejects(
      openBackupFile(baseline, join(dir, "reader-nan-limit.out"), key, { payload: payload.length, blob: Number.NaN }),
      /BACKUP_SIZE_LIMIT/,
    );
    assert.deepEqual((await readdir(dir)).filter(name => /too-much|too-large|reader-/.test(name)), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stream reader rejects bad header, wrong key, truncation, and authenticated tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-invalid-"));
  const key = randomBytes(32), payload = randomBytes(300), valid = join(dir, "valid.spbk");
  try {
    await sealBackupFile(chunks(payload), valid, key);
    const sealed = await readFile(valid);
    const badHeader = Buffer.from(sealed), badTag = Buffer.from(sealed);
    badHeader.writeUInt8(badHeader.readUInt8(0) ^ 1, 0);
    badTag.writeUInt8(badTag.readUInt8(badTag.length - 1) ^ 1, badTag.length - 1);
    const variants: [string, Buffer][] = [
      ["header", badHeader],
      ["truncated", sealed.subarray(0, sealed.length - 1)],
      ["tampered", badTag],
    ];
    for (const [name, bytes] of variants) {
      const input = join(dir, `${name}.spbk`);
      await writeFile(input, bytes);
      await assert.rejects(openBackupFile(input, join(dir, `${name}.out`), key), /BACKUP_INVALID/);
    }
    for (const size of [0, 32, 33]) {
      const input = join(dir, `short-${size}.spbk`);
      await writeFile(input, Buffer.alloc(size));
      await assert.rejects(openBackupFile(input, join(dir, `short-${size}.out`), key), /BACKUP_INVALID/);
    }
    await assert.rejects(openBackupFile(valid, join(dir, "wrong-key.out"), randomBytes(32)), /BACKUP_INVALID/);
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".out")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stream writer and reader remove partial outputs when file sync fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-sync-"));
  const key = randomBytes(32), payload = Buffer.from("durability failure"),
    sealed = join(dir, "good.spbk"), writeFailure = join(dir, "write-failure.spbk"),
    readFailure = join(dir, "read-failure.out"), preserved = join(dir, "preserved.out");
  try {
    await sealBackupFile(chunks(payload), sealed, key);
    const kept = Buffer.from("previous file");
    await writeFile(preserved, kept);
    const probe = await open(sealed, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const sync = t.mock.method(handlePrototype, "sync", async () => {
      throw Object.assign(new Error("disk sync failed"), { code: "EIO" });
    });
    await assert.rejects(sealBackupFile(chunks(payload), writeFailure, key), {code:"EIO"});
    await assert.rejects(openBackupFile(sealed, readFailure, key), {code:"EIO"});
    await assert.rejects(sealBackupFile(chunks(payload), preserved, key), /EEXIST/);
    assert.ok(sync.mock.callCount() >= 2);
    assert.deepEqual(await readFile(preserved), kept);
    assert.deepEqual((await readdir(dir)).filter(name => /write-failure|read-failure/.test(name)), []);
  } finally { t.mock.restoreAll(); await rm(dir, { recursive: true, force: true }); }
});

test("stream backup preserves existing outputs and removes partial files after source failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-output-"));
  const key = randomBytes(32), existing = Buffer.from("keep this"), output = join(dir, "existing.spbk");
  try {
    await writeFile(output, existing);
    await assert.rejects(sealBackupFile(chunks(Buffer.from("new")), output, key), /EEXIST/);
    assert.deepEqual(await readFile(output), existing);

    const sealed = join(dir, "good.spbk");
    await sealBackupFile(chunks(Buffer.from("payload")), sealed, key);
    const existingPlaintext = join(dir, "existing-plain.out");
    await writeFile(existingPlaintext, existing);
    await assert.rejects(openBackupFile(sealed, existingPlaintext, key), /EEXIST/);
    assert.deepEqual(await readFile(existingPlaintext), existing);

    const beforeFailedWrite = await readdir(dir);
    await assert.rejects(sealBackupFile(failedSource(), join(dir, "source-error.spbk"), key), /SOURCE_FAILED/);
    assert.deepEqual(await readdir(dir), beforeFailedWrite);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stream backup validates keys and preserves underlying filesystem errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sp-backup-stream-errors-"));
  const key = randomBytes(32), input = join(dir, "missing.spbk");
  try {
    assert.equal(BACKUP_STREAM_MAX_SIZE, 2 * 1024 * 1024 * 1024);
    await assert.rejects(sealBackupFile(chunks(Buffer.from("x")), join(dir, "bad-key.spbk"), Buffer.alloc(31)), /BACKUP_INVALID/);
    await assert.rejects(openBackupFile(input, join(dir, "bad-read.out"), Buffer.alloc(31)), /BACKUP_INVALID/);
    await assert.rejects(openBackupFile(input, join(dir, "bad-read.out"), key), /ENOENT/);
    await assert.rejects(sealBackupFile(chunks(Buffer.from("x")), join(dir, "missing-parent", "out.spbk"), key), /ENOENT/);
    await assert.rejects(sealBackupFile(chunks(Buffer.from("x")), join(dir, "bad-write.spbk"), Buffer.alloc(33)), /BACKUP_INVALID/);
    assert.deepEqual((await readdir(dir)).filter(name => /bad-key|bad-read|bad-write/.test(name)), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
