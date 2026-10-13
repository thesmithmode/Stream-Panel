import Database from 'better-sqlite3';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseDonationTime,DA_API_UTC_OFFSET_MINUTES} from '../dist/packages/core/src/donation-time.js';
const dir=process.env.STREAM_PANEL_DATA_DIR;
if(!dir)throw new Error('DATA_DIRECTORY_REQUIRED');
const db=new Database(join(dir,'data.sqlite'),{readonly:true});
db.pragma('busy_timeout=20000');
try{
 for(const profile of ['ruslan','gulnaz']){
  const config=JSON.parse(await readFile(join(dir,'profiles',profile,'secrets.json'),'utf8'));
  if(!config.daApiUtcClockApplied||config.daUtcOffsetMinutes!==DA_API_UTC_OFFSET_MINUTES)throw new Error('DA_API_CLOCK_NOT_APPLIED');
  const rows=db.prepare(`SELECT source_time,occurred_at_ms FROM p_${profile}_events WHERE source='donationalerts' AND type='donation' AND account_id!='manual'`).all();
  let valid=0,invalid=0;
  for(const row of rows){
   if(row.source_time===null){invalid++;continue;}
   let expected;try{expected=parseDonationTime(row.source_time,DA_API_UTC_OFFSET_MINUTES);}catch{invalid++;continue;}
   if(row.occurred_at_ms!==expected)throw new Error('DA_TIME_REPAIR_INCOMPLETE');
   valid++;
  }
  const facts=db.prepare(`SELECT count(*) AS total,sum(occurred_at_ms IS NULL) AS untimed,sum(EXISTS(SELECT 1 FROM p_${profile}_event_sessions es WHERE es.event_id=e.id)) AS linked FROM p_${profile}_effective_events e WHERE source='donationalerts' AND type='donation'`).get();
  const perStream=db.prepare(`SELECT count(*) AS streams_with_donations FROM (SELECT es.session_id FROM p_${profile}_event_sessions es JOIN p_${profile}_effective_events e ON e.id=es.event_id WHERE e.type='donation' GROUP BY es.session_id)`).get();
  const missing=db.prepare(`SELECT count(*) AS unlinkedInsideRecordedStreams FROM p_${profile}_effective_events e WHERE e.source='donationalerts' AND e.type='donation' AND e.occurred_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM p_${profile}_sessions s WHERE s.started_at_ms<=e.occurred_at_ms AND (s.ended_at_ms IS NULL OR s.ended_at_ms>e.occurred_at_ms) AND NOT EXISTS(SELECT 1 FROM p_${profile}_session_tombstones t WHERE t.session_id=s.id)) AND NOT EXISTS(SELECT 1 FROM p_${profile}_event_sessions es WHERE es.event_id=e.id)`).get();
  if(missing.unlinkedInsideRecordedStreams)throw new Error('DA_STREAM_ASSIGNMENT_INCOMPLETE');
  let selectedPaymentStreamRowsVerified=0;
  if(profile==='gulnaz'){
   const selected=db.prepare(`SELECT es.session_id AS session,coalesce(json_extract(e.payload_json,'$.amountMinor'),'') AS amount FROM p_${profile}_effective_events e JOIN p_${profile}_events original ON original.id=e.id JOIN p_${profile}_event_sessions es ON es.event_id=e.id WHERE e.source='donationalerts' AND e.type='donation' AND json_extract(original.payload_json,'$.amountMinor')='22800' AND json_extract(original.payload_json,'$.currency')='RUB'`).all();
   for(const payment of selected){
    const tips=db.prepare(`SELECT json_extract(e.payload_json,'$.amountMinor') AS amount,json_extract(e.payload_json,'$.currency') AS currency FROM p_${profile}_effective_events e JOIN p_${profile}_event_sessions es ON es.event_id=e.id WHERE e.type='donation' AND es.session_id=?`).all(payment.session);
    const rub=tips.filter(t=>t.currency==='RUB'&&/^\d+$/.test(t.amount??'')).reduce((sum,t)=>sum+BigInt(t.amount),0n);
    if(!tips.length||!/^\d+$/.test(payment.amount)||rub<BigInt(payment.amount))throw new Error('DA_SELECTED_STREAM_TOTAL_INVALID');
    selectedPaymentStreamRowsVerified++;
   }
  }
  console.log(JSON.stringify({profile,utcOffsetMinutes:config.daUtcOffsetMinutes,validated:valid,invalidSourceTimes:invalid,total: facts.total,untimed:facts.untimed??0,linkedToStreams:facts.linked??0,...perStream,...missing,selectedPaymentStreamRowsVerified}));
 }
}finally{db.close();}
