# Implementation Plan: ManacostTeam authentication and personal AI connections

## Status

Approved by the owner on 2026-09-01. This plan implements the approved
[`manacostteam-telegram-auth-spec.md`](manacostteam-telegram-auth-spec.md). Task breakdown and the
production cutover remain separate approval gates.

## Overview

ManacostTeam will use Telegram only to identify an allowlisted team member. Each signed-in member
will then connect either their own ChatGPT/Codex account or their own OpenRouter key in Settings.
Both paths continue to execute through the existing `agent-codex` service and its governed tools.

The change is delivered behind configuration gates. The existing production path remains available
until an owner Telegram login, owner history, both personal provider paths and cross-user isolation
have been verified against a copied production database and then in a canary deployment.

## Architecture decisions

### 1. Authentication and model access remain separate

Telegram creates the ManacostTeam application session. ChatGPT and OpenRouter credentials never
create an application session and cannot grant a role. This prevents a model account from becoming
an authorization primitive.

### 2. Telegram is a Better Auth plugin, not a parallel session system

A small first-party Better Auth plugin owns the Telegram callback. It validates the official
Telegram payload, one-time state, freshness and allowlist before using Better Auth's internal
adapter and cookie helpers to create the same database-backed session used by current request
guards. Existing `/api/me`, role guards, sign-out, session revocation and audit paths remain the
single source of truth.

No new authentication dependency is planned. The implementation uses Web Crypto, Better Auth 1.7.1
already installed in the repository and the current Drizzle adapter.

### 3. Telegram subject maps to an opaque application user

`telegram:<numeric-id>` is stored as the immutable provider account subject. Authorization continues
to use `users.id` through the existing `AuthenticatedActor` contract.

The owner's subject is bound once to the existing `dev-local-user` row by an idempotent operator
command. This preserves local foreign keys and CopilotKit history ownership. New Telegram subjects
create new opaque users. No public route can choose a target user ID or rebind an existing subject.

### 4. Personal AI connection has one active row per user

An additive `user_ai_connections` table binds a user to one active provider and one encrypted
credential row. The existing `credentials` vault continues to encrypt secrets with
`KEY_ENCRYPTION_KEY`; the new table supplies the user ownership that deployment-wide model keys do
not have.

OpenRouter stores a write-only API key after `GET /api/v1/key` validation against a fixed HTTPS
origin. ChatGPT stores the resulting Codex auth document after device authorization. Replacement
rotates the vault credential atomically. Disconnect revokes it and changes the connection state in
the same transaction.

### 5. One-time run delivery replaces the global Codex auth mount

The server mints a short-lived, actor/run-bound credential lease only after the normal agent grant
check. `agent-codex` redeems it once over the internal network using the managed-agent credential.
Redemption rechecks that the connection and credential are still active, so a disconnected key
cannot start a queued run.

The plaintext exists only in the server response body, the `agent-codex` process memory and the
matching Codex child. It is never placed in AG-UI events, audit payloads, timing logs, browser
responses or Docker configuration.

### 6. Every Codex child receives an isolated runtime profile

For ChatGPT, `agent-codex` materialises the decrypted auth document into a mode-`0700` temporary
`CODEX_HOME`, runs `codex app-server`, returns a safely refreshed auth document to the server when
needed, and removes the directory when the run ends.

For OpenRouter, the same temporary home contains a generated config with a fixed
`https://openrouter.ai/api/v1` Responses provider and an administrator-configured model. The key is
available to the provider process but excluded from shell/tool environments by Codex's shell
environment policy.

The first release admits one active Codex run per actor. This avoids concurrent ChatGPT refresh
races and gives every user a bounded share of the common host. The existing global and per-agent
limits remain as additional ceilings.

### 7. Public cutover is the last step

The existing ChatGPT edge gate, `OPENBOT_SINGLE_USER=true` and global host `auth.json` mount remain
in the rollback release but are absent from the ManacostTeam release. They are removed from live
traffic only after the owner signs in with Telegram and completes a harmless run through a personal
connection.

A separate HTTPS canary hostname, or a loopback-only deployment reached through an operator SSH
tunnel, is used while the current `work-origin.kolodahearthstone.com` edge gate remains live. Moving
`work.kolodahearthstone.com` away from its current ChatGPT gateway is a separate DNS/proxy cutover
after the canary passes. Google OAuth redirect URIs are updated deliberately at that boundary, not
silently during application deployment.

