import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Configuration, Tokens } from "./config.js";
import type { StoreClient } from "./db.js";
import { object, string } from "./twitch.js";
const scopes = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
export class YouTubeConnection {
  status = { state: "disconnected", account: "", detail: "" };
  private pending: { state: string; verifier: string; expires: number } | undefined;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private requests = new Set<AbortController>();
  constructor(private config: Configuration, private db: StoreClient, private redirect: string,
    private profile: string, private request: typeof fetch = fetch, private now = Date.now) {}
  private async json(url: string, init: RequestInit = {}) {
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.request(url, { ...init, signal: controller.signal });
      const data = object(await response.json());
      if (!response.ok) throw new Error(response.status === 401 ? "YOUTUBE_AUTH_REQUIRED" : response.status === 403 ? "YOUTUBE_ACCESS_OR_QUOTA" : "YOUTUBE_REQUEST_FAILED");
      return data;
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private token(body: Record<string,string>) {
    return this.json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: this.config.value.youtubeClientId ?? "", client_secret: this.config.value.youtubeClientSecret ?? "" }) });
  }
  async beginAuth(clientId: string, secret: string) {
    if (!clientId || clientId.length > 256 || secret.length > 256) throw new Error("INVALID_YOUTUBE_CLIENT");
    await this.stop();
    this.config.value.youtubeClientId = clientId;
    if (secret) this.config.value.youtubeClientSecret = secret;
    if (!this.config.value.youtubeClientSecret) throw new Error("MISSING_YOUTUBE_SECRET");
    delete this.config.value.youtube;
    await this.config.save();
    const state = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
    this.pending = { state, verifier, expires: this.now() + 600000 };
    this.status = { state: "authorizing", account: "", detail: "Завершите вход в Google" };
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: this.redirect, response_type: "code", scope: scopes.join(" "), access_type: "offline", prompt: "consent", state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` };
  }
  async finishAuth(code: string, state: string) {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || !code || this.now() > pending.expires || state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new Error("INVALID_YOUTUBE_STATE");
    const generation = this.generation;
    const data = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirect, code_verifier: pending.verifier });
    if (generation !== this.generation) return;
    const granted = string(data.scope).split(" ");
    if (!scopes.every(s => granted.includes(s)) || !string(data.access_token) || !string(data.refresh_token)) throw new Error("YOUTUBE_SCOPES_REQUIRED");
    const tokens: Tokens = { access: string(data.access_token), refresh: string(data.refresh_token), expiresAt: this.now() + Number(data.expires_in) * 1000, userId: "", scopes: granted };
    if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= this.now()) throw new Error("YOUTUBE_INVALID_TOKEN");
    const channels = await this.api("channels", { part: "snippet,statistics", mine: "true", maxResults: "50" }, tokens);
    if (generation !== this.generation) return;
    const items = Array.isArray(channels.items) ? channels.items : [];
    if (items.length !== 1 || channels.nextPageToken || !string(object(items[0]).id)) throw new Error("YOUTUBE_SELECT_ONE_CHANNEL");
    tokens.userId = string(object(items[0]).id);
    this.config.value.youtube = tokens;
    this.config.value.youtubeAccountId = tokens.userId;
    await this.db.call("youtubeSnapshot", tokens.userId, "channel", items[0], this.now());
    await this.config.save();
    void this.start();
  }
  private async api(resource: string, params: Record<string,string>, tokens: Tokens) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now());
    if (!await this.db.call("youtubeQuota", day, this.profile, 1)) throw new Error("YOUTUBE_DAILY_BUDGET");
    return this.json(`https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${tokens.access}` } });
  }
  private async activeBroadcasts(tokens: Tokens, valid: () => boolean) {
    let page = "";
    const seenPages = new Set<string>(), seenIds = new Set<string>(), broadcasts: Record<string, any>[] = [];
    for (let n = 0; n < 5; n++) {
      const response = await this.api("liveBroadcasts", { part: "snippet,status", broadcastStatus: "active", maxResults: "50", ...(page ? { pageToken: page } : {}) }, tokens);
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
  async collectOnce(): Promise<number> {
    const generation = this.generation, tokens = this.config.value.youtube;
    if (!tokens) return 300000;
    const valid = () => generation === this.generation && this.config.value.youtube === tokens;
    if (tokens.expiresAt <= this.now() + 60000) {
      const data = await this.token({ grant_type: "refresh_token", refresh_token: tokens.refresh });
      if (!valid()) return 300000;
      if (!string(data.access_token) || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error("YOUTUBE_INVALID_TOKEN");
      tokens.access = string(data.access_token); tokens.refresh = string(data.refresh_token) || tokens.refresh; tokens.expiresAt = this.now() + Number(data.expires_in) * 1000;
      await this.config.save();
    }
    const previous = await this.db.call<any>("youtubeData", tokens.userId);
    if (!valid()) return 300000;
    let channelSnapshot: Record<string, unknown> | undefined;
    if (this.now() - (previous.snapshots.channel?.updatedAt ?? 0) >= 21600000) {
      const channel = await this.api("channels", { part: "snippet,statistics", mine: "true", maxResults: "50" }, tokens);
      if (!valid()) return 300000;
      const own = (Array.isArray(channel.items) ? channel.items : []).find((x: any) => x.id === tokens.userId);
      if (!own) throw new Error("YOUTUBE_CHANNEL_CHANGED");
      channelSnapshot = own;
    }
    // Finish and validate every discovery page before changing session or snapshot state.
    const discovered = await this.activeBroadcasts(tokens, valid);
    if (!discovered || !valid()) return 300000;
    const broadcasts = discovered;
    const videoIds = broadcasts.map((broadcast) => string(broadcast.id));
    const videoDetails = new Map<string, Record<string, any>>();
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const ids = videoIds.slice(offset, offset + 50);
      const response = await this.api("videos", { part: "liveStreamingDetails", id: ids.join(",") }, tokens);
      if (!valid()) return 300000;
      if (!Array.isArray(response.items)) continue;
      const batch = new Map<string, Record<string, any>>();
      let malformed = false;
      for (const value of response.items) {
        if (!value || typeof value !== "object" || Array.isArray(value)) { malformed = true; break; }
        const item = value as Record<string, any>, id = string(item.id);
        if (!ids.includes(id) || batch.has(id)) { malformed = true; break; }
        batch.set(id, item);
      }
      if (malformed || batch.size !== ids.length || ids.some(id => !batch.has(id))) continue;
      for (const [id, item] of batch) videoDetails.set(id, item);
    }
    const observedAt = this.now();
    if (channelSnapshot) await this.db.call("youtubeSnapshot", tokens.userId, "channel", channelSnapshot, observedAt);
    if (!valid()) return 300000;
    await this.db.call("youtubeSnapshot", tokens.userId, "broadcasts", broadcasts, observedAt);
    if (!valid()) return 300000;
    const logicalViewers = new Map<string, string[]>();
    await this.db.call("youtubeSnapshot", tokens.userId, "liveVideoDetails", Object.fromEntries(videoDetails), observedAt);
    if (!valid()) return 300000;
    for (const broadcast of broadcasts) {
      const actualStartTime = videoDetails.get(broadcast.id)?.liveStreamingDetails?.actualStartTime;
      if (typeof actualStartTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(actualStartTime)) continue;
      const startedAt = Date.parse(actualStartTime);
      if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > observedAt) continue;
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(broadcast.id)}`;
      const sessionId = await this.db.call<string | null>("observePlatformStream", "youtube", tokens.userId, broadcast.id, startedAt, observedAt, url, string(broadcast.snippet?.title), videoIds);
      if (sessionId) logicalViewers.set(sessionId, [...(logicalViewers.get(sessionId) ?? []), broadcast.id]);
      if (!valid()) return 300000;
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
      if (!valid()) return 300000;
    }
    if (broadcasts.length && !logicalViewers.size) {
      await this.db.call("youtubeViewers", observedAt, counts(videoIds), null);
      if (!valid()) return 300000;
    }
    await this.db.call("platformMissing", "youtube", tokens.userId, videoIds, observedAt);
    if (!valid()) return 300000;
    let interval = broadcasts.length ? 60000 : 300000;
    for (const broadcast of broadcasts) {
      const chat = string(broadcast.snippet?.liveChatId); if (!chat) continue;
      const cursor = string(previous.snapshots[`cursor:${chat}`]?.data);
      const response = await this.api("liveChat/messages", { part: "id,snippet,authorDetails", liveChatId: chat, maxResults: "2000", ...(cursor ? { pageToken: cursor } : {}) }, tokens);
      if (!valid()) return 300000;
      await this.db.call("youtubeMessages", tokens.userId, chat, Array.isArray(response.items) ? response.items : []);
      if (!valid()) return 300000;
      await this.db.call("youtubeSnapshot", tokens.userId, `cursor:${chat}`, string(response.nextPageToken), this.now());
      if (!valid()) return 300000;
      interval = Math.max(interval, Number(response.pollingIntervalMillis) || 60000);
    }
    if (this.now() - (previous.snapshots.report?.updatedAt ?? 0) >= 21600000) {
      const end = new Date(this.now() - 86400000).toISOString().slice(0, 10), start = new Date(this.now() - 28 * 86400000).toISOString().slice(0, 10);
      const report = await this.json(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: `channel==${tokens.userId}`, startDate: start, endDate: end, metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" })}`, { headers: { Authorization: `Bearer ${tokens.access}` } });
      if (!valid()) return 300000;
      await this.db.call("youtubeSnapshot", tokens.userId, "report", { start, end, ...report }, this.now());
      if (!valid()) return 300000;
    }
    this.status = { state: "connected", account: tokens.userId, detail: broadcasts.length ? "Чат активных эфиров собирается" : "Канал подключён; активных эфиров нет" };
    return Math.min(interval, 3600000);
  }
  async start() {
    if (this.running || this.timer || !this.config.value.youtube) return;
    const generation = this.generation;
    const tick = async () => {
      let delay = 300000;
      this.running = this.collectOnce().then(n => { delay = n; }).catch(error => { if (generation === this.generation) this.status = { state: "error", account: "", detail: /^[A-Z_]+$/.test(error.message) ? error.message : "YOUTUBE_CONNECTION_FAILED" }; });
      await this.running; this.running = undefined;
      if (generation === this.generation) this.timer = setTimeout(() => void tick(), delay);
    };
    await tick();
  }
  async stop() {
    this.generation++; this.pending = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    for (const controller of this.requests) controller.abort();
    await this.running; this.running = undefined;
    this.status = { state: "disconnected", account: "", detail: "" };
  }
  async disconnect() { await this.stop(); delete this.config.value.youtube; await this.config.save(); }
}
