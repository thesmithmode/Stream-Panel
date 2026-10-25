// Explicit owner-authorized, reversible identity repair. Never prints donor data or credentials.
import {join} from 'node:path';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {repairConfirmedPerson} from '../dist/packages/core/src/confirmed-person-repair.js';
const dir=process.env.STREAM_PANEL_DATA_DIR;if(!dir)throw Error('DATA_DIRECTORY_REQUIRED');
const marker=join(dir,'confirmed-person-repair-v1.json');
let applied=false;
try{const saved=JSON.parse(await readFile(marker,'utf8'));if(saved.version!==1||!['merged','already-linked-or-absent'].includes(saved.result?.state))throw Error('INVALID_REPAIR_MARKER');applied=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(applied)console.log(JSON.stringify({confirmedPersonRepair:{state:'already-applied'}}));
else{
 const store=new StreamStore(join(dir,'data.sqlite'),'ruslan');let result;
 try{result=repairConfirmedPerson(store);}finally{store.close();}
 // A later deployment must respect an explicit undo of the authorized merge.
 if(['merged','already-linked-or-absent'].includes(result.state)){
  const temp=marker+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify({version:1,result}),{mode:0o600,flag:'wx'});await rename(temp,marker);}finally{await rm(temp,{force:true});}
 }
 console.log(JSON.stringify({confirmedPersonRepair:result}));
}