## Dependency graph

```text
Telegram/config validation ──> Better Auth Telegram plugin ──> Telegram sign-in UI
            │                              │                         │
            └──────────────> owner binding/session migration ───────┘

AI connection schema/vault ──> personal connection API ──> Settings UI
            │                          │
            ├──────────────> one-time run lease ──> agent-codex profile resolver
            │                                            │
            │                                            ├──> OpenRouter Codex child
            │                                            └──> ChatGPT Codex child
            │
            └──────────────> revoke/replace/audit

All verified slices ──> copied-data rehearsal ──> origin canary ──> public cutover
```

## Implementation order

### Phase 0 — Fail-fast runtime proofs

Before schema or UI work, add bounded integration harnesses that prove the two uncertain runtime
boundaries against the installed Codex CLI:

- a temporary `CODEX_HOME` can run without reading the host auth profile;
- a fixed OpenRouter Responses provider can initialise with a synthetic/test transport while its key
  is absent from spawned shell environments;
- the ChatGPT device-flow coordinator exposes only verification URL/code, cleans up on cancellation,
  and accepts a fixture auth document only from its matching temporary directory;
- a custom Better Auth endpoint can create and revoke an ordinary database session without a second
  cookie format.

Checkpoint: stop and revise the specification if any proof requires global credentials, a browser
secret or an unsupported Codex protocol.

### Phase 1 — Telegram login vertical slice

Implement strict Telegram configuration and signature verification, then the Better Auth plugin,
provider-account binding, one-time login state and Russian sign-in screen. Add allowlist
reconciliation that ends sessions for removed IDs. The existing OAuth providers remain available in
non-ManacostTeam deployments; Telegram is selected explicitly by configuration.

The owner-binding command is dry-run by default, accepts the numeric ID through protected terminal
input, refuses an already-bound ID or a second owner target and writes only non-secret identifiers to
audit/output.

Checkpoint: owner and editor fixtures produce distinct sessions; tamper, replay, stale payload,
unknown ID, role escalation and session-revocation tests pass.

### Phase 2 — OpenRouter personal connection vertical slice

Add the connection schema/store, actor-scoped API and Settings card. Validate a submitted key without
persisting it first; on success encrypt and bind it atomically. Implement replace and disconnect,
including queued-run refusal.

Add one-time lease redemption and per-actor admission to `agent-codex`. Generate a temporary Codex
configuration with the fixed OpenRouter origin, server-selected model and secret-denying shell
policy. Complete one governed agent run and verify that callbacks still carry the same actor.

Checkpoint: two users can run the same agent with different test keys; swapping actor, lease, run ID
or credential fails; browser/tool/log snapshots contain neither key.

### Phase 3 — ChatGPT/Codex personal connection vertical slice

Add an authenticated device-flow coordinator between the server and `agent-codex`. Start, poll,
cancel and expire flows by opaque flow ID bound to the initiating user. Store the completed auth
document only after successful login; never return it to the browser.

Materialise the stored document per run, prevent cross-user profile reuse and safely persist a
refreshed document through an actor/run-bound internal callback. Replacing or disconnecting the
connection cancels pending flows and retires the old credential.

Checkpoint: two isolated fixture profiles cannot read or refresh one another; restart/timeout/cancel
paths clean temporary state; a missing profile never falls back to the host profile.

### Phase 4 — Product identity, history and operational migration

Change visible branding to ManacostTeam while retaining protocol identifiers whose renaming would
break data. Rehearse the owner Telegram binding on a restored production snapshot and verify that
channels, artifacts, attachments, routines, Google connections, grants and audit history remain
available under the same internal owner ID.

Update configuration, deployment and rollback documentation. Add protected helpers for Telegram
configuration and owner/editor ID management without printing tokens. Update Google OAuth setup
instructions for the final public callback origin.

Checkpoint: full quality/security gates pass and the restored snapshot can run owner and editor
smoke scenarios with no cross-user reads.

### Phase 5 — Canary and production cutover

Take a verified backup, preserve immutable image IDs and deploy the compatible database/application
changes to the separate HTTPS/tunnel canary through the existing drain-aware deployment helper.
Keep the old public gateway and origin serving while the owner verifies Telegram login, personal
ChatGPT and OpenRouter runs, Google Docs, handoffs, research and YouTube artifacts.

