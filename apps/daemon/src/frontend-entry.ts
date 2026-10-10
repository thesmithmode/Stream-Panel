import {createFrontend} from './frontend.js';
const [root,collectorPort,port,origin,encodedNetwork]=process.argv.slice(2);
const network=JSON.parse(encodedNetwork!);
const app=createFrontend(root!,Number(collectorPort),origin!,network);
await new Promise<void>((resolve,reject)=>{app.once('error',reject);app.listen(Number(port),network.bindHost,resolve);});
process.send?.({ready:true});
let closing=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{
 if(closing)return;closing=true;app.close(()=>process.exit(0));app.closeIdleConnections();
});
