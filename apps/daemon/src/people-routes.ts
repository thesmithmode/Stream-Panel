import type { FastifyInstance } from 'fastify';
import type { ConfigurationPort } from './config.js';
import type { StorePort } from './store-contract.js';
import { object, string } from './provider-values.js';
import { analyticsSettings } from './analytics-settings.js';
type Store = StorePort<'bindDonorNickname' | 'candidatePersons' | 'createPersonNote' | 'deletePersonNote' | 'donorBindings' | 'donorNicknames' | 'insights' | 'merge' | 'merges' | 'person' | 'personActivity' | 'personFollowing' | 'personMetadata' | 'personNotes' | 'personStats' | 'persons' | 'personsPage' | 'personsTop' | 'renamePerson' | 'setPersonMetadata' | 'splitIdentities' | 'splits' | 'undoMerge' | 'undoSplit' | 'updatePersonNote'>;
export function registerPeopleRoutes(app: FastifyInstance, db: Store, configuration: ConfigurationPort) {
    app.get("/api/v1/persons/:id/following", async (request) => db.call("personFollowing", string(object(request.params).id), string(object(request.query).session)));
    app.get('/api/v1/donor-nicknames', () => db.call('donorNicknames'));
    app.get('/api/v1/persons/:id/donor-bindings', request => db.call('donorBindings', string(object(request.params).id)));
    app.post('/api/v1/persons/:id/donor-bindings', request => { const b = object(request.body); return db.call('bindDonorNickname', string(object(request.params).id), string(b.name), Number(b.revision), Date.now()); });
    function peopleFrom(query: unknown): number {
        const period = string(object(query).period);
        if (!period)
            return 0;
        if (period !== "7" && period !== "30")
            throw new Error("INVALID_PERIOD");
        return Date.now() - Number(period) * 86400000;
    }
    app.get('/api/v1/persons/page', request => {
        const q = object(request.query);
        return db.call('personsPage', string(q.search), configuration.value.excludedBotLogins, peopleFrom(q), Number(q.offset ?? 0), Number(q.limit ?? 50));
    });
    app.get("/api/v1/persons", async (request) => db.call("persons", string(object(request.query).search), configuration.value.excludedBotLogins, peopleFrom(request.query)));
    app.get("/api/v1/persons/tops", async (request) => {
        const q = object(request.query);
        const sortRaw = string(q.by) || "messages";
        const sortBy = sortRaw === "donations" || sortRaw === "observed_minutes"
            ? sortRaw
            : "messages";
        return db.call("personsTop", sortBy, string(q.session) || undefined, configuration.value.excludedBotLogins, q.limit === undefined ? 50 : Number(q.limit), q.from === undefined ? peopleFrom(request.query) : Number(q.from), q.to === undefined ? undefined : Number(q.to), string(q.currency) || 'RUB');
    });
    app.get("/api/v1/insights", async request=>{
        const q=object(request.query),defaults=analyticsSettings(configuration.value.analyticsSettings);
        return db.call('insights',string(q.session)||undefined,configuration.value.excludedBotLogins,{...defaults,ownerId:configuration.value.twitch?.userId??'',youtubeAccount:configuration.value.youtube?.userId??configuration.value.youtubeAccountId??''});
    });
    app.get("/api/v1/persons/:id", async (request) => db.call("person", string(object(request.params).id), string(object(request.query).events) !== "false"));
    app.get("/api/v1/persons/:id/activity", async (request) => db.call("personActivity", string(object(request.params).id), analyticsSettings(configuration.value.analyticsSettings).chatWindowMinutes, analyticsSettings(configuration.value.analyticsSettings).timezone));
    app.get("/api/v1/persons/:id/metadata", async (request) => db.call("personMetadata", string(object(request.params).id)));
    app.post("/api/v1/persons/:id/metadata", async (request) => {
        const b = object(request.body);
        if (!Array.isArray(b.tags) || !b.tags.every((tag): tag is string => typeof tag === 'string'))
            throw new Error('INVALID_PERSON_TAGS');
        if (b.manualCore !== null && typeof b.manualCore !== 'boolean')
            throw new Error('INVALID_MANUAL_CORE');
        return db.call("setPersonMetadata", string(object(request.params).id), b.tags, b.manualCore, Number(b.revision));
    });
    app.get("/api/v1/persons/:id/notes", async (request) => db.call("personNotes", string(object(request.params).id)));
    app.post("/api/v1/persons/:id/notes", async (request) => db.call("createPersonNote", string(object(request.params).id), string(object(request.body).body)));
    app.post("/api/v1/persons/:id/notes/:noteId/update", async (request) => {
        const p = object(request.params), b = object(request.body);
        return db.call("updatePersonNote", string(p.id), string(p.noteId), string(b.body), Number(b.revision));
    });
    app.post("/api/v1/persons/:id/notes/:noteId/delete", async (request) => {
        const p = object(request.params);
        await db.call("deletePersonNote", string(p.id), string(p.noteId), Number(object(request.body).revision));
        return { ok: true };
    });
    app.get("/api/v1/persons/:id/stats", async (request) => {
        const id = string(object(request.params).id);
        const session = string(object(request.query).session) || undefined;
        return db.call("personStats", id, session, configuration.value.excludedBotLogins, analyticsSettings(configuration.value.analyticsSettings).chatWindowMinutes, peopleFrom(request.query));
    });
    app.get("/api/v1/persons/:id/candidates", async (request) => {
        const person = await db.call("person", string(object(request.params).id), false);
        return db.call("candidatePersons", String(person.display_name));
    });
    app.post("/api/v1/persons/:id/rename", async (request) => {
        await db.call("renamePerson", string(object(request.params).id), string(object(request.body).name));
        return { ok: true };
    });
    app.post("/api/v1/persons/merge", async (request) => {
        const b = object(request.body);
        return {
            id: await db.call("merge", string(b.sourceId), string(b.targetId), Number(b.sourceRevision), Number(b.targetRevision), Date.now()),
        };
    });
    app.post("/api/v1/persons/split", async (request) => {
        const b = object(request.body);
        if (!Array.isArray(b.identityIds) || b.identityIds.length > 1000)
            throw new Error("INVALID_SPLIT");
        return {
            id: await db.call("splitIdentities", b.identityIds.map(string), string(b.name), Number(b.revision), Date.now()),
        };
    });
    app.get("/api/v1/splits", async () => db.call("splits"));
    app.post("/api/v1/splits/:id/undo", async (request) => { await db.call("undoSplit", string(object(request.params).id), Date.now()); return { ok: true }; });
    app.get("/api/v1/merges", async () => db.call("merges"));
    app.post("/api/v1/merges/:id/undo", async (request) => {
        await db.call("undoMerge", string(object(request.params).id), Date.now());
        return { ok: true };
    });
}
