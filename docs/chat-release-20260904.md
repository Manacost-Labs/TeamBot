# Chat reliability release evidence — 2026-09-04

**Status: pending clean-runner CI and release-owner verification.** This record is
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
| Full canonical gate | **PENDING CI** | Clean staged-source format, lint and types passed. Final serial testing on the shared host hit load-sensitive baseline failures; unchanged checks will run on clean GitHub runners before integration. |
| Migration metadata | **PASS** | Added only the missing `0036_snapshot.json` for existing SQL. Regression RED (missing file) → GREEN (38 assertions). Drizzle check passed; generation reported no schema changes; all migration-file hashes stayed identical. No SQL, journal or runtime schema change. |
| Production browser/OOMOL | **NOT RUN** | Chrome MCP navigation was policy-blocked; local browser evidence is synthetic and has zero external requests. |
| Final security commit, main push, deployment | **PENDING** | Earlier local commits are listed above; parent owns the final security commit, main push, and release actions. |

The historical pre-Astra candidate recorded `3325 pass, 23 skip, 0 fail`
plus PDF 10 and artifact 11 checks. A later parallel candidate recorded
`3327 pass, 23 skip, 1 fail`; the one failure was the known fixture timing
race. The final serial local run recorded `3325 pass, 23 skip, 4 fail, 1 error`
while host load reached 37.72 on 16 CPUs: attachment timing, stream-pull
scheduling, and settings timeouts. These counts are historical checkpoints,
not current approval. Test assertions and timeouts were not relaxed.

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
  fixture timing race; no runtime change is planned. The focused serial
  attachment suite passed 12/12; full clean-runner verification remains required.
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

The security fix is committed as `64e2838`; Astra and Luna reviews closed all
Critical/Required code findings. Astra also verified the generated snapshot
matches the existing SQL exactly. Recovery/verification entrypoint tests passed
17/17. The release owner must verify clean-runner CI before integrating into
main and deploying. No main push or deployment is claimed in this pre-release
record; actual release outcomes belong to the subsequent handoff.
