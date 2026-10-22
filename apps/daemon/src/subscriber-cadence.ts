/** Reuse the providers' existing collection loop; no extra timers or workers. */
export const subscriberInterval=(live:boolean)=>live?60_000:15*60_000;
