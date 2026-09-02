# HeartPulse control routine

The `Контроль HearthPulse` routine runs every six hours in UTC by default (the
routine preset is `0 */6 * * *`). This is a control-plane cadence, not a change
to the platform's server-side minimum: schedules may still run no more often
than every 15 minutes. It audits the
22 primary user-facing routes and their data boundaries before the strategy
specific checks:

- Home, Articles, FAQ, API, Gallery, Cosmetics, Guides Archive and Contests;
- Standard cards, matchups, meta, fun decks, archetypes and Vicious Gold;
- Arena classes, tier list and legendaries;
- Battlegrounds heroes, library, tier lists, strategies and tier builder.

Each route must return an HTML application shell. Each configured API boundary
must return valid JSON; `401`/`403` is recorded as `access_protected` for gated
data and is not treated as a parser or UI failure. HTTP errors, invalid JSON or
a missing application root are degraded states that the agent diagnoses before
considering a repair. The report includes `accessProtectedApis` and
`degradedApis` in addition to the section-level coverage, so protected data
boundaries remain visible even when their page shell is healthy.

## Fresh-only data boundary

Every six-hour cycle also checks the four one-day HSReplay meta slices that feed
the API-to-HeartPulse path:

- `hsreplay_meta_archetypes_legend_eu_1d`
- `hsreplay_meta_top_1000_legend_1d_firecrawl`
- `hsreplay_meta_legend_1d_firecrawl`
- `hsreplay_meta_diamond_4to1_1d_firecrawl`

A slice is fresh-only only when the publication evidence is present and
`upstream_freshness.status` is `fresh`. `state=ok`, HTTP 200, a cached/LKG
publication, or missing/unknown freshness evidence is a degraded state. Keep
that state visible in the HeartPulse report and hand parser/API evidence to
`Контроль данных`; do not render it as current data or replace it with a guess.

The agent may publish only a confirmed repair with a regression test and
targeted, full and security validation. Parser-originated failures are handed
to `Контроль данных`; upstream data that has not been published is reported and
not replaced with guessed values.
