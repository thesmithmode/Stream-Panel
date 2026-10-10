import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StreamStore } from '../../../packages/core/src/store.js';
import { AccountStore } from '../src/auth.js';
import { BackupService, restoreBackup } from '../src/backup.js';

test('cloud failure returns a restorable local backup and a later upload retry records independent success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-backup-independent-'));
  const key = randomBytes(32), dbPath = join(dir, 'data.sqlite');
  const auth = new AccountStore(dbPath);
  await auth.createUser('ruslan', 'ruslan', 'Руслан', 'backup-independent-password');
  const db = new StreamStore(dbPath, 'ruslan');
  await writeFile(join(dir, 'key'), key.toString('hex'));
  await writeFile(join(dir, 'service-key'), 'service-secret');
  await mkdir(join(dir, 'profiles', 'ruslan'), { recursive: true });
  await writeFile(join(dir, 'profiles', 'ruslan', 'secrets.json'), JSON.stringify({ version: 1, daAccessToken: 'fixture-secret' }));
  let mode: 'fail' | 'ok' = 'fail';
  const uploaded: string[] = [];
  const remoteBlobs = new Map<string, Buffer>();
  let failedUploads = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/bucket/')) return Response.json({ public: false });
    if (mode === 'fail' && init?.method === 'POST' && url.pathname.includes('/object/stream-panel-backups/stream-panel/')) {
      failedUploads++;
      return Response.json({}, { status: 503 });
    }
    if (url.pathname.includes('/object/authenticated/')) {
      const name = url.pathname.split('/').at(-1)!;
      const blob = remoteBlobs.get(name);
      return blob ? new Response(new Uint8Array(blob)) : Response.json({}, { status: 404 });
    }
    if (url.pathname.includes('/object/list/')) return Response.json(uploaded.map(name => ({ name })));
    if (init?.method === 'DELETE') {
      const removed = JSON.parse(String(init.body)).prefixes.map((value: string) => value.split('/').at(-1));
      for (let i = uploaded.length - 1; i >= 0; i--) if (removed.includes(uploaded[i])) { remoteBlobs.delete(uploaded[i]!); uploaded.splice(i, 1); }
    } else {const name=url.pathname.split('/').at(-1)!;uploaded.push(name);remoteBlobs.set(name,Buffer.from(init?.body as Uint8Array));}
    return Response.json({ ok: true });
  };
  const backup = new BackupService(dir, { keyFile: join(dir, 'key'), url: 'https://fixture.supabase.co', serviceKeyFile: join(dir, 'service-key') }, request);
  try {
    const partial = await backup.run();
    assert.ok(failedUploads > 0, 'upload-failure mock must intercept the object POST');
    assert.equal(partial.cloudError, 'BACKUP_UPLOAD_FAILED');
    assert.equal(backup.status.state, 'partial');
    assert.equal(backup.status.error, 'BACKUP_UPLOAD_FAILED');
    assert.equal(backup.status.local.state, 'success');
    assert.equal(backup.status.local.filename, partial.filename);
    assert.equal(backup.status.cloud.state, 'error');
    assert.equal(backup.status.cloud.error, 'BACKUP_UPLOAD_FAILED');
    assert.ok(backup.status.local.lastSuccessAt > 0);
    const localPath = join(dir, 'backups', partial.filename);
    const blob = await readFile(localPath);
    await restoreBackup(blob, key, join(dir, 'restored'));
    assert.equal(JSON.parse(await readFile(join(dir, 'restored', 'profiles', 'ruslan', 'secrets.json'), 'utf8')).daAccessToken, 'fixture-secret');
    const restored = new StreamStore(join(dir, 'restored', 'data.sqlite'), 'ruslan');
    restored.close();

    mode = 'ok';
    const recovered = await backup.run();
    assert.equal(recovered.cloudError, undefined);
    assert.equal(backup.status.state, 'uploaded');
    assert.equal(backup.status.local.filename, recovered.filename);
    assert.equal(backup.status.cloud.state, 'success');
    assert.equal(backup.status.cloud.filename, recovered.filename);
    assert.ok(backup.status.cloud.lastSuccessAt > 0);
    assert.ok(await readFile(localPath));
    assert.ok(uploaded.includes(recovered.filename));

    const cloudSuccessAt = backup.status.cloud.lastSuccessAt;
    mode = 'fail';
    const nextPartial = await backup.run();
    assert.equal(nextPartial.cloudError, 'BACKUP_UPLOAD_FAILED');
    assert.equal(backup.status.local.filename, nextPartial.filename);
    assert.equal(backup.status.cloud.lastSuccessAt, cloudSuccessAt);
    assert.equal(backup.status.cloud.filename, recovered.filename);
    assert.ok(await readFile(join(dir, 'backups', nextPartial.filename)));
  } finally {
    await backup.stop();
    db.close();
    auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('local failure keeps the last successful local file metadata and never reports a new success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-backup-local-failure-'));
  const store = new StreamStore(join(dir, 'data.sqlite'));
  const keyPath = join(dir, 'key');
  await writeFile(keyPath, randomBytes(32).toString('hex'));
  const backup = new BackupService(dir, { keyFile: keyPath });
  try {
    const first = await backup.run();
    const succeededAt = backup.status.local.lastSuccessAt;
    assert.equal(backup.status.local.filename, first.filename);
    await writeFile(keyPath, 'invalid-key');
    await assert.rejects(backup.run(), /INVALID_BACKUP_KEY/);
    assert.equal(backup.status.state, 'error');
    assert.equal(backup.status.local.state, 'error');
    assert.equal(backup.status.local.lastSuccessAt, succeededAt);
    assert.equal(backup.status.local.filename, first.filename);
    assert.ok(await readFile(join(dir, 'backups', first.filename)));
    assert.equal((await readdir(join(dir, 'backups'))).filter(name => name.endsWith('.spbk')).length, 1);
  } finally {
    await backup.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrong key or corrupted persisted blob never rotates prior local backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sp-backup-local-verify-'));
  const store = new StreamStore(join(dir, 'data.sqlite'));
  const keyPath = join(dir, 'key'), key = randomBytes(32).toString('hex');
  await writeFile(keyPath, key);
  const backup = new BackupService(dir, { keyFile: keyPath });
  const corruptReader: (path: string) => Promise<Buffer> = async path => {
    const persisted = Buffer.from(await readFile(path));
    persisted[persisted.length - 1] = persisted.at(-1)! ^ 1;
    return persisted;
  };
  const corrupted = new BackupService(dir, { keyFile: keyPath }, fetch, corruptReader);
  try {
    for (let i = 0; i < 3; i++) await backup.run();
    const before = (await readdir(join(dir, 'backups'))).filter(name => name.endsWith('.spbk')).sort();
    await writeFile(keyPath, 'wrong-key');
    await assert.rejects(new BackupService(dir, { keyFile: keyPath }).run(), /INVALID_BACKUP_KEY/);
    assert.deepEqual((await readdir(join(dir, 'backups'))).filter(name => name.endsWith('.spbk')).sort(), before);
    await writeFile(keyPath, key);
    await assert.rejects(corrupted.run(), /BACKUP_LOCAL_VERIFY_FAILED/);
    assert.deepEqual((await readdir(join(dir, 'backups'))).filter(name => name.endsWith('.spbk')).sort(), before);
  } finally {
    await backup.stop();
    await corrupted.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
