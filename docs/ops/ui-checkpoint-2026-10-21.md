# UI checkpoint — 21 October 2026

Pre-redesign production commit: `4026d3be91a11d89784df1759e12d08885790992`.
Permanent GitHub branch: `checkpoint/ui-before-redesign-2026-10-21`.

The redesign changes the web interface and its browser tests, not database schemas,
collectors, report calculations, APIs, authentication or stored facts.

## Before the consistency polish

The first responsive UI release remains available at
`7233e5050c0b90103b3f404dec89e30081d5a96c`, branch
`checkpoint/ui-before-polish-2026-10-21`. The follow-up changes disclosure controls,
overflow sheets, spacing and partial-data labels only. To undo this follow-up,
revert its release merge on current main using the same process below.

## Roll back the UI

Before the chart-density and People refinement, production is preserved at
`69f0d07e328e16f9cf714a49bbb0d1f211e5bd98`, branch
`checkpoint/ui-before-people-2026-10-21`. This refinement adds read-only 30-day
donation totals without changing stored facts or database schemas.

Before the compact participant table, production is preserved at
`07c37065a345fecede9c5fb6a6b010d1e793852f`, branch
`checkpoint/ui-before-participants-2026-10-22`. The table refinement changes
presentation and disclosure state only; presence and donation calculations stay
unchanged. It preserves loaded participant pages during data refresh.

Revert the redesign merge/squash commit on a branch from the **current main**,
run the existing quality gate, merge and let `Deploy server` publish the release.
For a normal merge use `git revert -m 1 MERGE_SHA`; for a squash commit use
`git revert SQUASH_SHA`. Resolve any later UI edits before merging the revert.
This preserves database history and subsequent backend fixes. Do not restore an
old database, force-reset main or redeploy the entire checkpoint after later
backend/schema changes just to change the appearance.

## Function inventory

| Previously visible | New location |
| --- | --- |
| Channel overview totals | More → Channel totals; 30-day and all-time donation sums also on Streams |
| Profile selection | Page heading |
| Refresh on/off, interval, manual refresh | More → Data refresh |
| Integrations, settings, logout and backups | More → Integrations / Settings |
| Open stream | Click the stream card; link supports normal browser navigation |
| Merge streams | Streams → Select → check streams → Merge |
| Unmerge / delete manual stream / platform recording links | Stream card → … |
| Viewer peak / donor count / breaks | Stream card → …; peak also in stream totals |
| Stream chart and minute drilldown | Stream → Results; metric and 1/5/15 min controls above the chart (5 min default, last choice saved per profile) |
| Viewer ranking and sorting | Stream → Participants; tap a column heading, or the currency sort on phones |
| Participant intervals | Tap the time/chevron; intervals expand directly below that row, collapse without reserved space |
| Participant account identities | Tap the participant name → Accounts; aliases are not repeated in the stream table |
| Following / subscription history | Stream → Results → Subscribers |
| Archived chat, moderation and donation events | Stream → Events |
| Stream names, categories, breaks | Stream heading → … |
| Insights, evidence and person links | Results / Analytics → Insights |
| Period, platform, category | Analytics → period shortcuts / Filters |
| Custom dates | Filters → Custom period |
| Display preferences and timezone | Filters → Display and timezone |
| Growth, categories, stream comparison, YouTube channel report | Analytics → Trends; detailed tables expand |
| Heatmap, clock and interval visitors, schedule and donation timing | Analytics → Time; each chart has options |
| Audience composition, search, core filter, attendance, minute intervals | Analytics → Audience |
| People search, ranking and paging | People → directory; desktop directory remains beside the selected card |
| Person statistics, activity, messages, donations, notes/tags, merge/split/undo | Person card → Overview / Activity / Messages / Donations / Notes / Accounts; phone back button returns to the directory |
| Donation editing and assignment | Donations; person card → Donations |

Missing measurements remain distinct from zero. Incomplete measurements remain
explained in stream actions, chart help and selected-bar details; the repeated
visible "частично" label was removed at the user's request. Settings remain
scoped to the selected profile. Unknown donation dates count toward all-time
totals only; the 30-day period uses confirmed timestamps and exact currency sums.
