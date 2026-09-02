# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, folder, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                            |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Product editor

Common coworker settings are managed on `/agents`; editing YAML is not required. The create screen
offers eight ordinary defaults: Researcher, Editor, Developer, Data Monitor, SEO, Designer, Support
and General Assistant. A template fills presentation, role, model and reasoning defaults only. It
never grants tools, copies secrets or connects somebody's OAuth account.

The editor controls name, deterministic avatar, title, standing role, model, visibility and the
optional external AG-UI endpoint/key. Skills, exact tool grants, Google Drive/Docs/Sheets access and
delegation remain explicit governed controls on the saved coworker's profile.

### Folders

Each coworker may have one optional folder, such as `Технический контроль` or `Редакция`. The roster
groups the signed-in user's coworkers by this value and puts empty values in `Без папки`. Folders are
labels only: they do not change visibility, grants, routing or the permissions of a coworker.

Reasoning may use a fixed bounded effort or `Adaptive`. Adaptive classifies only the current user
turn into low/medium/high/xhigh and clamps it to the configured ceiling before forwarding the run.
It does not make a second model call, log the request or let the model select an unbounded effort.
The managed provider is OpenAI in this deployment; administrators may enter supported custom model
identifiers, while ordinary users choose from the published model list.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be edited or deleted through the product.

## Channels

Starting a channel creates a new conversation and Intelligence thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

That is `agent-langgraph`, which runs a real framework and its own tool loop. The proof-of-concept on
`4200` hand-writes the protocol and leaves the loop to whatever is watching, so it is a reference
rather than something to build a deployment on.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: product-created coworkers
then need their own endpoint, and a package agent whose endpoint expands to nothing is omitted
rather than registered against a missing host. A leftover token with no URL is ignored.
Package-provided agents otherwise use their own `agents.yaml` configuration.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create or edit a coworker from `/agents` and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot by administrators;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).

## Embed a coworker on a website

An owner or administrator can open a coworker's profile and choose **Встраивание на сайт**. Issuing
the credential returns an `obot_embed_…` token once; only its SHA-256 hash is stored. Issuing again
rotates the old credential, and **Отозвать доступ** invalidates it immediately.

The website sends the standard AG-UI run request to:

```text
POST https://work.kolodahearthstone.com/api/copilotkit/agent/{agentId}/run
```

and includes either `x-manacost-embed-token: obot_embed_…` or
`Authorization: Bearer obot_embed_…`. The response is an AG-UI server-sent event stream. The token is
scoped to the `{agentId}` in the URL; it cannot be used for another coworker, the callback-tools
endpoint, administration or a different user's data. The runtime mounts only that coworker for a
scoped request and does not add cross-coworker handoff/escalation tools. Existing visibility,
personal AI connection, tool grants, audit and run limits still apply to the owner's run.

The body is the normal AG-UI `RunAgentInput` (for example `threadId`, `runId`, `messages`, `state`,
`tools`, `context` and `forwardedProps`). Use the AG-UI client for parsing the event stream rather
than assuming one JSON response.

Browser origins are deny-by-default. Add a comma-separated list to `AGENT_EMBED_ALLOWED_ORIGINS` and
redeploy; the deployment's own app/public origins remain allowed. Wildcards are not accepted. A
server-to-server integration can omit this setting because it does not send an `Origin` header.

Treat the token like a password: keep it server-side where possible, rotate it after exposure, and
never commit it to a site bundle or source control.
