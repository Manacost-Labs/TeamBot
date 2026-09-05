# OOMOL readiness — first quality-v1 slice

Base: `dba9983`. Final worktree: `/home/debian/.codex/worktrees/openbot-v1-readiness-reviewed-20260905`, branch `feat/oomol-v1-readiness-reviewed`.
No commit, main integration, push or production deployment in this iteration.

## Implemented

- One Russian-language setup/readiness panel on the existing OOMOL administrator page. It distinguishes missing setup/key, unchecked, checking, failed, empty discovery, unavailable agent roster, missing grants, missing/partial callback configuration and recorded grants with callback settings.
- Explicit shared ownership: this connector uses the account behind the administrator-supplied OOMOL key, not each participant's personal account. Existing authentication and authorization remain authoritative.
- Action groups show observed catalogue prefixes, action counts and recorded agent grants. The friendly `googledocs`/`googlesheets` labels follow [OOMOL's service-ID documentation](https://oomol.com/en/docs/openconnector-google-oauth-app/); grouping is presentation only, not a new account identity or permission boundary. Unknown groups remain visible; absent services are not invented.
- Recovery guidance distinguishes rejected keys, permissions, rate limits and temporary failures without echoing arbitrary vendor text in the new panel. Old catalogue entries remain visible with an unconfirmed-access warning after failure.
- Existing explicit setup, refresh and grant dialogs are reused. No automatic discovery on mount, automatic grants, provider actions or polling. Refresh reads the action catalogue; it does not prove a document/table/repository operation succeeds.
- The transport's existing HTTP-200 failure behavior is accounted for: `lastError` wins over cached tools, so a failed discovery never becomes a success toast or ready state.
- Grant counts intersect the available agent roster. Unresolved recorded IDs are shown separately, never described as deleted agents. A missing roster is not an empty roster; an empty available list suggests unhiding an agent or creating one. Shared/per-agent callback settings affect the projection but do not prove actual provider execution.
- A late OOMOL save no longer resets a newer refresh after route navigation; reset occurs before the save's first await.

## Verification

- New feature tests initially failed because the panel/projection were absent. A separate actual-route regression then failed on the old screen's missing readiness action and passed after integration.
- Focused after final review: 22 passed, 0 failed, 65 assertions; covers real router + query/mutation contracts with fixture HTTP responses, HTTP-200 failure, retry without grant/credential writes, callback configuration, unavailable/unresolved agents and deferred-save navigation.
- Canonical `make verify`: 3373 Bun passed, 23 skipped, 0 failed; 21 Node service tests passed; formatting, lint, types and app/server/worker builds passed. This full run precedes the final wording-only empty-roster correction; focused tests, `make verify-static` and fixture build passed again for that correction.
- The navigation regression runs in a fresh Bun unit-test process: Base UI caches DOM availability at module initialization, so the shared suite's earlier SSR imports otherwise prevent its real portal mounting. The parent fails on child errors and requires one matching test to pass. This remains Happy DOM with mocked HTTP, not browser/visual evidence. The first full run exposed this test-order failure; no test was skipped or weakened to hide it.
- Full verification used a freshly migrated disposable pgvector database, never a production database. The task-owned container and its tmpfs test data were removed afterward; these disposable records are recreatable by migrations/tests. No named volumes or user data were removed.
- The standalone visual fixture compiles with the project's pinned Vite 7.3.6. To open locally: `bun app/node_modules/vite/bin/vite.js --config app/tests/oomol-readiness-fixture/vite.config.ts --host 127.0.0.1 --port 52127 --strictPort`.
- Browser verification is **blocked**, not passed: Chrome DevTools rejected navigation to the fixture origin under its blocklist/allowlist rules. No alternate browser path was used to bypass that restriction. Responsive layout, screenshots, keyboard and visual accessibility still require an allowed browser session before release.
- Existing PageShell `nativeButton` development warning was reproduced on the unmodified route during RED verification. Existing SDK and large-bundle warnings remain; no checks were weakened or warnings suppressed.
- Independent Sol review: approved, no remaining P1/P2 findings on the final source/test revision. Callback reachability, unresolved grants, the reset race and empty-roster guidance are resolved. Reviewer independently reran the focused suite and inspected final static/build evidence. Browser acceptance remains outstanding; this approval is not release authorization.

## Boundaries and next acceptance step

No server, public API, schema, credential storage, provider effect classification, grant mutation or chat changes. No real OOMOL credentials or user data were read. Original worktree, `.serena/`, `tasks/` and other sessions' edits are preserved.

Profile: `openbot`. Applied frontend-ui-engineering (existing tokens, semantic controls, explicit states), test-driven-development (meaningful RED/GREEN regressions), browser-testing-with-devtools (visual gate remains blocked). Independent reviewer: Sol. Scope v3 covers only the panel, helper, tests, fixture, admin route and this evidence document.

The intermediate worktree `openbot-v1-readiness-20260905` is preserved but superseded: recreating its scope after owned edits mistakenly classified those files as protected baseline dirt. Its claim was closed, and the owned patch was transferred to a clean worktree with scope initialization before edits. Use only the reviewed worktree above for follow-up; main remains at `dba9983`.

This is not the complete v1 or a complete replacement for onboarding. Next: finish visual QA in an allowed browser, then validate three owner-approved end-to-end tasks (Docs, Sheets, GitHub) in test accounts. Personal-account architecture and write-action execution require their own reviewed slice; do not infer authorization from a catalogue listing.
