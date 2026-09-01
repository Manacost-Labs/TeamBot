# Task Breakdown: ManacostTeam authentication and personal AI connections

## Status

Approved by the owner on 2026-09-01. This breakdown implements the approved specification and
implementation plan. The approval authorises implementation tasks 1–31, but does not authorise
tasks 32–34 to touch copied production data, deploy a canary or change public traffic.

## Standing definition of done

Every implementation task is complete only when all of the following are true:

- its acceptance criteria are demonstrated at runtime, not only by typechecking;
- a new test fails without the change and passes with it;
- relevant existing tests, formatting and linting still pass;
- no secret, signed payload, prompt or auth document appears in logs, fixtures or browser output;
- the change is limited to the named task and its listed files, unless the living spec is updated;
- public behavior and operator actions introduced by the task are documented;
- authentication, data ownership and rollback implications have been reviewed.

Commands use `PATH=/home/debian/.bun/bin:$PATH` on this host.

## Phase 0 — Fail-fast runtime contracts

### Task 1: Isolated Codex runtime profile

**Description:** Introduce the reusable per-run runtime-profile abstraction and prove that every
Codex child receives its own temporary home rather than the host profile.

**Acceptance criteria:**

- [x] A run creates a mode-`0700` temporary `CODEX_HOME` and removes it after success, failure and cancellation.
- [x] The child environment is built from an allowlist and does not inherit the host `CODEX_HOME` or auth path.
- [x] Existing research, YouTube and control-agent workspace selection remains unchanged.

**Verification:**

- [x] `bun test agent-codex/tests/runtime-profile.test.ts agent-codex/tests/codex-run.test.ts`
- [x] A spawned fixture process sees only its task-owned home and the directory is gone after exit.

**Dependencies:** None.

**Files likely touched:**

