# Analytics fact cache and deployment

Migration 27 adds derived, profile-scoped activity/money versions, persisted stream
projections, and a coalesced SQLite job queue. Original polls, memberships, messages,
donations and audit records remain authoritative and unchanged.

## Invalidation and scheduling

- Finished stream keys include their own factual versions, logical group membership,
  exact clipped bounds and analytical settings. They exclude the global revision,
  follower snapshots, notes, channel-level YouTube reports and the current minute.
- Late donations replace financial projections, retaining attendance and clock facts.
  Membership changes and bot aliases invalidate streams containing those identities.
  Current labels, follower status and manual audience metadata are applied separately.
- Full finished-stream projections persist across restart. Transient rolling-window
  clips retain at most four variants per stream/table. Writes preserve a 1 GiB disk
  reserve; individual decoded projections are bounded to 16 MiB.
- Each dirty stream has one durable job. Jobs survive restart, coalesce repeated
  writes, and back off after failures. Both profiles catch up serially in batches of up to 200 ms between jobs;
  the scheduler yields between batches, prioritizes changed streams over initial
  backfill, and advances existing bounded report preparation.
- Heavy analytics uses one shared worker per physical database, separate from the
  collection/ordinary-read worker. Each worker has a 128 MiB old-generation limit.
  Overall service memory remains governed by the existing 512 MiB systemd limit.
- Period reports assemble cached contributions and retain exact unique membership.
  They can still require background assembly after changes; this does not reread
  historical attendance unless that stream's activity facts/settings changed.

Browser snapshots remain profile-scoped. Dynamics transfers the displayed month;
older months and seven-row return comparisons load on demand. Time transfers clock
summaries and loads visitor pages separately. Private ETags permit unchanged reads
without retransmitting bodies. All existing unprojected API responses remain available.

Category online uses measured viewer-minutes divided by known sampled minutes.
Known zero counts; missing data does not count as zero. Chat presence and video
viewership remain different signals, with coverage shown for incomplete observations.

## Reproduction

Run `pnpm benchmark:analytics` after installing the pinned Node/pnpm versions. It
creates an isolated database in a temporary directory and exercises the real worker
clients of both profiles, then removes the fixture. No production data is used.

Measured during this change on 10,000 finished streams split across two profiles:

| Measurement | Result |
| --- | ---: |
| Initial fact/report preparation | 82.0 s |
| Cached profile report p95 | 0.95 ms |
| Collection-worker metadata p95 during preparation | 56.0 ms |
| Largest displayed-month response | 30,790 bytes |
| Observed whole-process RSS, including workers | 260.4 MiB |

This scalability fixture has one recorded minute and one viewer sample per stream,
without chat/presence. It measures queue/cache scaling, not the cost of importing
10,000 long, busy broadcasts. Separate correctness tests compare chat, presence,
weighted means, money corrections, links, clipped periods and restart behavior with
raw calculations. Initial preparation cost depends on actual recorded activity.

## CI and rollback

Coverage artifacts live one day. `server-bundle` is validated on pull requests but
uploaded only for direct main/dev runs and retained seven days. Deployment/bootstrap
select a successful exact-main-SHA push/manual Quality gate run with a live bundle.
Expired/missing bundles fail before host mutations: rerun Quality gate on that exact
main SHA and retry deployment. Previously deleted artifacts are not deleted again.

Preserve the existing receiver's release/database rollback checkpoints. Returning to
a release with an older supported schema requires its matching database checkpoint;
do not simply point old application code at a newer-schema database.
