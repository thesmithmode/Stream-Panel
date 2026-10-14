/** Content-free chat observations preserve exact counts, attribution and deduplication. */
export function chatMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return {count:1,...(typeof payload.originChannelId === "string" ? {originChannelId:payload.originChannelId} : {}),
    ...(payload.redacted === 1 ? {redacted:1} : {})};
}
export function moderationMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...(typeof payload.targetMessageId === "string" ? {targetMessageId:payload.targetMessageId} : {}),
    ...(typeof payload.targetUserId === "string" ? {targetUserId:payload.targetUserId} : {})};
}
export function messageMetadata(message: any) {
  return {snippet:{type:message.snippet?.type,publishedAt:message.snippet?.publishedAt},
    authorDetails:{channelId:message.authorDetails?.channelId,displayName:message.authorDetails?.displayName,
      isChatOwner:message.authorDetails?.isChatOwner === true}};
}
