# Chat reliability review — 2026-09-04

## Scope and outcome

Gate B review of the OpenBot chat-reliability implementation at baseline
`aba4e9f`. The change addresses five narrowly scoped concerns:

1. transcript projection correctness for mutable rows at any history position;
2. entrance-animation cancellation during same-key streaming deltas;
3. stale completed thread-history snapshots during reconciliation;
4. cross-run assistant-output false positives when per-message run IDs are absent;
5. provider-invalid MCP tool aliases and their server/router/UI consumers.

No authentication flow, environment, production, database, dependency,
pagination, grant-policy, or unrelated refactor changes were assigned or
reviewed. Callback alias resolution was explicitly in review scope; it did not
change the authentication flow.

The implementation review found no Critical or Required correctness,
security, or integration finding remaining. The principal residual risk is the
performance cost of direct transcript projection, recorded below.

## Implementation and test evidence

Each behavior was developed with a focused RED test followed by GREEN
verification:

- transcript tests cover earlier-row replacement with unchanged length/tail,
  stable-array nested mutation, and animation continuity;
- reconciliation tests cover bounded turn output and cross-run false positives;
- thread-history tests cover fresh cache bypass, concurrent pending-read
  sharing, and the legacy fresh reader;
- alias tests cover valid legacy names, dotted/long names, collision-resistant
  `mcp_h__` aliases, signed-bot callback dispatch, revoked grants, guidance
  grouping, and UI display.

The UI alias parser was additionally corrected to strip the digest from the
joined action rather than the last `__`-split segment. This matters because
base64url digests can contain `__`. A long-server-name fallback now renders as
`Tool call` while retaining the server detail.

Reported focused results: 131/131 tests GREEN across 10 files: 21 transcript
tests, 44 history/reconciliation tests (31 history and 13 reconciliation), 9
tool-name tests, and 17 worker naming/guidance tests including OOMOL coverage.

Browser reliability is GREEN on desktop and mobile 4× CPU: 12 same-key text
deltas preserve the same DOM node and CSS animation identity; an earlier
history row refreshes; actual wheel scrolling remains within 1 px; reduced
motion produces zero animations; external requests are zero.

The callback path resolves hashed aliases using the signed bot's current raw
grants. `callTool` remains the final authority for authentication, grant
authorization, actor access, and policy. Valid legacy `mcp__` names remain
unchanged. The Codex adapter requires no change because `mcp_h__` is already a
valid non-reserved provider name, while the deployment-name map preserves the
exact wire name. This is not a claim about every generic OpenAI adapter.

Router provider grouping and model guidance now use the raw `server/tool` ref,
so hashed aliases do not appear as a synthetic `h` provider. Callback tests
cover signed dispatch and revoked grants. A direct router-grouping assertion
would still be useful future coverage, but no production defect was found in
the raw-ref implementation.

## Performance limitation

The correctness fix intentionally replaces the prior unsafe last-two-row memo
with direct `projectTranscriptWindow` projection. This guarantees arbitrary
mutable-row refreshes but scans/rebuilds projection state on each render. It
must not be described as a speed improvement.

The completed performance run passes 14 of 16 scenarios; warm-switch p95 is
160.5 ms on desktop and 576.1 ms on mobile 4× CPU, against targets of 100 ms
and 400 ms respectively. A future optimization should
introduce a reliable upstream revision/invalidation signal or equivalent
bounded invalidation without restoring stale arbitrary-row behavior.

The browser harness is a local synthetic `ChatTranscript` fixture. It does not
measure production TTFT, CWV, provider/network latency, or sustained production
flicker.

## Verification caveats

- A fresh isolated checkout at `aba4e9f` reproduces the AI settings baseline:
  14 passing, 2 failing, and 1 error. Those settings cases are pre-existing
  and untouched.
- The proper app-only run reports 460 passing, with the same two settings
  failures and one error. The isolated baseline at `aba4e9f` reproduces
  exactly 14 passing, 2 failing, and 1 error; these cases are pre-existing and
  untouched. The broad app run accidentally matched seven server append tests;
  their temporary local rows were cleaned by `afterAll`. The final focused
  ten-file run used no database.
- The common `ai-check` root-tsconfig detection failure is baseline tooling
  debt.
- Knip was blocked because `drizzle.config` requires `DATABASE_URL`; no
  secrets were supplied. Existing unused diagnostics remain baseline debt.
- Quick security passed: Gitleaks scanned 417 commits and OSV retained the
  existing 15 filters. Semgrep passed 22 rules across 9 production files with
  zero findings after the server-app changes.
- Focused Biome format and lint checks passed for the 18 touched files. The
  repository-wide Biome format check reports five pre-existing untouched files:
  `app/src/routes/sign.tsx`, `app/src/routes/sign.test.tsx`,
  `server/tests/health.test.ts`, `tests/nginx-telegram-oidc.test.ts`, and
  `server/tests/telegram-plugin.test.ts`. They were not formatted or otherwise
  modified; the baseline rerun confirms this exact debt.
- ESLint and Vitest were skipped because this project uses Biome and Bun.
  CodeQL was skipped because no project database/build was available. Trivy
  was skipped because there were no dependency or infrastructure changes;
  OSV covered dependency scanning. External live OOMOL/authentication tests
  were not run because the provided credential was intentionally not used.
- The app production build passed in 19.23 seconds using the safe example
  generated configuration. Vite large-chunk and browser-externalization
  warnings are baseline warnings; no deployment was performed.

## Handoff and ownership

- Profile: `openbot`.
- Implementation guidance applied: using-agent-skills, planning, TDD,
  incremental implementation, frontend/API engineering, debugging, performance,
  context engineering, browser testing, code review, security hardening,
  Git workflow, CI/CD and dev-team coordination. The TDD package's referenced
  `writing-good-tests.md` was missing; its main test-first contract was applied.
- Applied review guidance: code-review-and-quality, performance/diagnosis,
  browser verification, and test-focused regression review.
- MCP/tooling: Context7 React documentation, Serena navigation, and GitHub
  main-repository verification were used. Chrome MCP page listing worked, but
  navigation was blocked by policy and produced no production/runtime result.
  Local Playwright fixture runs were independent and recorded zero external
  requests. No production database was accessed intentionally and no database
  schema was mutated; the broad test-run caveat is documented above.
- Context and implementation gates: both native `gpt-5.6-luna` gates were
  available and executed.
- Protected paths: original `.serena/` and `tasks/`, plus isolated dependency
  symlink paths, remained outside the task edits.

## Final review status

All Critical and Required implementation findings are closed. Remaining items
are non-blocking: the two warm-switch budgets remain above target, direct
projection needs a future invalidation optimization, direct router-grouping
coverage would be useful, and repository-wide format debt remains in five
untouched baseline files. The production build is GREEN; at reviewer handoff,
commit and push were left to the main agent. This document is the only documentation path assigned to and
changed by the Gate B reviewer.
