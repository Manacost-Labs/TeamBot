# ManacostTeam Task 34 — public cutover evidence

**Status:** the public runtime was redeployed on 2026-09-02 after explicit owner approval. The
Cloudflare/DNS target was not changed in this window, so this is a production runtime deployment,
not a completed public cutover or full integration sign-off.

The loopback canary evidence remains partial at its integration gate. This record therefore separates
the checks that passed during the runtime deployment from the owner/editor, Google and artifact
scenarios that still require a later approved observation window. It contains no credentials, full
Telegram subjects, OAuth codes, prompts, responses, document contents or private infrastructure
values.

## Approval and release set

| Field | Value |
| --- | --- |
| Task 33 evidence reference | [`manacostteam-canary-evidence.md`](manacostteam-canary-evidence.md) — partial, infrastructure and owner gates passed |
| Task 34 public-cutover approval reference | explicit owner approval in task message (`выкладывай на прод`) |
| Operator | `task34-public-runtime-deploy` |
| UTC window start/end | `2026-09-02 13:02Z — 13:05Z` (bounded operator window) |
| Verified ManacostTeam commit/image labels | source `91f6811`; `openbot` `sha256:7bddb476540`; `agent-codex` `sha256:2c81455ebc1` |
| Complete rollback set label | `rollback-a4466eb` images retained |
| Public target | `work.kolodahearthstone.com` |
| Previous public route label | Cloudflare/DNS target unchanged; origin fallback remained available |

## Gate 0 — preflight

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Task 33 evidence reviewed and signed | partial evidence reviewed; integration gate was explicitly accepted as a known risk for this runtime deployment | `WARN — not a canary sign-off` |
| Managed runs drained and new routine starts paused | drain-aware helper completed; routine worker was stopped during replacement and resumed healthy | `PASS` |
| Backup/rollback set is restorable | private custom-format dump was non-empty (`345069` bytes); catalog check passed in the runtime image; rollback image set retained | `PASS` |
| Exact Google redirect URI is recorded and approved | no Google redirect or OAuth registration was changed in this window | `PENDING` |
| Previous proxy/DNS/edge-auth target is captured | public and origin fallback returned 200; Cloudflare/DNS route was not modified | `PASS` |
| New release health is green before switch | 10 runtime containers healthy; public and edge health returned 200 | `PASS` |

**Scope note:** this approval authorized the runtime deployment. It did not waive the remaining
owner/editor, Google, artifact or working-period checks required to call Task 34 fully complete.

## Gate 1 — switch verification

| Check | Correlation ID / safe evidence | Result |
| --- | --- | --- |
| Public proxy/DNS points to the verified release | `t34-route-01` — public root is ManacostTeam; route target was unchanged | `PASS — runtime only` |
| Owner Telegram login works after the switch | `t34-owner-login-01` — Telegram start returned 303; direct callback was not replayed after restart | `PENDING` |
| Editor login and permitted run work after the switch | `t34-editor-login-01` | `BLOCKED — no editor subject configured` |
| Negative owner/editor isolation remains enforced | `t34-isolation-01` | `PENDING — editor scenario unavailable` |
| Google OAuth callback matches the approved exact URI | `t34-google-callback-01` | `PENDING — no Google grant or redirect change` |
| `OPENBOT_SINGLE_USER` is absent from live runtime | bounded container config check returned `false` | `PASS` |
| Nginx `auth_request` and live `edge-auth` dependency are absent | no proxy/DNS change was made; edge-auth remains a rollback target | `PENDING` |
| Global host Codex auth mount is absent | bounded mount check found no `auth.json`/`.codex` mount | `PASS` |
| Logout, disconnect and revoke still work | not replayed in the post-deploy public session | `PENDING` |

## Gate 2 — working-period observation

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Health and all runtime containers remain healthy | 10/10 containers healthy; public, edge and internal health checks returned 200 | `PASS` |
| p50/p95 runtime timing remains within the canary envelope | no model timing was collected; deployment health only | `PENDING` |
| No cross-user or secret-leak alert fired | bounded recent logs contained zero fatal/panic/unhandled/run-error lines; full observation not complete | `PENDING` |
| Handoff, research and YouTube artifact paths remain healthy | no post-deploy artifact run was dispatched | `PENDING` |
| Routine worker resumes without duplicate or lost runs | worker is healthy; no duplicate-fire workload was dispatched | `PENDING` |
| One ordinary working period completed | observation window not complete | `PENDING` |

## Rollback record

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Previous public route restored if rollback was required | no rollback required; route target unchanged | `N/A` |
| Old release passed health and login smoke | isolated rollback rehearsal in Task 33 evidence | `PASS` |
| Additive rows/data were preserved | no migration or destructive data operation performed | `PASS` |
| New target was drained without deleting production data | drain-aware helper; production volumes retained | `PASS` |

## Sign-off

| Role | Opaque operator/reviewer ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `task34-public-runtime-deploy` | `PASS — deployment and health gates` | `2026-09-02` |
| Owner | `explicit production approval` | `PENDING — integration observation incomplete` | `2026-09-02` |

Task 34 is **not complete**: runtime deployment passed, but the public route was not switched and
the owner/editor, Google, artifact and working-period checks remain open. Keep the recorded rollback
set and backup until those checks pass or a documented rollback is approved.