Only after that verification:

1. remove Nginx `auth_request` to `edge-auth` on the chosen public origin;
2. run with Better Auth Telegram sessions and `OPENBOT_SINGLE_USER` disabled;
3. remove the global `/home/debian/.codex/auth.json` mount;
4. switch the public `work.kolodahearthstone.com` proxy/DNS path;
5. repeat owner/editor isolation and revoke/logout smoke checks.

Checkpoint: observe the release through one normal working period. Roll back the whole compatible
server + agent + proxy set on authentication, history, credential or tool-governance regression.

## Verification strategy

### Targeted gates per slice

```bash
bun test server/tests/config.test.ts server/tests/auth* server/tests/credentials.test.ts
bun test app/src/lib/auth app/src/routes app/src/lib/ai-connections
bun test agent-codex/tests
```

Exact file filters will be replaced by the task breakdown after test files are named. Tests that need
external providers use controlled fakes by default; live ChatGPT/OpenRouter smoke tests run only with
operator-provided credentials and never print them.

### Feature gate

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:ci
bun run build
/home/debian/server/tools/ai-quality/bin/ai-security-check
```

### Production evidence

- Telegram login outcomes by safe reason code, never signed payload;
- connection state and provider in audit, never credential metadata that can identify a key;
- run timing correlated by run/thread/agent and internal actor ID, without prompts;
- zero secret matches in browser captures, tool environments and bounded log exports;
- owner/editor negative access probes for channels, artifacts, Google connections and AI leases;
- backup restore and rollback evidence recorded before edge removal.

## Parallel and sequential work

After shared contracts and migrations are fixed, the Telegram UI, OpenRouter Settings UI, ChatGPT
device-flow UI and documentation can be implemented independently. Runtime credential delivery,
schema migration and request-actor wiring remain sequential because they share the same ownership
contract. Nginx, Compose and public DNS changes are strictly last and are never parallelised with
identity migration.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Owner lockout during edge removal | Critical | owner binding rehearsal, origin canary, non-empty owner config, old public gateway retained until smoke passes |
| Existing history appears empty under a new actor | High | bind Telegram subject to existing owner row; verify CopilotKit history before cutover |
| ChatGPT auth document leaks between users | Critical | encrypted ownership row, one-use lease, isolated `CODEX_HOME`, one active run per actor, negative cross-user tests |
| OpenRouter key reaches shell/tool output | Critical | fixed env name, Codex shell exclusion, no inherited host env, adversarial leak tests and log scan |
| Revoked key starts from queue | High | validate live connection during lease redemption after admission, not when request is submitted |
| Device flow survives restart in an ambiguous state | Medium | short expiry, in-memory coordinator plus database status, tmpfs cleanup and explicit retry state |
| Better Auth upgrade changes internal plugin helpers | Medium | pin 1.7.1 during feature work, contract tests around session cookie and adapter, no deep import without an ADR |
| Public domain and Google redirect URI diverge | High | canary origin first, explicit provider-console update, exact redirect smoke before DNS/proxy switch |
| Shared host capacity is exhausted | Medium | one active run per actor plus existing global/per-agent queue limits and safe 429/503 responses |

## Rollback boundary

All database changes are additive. The old release ignores new connection and Telegram account rows.
Before public cutover, rollback is an image/proxy rollback with the existing global Codex profile
still available only to the old edge-protected release. After cutover, rollback restores the whole
old server + agent + edge-auth set and its previous Nginx configuration; it never partially restores
the global auth mount beside the new multi-user server.

Credential ciphertext remains readable with the existing `KEY_ENCRYPTION_KEY`. No rollback step
prints, exports or transforms plaintext credentials.

## Inputs needed before live canary

- Telegram bot username already registered for the chosen HTTPS domain;
- Telegram bot token installed in protected server configuration;
- numeric owner ID and editor allowlist IDs supplied through the operator helper;
- an owner-configured OpenRouter Responses-compatible default model;
- one owner ChatGPT device login and one low-limit OpenRouter test key for harmless smoke runs;
- confirmation that the public `work.kolodahearthstone.com` gateway/DNS can be switched after the
  separate canary passes.

These values are not required to build or test the feature with fixtures. They are required before
production traffic changes.
