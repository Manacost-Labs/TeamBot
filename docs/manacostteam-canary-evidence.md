# ManacostTeam Task 33 — isolated canary evidence

**Status:** partially executed on an isolated loopback target on 2026-09-02. Infrastructure and
owner-authentication gates passed; public traffic and production data were not changed. Gate 2 is
paused because the canary has no separate Intelligence project, no second allowlisted editor, and
no copied Google/OpenRouter connections. This is not a public-cutover approval.

This record contains only bounded operational evidence. It never contains credentials, full Telegram
subjects, OAuth codes, prompts, responses, document contents, attachment names or production URLs.

## Approval and immutable release

| Field | Value |
| --- | --- |
| Task 32 evidence reference | [`manacostteam-rehearsal-evidence.md`](manacostteam-rehearsal-evidence.md) — passed on the copied target |
| Task 33 deployment approval reference | explicit owner approval in task message (`разрешаю`) |
| Operator | `task33-loopback-canary` |
| UTC start/end | `2026-09-02 11:52Z — 12:27Z` (bounded operator window) |
| Source commit SHA | `8c5909f` (runtime release; later worktree commits are documentation-only) |
| Server/agent/editor image labels | server `openbot-work:local` (`sha256:4367f1d`); rollback set `rollback-a4466eb` |
| Isolated Compose project/listener label | `mct33-20260902`; HTTP `127.0.0.1:3121`; temporary TLS loopback `127.0.0.1:3443` |
| Copied database label | `mct33-20260902-canary-postgres-1` |
| Public origin changed | `NO — public and edge-auth health remained 200` |
| Live volumes mounted | `PASS — no production-prefixed volume was mounted` |

The canary target used independent database, attachment, workspace, profile and research-run
volumes. It was never added to DNS or the public proxy. The TLS listener was bound to loopback only.

## Gate 0 — target and rollback

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Task 32 evidence reviewed | copied-production restore and owner-binding evidence above | `PASS` |
| Canary listener/hostname is isolated | `mct33-20260902`; loopback-only HTTP/TLS listeners | `PASS` |
| Public route still serves the previous release | public `127.0.0.1:3021/health=200`; edge-auth `127.0.0.1:3030/health=200`; 10 runtime containers | `PASS` |
| Canary has no production writer or live volume | 10 canary containers; separate networks; `live_volumes=none` | `PASS` |
| Previous server/agent/editor images start in rollback mode | separate `rollback-a4466eb` target: old services healthy and `/health=200` | `PASS` |
| Secrets are supplied only through protected runtime configuration | runtime presence checks passed; no secret values were emitted | `PASS` |

The previous image requires its legacy-compatible single-user/OAuth boot configuration when used as
a rollback target. Telegram-only settings are not sufficient for that old image; this was observed
and corrected only in the isolated rollback target.

## Gate 1 — owner and editor scenarios

Only the owner scenario could be exercised because the protected canary allowlist contains no second
editor subject. No editor ID was invented or added to production.

| Scenario | Correlation ID | Result | Latency | Safe note |
| --- | --- | --- | ---: | --- |
| Owner Telegram login and session | `t33-owner-auth-01` | `PASS` | not timed | state, browser binding, callback, session and `/api/me` all succeeded; role was admin |
| Owner sees only own channels/history/results | `t33-owner-scope-01` | `PASS` | not timed | channels, results, routines, agents, audit and thread-mint routes returned 200; no content recorded |
| Editor Telegram login in a separate session | `t33-editor-auth-01` | `BLOCKED` | — | no separate allowlisted editor subject is configured in the canary |
| Editor cannot read owner-only channel/artifact/grant/credential | `t33-editor-isolation-01` | `BLOCKED` | — | requires the separate editor session first |
| Logout removes the active session | `t33-owner-logout-01` | `PASS` | not timed | sign-out returned 200 and the same cookie received `/api/me=401` afterwards |
| Allowlist removal invalidates the affected session | `t33-allowlist-revoke-01` | `BLOCKED` | — | deferred until an editor subject exists; owner lockout was not attempted |

The canary session table was empty after the final owner smoke (`sessions=0`); the copied production
session rows were not retained as active canary sessions.

## Gate 2 — integrations and artifact contracts

