import {ReadCache} from '../dist/apps/daemon/src/read-cache.js';
if(!process.env.STREAM_PANEL_REDIS_URL)throw new Error('REDIS_NOT_CONFIGURED');
const cache=new ReadCache();
let loads=0;
try{
 // Connection timeout is 300 ms; this probe never reads real application data.
 await new Promise(resolve=>setTimeout(resolve,400));
 const first=await cache.read('diagnostic',async()=>++loads);
 // Evict the bounded local cache so this probe actually exercises Redis.
 for(let n=0;n<129;n++)await cache.read(`diagnostic-evict-${n}`,async()=>n);
 const repeated=await cache.read('diagnostic',async()=>++loads);
 if(first!==1||repeated!==1||loads!==1)throw new Error('REDIS_HIT_NOT_VERIFIED');
 cache.invalidate();
 if(await cache.read('diagnostic',async()=>++loads)!==2)throw new Error('REDIS_INVALIDATION_FAILED');
 console.log('Redis application client: hit verified after local eviction; mutation invalidation verified');
}finally{cache.close();}
