# ManacostTeam Task 34 — public cutover evidence

**Status:** template only. Public traffic and DNS have not been changed by this record.

Fill this file only after the isolated canary and its rollback have passed and a separate written
approval names the cutover window. Keep the committed record free of credentials, full Telegram
subjects, OAuth codes, prompts, responses, document contents and private infrastructure values.

## Approval and release set

| Field | Value |
| --- | --- |
| Task 33 evidence reference | `[pending]` |
| Task 34 public-cutover approval reference | `[pending]` |
| Operator | `[pending]` |
| UTC window start/end | `[pending]` |
| Verified ManacostTeam commit/image labels | `[pending]` |
| Complete rollback set label | `[pending]` |
| Public target | `work.kolodahearthstone.com` |
| Previous public route label | `[pending]` |

## Gate 0 — preflight

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Task 33 evidence reviewed and signed | evidence/reference label | `[PASS/FAIL]` |
| Managed runs drained and new routine starts paused | drain check ID | `[PASS/FAIL]` |
| Backup/rollback set is restorable | backup and check labels | `[PASS/FAIL]` |
| Exact Google redirect URI is recorded and approved | URI fingerprint, not the full secret/config | `[PASS/FAIL]` |
| Previous proxy/DNS/edge-auth target is captured | bounded route label | `[PASS/FAIL]` |
| New release health is green before switch | status/count | `[PASS/FAIL]` |

**Stop condition:** missing approval, incomplete drain, unavailable rollback, wrong redirect or
unhealthy release stops the window before proxy/DNS changes.

## Gate 1 — switch verification

| Check | Correlation ID / safe evidence | Result |
| --- | --- | --- |
| Public proxy/DNS points to the verified release | `[ ]` | `[PASS/FAIL]` |
| Owner Telegram login works after the switch | `[ ]` | `[PASS/FAIL]` |
| Editor login and permitted run work after the switch | `[ ]` | `[PASS/FAIL]` |
| Negative owner/editor isolation remains enforced | `[ ]` | `[PASS/FAIL]` |
| Google OAuth callback matches the approved exact URI | `[ ]` | `[PASS/FAIL]` |
| `OPENBOT_SINGLE_USER` is absent from live runtime | bounded config check | `[PASS/FAIL]` |
| Nginx `auth_request` and live `edge-auth` dependency are absent | bounded config check | `[PASS/FAIL]` |
| Global host Codex auth mount is absent | bounded mount check | `[PASS/FAIL]` |
| Logout, disconnect and revoke still work | `[ ]` | `[PASS/FAIL]` |

## Gate 2 — working-period observation

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Health and all runtime containers remain healthy | bounded status/count | `[PASS/FAIL]` |
| p50/p95 runtime timing remains within the canary envelope | metric label and bounded values | `[PASS/FAIL]` |
| No cross-user or secret-leak alert fired | alert/check ID | `[PASS/FAIL]` |
| Handoff, research and YouTube artifact paths remain healthy | scenario count and IDs | `[PASS/FAIL]` |
| Routine worker resumes without duplicate or lost runs | run count and check ID | `[PASS/FAIL]` |
| One ordinary working period completed | start/end labels | `[PASS/FAIL]` |

## Rollback record

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Previous public route restored if rollback was required | route label and timestamp | `[PASS/FAIL/N/A]` |
| Old release passed health and login smoke | check ID | `[PASS/FAIL/N/A]` |
| Additive rows/data were preserved | bounded count check | `[PASS/FAIL/N/A]` |
| New target was drained without deleting production data | operation ID | `[PASS/FAIL/N/A]` |

## Sign-off

| Role | Opaque operator/reviewer ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `[ ]` | `[PASS/FAIL]` | `[ ]` |
| Owner | `[ ]` | `[PASS/FAIL]` | `[ ]` |

Task 34 is complete only after the switch checks and one working-period observation pass, or after
a documented rollback has restored the previous route and a new approval is issued.