| Scenario | Correlation ID | Result | Latency | Secret-free observation |
| --- | --- | --- | ---: | --- |
| Research source: YouTube transcript retrieval | `t33-youtube-source-01` | `PASS` | not timed | internal source gateway returned 1 normalized result and 208 segments for the supplied test video; transcript text was not stored |
| Owner harmless ChatGPT/Codex run | `t33-owner-chatgpt-01` | `PASS` | 8.1 s to managed completion | authenticated AG-UI POST was accepted with HTTP 200; the isolated `agent-codex` runtime recorded a first text delta and `run_completed` for the fresh canary thread; no tools, files or response text were recorded |
| Owner harmless OpenRouter run | `t33-owner-openrouter-01` | `BLOCKED` | — | no active OpenRouter connection exists in the copied target |
| Editor permitted run uses its own actor | `t33-editor-run-01` | `BLOCKED` | — | no editor session or personal connection exists in the copied target |
| Google Docs/Drive read uses owner grant | `t33-google-read-01` | `BLOCKED` | — | copied target has zero Google connections; no grant was fabricated |
| One approved Google write uses exact grant and policy | `t33-google-write-01` | `BLOCKED` | — | same missing owner Google connection |
| Handoff creates one expected logical run | `t33-handoff-01` | `BLOCKED` | — | depends on an editor and a working isolated model runtime |
| Main Analyst ends only with verified Markdown artifact | `t33-main-analyst-artifact-01` | `BLOCKED` | — | no model run was allowed to target shared production Intelligence history |
| YouTube Analyst ends only with verified Markdown artifact | `t33-youtube-artifact-01` | `BLOCKED` | — | transcript source passed, but the full agent/artifact run was not executed without isolated Intelligence |
| Progress text does not become “Ответ готов” | `t33-progress-contract-01` | `PENDING` | — | requires a completed model/artifact run; no false completion is claimed |
| Disconnect retires local access and reports vendor result | `t33-disconnect-01` | `PENDING` | — | not run so the copied active owner connection remains available for a later approved canary |

The authenticated runtime-info endpoint returned six registered agents. The provider status endpoint
returned one active ChatGPT connection for the owner. The direct smoke confirmed the managed Codex
completion, but it did not exercise the browser realtime observer or any artifact-producing agent.

**Stop condition reached:** missing artifact scenarios, missing editor/integration credentials and the
absence of a separate Intelligence namespace stop the canary before handoff, Google writes,
disconnect or public traffic.

## Gate 3 — observation and rollback

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Health and all canary containers remain healthy | 9 containers reported healthy; routine worker running with its inherited health probe disabled; canary `/health=200` | `PASS` |
| Runtime p50/p95 stays within the recorded baseline | loopback TLS health only: p50 `44.7 ms`, p95 `48.7 ms`; this is infrastructure timing, not a model/chat run | `PENDING` |
| Audit attribution names actor/Bot without private content | authenticated audit endpoint returned 200; event payload attribution was not inspected | `PENDING` |
| Routine worker drains and resumes without duplicate firing | worker remained running; no duplicate-fire workload was dispatched | `PENDING` |
| Rollback was demonstrated on the isolated target | old image set started in a separate project and returned `/health=200`; target was then discarded | `PASS` |
| Public origin and production data remain unchanged | public/edge health stayed 200; no production volume or writer was attached | `PASS` |

For comparison, public HTTP health timing during the same window was p50 `0.3 ms`, p95 `0.5 ms`.
Neither timing pair is a release-performance result for model or artifact execution.

## Sign-off

| Role | Opaque operator/reviewer ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `task33-loopback-canary` | `PASS — infrastructure gates only` | `2026-09-02` |
| Owner | `explicit Task 33 approval` | `PENDING — scenario gates incomplete` | `2026-09-02` |
| Editor | `not configured in canary` | `BLOCKED` | `2026-09-02` |

### Unlocks for the remaining canary work

1. Provision a separate Intelligence project/API configuration for the canary, or explicitly approve
   a different isolated backend. Existing production thread IDs must not be used for a test run.
2. Add the editor's Telegram subject to the protected canary allowlist (without committing it), then
   repeat the positive editor and negative owner-isolation scenarios.
3. Establish the intended owner OpenRouter and Google grants in the canary through their normal UI
   flows, without copying secrets into files or chat.
4. Repeat the harmless provider, handoff, Google, Main Analyst, YouTube artifact, progress-status,
   disconnect and revoke checks. Only then can Task 33 be marked complete and Task 34 considered.

Task 33 is **not complete**: the public origin remains unchanged and no public-cutover approval is
implied by this evidence.
