import {join} from 'node:path';
import {homedir} from 'node:os';
import {access} from 'node:fs/promises';
import {AccountStore} from './auth.js';
import {BackupService} from './backup.js';
export async function resetLocalPassword(dir:string,password:string) {
 if(password.length<14||password.length>256)throw Error('INVALID_PASSWORD');
 await access(join(dir,'data.sqlite'));
 const backup=new BackupService(dir,{keyFile:join(dir,'backup-key')});await backup.run();
 const accounts=new AccountStore(join(dir,'data.sqlite'));
 try{await accounts.resetPassword('ruslan',password);}finally{accounts.close();}
}
if(process.env.STREAM_PANEL_RESET_PASSWORD==='1'){
 const dir=process.env.STREAM_PANEL_DATA_DIR??join(process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),'stream-panel-local');
 const password=process.env.STREAM_PANEL_INITIAL_PASSWORD??'';delete process.env.STREAM_PANEL_INITIAL_PASSWORD;
 await resetLocalPassword(dir,password);console.log('Пароль ruslan изменён. История и ключи сохранены. Запустите stream-panel.');
}
