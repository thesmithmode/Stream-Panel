import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
const diff = execFileSync('git', ['diff','--binary','HEAD'], {maxBuffer: 16 * 1024 * 1024});
const encoded = gzipSync(diff).toString('base64');
console.log('FORMAT_DELTA_START ' + encoded.length);
for (let i = 0; i < encoded.length; i += 2048) console.log('FORMAT_DELTA ' + encoded.slice(i, i + 2048));
console.log('FORMAT_DELTA_END');
