# UI review: charts, panels and tables

Reference: the stream viewer/chat chart. Preserve data, chart selection, keyboard
navigation and drill-down behavior. These are semantic groups, not a blanket restyle.

| Pattern | Screens/components | Rule |
| --- | --- | --- |
| Metric/source selection | Stream Overview, daily dynamics, ActivityClock, TimePatterns, DonationPatterns | Native compact selector; advanced selectors in the existing disclosure |
| Period | Analytics toolbar, SubscriberGrowth, stream chart interval | Segmented control with one shared selected treatment; date navigation adjacent and wrapping when necessary |
| Navigation | SectionTabs, mobile navigation | Keep distinct from period/metric controls; preserve ARIA tabs and keyboard support |
| Chart panel | Daily dynamics, subscribers, hourly clock, time and donation patterns, categories | Common header/gutters, control sizing and numeric alignment; retain each visualization's meaningful scale |
| Summary cells | ChannelOverview, stream metrics | Preserve existing compact cells; dates/secondary values remain smaller |
| Ranked rows | CategoryComparison, participant rankings, returning audience | Compact aligned values, optional inline evidence; do not turn every row into a separate panel |
| Evidence tables | Stream/person intervals, event/donation lists | Preserve semantic columns, phone layouts and links; no nested generic card restyle |
| Help/settings | Help, chart disclosures, Sheet | Help beside title; optional chart settings in one disclosure; sheets for actual filters/actions |

The broad stylesheet predates these changes and contains several layers of overrides.
Only verified obsolete selectors are removed. Source/database/collector code is outside
this visual cleanup. Removal of executable code requires checking production imports,
not merely finding an unused exported name.

Rollback: functional graph/filter fixes are the first commit. Styling and cleanup are
subsequent commits so they can be reverted without undoing the functional fixes.

Ownership after maintenance:
- `ui-patterns.css` owns shared period controls, chart toolbars, panel controls and numeric alignment.
- `TrendChart.svelte` owns its SVG, palette, selection overlay, caption and paging geometry. Global styles must not target its internal rectangles.
- Screen components own screen-specific placement; `style.css` and `quiet-ui.css` retain legacy page styles until separately verified migration.
- Functional caching/API/CI changes and style ownership cleanup are separate commits. This cleanup preserves computed layout at 320, 390 and 1280 px.

## Compact overview and Back navigation

- The overview keeps all six totals and five records. Short counts share a row;
  duration and the paired donation figures get space for longer values. The last
  record fills the row rather than leaving an empty grid cell. On desktop its
  label, amount and attribution align horizontally.
- Date controls use SVG chevrons in equal 44px targets and a flexible central
  label. Keep both buttons in place when either direction is disabled.
- Header Back uses native browser history, including section tabs. The browser's
  Back and Forward controls have the same behavior. Reload retains the entry.
- Direct links without an in-app predecessor replace their entry with a parent
  screen; they do not push a parent that would create a Back loop.
- All people is an explicit directory action, not a second Back. Directory search,
  sorting and page are kept per profile in the browser entry. Stream history page
  is part of the route so reload and Back restore the same page.
- Analytics section tabs sit inside the page on phones; the primary navigation
  stays available. No report, filter, setting, account action or metric is removed.
- List paging uses Previous/Next wording to distinguish it from screen Back.

Visual review used the accepted November 13 reference and Chromium screenshots at
320, 390, 677 and 1280 CSS pixels (Playwright fallback: no browser connector was
available). Compared palette, type hierarchy, all six totals/five records, compact
card spacing, donation grouping, date alignment and navigation targets. The
reference's illustrative account/data were not introduced into the application.
Intentional extensions: universal Back per the follow-up request, existing profile
placement preserved, 320px label wrapping and desktop horizontal record layout.

Returning audience by stream uses one compact table: date, returning/total count
and percentage. The short bar stays in the percentage column. Zero and unknown
remain distinct. Paging stays at the bottom in equal chevron targets; its range
shows which seven streams are visible. At desktop widths the section follows the
width of one dynamics chart instead of stretching sparse values across the page.
The retention regression covers 320/390/1280px, page switching and unknown values.