- `agent-codex/src/runtime-profile.ts`
- `agent-codex/src/codex-run.ts`
- `agent-codex/tests/runtime-profile.test.ts`
- `agent-codex/tests/codex-run.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 2: OpenRouter Codex provider contract

**Description:** Prove the installed Codex CLI accepts the fixed OpenRouter Responses provider and
that the provider key cannot enter a shell/tool environment.

**Acceptance criteria:**

- [x] Generated configuration fixes `base_url`, `wire_api` and the environment-key name server-side.
- [x] Client input cannot replace the OpenRouter origin or inject extra Codex configuration.
- [x] A fixture shell launched by Codex receives no OpenRouter key while the provider adapter can read it.

**Verification:**

- [x] `bun test agent-codex/tests/runtime-profile.test.ts agent-codex/tests/codex-run.test.ts`
- [x] A bounded installed-CLI probe reaches `initialize` with the generated profile and synthetic transport.

**Dependencies:** Task 1.

**Files likely touched:**

- `agent-codex/src/runtime-profile.ts`
- `agent-codex/tests/runtime-profile.test.ts`
- `agent-codex/tests/codex-run.test.ts`

**Estimated scope:** Medium, 3 files.

### Task 3: Better Auth Telegram session contract

**Description:** Add the smallest first-party Better Auth plugin endpoint needed to create the
repository's normal session and prove logout/revocation still use the same cookie and database rows.

**Acceptance criteria:**

- [x] The endpoint creates a Better Auth session without introducing a second cookie format.
- [x] Existing `createRequireUser`, sign-out and session deletion recognize the new session.
- [x] Better Auth is pinned to the tested 1.7.1 contract during this feature.

**Verification:**

- [x] `bun test server/tests/telegram-plugin.test.ts server/tests/health.test.ts`
- [x] Contract test confirms the session is rejected after its database row is removed.

**Dependencies:** None.

**Files likely touched:**

- `server/src/auth/telegram-plugin.ts`
- `server/src/auth/index.ts`
- `server/tests/telegram-plugin.test.ts`
- `server/package.json`
- `bun.lock`

**Estimated scope:** Medium, 5 files.

## Checkpoint A — Runtime feasibility

- [x] Tasks 1–3 tests pass together.
- [x] No proof requires the global host `auth.json`, a browser secret or a parallel session system.
- [x] Any unsupported Codex/Better Auth behavior is reflected in the specification before continuing.

## Phase 1 — Telegram login vertical slice

### Task 4: Fail-closed Telegram configuration

**Description:** Add typed Telegram mode, bot, allowlist and owner configuration while preserving
the current OAuth configuration for other deployments.

**Acceptance criteria:**

- [x] Telegram mode requires an HTTPS public URL, session secret, bot username/token and non-empty owner set.
- [x] Owner IDs must be a subset of canonical positive allowlist IDs; duplicates and malformed values fail boot.
- [x] `OPENBOT_SINGLE_USER` cannot become a fallback when Telegram mode is selected.

**Verification:**

- [x] `bun test server/tests/config.test.ts`
- [x] Table-driven tests cover every missing, malformed and conflicting configuration.

**Dependencies:** Task 3.

**Files likely touched:**

- `server/src/config.ts`
- `server/tests/config.test.ts`
- `.env.example`

**Estimated scope:** Medium, 3 files.

### Task 5: Telegram payload verification and one-time state

**Description:** Implement the pure cryptographic boundary for Telegram Login Widget callbacks and
the short-lived, one-time login state.

**Acceptance criteria:**

- [x] Official signature fixtures pass; modified, stale, future, missing and malformed payloads fail generically.
- [x] Hash comparison is constant-time and safe for unequal lengths.
- [x] Login state is origin/return-path bound, expires, and can be consumed exactly once.

**Verification:**

- [x] `bun test server/tests/telegram-login.test.ts`
- [x] Replay and open-redirect fixtures are refused without creating users or sessions.

**Dependencies:** Task 4.

**Files likely touched:**

- `server/src/auth/telegram-login.ts`
- `server/tests/telegram-login.test.ts`

**Estimated scope:** Small, 2 files.

### Task 6: Telegram account binding and role provisioning

**Description:** Complete the plugin with allowlist verification, immutable provider-account
binding and owner/editor role provisioning.

**Acceptance criteria:**

- [x] An allowlisted new subject creates one opaque user, one Telegram account and the configured role.
- [x] A returning subject resolves to the same user; a browser cannot select or rebind a user ID.
- [x] Unknown, revoked or removed IDs create neither user nor session and produce only safe audit metadata.

**Verification:**

- [x] `bun test server/tests/telegram-plugin.test.ts server/tests/guards.test.ts`
- [x] Database integration test proves account subject uniqueness under two concurrent callbacks.

**Dependencies:** Tasks 4–5.

**Files likely touched:**

- `server/src/auth/telegram-plugin.ts`
- `server/src/auth/index.ts`
- `server/src/auth/roles.ts`
- `server/tests/telegram-plugin.test.ts`

**Estimated scope:** Medium, 4 files.

## Checkpoint B — Server-side Telegram authentication

- [x] Tasks 4–6 pass with no browser code.
- [x] Owner/editor/unknown/replay cases leave the expected users, roles, sessions and audit events.
- [x] Existing Google, Microsoft, Okta and SSO tests remain green.

### Task 7: Telegram sign-in screen

**Description:** Replace the ManacostTeam sign-in choice with the official Telegram widget when
Telegram mode is configured, without exposing secret configuration.

**Acceptance criteria:**

- [x] `/api/capabilities` returns only the public bot username and Telegram-enabled flag.
- [x] The sign screen loads the widget with the server-minted state and handles generic callback failures in Russian.
- [x] OAuth/SSO buttons remain unchanged for non-ManacostTeam deployments.

**Verification:**

- [x] `bun test app/src/lib/auth app/src/routes/sign.test.tsx server/tests/health.test.ts`
- [x] Browser component test renders no bot token, internal origin or arbitrary redirect.

**Dependencies:** Task 6.

**Files likely touched:**

- `server/src/app.ts`
- `app/src/lib/auth/queries.ts`
- `app/src/routes/sign.tsx`
- `app/src/routes/sign.test.tsx`

**Estimated scope:** Medium, 4 files.

### Task 8: Idempotent owner-binding operator command

**Description:** Add the protected one-time operation that attaches the configured owner Telegram
subject to the existing `dev-local-user` row without rewriting its identity.

**Acceptance criteria:**

- [x] The command is dry-run by default and accepts the numeric ID without putting it in shell history.
- [x] Apply mode refuses an already-bound subject, a missing legacy owner or a conflicting target.
- [x] Re-running after success is harmless and history-owning IDs remain unchanged.

**Verification:**

- [x] `bun test server/tests/telegram-owner-binding.test.ts`
- [x] Integration fixture verifies channels/memberships still point to `dev-local-user` after binding.

**Dependencies:** Task 6.

**Files likely touched:**

- `server/src/auth/telegram-owner-binding.ts`
- `server/tests/telegram-owner-binding.test.ts`
- `scripts/bind-telegram-owner.ts`
- `package.json`

**Estimated scope:** Medium, 4 files.

### Task 9: Allowlist reconciliation and session revocation

**Description:** Reconcile configured Telegram access at boot so removing an ID ends its sessions
and prevents the next sign-in.

**Acceptance criteria:**

- [x] Removed subjects lose active sessions and cannot sign in again.
- [x] Explicit database revocation continues to win over configuration.
- [x] An empty/missing owner result fails before traffic is served.

**Verification:**

- [x] `bun test server/tests/telegram-access-reconciliation.test.ts server/tests/people-routes.test.ts`
- [x] Two-replica-style idempotency fixture produces one safe reconciliation result.

**Dependencies:** Tasks 6 and 8.

**Files likely touched:**

- `server/src/auth/telegram-access.ts`
- `server/src/index.ts`
- `server/src/people/store.ts`
- `server/tests/telegram-access-reconciliation.test.ts`

**Estimated scope:** Medium, 4 files.

## Checkpoint C — Complete Telegram slice

- [x] Tasks 7–9 pass with owner and editor browser/session fixtures.
- [x] Owner history remains under the original internal actor ID.
- [x] Logout, allowlist removal and explicit revocation all invalidate access.

## Phase 2 — Personal AI connection persistence and OpenRouter UI

### Task 10: Additive personal-AI schema

**Description:** Add the ownership, device-flow and one-time lease tables needed by both provider
paths without changing or deleting existing rows.

**Acceptance criteria:**

- [x] One user has at most one active connection and one provider per connection.
- [x] Connection/flow/lease rows reference users and encrypted credentials with safe delete behavior.
- [x] Lease run IDs are unique and redemption/expiry fields support atomic one-time use.

**Verification:**

- [x] `bun x drizzle-kit check --config=server/drizzle.config.ts`
- [x] Migration applies twice safely in the repository's migration harness and old schema data remains readable.

**Dependencies:** Checkpoint A.

**Files likely touched:**

- `server/src/db/schema/core.ts`
- `server/src/db/schema/index.ts`
- `server/drizzle/0031_*_personal_ai.sql`
- `server/drizzle/meta/0031_snapshot.json`
- `server/drizzle/meta/_journal.json`

**Estimated scope:** Medium, 5 files including generated migration metadata.

### Task 11: Actor-owned AI connection store

**Description:** Implement atomic connect, rotate, disconnect and safe status projection on top of
the existing encrypted credential vault.

**Acceptance criteria:**

- [x] Every operation receives the authenticated actor ID; no caller supplies a target user or credential ID.
- [x] Replacement rotates the encrypted credential and connection pointer atomically.
- [x] Status projections contain provider/state/time and safe metadata, never ciphertext or plaintext.

**Verification:**

- [x] `bun test server/tests/ai-connection-store.test.ts server/tests/credentials.test.ts`
- [x] Transaction-failure fixtures leave the previous connection live and reveal no secret.

**Dependencies:** Task 10.

**Files likely touched:**

- `server/src/ai-connections/store.ts`
- `server/src/credentials.ts`
- `server/tests/ai-connection-store.test.ts`

**Estimated scope:** Medium, 3 files.

### Task 12: Fixed-origin OpenRouter key validation

**Description:** Validate OpenRouter keys with the current-key endpoint before persistence using a
bounded, injectable client.

**Acceptance criteria:**

- [x] Only `https://openrouter.ai/api/v1/key` can be contacted and redirects to another origin are refused.
- [x] Invalid/revoked/rate-limited/network failures return stable safe reason codes.
- [x] Successful projection keeps only explicitly allowlisted non-secret metadata.

