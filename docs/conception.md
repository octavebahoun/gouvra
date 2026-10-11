> **Note (2026-10-11)** — « AgentHub » était le nom de travail ; le produit s'appelle désormais **Gouvra** (voir `DECISIONS.md`, D-001/D-002). Le contenu ci-dessous est la conversion fidèle du document de cadrage, nom mis à jour.

**GOUVRA**

Document de conception du produit

*Plateforme open source pour créer, exécuter, évaluer et superviser des agents IA*

Version 1.0 — Document initial de cadrage

# 1. Résumé exécutif

Gouvra est une plateforme open source destinée aux développeurs et aux équipes qui construisent des agents d’intelligence artificielle. Elle centralise leur configuration, leurs outils, leurs exécutions, leurs évaluations et leur observabilité dans un environnement cohérent. Le produit doit pouvoir être installé soi-même, utilisé via une interface web et piloté par une API.

L’ambition n’est pas de créer un simple chatbot ni un constructeur visuel limité. Gouvra doit fournir une couche opérationnelle permettant de passer du prototype à une exécution contrôlée : qui a lancé un agent, avec quelle configuration, quels outils ont été appelés, combien de temps et de ressources ont été consommés, et pourquoi une exécution a réussi ou échoué.

# 2. Vision et objectifs

## Vision

Devenir une plateforme accessible et extensible pour gérer le cycle de vie opérationnel des agents IA, sans imposer un fournisseur de modèles ni un framework d’agents unique.

## Objectifs

- Centraliser la configuration et la gestion des agents.

- Connecter plusieurs fournisseurs de modèles derrière une interface cohérente.

- Définir des outils autorisés et tracer leurs appels.

- Exécuter des tâches de manière contrôlée, avec états, délais, annulation et gestion des erreurs.

- Inspecter les traces, les sorties, les durées et les coûts estimés.

- Évaluer les agents sur des jeux de tests reproductibles.

- Fournir une API et une documentation permettant l’intégration dans d’autres produits.

- Permettre une installation auto-hébergée et proposer une base compatible avec une future offre SaaS.

# 3. Public cible et problèmes résolus

| **Public** | **Problème** | **Valeur apportée** |
|----|----|----|
| Développeur indépendant | Prototypes difficiles à inspecter et à maintenir | Un espace pour configurer, lancer et déboguer les agents |
| Équipe produit/IA | Exécutions et résultats dispersés entre outils | Historique, traces, évaluations et comparaison |
| Équipe plateforme | Besoin de contrôle et de limites opérationnelles | Permissions, quotas, journaux et configuration centralisée |
| Mainteneur open source | Intégrations spécifiques et contributions difficiles | Architecture modulaire, interfaces stables et guides de contribution |

# 4. Principes de conception

- Open source d’abord : installation documentée, licence explicite, issues et contributions accessibles.

- Modularité : séparer les domaines métier sans démarrer avec des microservices prématurés.

- Sécurité par défaut : permissions côté serveur, secrets protégés, validation stricte des entrées et isolation des espaces de travail.

- Traçabilité : chaque exécution doit produire un historique utile au diagnostic.

- Interopérabilité : ne pas lier toute la plateforme à un seul fournisseur de modèles.

- Progressivité : livrer une base fiable avant les fonctions avancées.

- Transparence : distinguer coût réel communiqué par un fournisseur, coût estimé et métriques indisponibles.

# 5. Périmètre fonctionnel

## 5.1 Fonctionnalités du MVP

- Comptes : inscription, connexion, déconnexion, vérification d’e-mail, récupération de mot de passe et profil.

- Espaces de travail : création d’un workspace, membres, invitations et rôles de base.

- Agents : créer, modifier, dupliquer, archiver et configurer un agent.

- Fournisseurs : enregistrer une configuration de fournisseur et sélectionner un modèle compatible.

- Outils : définir des outils explicitement autorisés, avec schéma d’entrée et validation.

- Exécutions : lancer une tâche, afficher son état, consulter l’entrée et la sortie, annuler si possible.

- Historique : conserver les exécutions et les événements techniques utiles.

- Observabilité minimale : étapes, appels de modèles, outils, erreurs et durée.

- API documentée : endpoints versionnés pour les ressources principales.

- Déploiement local : Docker Compose, migrations et fichier d’environnement d’exemple.

## 5.2 Après le MVP

- Constructeur de workflows multi-étapes et orchestration multi-agents.

- Jeux d’évaluation, critères de notation et comparaison de versions de prompts/modèles.

- Budgets, quotas, alertes et estimation du coût par workspace.

- Planification de tâches récurrentes et déclencheurs par webhook.

- Bibliothèque de connecteurs et registre de modèles/outils.

- Clés API de service, politiques de rétention et exports.

- Fonctionnalités SaaS : plans, facturation, limites par abonnement et administration multi-organisation.

# 6. Parcours utilisateur principaux

1.  Un utilisateur crée un compte, vérifie son adresse et ouvre un workspace.

2.  Il configure un fournisseur de modèle en stockant une clé API de manière sécurisée.

3.  Il crée un agent, choisit son modèle, définit ses instructions et sélectionne les outils autorisés.

