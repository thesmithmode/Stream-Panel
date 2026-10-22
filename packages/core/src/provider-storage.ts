import {SubscriberHistory} from './subscriber-history.js';
import type Database from 'better-sqlite3';
import {createHash,randomUUID as cryptoId} from 'node:crypto';
import {parse,stringify} from 'lossless-json';
import {assertTimestamp} from './domain.js';

export type ImportState={id:string;needsImport:boolean;occurredAtMs:number|null};
export type PendingDonation={id:string;serialized:string};
/** Only domain history and unresolved money records belong in the provider archive. */
export class ProviderStorage {
 constructor(private db:Database.Database){}

 saveFollowers(source:string,account:string,data:{followers:{id:string;name:string;followedAtMs:number|null}[];complete:boolean;total:number|null},at:number,session:string|null):void {
  const clean={followers:data.followers.map(({id,name,followedAtMs})=>({id,name,followedAtMs})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),complete:data.complete,total:data.total};
  const payload=JSON.stringify(clean),id=createHash('sha256').update(JSON.stringify([source,account,payload])).digest('hex');
  this.db.transaction(()=>{
   const saved=this.db.prepare("INSERT OR IGNORE INTO provider_snapshots VALUES (?,?,?,'followers',?,?,?)").run(id,source,account,at,session,payload);
   if(saved.changes&&source==='twitch'){const history=new SubscriberHistory(this.db);for(const follower of clean.followers)if(follower.followedAtMs!==null)history.follow(account,follower.id,follower.name,follower.followedAtMs);}
   this.db.prepare('INSERT INTO follower_checks VALUES (?,?,?,?)').run(cryptoId(),id,at,session);
  }).immediate();
 }
 migrateFollowers():void {
  let last='';
  for(;;){
   const rows=this.db.prepare("SELECT p.* FROM provider_snapshots p JOIN follower_checks c ON c.id=p.id AND c.snapshot_id=p.id WHERE p.key='followers' AND p.id>? ORDER BY p.id LIMIT 100").all(last) as {id:string;source:string;account_id:string;observed_at_ms:number;session_id:string|null;payload_json:string}[];
   if(!rows.length)break;
   for(const row of rows){
    const data=JSON.parse(row.payload_json),clean={followers:data.followers.map(({id,name,followedAtMs}:{id:string;name:string;followedAtMs:number|null})=>({id,name,followedAtMs})).sort((a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0),complete:data.complete,total:data.total};
    const payload=JSON.stringify(clean),id=createHash('sha256').update(JSON.stringify([row.source,row.account_id,payload])).digest('hex');
    if(id!==row.id){
     this.db.prepare("INSERT OR IGNORE INTO provider_snapshots VALUES (?,?,?,'followers',?,?,?)").run(id,row.source,row.account_id,row.observed_at_ms,row.session_id,payload);
     this.db.prepare('UPDATE follower_checks SET snapshot_id=? WHERE snapshot_id=?').run(id,row.id);
     this.db.prepare('DELETE FROM provider_snapshots WHERE id=?').run(row.id);
    }
    last=row.id;
   }
  }
 }

 donationStates(account:string,ids:readonly string[]):ImportState[]{
  if(!account||ids.length>2000||ids.some(id=>!/^\d+$/.test(id)))throw new Error('INVALID_DONATION_IDS');
  return (this.db.prepare("SELECT external_id AS id,occurred_at_ms AS occurredAtMs,CASE WHEN occurred_at_ms IS NULL THEN 1 ELSE 0 END AS missing FROM events WHERE source='donationalerts' AND account_id=? AND type='donation' AND external_id IN(SELECT value FROM json_each(?))").all(account,JSON.stringify([...new Set(ids)])) as {id:string;missing:number;occurredAtMs:number|null}[]).map(row=>({id:row.id,needsImport:row.missing===1,occurredAtMs:row.occurredAtMs}));
 }
 saveFailure(account:string,serialized:string,error:string,at:number):void {
  assertTimestamp(at);if(!account||typeof serialized!=='string'||!serialized||(this.db.prepare('SELECT json_valid(?) AS valid').get(serialized) as {valid:number}).valid!==1)throw new Error('INVALID_PENDING_DONATION');
  const raw=parse(serialized) as Record<string,unknown>,providerId=String(raw?.id??'');
  const key=/^\d+$/.test(providerId)?providerId:createHash('sha256').update(serialized).digest('hex');
  const id=createHash('sha256').update(JSON.stringify(['donationalerts',account,key])).digest('hex');
  const payload=JSON.stringify({serialized,providerId,error:/^[A-Z_]+$/.test(error)?error:'IMPORT_FAILED'});
  this.db.prepare("INSERT INTO provider_snapshots VALUES (?,'donationalerts',?,'donation_unparsed',?,NULL,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,observed_at_ms=excluded.observed_at_ms").run(id,account,at,payload);
 }
 pendingCount(account:string):number {
  if(!account)throw new Error('INVALID_DONATION_ACCOUNT');
  return (this.db.prepare("SELECT count(*) AS n FROM provider_snapshots WHERE source='donationalerts' AND account_id=? AND key='donation_unparsed'").get(account) as {n:number}).n;
 }
 pending(account:string):PendingDonation[]{
  if(!account)throw new Error('INVALID_DONATION_ACCOUNT');
  return (this.db.prepare("SELECT id,payload_json FROM provider_snapshots WHERE source='donationalerts' AND account_id=? AND key='donation_unparsed' ORDER BY observed_at_ms,id LIMIT 100").all(account) as {id:string;payload_json:string}[]).map(row=>({id:row.id,serialized:JSON.parse(row.payload_json).serialized}));
 }
 removePending(account:string,id:string):void {
  this.db.prepare("DELETE FROM provider_snapshots WHERE source='donationalerts' AND account_id=? AND key='donation_unparsed' AND id=?").run(account,id);
 }
 clearImported(account:string,providerId:string):void {
  this.db.prepare("DELETE FROM provider_snapshots WHERE source='donationalerts' AND account_id=? AND key='donation_unparsed' AND json_extract(payload_json,'$.providerId')=?").run(account,providerId);
 }
 migrate():void {
  let last='';
  for(;;){
   const rows=this.db.prepare("SELECT id,account_id,key,payload_json,observed_at_ms FROM provider_snapshots WHERE id>? AND source='donationalerts' AND key IN('donation_history_page','donation_notification') ORDER BY id LIMIT 16").all(last) as {id:string;account_id:string;key:string;payload_json:string;observed_at_ms:number}[];
   if(!rows.length)break;
   for(const row of rows){
    // Older snapshots used JSON.stringify on LosslessNumber; restore the exact decimal as a string.
    const payload=JSON.parse(row.payload_json,(_key,value)=>value?.isLosslessNumber===true&&typeof value.value==='string'?value.value:value);
    const records=row.key==='donation_history_page'?(Array.isArray(payload.response?.data)?payload.response.data:[]):[findArchivedDonation(payload)].filter(Boolean);
    for(const raw of records){
     const id=String(raw?.id??''),known=/^\d+$/.test(id)?this.donationStates(row.account_id,[id])[0]:undefined;
     if(!known||known.needsImport){const encoded=stringify(raw);if(encoded)this.saveFailure(row.account_id,encoded,'LEGACY_PENDING',row.observed_at_ms);}
    }
    last=row.id;
   }
  }
 }
}
function findArchivedDonation(value:any,depth=0):any {
 if(depth>6||!value||typeof value!=='object')return null;
 if(value.id!==undefined&&value.amount!==undefined&&value.currency!==undefined)return value;
 for(const key of ['data','result','publication','push','pub']){let child=value[key];if(typeof child==='string'){try{child=parse(child);}catch{continue;}}const found=findArchivedDonation(child,depth+1);if(found)return found;}
 return null;
}