**Verification:**

- [x] `bun test server/tests/openrouter-key-validator.test.ts`
- [x] Adversarial responses cannot inject headers, URLs, key suffixes or raw bodies into logs/status.

**Dependencies:** Task 11.

**Files likely touched:**

- `server/src/ai-connections/openrouter.ts`
- `server/tests/openrouter-key-validator.test.ts`

**Estimated scope:** Small, 2 files.

## Checkpoint D — Persistence foundation

- [x] Tasks 10–12 pass against PostgreSQL and controlled OpenRouter responses.
- [x] Secret scans of returned objects, errors and audit fixtures are empty.
- [x] Migration is additive and the old release can ignore the new tables.

### Task 13: Actor-scoped personal connection API

**Description:** Mount status, connect, replace and disconnect routes behind the existing user
session guard.

**Acceptance criteria:**

- [x] Routes derive ownership only from `context.var.actor.id` and reject unknown providers/fields.
- [x] OpenRouter plaintext is consumed once and never returned; disconnect is CSRF-protected by same-origin session controls.
- [x] A user cannot enumerate, address or mutate another user's connection.

**Verification:**

- [x] `bun test server/tests/ai-connection-routes.test.ts`
- [x] Negative actor-swap tests return 403/404 without revealing existence.

**Dependencies:** Tasks 11–12.