4.  Il lance une exécution avec une entrée, puis suit les états en cours.

5.  À la fin, il consulte la réponse, les étapes, les appels d’outils, les erreurs et les métriques disponibles.

6.  Il modifie la configuration et relance un test pour comparer les résultats.

# 7. Architecture proposée

Pour la première version, privilégier un monolithe modulaire avec un worker asynchrone séparé pour les tâches longues. Cette approche limite la complexité opérationnelle tout en préservant des frontières métier claires.

| **Couche** | **Responsabilité** |
|----|----|
| **Interface web — React + TypeScript** | Console de gestion, formulaires, tableaux de bord et visualisation des exécutions |
| **API — Python + FastAPI** | Authentification, validation, autorisations et logique métier |
| **Moteur d’exécution** | Cycle de vie des agents, appels de modèles, exécution des outils et limites |
| **Worker — Celery ou équivalent** | Tâches longues, reprises contrôlées et exécutions asynchrones |
| **PostgreSQL** | Utilisateurs, workspaces, agents, configurations, exécutions et événements |
| **Redis** | File de tâches et données temporaires, si nécessaires |
| **Stockage objet optionnel** | Artefacts volumineux, exports et pièces jointes |
| **Docker + CI** | Environnement reproductible, tests et livraison |

# 8. Modules métier

**Identity —** Comptes, sessions, vérification et récupération.

**Workspaces —** Organisations, membres, invitations et rôles.

**Agent Registry —** Définition, version et statut des agents.

**Model Gateway —** Adaptateurs par fournisseur, normalisation des réponses et erreurs.

**Tool Registry —** Définition des outils, schémas, permissions et validations.

**Execution Engine —** Lancement, états, annulation, délais, limites et orchestration.

**Observability —** Événements, traces, métriques et diagnostic.

**Evaluation —** Cas de test, résultats, critères et comparaisons.

**Usage & Billing —** Compteurs, quotas et intégration future d’un fournisseur de paiement.

**Administration —** Paramètres globaux, audit et outils de support.

# 9. Modèle de données initial

Les entités principales envisagées sont :

- User : identité, e-mail vérifié, état du compte et dates.

- Workspace : propriétaire, nom, paramètres et état.

- Membership : utilisateur, workspace et rôle.

- Invitation : e-mail invité, rôle proposé, expiration et état.

- ProviderConfig : workspace, fournisseur, référence du secret et paramètres non sensibles.

- Agent : workspace, nom, instructions, configuration et version.

- ToolDefinition : nom, description, schéma, type d’intégration et politique d’autorisation.

- Execution : agent/version, déclencheur, état, entrée référencée, sortie, timestamps et erreur normalisée.

- ExecutionEvent : exécution, type d’événement, horodatage et métadonnées filtrées.

- EvaluationSuite / EvaluationCase / EvaluationRun : scénarios, critères et résultats.

- UsageRecord : métriques de consommation, source, estimation et devise lorsque connue.

- AuditEvent : acteur, action, cible et horodatage, sans secrets ni contenus sensibles inutiles.

# 10. Sécurité et confiance

- Toutes les autorisations sont vérifiées côté serveur pour chaque ressource et workspace.

- Les requêtes doivent être protégées contre l’accès inter-workspace (IDOR et fuites multi-tenant).

- Les clés de fournisseurs ne doivent jamais être retournées au navigateur après leur enregistrement.

- Chiffrer les secrets au repos avec une clé de chiffrement hors de la base de données et documenter la rotation.

- Ne jamais exécuter du code arbitraire fourni par un utilisateur dans le processus principal de l’API.

- Traiter les outils comme des capacités à privilèges : liste d’autorisation, validation, délais, quotas et isolation adaptés.

- Définir des limites de taille, de durée, de concurrence et de consommation.

- Filtrer les secrets et données personnelles des journaux.

- Vérifier les signatures des webhooks et rendre leurs traitements idempotents.

- Prévoir sauvegardes, restauration testée, politique de rétention et procédure de divulgation responsable.

# 11. Exigences non fonctionnelles

- Fiabilité : états d’exécution explicites et erreurs normalisées.

- Sécurité : tests d’autorisation, dépendances contrôlées et gestion documentée des secrets.

- Maintenabilité : typage, conventions, modules bornés et migrations versionnées.

- Testabilité : tests unitaires, intégration, API et parcours critiques.

- Observabilité : logs structurés avec identifiants de corrélation, métriques et traces utiles.

- Déploiement : démarrage documenté, health checks, migrations et procédure de rollback.

- Accessibilité : navigation clavier, libellés de formulaire et contrastes suffisants.

- Internationalisation future : textes d’interface séparés du code métier.

# 12. Stratégie de tests et de qualité

- Tests unitaires pour les règles métier, les adaptateurs et les transitions d’état.

- Tests d’intégration avec PostgreSQL et la file de tâches.

- Tests API pour authentification, permissions, validation et isolation entre workspaces.

- Tests de contrat pour les adaptateurs de fournisseurs et d’outils.

- Tests de sécurité ciblés : accès non autorisé, fuite de secrets, entrées invalides et limites.

