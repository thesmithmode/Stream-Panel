import type { FastifyInstance } from 'fastify';
import type { ConfigurationPort } from './config.js';
import type { StorePort } from './store-contract.js';
import { object, string } from './provider-values.js';
import { analyticsSettings } from './analytics-settings.js';
import { randomUUID } from 'node:crypto';
type Store = StorePort<'analytics' | 'channelOverview' | 'deleteManualSession' | 'endSession' | 'events' | 'followingAnalytics' | 'grid' | 'sessions' | 'startSession' | 'streamMetadata' | 'summary'>;
export function registerStreamsRoutes(app: FastifyInstance, db: Store, configuration: ConfigurationPort) {
    app.get("/api/v1/overview", () => db.call("channelOverview", configuration.value.excludedBotLogins));
    app.get("/api/v1/analytics", async (request) => {
        const q = object(request.query);
        const sessionId = string(q.session), defaults = analyticsSettings(configuration.value.analyticsSettings);
        const source = string(q.source) || 'all', coreRule = string(q.coreRule) || defaults.coreRule;
        if (source !== 'all' && source !== 'twitch' && source !== 'youtube')
            throw new Error('INVALID_ANALYTICS_FILTER');
        if (coreRule !== 'either' && coreRule !== 'both' && coreRule !== 'frequency')
            throw new Error('INVALID_ANALYTICS_FILTER');
        return db.call("analytics", {
            ...(sessionId ? { sessionId } : {}), ...(string(q.mode)==='summary'?{summaryOnly:true}:{}), fromMs: sessionId ? 0 : Number(q.from), toMs: sessionId ? Date.now() : Math.min(Number(q.to), Date.now()), source, category: string(q.category),
            ...(q.audienceOffset===undefined?{}:{audienceOffset:Number(q.audienceOffset)}),...(q.audienceSearch===undefined?{}:{audienceSearch:string(q.audienceSearch)}),...(q.audienceSort===undefined?{}:{audienceSort:string(q.audienceSort)}),...(q.audienceCoreOnly===undefined?{}:{audienceCoreOnly:string(q.audienceCoreOnly)==='1'}),
            ...(q.clockMinute===undefined?{}:{clockMinute:Number(q.clockMinute),clockDay:string(q.clockDay)||'all',clockResolution:Number(q.clockResolution??60),clockOffset:Number(q.clockOffset??0)}),
            regularThresholdPercent: q.regularThresholdPercent === undefined ? defaults.regularThresholdPercent : Number(q.regularThresholdPercent), minSessions: q.minSessions === undefined ? defaults.minSessions : Number(q.minSessions), minMinutes: q.minMinutes === undefined ? defaults.minMinutes : Number(q.minMinutes), minMessages: q.minMessages === undefined ? defaults.minMessages : Number(q.minMessages),
            chatWindowMinutes: q.chatWindowMinutes === undefined ? defaults.chatWindowMinutes : Number(q.chatWindowMinutes), coreRule, timezone: string(q.timezone) || defaults.timezone,
            excludedLogins: configuration.value.excludedBotLogins, ownerId: configuration.value.twitch?.userId ?? "", youtubeAccount: configuration.value.youtube?.userId ?? configuration.value.youtubeAccountId ?? "",
        });
    });
    app.get("/api/v1/sessions", async (request) => db.call("sessions", string(object(request.query).session) || undefined, Number(object(request.query).offset ?? 0), Number(object(request.query).limit ?? 100), configuration.value.excludedBotLogins));
    app.get("/api/v1/sessions/:id/followers", async (request) => db.call("followingAnalytics", string(object(request.params).id)));
    app.get("/api/v1/sessions/:id/metadata", async (request) => db.call('streamMetadata', string(object(request.params).id)));
    app.post("/api/v1/sessions/start", async () => {
        const existing = await db.call("sessions");
        if (existing.some((s) => s.ended_at_ms === null))
            throw new Error("SESSION_ALREADY_OPEN");
        return {
            id: await db.call("startSession", configuration.value.twitch?.userId || "local", `manual-${randomUUID()}`, Date.now(), "manual", Date.now()),
        };
    });
    app.post("/api/v1/sessions/:id/stop", async (request) => {
        const id = string(object(request.params).id), session = (await db.call("sessions")).find((s) => s.id === id);
        if (!session)
            throw new Error("SESSION_NOT_FOUND");
        if (session.kind !== "manual")
            throw new Error("PLATFORM_SESSION_MANAGED_AUTOMATICALLY");
        await db.call("endSession", id, Date.now(), "manual");
        return { ok: true };
    });
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
