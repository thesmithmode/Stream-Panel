import type {StreamStore} from '../../../packages/core/src/store.js';

/** One allowlist defines worker operations, client types and cache policy. */
export const storeOperations={
  currentChat:"read",
  subscriberHistory:"read",
  changes:"read",
  youtubePublications:"write",
  channelOverview:"cached",
  analytics:"cached",
  clockAudience:"cached",
  warmAnalytics:"maintenance",
  advanceAnalytics:"maintenance",
  streamSample:"write",
  youtubeViewers:"write",
  followingSnapshot:"write",
  personFollowing:"cached",
  followingAnalytics:"cached",
  youtubeQuota:"maintenance",
  youtubeSnapshot:"write",
  providerSnapshot:"write",
  collectionLifecycle:"write",
  streamMetadata:"cached",
  youtubeMessages:"write",
  youtubeData:"read",
  ingest:"write",
  donationImportStates:"read",
  pendingDonationImports:"read",
  pendingDonationImportCount:"read",
  saveDonationImportFailure:"maintenance",
  removePendingDonation:"maintenance",
  ingestLiveDonation:"write",
  sessions:"cached",
  matchingStream:"read",
  streamMatchContext:"read",
  mergeSessions:"write",
  unmergeSessions:"write",
  platformStreams:"read",
  platformMissing:"write",
  attachPlatformStream:"write",
  observePlatformStream:"write",
  activeLogicalStream:"read",
  startSession:"write",
  endSession:"write",
  deleteManualSession:"write",
  recordPoll:"write",
  updateChatterNames:"write",
  persons:"cached",
  personsPage:"cached",
  personOptions:"cached",
  personAnalytics:"cached",
  createPerson:"write",
  donorNicknames:"cached",
  donorBindings:"cached",
  bindDonorNickname:"write",
  person:"cached",
  personNotes:"cached",
  createPersonNote:"write",
  updatePersonNote:"write",
  deletePersonNote:"write",
  personMetadata:"cached",
  setPersonMetadata:"write",
  resolveDonationTimes:"write",
  reassignDonation:"write",
  donation:"cached",
  donations:"cached",
  createDonation:"write",
  restoreDonation:"write",
  donationAudit:"cached",
  donationCandidates:"cached",
  events:"cached",
  recentEvents:"read",
  purgeRecentEvents:"maintenance",
  summary:"cached",
  grid:"read",
  renamePerson:"write",
  splitIdentities:"write",
  splits:"cached",
  undoSplit:"write",
  merges:"cached",
  merge:"write",
  undoMerge:"write",
  gap:"write",
  gaps:"read",
  backup:"maintenance",
  close:"write",
  candidatePersons:"cached",
  insights:"cached",
  personsTop:"cached",
  personStats:"cached",
  personActivity:"cached",
  ensureOwnerIdentity:"write",
} as const satisfies Partial<Record<keyof StreamStore,'cached'|'read'|'write'|'maintenance'>>;
export type StoreMethod=keyof typeof storeOperations;
export type StoreRequest={
  [Method in StoreMethod]:[method:Method,...args:Parameters<StreamStore[Method]>]
}[StoreMethod];
export type StoreResult<Method extends StoreMethod> = Awaited<ReturnType<StreamStore[Method]>>;
/** Consumers depend on their required operations, not the worker implementation. */
export type StorePort<Method extends StoreMethod> = {
  call<Request extends Extract<StoreRequest, [Method, ...unknown[]]>>(...request: Request): Promise<StoreResult<Request[0]>>;
};
export function isStoreMethod(value:string):value is StoreMethod {
  return Object.hasOwn(storeOperations,value);
}
export function operationsWithPolicy(policy:'cached'|'read'|'write'|'maintenance'):Set<string> {
  return new Set(Object.entries(storeOperations).filter(([,value])=>value===policy).map(([name])=>name));
}

/** Operational heartbeats and maintenance do not change analytical facts. */
export function invalidatesCachedReads(method:StoreMethod,args:readonly unknown[]):boolean{
  if(method==='youtubeSnapshot'&&typeof args[1]==='string'&&args[1].startsWith('cursor:'))return false;
  if(method==='youtubeMessages'&&Array.isArray(args[2])&&args[2].length===0)return false;
  return storeOperations[method]==='write'&&method!=='close'&&!(method==='collectionLifecycle'&&args[0]==='heartbeat');
}