**Files likely touched:**

- `server/src/ai-connections/routes.ts`
- `server/src/app.ts`
- `server/src/index.ts`
- `server/tests/ai-connection-routes.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 14: OpenRouter Settings card

**Description:** Add the write-only key form and connection status to personal Settings.

**Acceptance criteria:**

- [x] The form never repopulates a saved key and clears input after submission/failure/unmount.
- [x] Connected, invalid, replacing and disconnected states are understandable in Russian.
- [x] No user-entered base URL/model/credential ID field exists in the first release.

**Verification:**

- [x] `bun test app/src/routes/_authed/settings/ai-connections.test.tsx`
- [x] Component test confirms query cache and rendered DOM never retain plaintext after mutation settles.

**Dependencies:** Task 13.

**Files likely touched:**

- `app/src/lib/ai-connections/queries.ts`
- `app/src/lib/ai-connections/mutations.ts`
- `app/src/routes/_authed/settings/index.tsx`
- `app/src/routes/_authed/settings/ai-connections.test.tsx`

**Estimated scope:** Medium, 4 files.

### Task 15: Personal connection ownership regression suite

**Description:** Add cross-user, revoke and race coverage before any runtime is allowed to consume
the credentials.

**Acceptance criteria:**

- [x] Two users may hold different providers/credentials without status or mutation crossover.
- [x] Concurrent replace/disconnect yields exactly one active-or-none outcome, never two live credentials.
- [x] Revoking a person retires their personal AI connection without affecting another user.

**Verification:**

- [x] `bun test server/tests/ai-connections.integration.test.ts server/tests/credentials.test.ts`

**Dependencies:** Tasks 13–14.

**Files likely touched:**

- `server/tests/ai-connections.integration.test.ts`
- `server/tests/credentials.test.ts`

**Estimated scope:** Small, 2 files.

## Checkpoint E — OpenRouter connection UI

- [x] Tasks 13–15 pass end-to-end with controlled HTTP and PostgreSQL fixtures.
- [x] Browser and API responses contain no plaintext key.
- [x] No runtime has access yet; persistence/UI can be reviewed independently.

## Phase 3 — One-time runtime delivery and OpenRouter execution

### Task 16: One-time credential lease service

**Description:** Mint and atomically redeem short-lived run leases bound to actor, bot, run and
credential without putting the secret in AG-UI input.

**Acceptance criteria:**

- [x] Minting requires an active connection and records only identifiers/expiry.
- [x] Redemption verifies the managed caller and signed run, rechecks live ownership, then succeeds once.
- [x] Expired, replayed, disconnected, actor-swapped and bot-swapped leases return the same safe refusal class.

**Verification:**

- [x] `bun test server/tests/ai-credential-lease.test.ts server/tests/agent-callback-token.test.ts`
- [x] Concurrency fixture permits exactly one of two simultaneous redemptions.

**Dependencies:** Tasks 10–15.

**Files likely touched:**

- `server/src/ai-connections/leases.ts`
- `server/src/ai-connections/internal-routes.ts`
- `server/tests/ai-credential-lease.test.ts`

**Estimated scope:** Medium, 3 files.

### Task 17: Attach the lease to governed remote runs

**Description:** Extend the server-owned remote-agent run preparation so only the application can
attach a lease and actor admission key after agent authorization.

**Acceptance criteria:**

- [ ] Server-owned forwarded properties overwrite client attempts to provide actor/lease fields.
- [ ] A user with no active connection receives the Settings guidance before the remote agent is called.
- [ ] Handoffs and routine runs mint leases for their original trusted actor, not the model or browser body.

**Verification:**

- [ ] `bun test server/tests/copilot.test.ts server/tests/agent-handoff-delivery.test.ts server/tests/routine-endpoint.test.ts`

**Dependencies:** Task 16.

**Files likely touched:**

- `server/src/copilot.ts`
- `server/src/index.ts`
- `server/tests/copilot.test.ts`
- `server/tests/agent-handoff-delivery.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 18: Agent-side lease redemption client

