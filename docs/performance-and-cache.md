# Performance and cache contract

Read this before changing data writes, API projections or screen loading. Preserve
all metrics, exact bounds, missing-data semantics, profile isolation and freshness.
The detailed fact/tree layout is in [analytics-performance.md](analytics-performance.md).

## Data → calculation → cache → browser

SQLite raw events, memberships, samples and donations are authoritative. Triggers
advance domain and per-stream revisions. A shared analytics worker per physical DB
builds versioned stream facts and an incremental reduction tree; collection uses a
separate worker. Corrections replace only affected leaves and their ancestors.

1. Per-stream facts use stream/group identity, activity/money revisions, clipped
   bounds, source/category, bot exclusions and calculation settings. Finished facts
   persist; live facts use their current factual revision in bounded memory.
2. Period reports use effective historical bounds, stream revisions, settings,
   presentation and follower versions. Rolling core has an independent minute-stable
   membership cache. Exact moving 7/30-day report bounds remain in report requests.
   Live aggregate snapshots include the live revision and reuse unchanged history;
   changed chat/polls invalidate the live contribution. No additional stale TTL is
   introduced. Completed memory/workspaces and SQLite report storage are bounded.
3. Panel projections include the panel, selected clock day/resolution, audience
   search/sort/page/core filter and stream range. Time requests `clockActivityCompact=1`: the worker merges minute numerators,
   exposure, bot totals, known/partial viewer durations and exact currency minor
   units into the selected day/resolution before RPC. The UI receives only this
   activity grid plus aggregated attendance buckets and the complete currency list; other day/resolution and participant pages load on demand. The default unprojected
   API retains the minute grid for existing clients. The full API
   is retained. UI follower endpoints omit unused `polls`; stored history and core
   diagnostic methods retain it. Poll summaries are suppressed before worker RPC
   for these UI reads. The stream view requests an explicit projection containing
   filters, summary, full timeline, full audience and viewer comparison; clock/cohort
   tables unused on that page stay in the full analytical API.
4. Worker read caches are client/profile scoped and observe committed writes before
   reuse. Their existing 30-second moving-window policy is unchanged. Persistent
   analytical caches remain authoritative only for matching factual versions.
5. Route-local prepared bodies retain serialized JSON, block hashes and ETag within
   8 MiB/128 entries per route registration. Keys include route/session, exact query
   (excluding the background scheduling hint), calculation settings, owner/accounts,
   exclusions and authoritative `changes` versions. Analytical keys also include the
   minute-stable rolling-core clock; follower keys do not depend on a wall-clock tick. Check versions before a hit.
   Missing/future time bounds and any active stream bypass this additional wire
   cache, avoiding freezing elapsed live time. Progress responses are never cached.
   Logout/authorization runs before route lookup; no cache bypasses access control.
6. The compression hook retains gzip by content ETag within 4 MiB/128 entries,
   maximum 2 MiB per entry. It respects encoding negotiation, including `gzip;q=0`.
   Private responses vary by profile, cookie and encoding. A matching ETag sends an
   empty 304 before loading the report or serializing/compressing its body.
7. Browser snapshots include profile, filters, server and mutation versions; they
   clear on logout. Stale snapshots can stay visible during revalidation, never
   substitute another profile. Authenticated status permits shell-free pages to
   start alongside revision checks. Followers/subscribers start alongside the
   visible report. Other panels preload serially after it completes.

Background fact advancement, warming and panel preloads yield to foreground FIFO
reads/writes. Client open/close are queue barriers. An executing SQLite statement
cannot be preempted. Background reports advance one bounded generator slice;
foreground StoreClient reads coalesce bounded worker slices for up to two seconds per API read
before returning progress. One expensive indivisible operation can exceed this;
never claim a hard end-to-end deadline from the slice limit alone.

The warmer freezes a cycle's minute-aligned endpoint and prepares all-time, 7-day
and 30-day projections for Dynamics, Time and Audience. It advances unfinished work
serially, checks queue pressure, refreshes on data/settings changes and each minute,
and stops cleanly. Warming must not change raw data or require a collector restart.

## Budgets and measurement

Product targets: every analytics panel/period and a stream page ≤1 s cold and
≤300 ms warm, measured from navigation/filter action to meaningful rendered content.
API fixtures alone do not prove browser or production targets. Do not trade accuracy,
functionality or freshness for a target without owner approval.

Run `pnpm build`, then `node scripts/benchmark-screen-api.mjs`. It creates isolated
raw-data fixtures, copies the unprojected database per screen, measures process-cold,
warm and conditional HTTP-handler loads, and deletes the databases. It includes
worker startup/RPC and preparation request count, JSON/transfer bytes and empty 304;
it excludes TCP/network/browser rendering. Use `STREAM_PANEL_BENCHMARK_ROOT` to
measure a separately built baseline with the identical fixture. No production access.

CI uses `STREAM_PANEL_PERF_GATE=1`: each fixture cold load ≤3 s (a coarse regression
ceiling, **not** the product's 1 s acceptance target), warm ≤300 ms, projected JSON
≤300 KiB and conditional response 304. Keep the existing 10,000-stream scaling gate.
The stream fixture uses its chart/participant projection with a 2 MiB JSON
ceiling; it preserves chart/participant functionality rather than silently dropping
fields to satisfy a projection budget.

For browser checks, record the API waterfall (request start, TTFB, completion,
transfer/decoded sizes and count), console errors and time to the rendered chart or
audience table. Exercise 7/30/all × three panels, exact custom filters, stream
summary/people/current/events, cold browser/restart and warm return. Use isolated
synthetic live input for live freshness checks. Production measurements require an
existing authorized read-only setup; never change a live collector or server by hand.

## New feature checklist

- List affected domains, stream facts, report/projection, wire and browser keys.
- Include every output-affecting setting/filter/profile and exact historical bound.
- Advance authoritative versions on each relevant write, including late corrections,
  identity merges, exclusions, donations, follower and presentation changes.
- Prove unchanged data reuses caches; changed data invalidates all relevant layers.
- Return only fields rendered by that endpoint's clients; keep diagnostic data at
  its source or an explicit detail endpoint. Paginate large lists without truncation.
- Add correctness, key/isolation, invalidation and ETag/304 tests; measure cold/warm
  latency, response bytes and request count. Add/adjust an honest CI budget.
- Verify default and custom filters, lazy details, live updates, cancellation,
  restart and bounded memory; record limitations in the PR.
- Update this contract and the architecture/PRD when dependencies or loading change.
  Main/production require explicit owner approval; performance work never implies it.
