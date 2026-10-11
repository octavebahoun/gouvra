# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/octavebahoun/gouvra/security/advisories/new) with:

- the affected version or commit, and the component (API, worker, interface, deployment files);
- steps to reproduce, or a proof of concept limited to your own test instance;
- the impact you observed.

We acknowledge reports within 3 working days, share a first assessment within 10, and agree on a
disclosure date with you. Fixes are released as soon as they are ready and credited in the
changelog unless you prefer otherwise. Please give us a reasonable time to fix before disclosure,
and never access data that is not yours or degrade a service you do not own.

## Supported versions

Security fixes are made on the latest release. Upgrade with `scripts/backup` then the steps in
[`docs/operations.md`](docs/operations.md#upgrading).

## Security model, in short

- Every request is authorised server-side by a central layer; resources are scoped to a
  workspace and a foreign identifier answers 404. An automated suite proves it for every route.
- Passwords: Argon2id, common and easy-to-guess passwords refused, no account enumeration. Sessions:
  `__Host-` HttpOnly Secure SameSite cookies, rotated, revocable; CSRF tokens bound to the session
  plus Origin checks. OAuth with PKCE and signed state.
- Secrets at rest (provider keys, tool credentials): AES-256-GCM with a rotating key ring; they
  are write-only through the API and never logged (structured logs are redacted).
- Tools: arguments validated against strict JSON Schemas; HTTP tools only reach allow-listed hosts,
  with DNS rebinding and private-network protection; untrusted code runs in an isolated sandbox,
  never in the API or the worker.
- Rate limits on authentication, e-mail links, invitations and execution launches; request body
  size limits; strict Content-Security-Policy and security headers; HTTPS with HSTS in production.

## Hardening checklist for operators

- Run with `APP_ENV=production` (the API refuses unsafe settings) behind the provided Caddy setup.
- Keep `.env` readable by the operator only; store `ENCRYPTION_KEYS` separately from backups.
- Rotate keys as described in the operations guide; restrict SSH and the Docker socket.
- Set `SIGNUP_ENABLED=false` for private instances and invite people instead.
