# Chat reliability implementation review — 2026-09-04

> **Superseded release status:** This implementation review is retained as
> history. The current release evidence and approval state are in
> [`chat-release-20260904.md`](chat-release-20260904.md). This document does
> not grant final release approval.

## Scope and current outcome

The reviewed change set covers five concerns:

1. mutable transcript rows at any history position;
2. entrance-animation cancellation during same-key streaming deltas;
3. stale completed thread-history snapshots during reconciliation;
4. cross-run assistant-output false positives when per-message run IDs are absent;
5. provider-invalid MCP tool aliases and their server/router/UI consumers.

The implementation and focused regression evidence are complete. The release
decision remains **pending** the parent's final serial canonical gate and
review. No commit, push, or deployment has been performed by this reviewer.

## Current evidence

- The external browser reliability artifact `chat-release-browser-20260905.json`
  (stored outside this repository at
  `/home/debian/.codex/visualizations/2026/09/04/01a06c25-74c2-7df1-8266-5db9bd149d54/chat-release-browser-20260905.json`)
  is `passed: true` at revision `2244e96`. Desktop and mobile/4× CPU each
  passed 12 same-key deltas, stable row identity, corrected-history refresh,
  preserved scroll, reduced-motion behavior, zero external requests, and no
  page errors. The harness is a local production UI fixture; it excludes
  authentication, provider, and network latency.
- Historical focused implementation evidence was 131/131 tests across 10
  files. The later security-focused slice was RED 4 failing/1 passing and
  GREEN 70 passing across 3 files after the fixes described below. These are
  historical checkpoints, not substitutes for the pending serial gate.
- The four-file security diff inspected for this Gate B review is limited to
  `server/src/app.ts`, `server/src/plugins/store.ts`,
  `server/tests/agent-tool-call-context.test.ts`, and
  `server/tests/plugin-store.integration.test.ts`.

## Security and correctness review

Two Astra findings were closed in the inspected diff:

- policy evaluation retains the legacy `tool.name` identity while transport
  aliases remain provider-safe, so existing deny rules do not silently stop
  matching;
- unresolved or revoked hashed aliases emit only a bounded alias plus the
  signed actor, Bot, run, optional thread, and refusal reason. Tool arguments
  and guessed server/action identities are not recorded. The final
  `callTool` path remains the grant, actor, authentication, and policy
  authority.

The callback tests cover granted dispatch, revoked grants, signed context, and
bounded rejection auditing. A direct router-grouping assertion would improve
coverage, but no router defect was found in the raw-ref implementation.

## Performance and test limitations

The correctness fix uses direct transcript projection to avoid stale arbitrary
row updates. It is not a speed improvement. The historical warm-switch run
passed 14/16 scenarios; warm-switch p95 was 160.5 ms on desktop and 576.1 ms
on mobile/4× CPU against 100 ms and 400 ms targets. The limitation is tracked
as follow-up work requiring an upstream revision/invalidation signal.

The attachment-related full-run failure is a known fixture timing race: a
40 ms lease is created before the asynchronous blob write, so it can expire
before the validator enters. It is not a reported runtime regression and no
runtime change is planned for it. The parent is rerunning the canonical gate
serially without the frontend benchmark/scanner parallel load; that result is
pending.

Historical verification caveats remain relevant only as context:

- AI settings failures reproduced under earlier host load; the latest isolated
  settings run passed 16/16 and the app run passed 467/467 without authentication
  behavior changes.
- `TEST_DATABASE_URL` must be an explicit migrated disposable database for
  the canonical test phase. No deployment database or secrets were used.
- Gitleaks staged scanning was clean; OSV retained 15 existing filters with
  no new unfiltered finding; Semgrep covered 22 rules with zero findings in
  the inspected files. CodeQL had no analysis database and Helm was unavailable, so no full
  scanner or chart claim is made.
- Chrome MCP navigation was policy-blocked. The browser result above is from
  the local harness, not a production browser session or live OOMOL run.
- The five baseline format failures were corrected in `f140fe2`. Clean candidate
  formatting and linting passed; protected untracked diagnostics still produce
  four lint warnings in the development worktree and are not release files.

## Review handoff

**Critical:** none found in the inspected four-file diff.

**Required:** none found in the inspected four-file diff. Release approval is
still blocked by the pending canonical serial gate, not by an open code
finding.

**Follow-ups:**

- parent appends the actual serial `make check` result and final gate outcome
  to [`chat-release-20260904.md`](chat-release-20260904.md);
- parent verifies the CI-only Drizzle metadata repair: the old CI run
  `33912717186` reported format/tests/migrations failures because the existing
  `0036_manacost_team_autonomy.sql` migration lacks
  `server/drizzle/meta/0036_snapshot.json`. The readonly diagnostic also
  showed that generating SQL would duplicate `0036`; this is metadata repair,
  not a new migration. Until the parent adds and verifies only the missing
  snapshot plus its regression test, the full candidate gate remains pending;
- optimize transcript projection only after a reliable invalidation signal is
  available;
- add a direct router-grouping regression assertion;
- keep the attachment fixture timing issue separate from runtime behavior and
  fix it only in an explicitly scoped test-harness change.
