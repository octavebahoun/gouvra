# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `PROVIDER_ALLOW_PRIVATE_NETWORKS` and `HTTP_TOOL_ALLOW_PRIVATE_NETWORKS` now reach the
  containers, so a model served on your own network (Ollama, LM Studio, vLLM) can be used with
  Docker Compose; the *Ollama* preset points at the host machine (`host.docker.internal`).
- A refused private address names the setting that would allow it.

### Security
- Allowing private networks never opens link-local, cloud metadata, multicast or reserved
  addresses.

## [0.1.0] — 2026-10-12

First release — see [RELEASE_NOTES.md](RELEASE_NOTES.md) for what was verified and the known
limitations.

### Added
- Accounts: sign-up without account enumeration, e-mail confirmation, sign-in with e-mail,
  GitHub or Google, password reset, sessions you can review and revoke, profile and preferences.
- Workspaces with roles, invitations, ownership transfer, service keys, execution limits and an
  audit log; onboarding with a setup checklist.
- Model providers (DeepSeek, Anthropic, OpenAI-compatible, offline scripted model) with encrypted
  keys, connection tests and a model catalogue with published prices.
- Tools: built-ins, custom HTTP tools with strict schemas, a test console and call history.
- Agents with versions, readiness checks, duplication, archiving and restore.
- Executions: asynchronous queue with leases, limits, cancellation, retries, live traces over
  Server-Sent Events with token streaming, failure diagnosis and JSON export.
- Overview and usage with cost provenance (reported, estimated, unavailable), by agent and model.
- Evaluations: suites, cases (with JSON import), graders (exact, contains, regex, JSON Schema, LLM
  judge) with a live try-out, runs on a version or a variant (model, provider, instructions) with
  results arriving live, and a case-by-case comparison of two runs.
- Workflows: a visual editor (agents, tools, conditions, transforms, outputs) with checked
  templates, autosave with conflict detection, undo and redo; draft test runs, published versions
  and restores; runs drawn live on the graph, step by step, with each step's input and output.
- Code tools (Python, JavaScript) run in a separate sandbox service: one throwaway container per
  call, without network, read-only, unprivileged and limited, through a filtered Docker socket.
- Automations: cron schedules in any time zone and signed, idempotent inbound webhooks (Gouvra's
  timestamped signature or GitHub's) starting agents or workflows, with a delivery log, overlap
  control and automatic pause after repeated failures.
- Connectors (Slack, Discord, GitHub, signed outgoing webhooks) whose operations become tools,
  and a registry of models and tools with prices and usage.
- Plans and billing for running Gouvra as a service: Free, Team and Business plans with monthly
  run quotas and resource limits, Stripe Checkout and customer portal (test mode supported), a
  simulated mode without any card, and an unlimited Self-hosted plan when billing is off.
- Monthly budgets with alert thresholds and an optional hard stop, quota and payment alerts by
  e-mail, data retention per workspace, configuration export without secrets and CSV exports.
- Instance administration for super-admins: totals, workspaces (suspend, grant a plan), accounts
  (disable) and the instance-wide audit log.
- Public site, English and French interface, light and dark themes, accessibility audits.
- Production deployment with automatic HTTPS, backups and restores, secret rotation commands.
- A labelled demo workspace, seeded at start-up, that shows every part of the product (agents,
  executions, an evaluation suite, a workflow, automations, a budget) on the offline model.
