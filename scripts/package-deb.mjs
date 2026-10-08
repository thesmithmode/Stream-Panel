import {cp,mkdir,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Linux amd64 only');
const version=JSON.parse(await readFile('package.json','utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid package version');
const root=resolve('artifacts/deb-root'),app=join(root,'opt/stream-panel-local');
await rm(root,{recursive:true,force:true});await mkdir(app+'/bin',{recursive:true});
await cp(process.execPath,app+'/bin/node');await chmod(app+'/bin/node',0o755);
for(const path of ['dist','node_modules','apps/web/dist','package.json']){
 await mkdir(join(app,path,'..'),{recursive:true});
 await cp(path,join(app,path),{recursive:true,verbatimSymlinks:true});
}
await mkdir(root+'/usr/bin',{recursive:true});await cp('packaging/stream-panel',root+'/usr/bin/stream-panel');await chmod(root+'/usr/bin/stream-panel',0o755);
await mkdir(root+'/usr/share/applications',{recursive:true});
await writeFile(root+'/usr/share/applications/stream-panel.desktop','[Desktop Entry]\nType=Application\nName=Stream Panel\nComment=Local Stream Panel analytics\nExec=stream-panel\nTerminal=true\nCategories=Network;AudioVideo;\n');
await mkdir(root+'/DEBIAN',{recursive:true});
await writeFile(root+'/DEBIAN/control',`Package: stream-panel\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: Stream Panel <noreply@localhost>\nDepends: libc6 (>= 2.35), libstdc++6, bash, util-linux, xdg-utils\nDescription: Local Stream Panel analytics preview\n Bundled Node runtime, browser UI and safe legacy data import.\n`);
// Package scripts never read or modify any user's home/data directory as root.
const output=resolve(`artifacts/stream-panel_${version}_amd64.deb`);
const r=spawnSync('dpkg-deb',['--build','--root-owner-group',root,output],{stdio:'inherit'});
if(r.status!==0)throw Error('Deb build failed');
console.log(output);
