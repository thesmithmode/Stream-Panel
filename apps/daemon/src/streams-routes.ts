import type {AnalyticsOptions} from '../../../packages/core/src/analytics.js';
import {conditionalResponse,PreparedResponses} from './conditional-response.js';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { ConfigurationPort } from './config.js';
import type { StorePort } from './store-contract.js';
import { object, string } from './provider-values.js';
import { analyticsSettings,analyticsBotLogins } from './analytics-settings.js';
type Store = StorePort<'streamAnalytics' | 'preloadAnalytics' | 'changes' | 'supplementaryParticipants' | 'currentChat' | 'matchingStream' | 'subscriberHistory' | 'recentEvents' | 'mergeSessions' | 'unmergeSessions' | 'analytics' | 'clockAudience' | 'channelOverview' | 'deleteSession' | 'events' | 'followerPerson' | 'followerChanges' | 'followingAnalytics' | 'grid' | 'sessions' | 'streamMetadata' | 'summary'>;
export function registerStreamsRoutes(app: FastifyInstance, db: Store, configuration: ConfigurationPort) {
    const wire=new PreparedResponses();
    const wireKey=async(request:FastifyRequest,session='')=>{
      const change=await db.call('changes',session||undefined);
      // Elapsed live time changes even without a fact write; leave live reads to the
      // existing versioned incremental cache, rather than freeze their wire snapshot.
      const q=object(request.query);
      if(change.activeStream||(!session&&(q.to===undefined||Number(q.to)>Date.now())))return undefined;
      const coreTick=request.routeOptions.url?.startsWith('/api/v1/analytics')?Math.floor(Date.now()/60000):null;
      return JSON.stringify([request.routeOptions.url,session,coreTick,Object.fromEntries(Object.entries(object(request.query)).filter(([key])=>key!=='_background')),configuration.value.analyticsSettings,configuration.value.excludedBotLogins,configuration.value.twitch?.userId,configuration.value.youtube?.userId,configuration.value.youtubeAccountId,change]);
    };
    const botsFor=(query:unknown)=>analyticsBotLogins(object(query),configuration.value);
    app.post('/api/v1/followers/person',request=>{const b=object(request.body);return db.call('followerPerson',string(b.source),string(b.account),string(b.externalId));});
    app.get('/api/v1/followers/changes',async(request,reply)=>{const q=object(request.query);
      return wire.respond(request,reply,await wireKey(request),async()=>{const {polls,...visible}=await db.call('followerChanges',Number(q.from??0),Number(q.to??Date.now()),botsFor(q),false);void polls;return visible;});
    });
    app.get('/api/v1/events/recent',request=>{const q=object(request.query);return db.call('recentEvents',Number(q.offset??0),Number(q.limit??100),{...(string(q.session)?{session:string(q.session)}:{}),...(string(q.person)?{person:string(q.person)}:{}),messagesOnly:string(q.messages)==='1'});});
    for(const path of ['/api/v1/analytics/subscribers','/api/v1/analytics/subscriber-streams'])app.get(path,request=>{
      const q=object(request.query),source=string(q.source);
      if(source!=='twitch'&&source!=='youtube')throw new Error('INVALID_SUBSCRIBER_WINDOW');
      const account=source==='twitch'?configuration.value.twitch?.userId??'':configuration.value.youtube?.userId??configuration.value.youtubeAccountId??'';
      return db.call('subscriberHistory',{source,account,...(request.routeOptions.url?.endsWith('/subscriber-streams')?{streamsOnly:true}:{}),from:Number(q.from),to:Math.min(Number(q.to),Date.now())});
    });
    app.get("/api/v1/overview", async (request,reply) => conditionalResponse(request,reply,await db.call("channelOverview", botsFor(request.query))));
    for(const path of ["/api/v1/analytics","/api/v1/analytics/clock","/api/v1/analytics/audience","/api/v1/analytics/clock-summary"])app.get(path, async (request,reply) => {
        const q = object(request.query);
        const panel=string(q.panel);if(panel&&!['dynamics','time','audience'].includes(panel))throw new Error('INVALID_ANALYTICS_PANEL');
        const streamView=string(q.view)==='stream';if(streamView&&!string(q.session))throw Error('INVALID_ANALYTICS_FILTER');
        const sessionId = string(q.session), defaults = analyticsSettings(configuration.value.analyticsSettings);
        const source = string(q.source) || 'all', coreRule = string(q.coreRule) || defaults.coreRule;
        if (source !== 'all' && source !== 'twitch' && source !== 'youtube')
            throw new Error('INVALID_ANALYTICS_FILTER');
        if (coreRule !== 'either' && coreRule !== 'both' && coreRule !== 'frequency')
            throw new Error('INVALID_ANALYTICS_FILTER');
        for(const field of ['streamFrom','streamTo','streamOffset','streamLimit'])if(q[field]!==undefined&&(!Number.isSafeInteger(Number(q[field]))||Number(q[field])<0||(field==='streamLimit'&&Number(q[field])>100)))throw Error('INVALID_ANALYTICS_FILTER');
        return wire.respond(request,reply,await wireKey(request,sessionId),async()=>{
        const options:AnalyticsOptions={
            rollingCore:true,coreWindowDays:defaults.coreWindowDays,...(q.streamFrom===undefined?{}:{streamFrom:Number(q.streamFrom)}),...(q.streamTo===undefined?{}:{streamTo:Number(q.streamTo)}),...(q.streamOffset===undefined?{}:{streamOffset:Number(q.streamOffset)}),...(q.streamLimit===undefined?{}:{streamLimit:Number(q.streamLimit)}),
            ...(sessionId ? { sessionId } : {}),...(panel?{panel:panel as 'dynamics'|'time'|'audience'}:{}),...(string(q.attendanceOnly)==='1'?{attendanceOnly:true}:{}), ...(string(q.mode)==='summary'?{summaryOnly:true}:{}),...(string(q.insights)==='1'?{includeInsights:true}:{}), fromMs: sessionId ? 0 : Number(q.from), toMs: sessionId ? Date.now() : Math.min(Number(q.to), Date.now()), source, category: string(q.category),
            ...(q.audienceOffset===undefined?{}:{audienceOffset:Number(q.audienceOffset)}),...(q.audienceSearch===undefined?{}:{audienceSearch:string(q.audienceSearch)}),...(q.audienceSort===undefined?{}:{audienceSort:string(q.audienceSort)}),...(q.audienceCoreOnly===undefined?{}:{audienceCoreOnly:string(q.audienceCoreOnly)==='1'}),
            ...(string(q.clockCompact)==='1'||request.routeOptions.url==='/api/v1/analytics/clock-summary'?{clockCompact:true,clockDay:string(q.clockDay)||'all',clockResolution:Number(q.clockResolution??15)}:{}),
            ...(q.clockMinute===undefined?{}:{clockMinute:Number(q.clockMinute),clockDay:string(q.clockDay)||'all',clockResolution:Number(q.clockResolution??60),clockOffset:Number(q.clockOffset??0),clockBatch:string(q.clockBatch)==='1'}),
            regularThresholdPercent: q.regularThresholdPercent === undefined ? defaults.regularThresholdPercent : Number(q.regularThresholdPercent), minSessions: q.minSessions === undefined ? defaults.minSessions : Number(q.minSessions), minMinutes: q.minMinutes === undefined ? defaults.minMinutes : Number(q.minMinutes), minMessages: q.minMessages === undefined ? defaults.minMessages : Number(q.minMessages),
            chatWindowMinutes: q.chatWindowMinutes === undefined ? defaults.chatWindowMinutes : Number(q.chatWindowMinutes), coreRule, timezone: string(q.timezone) || defaults.timezone,
            excludedLogins: botsFor(request.query), ownerId: configuration.value.twitch?.userId ?? "", youtubeAccount: configuration.value.youtube?.userId ?? configuration.value.youtubeAccountId ?? "",
        };
        const compactActivity=string(q.clockActivityCompact)==='1'&&(panel==='time'||request.routeOptions.url==='/api/v1/analytics/clock-summary');
        const result=request.routeOptions.url==='/api/v1/analytics/clock'?await db.call('clockAudience',options):streamView?await db.call('streamAnalytics',options):string(q._background)==='1'?await db.call('preloadAnalytics',options,compactActivity):await db.call('analytics',options,compactActivity);
        if(request.routeOptions.url==='/api/v1/analytics/clock-summary'&&'clockBuckets' in result&&!result.preparing)
            return {filters:result.filters,clockBuckets:result.clockBuckets,clockSelection:'clockSelection' in result?result.clockSelection:undefined,clockRevision:'clockRevision' in result?result.clockRevision:undefined,...(compactActivity&&'clockCurrencies' in result&&'activityClock' in result?{activityClock:result.activityClock,clockCurrencies:result.clockCurrencies}:{})};
        if(request.routeOptions.url==='/api/v1/analytics/audience'&&'audience' in result&&!result.preparing)
            return {filters:result.filters,audience:result.audience,audiencePage:'audiencePage' in result?result.audiencePage:undefined};
        return result;
        });
    });
    app.get('/api/v1/sessions/match',async(request,reply)=>{const q=object(request.query);return reply.type('application/json').send(JSON.stringify(await db.call('matchingStream',Number(q.startedAt),string(q.latest)==='1')));});
    app.get("/api/v1/sessions", async (request) => db.call("sessions", string(object(request.query).session) || undefined, Number(object(request.query).offset ?? 0), Number(object(request.query).limit ?? 100), botsFor(request.query)));
    app.get('/api/v1/sessions/:id/current-chat',async(request,reply)=>{
      const q=object(request.query);if(q.includeExcluded!==undefined&&!['0','1'].includes(string(q.includeExcluded)))throw Error('INVALID_CHAT_FILTER');
      return conditionalResponse(request,reply,await db.call('currentChat',string(object(request.params).id),botsFor(request.query),string(q.includeExcluded)==='1'));
    });
    app.get('/api/v1/sessions/:id/supplementary-chat',request=>db.call('supplementaryParticipants',string(object(request.params).id),botsFor(request.query)));
    app.get("/api/v1/sessions/:id/followers", async (request,reply) => {
      const id=string(object(request.params).id);
      return wire.respond(request,reply,await wireKey(request,id),async()=>{const {polls,...visible}=await db.call('followingAnalytics',id,botsFor(request.query),false);void polls;return visible;});
    });
    app.get("/api/v1/sessions/:id/metadata", async (request) => db.call('streamMetadata', string(object(request.params).id)));
    app.post('/api/v1/sessions/merge',async request=>({id:await db.call('mergeSessions',object(request.body).sessionIds as string[])}));
    app.post('/api/v1/sessions/:id/unmerge',async request=>{await db.call('unmergeSessions',string(object(request.params).id));return {ok:true};});
    app.post("/api/v1/sessions/:id/delete", async (request) => {
        await db.call("deleteSession", string(object(request.params).id), Date.now());
        return { ok: true };
    });
    app.get("/api/v1/summary", async (request) => db.call("summary", string(object(request.query).session) || undefined, botsFor(request.query), string(object(request.query).compact) !== "1"));
    app.get("/api/v1/events", async (request) => {
        const q = object(request.query);
        return db.call("events", string(q.session) || undefined, string(q.person) || undefined, q.from === undefined ? undefined : Number(q.from), q.to === undefined ? undefined : Number(q.to), string(q.type) || undefined, string(q.source) || undefined);
    });
    app.get("/api/v1/presence", async (request) => {
        const q = object(request.query);
        return db.call("grid", string(q.session), string(q.person), Number(q.from), Number(q.to));
    });
}


