# Analytics review implementation

Core is the configured fraction of logical streams with >=20% combined activity.
Twitch sampled-minute semantics, YouTube activity estimation, source/category
filters, manual overrides, excluded owners/bots and profile isolation are retained.

Full-stream interval inputs are independent of timezone, category and core rules;
activity revisions invalidate them. Full-stream reports share this input. Partial
windows retain their boundary-poll query so observations starting after the window
cannot become fabricated attendance through minute rounding. Large raw YouTube
message counts are grouped before interval limits. Limits on grouped data and
expanded minutes still protect memory.

`coreAttendanceCount` is exact. `coreSessionIds` contains at most 100 unique IDs in
stable lexical order; `coreSessionIdsTruncated` explicitly marks an incomplete list.
Old core minute/message/session settings remain accepted and validated for older
clients but are normalized before cache addressing.

`GET /api/v1/persons/options` returns compact `items`, `selectedItem`, `total`,
`offset` and `limit` (max 50). Search matches names and aliases. `selected` preserves
an off-page choice; `includeBots=1` retains merge-form behavior. All data is scoped
by the existing authenticated profile. Existing directory endpoints are unchanged.
`GET /api/v1/persons/:id/analytics` returns only this person's intervals and a compact
minute-coverage timeline for a specified from/to/source/category/timezone.

Browser report equality reuses the existing HTTP ETag computed from the actual
response, rather than adding a revision that could race a concurrent write.
For analytical responses larger than 16 KiB, `X-Stream-Panel-Blocks` contains SHA-256 validators of
top-level blocks, and `X-Stream-Panel-Bytes` reports uncompressed response size.
Serialization is reused for the actual response body. Missing or invalid block
headers fall back to replacing the response, never to trusting stale data.

## Storage policy and rollback

`maxStreamCacheBytes` names the existing disposable stream-report cache budget;
`maxTotalBytes` is retained as an internal compatibility alias. Report caches retain
their independent budgets. Complete fact snapshots and shared interval inputs are
durable derived facts, intentionally retained across restart. They are not evicted
using the disposable-report budget. Partial variants stay bounded. Low disk skips
new derived writes. This release does not delete prior-format complete facts: they
remain available for rollback. Cleanup of obsolete formats must follow successful
release verification and must never delete source events.

The presentation revision row and triggers are additive to version-28 databases.
No schema version bump or rewriting factual data is required, and the preceding
application version can still open the database. New cache format keys prevent
reading obsolete results as current.

## Measurements

Run `node scripts/benchmark-review.mjs` before/after with identical runtime and
fixture. `STREAM_PANEL_REVIEW_DIST` selects a baseline build. It reports raw and
cold-report grouping counts, cold latency, hot p50/p95, response bytes and RSS.
The fixture is intentionally labelled; operation-count reductions do not establish
a percentage speedup for the whole server. The existing 10,000-stream benchmark
and dense-chat regression tests cover different workloads.
