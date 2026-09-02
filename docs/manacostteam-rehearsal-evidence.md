# ManacostTeam Task 32 — rehearsal evidence

**Status:** completed on an isolated copied-production target; public traffic was not changed.

This file is completed only during an explicitly approved rehearsal on an isolated database copy.
It is not a deployment log and it must never contain credentials, full Telegram subjects, database
URLs, prompts, responses, document contents or attachment names.

## Approval and immutable release

| Field | Value |
| --- | --- |
| Task 32 approval reference | explicit owner approval in task message |
| Operator | `task32-automated-rehearsal` |
| UTC start/end | `2026-09-02 09:10Z — 09:49Z` |
| Source commit SHA | `8c5909f` |
| Server/agent/editor image IDs | server `openbot-work:local` (`sha256:4367f1d`); rollback server `openbot-work:rollback-a4466eb` (`sha256:b73663f`); agent/editor writers were not attached to the target |
| Isolated Compose project | `mct32` Docker target (`manacostteam.task=32`) |
| Copied database label | `mct32-pg-20260902t091129z` |
| Production writer connection disabled | `PASS — target used only its internal PostgreSQL alias; no production writer or live volume was mounted` |
| Public origin changed | `NO — must remain unchanged` |

Record only opaque internal correlation IDs or short image digests approved for operations. Keep
the full values in the private change record, not in this repository.

## Gate 0 — backup and restore

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Backup completed before binding | fresh custom dump, `2026-09-02 09:21Z`, 439099 bytes | `PASS` |
| Restore completed into isolated database | `mct32-pg-20260902t091129z`; 28/28 safe counts matched | `PASS` |
| Restored schema is readable by the previous release | current server health 200 and owner channel/results/attachment reads | `PASS` |
| No production writer or live volume is mounted | internal network, no published port, four `mct32-*` data volumes only | `PASS` |
| Rollback images/configuration are startable in isolation | rollback server health 200 and channel read | `PASS` |

**Stop condition:** any failed backup, restore, writer-isolation or rollback check stops the
rehearsal. Do not continue to owner binding.

## Gate 1 — owner binding on the copy

The operator runs the existing binding command in dry-run mode first, then applies it only after the
dry-run is a safe match. The subject is entered interactively and is never written into this file.

| Check | Evidence (counts/approved IDs only) | Result |
| --- | --- | --- |
| Dry-run targets the retained internal owner | existing owner row; subject omitted | `PASS` |
| Dry-run confirms the protected owner/allowlist relationship | protected configuration accepted; no subject recorded | `PASS` |
| Apply creates or confirms exactly one binding | already-correct binding; one Telegram owner account and one admin role | `PASS` |
| Repeated apply is idempotent | second apply returned the same no-op result; delta 0 | `PASS` |
| Previous release reads the copy after binding | rollback image health 200; owner channel read succeeded | `PASS` |

### Safe resource counts

Record counts before and after. A count change is allowed only when the binding operation explicitly
requires it and the reason is written without customer data.

| Resource | Before | After | Delta | Expected |
| --- | ---: | ---: | ---: | --- |
| Users | `1` | `1` | `0` | `0` |
| Channels | `21` | `21` | `0` | `0` |
| Artifacts | `7` | `7` | `0` | `0` |
| Attachments | `7` | `7` | `0` | `0` |
| Routines | `2` | `2` | `0` | `0` |
| Google connections | `0` | `0` | `0` | `0` |
| Google grants | `115` | `115` | `0` | `0` |
| Personal AI connections | `1` | `1` | `0` | `0` |
| Audit rows | `3971` | `3971` | `0` | `0` |
| External history page (messages) | `2` | `2` | `0` | `0` |

**Stop condition:** an unexpected owner ID change, resource delta, duplicate account/session or
failed previous-release read stops the rehearsal and triggers isolated rollback.

The source snapshot contained 3969 audit rows. The server boot used for the binding baseline wrote
two bounded boot events, so that baseline was 3971; the binding itself produced no additional rows.
Later isolated rollback/history boots were outside the before/after binding pair and were discarded
with the target. The external history check returned only `count=2, hasOlder=false` for the owner and
`count=0` for the editor; no message text was stored in this repository.

## Rollback evidence

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Isolated writers stopped before rollback | current rehearsal container removed before rollback image | `PASS` |
| Snapshot/copy restored or environment discarded | fresh dump restored; target discarded after checks | `PASS` |
| Previous release reads the restored copy | `openbot-work:rollback-a4466eb`, health 200, channel read | `PASS` |
| Public origin and live volumes remained unchanged | production Compose remained 10/10 healthy; target had no public port | `PASS` |

## Sign-off

| Role | Name/opaque operator ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `task32-automated-rehearsal` | `PASS` | `2026-09-02` |
| Owner | `explicit Task 32 approval` | `PASS` | `2026-09-02` |

Task 32 is complete only when every Gate 0 and Gate 1 check passes, rollback is demonstrated on the
copy, and the completed evidence has been reviewed. This record authorizes no public cutover and
does not authorize Task 33 or Task 34.
