# PROGRESS — Gouvra

> À relire au début de chaque session, avec `DECISIONS.md` et `BRIEF.md`.

## État

- **Backend terminé et commité pour les phases 2, 3, 4 et 6.** Écrans web : phase 2 en cours (sous-agent), phases 3, 4 et 6 à faire.
- **Tâche suivante :** relire le travail web du sous-agent (captures, a11y), puis écrans : Providers (O), Tools (N), Agents (H, I, J), lancement (K), Executions (L), détail d'exécution animé (M), Overview (G), Usage (P), Évaluations.

## Brief mis à jour — 2026-10-11 03:56 (relu en entier)

- Changements intégrés : OAuth GitHub + Google avec callbacks sur `http://localhost:8000` (D-053), variables OAuth dans la liste officielle, bouton masqué si une variable manque.
- Variables vérifiées dans le conteneur API avec `gouvra check-config --live` (valeurs jamais affichées) :

| Variable | Lue | Format | Contrôle réel (lecture seule) |
|---|---|---|---|
| RESEND_API_KEY | oui | ok | clé valide, domaine expéditeur **verified** |
| EMAIL_FROM | oui | ok | — |
| DEEPSEEK_API_KEY | oui | ok | valide, 2 modèles (`deepseek-flash`, `deepseek-v4-pro`), solde disponible |
| STRIPE_SECRET_KEY | oui | ok (sk_test_) | valide, `livemode=false` |
| STRIPE_PUBLISHABLE_KEY | oui | ok (pk_test_) | — |
| GITHUB_CLIENT_ID / SECRET | oui | ok | client id reconnu par GitHub |
| GOOGLE_CLIENT_ID / SECRET | oui | ok | — (testé au premier parcours OAuth) |
| STRIPE_WEBHOOK_SECRET | non | — | à obtenir via Stripe CLI (phase 9) |
| ANTHROPIC_API_KEY | non (optionnel) | — | adaptateur testé par contrat (D-052) |

- Plan adapté : phase 2 inclut OAuth GitHub **et** Google de bout en bout.

## Étape 0 — fait (2026-10-11)

- Documents convertis : `docs/conception.md`, `docs/ui.md` (pandoc 3.6.1), lus en entier.
- Nom choisi : **Gouvra** (D-001).
- Message unique envoyé à l'utilisateur : démarrer Docker, assets de marque, OAuth/Anthropic optionnels, dépôt GitHub pour la CI. Valeurs par défaut : D-052.

## Phases

