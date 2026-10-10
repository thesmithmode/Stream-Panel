import { readFile } from 'node:fs/promises';
import { restoreBackupFile } from '../dist/apps/daemon/src/backup.js';
const [blob, keyFile, destination] = process.argv.slice(2);
if (!blob || !keyFile || !destination) throw new Error('Usage: restore-backup.mjs BACKUP_FILE KEY_FILE NEW_EMPTY_DIRECTORY');
await restoreBackupFile(blob, Buffer.from((await readFile(keyFile,'utf8')).trim(),'hex'), destination);
console.log('Backup restored; sessions revoked. Validate accounts before switching the stopped service to this directory.');
