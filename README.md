# Gouvra

**The open-source control room for AI agents** — build, run, evaluate and supervise agents,
with every model call, tool call, token and cost traced.

> Status: under active construction. See `PROGRESS.md`.

## Quick start (local)

```bash
cp .env.example .env        # optional: add provider / e-mail keys
scripts/gen-secrets         # generates every internal secret into .env
docker compose up -d        # api, worker, web, postgres, valkey, mailpit
```

- App: http://localhost:8080 — API docs: http://localhost:8080/api/docs
- Captured e-mails (Mailpit): http://localhost:8025

## Licence

Apache-2.0 — see `LICENSE`.
