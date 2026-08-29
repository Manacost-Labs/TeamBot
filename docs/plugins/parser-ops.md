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
