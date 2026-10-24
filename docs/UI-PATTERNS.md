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
