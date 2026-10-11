# DECISIONS — Gouvra

Chaque choix technique ou produit, avec sa raison. Le plus récent en bas de chaque section.
Priorité en cas de conflit : `BRIEF.md` > `docs/ui.md` / `docs/conception.md` > préférences.

## Produit

- **D-001 — Nom : Gouvra.** Du français *gouverner* (« gouverner un navire » = tenir la barre ; *gouvernail*, *gouverne*), lui-même du latin *gubernare* et du grec *kybernân* : « piloter ». En anglais, la même racine donne *govern* / *governance* — double sens utile : on pilote ses agents et on les gouverne (permissions, budgets, quotas). 6 lettres, 2 syllabes, se prononce « gou-vra » / « GOO-vruh ». Vérifié le 2026-10-11 : aucun produit tech connu à ce nom (recherche web), et `gouvra` est libre sur npm, PyPI, GitHub (utilisateur/organisation), `gouvra.com`, `gouvra.dev`, `gouvra.io` (requêtes RDAP Verisign / Google Registry / Identity Digital → 404). Écartés : Aileron, Timon, Auriga, Pitwall, Kelpie (noms pris partout), Octant (outil VMware), Nacelle (plateforme e-commerce), Diriga/Navarq (comptes GitHub pris).
- **D-002 — « AgentHub » remplacé partout** par Gouvra (code, UI, logo, docs, packages, images Docker). Les documents de cadrage convertis (`docs/conception.md`, `docs/ui.md`) gardent leur contenu ; un bandeau en tête rappelle que « AgentHub » était le nom de travail.
- **D-003 — Workspace = organisation (tenant).** Un utilisateur appartient à plusieurs workspaces ; la facturation, les quotas, les budgets et la rétention s'appliquent au workspace. « Administration multi-organisation » = panneau super-admin qui gère tous les workspaces et utilisateurs de l'instance.
- **D-004 — Langue de l'interface : anglais par défaut + français complet**, i18n dès le départ (i18next, textes dans `web/src/locales/*.json`). Détection de la langue du navigateur, choix mémorisé dans le profil. E-mails transactionnels dans la langue de l'utilisateur.
- **D-005 — Licence Apache-2.0.** Permissive (adoption, contributions), avec concession de brevets explicite ; compatible avec toutes les dépendances retenues (MIT/BSD/Apache). Le module SaaS fait partie du dépôt mais reste désactivé par défaut en auto-hébergement (`BILLING_PROVIDER=none`).
- **D-006 — Thème clair par défaut, sombre disponible** (choix mémorisé côté serveur dans les préférences + `localStorage` pour éviter le flash au chargement).
- **D-007 — Densité : modérée-élevée** (outil pour développeurs), hiérarchie typographique nette, texte courant 14 px, jamais sous 12 px.

## Architecture

