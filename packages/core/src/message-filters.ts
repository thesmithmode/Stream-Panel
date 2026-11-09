/** Shared counting rules for stream cards and detailed summaries. One JSON binding per filter. */
export const twitchMessageFilter = `e.type='chat.message'
 AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id)
 AND (i.id IS NULL OR NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value='owner:'||i.person_id OR ((value=i.match_key OR value='person:'||i.person_id) AND i.person_id NOT IN(SELECT person_id FROM human_people UNION SELECT person_id FROM manual_neutral_people))))`;
export const youtubeMessageFilter = `NOT EXISTS(SELECT 1 FROM youtube_snapshots role WHERE role.account_id=m.account_id AND role.key='collectionRole' AND role.payload_json='"secondary"') AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
 AND y.is_owner=0 AND y.external_id<>y.account_id AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE value='owner:'||y.person_id OR ((value=y.match_key OR value='person:'||y.person_id) AND y.person_id NOT IN(SELECT person_id FROM human_people UNION SELECT person_id FROM manual_neutral_people)))`;
