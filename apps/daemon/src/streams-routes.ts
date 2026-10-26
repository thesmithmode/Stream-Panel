import {conditionalResponse} from './conditional-response.js';
import type { FastifyInstance } from 'fastify';
import type { ConfigurationPort } from './config.js';
import type { StorePort } from './store-contract.js';
import { object, string } from './provider-values.js';
import { analyticsSettings } from './analytics-settings.js';
type Store = StorePort<'matchingStream' | 'subscriberHistory' | 'recentEvents' | 'mergeSessions' | 'unmergeSessions' | 'analytics' | 'clockAudience' | 'channelOverview' | 'deleteManualSession' | 'events' | 'followingAnalytics' | 'grid' | 'sessions' | 'streamMetadata' | 'summary'>;
export function registerStreamsRoutes(app: FastifyInstance, db: Store, configuration: ConfigurationPort) {
    app.get('/api/v1/events/recent',request=>{const q=object(request.query);return db.call('recentEvents',Number(q.offset??0),Number(q.limit??100),{...(string(q.session)?{session:string(q.session)}:{}),...(string(q.person)?{person:string(q.person)}:{}),messagesOnly:string(q.messages)==='1'});});
    app.get('/api/v1/analytics/subscribers',request=>{
      const q=object(request.query),source=string(q.source);
      if(source!=='twitch'&&source!=='youtube')throw new Error('INVALID_SUBSCRIBER_WINDOW');
      const account=source==='twitch'?configuration.value.twitch?.userId??'':configuration.value.youtube?.userId??configuration.value.youtubeAccountId??'';
      return db.call('subscriberHistory',{source,account,from:Number(q.from),to:Math.min(Number(q.to),Date.now())});
    });
    app.get("/api/v1/overview", async (request,reply) => conditionalResponse(request,reply,await db.call("channelOverview", configuration.value.excludedBotLogins)));
    for(const path of ["/api/v1/analytics","/api/v1/analytics/clock","/api/v1/analytics/audience","/api/v1/analytics/clock-summary"])app.get(path, async (request,reply) => {
        const q = object(request.query);
        const panel=string(q.panel);if(panel&&!['dynamics','time','audience'].includes(panel))throw new Error('INVALID_ANALYTICS_PANEL');
        const sessionId = string(q.session), defaults = analyticsSettings(configuration.value.analyticsSettings);
        const source = string(q.source) || 'all', coreRule = string(q.coreRule) || defaults.coreRule;
        if (source !== 'all' && source !== 'twitch' && source !== 'youtube')
            throw new Error('INVALID_ANALYTICS_FILTER');
        if (coreRule !== 'either' && coreRule !== 'both' && coreRule !== 'frequency')
            throw new Error('INVALID_ANALYTICS_FILTER');
        for(const field of ['streamFrom','streamTo','streamOffset','streamLimit'])if(q[field]!==undefined&&(!Number.isSafeInteger(Number(q[field]))||Number(q[field])<0||(field==='streamLimit'&&Number(q[field])>100)))throw Error('INVALID_ANALYTICS_FILTER');
        const result=await db.call(request.routeOptions.url==='/api/v1/analytics/clock'?"clockAudience":"analytics", {
            ...(q.streamFrom===undefined?{}:{streamFrom:Number(q.streamFrom)}),...(q.streamTo===undefined?{}:{streamTo:Number(q.streamTo)}),...(q.streamOffset===undefined?{}:{streamOffset:Number(q.streamOffset)}),...(q.streamLimit===undefined?{}:{streamLimit:Number(q.streamLimit)}),
            ...(sessionId ? { sessionId } : {}),...(panel?{panel:panel as 'dynamics'|'time'|'audience'}:{}),...(string(q.attendanceOnly)==='1'?{attendanceOnly:true}:{}), ...(string(q.mode)==='summary'?{summaryOnly:true}:{}),...(string(q.insights)==='1'?{includeInsights:true}:{}), fromMs: sessionId ? 0 : Number(q.from), toMs: sessionId ? Date.now() : Math.min(Number(q.to), Date.now()), source, category: string(q.category),
            ...(q.audienceOffset===undefined?{}:{audienceOffset:Number(q.audienceOffset)}),...(q.audienceSearch===undefined?{}:{audienceSearch:string(q.audienceSearch)}),...(q.audienceSort===undefined?{}:{audienceSort:string(q.audienceSort)}),...(q.audienceCoreOnly===undefined?{}:{audienceCoreOnly:string(q.audienceCoreOnly)==='1'}),
            ...(string(q.clockCompact)==='1'||request.routeOptions.url==='/api/v1/analytics/clock-summary'?{clockCompact:true,clockDay:string(q.clockDay)||'all',clockResolution:Number(q.clockResolution??15)}:{}),
            ...(q.clockMinute===undefined?{}:{clockMinute:Number(q.clockMinute),clockDay:string(q.clockDay)||'all',clockResolution:Number(q.clockResolution??60),clockOffset:Number(q.clockOffset??0),clockBatch:string(q.clockBatch)==='1'}),
            regularThresholdPercent: q.regularThresholdPercent === undefined ? defaults.regularThresholdPercent : Number(q.regularThresholdPercent), minSessions: q.minSessions === undefined ? defaults.minSessions : Number(q.minSessions), minMinutes: q.minMinutes === undefined ? defaults.minMinutes : Number(q.minMinutes), minMessages: q.minMessages === undefined ? defaults.minMessages : Number(q.minMessages),
            chatWindowMinutes: q.chatWindowMinutes === undefined ? defaults.chatWindowMinutes : Number(q.chatWindowMinutes), coreRule, timezone: string(q.timezone) || defaults.timezone,
            excludedLogins: configuration.value.excludedBotLogins, ownerId: configuration.value.twitch?.userId ?? "", youtubeAccount: configuration.value.youtube?.userId ?? configuration.value.youtubeAccountId ?? "",
        });
        if(request.routeOptions.url==='/api/v1/analytics/clock-summary'&&'clockBuckets' in result&&!result.preparing)
            return conditionalResponse(request,reply,{filters:result.filters,clockBuckets:result.clockBuckets,clockSelection:result.clockSelection,clockRevision:result.clockRevision});
        if(request.routeOptions.url==='/api/v1/analytics/audience'&&'audience' in result&&!result.preparing)
            return conditionalResponse(request,reply,{filters:result.filters,audience:result.audience,audiencePage:result.audiencePage});
        return conditionalResponse(request,reply,result);
    });
    app.get('/api/v1/sessions/match',request=>{const q=object(request.query);return db.call('matchingStream',Number(q.startedAt),string(q.latest)==='1');});
    app.get("/api/v1/sessions", async (request) => db.call("sessions", string(object(request.query).session) || undefined, Number(object(request.query).offset ?? 0), Number(object(request.query).limit ?? 100), configuration.value.excludedBotLogins));
    app.get("/api/v1/sessions/:id/followers", async (request) => db.call("followingAnalytics", string(object(request.params).id)));
    app.get("/api/v1/sessions/:id/metadata", async (request) => db.call('streamMetadata', string(object(request.params).id)));
    app.post('/api/v1/sessions/merge',async request=>({id:await db.call('mergeSessions',object(request.body).sessionIds as string[])}));
    app.post('/api/v1/sessions/:id/unmerge',async request=>{await db.call('unmergeSessions',string(object(request.params).id));return {ok:true};});
    app.post("/api/v1/sessions/:id/delete", async (request) => {
        await db.call("deleteManualSession", string(object(request.params).id), Date.now());
        return { ok: true };
    });
    app.get("/api/v1/summary", async (request) => db.call("summary", string(object(request.query).session) || undefined, configuration.value.excludedBotLogins, string(object(request.query).compact) !== "1"));
    app.get("/api/v1/events", async (request) => {
        const q = object(request.query);
        return db.call("events", string(q.session) || undefined, string(q.person) || undefined, q.from === undefined ? undefined : Number(q.from), q.to === undefined ? undefined : Number(q.to), string(q.type) || undefined, string(q.source) || undefined);
    });
    app.get("/api/v1/presence", async (request) => {
        const q = object(request.query);
        return db.call("grid", string(q.session), string(q.person), Number(q.from), Number(q.to));
    });
}


