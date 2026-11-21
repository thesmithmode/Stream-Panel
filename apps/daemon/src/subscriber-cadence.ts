/** Reuse the providers' existing collection loop; no extra timers or workers. */
export const subscriberInterval=(live:boolean)=>live?60_000:15*60_000;
/** YouTube Data API quota: the live subscriber total every 5 minutes, the public subscriber list every 15 minutes (Twitch keeps subscriberInterval). */
export const youtubeSubscriberCountInterval=(live:boolean)=>live?5*60_000:15*60_000;
export const youtubeSubscriberListInterval=15*60_000;
