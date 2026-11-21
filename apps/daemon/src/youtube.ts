import {youtubeSubscriberCountInterval,youtubeSubscriberListInterval} from './subscriber-cadence.js';
import {collectYouTubePublications} from './youtube-publications.js';
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { ConfigurationPort, Tokens } from "./config.js";
import type {StorePort} from './store-contract.js';
type YoutubeStore = StorePort<'youtubePublications' | 'followingSnapshot' | 'gap' | 'observePlatformStream' | 'platformMissing' | 'youtubeData' | 'youtubeMessages' | 'youtubeQuota' | 'youtubeSnapshot' | 'youtubeViewers'>;
import { object, string, type ProviderConnection } from "./provider-values.js";
const scopes = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const videoParts='snippet,statistics,contentDetails,liveStreamingDetails,status,recordingDetails,topicDetails,localizations,paidProductPlacementDetails';
/** Google quota units per Data API read (https://developers.google.com/youtube/v3/determine_quota_cost): every list used here costs 1, a live chat read costs 5. */
export const youtubeUnitCost=(resource:string)=>resource==='liveChat/messages'?5:1;
/** Local daily budgets in Google units (default project quota: 10 000 units/day, reset at midnight Pacific Time). */
export const YOUTUBE_DAILY_UNITS={primary:9000,secondary:3000} as const;
/** While live, the active broadcast list is rediscovered at most this often; per-minute video reads confirm that known broadcasts are still live. */
export const YOUTUBE_LIVE_DISCOVERY_MS=5*60_000;
/** Chat pacing: 60 s while messages arrive, 120 s while quiet, never faster than a 90 s long-run average (small burst allowance). */
export const YOUTUBE_CHAT_PACE={activeMs:60_000,quietMs:120_000,averageMs:90_000,burst:4,toleranceMs:5_000} as const;
type ChatPace={at:number;credits:number;quiet:boolean;floor:number};
type Snapshots=Record<string,{data:unknown;updatedAt:number}>;
type LiveState={broadcasts:Record<string,any>[];videoDetails:Map<string,Record<string,any>>;reused:boolean};
// A reused broadcast list stays valid only while the per-minute video read still says live:
// snippet.liveBroadcastContent leaves 'live' and actualEndTime appears when a stream ends,
// and either signal alone triggers rediscovery (whichever YouTube updates first).
const stillLive=(video:Record<string,any>|undefined)=>!!video&&!!video.liveStreamingDetails&&typeof video.liveStreamingDetails==='object'&&!video.liveStreamingDetails.actualEndTime&&video.snippet?.liveBroadcastContent==='live';
export class YouTubeConnection implements ProviderConnection {
  status:{state:string;account:string;detail:string;lastSyncAt?:number;lastFollowersAt?:number} = { state: "disconnected", account: "", detail: "" };
  private pending: { state: string; verifier: string; expires: number; clientId: string; secret: string } | undefined;
  private generation = 0;
  private authAttempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private requests = new Set<AbortController>();
  private refreshing: Promise<void> | undefined;
  private initialCountChecked = false;
  private broadcastCache:{at:number;items:Record<string,any>[]}|undefined;
  private readonly chatPace=new Map<string,ChatPace>();
  constructor(private config: ConfigurationPort, private db: YoutubeStore, private redirect: string,
    private profile: string, private request: typeof fetch = fetch, private now = Date.now,private mode:{chatOnly?:boolean;otherAccount?:()=>string|undefined}={}) {}
  acceptsState(state:string){return !!this.pending&&this.pending.state===state;}
  private requiredScopes(){return this.mode.chatOnly?scopes.slice(0,1):scopes;}
  private async json(url: string, init: RequestInit = {}) {
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.request(url, { ...init, signal: controller.signal });
      const data = object(await response.json());
      if (!response.ok && url === "https://oauth2.googleapis.com/token" && response.status < 500) {
        if (data.error === "invalid_grant") throw new Error("YOUTUBE_REFRESH_REJECTED");
        if (data.error === "invalid_client" || data.error === "unauthorized_client") throw new Error("YOUTUBE_CLIENT_REJECTED");
      }
      if (!response.ok) throw new Error(response.status === 401 ? "YOUTUBE_AUTH_REQUIRED" : response.status === 403 ? "YOUTUBE_ACCESS_OR_QUOTA" : "YOUTUBE_REQUEST_FAILED");
      return data;
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private token(body: Record<string,string>, clientId = this.config.value.youtubeClientId ?? "", secret = this.config.value.youtubeClientSecret ?? "") {
    return this.json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: clientId, client_secret: secret }) });
  }
  private async refresh(tokens: Tokens) {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const operation = (async () => {
      const data = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refresh });
      if (generation !== this.generation || this.config.value.youtube !== tokens) return;
      if (!string(data.access_token) || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error("YOUTUBE_INVALID_TOKEN");
      tokens.access = string(data.access_token);
      tokens.refresh = string(data.refresh_token) || tokens.refresh;
      tokens.expiresAt = this.now() + Number(data.expires_in) * 1000;
      await this.config.save();
    })();
    this.refreshing = operation;
    try { await operation; } finally { if (this.refreshing === operation) this.refreshing = undefined; }
  }
  private async authorizedJson(url: string, tokens: Tokens) {
    const generation = this.generation, access = tokens.access;
    try { return await this.json(url, { headers: { Authorization: `Bearer ${access}` } }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "YOUTUBE_AUTH_REQUIRED" ||
          generation !== this.generation || this.config.value.youtube !== tokens) throw error;
      // Google can invalidate an access token before its advertised expiry.
      // Share refreshes and retry the failed request once, without replaying writes.
      if (tokens.access === access) await this.refresh(tokens);
      if (generation !== this.generation || this.config.value.youtube !== tokens) return {};
      return this.json(url, { headers: { Authorization: `Bearer ${tokens.access}` } });
    }
  }
  async beginAuth(clientId: string, secret: string) {
    if (!clientId || clientId.length > 256 || secret.length > 256) throw new Error("INVALID_YOUTUBE_CLIENT");
    if (!secret && !this.config.value.youtubeClientSecret) throw new Error("MISSING_YOUTUBE_SECRET");
    if (!secret && this.config.value.youtubeClientId && clientId !== this.config.value.youtubeClientId) throw new Error("MISSING_YOUTUBE_SECRET");
    this.authAttempt++;
    const state = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
    this.pending = { state, verifier, expires: this.now() + 600000, clientId, secret: secret || this.config.value.youtubeClientSecret! };
    this.status = { state: "authorizing", account: "", detail: "Завершите вход в Google" };
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: this.redirect, response_type: "code", scope: this.requiredScopes().join(" "), access_type: "offline", prompt: "consent", state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  }
  async finishAuth(code: string, state: string) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || !code || this.now() > pending.expires || state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new Error("INVALID_YOUTUBE_STATE");
    const generation = this.generation, attempt = this.authAttempt;
    const data = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirect, code_verifier: pending.verifier }, pending.clientId, pending.secret);
    if (generation !== this.generation || attempt !== this.authAttempt) return;
    const granted = string(data.scope).split(" ");
    if (!this.requiredScopes().every(s => granted.includes(s)) || !string(data.access_token) || !string(data.refresh_token)) throw new Error("YOUTUBE_SCOPES_REQUIRED");
    const tokens: Tokens = { access: string(data.access_token), refresh: string(data.refresh_token), expiresAt: this.now() + Number(data.expires_in) * 1000, userId: "", scopes: granted };
    if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= this.now()) throw new Error("YOUTUBE_INVALID_TOKEN");
    const channels = await this.api("channels", { part: "snippet,statistics,brandingSettings,contentDetails,topicDetails", mine: "true", maxResults: "50" }, tokens);
    if (generation !== this.generation || attempt !== this.authAttempt) return;
    const items = Array.isArray(channels.items) ? channels.items : [];
    if (items.length !== 1 || channels.nextPageToken || !string(object(items[0]).id)) throw new Error("YOUTUBE_SELECT_ONE_CHANNEL");
    tokens.userId = string(object(items[0]).id);
    if(tokens.userId===this.mode.otherAccount?.())throw new Error("YOUTUBE_ACCOUNT_ALREADY_CONNECTED");
    await this.stop();
    if (this.generation !== generation + 1 || this.authAttempt !== attempt + 1) return;
    this.config.value.youtubeClientId = pending.clientId;
    this.config.value.youtubeClientSecret = pending.secret;
    this.config.value.youtube = tokens;
    this.config.value.youtubeAccountId = tokens.userId;
    await this.db.call("youtubeSnapshot", tokens.userId, this.mode.chatOnly?"chatChannel":"channel", items[0], this.now());
    await this.db.call("youtubeSnapshot",tokens.userId,"collectionRole",this.mode.chatOnly?"secondary":"primary",this.now());
    await this.config.save();
    void this.start();
  }
  private async api(resource: string, params: Record<string,string>, tokens: Tokens) {
    const generation=this.generation;
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now());
    if (!await this.db.call("youtubeQuota", day, this.mode.chatOnly?`${this.profile}:secondary`:this.profile, youtubeUnitCost(resource),this.mode.chatOnly?YOUTUBE_DAILY_UNITS.secondary:YOUTUBE_DAILY_UNITS.primary)) throw new Error("YOUTUBE_DAILY_BUDGET");
    const data=await this.authorizedJson(`https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`, tokens);
    if(generation!==this.generation)return {};

    return data;
  }
  private async activeBroadcasts(tokens: Tokens, valid: () => boolean) {
    let page = "";
    const seenPages = new Set<string>(), seenIds = new Set<string>(), broadcasts: Record<string, any>[] = [];
    for (let n = 0; n < 5; n++) {
      const response = await this.api("liveBroadcasts", { part: "snippet,status,contentDetails,monetizationDetails", broadcastStatus: "active", maxResults: "50", ...(page ? { pageToken: page } : {}) }, tokens);
      if (!valid()) return null;
      if (!Array.isArray(response.items) || response.items.length > 50) throw new Error("YOUTUBE_INVALID_BROADCASTS");
      for (const value of response.items) {
        let item: Record<string, unknown>, snippet: Record<string, unknown>;
        try { item = object(value); snippet = object(item.snippet); }
        catch { throw new Error("YOUTUBE_INVALID_BROADCASTS"); }
        const id = string(item.id), channelId = string(snippet.channelId);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !channelId || seenIds.has(id) ||
            (snippet.liveChatId !== undefined && typeof snippet.liveChatId !== "string") ||
            (snippet.title !== undefined && typeof snippet.title !== "string")) throw new Error("YOUTUBE_INVALID_BROADCASTS");
        seenIds.add(id);
        if (channelId === tokens.userId) broadcasts.push({ ...item, id, snippet });
      }
      const next = response.nextPageToken;
      if (next !== undefined && (typeof next !== "string" || next.length > 512)) throw new Error("YOUTUBE_INVALID_BROADCASTS");
      if (!next) return broadcasts;
      if (seenPages.has(next)) throw new Error("YOUTUBE_INVALID_BROADCASTS");
      if (n === 4) throw new Error("YOUTUBE_BROADCAST_PAGINATION_LIMIT");
      seenPages.add(next);
      page = next;
    }
    throw new Error("YOUTUBE_BROADCAST_PAGINATION_LIMIT");
  }
  private async discoverBroadcasts(tokens:Tokens,valid:()=>boolean){
    const broadcasts=await this.activeBroadcasts(tokens,valid);
    if(broadcasts&&valid())this.broadcastCache=broadcasts.length?{at:this.now(),items:broadcasts}:undefined;
    return broadcasts;
  }
  /** Validated video details by ID; a malformed batch is left out. */
  private async videoDetails(ids:string[],tokens:Tokens,valid:()=>boolean){
    const videoDetails = new Map<string, Record<string, any>>();
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batchIds = ids.slice(offset, offset + 50);
      const response = await this.api("videos", { part: videoParts, id: batchIds.join(",") }, tokens);
      if (!valid()) return null;
      if (!Array.isArray(response.items)) continue;
      const batch = new Map<string, Record<string, any>>();
      let malformed = false;
      for (const value of response.items) {
        if (!value || typeof value !== "object" || Array.isArray(value)) { malformed = true; break; }
        const item = value as Record<string, any>, id = string(item.id);
        if (!batchIds.includes(id) || batch.has(id)) { malformed = true; break; }
        batch.set(id, item);
      }
      if (malformed || batch.size !== batchIds.length || batchIds.some(id => !batch.has(id))) continue;
      for (const [id, item] of batch) videoDetails.set(id, item);
    }
    return videoDetails;
  }
  /**
   * Active broadcasts with their video details. While live, a recent broadcast list is reused
   * when the per-minute video read confirms every known broadcast is still live; otherwise
   * (ended, missing or unconfirmed) the list is rediscovered at once.
   */
  private async liveState(tokens:Tokens,valid:()=>boolean){
    const cached=this.broadcastCache;let known:Map<string,Record<string,any>>|undefined,knownIds:string[]=[];
    if(cached&&this.now()-cached.at<YOUTUBE_LIVE_DISCOVERY_MS){
      knownIds=cached.items.map(b=>string(b.id));
      const details=await this.videoDetails(knownIds,tokens,valid);if(!details)return null;
      if(knownIds.every(id=>stillLive(details.get(id))))return {broadcasts:cached.items,videoDetails:details,reused:true};
      known=details;
    }
    const broadcasts=await this.discoverBroadcasts(tokens,valid);if(!broadcasts||!valid())return null;
    const ids=broadcasts.map(b=>string(b.id));
    if(known&&ids.length===knownIds.length&&ids.every((id,i)=>id===knownIds[i]))return {broadcasts,videoDetails:known,reused:false};
    const videoDetails=await this.videoDetails(ids,tokens,valid);if(!videoDetails)return null;
    return {broadcasts,videoDetails,reused:false};
  }
  private chatDue(chat:string):boolean{
    const pace=this.chatPace.get(chat);if(!pace)return true;
    const elapsed=this.now()-pace.at,credits=Math.min(YOUTUBE_CHAT_PACE.burst,pace.credits+elapsed/YOUTUBE_CHAT_PACE.averageMs);
    return credits>=1&&elapsed>=Math.max(pace.quiet?YOUTUBE_CHAT_PACE.quietMs:YOUTUBE_CHAT_PACE.activeMs,pace.floor)-YOUTUBE_CHAT_PACE.toleranceMs;
  }
  private chatPolled(chat:string,messages:number,floor:number){
    const now=this.now(),pace=this.chatPace.get(chat);
    const credits=pace?Math.min(YOUTUBE_CHAT_PACE.burst,pace.credits+(now-pace.at)/YOUTUBE_CHAT_PACE.averageMs):YOUTUBE_CHAT_PACE.burst;
    this.chatPace.set(chat,{at:now,credits:credits-1,quiet:messages===0,floor});
  }
  /**
   * Reads every due chat from its saved cursor (skipped polls lose nothing) and returns the
   * loop interval: 60 s while live, raised to YouTube's pollingIntervalMillis like before.
   */
  private async collectChats(tokens:Tokens,broadcasts:Record<string,any>[],snapshots:Record<string,{data:unknown;updatedAt:number}>,valid:()=>boolean,reused:boolean):Promise<number|null>{
    let interval=broadcasts.length?60000:300000,ended=false;
    const chats=new Set<string>();
    for(const broadcast of broadcasts){
      const chat=string(broadcast.snippet?.liveChatId);if(!chat)continue;chats.add(chat);
      if(!this.chatDue(chat)){interval=Math.max(interval,this.chatPace.get(chat)!.floor);continue;}
      const cursor=string(snapshots[`cursor:${chat}`]?.data);
      let response:Record<string,any>;
      try{response=await this.api('liveChat/messages',{part:'id,snippet,authorDetails',liveChatId:chat,maxResults:'2000',...(cursor?{pageToken:cursor}:{})},tokens);}
      catch(error){
        // A reused list may name a broadcast that just ended: confirm before reporting a failure.
        if(!reused||!valid())throw error;
        const fresh=await this.discoverBroadcasts(tokens,valid);if(!fresh||!valid())return null;
        if(fresh.some(item=>string(item.snippet?.liveChatId)===chat))throw error;
        if(!fresh.length)ended=true;
        continue;
      }
      if(!valid())return null;
      const items=Array.isArray(response.items)?response.items:[];
      await this.db.call('youtubeMessages',tokens.userId,chat,items,broadcast.id);if(!valid())return null;
      await this.db.call('youtubeSnapshot',tokens.userId,`cursor:${chat}`,string(response.nextPageToken),this.now());if(!valid())return null;
      const floor=Number(response.pollingIntervalMillis)||60000;
      this.chatPolled(chat,items.length,floor);
      if(response.offlineAt)this.broadcastCache=undefined;
      interval=Math.max(interval,floor);
    }
    for(const chat of this.chatPace.keys())if(!chats.has(chat))this.chatPace.delete(chat);
    return ended?300000:interval;
  }
  async collectOnce(): Promise<number> {
    const generation = this.generation, tokens = this.config.value.youtube;
    if (!tokens) return 300000;
    const valid = () => generation === this.generation && this.config.value.youtube === tokens;
    if (tokens.expiresAt <= this.now() + 60000) {
      await this.refresh(tokens);
      if (!valid()) return 300000;
    }
    const previous = await this.db.call("youtubeData", tokens.userId);
    if (!valid()) return 300000;
    if(this.mode.chatOnly)return this.collectChatOnly(tokens,previous,generation);
    const {snapshots} = previous;
    const metadata = await this.channelMetadata(tokens, snapshots, valid);
    if (!metadata) return 300000;
    let channelSnapshot = metadata.snapshot;
    // Finish and validate every discovery page before changing session or snapshot state.
    const live = await this.liveState(tokens, valid);
    if (!live || !valid()) return 300000;
    const {broadcasts,reused} = live;
    // Legacy channel metadata is not a subscriber-history observation. Start the
    // history with a fresh API value instead of waiting on the old metadata age.
    if(!channelSnapshot&&((previous.subscriberCountAt===null&&!this.initialCountChecked)||this.now()-(snapshots.channel?.updatedAt??0)>=youtubeSubscriberCountInterval(broadcasts.length>0))){
      const counted = await this.subscriberCount(tokens, snapshots, valid);
      if (counted === null) return 300000;
      channelSnapshot = counted;
    }
    const videoIds = broadcasts.map((broadcast) => string(broadcast.id));
    const archive = await this.archiveCursor(tokens, snapshots, videoIds, valid);
    if (!archive) return 300000;
    const observedAt = await this.saveDiscovery(tokens, snapshots, channelSnapshot, metadata.refreshed, live, valid);
    if (observedAt === null) return 300000;
    if (!await this.recordViewers(tokens, live, videoIds, observedAt, valid)) return 300000;
    await this.db.call("platformMissing", "youtube", tokens.userId, videoIds, observedAt);
    if (!valid()) return 300000;
    const interval = await this.collectChats(tokens, broadcasts, snapshots, valid, reused);
    if (interval === null || !valid()) return 300000;
    if (!await this.collectReport(tokens, snapshots, valid)) return 300000;
    await this.collectSubscribers(tokens,valid,this.now());if(!valid())return 300000;
    const {cursor,removed,archivedIds} = archive;
    if(archivedIds.length&&(removed.length||!Number.isFinite(Number(cursor.checkedAt))||this.now()-Number(cursor.checkedAt??0)>=21600000))await this.collectArchivedVideos(tokens,archivedIds,valid,this.now());if(!valid())return 300000;
    await this.collectPublications(tokens, snapshots, channelSnapshot, valid);
    if(!valid())return 300000;
    this.status = { ...this.status,lastSyncAt:this.now(),state: "connected", account: tokens.userId, detail: broadcasts.length ? "Чат активных эфиров собирается" : "Канал подключён; активных эфиров нет" };
    return Math.min(interval, 3600000);
  }
  /** Full channel metadata, read again every six hours. `null`: the connection changed meanwhile. */
  private async channelMetadata(tokens:Tokens,snapshots:Snapshots,valid:()=>boolean):Promise<{snapshot:Record<string,unknown>|undefined;refreshed:boolean}|null>{
    if (this.now() - (snapshots['cursor:channelMetadata']?.updatedAt??snapshots.channel?.updatedAt??0) >= 21600000) {
      const channel = await this.api("channels", { part: "snippet,statistics,brandingSettings,contentDetails,topicDetails", mine: "true", maxResults: "50" }, tokens);
      if (!valid()) return null;
      const own = (Array.isArray(channel.items) ? channel.items : []).find((x: any) => x.id === tokens.userId);
      if (!own) throw new Error("YOUTUBE_CHANNEL_CHANGED");
      return {snapshot:own,refreshed:true};
    }
    return {snapshot:undefined,refreshed:false};
  }
  /** A fresh subscriber count merged into the saved channel; `undefined` after a recorded gap, `null` when the connection changed. */
  private async subscriberCount(tokens:Tokens,snapshots:Snapshots,valid:()=>boolean):Promise<Record<string,unknown>|undefined|null>{
    this.initialCountChecked=true;
    try{
      const response=await this.api('channels',{part:'statistics',id:tokens.userId},tokens);if(!valid())return null;
      const own=(Array.isArray(response.items)?response.items:[]).find((item:any)=>item.id===tokens.userId);
      if(!own||!own.statistics)throw new Error('INVALID_CHANNEL_COUNT');
      return {...object(snapshots.channel?.data??{}),...own};
    }catch{if(valid())await this.db.call('gap','youtube','subscriber_count_unavailable',this.now(),this.now());}
    return undefined;
  }
  /** Broadcasts that left the live list join the archived-video cursor (at most 200 ids). */
  private async archiveCursor(tokens:Tokens,snapshots:Snapshots,videoIds:string[],valid:()=>boolean){
    const savedCursor=snapshots['cursor:archivedVideos']?.data;
    const cursor=savedCursor&&typeof savedCursor==='object'&&!Array.isArray(savedCursor)?savedCursor as Record<string,unknown>:{};
    const oldBroadcasts=snapshots.broadcasts?.data;
    const removed=(Array.isArray(oldBroadcasts)?oldBroadcasts:[]).map((b:unknown)=>b&&typeof b==='object'&&!Array.isArray(b)?string((b as Record<string,unknown>).id):'').filter((id:string)=>id&&!videoIds.includes(id));
    const archivedIds=[...new Set([...removed,...(Array.isArray(cursor.ids)?cursor.ids:[])])].filter((id):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)&&!videoIds.includes(id)).slice(0,200);
    if(removed.length){await this.db.call('youtubeSnapshot',tokens.userId,'cursor:archivedVideos',{ids:archivedIds,checkedAt:0},this.now());if(!valid())return null;}
    return {cursor,removed,archivedIds};
  }
  /** Saves the channel and discovery snapshots; returns their observation time, `null` when the connection changed. */
  private async saveDiscovery(tokens:Tokens,snapshots:Snapshots,channelSnapshot:Record<string,unknown>|undefined,refreshedMetadata:boolean,{broadcasts,videoDetails}:LiveState,valid:()=>boolean):Promise<number|null>{
    const observedAt = this.now();
    if (channelSnapshot) {
      this.initialCountChecked=true;
      await this.db.call("youtubeSnapshot", tokens.userId, "channel", channelSnapshot, observedAt);
    }
    if(valid()&&(refreshedMetadata||!snapshots['cursor:channelMetadata']))await this.db.call('youtubeSnapshot',tokens.userId,'cursor:channelMetadata',true,refreshedMetadata?observedAt:snapshots.channel?.updatedAt??observedAt);
    if (!valid()) return null;
    await this.db.call("youtubeSnapshot", tokens.userId, "broadcasts", broadcasts, observedAt);
    if (!valid()) return null;
    await this.db.call("youtubeSnapshot", tokens.userId, "liveVideoDetails", Object.fromEntries(videoDetails), observedAt);
    if (!valid()) return null;
    return observedAt;
  }
  /** Links started broadcasts to logical streams and records one viewer sample per stream; `false` when the connection changed. */
  private async recordViewers(tokens:Tokens,{broadcasts,videoDetails}:LiveState,videoIds:string[],observedAt:number,valid:()=>boolean):Promise<boolean>{
    const logicalViewers = new Map<string, string[]>();
    for (const broadcast of broadcasts) {
      const actualStartTime = videoDetails.get(broadcast.id)?.liveStreamingDetails?.actualStartTime;
      if (typeof actualStartTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(actualStartTime)) continue;
      const startedAt = Date.parse(actualStartTime);
      if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > observedAt) continue;
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(broadcast.id)}`;
      const sessionId = await this.db.call("observePlatformStream", "youtube", tokens.userId, broadcast.id, startedAt, observedAt, url, string(broadcast.snippet?.title), videoIds);
      if (sessionId) logicalViewers.set(sessionId, [...(logicalViewers.get(sessionId) ?? []), broadcast.id]);
      if (!valid()) return false;
    }
    const counts = (ids: string[]): number | null => {
      const numbers = ids.map(id => videoDetails.get(id)?.liveStreamingDetails?.concurrentViewers);
      const complete = ids.length > 0 && ids.every(id => videoDetails.has(id));
      const validCounts = numbers.every(value => /^[0-9]+$/.test(String(value)) && Number.isSafeInteger(Number(value)));
      const sum = numbers.reduce((total: number, value: any) => total + Number(value), 0);
      return complete && validCounts && Number.isSafeInteger(sum) ? sum : null;
    };
    for (const [sessionId, ids] of logicalViewers) {
      await this.db.call("youtubeViewers", observedAt, counts(ids), sessionId);
      if (!valid()) return false;
    }
    if (broadcasts.length && !logicalViewers.size) {
      await this.db.call("youtubeViewers", observedAt, counts(videoIds), null);
      if (!valid()) return false;
    }
    return true;
  }
  /** The 28-day YouTube Analytics report, refreshed every six hours; `false` when the connection changed. */
  private async collectReport(tokens:Tokens,snapshots:Snapshots,valid:()=>boolean):Promise<boolean>{
    if (this.now() - (snapshots.report?.updatedAt ?? 0) >= 21600000) {
      const end = new Date(this.now() - 86400000).toISOString().slice(0, 10), start = new Date(this.now() - 28 * 86400000).toISOString().slice(0, 10);
      const report = await this.authorizedJson(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: `channel==${tokens.userId}`, startDate: start, endDate: end, metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" })}`, tokens);
      if (!valid()) return false;
      await this.db.call("youtubeSnapshot", tokens.userId, "report", { start, end, ...report }, this.now());
      if (!valid()) return false;
    }
    return true;
  }
  /** Publication metadata; a failure is recorded as a gap and never fails the collection. */
  private async collectPublications(tokens:Tokens,snapshots:Snapshots,channelSnapshot:Record<string,unknown>|undefined,valid:()=>boolean){
    try{
      await collectYouTubePublications({account:tokens.userId,at:this.now(),valid,
        channel:channelSnapshot??object(snapshots.channel?.data??{}),snapshots,
        api:(resource,params)=>this.api(resource,params,tokens),
        types:params=>this.authorizedJson(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams(params)}`,tokens),
        save:(items,at)=>this.db.call('youtubePublications',tokens.userId,items,at),
        cursor:(key,data)=>this.db.call('youtubeSnapshot',tokens.userId,key,data,this.now())});
    }catch{if(valid())await this.db.call('gap','youtube','publications_unavailable',this.now(),this.now());}
  }
  /** Supplementary chat never creates sessions, viewer samples or analytical reports. */
  private async collectChatOnly(tokens:Tokens,previous:{snapshots:Record<string,{data:unknown;updatedAt:number}>},generation:number):Promise<number> {
    const valid=()=>generation===this.generation&&this.config.value.youtube===tokens;
    // The supplementary collector has no per-minute video read: a chat reporting offlineAt or a failed read triggers rediscovery.
    const cached=this.broadcastCache&&this.now()-this.broadcastCache.at<YOUTUBE_LIVE_DISCOVERY_MS?this.broadcastCache:undefined,reused=!!cached;
    const broadcasts=cached?cached.items:await this.discoverBroadcasts(tokens,valid);if(!broadcasts||!valid())return 300000;
    await this.db.call('youtubeSnapshot',tokens.userId,'collectionRole','secondary',this.now());if(!valid())return 300000;
    await this.db.call('youtubeSnapshot',tokens.userId,'broadcasts',broadcasts,this.now());if(!valid())return 300000;
    const interval=await this.collectChats(tokens,broadcasts,previous.snapshots,valid,reused);if(interval===null||!valid())return 300000;
    this.status={...this.status,state:'connected',account:tokens.userId,detail:'Дополнительный чат подключён',lastSyncAt:this.now()};
    return Math.min(interval,3600000);
  }
  private async collectArchivedVideos(tokens:Tokens,ids:string[],valid:()=>boolean,at:number){
    try{
      const videos:unknown[]=[];
      for(let offset=0;offset<ids.length;offset+=50){
        const response=await this.api('videos',{part:videoParts,id:ids.slice(offset,offset+50).join(',')},tokens);if(!valid())return;
        if(!Array.isArray(response.items))throw new Error('INVALID_ARCHIVED_VIDEOS');videos.push(...response.items);
      }
      await this.db.call('youtubeSnapshot',tokens.userId,'archivedVideoDetails',videos,at);if(!valid())return;
      await this.db.call('youtubeSnapshot',tokens.userId,'cursor:archivedVideos',{ids,checkedAt:at},at);
    }catch{if(valid())await this.db.call('gap','youtube','archived_video_metadata_unavailable',at,at);}
  }
  private async collectSubscribers(tokens:Tokens,valid:()=>boolean,at:number){
    const previous=await this.db.call('youtubeData',tokens.userId);if(!valid()||at-(previous.snapshots["cursor:followers"]?.updatedAt??-Infinity)<youtubeSubscriberListInterval)return;
    try{
      const channelStats=object(object(previous.snapshots.channel?.data??{}).statistics??{}),count=Number(channelStats.subscriberCount);
      const subscriberTotal=channelStats.hiddenSubscriberCount===true||!Number.isSafeInteger(count)||count<0?null:count;
      let page='',complete=false;const seen=new Set<string>(),followers:{id:string;name:string;followedAtMs:number|null;raw:unknown}[]=[];
      for(let n=0;n<25;n++){
        const result=await this.api('subscriptions',{part:'snippet,subscriberSnippet',mySubscribers:'true',maxResults:'50',...(page?{pageToken:page}:{})},tokens);if(!valid())return;
        if(!Array.isArray(result.items))throw new Error('INVALID_SUBSCRIBERS');
        for(const raw of result.items){const f=object(raw),subscriber=object(f.subscriberSnippet),id=string(subscriber.channelId);if(!id)throw new Error('INVALID_SUBSCRIBERS');const date=Date.parse(string(object(f.snippet).publishedAt));followers.push({id,name:string(subscriber.title)||id,followedAtMs:Number.isFinite(date)&&date>=0?date:null,raw});}
        page=string(result.nextPageToken);if(!page){complete=true;break;}if(seen.has(page))throw new Error('SUBSCRIBERS_PAGINATION_LOOP');seen.add(page);
      }
      if(!valid())return;await this.db.call('followingSnapshot','youtube',tokens.userId,followers,complete,at,subscriberTotal);if(!valid())return;
      await this.db.call('youtubeSnapshot',tokens.userId,'cursor:followers',true,at);if(valid())this.status.lastFollowersAt=at;
      // A private or API-limited YouTube subscription remains unknown, even after full pagination.
    }catch{if(valid())await this.db.call('gap','youtube','subscribers_unavailable',at,at);}
  }
  async start() {
    if (this.running || this.timer || !this.config.value.youtube) return;
    const generation = this.generation;
    this.status = { state: "connecting", account: this.config.value.youtube.userId, detail: "Проверяем подключение YouTube" };
    const tick = async () => {
      let delay = 300000;
      this.running = this.collectOnce().then(n => { delay = n; }).catch(error => { if (generation === this.generation) this.status = { state: "error", account: this.config.value.youtube?.userId ?? "", detail: /^[A-Z_]+$/.test(error.message) ? error.message : "YOUTUBE_CONNECTION_FAILED" }; });
      await this.running; this.running = undefined;
      if (generation === this.generation) this.timer = setTimeout(() => void tick(), delay);
    };
    await tick();
  }
  async stop() {
    this.generation++; this.authAttempt++; this.pending = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    for (const controller of this.requests) controller.abort();
    await this.running; this.running = undefined;
    this.initialCountChecked=false;this.broadcastCache=undefined;this.chatPace.clear();
    this.status = { state: "disconnected", account: "", detail: "" };
  }
  async disconnect() { await this.stop(); delete this.config.value.youtube; await this.config.save(); }
}

