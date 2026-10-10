import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

export const BACKUP_STREAM_MAX_SIZE = 2 * 1024 * 1024 * 1024;
const magic = Buffer.from("SPBK2");
const headerSize = 17;
const tagSize = 16;
type Limits = { payload: number; blob: number };
const defaults: Limits = { payload: BACKUP_STREAM_MAX_SIZE, blob: BACKUP_STREAM_MAX_SIZE };
const fsErrors = new Set(["EACCES", "EBADF", "EBUSY", "EEXIST", "EFAULT", "EFBIG", "EINTR", "EINVAL", "EIO", "EISDIR", "EMFILE", "EMLINK", "ENAMETOOLONG", "ENFILE", "ENODEV", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "ENOTSUP", "EOVERFLOW", "EPERM", "EPIPE", "EROFS", "ETXTBSY", "EXDEV"]);

function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("BACKUP_SIZE_LIMIT");
  return value;
}
function counter(max: number, hash: ReturnType<typeof createHash>, initial = 0, reserved = 0) {
  let size = initial;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size + reserved > max) return callback(new Error("BACKUP_SIZE_LIMIT"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}
function sink(handle: Awaited<ReturnType<typeof open>>) {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void handle.writeFile(chunk).then(() => callback(), callback);
    },
  });
}
function invalid(error: unknown): Error {
  if (error instanceof Error && (error.message === "BACKUP_SIZE_LIMIT" || fsErrors.has((error as NodeJS.ErrnoException).code ?? ""))) return error;
  return new Error("BACKUP_INVALID");
}
async function exactRead(handle: Awaited<ReturnType<typeof open>>, size: number, position: number) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) throw new Error("BACKUP_INVALID");
    offset += bytesRead;
  }
  return buffer;
}

export async function sealBackupFile(
  source: AsyncIterable<Uint8Array>, output: string, key: Buffer,
  limits: Limits = defaults,
): Promise<string> {
  if (key.length !== 32) throw new Error("BACKUP_INVALID");
  const maxPayload = limit(limits.payload), maxBlob = limit(limits.blob);
  if (maxBlob < headerSize + tagSize) throw new Error("BACKUP_SIZE_LIMIT");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256"), handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let complete = false;
  try {
    await handle.writeFile(Buffer.concat([magic, iv]));
    await pipeline(
      Readable.from(source), counter(maxPayload, hash), createGzip(), cipher,
      counter(maxBlob, createHash("sha256"), headerSize, tagSize), sink(handle),
    );
    await handle.writeFile(cipher.getAuthTag());
    await handle.sync();
    complete = true;
    return hash.digest("hex");
  } finally {
    let closeError: unknown;
    try { await handle.close(); } catch (error) { closeError = error; }
    if (!complete || closeError) await rm(output, { force: true }).catch(() => {});
    if (closeError) throw closeError;
  }
}

export async function openBackupFile(
  input: string, output: string, key: Buffer, limits: Limits = defaults,
): Promise<string> {
  if (key.length !== 32) throw new Error("BACKUP_INVALID");
  const maxPayload = limit(limits.payload), maxBlob = limit(limits.blob);
  const source = await open(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let target: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false, failure: Error | undefined;
  try {
    const info = await source.stat(), size = info.size;
    if (!info.isFile()) throw new Error("BACKUP_INVALID");
    if (!Number.isSafeInteger(size) || size <= headerSize + tagSize) throw new Error("BACKUP_INVALID");
    if (size > maxBlob) throw new Error("BACKUP_SIZE_LIMIT");
    const header = await exactRead(source, headerSize, 0);
    if (!header.subarray(0, magic.length).equals(magic)) throw new Error("BACKUP_INVALID");
    const tag = await exactRead(source, tagSize, size - tagSize);
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(5));
    decipher.setAuthTag(tag);
    target = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const encrypted = createReadStream(input, {
      fd: source.fd, autoClose: false, start: headerSize, end: size - tagSize - 1,
    });
    await pipeline(encrypted, decipher, createGunzip(), counter(maxPayload, hash), sink(target));
    await target.sync();
    complete = true;
    return hash.digest("hex");
  } catch (error) {
    failure = invalid(error);
    throw failure;
  } finally {
    let closeError: unknown;
    if (target) {
      try { await target.close(); } catch (error) { closeError = error; }
    }
    try { await source.close(); } catch (error) { closeError ??= error; }
    if (target && (!complete || closeError)) await rm(output, { force: true }).catch(() => {});
    if (closeError && !failure) throw invalid(closeError);
  }
}
