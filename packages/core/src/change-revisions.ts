/** Durable, profile-scoped versions of screen facts. Operational heartbeats,
 * derived caches and unchanged payloads must never trigger a report download. */
type Spec=readonly [table:string,domain:string,columns:string,guard?:((row:string)=>string)];
const tracked:readonly Spec[]=[
 ['sessions','activity','started_at_ms,ended_at_ms,kind'],
 ['event_sessions','activity','event_id,session_id'],
 ['platform_streams','activity','session_id,started_at_ms,ended_at_ms,title,url'],
 ['stream_samples','activity','session_id,observed_at_ms,category_id,category_name,title,twitch_viewers,youtube_viewers'],
 ['presence_polls','activity','session_id,started_at_ms,completed_at_ms,status'],
 ['presence_members_compact','activity','poll_key,identity_key'],
 ['youtube_messages','activity','account_id,author_id,published_at_ms,payload_json'],
 ['events','activity','type,identity_id,occurred_at_ms,payload_json',r=>`${r}.type<>'donation'`],
 ['events','donations','type,identity_id,occurred_at_ms,payload_json',r=>`${r}.type='donation'`],
 ['donation_corrections','donations','identity_id,occurred_at_ms,payload_json,deleted,revision'],
 ['anonymous_donors','donations','account_id,identity_id'],
 ['session_groups','activity','member_id,group_id'],
 ['session_tombstones','activity','session_id'],
 ['collection_gaps','activity','source,reason,started_at_ms,ended_at_ms'],
 ['persons','people','display_name,revision'],
 ['identities','people','source,person_id,display_name,match_key'],
 ['youtube_identities','people','person_id,display_name,match_key,is_owner'],
 ['identity_aliases','people','identity_id,name,candidate_key'],
 ['youtube_identity_aliases','people','identity_id,name,match_key'],
 ['person_notes','people','person_id,body,revision'],
 ['person_preferences','people','person_id,manual_core'],
 ['person_tags','people','person_id,label'],
 ['donor_bindings','people','name_key,person_id,identity_id'],
 ['provider_snapshots','follows','source,account_id,key,payload_json',r=>`${r}.key='followers'`],
 ['subscriber_follows','subscribers','account_id,external_id,followed_at_ms,name'],
 ['subscriber_counts','subscribers','source,account_id,observed_at_ms,total'],
 ['youtube_publications','subscribers','account_id,video_id,title,published_at_ms,kind'],
 ['youtube_snapshots','subscribers','account_id,key,payload_json',r=>`${r}.key IN('channel','report')`],
];
/** Additive metadata versions; safe to initialize on existing version-28 profiles. */
export const analyticsPresentationSchema=`
INSERT OR IGNORE INTO ui_revisions(domain) VALUES('analyticsPresentation');
${[['person_preferences','person_id,manual_core'],['person_tags','person_id,label'],['collection_gaps','source,started_at_ms,ended_at_ms']].flatMap(([table,columns])=>['INSERT','UPDATE','DELETE'].map(op=>{
 const changed=op==='UPDATE'?columns!.split(',').map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR '):'';
 const relevant=table==='collection_gaps'?(op==='UPDATE'?"OLD.source IN('twitch','youtube') OR NEW.source IN('twitch','youtube')":`${op==='DELETE'?'OLD':'NEW'}.source IN('twitch','youtube')`):'';
 const guard=[changed,relevant].filter(Boolean).map(v=>'('+v+')').join(' AND ');
 return `CREATE TRIGGER IF NOT EXISTS presentation_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} ${guard?'WHEN '+guard:''} BEGIN UPDATE ui_revisions SET revision=revision+1 WHERE domain='analyticsPresentation'; END;`;
})).join('\n')}
`;
export const changeRevisionSchema=`
CREATE TABLE IF NOT EXISTS ui_revisions(domain TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
INSERT OR IGNORE INTO ui_revisions(domain) VALUES('activity'),('people'),('donations'),('follows'),('subscribers');
${tracked.flatMap(([table,domain,columns,guard])=>['INSERT','UPDATE','DELETE'].map(operation=>{
 const row=operation==='DELETE'?'OLD':'NEW';
 const changed=operation==='UPDATE'?columns.split(',').map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR '):'';
 const relevant=guard?(operation==='UPDATE'?`(${guard('OLD')}) OR (${guard('NEW')})`:guard(row)):'';
 const when=[changed,relevant].filter(Boolean).map(x=>`(${x})`).join(' AND ');
 return `CREATE TRIGGER IF NOT EXISTS ui_${domain}_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} ${when?'WHEN '+when:''} BEGIN UPDATE ui_revisions SET revision=revision+1 WHERE domain='${domain}'; END;`;
})).join('\n')}
${analyticsPresentationSchema}
PRAGMA user_version=26;
`;
