// One-time administrator export. Secrets are returned only in a hybrid encrypted envelope.
import {readFile,readdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createCipheriv,publicEncrypt,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const Database=createRequire(join(process.cwd(),'package.json'))('better-sqlite3');
const {restoreBackupFile}=await import(join(process.cwd(),'dist/apps/daemon/src/backup.js'));
const payload=process.argv[2],dir=process.env.STREAM_PANEL_DATA_DIR;
if(!payload||!dir||!process.env.STREAM_PANEL_BACKUP_KEY_FILE)throw new Error('RECOVERY_CONFIG_REQUIRED');
const key=(await readFile(process.env.STREAM_PANEL_BACKUP_KEY_FILE,'utf8')).trim();
if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('INVALID_BACKUP_KEY');
const expected=(await readFile(join(payload,'expected-key'),'utf8')).trim();
if(createHash('sha256').update(key).digest('hex')!==createHash('sha256').update(expected).digest('hex'))throw new Error('GITHUB_BACKUP_KEY_MISMATCH');
const credentials=JSON.parse(await readFile(join(payload,'credentials.json'),'utf8'));
if(credentials.profile!=='gulnaz'||typeof credentials.password!=='string')throw new Error('INVALID_RECOVERY_ACCOUNT');
const staging=await mkdtemp(join(dir,'recovery-proof-'));
try{
 const files=(await readdir(join(dir,'backups'))).filter(x=>/^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/.test(x)).sort().reverse();
 if(!files.length)throw new Error('LOCAL_BACKUP_MISSING');
 await restoreBackupFile(join(dir,'backups',files[0]),Buffer.from(key,'hex'),join(staging,'restored'));
 const restored=new Database(join(staging,'restored','data.sqlite'),{readonly:true});
 let schemas,tables;
 try{
  if(restored.pragma('integrity_check',{simple:true})!=='ok'||restored.pragma('foreign_key_check').length)throw new Error('RESTORED_DATABASE_INVALID');
  schemas=restored.prepare('SELECT profile,version FROM sp_profile_schema ORDER BY profile').all();
  if(schemas.length!==2)throw new Error('RESTORED_PROFILES_MISSING');
  tables=restored.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
 }finally{restored.close();}
 const live=new Database(join(dir,'data.sqlite'),{readonly:true});let account;
 try{account=live.prepare("SELECT username,salt,password_hash FROM sp_users WHERE profile='gulnaz'").get();}finally{live.close();}
 if(!account||account.username!==credentials.username)throw new Error('RECOVERY_ACCOUNT_MISMATCH');
 const actual=await promisify(scrypt)(credentials.password,account.salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 if(!timingSafeEqual(actual,Buffer.from(account.password_hash,'hex')))throw new Error('RECOVERY_PASSWORD_MISMATCH');
 const proof={backup:files[0],restored:true,integrity:'ok',schemas,tables,githubKeyMatches:true,passwordVerified:true};
 const data=Buffer.from(JSON.stringify({backupKey:key,username:credentials.username,password:credentials.password,proof}));
 const wrappingKey=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',wrappingKey,iv);
 const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
 const wrappedKey=publicEncrypt({key:await readFile(join(payload,'recipient.pem')),oaepHash:'sha256'},wrappingKey);
 await writeFile(join(payload,'recovery.enc.json'),JSON.stringify({version:1,wrappedKey:wrappedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify(proof));
}finally{await rm(staging,{recursive:true,force:true});}
