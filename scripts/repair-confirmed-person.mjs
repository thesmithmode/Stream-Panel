// Explicit owner-authorized, reversible identity repair. Never prints donor data or credentials.
import {join} from 'node:path';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {repairConfirmedPerson} from '../dist/packages/core/src/confirmed-person-repair.js';
const dir=process.env.STREAM_PANEL_DATA_DIR;if(!dir)throw Error('DATA_DIRECTORY_REQUIRED');
const store=new StreamStore(join(dir,'data.sqlite'),'ruslan');
try{const result=repairConfirmedPerson(store);console.log(JSON.stringify({confirmedPersonRepair:result}));}finally{store.close();}
