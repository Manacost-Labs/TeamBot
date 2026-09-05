# Chat reliability release evidence — 2026-09-04

**Status: pending final serial gate and parent approval.** This record is
evidence for the chat-reliability change; it is not a deployment approval.

## Candidate

- Feature HEAD: `2244e96` (`test: align connector guidance fixtures with granted tools`).
- Main baseline: `aba4e9f`.
- Earlier implementation: `228331a` (chat updates and OOMOL dispatch).
- Verification wiring: `f140fe2` (canonical `make check` phases and baseline
  formatting corrections).
- No schema, Compose, Dockerfile, dependency, authentication behavior, or production
  data changes are part of this release candidate.

## Evidence status

| Area | Result | Notes |
| --- | --- | --- |
| Chat browser reliability | **PASS** | Desktop and mobile/4× CPU; 12 deltas each, stable rows, corrected history, preserved scroll, reduced motion, zero external requests, no page errors. External artifact filename: `chat-release-browser-20260905.json`; no repository-relative artifact is claimed. |
| Focused implementation tests | **PASS (historical checkpoint)** | 131/131 across 10 files. |
| Security slice | **PASS (historical checkpoint)** | RED 4 failing/1 passing, then GREEN 70 passing across 3 files; Semgrep 22 rules/0 findings; Gitleaks staged clean. |
| Full canonical gate | **PENDING** | A parallel rerun had one known attachment-fixture lease timeout; the parent is rerunning serially without frontend benchmark/scanner parallelism. A CI-only Drizzle metadata repair is also pending: old CI run `33912717186` reported format/tests/migrations failures because existing `0036_manacost_team_autonomy.sql` lacks `server/drizzle/meta/0036_snapshot.json`. Readonly generation showed that generating SQL would duplicate `0036`; no new migration is intended. |
| Production browser/OOMOL | **NOT RUN** | Chrome MCP navigation was policy-blocked; local browser evidence is synthetic and has zero external requests. |
| Final security commit, main push, deployment | **PENDING** | Earlier local commits are listed above; parent owns the final security commit, main push, and release actions. |

The historical pre-Astra candidate recorded `3325 pass, 23 skip, 0 fail`
plus PDF 10 and artifact 11 checks. A later parallel candidate recorded
`3327 pass, 23 skip, 1 fail`; the one failure was the known fixture timing
race. These counts are historical checkpoints, not current approval.

## What changed

The candidate stabilizes arbitrary mutable transcript-row updates, streaming
animation identity, thread-history reconciliation, cross-run output matching,
and provider-safe MCP aliases. Legacy `mcp__` names remain valid. Hashed
aliases dispatch only from signed run context and current grants; policy
evaluation preserves the legacy `tool.name` identity. Unresolved aliases are
bounded in audit records and omit arguments.

## Known limitations and pending work

- Direct transcript projection fixes correctness but can scan/rebuild state on
  each render. Historical warm-switch performance passed 14/16 scenarios;
  p95 was 160.5 ms desktop and 576.1 ms mobile/4× CPU against 100 ms and
  400 ms targets. This is follow-up optimization, not a speed claim.
- The attachment check can time out because a 40 ms lease is created before
  an asynchronous blob write and expires before validation begins. This is a
  fixture timing race; no runtime change is planned. The parent must still
  complete the serial canonical gate.
- `TEST_DATABASE_URL` must point to a migrated disposable database for the
  test phase. No secrets, `.env` values, production database, or live OOMOL
  credentials were used.
- Full scanner claims are intentionally limited: CodeQL had no analysis database
  and Helm was unavailable; OSV covered dependency scanning with 15 existing
  filters, and no dependency changed. ESLint/Vitest are not the project runners;
  Biome/Bun are used. No new Go, API-schema, or dependency changes required their
  unrelated checks. No Trivy or CodeQL coverage is claimed.

## Rollback and operational state

The retained rollback image is `openbot-work:rollback-20260905-before-chat-reliability`
with digest
`sha256:4bdd339cedcb5323b1e910225d710de0782bf8e23b8a818d051e2a4b45821e3b`.
The current live target was healthy during the recorded checks. The
`scripts/deploy-production.sh` path drains `agent-codex` and
pairs replacement with `routine-worker` and may recreate the unchanged
agent-computer dependency; it was not invoked by this reviewer.

## Ownership and review method

Profile: `openbot`. Applied in bounded phases: using-agent-skills, planning,
debugging, TDD, Git workflow, CI/CD, shipping, and browser-testing guidance.
The TDD package's referenced `writing-good-tests.md` was unavailable.
Native `gpt-5.6-luna` Context Scout and independent documentation/micro-review
both executed; independent `gpt-6-astra` review found and then closed both
security findings. Serena supplied symbol context; GitHub supplied main/CI
evidence. There was no graph index to query.

Original main contained protected untracked `.serena/` and `tasks/`. The isolated
worktree also contained diagnostic changes to `scripts/runtime-performance.ts`,
`docs/chat-switch-performance-20260904.md`, local task notes and dependency
symlinks. Those baseline paths remain unchanged and excluded from the release;
scope guards validate this separately from the clean staged-source candidate.

## Parent completion record

The parent must append the current serial canonical-gate result here before
calling this candidate releasable. Until then, the correct state is
**pending**, with the final security commit, main push, and deployment still
unclaimed. The parent may add
only the missing Drizzle snapshot and its regression test for the CI metadata
repair; no SQL, journal, schema, or production-data change is intended.
