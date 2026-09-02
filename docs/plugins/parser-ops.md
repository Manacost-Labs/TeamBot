# Parser Ops

Parser Ops is the first-party, least-privilege boundary used by the **Контроль данных** Bot. It
monitors every source in `api.kolodahearthstone.com`, permits bounded retries of at most five known
source ids, validates repairs in a dedicated clone, and publishes only an exact commit that passed
targeted, full, and security checks.

The Bot cannot read production secrets, run Docker or systemd, push directly, or edit the runtime
tree. The host service reads only the scoped orchestrator credential it needs and never includes it
in a result. Production deployment goes through `scripts/deploy-server.sh`; a failed deployment or a
post-deploy result other than `fresh_published` creates a reverting commit and deploys it.

The connector is granted per Bot and every call still passes OpenBot's action policy and audit trail.
The host boundary authenticates with a one-way value derived from `AGENT_TOOL_TOKEN`, so the service
credential is not stored separately or returned to the model.

## Six-hour freshness control

The `Контроль данных` routine uses the six-hour preset `0 */6 * * *`; this is
the routine's cadence and does not relax the platform-wide 15-minute minimum.
Each cycle must call out these four one-day HSReplay meta sources explicitly:

- `hsreplay_meta_archetypes_legend_eu_1d`
- `hsreplay_meta_top_1000_legend_1d_firecrawl`
- `hsreplay_meta_legend_1d_firecrawl`
- `hsreplay_meta_diamond_4to1_1d_firecrawl`

For these sources, `state=ok` or HTTP 200 is availability only. The result is
fresh-only only when publication evidence and
`structured.upstream_freshness.status=fresh` are present. A cached/LKG result,
`provisional`, or missing/unknown freshness evidence must be reported as
degraded and must not be treated as a successful fresh publication.