**Description:** Resolve the personal provider once per accepted run, keep it in process memory and
feed only a typed provider context to the runtime profile.

**Acceptance criteria:**

- [ ] The resolver contacts only the fixed internal server URL with the managed credential and opaque lease.
- [ ] Secret values are absent from errors, timing records, protocol traces and callback arguments.
- [ ] Provider resolution occurs after queue admission and before child spawn, so disconnect blocks queued work.

**Verification:**

- [ ] `bun test agent-codex/tests/provider-connection.test.ts agent-codex/tests/request-handler.test.ts`

**Dependencies:** Task 17.

**Files likely touched:**

- `agent-codex/src/provider-connection.ts`
- `agent-codex/src/request-handler.ts`
- `agent-codex/src/codex-run.ts`
- `agent-codex/tests/provider-connection.test.ts`

**Estimated scope:** Medium, 4 files.

## Checkpoint F — Credential-delivery boundary

- [ ] Tasks 16–18 pass with replay, queue and actor-swap tests.
- [ ] AG-UI captures contain an opaque lease only, never provider secret material.
- [ ] A disconnected queued run reaches no Codex child.

### Task 19: Per-actor admission limit

**Description:** Extend admission control so one actor can run only one Codex child at a time while
the existing per-agent/global limits continue to apply.

**Acceptance criteria:**

- [ ] A second run for the same server-stamped actor queues; another actor may use free capacity.
- [ ] Cancellation, timeout, drain and process exit release every actor/global/agent slot exactly once.
- [ ] Invalid/missing actor admission data fails closed before child spawn.

**Verification:**

- [ ] `bun test agent-codex/tests/run-admission.test.ts agent-codex/tests/request-handler.test.ts`

**Dependencies:** Task 18.

**Files likely touched:**

- `agent-codex/src/run-admission.ts`
- `agent-codex/src/request-handler.ts`
- `agent-codex/tests/run-admission.test.ts`
- `agent-codex/tests/request-handler.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 20: Execute OpenRouter through Codex CLI

**Description:** Connect the redeemed OpenRouter context to the isolated profile and existing
`codex app-server` protocol.

**Acceptance criteria:**

- [ ] The server-configured model/provider is used and client model override cannot cross providers.
- [ ] Existing reasoning, tools, research finalization and artifact behavior remain unchanged.
- [ ] Child/profile cleanup occurs after success, failure, cancellation and forced kill.

**Verification:**

- [ ] `bun test agent-codex/tests/runtime-profile.test.ts agent-codex/tests/codex-run.test.ts agent-codex/tests/history.test.ts`
- [ ] Controlled Responses endpoint completes one AG-UI run through the real Codex child.

**Dependencies:** Tasks 2, 18 and 19.

**Files likely touched:**

- `agent-codex/src/runtime-profile.ts`
- `agent-codex/src/codex-run.ts`
- `agent-codex/tests/runtime-profile.test.ts`
- `agent-codex/tests/codex-run.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 21: OpenRouter governed-run integration suite

**Description:** Prove two users can use the same logical employee through different keys without
sharing history, tools or provider state.

**Acceptance criteria:**

- [ ] Two actors receive distinct leases, provider contexts, Intelligence user IDs and audit actors.
- [ ] Tool callbacks remain authorized by the original signed run and never by OpenRouter output.
- [ ] Secret canaries are absent from browser events, tool results and bounded service logs.

**Verification:**

- [ ] `bun test server/tests/personal-ai-run.integration.test.ts agent-codex/tests/personal-provider.integration.test.ts`

**Dependencies:** Task 20.

**Files likely touched:**

- `server/tests/personal-ai-run.integration.test.ts`
- `agent-codex/tests/personal-provider.integration.test.ts`

**Estimated scope:** Small, 2 files.

## Checkpoint G — OpenRouter execution slice

- [ ] Tasks 19–21 pass together.
- [ ] One controlled end-to-end run creates real progressive AG-UI events and governed tool audit.
- [ ] No global or owner credential is consulted when a user connection is absent.

## Phase 4 — ChatGPT/Codex personal connection

### Task 22: Agent-side ChatGPT device-flow coordinator

**Description:** Add managed internal start/status/cancel operations around `codex login
--device-auth` in a flow-owned temporary home.

**Acceptance criteria:**

- [x] Start returns only opaque flow ID, verification URL, user code and expiry.
- [x] Status never returns the auth document; completion is available only to the server-to-server collector.
- [x] Timeout, cancel, duplicate start, process error and service shutdown terminate the child and remove the home.

