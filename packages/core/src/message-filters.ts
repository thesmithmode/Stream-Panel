/** Shared counting rules for stream cards and detailed summaries. One JSON binding per filter. */
export const twitchMessageFilter = `e.type='chat.message'
 AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id)
 AND (i.id IS NULL OR i.match_key NOT IN(SELECT value FROM json_each(?)))`;
export const youtubeMessageFilter = `json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')
 AND y.is_owner=0 AND y.external_id<>y.account_id AND y.match_key NOT IN(SELECT value FROM json_each(?))`;
