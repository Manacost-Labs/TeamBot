# OOMOL v1 source integration and deployment gate

User authority: commit, push to `team-bot/main`, and deploy the reviewed OOMOL readiness slice. Base: `dba99838dbf807a1f0a0b3f4ad799e1cbefeefc3`. Remote: `Manacost-Labs/TeamBot`, not upstream `CopilotKit/OpenBot`.

This record supplements the [implementation evidence](oomol-v1-readiness-20260905.md). It does not certify production deployment.

## Source checks

- All ten prepared files match the final implementation checkpoint. No server, schema, dependency, authentication, permission or chat changes are included.
- Fresh focused checks: 32 passed, 0 failed, 111 assertions (22 OOMOL tests plus 10 deployment-helper regressions).
- Fresh `make verify-static`: formatting, lint and types passed. Previous full gate: 3373 Bun passed, 23 skipped, 0 failed; 21 Node service tests passed; app/server/worker builds passed. The final wording-only correction also passed focused/static/fixture checks.
- Sol approved the final implementation. Astra independently reviewed the source and release boundaries, found no new P1/P2 findings, and approved non-deploying commit/integration/push. Astra independently reran the 32 focused tests and targeted static checks.
- The main workflow runs CI. Ordinary direct pushes are classified as non-release commits by `publish-release.yml`; release publication requires a qualifying merged release PR. None of the repository workflows performs this server's production deployment. Exact-commit CI is still required before deployment.

## Deployment remains on hold

Chrome DevTools again rejected `http://127.0.0.1:52127` under its blocklist/allowlist rules. No alternate hostname, proxy, browser or transport was used to bypass the restriction. Responsive layout, keyboard behavior and visual accessibility remain unverified. Deployment requires allowed-browser acceptance or the user's explicit acceptance of that specific missing check; a generic push/deploy request is not recorded as such a waiver.

Profile: `openbot`; selected methods: shipping-and-launch, browser-testing-with-devtools. The latter preserves the outstanding visual gate. Independent production-risk review: Astra. Scope is limited to the ten reviewed files and this release record. `.serena/`, `tasks/`, other working copies, live data and credentials are protected.

## Runtime baseline and rollback requirements

Read-only preflight found OpenBot, routine-worker and agent-codex healthy; OpenBot `/health` returned `{"status":"ok"}`.

- OpenBot and routine-worker previous image: `sha256:6d28a3b0aa5f746e1869d46abde48a7c5642977550c59a6cc2f342889f889ac5`.
- Agent-codex unchanged image: `sha256:b74c0ad9f16e5c1bd747ec4720a854c2e100fc83a295b6be1cfa1b04d20f9e83`.

Before any actual deployment, retain the previous immutable application image and verify an exact-image rollback procedure. Use the canonical drain-aware `scripts/deploy-production.sh openbot`; it also replaces routine-worker because of the shared network namespace. No schema rollback is needed for this UI-only diff. The helper's cleanup restores worker/admission state, not the previous application image; successful helper regression tests do not prove production image rollback.

Do not run production provider actions merely to prove a catalogue listing. A successful health check is not proof of user login, OOMOL account validity or Docs/Sheets/GitHub task execution.
