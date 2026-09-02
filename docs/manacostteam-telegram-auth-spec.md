# Spec: ManacostTeam — Telegram authentication and personal AI connections

## Status

Approved by the owner on 2026-08-31. The implementation plan was approved on 2026-09-01; task
breakdown and production cutover remain separate approval gates.

## Assumptions

1. ManacostTeam remains a private web application at the existing `work.kolodahearthstone.com`
   deployment.
2. The existing Telegram bot is reused for website login after its domain is registered in
   BotFather. A second bot is not required.
3. Access is invite-only and keyed by an immutable numeric Telegram user ID, never by a mutable
   `@username`.
4. The first release reads the allowlist and owner IDs from protected server configuration. A later
   release may add an owner-only People screen for managing them.
5. Every Telegram user is a distinct ManacostTeam actor with separate sessions, threads, files,
   audit events, Google OAuth connections, quotas and agent grants.
6. Codex CLI remains the execution engine. In personal settings, each user chooses either their own
   ChatGPT/Codex login or their own OpenRouter API key. There is no fallback to another person's
   connection.

## Objective

Replace the current ChatGPT edge login plus `OPENBOT_SINGLE_USER` identity with Telegram login and
turn the OpenBot-derived deployment into the private ManacostTeam workspace.

The owner can add numeric Telegram IDs to a server-side allowlist. An allowlisted person signs in
through Telegram and receives a normal secure ManacostTeam session. A non-allowlisted or forged
identity receives no user, session or application metadata.

The existing Codex CLI process remains behind the application boundary for both AI providers.
Browsers never receive a stored Codex auth file, ChatGPT cookie, refresh token, Telegram bot token,
OpenRouter key or internal agent token. Codex conversations, provider selection and tools are scoped
to the authenticated ManacostTeam actor.

### User stories

- As the owner, I can sign in with my Telegram account and retain administrator access.
- As the owner, I can add an editor's numeric Telegram ID to protected configuration and deploy it.
- As an editor, I can sign in with Telegram and use only the agents and tools assigned to me.
- As a user, I can connect ChatGPT/Codex with a device code or save my OpenRouter API key.
- As a user, I can see connection status, replace or disconnect my own AI provider without seeing a
  stored secret again.
- As an editor, I cannot see the owner's conversations, files, Google account, credentials or admin
  screens.
- As the operator, I can revoke a Telegram ID and invalidate all of that person's sessions.
- As the operator, I can attribute every login and AI run to one Telegram-derived internal user ID.

## Existing system and migration boundary

The application already has PostgreSQL users and sessions, Better Auth-backed request guards,
`admin`/`user` roles, access revocation and audit storage. These are retained.

The unsafe compatibility path is removed from production:

- `OPENBOT_SINGLE_USER=true` no longer authenticates public requests;
- `dev-local-user` is never used for a Telegram-authenticated request;
- the ChatGPT edge bootstrap cookie no longer decides the ManacostTeam actor;
- existing owner data is migrated or explicitly retained under the owner's new Telegram identity;
- rollback preserves the old deployment until owner login and data ownership are verified.

The first release changes visible product branding to `ManacostTeam`. Internal database/table names,
artifact schema identifiers and protocol-compatible `openbot__*` tool names remain unchanged where
renaming them would break stored data or agent contracts. Those can be migrated separately.

## Authentication design

### Telegram OIDC callback

The login screen submits an ordinary same-origin POST to the server. The server starts Telegram's
Authorization Code flow with PKCE S256, then:

1. creates one opaque, five-minute state and binds it to a signed `HttpOnly` browser cookie;
2. sends only a derived PKCE challenge and nonce to Telegram;
3. accepts only the fixed HTTPS issuer, authorization, token and JWKS endpoints;
4. consumes state before exchanging the authorization code and refuses replay;
5. verifies the RS256 signature, issuer, audience, expiry, nonce and bounded claim shapes;
6. takes the stable account identity from Telegram's signed numeric `id` claim, not mutable profile
   fields and not the distinct OIDC `sub` value;
7. applies the existing allowlist, owner binding and revocation rules before creating a session;
8. redirects only to an allowlisted local path.

The OIDC client secret is read only by the authentication service. It is never returned, logged,
stored in a browser, copied into the tenant package or passed to an AI agent. Callback responses use
`no-store` and `Referrer-Policy: no-referrer`; the reverse proxy disables callback access logging
because the authorization code is carried in the query string.

