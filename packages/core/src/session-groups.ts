import type Database from 'better-sqlite3';

/** Changes only group membership. Collection always writes original session IDs. */
export class SessionGroups {
 constructor(private readonly db:Database.Database){}
 root(id:string):string{return (this.db.prepare('SELECT group_id FROM session_groups WHERE member_id=?').get(id) as {group_id:string}|undefined)?.group_id??id;}
 members(id:string):string[]{const root=this.root(id);const rows=this.db.prepare('SELECT member_id FROM session_groups WHERE group_id=? ORDER BY member_id').all(root) as {member_id:string}[];return rows.length?rows.map(r=>r.member_id):[root];}
 merge(ids:string[]):string{
  if(!Array.isArray(ids)||ids.length<2||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>256))throw new Error('INVALID_SESSION_GROUP');
  return this.db.transaction(()=>{
   const members=[...new Set(ids.flatMap(id=>this.members(id)))];
   if(members.length>100)throw new Error('INVALID_SESSION_GROUP');
   const rows=this.db.prepare(`SELECT s.* FROM sessions s WHERE id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY started_at_ms,id`).all(JSON.stringify(members)) as {id:string;kind:string;started_at_ms:number;ended_at_ms:number|null}[];
   if(rows.length!==members.length||rows.some(row=>row.kind!=='platform'||row.ended_at_ms===null||row.ended_at_ms<=row.started_at_ms)||rows.some((row,i)=>i>0&&row.started_at_ms<rows[i-1]!.ended_at_ms!)||rows.at(-1)!.ended_at_ms!-rows[0]!.started_at_ms>31*86400000)throw new Error('INVALID_SESSION_GROUP');
   const root=rows[0]!.id,insert=this.db.prepare('INSERT INTO session_groups(member_id,group_id) VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET group_id=excluded.group_id');
   for(const row of rows)insert.run(row.id,root);
   return root;
  }).immediate();
 }
 unmerge(id:string):void{
  this.db.transaction(()=>{
   const root=this.root(id),members=this.members(root);
   if(!this.db.prepare('SELECT 1 FROM session_groups WHERE group_id=?').get(root))throw new Error('SESSION_GROUP_NOT_FOUND');
   if(this.db.prepare('SELECT 1 FROM sessions WHERE id IN(SELECT value FROM json_each(?)) AND ended_at_ms IS NULL').get(JSON.stringify(members)))throw new Error('INVALID_SESSION_GROUP');
   this.db.prepare('DELETE FROM session_groups WHERE group_id=?').run(root);
  }).immediate();
 }
}

/** Read-side projection only. Literals and bound values are never rewritten.
 * SQL views expose one logical session to existing analytics; no fact is moved.
 * Collection, identity changes and backups retain the physical connection. */
export function logicalReadDatabase(db:Database.Database):Database.Database{
 const views=new Map(['sessions','event_sessions','presence_polls','platform_streams','stream_samples','follower_observations','analytics_stream_revisions'].map(name=>[name,`logical_${name}`]));
 return new Proxy(db,{get(target,property){
  if(property==='prepare')return(sql:string)=>{
   if(/^\s*(SELECT|WITH)\b/i.test(sql))sql=sql.replace(/\s+INDEXED BY (?:event_sessions_session|presence_polls_session_time|platform_streams_session_end|sessions_start)\b/gi,'').replace(/'(?:''|[^'])*'|\b[a-z_][a-z0-9_]*\b/gi,token=>views.get(token.toLowerCase())??token);
   return target.prepare(sql);
  };
  const value=Reflect.get(target,property,target) as unknown;return typeof value==='function'?value.bind(target):value;
 }});
}
