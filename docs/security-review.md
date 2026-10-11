# Security review

Self-review of the product against section 10 of the design document (*Sécurité et confiance*),
with the evidence for each point. Updated at the end of every phase; open items name the phase
that closes them.

Last review: 2026-10-11 (end of phase 5 — foundation stabilised).

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Every authorisation is checked server-side, per resource and workspace. | ✅ | Central layer `core/authz.py` (`load_in_workspace`, `workspace_access`, one `Permission` per action, role matrix). No route reads a resource without it. |
| 2 | No cross-workspace access (IDOR, multi-tenant leaks). | ✅ | `tests/test_isolation.py`: every workspace route and every resource route called by the owner of another workspace answers 404; mixed identifiers, service keys of another workspace, data untouched afterwards. Two guards fail the build if a route escapes the suite (they read the published route table). |
| 3 | Provider keys never returned to the browser after saving. | ✅ | Write-only fields; responses carry `secret_set` and a 4-character hint. Tests assert no key material in provider and tool responses. |
| 4 | Secrets encrypted at rest with a key outside the database; rotation documented. | ✅ | AES-256-GCM with associated data per row, key ring in `ENCRYPTION_KEYS` (environment), `gouvra rotate-secrets`; procedure in `docs/operations.md`. |
| 5 | Never run user-supplied code in the API process. | ✅ | Code tools only run in the sandbox service, one throwaway container per call (`sandbox/runner.py`); without a configured sandbox they are refused. The calculator parses an AST whitelist — no `eval`. |
| 6 | Tools are privileged capabilities: allow-list, validation, time-outs, quotas, isolation. | ✅ / ⏳ | Per-agent allow-list; strict JSON Schema arguments (closed objects); per-tool time-outs; per-execution tool-call limit; HTTP tools restricted to allow-listed hosts with DNS-rebinding and private-network protection (`core/netguard.py`, `tools/http_client.py`). Code tools: container with no network by default, read-only root, `nobody`, no capability, `no-new-privileges`, memory/CPU/PIDs/time limits — each property verified against a real Docker daemon (`tests/test_sandbox.py`). |
| 7 | Limits on size, duration, concurrency and consumption. | ✅ / ⏳ | Request bodies (`BodySizeLimitMiddleware`), execution input size, time-outs (agent and instance maximum), workspace concurrency, launch rate limit, per-agent token and cost caps. ⏳ Workspace budgets and plan quotas: phase 9. |
| 8 | Secrets and personal data filtered from logs. | ✅ | `core/logging.py` redacts sensitive keys, credential-shaped values and e-mail addresses (tested); usage counters are explicitly kept. Execution events are redacted and size-capped before storage. |
| 9 | Webhook signatures verified, processing idempotent. | ⏳ | Inbound webhooks arrive in phase 8 (automation) and Stripe webhooks in phase 9 (billing). Execution launches already honour `Idempotency-Key`. |
| 10 | Backups, tested restore, retention policy, responsible disclosure. | ✅ / ⏳ | `scripts/backup` (verified dumps) and `scripts/restore`, round trip tested on 2026-10-11 (identical row counts and schema version); `SECURITY.md` disclosure process. ⏳ Retention policies: phase 9. |

## Other controls reviewed

- **Authentication**: Argon2id; common passwords refused; sign-up and reset without account
  enumeration; sessions in `__Host-` HttpOnly Secure SameSite cookies, rotated, revocable;
  OAuth with PKCE and signed state; verified e-mail required to link an OAuth identity.
- **CSRF and origins**: tokens bound to the session plus an Origin check on every unsafe request —
  verified through the production proxy (a foreign `Origin` gets 403).
- **Rate limiting**: sign-in (per account and per address), sign-up, e-mail links, resets,
  invitations, execution launches (sliding windows in Valkey).
- **Headers**: strict CSP for the interface and the API reference (no third-party code, Swagger UI
  vendored), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, COOP/CORP, HSTS in production.
- **Redirects**: post-sign-in `next` accepts same-origin paths only; e-mail links carry their
  one-time tokens in the URL fragment (never sent to servers or logged).
- **E-mail rendering**: every user-provided value is HTML-escaped.
- **Containers (production)**: non-root API image, read-only root file systems, all Linux
  capabilities dropped (Caddy keeps only `NET_BIND_SERVICE`), `no-new-privileges`, database and
  queue on a network without outside access.
- **Sandbox**: the sandbox process receives only its own settings (no database, session or
  encryption secret); it is reachable only on an internal network shared with the API and the
  worker, and authenticates every call with a 32+ character token (constant-time comparison).
  It reaches Docker through `docker-socket-proxy`, which refuses every API section but
  containers and images (exec, volumes, networks, swarm, secrets, build: 403). *Residual risk*:
  the containers API itself would let a compromised sandbox process start a privileged
  container; the sandbox is a small, single-purpose service that builds every container spec
  itself, and hosts that need more can set `SANDBOX_RUNTIME=runsc` (gVisor) or run Docker
  rootless.
- **Dependencies**: `pip-audit` (production requirements) and `pnpm audit` report no known
  vulnerability on 2026-10-11.

## Open items

| Item | Closes in |
|---|---|
| Signed, idempotent inbound webhooks | Phase 8 |
| Stripe webhook signature verification, budgets, quotas, retention policies | Phase 9 |
| Full re-review of the finished product | Phase 10 |