One release retains the old HMAC callback route and bot token for already-open browser bundles.
The current sign-in screen never loads the archived Telegram widget. Remove the fallback after the
observation window. Protocol reference: [Telegram Login](https://core.telegram.org/bots/telegram-login).

### Internal identity

The stable authentication subject is `telegram:<numeric-id>` and is bound to one opaque internal
user ID. Display name, username and photo are profile metadata and never authorization inputs. A
Telegram subject cannot be moved to another existing user through a browser request.

The owner's Telegram subject is bound once, through an explicit operator migration, to the existing
`dev-local-user` row. This preserves local foreign keys and CopilotKit history ownership without a
bulk identity rewrite. New people receive new opaque internal user IDs. After the binding,
`dev-local-user` is no longer a no-auth fallback: it is reachable only through the bound owner's
verified Telegram login.

The protected configuration contains:

- `TELEGRAM_OIDC_CLIENT_ID` and `TELEGRAM_OIDC_CLIENT_SECRET` — confidential OIDC client;
- `TELEGRAM_LOGIN_BOT_USERNAME` and `TELEGRAM_LOGIN_BOT_TOKEN` — one-release legacy fallback;
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated positive numeric IDs;
- `TELEGRAM_OWNER_USER_IDS` — non-empty subset of the allowlist;
- `BETTER_AUTH_SECRET`, public URL and trusted origin values already required for secure sessions.

Boot fails closed when Telegram login is selected but either OIDC credential, the compatibility
credential, owner set, session secret, public HTTPS URL or consistent allowlist is missing.

### Roles and revocation

An ID in `TELEGRAM_OWNER_USER_IDS` receives the existing administrator role. Other allowlisted IDs
receive the existing user role, shown as `Редактор` in the ManacostTeam interface. Removing an ID
from the allowlist prevents a new login and invalidates its active sessions during configuration
reconciliation. Explicit revocation in the database continues to win over configuration.

## Personal AI connections

The authenticated ManacostTeam session and the AI provider are separate concepts. Telegram proves
which team member is using the application. The personal AI connection decides which account pays
for and authorises that member's model runs.

The Settings screen shows exactly two cards:

1. **ChatGPT / Codex** — starts `codex login --device-auth` in an isolated, per-user Codex home.
   ManacostTeam displays the one-time verification URL and code and polls only for completion or
   failure. The user completes authentication directly with ChatGPT. The application never asks for
   a ChatGPT password.
2. **OpenRouter API key** — accepts one write-only key over HTTPS, validates it with OpenRouter's
   authenticated `GET /api/v1/key` endpoint, encrypts it with the deployment key and displays only
   connection status and non-secret key metadata afterwards.

Only one provider is active for a user at a time. Connecting a new provider retires the previous
credential in one transaction after the new connection has passed validation. Disconnecting blocks
new runs immediately and prevents queued runs from starting. It does not delete conversation
history.

OpenRouter uses an owner-configured, tool-compatible default model in the first release; the user
does not need to select a model just to connect a key. Per-agent OpenRouter model choices are a later
feature and must never silently reuse an OpenAI-only model identifier.

### Credential storage and delivery

The existing encrypted credential vault stores an opaque per-user credential reference. A new
user-AI-connection row binds exactly one user ID to a provider and credential ID. Browser responses
may contain provider, status, validation time and safe account limits, but never the encrypted blob,
key suffix unless OpenRouter itself marks it safe for display, auth cache or refresh token.

ChatGPT/Codex auth state is materialised into a mode-`0700` per-run tmpfs directory only for the
matching user, then re-encrypted after Codex refreshes it and removed when the process ends. The
OpenRouter key is delivered to the matching Codex child through a single-use internal credential
lease, removed from shell/tool environments, and discarded when the process ends. Neither secret is
mounted globally into the agent container.

## Codex CLI runtime design

Codex CLI remains a private server worker. ManacostTeam sends it bounded run input and streams back
events; it never exposes a shell, auth file or Codex control protocol to the browser.

Runtime isolation requirements:

- one authenticated ManacostTeam actor is carried through request, thread and audit boundaries;
- a run is admitted only after the actor may use the selected agent;
- concurrency, queue and daily usage limits are enforced per actor as well as globally;
- tool grants are checked by the ManacostTeam server on every callback;
- model output is untrusted and cannot grant access or select another user's storage;
- the Codex process cannot read application secrets, Google OAuth tokens or another user's files;
- owner and editor history cannot share a Codex thread ID, provider credential or writable workspace
  state;
- ChatGPT mode launches Codex with the matching user's isolated `CODEX_HOME`;
- OpenRouter mode launches the same Codex CLI with a custom `responses` provider at the fixed
  `https://openrouter.ai/api/v1` base URL and the matching user's leased key;
- an owner's existing Codex auth profile is migrated to the owner's connection and remains
  owner-only.

The browser sees `AI недоступен: подключите ChatGPT или OpenRouter в настройках` when a permitted
ManacostTeam user has no active provider. It does not fall back to the owner's profile or a
deployment-wide model key.

## Threat model

### Assets

- Telegram OIDC client secret, authorization code and signed ID token;
- ManacostTeam session cookies and role assignments;
- Codex/ChatGPT credentials, OpenRouter API keys and model capacity;
- conversations, attachments, artifacts and Google OAuth tokens;
- agent/tool grants and administrator actions.

### Trust boundaries and abuse cases

| Boundary | Abuse case | Required control |
| --- | --- | --- |
| Browser → Telegram callback | forged token, replay, login CSRF | RS256/JWKS verification, PKCE, nonce and one-time browser-bound state |
| Telegram profile → authorization | attacker takes an allowed username | authorize only immutable numeric ID |
| Browser → application API | editor calls admin route directly | server-side role guard on every route |
| User A → shared storage | guessed thread/artifact ID exposes user B | actor-scoped queries and negative cross-user tests |
| Application → Codex CLI | prompt asks for auth files or another user's data | filesystem isolation, credential deny rules, scoped workspace |
| Settings → credential vault | key is logged, returned or attached to wrong user | write-only API, encryption, actor binding, redaction |
| Codex CLI → OpenRouter | key leaks into a shell or arbitrary host is selected | fixed HTTPS origin, stripped shell env, single-use lease |
| Codex CLI → tools | model fabricates a privileged tool call | server-enforced actor, agent grant, policy and confirmation |
| One user → shared capacity | unbounded runs deny service or consume quota | per-user/global concurrency, queue, timeout and usage caps |
| Configuration → production | owner removes their own only access | non-empty owner set, fail-closed boot, tested rollback |

## Tech stack

- TypeScript and Bun in the existing monorepo;
- Hono server and PostgreSQL/Drizzle persistence;
- React/TanStack Router client;
- Better Auth session storage and existing authorization guards;
- Telegram OIDC Authorization Code flow with PKCE and server-side JWT verification;
- existing `agent-codex` AG-UI runtime and Codex CLI process;
- Codex device-code login and Codex custom `responses` provider support;
- OpenRouter Responses API and current-key validation endpoint.

No authentication dependency is added unless the existing crypto and session primitives prove
insufficient during implementation review.

## Commands

Run from `/srv/projects/web/work.kolodahearthstone.com`:

```bash
bun run generate:app-config
bun run format:check
bun run lint
bun run typecheck
bun test server/tests app/tests edge-auth/tests agent-codex/tests
bun run test:ci
bun run build
/home/debian/server/tools/ai-quality/bin/ai-security-check
```

Production verification uses the repository's existing deployment procedure and smoke suite; no
runtime or `/var/www` copy is edited as source.

## Project structure

```text
server/src/auth/                 Telegram verification, session provisioning and actor guards
server/src/credentials.ts        encrypted, actor-bound AI credential references and leases
server/src/db/schema/            identity/session schema only if an additive migration is required
server/tests/                    callback, allowlist, credential, role, replay and cross-user tests
app/src/routes/sign.tsx          ManacostTeam Telegram sign-in screen
app/src/lib/auth/                browser client for the server callback/session only
app/src/routes/_authed/settings/ personal ChatGPT/OpenRouter connection screen
agent-codex/src/                 per-actor runtime admission, provider and isolated profile selection
agent-codex/tests/               provider, secret isolation, no-fallback and cross-user tests
examples/chatgpt/brand.yaml      visible ManacostTeam product identity
docs/runbooks/                   Telegram/BotFather setup, allowlist, revocation and rollback
docs/                            this specification and later approved revisions
docker-compose.production.yml    secret references and removal of public single-user mode
ops/nginx/                       same-origin callback and security headers
```

## Code style

External data is narrowed at the boundary and authorization inputs use explicit types:

```ts
type TelegramSubject = `telegram:${string}`;

function telegramSubject(id: unknown): TelegramSubject {
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) {
    throw new TelegramLoginError("invalid_payload");
  }
  return `telegram:${id}`;
}
```

Names describe security decisions (`verifyTelegramLogin`, `isAllowedTelegramId`) rather than UI
events. Errors returned to the browser are stable and generic; secret values and signed payloads are
never included in logs.

## Testing strategy

### Unit tests

- official signature fixture succeeds;
- modified field, ID or hash fails;
- stale/future/missing `auth_date` fails;
- malformed, zero, negative, decimal and oversized IDs fail;
- constant-time signature path handles unequal-length input safely;
- allowlist and owner subset configuration fail closed;
- personal provider parsing rejects unknown providers and client-supplied credential IDs;
- OpenRouter base URL cannot be changed by a user;
- credential projections never contain secrets.

### Integration tests

- allowlisted owner and editor create distinct users and sessions;
- unknown ID creates neither user nor session;
- replayed state and callback fail;
- revoked/removed ID cannot sign in and existing sessions stop working;
- editor cannot use administrator endpoints;
- editor cannot read owner's channels, artifacts, attachments or Google connection;
- one user's run never resumes another user's Codex thread/profile;
- a missing personal AI connection never falls back to owner credentials;
- ChatGPT device flow is scoped to the initiating user and expires;
- a valid OpenRouter key is stored write-only and an invalid/revoked key is rejected safely;
- replacing/disconnecting a provider retires the old credential and blocks queued runs;
- OpenRouter runs use that user's key and never expose it to Codex shell tools;
- ChatGPT and OpenRouter users can use the same governed agent without sharing provider state.

### Production checks

- owner signs in through Telegram before old edge access is removed;
- direct origin and callback enforce HTTPS, host and trusted-origin rules;
- session cookie is `HttpOnly`, `Secure` and `SameSite=Lax` or stricter;
- login and callback have bounded rate limits;
- owner and editor each complete an isolated harmless run;
- logout and allowlist removal invalidate sessions;
- rollback restores the previous release without losing stored data.

## Boundaries

### Always

- verify Telegram data and allowlist membership on the server;
- authorize every protected resource by the internal actor;
- keep credentials server-side and redact authentication payloads from logs;
- bind every AI credential, login flow and runtime lease to the authenticated actor;
- use additive migrations and preserve the production database;
- run targeted, full, build and security checks before deployment.

### Ask first

- change the PostgreSQL role enum or add a new user-facing role;
- add a dependency or a second Telegram bot;
- move allowlist management from configuration into the database/UI;
- change session duration, rate limits or production origins;
- change the approved one-time binding of the owner's Telegram subject to `dev-local-user`;
- change the owner-configured OpenRouter default model or enable arbitrary model selection;
- deploy and remove the old edge login.

### Never

- authorize by Telegram username, photo, name or client-supplied role;
- accept stale/replayed Telegram login data;
- expose or copy bot, Codex, ChatGPT, Google or internal service credentials;
- return a saved OpenRouter key or ChatGPT auth cache to the browser;
- let an editor inherit the owner's Codex profile when theirs is absent;
- put authentication tokens in localStorage, URLs, tenant YAML, Git or audit payloads;
- disable a failing authorization/security test to ship.

## Success criteria

1. The application is visibly branded ManacostTeam and no public screen asks for ChatGPT login.
2. Only allowlisted numeric Telegram IDs can create a session.
3. At least one configured owner can reach administrator functions after deployment.
4. Two Telegram users have different internal IDs, sessions, threads, artifacts and audit actors.
5. Editor-to-owner data and administrator access tests return 403/404 without revealing existence.
6. Removing/revoking an ID blocks login and invalidates active sessions.
7. Telegram callback replay, signature/claim tampering, PKCE and login-CSRF tests pass.
8. Codex CLI remains the execution engine for both ChatGPT and OpenRouter modes.
9. A user can connect ChatGPT by device code or save a valid OpenRouter key without either secret
   being displayed, logged or exposed to tools.
10. A user without an active personal provider cannot consume the owner's Codex session or a global
    model key.
11. Full tests, build, project quality gate and security check pass before production rollout.
12. Owner and editor production smoke runs are isolated and attributable in audit, including the
    selected provider but excluding secret and prompt content.
13. Rollback is tested before the legacy edge gate is removed.

## Deployment inputs still required

1. Confirm the Telegram bot username to reuse. The token must be installed through protected server
   configuration and must not be pasted into chat or committed.
2. Provide the numeric Telegram owner ID and editor IDs later through the protected operator
   command/runbook.
3. Configure the first OpenRouter default model from the provider's tool-compatible Responses API
   catalog. The application will not guess a model from the user's key.

The approved defaults are a five-minute Telegram payload freshness window, an eight-hour
ManacostTeam session, and a one-time operator binding of the owner's Telegram subject to the
existing `dev-local-user` history.