**Verification:**

- [x] `bun test agent-codex/tests/device-auth.test.ts agent-codex/tests/index.test.ts`
- [x] Installed-CLI start/cancel probe leaves no temporary file or child process.

**Dependencies:** Task 1.

**Files likely touched:**

- `agent-codex/src/device-auth.ts`
- `agent-codex/src/index.ts`
- `agent-codex/tests/device-auth.test.ts`
- `agent-codex/tests/index.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 23: Server-side device-flow ownership API

**Description:** Bind every ChatGPT flow to the initiating actor, proxy only safe state to the
browser and store the completed auth document in the encrypted vault.

**Acceptance criteria:**

- [ ] Start/poll/cancel derive actor from the session and refuse another actor's flow generically.
- [ ] Only the server collector receives completion material; it validates shape before atomic connection rotation.
- [ ] Restart/expiry produces an explicit retryable state and never a connected status without a live credential.

**Verification:**

- [ ] `bun test server/tests/chatgpt-device-flow.test.ts server/tests/ai-connection-routes.test.ts`

**Dependencies:** Tasks 11, 13 and 22.

**Files likely touched:**

- `server/src/ai-connections/device-flows.ts`
- `server/src/ai-connections/routes.ts`
- `server/src/app.ts`
- `server/tests/chatgpt-device-flow.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 24: ChatGPT connection Settings card

**Description:** Add the personal ChatGPT connect/cancel/disconnect experience beside OpenRouter.

**Acceptance criteria:**

- [ ] The card displays the official verification URL/code and clear expiry/progress without requesting a password.
- [ ] Polling stops on completion, failure, expiry, unmount and sign-out.
- [ ] Provider replacement requires explicit confirmation and never exposes the previous credential.

**Verification:**

- [ ] `bun test app/src/routes/_authed/settings/ai-connections.test.tsx`

**Dependencies:** Task 23.

**Files likely touched:**

- `app/src/lib/ai-connections/queries.ts`
- `app/src/lib/ai-connections/mutations.ts`
- `app/src/routes/_authed/settings/index.tsx`
- `app/src/routes/_authed/settings/ai-connections.test.tsx`

**Estimated scope:** Medium, 4 files.

## Checkpoint H — ChatGPT connection flow

- [ ] Tasks 22–24 pass without a live account through fixtures and start/cancel probe.
- [ ] Browser network/DOM fixtures contain no auth document, refresh token or password field.
- [ ] A flow is visible and mutable only to its initiating actor.

### Task 25: ChatGPT profile materialization and refresh

**Description:** Run Codex with the redeemed per-user ChatGPT auth document and safely persist a
refreshed document after the child exits.

**Acceptance criteria:**

- [ ] The auth document is written only inside the matching mode-`0700` temporary home.
- [ ] Refresh upload is actor/run/credential bound and cannot revive a disconnected or rotated credential.
- [ ] Missing, malformed or revoked documents fail with Settings guidance and never use the host profile.

**Verification:**

- [ ] `bun test agent-codex/tests/chatgpt-profile.test.ts agent-codex/tests/codex-run.test.ts server/tests/ai-credential-lease.test.ts`

**Dependencies:** Tasks 18, 19 and 23.

**Files likely touched:**

