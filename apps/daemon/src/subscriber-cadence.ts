/** Reuse the providers' existing collection loop; no extra timers or workers. */
export const subscriberInterval = (live: boolean) => (live ? 60_000 : 15 * 60_000);
/** Keep live totals fresh; a full roster can take up to 25 API calls. */
export const youtubeOfflineBackgroundInterval = 3 * 60 * 60_000;
export const youtubeSubscriberCountInterval = (live: boolean) => (live ? 5 * 60_000 : youtubeOfflineBackgroundInterval);
export const youtubeSubscriberListInterval = 60 * 60_000;
