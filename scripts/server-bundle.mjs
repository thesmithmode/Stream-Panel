import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const sha = process.env.STREAM_PANEL_RELEASE;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Exact release commit required');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux amd64 bundle only');
const target = resolve('artifacts/server');
await rm(target,{recursive:true,force:true});await mkdir(target + '/bin',{recursive:true});
await cp(process.execPath, target + '/bin/node');
for (const path of ['dist','node_modules','apps/web/dist','package.json','scripts/provision-accounts.mjs','scripts/restore-backup.mjs']) {
 await mkdir(target + '/' + path.split('/').slice(0,-1).join('/'),{recursive:true});
 await cp(path,target+'/'+path,{recursive:true,dereference:false,verbatimSymlinks:true});
}
const child = spawn('tar',['-czf',resolve('artifacts/server.tar.gz'),'-C',target,'bin','dist','node_modules','apps','package.json','scripts'],{stdio:'inherit'});
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
if (code !== 0) throw new Error('Bundle failed');
const hash=createHash('sha256').update(await readFile('artifacts/server.tar.gz')).digest('hex');
await writeFile('artifacts/server.header',`${sha} ${hash}\n`);
