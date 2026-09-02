# ManacostTeam Task 32 — rehearsal evidence

**Status:** template only. No production or copied-production data is recorded here yet.

This file is completed only during an explicitly approved rehearsal on an isolated database copy.
It is not a deployment log and it must never contain credentials, full Telegram subjects, database
URLs, prompts, responses, document contents or attachment names.

## Approval and immutable release

| Field | Value |
| --- | --- |
| Task 32 approval reference | `[pending]` |
| Operator | `[pending]` |
| UTC start/end | `[pending]` |
| Source commit SHA | `[pending]` |
| Server/agent/editor image IDs | `[pending]` |
| Isolated Compose project | `[pending]` |
| Copied database label | `[pending]` |
| Production writer connection disabled | `[pending: PASS/FAIL]` |
| Public origin changed | `NO — must remain unchanged` |

Record only opaque internal correlation IDs or short image digests approved for operations. Keep
the full values in the private change record, not in this repository.

## Gate 0 — backup and restore

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Backup completed before binding | backup label and timestamp only | `[PASS/FAIL]` |
| Restore completed into isolated database | copy label and timestamp only | `[PASS/FAIL]` |
| Restored schema is readable by the previous release | release/image label only | `[PASS/FAIL]` |
| No production writer or live volume is mounted | bounded configuration check | `[PASS/FAIL]` |
| Rollback images/configuration are startable in isolation | check ID only | `[PASS/FAIL]` |

**Stop condition:** any failed backup, restore, writer-isolation or rollback check stops the
rehearsal. Do not continue to owner binding.

## Gate 1 — owner binding on the copy

The operator runs the existing binding command in dry-run mode first, then applies it only after the
dry-run is a safe match. The subject is entered interactively and is never written into this file.

| Check | Evidence (counts/approved IDs only) | Result |
| --- | --- | --- |
| Dry-run targets the retained internal owner | opaque user ID and bounded reason | `[PASS/FAIL]` |
| Dry-run confirms the protected owner/allowlist relationship | set sizes and reason code | `[PASS/FAIL]` |
| Apply creates or confirms exactly one binding | binding result code, no subject | `[PASS/FAIL]` |
| Repeated apply is idempotent | second result code and delta count | `[PASS/FAIL]` |
| Previous release reads the copy after binding | release/image label and smoke ID | `[PASS/FAIL]` |

### Safe resource counts

Record counts before and after. A count change is allowed only when the binding operation explicitly
requires it and the reason is written without customer data.

| Resource | Before | After | Delta | Expected |
| --- | ---: | ---: | ---: | --- |
| Users | `[ ]` | `[ ]` | `[ ]` | `[0 or approved]` |
| Channels | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Artifacts | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Attachments | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Routines | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Google connections | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Google grants | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Personal AI connections | `[ ]` | `[ ]` | `[ ]` | `[0]` |
| Audit rows | `[ ]` | `[ ]` | `[ ]` | `[approved binding delta]` |

**Stop condition:** an unexpected owner ID change, resource delta, duplicate account/session or
failed previous-release read stops the rehearsal and triggers isolated rollback.

## Rollback evidence

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Isolated writers stopped before rollback | stop operation ID | `[PASS/FAIL]` |
| Snapshot/copy restored or environment discarded | copy label and timestamp | `[PASS/FAIL]` |
| Previous release reads the restored copy | smoke ID | `[PASS/FAIL]` |
| Public origin and live volumes remained unchanged | bounded configuration check | `[PASS/FAIL]` |

## Sign-off

| Role | Name/opaque operator ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `[ ]` | `[PASS/FAIL]` | `[ ]` |
| Owner | `[ ]` | `[PASS/FAIL]` | `[ ]` |

Task 32 is complete only when every Gate 0 and Gate 1 check passes, rollback is demonstrated on the
copy, and the completed evidence has been reviewed. This template does not authorize Task 32,
Task 33 or Task 34.
