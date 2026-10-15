import type { FastifyInstance } from 'fastify';
import type { ConfigurationPort } from './config.js';
import type { StorePort } from './store-contract.js';
import { object, string } from './provider-values.js';
type Store = StorePort<'createDonation' | 'donation' | 'donationAudit' | 'donationCandidates' | 'donations' | 'reassignDonation' | 'restoreDonation'>;
export function registerDonationsRoutes(app: FastifyInstance, db: Store, configuration: ConfigurationPort) {
    const donationInput = (b: Record<string, unknown>) => ({ personId: string(b.personId), amount: string(b.amount), currency: string(b.currency), occurredAtMs: b.occurredAtMs === null ? null : Number(b.occurredAtMs), message: string(b.message), sourceName: string(b.sourceName) });
    app.get("/api/v1/donations", async (request) => {
        const q = object(request.query);
        if (q.includeDeleted !== undefined && !["true", "false"].includes(string(q.includeDeleted)))
            throw new Error("INVALID_DONATION_PAGE");
        return db.call("donations", q.person === undefined ? undefined : string(q.person), q.offset === undefined ? 0 : Number(q.offset), q.limit === undefined ? 50 : Number(q.limit), q.includeDeleted === "true", q.session === undefined ? undefined : string(q.session));
    });
    app.get("/api/v1/donations/:id", async (request) => db.call("donation", string(object(request.params).id)));
    app.get("/api/v1/donations/:id/candidates", async (request) => db.call("donationCandidates", string(object(request.params).id), configuration.value.excludedBotLogins));
    app.get("/api/v1/donations/:id/audit", async (request) => db.call("donationAudit", string(object(request.params).id)));
    app.post("/api/v1/donations", async (request) => db.call("createDonation", donationInput(object(request.body)), Date.now()));
    app.post("/api/v1/donations/:id/assign", async (request) => { const b = object(request.body); return db.call("reassignDonation", string(object(request.params).id), b.personId === null ? null : string(b.personId), Number(b.revision), Date.now()); });
    app.post("/api/v1/donations/:id/restore", async (request) => db.call("restoreDonation", string(object(request.params).id), Number(object(request.body).revision), Date.now()));
}