- `agent-codex/src/runtime-profile.ts`
- `agent-codex/src/provider-connection.ts`
- `agent-codex/src/codex-run.ts`
- `agent-codex/tests/chatgpt-profile.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 26: ChatGPT cross-user and lifecycle suite

**Description:** Exercise profile isolation, concurrent login, reconnect, disconnect and refresh
races across two users.

**Acceptance criteria:**

- [ ] User A cannot poll, redeem, run or refresh user B's flow/profile/credential.
- [ ] Reconnect retires the old document; late refresh from the old run is refused.
- [ ] Service restart and forced child exit leave no reusable plaintext or false connected status.

**Verification:**

- [ ] `bun test server/tests/chatgpt-isolation.integration.test.ts agent-codex/tests/chatgpt-isolation.integration.test.ts`

**Dependencies:** Task 25.

**Files likely touched:**

- `server/tests/chatgpt-isolation.integration.test.ts`
- `agent-codex/tests/chatgpt-isolation.integration.test.ts`

**Estimated scope:** Small, 2 files.

## Checkpoint I — Both provider paths

- [ ] Tasks 25–26 and all OpenRouter tests pass together.
- [ ] Provider replacement, disconnect and absence have deterministic no-fallback behavior.
- [ ] One active run per actor prevents ChatGPT refresh races without blocking a different actor.

## Phase 5 — Product, deployment package and documentation

### Task 27: Visible ManacostTeam branding

**Description:** Replace user-facing OpenBot product identity while retaining protocol and storage
identifiers required for compatibility.

**Acceptance criteria:**

- [ ] Sign-in, sidebar, settings, document titles and empty states display ManacostTeam.
- [ ] No user-facing text suggests the owner is sharing their ChatGPT account.
- [ ] Internal `openbot__*`, database names and AG-UI contracts remain unchanged unless separately migrated.

**Verification:**

- [ ] `bun test app/src server/tests/tenant-package.test.ts`
- [ ] `bun run build`

**Dependencies:** Tasks 7, 14 and 24.

**Files likely touched:**

- `examples/chatgpt/brand.yaml`
- `app/src/components/app-sidebar/app-sidebar.tsx`
- `app/src/routes/sign.tsx`
- `app/src/routes/_authed/settings/index.tsx`

**Estimated scope:** Medium, 4 files.

### Task 28: ManacostTeam Compose/runtime configuration

**Description:** Prepare the new release configuration with Telegram sessions, personal-provider
runtime and no globally mounted Codex profile.

**Acceptance criteria:**

- [ ] New configuration refuses `OPENBOT_SINGLE_USER=true` with Telegram mode.
- [ ] `agent-codex` receives internal endpoints/tokens but no host `auth.json` or global model credential.
- [ ] Existing research-source secrets remain restricted to the services that already require them.

**Verification:**

- [ ] `bun test tests/compose.test.ts server/tests/config.test.ts`
- [ ] `docker compose -f docker-compose.production.yml config --quiet` with protected fixture values.

**Dependencies:** Checkpoint I.

**Files likely touched:**

- `docker-compose.production.yml`
- `tests/compose.test.ts`
- `.env.example`
- `agent-codex/Dockerfile`

**Estimated scope:** Medium, 4 files.

### Task 29: Protected configuration helpers

**Description:** Add operator helpers for Telegram token/IDs, default OpenRouter model and safe
validation without placing values in command arguments, Git or output.

**Acceptance criteria:**

- [ ] Helpers prompt privately, write only ignored mode-`0600` configuration and redact diagnostics.
- [ ] Dry-run reports missing variable names and allowlist relationships, never values.
- [ ] Owner/editor updates cannot accidentally remove the last owner without an explicit refused operation.

**Verification:**

- [ ] Shell helper tests run with temporary files and synthetic values.
- [ ] `shellcheck` and `shfmt -d` pass for new/changed scripts.

**Dependencies:** Tasks 4, 8 and 28.

**Files likely touched:**

- `scripts/configure-manacostteam-auth.sh`
- `scripts/test-configure-manacostteam-auth.sh`
- `.gitignore`

**Estimated scope:** Medium, 3 files.

## Checkpoint J — Deployable source release

- [ ] Tasks 27–29 pass with no production mutation.
- [ ] Compose contains no global ChatGPT/OpenRouter credential path.
- [ ] Operator can prepare all required configuration without pasting a secret into chat or shell history.

### Task 30: Authentication and personal-provider runbooks

**Description:** Document setup, owner binding, editor allowlist, device login, OpenRouter key
handling, revocation, canary, public cutover and rollback in current-state language.

**Acceptance criteria:**

- [ ] Runbooks distinguish application Telegram login from personal model connection.
- [ ] Every destructive/traffic-changing step has preflight, exact target, verification and rollback.
- [ ] Google OAuth callback/origin changes are placed at public cutover, not initial build/deploy.

**Verification:**

- [ ] Markdown formatting and relative links pass.
- [ ] A redaction review finds no real token, client secret, ID or auth document.

**Dependencies:** Tasks 27–29.

**Files likely touched:**

- `docs/runbooks/manacostteam-authentication.md`
- `docs/production-runtime.ru.md`
- `docs/production-operations.ru.md`
- `docs/plugins/google-drive.md`

**Estimated scope:** Medium, 4 files.

### Task 31: Full feature quality and security gate

**Description:** Run the complete repository gates, security analysis and focused adversarial tests;
fix only findings caused by this feature.

**Acceptance criteria:**

- [ ] Full format, lint, typecheck, test, build and project quality commands pass.
- [ ] Security check has no unresolved feature-introduced critical/high finding.
- [ ] Secret-canary scan, cross-user probes and rollback rehearsal tests are green.

**Verification:**

- [ ] `bun run format:check`
- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test:ci`
- [ ] `bun run build`
- [ ] `/home/debian/server/tools/ai-quality/bin/ai-check`
- [ ] `/home/debian/server/tools/ai-quality/bin/ai-security-check`

