# Contributing to Gouvra

Thank you for helping! This guide explains how to set up the project, the conventions we follow
and what "done" means for a change.

## Set up

```bash
scripts/gen-secrets && docker compose up -d postgres valkey mailpit   # services for tests
cd api && uv sync && uv run pytest                                     # API (Python 3.13, uv)
cd web && pnpm install && pnpm dev                                      # interface (Node 24, pnpm)
```

The full stack (`docker compose up -d`) is needed for the end-to-end tests (`cd web && pnpm e2e`).

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(api): …`, `fix(web): …`, `docs: …`), one logical change per commit, with a body that
  explains the *why* when it is not obvious.
- **API**: typed everywhere (mypy strict), Ruff for lint and format, errors as Problem Details with
  stable codes, every new route authorised through `load_in_workspace()` / `workspace_access()`.
- **Interface**: design tokens only (no hard-coded colours), components from `components/ui`,
  every visible string in both `locales/en` and `locales/fr` (a test checks parity), server data
  through TanStack Query, animations on `transform`/`opacity` with a reduced-motion fallback.
- **Decisions** that shape the product go in `DECISIONS.md` with a one-line reason.

## Definition of done

A change is ready when `scripts/ci-local` passes, which includes:

1. Ruff, mypy, ESLint (strict + jsx-a11y), Prettier and TypeScript with zero errors or warnings.
2. Tests: unit and integration on a real PostgreSQL; ≥ 80 % backend coverage; a new
   `/workspaces/...` or resource route is added to `tests/test_isolation.py` (a guard fails
   otherwise); new screens get a Playwright journey and an axe audit at three widths.
3. Migrations upgrade, downgrade and pass `alembic check`; `docs/api/openapi.json` and the
   generated web types are up to date.
4. No high-severity issue from `pip-audit` or `pnpm audit`.
5. Screenshots of changed screens reviewed in light and dark themes on desktop, tablet and mobile.

## Reporting bugs and security issues

Open an issue with steps to reproduce and the diagnostic ID shown by the interface. Security
issues follow [SECURITY.md](SECURITY.md) instead.

By contributing you agree that your contributions are licensed under Apache-2.0 and that you
follow our [Code of Conduct](CODE_OF_CONDUCT.md).