| # | Phase | État | Critère de sortie |
|---|---|---|---|
| 1 | Fondations | **fait** (2026-10-11) | `docker compose up` démarre tout, CI verte |
| 2 | Identité | backend **fait** ; web en cours | Tests des flux + isolation inter-workspace verts |
| 3 | Agent simple | backend **fait** (exécution réelle DeepSeek OK) ; web à faire | Une exécution réelle, tracée de bout en bout |
| 4 | Exploitation | backend **fait** (vue d'ensemble, usage, stats, audit, export, limites) ; web à faire | Diagnostic d'un échec depuis l'UI |
| 5 | Stabilisation du socle | à faire | Section 9 du brief validée sur le socle |
| 6 | Évaluations | backend **fait** (comparaison v1/v2 vérifiée par l'API) ; web à faire | Comparaison de deux versions d'agent |
| 7 | Workflows | à faire | Workflow multi-étapes exécuté et visualisé en direct |
| 8 | Automatisation | à faire | Tâche planifiée et webhook signé testés |
| 9 | SaaS | à faire | Parcours d'abonnement testé en mode test |
| 10 | Release finale | à faire | Section 9 validée sur tout le produit |

## Problèmes ouverts

- Swagger UI (`/api/docs`) charge ses assets depuis un CDN : à auto-héberger (phase 5).
- `pandoc`, `stripe` CLI absents du système : pandoc récupéré via `pypandoc_binary` (lien `~/.local/bin/pandoc`) ; Stripe CLI à télécharger (phase 9).

## Journal de vérification

### Phase 1 — 2026-10-11
- API : ruff format/check ✔, mypy strict ✔ (25 fichiers), pytest 14/14 ✔ sur PostgreSQL 17 + Valkey réels, couverture 90 %.
- Web : prettier ✔, eslint (strict type-checked + jsx-a11y strict) ✔ 0 avertissement, tsc ✔, vitest 8/8 ✔, build ✔.
- Audits : pip-audit « No known vulnerabilities », pnpm audit (high) « No known vulnerabilities ».
- `docker compose up -d` : postgres, valkey, mailpit, migrate (exit 0), api (healthy, /readyz = ready, migrations à jour), worker (healthy, heartbeat), web (healthy, CSP stricte, fallback SPA).
- Captures design system clair/sombre + landing mobile relues : bug `asChild` (fragment) corrigé, police inlinée en data: bloquée par la CSP corrigée (`assetsInlineLimit: 0`).
- CI GitHub Actions écrite ; rejouée en local à l'identique via `scripts/ci-local` (pas de dépôt distant, D-052).

### Phase 2 (backend) — 2026-10-11
- 102 tests : flux d'inscription non énumérable, vérification, connexion/déconnexion, cookies `__Host-` HttpOnly/Secure/SameSite, CSRF + Origin (dont « login CSRF »), rotation de session avec délai de grâce, révocation, mot de passe oublié/réinitialisation (sessions révoquées + avertissement), changement d'e-mail, limitation de débit (login, reset), absence de secrets/e-mails dans les logs, OAuth GitHub/Google simulés (PKCE, state, protection contre la pré-inscription), workspaces, rôles, invitations, transfert de propriété, clés de service, audit.
- Isolation : chaque route de workspace testée par un propriétaire d'un autre workspace ⇒ 404 ; garde-fou qui échoue si une nouvelle route n'est pas couverte.
- E-mail réel via Resend vers `delivered@resend.dev` ✔ ; SMTP → Mailpit ✔ ; chaîne complète en Docker (API → outbox → worker → Mailpit) ✔.

### Phase 3 (backend) — 2026-10-11
- 213 tests (hors réels), couverture 86 %, mypy strict 101 fichiers, ruff ✔, migrations montée/descente/remontée ✔ et `alembic check` ✔.
- Tests réels : appel d'outil DeepSeek avec et sans réflexion + streaming ✔ ; exécution complète via le moteur (fournisseur testé, agent + calculatrice, résultat 7006652, coût estimé USD > 0, trace ordonnée) ✔.
- Stack Docker : exécution réelle traitée par le worker conteneurisé, SSE en direct (événements + 7 fragments de texte), coût 0,00016 $ ✔. Bug trouvé et corrigé à cette occasion : le worker n'importait pas tous les modèles (clé étrangère non résolue) ; le « reaper » avait bien rattrapé l'exécution. Test de démarrage de processus ajouté.
- Isolation étendue : 55 tests anti-IDOR (routes de workspace, routes par ressource fournisseurs/outils/agents/exécutions, mélange d'identifiants, clés de service d'un autre workspace) + garde-fous de couverture.

### Phase 4 (backend) + démo — 2026-10-11
- Vue d'ensemble, agrégats d'usage avec provenance des coûts, stats par agent, journal d'audit, export d'exécution, historique des appels d'outil, limites de workspace.
- `gouvra seed-demo` : compte et workspace étiquetés « demo », 36 exécutions scriptées étalées sur 14 jours, 2 exécutions DeepSeek réelles, 1 en file ; idempotent. `gouvra rotate-secrets` (rotation de clé de chiffrement) et `gouvra create-superadmin`.

### Phase 6 (backend) — 2026-10-11
- 260 tests (hors réels) ✔, couverture 87 %, mypy strict 115 fichiers ✔, ruff ✔ ; migration 0004 montée / `alembic check` / descente complète / remontée ✔ sur base vierge.
- Critère de sortie (côté API) : une suite lancée sur la v1 (texte) puis la v2 (mode JSON) d'un agent ⇒ 0 % puis 100 % de réussite, comparaison « 3 améliorés, 0 régressé » ✔.
- Juge réel DeepSeek (`deepseek-flash`) ✔ ; ReDoS coupé à 0,5 s ✔ ; annulation d'un run ✔ ; worker de notation réveillé par le moteur ✔.
- **Correction honnête du journal phase 2/3** : le garde-fou « toute nouvelle route doit être couverte » ne vérifiait plus rien depuis FastAPI 0.143 (D-088). Réparé ; toutes les routes existantes étaient bien couvertes (isolation : 78 tests ✔).

