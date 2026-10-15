// Synthetic feed query plan/latency. Optional first argument: compiled baseline module.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {migrateDatabase} from '../dist/packages/core/src/database-migrations.js';
import {AudienceQueries as After} from '../dist/packages/core/src/audience-queries.js';
const cases=[];
if(process.argv[2])cases.push(['before',(await import(pathToFileURL(resolve(process.argv[2])).href)).AudienceQueries]);
cases.push(['after',After]);
const db=new Database(':memory:');migrateDatabase(db);
const insertPerson=db.prepare('INSERT INTO persons VALUES (?,?,0)');
const insertIdentity=db.prepare("INSERT INTO identities VALUES (?,'twitch','channel',?,?,?,?,?)");
const insert=db.prepare("INSERT INTO events VALUES (?,'twitch','channel',?,'chat.message',?,?,?,NULL,'provider','eventsub','{}')");
const at=Date.UTC(2026,9,15);
db.transaction(()=>{
 for(let n=0;n<1000;n++){const id=`p:${n}`;insertPerson.run(id,id);insertIdentity.run(id,id,id,id,id,id);}
 for(let n=0;n<480000;n++){const id=`e:${n}`;insert.run(id,id,`p:${n%1000}`,at+n,at+n);}
})();
db.exec('ANALYZE');
let lastSql,lastArgs;
const tracked=new Proxy(db,{get(target,prop){if(prop==='prepare')return sql=>{const stmt=target.prepare(sql);return new Proxy(stmt,{get(stmt,method){if(method==='all')return(...args)=>{if(sql.includes('FROM effective_events e LEFT JOIN identities')){lastSql=sql;lastArgs=args;}return stmt.all(...args);};const value=Reflect.get(stmt,method,stmt);return typeof value==='function'?value.bind(stmt):value;}});};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
let baseline;
for(const [name,Class] of cases){
 const q=new Class(tracked);const result=q.events(undefined,'p:0');if(baseline)assert.deepEqual(result,baseline);else baseline=result;
 const times=[];for(let n=0;n<15;n++){const start=performance.now();q.events(undefined,'p:0');times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);
 console.log(JSON.stringify({name,events:480000,matched:480,returned:result.length,medianMs:times[7],minMs:times[0],maxMs:times[14],plan:db.prepare('EXPLAIN QUERY PLAN '+lastSql).all(...lastArgs).map(row=>row.detail)}));
}
db.close();