**Dependencies:** Tasks 1–30.

**Files likely touched:**

- No planned source file; any required fix becomes a separately reviewed task if it exceeds five files or changes scope.

**Estimated scope:** Small gate, variable runtime.

## Checkpoint K — Implementation complete, production untouched

- [ ] Tasks 1–31 and the standing definition of done are complete.
- [ ] Approved spec, plan, task list, code, migrations and runbooks are committed on `main`.
- [ ] Owner receives a release summary, known limitations and exact canary prerequisites.
- [ ] A new explicit approval is obtained before Task 32.

## Phase 6 — Production-data and traffic gates

### Task 32: Copied-production owner-binding rehearsal

**Description:** Restore a verified database copy into an isolated environment, run the owner
binding and confirm every owner resource remains reachable under the unchanged internal actor ID.

**Acceptance criteria:**

- [ ] Backup/restore is verified before binding and contains no production writer connection.
- [ ] Channels, artifacts, attachments, routines, Google connections, grants and history counts match before/after.
- [ ] Editor fixture cannot read owner data and rollback to the old release reads the copy.

**Verification:**

- [ ] Evidence records only counts, IDs approved for operations and pass/fail status; no content/secrets.

**Dependencies:** Checkpoint K and explicit owner approval for copied production data.

**Files likely touched:**

- `docs/manacostteam-rehearsal-evidence.md`

**Estimated scope:** Small document plus controlled operations.

### Task 33: Separate canary deployment

**Description:** Deploy the new release to a separate HTTPS hostname or loopback/SSH-tunnel canary
while the current public gateway and origin continue serving the old release.

**Acceptance criteria:**

- [ ] Owner and editor complete isolated Telegram login and harmless ChatGPT/OpenRouter runs.
- [ ] Google Docs, handoff, research and YouTube artifact smoke scenarios pass without secret leakage.
- [ ] Logout, allowlist removal, disconnect and rollback are demonstrated before public cutover.

**Verification:**

- [ ] Health, runtime timing, audit attribution and browser smoke evidence are recorded safely.

**Dependencies:** Task 32 and explicit deployment approval.

**Files likely touched:**

- `docs/manacostteam-canary-evidence.md`

**Estimated scope:** Medium operational task.

### Task 34: Public ManacostTeam cutover

**Description:** Switch `work.kolodahearthstone.com` from the ChatGPT gateway to the verified
ManacostTeam release and retire edge-auth from live traffic.

**Acceptance criteria:**

- [ ] Owner login succeeds before and after the proxy/DNS switch; at least one editor succeeds after it.
- [ ] `OPENBOT_SINGLE_USER`, Nginx `auth_request`, live `edge-auth` dependency and global auth mount are absent.
- [ ] Google OAuth exact redirect works and the complete compatible rollback set is immediately available.

**Verification:**

- [ ] Repeat canary smoke, negative isolation, logout/revoke and one-working-period observation.

**Dependencies:** Task 33 and a separate explicit public-cutover approval.

**Files likely touched:**

- `ops/nginx/work-origin.kolodahearthstone.com.conf`
- `docker-compose.production.yml`
- `docs/manacostteam-cutover-evidence.md`

**Estimated scope:** Medium operational task, 3 tracked files plus external proxy/DNS configuration.

## Parallelization map

Only after the named contracts are merged:

- Tasks 7 and 8 may run in parallel after Task 6.
- Tasks 14 and 15 may run in parallel after Task 13.
- Task 19 may run alongside the UI part of Task 14, but not before Task 18 fixes the actor contract.
- Tasks 22 and 23 are sequential at their shared protocol boundary; Task 24 follows both.
- Task 27 may run alongside Task 26 after both Settings cards have stable copy and states.
- Documentation may be drafted in parallel after Task 28, then reconciled after Task 31.
- Tasks 10, 16–18, 25, 28 and all production tasks are sequential because they change shared ownership or runtime boundaries.

## Inputs that do not block Tasks 1–31

Real Telegram IDs/tokens, an OpenRouter key, a ChatGPT account and public DNS/proxy access are not
needed for implementation tests; fixtures and bounded local probes are used. They become mandatory
only for Tasks 32–34 and are supplied through protected operator paths, never this document or chat.
