import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {prepareLocal} from './legacy-import.js';
const base=process.env.XDG_DATA_HOME??join(homedir(),'.local/share');
const dir=process.env.STREAM_PANEL_DATA_DIR??join(base,'stream-panel-local');
const legacy=process.env.STREAM_PANEL_LEGACY_DIR??join(base,'stream-panel');
await prepareLocal(dir,legacy,process.env.STREAM_PANEL_INITIAL_PASSWORD);
delete process.env.STREAM_PANEL_INITIAL_PASSWORD;
process.env.STREAM_PANEL_DATA_DIR=dir;
process.env.STREAM_PANEL_PUBLIC_ORIGIN??=`http://127.0.0.1:${process.env.STREAM_PANEL_PORT??47831}`;
process.env.STREAM_PANEL_BACKUP_KEY_FILE??=join(dir,'backup-key');
await import('./index.js');
if(process.env.STREAM_PANEL_NO_BROWSER!=='1'){
 const opener=spawn('xdg-open',[process.env.STREAM_PANEL_PUBLIC_ORIGIN],{stdio:'ignore'});
 opener.on('error',()=>console.error('Откройте адрес панели в браузере вручную.'));
}
