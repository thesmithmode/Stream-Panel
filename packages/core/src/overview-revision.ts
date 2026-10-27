const tables=['events','event_sessions','presence_polls','presence_members_compact','identities','youtube_messages','youtube_identities','identity_aliases','youtube_identity_aliases','session_tombstones'];
export const overviewRevisionSchema=`INSERT OR IGNORE INTO ui_revisions(domain) VALUES('overviewAttendance');
${tables.flatMap(table=>['INSERT','UPDATE','DELETE'].map(op=>{
 const rows=op==='INSERT'?['NEW']:op==='DELETE'?['OLD']:['OLD','NEW'];
 let guard=table==='events'?rows.map(row=>`${row}.type='chat.message'`).join(' OR '):table==='event_sessions'?rows.map(row=>`EXISTS(SELECT 1 FROM events WHERE id=${row}.event_id AND type='chat.message')`).join(' OR '):'';
 if(op!=='DELETE'&&['identities','youtube_identities','identity_aliases','youtube_identity_aliases'].includes(table))guard=rows.map(row=>{
  const youtube=table.startsWith('youtube_'),identityTable=youtube?'youtube_identities':'identities';
  const person=table.endsWith('_aliases')?`(SELECT person_id FROM ${identityTable} WHERE id=${row}.identity_id)`:`${row}.person_id`;
  return `EXISTS(SELECT 1 FROM events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=${person} AND e.type='chat.message') OR EXISTS(SELECT 1 FROM presence_members m JOIN identities i ON i.id=m.identity_id WHERE i.person_id=${person}) OR EXISTS(SELECT 1 FROM youtube_messages m JOIN youtube_identities i ON i.account_id=m.account_id AND i.external_id=m.author_id WHERE i.person_id=${person})`;
 }).join(' OR ');
 if(op==='UPDATE'){
  const columns:Record<string,string>={events:'type,identity_id,occurred_at_ms,payload_json',event_sessions:'event_id,session_id',presence_polls:'session_id,started_at_ms,completed_at_ms,status',presence_members_compact:'poll_key,identity_key',identities:'person_id,display_name,match_key',youtube_messages:'account_id,author_id,published_at_ms,payload_json',youtube_identities:'person_id,display_name,match_key,is_owner',identity_aliases:'identity_id,name,candidate_key',youtube_identity_aliases:'identity_id,name,match_key',session_tombstones:'session_id'};
  const changed=columns[table]!.split(',').map(column=>`OLD.${column} IS NOT NEW.${column}`).join(' OR ');
  guard=guard?`(${guard}) AND (${changed})`:changed;
 }
 return `CREATE TRIGGER IF NOT EXISTS overview_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} ${guard?'WHEN '+guard:''} BEGIN UPDATE ui_revisions SET revision=revision+1 WHERE domain='overviewAttendance'; END;`;
})).join('\n')}
PRAGMA user_version=28;`;
