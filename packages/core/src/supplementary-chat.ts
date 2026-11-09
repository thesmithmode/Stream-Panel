import type Database from 'better-sqlite3';

/** A presentation projection only: supplementary chat is never an analytical input. */
export class SupplementaryChat {
 constructor(private db:Database.Database){}
 participants(session:string,botJson:string,now=Date.now(),activeOnly=false,includeExcluded=false){
  return this.db.prepare(`SELECT y.person_id AS id,p.display_name AS name,y.display_name AS accountName,m.account_id AS accountId,
   count(*) AS messages,max(m.published_at_ms) AS lastMessageAt
   FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id
   JOIN persons p ON p.id=y.person_id
   JOIN youtube_snapshots role ON role.account_id=m.account_id AND role.key='collectionRole' AND role.payload_json='"secondary"'
   WHERE m.published_at_ms<=? AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
   AND EXISTS(SELECT 1 FROM logical_sessions s WHERE s.id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id)
    AND m.published_at_ms>=s.started_at_ms AND m.published_at_ms<coalesce(s.ended_at_ms,?+1)
    AND (s.kind='manual' OR EXISTS(SELECT 1 FROM logical_platform_streams ps WHERE ps.session_id=s.id AND m.published_at_ms>=ps.started_at_ms AND m.published_at_ms<coalesce(ps.ended_at_ms,?+1))))
   AND (?=1 OR (y.is_owner=0 AND y.external_id<>y.account_id AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value='owner:'||y.person_id OR ((value=y.match_key OR value='person:'||y.person_id) AND y.person_id NOT IN(SELECT person_id FROM human_people UNION SELECT person_id FROM manual_neutral_people)))))
   AND (?=0 OR EXISTS(SELECT 1 FROM youtube_snapshots b,json_each(b.payload_json) video WHERE b.account_id=m.account_id AND b.key='broadcasts' AND b.updated_at_ms>? AND json_extract(video.value,'$.snippet.liveChatId')=m.chat_id))
   GROUP BY y.person_id,m.account_id
   HAVING ?=0 OR max(m.published_at_ms)>?
   ORDER BY lastMessageAt DESC,y.person_id,m.account_id`).all(now,session,now,now,Number(includeExcluded),botJson,Number(activeOnly),now-180000,Number(activeOnly),now-600000) as {id:string;name:string;accountName:string;accountId:string;messages:number;lastMessageAt:number}[];
 }
 /** Only people known exclusively through supplementary YouTube receive this colour. */
 decorate<T>(rows:T[],personId:(row:T)=>string):(T&{youtubeSecondary:boolean})[]{
  const ids=JSON.stringify(rows.map(personId));
  const secondary=new Set((this.db.prepare(`SELECT DISTINCT y.person_id FROM youtube_identities y
   WHERE y.person_id IN(SELECT value FROM json_each(?))
   AND EXISTS(SELECT 1 FROM youtube_snapshots r WHERE r.account_id=y.account_id AND r.key='collectionRole' AND r.payload_json='"secondary"')
   AND NOT EXISTS(SELECT 1 FROM youtube_identities other WHERE other.person_id=y.person_id AND NOT EXISTS(SELECT 1 FROM youtube_snapshots r WHERE r.account_id=other.account_id AND r.key='collectionRole' AND r.payload_json='"secondary"'))
   AND NOT EXISTS(SELECT 1 FROM identities i WHERE i.person_id=y.person_id AND i.source='twitch')`).all(ids) as {person_id:string}[]).map(r=>r.person_id));
  return rows.map(row=>({...row,youtubeSecondary:secondary.has(personId(row))}));
 }
}
