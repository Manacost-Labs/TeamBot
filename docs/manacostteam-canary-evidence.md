# ManacostTeam Task 33 — isolated canary evidence

**Status:** template only. No canary has been run and no public traffic was changed.

This record is filled only after Task 32 has passed and a separate deployment approval names the
isolated canary target. Keep it safe to commit: never write credentials, full Telegram subjects,
OAuth codes, prompts, responses, document contents, attachment names or production URLs that are
not already public. Use approved opaque correlation IDs and bounded image/commit labels only.

## Approval and immutable release

| Field | Value |
| --- | --- |
| Task 32 evidence reference | `[pending]` |
| Task 33 deployment approval reference | `[pending]` |
| Operator | `[pending]` |
| UTC start/end | `[pending]` |
| Source commit SHA | `[pending]` |
| Server/agent/editor image labels | `[pending]` |
| Isolated Compose project/listener label | `[pending]` |
| Copied database label | `[pending]` |
| Public origin changed | `NO — must remain unchanged` |
| Live volumes mounted | `[pending: NO/PASS]` |

## Gate 0 — target and rollback

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Task 32 evidence reviewed | evidence reference and reviewer label | `[PASS/FAIL]` |
| Canary listener/hostname is isolated | target class and bounded listener label | `[PASS/FAIL]` |
| Public route still serves the previous release | bounded status and release label | `[PASS/FAIL]` |
| Canary has no production writer or live volume | configuration check ID | `[PASS/FAIL]` |
| Previous server/agent/editor images start in rollback mode | rollback check ID | `[PASS/FAIL]` |
| Secrets are supplied only through protected runtime configuration | secret-presence check, no values | `[PASS/FAIL]` |

**Stop condition:** any target collision, live-volume mount, public-route change, missing rollback
image or failed health check stops the canary before user scenarios begin.

## Gate 1 — owner and editor scenarios

Record only a bounded scenario ID, pass/fail, latency and a short safe reason. Do not record account
names, Telegram payloads, prompts, responses or file contents.

| Scenario | Correlation ID | Result | Latency | Safe note |
| --- | --- | --- | ---: | --- |
| Owner Telegram login and session | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Owner sees only own channels/history/results | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Editor Telegram login in a separate session | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Editor cannot read owner-only channel/artifact/grant/credential | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Logout removes the active session | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Allowlist removal invalidates the affected session | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |

## Gate 2 — integrations and artifact contracts

| Scenario | Correlation ID | Result | Latency | Secret-free observation |
| --- | --- | --- | ---: | --- |
| Owner harmless ChatGPT/Codex run | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Owner harmless OpenRouter run | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Editor permitted run uses its own actor | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Google Docs/Drive read uses owner grant | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| One approved Google write uses exact grant and policy | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Handoff creates one expected logical run | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Main Analyst ends only with verified Markdown artifact | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| YouTube Analyst ends only with verified Markdown artifact | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Progress text does not become “Ответ готов” | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |
| Disconnect retires local access and reports vendor result | `[ ]` | `[PASS/FAIL]` | `[ ] ms` | `[ ]` |

**Stop condition:** any cross-user read, credential fallback, secret match, wrong redirect, false
completion, missing artifact or ambiguous external write stops the canary and triggers rollback.

## Gate 3 — observation and rollback

| Check | Evidence (safe summary only) | Result |
| --- | --- | --- |
| Health and all canary containers remain healthy | bounded status/count | `[PASS/FAIL]` |
| Runtime p50/p95 stays within the recorded baseline | metric label and bounded values | `[PASS/FAIL]` |
| Audit attribution names actor/Bot without private content | audit check ID | `[PASS/FAIL]` |
| Routine worker drains and resumes without duplicate firing | run count and check ID | `[PASS/FAIL]` |
| Rollback was demonstrated on the isolated target | rollback check ID | `[PASS/FAIL]` |
| Public origin and production data remain unchanged | bounded configuration check | `[PASS/FAIL]` |

## Sign-off

| Role | Opaque operator/reviewer ID | Result | UTC |
| --- | --- | --- | --- |
| Operator | `[ ]` | `[PASS/FAIL]` | `[ ]` |
| Owner | `[ ]` | `[PASS/FAIL]` | `[ ]` |
| Editor | `[ ]` | `[PASS/FAIL]` | `[ ]` |

Task 33 is complete only when every gate passes, rollback is demonstrated and a separate Task 34
approval is recorded. This template does not authorize public cutover.
