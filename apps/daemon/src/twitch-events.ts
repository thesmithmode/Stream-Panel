/** EventSub collection only: provider API mutations are never issued. */
export const extraTwitchEvents:ReadonlyArray<readonly [string,string,string|null]>=[
 ['channel.chat.notification','1','user:read:chat'],
 ['channel.chat_settings.update','1','user:read:chat'],
 ['channel.shared_chat.begin','1',null],['channel.shared_chat.update','1',null],['channel.shared_chat.end','1',null],
 ['channel.subscription.end','1','channel:read:subscriptions'],
 ['channel.bits.use','1','bits:read'],
 ['channel.channel_points_automatic_reward_redemption.add','2','channel:read:redemptions'],
 ...['add','update','remove'].map(action=>[`channel.channel_points_custom_reward.${action}`,'1','channel:read:redemptions'] as const),
 ...['add','update'].map(action=>[`channel.channel_points_custom_reward_redemption.${action}`,'1','channel:read:redemptions'] as const),
 ...['begin','progress','end'].map(action=>[`channel.poll.${action}`,'1','channel:read:polls'] as const),
 ...['begin','progress','lock','end'].map(action=>[`channel.prediction.${action}`,'1','channel:read:predictions'] as const),
 ...['begin','progress','end'].map(action=>[`channel.hype_train.${action}`,'2','channel:read:hype_train'] as const),
 ...['begin','progress','end'].map(action=>[`channel.goal.${action}`,'1','channel:read:goals'] as const),
 ...['start','progress','stop','donate'].map(action=>[`channel.charity_campaign.${action}`,'1','channel:read:charity'] as const),
 ['channel.ad_break.begin','1','channel:read:ads'],
 ...['add','remove'].map(action=>[`channel.vip.${action}`,'1','channel:read:vips'] as const),
 ['channel.ban','1','channel:moderate'],['channel.unban','1','channel:moderate'],
 ['channel.moderator.add','1','moderation:read'],['channel.moderator.remove','1','moderation:read'],
];
export const extraTwitchScopes=[...new Set(extraTwitchEvents.map(([, ,scope])=>scope).filter((scope):scope is string=>Boolean(scope)))];
