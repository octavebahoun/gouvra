# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Evaluations API: suites, cases, graders (exact, contains, regex, JSON Schema, LLM judge), runs
  on versions or variants, case-by-case comparison.
- Public site, English and French interface, light and dark themes, accessibility audits.
- Production deployment with automatic HTTPS, backups and restores, secret rotation commands.
