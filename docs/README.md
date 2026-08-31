# OpenBot docs

Start with the root [README](../README.md), then use these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Development](development.md): local setup, migrations, ports, and quality checks.
- [Production workspace](production-workspace.md): milestone architecture, Google OAuth values, rollout checklist, smoke tests, and troubleshooting.
- [Coworkers](coworkers.md): durable Bot profiles, channels, visibility, deletion, and external AG-UI registration.
- [Routines](routines.md): standing instructions a Bot runs on a schedule, the worker that fires them, and who they run as.
- [Main Editor → Google Docs runbook](runbooks/editor-google-docs.md): read-only model boundary, review screen, one-time write-back, rollout and troubleshooting.
- [Generated artifacts](artifacts.md): governed Markdown, text, JSON, CSV, SVG, HTML and PDF creation, inert previews, storage, renderer isolation, and operations.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Google Workspace (Drive, Docs and Sheets)](plugins/google-drive.md)
  - [Notion](plugins/notion.md)
- [Deployment](deployment.md): the container, what is in the image, minimum sizes, and the platform notes.
- [Kubernetes](../charts/openbot/README.md): the Helm chart, what a cluster needs before it, and the values that differ per cloud.
- [Releasing](releasing.md): how a release is proposed, reviewed and published.
- Russian production runbooks:
  - [Runtime and security boundaries](production-runtime.ru.md): production topology, authentication, runtime-state ownership, AG-UI streaming, permissions, workspaces, and editor boundaries.
  - [Operations and execution timing](production-operations.ru.md): backup, deployment, rollback, timing phases, troubleshooting, verification, and known limitations.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
