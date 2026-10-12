# Gouvra 0.1.0 — release notes

*12 October 2026.* The first release of Gouvra, the open-source control room for AI agents:
build agents on the models you choose, give them only the tools they need, run them in the
background, watch every step live, evaluate them, chain them, schedule them — and, if you run
Gouvra as a service, bill for it.

## What is delivered

Every feature of sections 5.1 and 5.2 of the design document, and every screen (A to T) of the
interface specification, plus the screens the later phases called for.

| Area | Delivered |
|---|---|
| Accounts | Sign-up without account enumeration, e-mail confirmation, sign-in with e-mail, GitHub or Google (PKCE, signed state), password reset, sessions to review and revoke, profile and preferences (language, theme). |
| Workspaces | Roles (owner, admin, member, viewer) enforced on the server, invitations, ownership transfer, service keys, limits, audit log, onboarding checklist. |
| Providers and models | DeepSeek (official API, tested live), Anthropic, any OpenAI-compatible API, and a deterministic offline model; keys sealed with AES-256-GCM and never returned; connection tests; a catalogue with published prices. |
| Tools | Built-ins, HTTP tools restricted to allow-listed hosts, code tools (Python, JavaScript) run in throwaway, locked-down containers by a separate sandbox service; strict schemas, a test console, call history. |
| Agents | Versions with restore, readiness checks, duplication, archiving, limits (turns, tool calls, tokens, cost, time). |
| Executions | A queue with leases, concurrency and rate limits, cancellation, retries, idempotent launches; live traces with token streaming; failures explained (cause, next action, code); JSON export. |
| Usage | Tokens and costs by period, agent and model, with the provenance of every figure (reported, estimated, unavailable). |
| Evaluations | Suites, cases (JSON import), graders (exact, contains, regex, JSON Schema, LLM judge), runs on a version or a variant, case-by-case comparison of two runs. |
| Workflows | A visual editor (agents, tools, conditions, transforms) with checked templates, autosave with conflict detection, undo; draft tests, published versions; runs drawn live on the graph. |
| Automations | Cron schedules in any time zone; signed, idempotent inbound webhooks (Gouvra's or GitHub's format); delivery log; automatic pause after repeated failures. |
| Connectors and registry | Slack, Discord, GitHub and signed outgoing webhooks, whose operations become tools; a registry of models (with prices) and tools, and of the agents that use them. |
| Running Gouvra as a service | Free, Team and Business plans with monthly quotas and limits; Stripe Checkout and customer portal (test mode supported) or a simulated mode; monthly budgets with alerts and an optional hard stop; retention per workspace; exports without secrets; an instance administration console. Billing is off by default when self-hosting. |
| Operations | `docker compose up` for a complete local stack with a labelled demo; `docker-compose.prod.yml` with Caddy (automatic HTTPS), a separate worker and persistent volumes; backups and restores; secret rotation; configuration checks that never print a value. |
| Interface | English and French, light and dark themes, responsive from phone to desktop, keyboard paths, WCAG 2.2 AA targets, motion that carries information (and stays still for those who ask). |

## How it was verified

The release was verified on the **committed code only** (a clean checkout, built into its own
Docker Compose project on **empty volumes**), not on a developer's working tree.

| Check | Result |
|---|---|
| Cold start | Every service healthy 25 s after `up`; migrations to revision 0008; demo seeded (labelled), including two real DeepSeek executions; the worker then completed the demo's evaluation runs (75 % — one case fails on purpose) and its workflow run. |
| Static checks | Ruff, mypy (strict), ESLint (strict type-checked + jsx-a11y), Prettier and TypeScript: no error. |
| Backend tests | 374 tests on a real PostgreSQL and Valkey, coverage 89 % (target ≥ 80 %), including tenant isolation on every route, an anonymous call to every route (only 14 reviewed routes answer without credentials), Stripe events signed like Stripe signs them, and the sandbox against a real Docker daemon. |
| Frontend tests | 52 unit tests (design system, translations parity, workflow graph rules, route transitions). |
| End-to-end | **70/70** Playwright tests on the production build: 34 on desktop (every journey — sign-up to a traced execution, diagnosis, evaluations, workflows, automations, a subscription through the real Stripe Checkout in test mode with the event relayed by the Stripe CLI, budgets, retention, exports, administration — and the accessibility audit of every screen) and 36 at tablet and phone widths. |
| Accessibility | axe on every screen at three widths and in both themes: no serious or critical violation. |
| Screens | Every screen was captured at three widths and in both themes in the phase that built it, reviewed and corrected; the screens this release changed (billing, data, administration, usage) were captured and reviewed again, and the README images retaken from the release build's demo. |
| Backup and restore | A backup, a change, then a restore: identical row counts on thirteen tables, same schema version, the change undone, the API ready and the demo intact. |
| Dependencies | `pip-audit` (production requirements) and `pnpm audit`, on 12 October 2026: no known vulnerability. |
| Security review | [`docs/security-review.md`](docs/security-review.md): the ten requirements of the design document are met, with their evidence. |

The release review found and fixed, before this release: a page that could stay empty after a
navigation (the next page waited for the previous one's exit animation), line breaks from a name
reaching an e-mail subject, instance lists and an agent's version history querying the database
once per row, the `create-superadmin` command crashing, the exports module hidden from git by an
ignore rule, an out-of-memory kill reported as "no result", and long lists taking seconds to
settle.

## Known limitations

- **Scale.** Built and tested for a single instance (API, worker and database on one host).
  Workers can be added (the queue uses `SKIP LOCKED`), but no load test was run and high
  availability is not documented. A few lists (automations, workflows, evaluation suites,
  connections, tools) still make one or two queries per row — fine at the sizes the plans allow.
- **Providers.** DeepSeek is tested against the real API; the Anthropic and OpenAI-compatible
  adapters are tested against their documented contracts.
- **Code sandbox.** The Docker socket proxy only opens the containers and images API, which
  remains powerful: for untrusted multi-tenant code, run the sandbox with gVisor
  (`SANDBOX_RUNTIME=runsc`) or rootless Docker.
- **Billing.** Stripe only (or the simulated mode); prices in US dollars; plan limits are defined
  in code; no tax handling (Stripe Tax can be enabled on the Stripe side); invoices are in the
  Stripe portal, not in Gouvra.
- **Alerts** reach owners and admins by e-mail and in the interface; there is no Slack or
  webhook alert channel yet.
- **Languages**: English and French.

## Suggested next steps

1. Load tests and a documented high-availability deployment (several API and worker replicas,
   managed PostgreSQL), then batch the remaining per-row list queries.
2. Alert channels through the existing connectors (Slack, webhook), and alerts on failure rates.
3. Single sign-on for organisations (OIDC, then SAML) and SCIM provisioning.
4. More providers (Gemini, Mistral, local models through Ollama) and tracing of their cached
   tokens.
5. Agent and workflow templates that can be shared between workspaces.
6. Annual plans, taxes and invoices in the interface for SaaS operators.