- Tests de bout en bout pour inscription, création d’agent et exécution simple.

- CI : formatage, lint, typage, tests, audit des dépendances et construction des images.

# 13. API — première surface envisagée

| **Méthode** | **Route indicative** | **Usage** |
|----|----|----|
| POST | /api/v1/auth/register | Créer un compte |
| POST | /api/v1/auth/login | Ouvrir une session |
| GET | /api/v1/workspaces | Lister les workspaces accessibles |
| POST | /api/v1/workspaces | Créer un workspace |
| GET / POST | /api/v1/workspaces/{id}/agents | Lister ou créer des agents |
| GET / PATCH / DELETE | /api/v1/agents/{id} | Lire, modifier ou supprimer un agent |
| POST | /api/v1/agents/{id}/executions | Lancer une exécution |
| GET | /api/v1/executions/{id} | Lire l’état et le résultat |
| GET | /api/v1/executions/{id}/events | Consulter les événements filtrés |
| POST | /api/v1/evaluations/runs | Lancer une évaluation — phase ultérieure |

Ces routes sont des propositions de conception, pas une API déjà implémentée. Les contrats définitifs devront préciser les schémas, codes d’erreur, pagination, idempotence et versionnement.

# 14. Déploiement et exploitation

- Développement : Docker Compose avec API, frontend, PostgreSQL et Redis si requis.

- Configuration : variables d’environnement documentées, validation au démarrage et aucun secret dans Git.

- Production : HTTPS, proxy inverse, worker séparé, stockage persistant et sauvegardes.

- Migrations : versionnées, testées et accompagnées d’une stratégie de retour arrière.

- Observabilité : health/readiness checks, logs structurés, métriques et alertes.

- Documentation d’exploitation : sauvegarde/restauration, rotation des secrets, incidents et mise à niveau.

# 15. Gouvernance open source

- Choisir une licence reconnue avant la première publication (par exemple Apache-2.0 ou MIT, selon les objectifs).

- Publier README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY et CHANGELOG.

- Définir les règles de branches, revues de code, labels d’issues et modèles de pull request.

- Maintenir une feuille de route publique et distinguer les objectifs du MVP des idées futures.

- Établir une politique de versions et de dépréciation de l’API.

- Documenter la provenance des dépendances, les licences tierces et les exigences de sécurité.

# 16. Feuille de route indicative

| **Phase** | **Livrable** | **Critère de sortie** |
|----|----|----|
| 0 — Cadrage | Décisions, architecture, exigences et maquettes simples | Périmètre MVP validé |
| 1 — Fondations | Repo, environnement local, CI, base et migrations | Un nouveau contributeur démarre le projet |
| 2 — Identité | Comptes, workspaces, membres et autorisations | Tests des flux et de l’isolation réussis |
| 3 — Agent simple | Configuration, un fournisseur et un outil contrôlé | Une exécution traçable fonctionne de bout en bout |
| 4 — Exploitation | Historique, erreurs, métriques et limites | Diagnostic d’une exécution possible |
| 5 — Stabilisation | Tests, docs, sécurité, installation reproductible | Release candidate vérifiée |
| 6 — Extensions | Évaluations, workflows, quotas et facturation | Fonctions ajoutées selon les retours |

# 17. Risques et décisions ouvertes

- La portée peut devenir trop large : garder un MVP strict et différer le constructeur visuel avancé.

- Les fournisseurs ont des comportements et tarifs différents : concevoir des adaptateurs sans masquer les limites propres à chacun.

- Les agents peuvent appeler des outils risqués : limiter les capacités par défaut et isoler les exécutions non fiables.

- Les métriques de coût ne sont pas toujours disponibles ou comparables : afficher la source et le niveau de confiance.

- La complexité multi-tenant augmente le risque de fuite : en faire une exigence centrale des tests.

- Le framework exact du moteur d’agents reste à décider après une preuve de concept comparant une implémentation légère et des frameworks existants.

- La licence, le modèle de contribution et la frontière entre édition communautaire et éventuel SaaS doivent être décidés explicitement.

# 18. Critères de réussite du premier jalon

- Le projet démarre localement à partir d’instructions reproductibles.

- Un utilisateur peut s’inscrire, vérifier son e-mail et créer un workspace.

- Les rôles et autorisations sont appliqués côté serveur.

- Un agent peut exécuter une tâche simple via un fournisseur configuré.

- Chaque exécution expose un état, un résultat et des événements de diagnostic.

- Les secrets ne sont pas exposés dans l’interface ni les logs.

- La CI exécute les tests critiques et bloque une régression.

- Un contributeur externe peut comprendre l’architecture et proposer une modification.

# 19. Conclusion

Gouvra doit être construit comme une plateforme d’ingénierie fiable, pas comme une démonstration d’IA spectaculaire mais fragile. La première preuve de valeur sera une exécution d’agent simple, sécurisée, reproductible et observable. Les workflows complexes, l’évaluation avancée et la monétisation viendront ensuite, une fois les fondations vérifiées.

*Fin du document — version initiale à valider avant l’implémentation*