- **D-010 — Monolithe modulaire + worker séparé** (même code Python, deux points d'entrée), conformément à `conception.md` §7. Pas de microservices. Un troisième processus, `sandbox`, n'exécute que du code non fiable dans des conteneurs éphémères (voir D-035).
- **D-011 — Backend : Python 3.13, FastAPI, Pydantic v2, SQLAlchemy 2 (async) + asyncpg, Alembic.** Stack de `conception.md`. SQLAlchemy 2 typé + Alembic = migrations versionnées et réversibles.
- **D-012 — File d'exécution sur PostgreSQL (`FOR UPDATE SKIP LOCKED`) plutôt que Celery.** Raisons : (1) la mise en file est transactionnelle avec la création de l'exécution (jamais d'exécution « créée mais pas en file ») ; (2) le moteur est 100 % asyncio, mal servi par Celery ; (3) il faut des limites de concurrence *par workspace*, l'annulation d'une tâche en cours et des planifications définies par les utilisateurs — aucune file générique ne le fait sans contournements. Même conception que Solid Queue (Rails 8), River (Go) ou Oban (Elixir) : bail (lease) + heartbeat, récupération des exécutions orphelines, réveil par `LISTEN/NOTIFY`. Redis (Valkey) sert au rate limiting, au relais temps réel (pub/sub pour SSE et deltas de tokens) et aux signaux d'annulation rapides.
- **D-013 — Valkey 8 au lieu de Redis ≥ 7.4.** Redis 7.4+ n'est plus sous licence open source OSI ; Valkey (BSD-3, Linux Foundation) est compatible protocole et client (`redis-py`).
- **D-014 — PostgreSQL 17.**
- **D-015 — Moteur d'agents maison, léger, derrière une interface `ModelGateway`.** Comparaison (preuve de concept papier, `conception.md` §17) : LangGraph, PydanticAI, OpenAI Agents SDK. Tous imposent leurs propres abstractions de modèle et de boucle, ce qui gêne trois exigences centrales : tracer *chaque* appel de modèle/outil avec tokens et coût normalisés, appliquer des limites strictes (étapes, appels d'outils, tokens, coût, durée) et annuler proprement. Une boucle d'appel d'outils maison (~500 lignes, testée) garde le contrôle total et n'enferme dans aucun fournisseur.
- **D-016 — Adaptateurs de modèles :** `openai_compatible` (générique, réutilisable), `deepseek` (préréglage du précédent, API officielle, testé en réel), `anthropic` (API Messages native), `test` (déterministe, scripté, sans réseau). Normalisation des messages, des appels d'outils, de l'usage et des erreurs.
- **D-017 — Coût : trois sources explicites** — `provider_reported` (le fournisseur renvoie un coût), `estimated` (tokens × tarif du registre de modèles, avec date et source du tarif), `unavailable` (tarif inconnu : jamais de zéro trompeur).
- **D-018 — Temps réel : SSE** (`text/event-stream`) avec reprise via `Last-Event-ID` (rejoue les événements persistés, puis s'abonne au pub/sub). Plus simple que WebSocket, traverse les proxys, suffisant (flux serveur → client).
- **D-019 — API `/api/v1`** : collections imbriquées sous le workspace (`/workspaces/{id}/agents`), ressources unitaires à la racine (`/agents/{id}`, `/executions/{id}`), comme proposé dans `conception.md` §13. Erreurs au format RFC 9457 (Problem Details) + `code` stable + `request_id`. Pagination par curseur opaque. Idempotence via l'en-tête `Idempotency-Key` sur les créations.
- **D-020 — Contrôle d'accès central** : un seul module (`gouvra/core/authz.py`) résout l'acteur (session ou clé de service), charge la ressource *filtrée par workspace* et applique une matrice rôle → permissions. Ressource d'un autre workspace = **404** (jamais 403, pour ne rien révéler). Rôles : owner > admin > member > viewer.
- **D-021 — Sessions serveur** (jeton aléatoire 256 bits en cookie `HttpOnly; Secure; SameSite=Lax`, seul son SHA-256 est stocké), rotation à la connexion, à l'élévation de privilège et périodiquement ; expiration glissante + absolue ; révocation par session. **CSRF** : double soumission (cookie lisible + en-tête `X-CSRF-Token`) + vérification d'`Origin` sur les méthodes non sûres.
- **D-022 — Mots de passe : Argon2id** (`argon2-cffi`, paramètres RFC 9106 « second choix » : m=64 Mio, t=3, p=4), rehash automatique si les paramètres changent.
- **D-023 — Secrets fournisseurs : AES-256-GCM**, clé hors base (`ENCRYPTION_KEYS`, trousseau `kid:clé` pour la rotation), données associées = workspace + ressource (un chiffré ne peut pas être déplacé vers un autre workspace). Seuls les 4 derniers caractères sont conservés en clair pour l'affichage. Rotation documentée dans `docs/operations.md`.
- **D-024 — Logs JSON structurés (`structlog`)** avec `request_id` / `execution_id` de corrélation et un filtre de rédaction (clés sensibles, motifs de jetons, e-mails).
- **D-025 — E-mails : interface `EmailSender`** avec adaptateurs `resend` (production), `smtp` (Mailpit en dev) et `console`. Choix par `EMAIL_PROVIDER`.
- **D-026 — Paiement : interface `BillingProvider`** avec adaptateurs `stripe` (mode test fourni) et `simulated` ; `none` en auto-hébergement.

## Frontend

- **D-030 — React 19 + TypeScript strict + Vite**, React Router 7, TanStack Query 5 (seule source des données serveur), Tailwind CSS 4 (tokens en variables CSS, thème sombre par tokens sémantiques), primitives accessibles Radix UI (composants possédés, approche shadcn), **Motion** pour l'animation (layout, AnimatePresence, `reducedMotion="user"`), Lucide pour les icônes, React Hook Form + Zod, TanStack Virtual pour les longues traces, React Flow (`@xyflow/react`) pour l'éditeur de workflows, Recharts pour les graphiques, CodeMirror 6 pour JSON. Polices Inter + JetBrains Mono auto-hébergées (`@fontsource-variable`), aucun CDN tiers.
- **D-031 — Client API typé généré depuis l'OpenAPI** (`openapi-typescript` + `openapi-fetch`) : le contrat front/back est vérifié par le compilateur.

## Exécution des outils

- **D-035 — Bac à sable** : les outils « code » s'exécutent dans un conteneur éphémère (`--network none` par défaut, système de fichiers en lecture seule, `tmpfs`, utilisateur non root, `cap-drop ALL`, `no-new-privileges`, limites CPU/mémoire/PIDs, délai). Seul le service `sandbox` parle au démon Docker, et seulement via un proxy de socket filtrant. Jamais dans l'API ni dans le worker.
- **D-036 — Outils intégrés sûrs** (exécutés dans le worker, sans code utilisateur) : requête HTTP vers hôtes autorisés (protection SSRF : résolution DNS vérifiée, IP privées interdites), calculatrice (analyseur d'expressions, pas d'`eval`), horloge/fuseaux, JSON (extraction de chemin), texte (stats/regex bornée), UUID, aléatoire.

## Outillage & qualité

- **D-040 — Python : uv, Ruff (lint + format), mypy strict, pytest (+ base PostgreSQL réelle), coverage ≥ 80 % sur le métier, pip-audit.**
- **D-041 — Web : pnpm, ESLint (typescript-eslint strict) + Prettier, Vitest + Testing Library, Playwright (+ axe-core) pour E2E, captures et audits d'accessibilité.**
- **D-042 — Conventional Commits**, commits atomiques, jamais de build cassé.

## Étape 0 (2026-10-11)

- **D-050 — Clés fournies** : `RESEND_API_KEY`, `EMAIL_FROM`, `DEEPSEEK_API_KEY`, `STRIPE_SECRET_KEY` (sk_test), `STRIPE_PUBLISHABLE_KEY` (pk_test) présentes dans `.env`.
- **D-051 — Docker arrêté sur la machine** : demandé à l'utilisateur (`sudo systemctl enable --now docker`, nécessite son mot de passe). En attendant, le code avance ; la vérification `docker compose up` attend le démon.
- **D-052 — Valeurs par défaut sans réponse sous 10 min** : identité visuelle créée par moi (aucun asset fourni) ; adaptateur Anthropic vérifié par tests de contrat (HTTP simulé) tant qu'aucune clé n'est fournie ; pas de dépôt distant : la CI GitHub Actions est écrite et rejouée à l'identique en local (`scripts/ci-local`). Un bouton OAuth n'apparaît que si son couple d'identifiants est présent (masqué sans erreur sinon).
- **D-053 — Brief mis à jour le 2026-10-11 (03:56)** : produit complet confirmé, OAuth GitHub **et** Google fournis. Callbacks imposés sur l'API directe : `http://localhost:8000/api/v1/auth/oauth/{github,google}/callback`. → Nouveau réglage `API_PUBLIC_URL` (dev : `http://localhost:8000`, prod : égal à `APP_URL` derrière Caddy) qui construit les `redirect_uri`. Les cookies sont liés à l'hôte et non au port : la session posée par l'API sur `localhost:8000` vaut aussi pour l'app sur `localhost:8080`, vers laquelle le callback redirige.
- **D-054 — Vérification de configuration sans fuite** : `gouvra check-config [--live]` contrôle la présence et le format de chaque variable et, avec `--live`, fait un appel en lecture seule à chaque fournisseur (DeepSeek `/models` + solde, Stripe `/v1/balance`, Resend `/domains`, GitHub `authorize`). Aucune valeur n'est jamais affichée.
- **D-055 — Modèles DeepSeek actuels** (lus via l'API le 2026-10-11) : `deepseek-flash` et `deepseek-v4-pro`. Le registre de modèles et les tests réels utilisent ces identifiants ; le préréglage DeepSeek interroge `/models` pour rester à jour.

## Identité (phase 2)

- **D-060 — Inscription non énumérable.** `POST /auth/register` répond toujours 202 « vérifiez votre boîte ». Si l'adresse existe déjà, aucun compte n'est créé et le titulaire reçoit un e-mail « quelqu'un a tenté de s'inscrire avec votre adresse ». Le lien de vérification connecte l'utilisateur (preuve de possession de l'adresse), ce qui évite tout oracle « compte créé / pas créé ».
- **D-061 — Connexion possible avant vérification**, mais toute route hors `/auth/*` et `/me` renvoie 403 `email_not_verified` : l'écran D guide l'utilisateur.
- **D-062 — Jeton CSRF lié à la session** (HMAC-SHA256 de l'empreinte de session avec `SESSION_SECRET`, « signed double-submit cookie » OWASP) + vérification d'`Origin` sur toute requête non sûre portant des cookies, y compris login/register (anti « login CSRF »). Cookies préfixés `__Host-` quand `COOKIE_SECURE=true`.
- **D-063 — Rotation de session** toutes les 12 h d'activité, à la connexion et au changement de mot de passe ; l'ancien jeton reste valable 60 s pour les requêtes déjà en vol. Expiration glissante 72 h, absolue 30 jours.
- **D-064 — Liens e-mail avec jeton dans le fragment d'URL** (`/reset-password#token=…`) : jamais envoyé aux serveurs, absent des journaux d'accès et des en-têtes Referer.
- **D-065 — Invitation acceptée uniquement par le compte dont l'e-mail vérifié correspond** à l'adresse invitée (un lien transféré ne donne pas accès).
- **D-066 — Liaison OAuth** : une identité GitHub/Google à e-mail vérifié se lie au compte de même adresse ; si ce compte n'était pas vérifié, son mot de passe est supprimé et ses sessions révoquées (empêche la prise de compte par pré-inscription).
- **D-067 — Politique de mot de passe (NIST 800-63B)** : 10 à 128 caractères, refus des mots de passe courants et de ceux qui reprennent l'adresse e-mail, pas de règles de composition arbitraires.
