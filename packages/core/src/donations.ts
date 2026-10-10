import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {assertTimestamp,moneyToMinor,eventKey} from './domain.js';
export interface DonationInput {personId:string;amount:string;currency:string;occurredAtMs:number|null;message:string;sourceName:string;}
type Raw = {id:string;source:string;account_id:string;external_id:string;identity_id:string|null;occurred_at_ms:number|null;payload_json:string;original_payload:string;revision:number;deleted:number;person_id:string|null;display_name:string|null;};
export class DonationLedger {
 constructor(private db:Database.Database){}
 ensureAnonymous(account:string):void {
  if(this.db.prepare('SELECT 1 FROM anonymous_donors WHERE account_id=?').get(account))return;
  const person=`anonymous:person:${account}`,identity=`anonymous:identity:${account}`;
  this.db.prepare("INSERT OR IGNORE INTO persons VALUES (?,'Аноним',1)").run(person);
  this.db.prepare("INSERT OR IGNORE INTO identities VALUES (?,'donationalerts',?,'anonymous:donor','Аноним','',?,?)").run(identity,account,person,`anonymous:${account}`);
  this.db.prepare('INSERT INTO anonymous_donors VALUES (?,?)').run(account,identity);
 }
 private raw(id:string):Raw {
  const row=this.db.prepare(`SELECT e.id,e.source,e.account_id,e.external_id,coalesce(c.identity_id,e.identity_id,a.identity_id) AS identity_id,
    CASE WHEN c.event_id IS NULL THEN e.occurred_at_ms ELSE c.occurred_at_ms END AS occurred_at_ms,
    coalesce(c.payload_json,e.payload_json) AS payload_json,e.payload_json AS original_payload,
    coalesce(c.revision,0) AS revision,coalesce(c.deleted,0) AS deleted,i.person_id,p.display_name
    FROM events e LEFT JOIN donation_corrections c ON c.event_id=e.id LEFT JOIN anonymous_donors a ON a.account_id=e.account_id AND e.source='donationalerts' AND e.type='donation'
    LEFT JOIN identities i ON i.id=coalesce(c.identity_id,e.identity_id,a.identity_id) LEFT JOIN persons p ON p.id=i.person_id
    WHERE e.id=? AND e.type='donation'`).get(id) as Raw|undefined;
  if(!row)throw new Error('DONATION_NOT_FOUND');return row;
 }
 donation(id:string) {
  const row=this.raw(id),payload=JSON.parse(row.payload_json),original=JSON.parse(row.original_payload);
  return {id:row.id,personId:row.person_id,personName:row.display_name,amountMinor:String(payload.amountMinor??''),currency:String(payload.currency??''),occurredAtMs:row.occurred_at_ms,message:String(payload.text??''),sourceName:String(payload.sourceName??(row.account_id==='manual'?'Manual':'DonationAlerts')),originalActorName:String(original.actorName??''),provider:row.source,providerAccount:row.account_id,providerId:row.external_id,revision:row.revision,deleted:row.deleted===1};
 }
 list(personId?:string,offset=0,limit=50,includeDeleted=false) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||typeof includeDeleted!=='boolean')throw new Error('INVALID_DONATION_PAGE');
  const scope=`e.type='donation' AND (? IS NULL OR i.person_id=?) AND (?=1 OR coalesce(c.deleted,0)=0)`;
  const args=[personId??null,personId??null,Number(includeDeleted)] as const;
  const ids=this.db.prepare(`SELECT e.id FROM events e LEFT JOIN donation_corrections c ON c.event_id=e.id LEFT JOIN anonymous_donors a ON a.account_id=e.account_id AND e.source='donationalerts' AND e.type='donation' LEFT JOIN identities i ON i.id=coalesce(c.identity_id,e.identity_id,a.identity_id) WHERE ${scope} ORDER BY coalesce(CASE WHEN c.event_id IS NULL THEN e.occurred_at_ms ELSE c.occurred_at_ms END,e.received_at_ms) DESC,e.id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset) as {id:string}[];
  const total=(this.db.prepare(`SELECT count(*) AS n FROM events e LEFT JOIN donation_corrections c ON c.event_id=e.id LEFT JOIN anonymous_donors a ON a.account_id=e.account_id AND e.source='donationalerts' AND e.type='donation' LEFT JOIN identities i ON i.id=coalesce(c.identity_id,e.identity_id,a.identity_id) WHERE ${scope}`).get(...args) as {n:number}).n;
  return {items:ids.map(row=>this.donation(row.id)),total,offset,limit};
 }
 private validate(input:DonationInput,manual=false):string {
  if(typeof input.personId!=='string'||typeof input.amount!=='string'||input.amount.length>50||typeof input.currency!=='string'||typeof input.message!=='string'||input.message.length>10000||typeof input.sourceName!=='string'||!input.sourceName.trim()||input.sourceName.length>200)throw new Error('INVALID_DONATION');
  if(input.occurredAtMs!==null)assertTimestamp(input.occurredAtMs);else if(manual)throw new Error('INVALID_DONATION_TIME');
  if(!this.db.prepare('SELECT 1 FROM persons WHERE id=?').get(input.personId))throw new Error('PERSON_NOT_FOUND');
  return moneyToMinor(input.amount,input.currency);
 }
 private identity(personId:string,eventId:string,kind:'manual'|'correction',at:number):string {
  const person=this.db.prepare('SELECT display_name FROM persons WHERE id=?').get(personId) as {display_name:string};
  const account=`${kind}:${eventId}`;
  const existing=this.db.prepare("SELECT id,person_id FROM identities WHERE source='donationalerts' AND account_id=? AND external_id='donation'").get(account) as {id:string;person_id:string}|undefined;
  const id=existing?.id??randomUUID();
  if(existing){
   this.db.prepare('UPDATE identities SET person_id=?,display_name=?,match_key=? WHERE id=?').run(personId,person.display_name,`manual:${personId}`,id);
   if(existing.person_id!==personId)this.db.prepare('UPDATE persons SET revision=revision+1 WHERE id IN(?,?)').run(existing.person_id,personId);
  }else{
   this.db.prepare("INSERT INTO identities VALUES (?,'donationalerts',?,'donation',?,'',?,?)").run(id,account,person.display_name,personId,`manual:${personId}`);
   this.db.prepare('UPDATE persons SET revision=revision+1 WHERE id=?').run(personId);
  }
  this.db.prepare('INSERT INTO membership_operations VALUES (?,?,?,?,?)').run(randomUUID(),kind==='manual'?'manual_donation':'donation_assignment',JSON.stringify(existing?[{id,personId:existing.person_id}]:[]),JSON.stringify([{id,personId}]),at);
  return id;
 }
 private assign(id:string,time:number|null):void {
  this.db.prepare('DELETE FROM event_sessions WHERE event_id=?').run(id);
  if(time===null)return;
  const sessions=this.db.prepare(`SELECT DISTINCT s.id FROM sessions s JOIN platform_streams p ON p.session_id=s.id
   WHERE s.kind='platform' AND p.started_at_ms<=? AND (p.ended_at_ms IS NULL OR p.ended_at_ms>?) AND (s.ended_at_ms IS NULL OR s.ended_at_ms>?) LIMIT 2`).all(time,time,time) as {id:string}[];
  if(sessions.length===1)this.db.prepare('INSERT INTO event_sessions VALUES (?,?)').run(id,sessions[0]!.id);
 }
 private audit(id:string,revision:number,kind:string,before:unknown,after:unknown,at:number):void {
  this.db.prepare('INSERT INTO donation_audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(),id,revision,kind,JSON.stringify(before),JSON.stringify(after),at);
 }
 create(input:DonationInput,at:number) {
  assertTimestamp(at);const amount=this.validate(input,true);
  return this.db.transaction(()=>{
   const externalId=randomUUID(),key=eventKey({source:'donationalerts',accountId:'manual',type:'donation',externalId});
   const identity=this.identity(input.personId,key,'manual',at);
   const person=this.db.prepare('SELECT display_name FROM persons WHERE id=?').get(input.personId) as {display_name:string};
   const payload={amountMinor:amount,currency:input.currency,text:input.message,sourceName:input.sourceName.trim(),actorName:person.display_name,manual:true};
   this.db.prepare("INSERT INTO events VALUES (?,'donationalerts','manual',?,'donation',?,?,?,?,'configured','rest',?)").run(key,externalId,identity,input.occurredAtMs,at,new Date(input.occurredAtMs!).toISOString(),JSON.stringify(payload));
   this.assign(key,input.occurredAtMs);const result=this.donation(key);this.audit(key,0,'create',null,result,at);return result;
  }).immediate();
 }
 update(id:string,input:DonationInput,revision:number,at:number) {
  assertTimestamp(at);const amount=this.validate(input);this.validRevision(revision);
  return this.db.transaction(()=>{
   const row=this.raw(id);if(row.revision!==revision)throw new Error('DONATION_CONFLICT');if(row.deleted)throw new Error('INVALID_DELETED_DONATION');
   const before=this.donation(id),identity=this.identity(input.personId,id,'correction',at);
   const person=this.db.prepare('SELECT display_name FROM persons WHERE id=?').get(input.personId) as {display_name:string};
   const payload={...JSON.parse(row.original_payload),amountMinor:amount,currency:input.currency,text:input.message,sourceName:input.sourceName.trim(),actorName:person.display_name,corrected:true};
   this.db.prepare(`INSERT INTO donation_corrections VALUES (?,?,?,?,0,?,?) ON CONFLICT(event_id) DO UPDATE SET identity_id=excluded.identity_id,occurred_at_ms=excluded.occurred_at_ms,payload_json=excluded.payload_json,revision=excluded.revision,updated_at_ms=MAX(updated_at_ms,excluded.updated_at_ms)`).run(id,identity,input.occurredAtMs,JSON.stringify(payload),revision+1,at);
   this.assign(id,input.occurredAtMs);const result=this.donation(id);this.audit(id,revision+1,'update',before,result,at);return result;
  }).immediate();
 }
 private validRevision(revision:number):void {if(!Number.isSafeInteger(revision)||revision<0)throw new Error('INVALID_DONATION_REVISION');}
 remove(id:string,revision:number,at:number):void {this.setDeleted(id,revision,at,true);}
 restore(id:string,revision:number,at:number) {this.setDeleted(id,revision,at,false);return this.donation(id);}
 private setDeleted(id:string,revision:number,at:number,deleted:boolean):void {
  assertTimestamp(at);this.validRevision(revision);
  this.db.transaction(()=>{
   const row=this.raw(id);if(row.revision!==revision)throw new Error('DONATION_CONFLICT');if(Boolean(row.deleted)===deleted)throw new Error(deleted?'INVALID_DELETED_DONATION':'INVALID_ACTIVE_DONATION');
   const before=this.donation(id);
   this.db.prepare(`INSERT INTO donation_corrections VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET deleted=excluded.deleted,revision=excluded.revision,updated_at_ms=MAX(updated_at_ms,excluded.updated_at_ms)`).run(id,row.identity_id,row.occurred_at_ms,row.payload_json,Number(deleted),revision+1,at);
   this.assign(id,deleted?null:row.occurred_at_ms);this.audit(id,revision+1,deleted?'delete':'restore',before,this.donation(id),at);
  }).immediate();
 }
 auditHistory(id:string) {this.raw(id);return this.db.prepare('SELECT id,revision,kind,before_json,after_json,created_at_ms FROM donation_audit WHERE event_id=? ORDER BY revision DESC').all(id) as Record<string,unknown>[];}
}
