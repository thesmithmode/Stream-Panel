import type { FastifyInstance } from 'fastify';
export function registerRouteSchemas(app: FastifyInstance) {
    const text = { type: "string", maxLength: 256, minLength: 1 };
    const revision = { type: "integer", minimum: 0 };
    const body = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({
        type: "object",
        additionalProperties: false,
        properties,
        required,
    });
    const donationFields = { personId: { type: "string", minLength: 1, maxLength: 512 }, amount: { type: "string", minLength: 1, maxLength: 50, pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$" }, currency: { type: "string", enum: ["RUB", "USD", "EUR", "BYN", "KZT", "UAH", "BRL", "TRY"] }, occurredAtMs: { type: ["integer", "null"], minimum: 0 }, message: { type: "string", maxLength: 10000 }, sourceName: { type: "string", minLength: 1, maxLength: 200 } };
    const donationRequired = ["personId", "amount", "currency", "occurredAtMs", "message", "sourceName"];
    const schemaBodies: Record<string, Record<string, unknown>> = {
        "/api/v1/persons/:id/donor-bindings": body({ name: { type: "string", minLength: 1, maxLength: 200 }, revision }, ["name", "revision"]),
        "/api/v1/donations": body({ ...donationFields, occurredAtMs: { type: "integer", minimum: 0 } }, donationRequired),
        "/api/v1/donations/:id/assign": body({ personId: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] }, revision }, ["personId", "revision"]),
        "/api/v1/donations/:id/restore": body({ revision }, ["revision"]),
        "/api/v1/persons/:id/metadata": body({ tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 64 } }, manualCore: { type: ["boolean", "null"] }, revision }, ["tags", "manualCore", "revision"]),
        "/api/v1/persons/:id/notes": body({ body: { type: "string", minLength: 1, maxLength: 10000 } }, ["body"]),
        "/api/v1/persons/:id/notes/:noteId/update": body({ body: { type: "string", minLength: 1, maxLength: 10000 }, revision }, ["body", "revision"]),
        "/api/v1/persons/:id/notes/:noteId/delete": body({ revision }, ["revision"]),
        "/api/v1/sessions/start": body(),
        "/api/v1/sessions/:id/stop": body(),
        "/api/v1/sessions/:id/delete": body(),
        "/api/v1/persons/:id/rename": body({ name: { type: "string", minLength: 1, maxLength: 200 } }, ["name"]),
        "/api/v1/persons/merge": body({
            sourceId: text,
            targetId: text,
            sourceRevision: revision,
            targetRevision: revision,
        }, ["sourceId", "targetId", "sourceRevision", "targetRevision"]),
        "/api/v1/persons/split": body({
            identityIds: {
                type: "array",
                items: text,
                minItems: 1,
                maxItems: 1000,
                uniqueItems: true,
            },
            name: { type: "string", minLength: 1, maxLength: 200 },
            revision,
        }, ["identityIds", "name", "revision"]),
        "/api/v1/merges/:id/undo": body(),
        "/api/v1/splits/:id/undo": body(),
        "/api/v1/youtube/connect": body({ clientId: text, clientSecret: { type: "string", maxLength: 256 } }, ["clientId"]),
        "/api/v1/youtube/disconnect": body(),
        "/api/v1/twitch/connect": body({ clientId: text, extended: { type: "boolean" } }, ["clientId"]),
        "/api/v1/twitch/disconnect": body(),
        "/api/v1/donationalerts/connect": body({
            clientId: { type: "string", maxLength: 256 },
            clientSecret: { type: "string", maxLength: 4096 },
            accessToken: { type: "string", maxLength: 4096 },
            refreshToken: { type: "string", maxLength: 4096 },
            utcOffsetMinutes: {
                anyOf: [
                    { type: "integer", minimum: -840, maximum: 840 },
                    { type: "null" },
                ],
            },
        }, ["utcOffsetMinutes"]),
        "/api/v1/donationalerts/disconnect": body(),
        "/api/v1/donationalerts/rescan": body(),
        "/api/v1/donationalerts/timezone": body({ utcOffsetMinutes: { type: "integer", minimum: -840, maximum: 840 } }, ["utcOffsetMinutes"]),
        "/api/v1/backup": body(),
    };
    app.addHook("onRoute", (route) => {
        if (route.method === "POST" && schemaBodies[route.url])
            route.schema = { ...route.schema, body: schemaBodies[route.url] };
    });
}
