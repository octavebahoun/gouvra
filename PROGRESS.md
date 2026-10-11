# PROGRESS — Gouvra

> À relire au début de chaque session, avec `DECISIONS.md` et `BRIEF.md`.

## État

- **Phase en cours : 1 — Fondations**
- **Tâche suivante :** squelette backend (config, logs, DB, erreurs, health), squelette web (tokens, shell, composants de base), Docker Compose, CI.

## Étape 0 — fait (2026-10-11)

- Documents convertis : `docs/conception.md`, `docs/ui.md` (pandoc 3.6.1), lus en entier.
- Nom choisi : **Gouvra** (D-001).
- Message unique envoyé à l'utilisateur : démarrer Docker, assets de marque, OAuth/Anthropic optionnels, dépôt GitHub pour la CI. Valeurs par défaut : D-052.

## Phases

| # | Phase | État | Critère de sortie |
|---|---|---|---|
| 1 | Fondations | en cours | `docker compose up` démarre tout, CI verte |
| 2 | Identité | à faire | Tests des flux + isolation inter-workspace verts |
| 3 | Agent simple | à faire | Une exécution réelle, tracée de bout en bout |
| 4 | Exploitation | à faire | Diagnostic d'un échec depuis l'UI |
| 5 | Stabilisation du socle | à faire | Section 9 du brief validée sur le socle |
| 6 | Évaluations | à faire | Comparaison de deux versions d'agent |
| 7 | Workflows | à faire | Workflow multi-étapes exécuté et visualisé en direct |
| 8 | Automatisation | à faire | Tâche planifiée et webhook signé testés |
| 9 | SaaS | à faire | Parcours d'abonnement testé en mode test |
| 10 | Release finale | à faire | Section 9 validée sur tout le produit |

## Problèmes ouverts

- Démon Docker arrêté sur la machine (besoin de `sudo`) — en attente de l'utilisateur.
- `pandoc`, `stripe` CLI absents du système : pandoc récupéré via `pypandoc_binary` (lien `~/.local/bin/pandoc`) ; Stripe CLI à télécharger (phase 9).

## Journal de vérification

_(rempli à chaque fin de phase : lint, typage, tests, couverture, compose à froid, E2E, captures, axe, audits dépendances, relecture sécurité)_
