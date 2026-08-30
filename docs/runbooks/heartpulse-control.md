# HeartPulse control routine

The `Контроль HearthPulse` routine runs every 15 minutes in UTC. It audits the
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

The agent may publish only a confirmed repair with a regression test and
targeted, full and security validation. Parser-originated failures are handed
to `Контроль данных`; upstream data that has not been published is reported and
not replaced with guessed values.
