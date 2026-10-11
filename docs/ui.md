> **Note (2026-10-11)** — « AgentHub » était le nom de travail ; le produit s'appelle désormais **Gouvra** (voir `DECISIONS.md`, D-001/D-002). Le contenu ci-dessous est la conversion fidèle du document de cadrage, nom mis à jour.

**GOUVRA**

Identité frontend & spécifications des interfaces

*Direction artistique, design system, navigation et états d’interface*

Version 1.0 — Document de cadrage UI/UX

# 1. Objectif du document

Ce document définit l’identité visuelle et le périmètre des interfaces frontend d’Gouvra. Il sert de référence commune au design et au développement. Il précise le positionnement visuel, les règles d’interface, la navigation, les écrans nécessaires et leurs états. Il ne constitue pas encore une maquette pixel-perfect ni une implémentation.

# 2. Positionnement et personnalité

Gouvra est un outil de travail pour développeurs et équipes techniques. L’interface doit évoquer la maîtrise, la précision et la visibilité opérationnelle, sans ressembler à un tableau de bord financier générique ni à une vitrine marketing chargée.

- Personnalité : technique, calme, claire, fiable et légèrement futuriste.

- Priorité : rendre les configurations, exécutions, erreurs et coûts faciles à comprendre.

- Densité : modérée à élevée dans les vues techniques, mais avec une hiérarchie typographique nette.

- Décoration : minimale ; les données et les états d’exécution sont les éléments visuels dominants.

- Ton rédactionnel : direct, utile, sans jargon inutile ; les termes techniques sont précis.

# 3. Direction artistique

## Concept visuel : “Control room for AI agents”

Une interface inspirée des outils de développement et d’observabilité : surfaces sobres, navigation structurée, panneaux lisibles, détails monospace pour les identifiants et journaux, et couleur réservée aux actions et aux états significatifs.

## Palette de couleurs

| **Token** | **Valeur** | **Usage** | **Règle** |
|----|----|----|----|
| **Ink / texte principal** | \#172B4D | Titres et texte fort | Contraste élevé |
| **Brand / bleu** | \#2563EB | Actions primaires, liens, focus | Ne pas colorer tous les éléments |
| **Canvas** | \#F6F8FB | Fond général clair | Séparer les zones par surfaces |
| **Surface** | \#FFFFFF | Cartes, formulaires, tableaux | Bordures fines |
| **Border** | \#D9E1EC | Séparateurs et champs | Éviter les contours lourds |
| **Success** | \#16845B | Réussite, actif | Toujours accompagné d’un libellé |
| **Warning** | \#B7791F | Avertissement, quota proche | Ne pas utiliser pour une erreur bloquante |
| **Danger** | \#C2413B | Échec, suppression, risque | Réserver aux états critiques |
| **Muted** | \#64748B | Aide, métadonnées | Rester lisible |

Mode sombre : prévu dès le design system, avec des tokens sémantiques dédiés. Le mode choisi par l’utilisateur doit être conservé côté application, sans dépendre uniquement des couleurs codées en dur.

## Typographie

- Police d’interface : Inter ou une police sans-serif système équivalente.

- Police monospace : JetBrains Mono ou une police monospace système pour IDs, extraits JSON, logs et données techniques.

- Titres : échelle sobre, poids semi-gras ; éviter les titres surdimensionnés dans l’application.

- Texte courant : 14–16 px selon la densité ; texte secondaire jamais trop petit pour être lu.

- Les chiffres de métriques utilisent des chiffres tabulaires lorsque possible.

# 4. Règles du design system

| **Élément** | **Spécification** | **Comportement** |
|----|----|----|
| **Espacement** | Échelle de 4 px : 4, 8, 12, 16, 24, 32, 40, 48 | Utiliser des tokens, éviter les valeurs arbitraires |
| **Rayons** | 6 px pour champs/boutons, 10 px pour cartes, 14 px pour grands panneaux | Cohérence avant décoration |
| **Boutons** | Primaire, secondaire, tertiaire, danger | États hover, focus, disabled, loading |
| **Champs** | Label, aide, erreur et état disabled | Erreur reliée au champ et annoncée accessible |
| **Badges d’état** | En attente, en cours, réussi, échec, annulé | Texte + icône/couleur, jamais la couleur seule |
| **Tableaux** | En-têtes stables, tri explicite, pagination si nécessaire | États vide, chargement, erreur |
| **Modales** | Actions clairement nommées | Échap ferme si non destructif ; focus piégé |
| **Notifications** | Succès, info, avertissement, erreur | Message actionnable, durée adaptée |
| **Icônes** | Lucide | Même style et taille, avec libellé accessible si nécessaire |

# 5. Structure globale de l’application

## Application authentifiée

- Barre latérale gauche : logo, workspace actif, navigation principale, lien paramètres.

- En-tête de page : fil d’Ariane si utile, titre, description courte et action principale.

- Zone centrale : contenu spécifique à la page, avec largeur adaptée aux tableaux et formulaires.

- Panneau latéral contextuel : détails d’exécution ou propriétés, uniquement lorsque cela aide.

- Menu utilisateur : profil, préférences, thème et déconnexion.

- Sélecteur de workspace : visible dans la navigation et avec confirmation claire lors d’un changement de contexte.

## Navigation principale

- Overview

- Agents

- Executions

- Evaluations (phase 2)

- Tools

- Providers

- Usage

- Workspace settings

# 6. Inventaire des interfaces

**A. Site public / présentation —** Accueil, proposition de valeur, capacités, aperçu de l’interface, documentation, dépôt GitHub, bouton de connexion/inscription.

**B. Inscription —** E-mail, mot de passe, confirmation des règles, validation et états d’erreur ; OAuth éventuel dans une phase ultérieure.

**C. Connexion —** E-mail/mot de passe, afficher/masquer le mot de passe, lien de récupération, erreurs neutres qui ne révèlent pas l’existence d’un compte.

**D. Vérification d’e-mail —** Confirmation de l’adresse, renvoi contrôlé du lien et état expiré.

**E. Mot de passe oublié / réinitialisation —** Demande par e-mail, réponse neutre, nouveau mot de passe et confirmation.

**F. Onboarding —** Bienvenue, création du workspace, choix du nom, invitation facultative et checklist de première configuration.

**G. Overview —** Résumé des agents, exécutions récentes, taux de réussite, erreurs récentes, usage estimé et raccourcis d’action.

**H. Agents — liste —** Recherche, filtres, état, fournisseur/modèle, dernière exécution, création et menu d’actions.

**I. Agent — création/édition —** Nom, description, instructions, modèle, paramètres, outils autorisés, limites, version et validation avant sauvegarde.

**J. Agent — détail —** Résumé, configuration, versions, bouton lancer, dernières exécutions et liens vers traces.

**K. Lancer une exécution —** Entrée utilisateur, paramètres optionnels, estimation/limites disponibles, confirmation et démarrage.

**L. Executions — liste —** ID, agent, état, déclencheur, durée, date, filtres, recherche et pagination.

**M. Exécution — détail —** État en direct, entrée/sortie, chronologie des événements, appels de modèles/outils, erreurs, durée et coûts disponibles.

**N. Tools —** Liste des outils, type, statut, schéma, permissions, test contrôlé et historique d’utilisation.

**O. Providers —** Fournisseurs configurés, modèle par défaut, état de connexion, ajout/modification et gestion sûre des secrets.

**P. Usage —** Tokens ou unités déclarés par fournisseur, coût estimé, période, répartition par agent et limites/quota.

**Q. Workspace settings —** Nom, membres, invitations, rôles, clés de service, préférences et audit selon les permissions.

**R. Profil & préférences —** Nom d’affichage, e-mail, sécurité du compte, thème, langue et sessions.

**S. Évaluations — phase 2 —** Suites de tests, cas, critères, historique, comparaison de versions et résultats.

**T. Workflows — phase ultérieure —** Éditeur de séquence, étapes, transitions, validations, erreurs et visualisation d’exécution.

# 7. Écrans clés : contenu et comportement

## Overview

- Afficher uniquement des métriques compréhensibles et dont la provenance est connue.

- Les cartes de résumé ne remplacent pas les listes détaillées et les liens vers les données sources.

- Le bloc “Dernières exécutions” donne accès directement à la trace d’une exécution.

- En l’absence de données, proposer une action utile : configurer un fournisseur ou créer un agent.

## Création d’agent

- Séparer les réglages en sections : identité, instructions, modèle, outils, limites et aperçu.

- Valider les champs avant l’enregistrement et afficher les erreurs au plus près.

- Ne pas activer d’outil par défaut sans consentement explicite.

- Présenter les limites et capacités du fournisseur choisi sans promettre des fonctions non supportées.

## Détail d’exécution

- Utiliser une chronologie lisible : démarrage, appel de modèle, appel d’outil, résultat, fin ou échec.

- Distinguer les données de sortie de l’agent des événements internes.

- Afficher les secrets et en-têtes sensibles masqués, même dans les vues de diagnostic.

- Permettre de copier les identifiants et détails non sensibles ; proposer l’export uniquement si le contrôle d’accès le permet.

# 8. États obligatoires pour chaque écran

- Chargement : squelette ou indicateur proportionné ; éviter les écrans vides non expliqués.

- Vide : expliquer pourquoi il n’y a aucune donnée et proposer une prochaine action.

- Erreur : message clair, identifiant de diagnostic si utile et action de réessai lorsque sûre.

- Succès : confirmation sobre après une action réussie.

- Accès refusé : expliquer l’absence de permission sans divulguer les ressources privées.

- Mode hors ligne / API indisponible : indiquer l’état et préserver les saisies non envoyées lorsque possible.

- État partiel : signaler les données indisponibles au lieu de les remplacer par des zéros trompeurs.

# 9. Responsive design

- Desktop (≥ 1200 px) : barre latérale complète, tableaux et panneaux côte à côte.

- Tablet (768–1199 px) : barre latérale rétractable, colonnes réduites et actions regroupées.

- Mobile (\< 768 px) : navigation en tiroir, cartes empilées, tableaux transformés en listes lorsque nécessaire.

- Les vues de logs/JSON peuvent rester denses, mais doivent permettre le défilement horizontal contrôlé et la copie.

- Aucune action critique ne doit dépendre du survol uniquement.

# 10. Accessibilité et ergonomie

- Objectif : conformité WCAG 2.2 AA autant que possible.

- Navigation complète au clavier et focus visible.

- Libellés explicites, messages d’erreur associés aux champs et ordre de tabulation logique.

- Contraste suffisant ; couleur toujours doublée d’un texte ou d’une icône.

- Annoncer les changements d’état importants des exécutions aux technologies d’assistance sans provoquer de lecture excessive.

- Respecter la préférence de réduction des animations.

- Dialogues accessibles : titre, description, focus initial et restitution du focus à la fermeture.

# 11. Micro-interactions

- Bouton de lancement : état loading, prévention du double clic et confirmation de la création d’exécution.

- Copie d’un ID : confirmation non intrusive.

- Suppression ou révocation : confirmation explicite avec nom de la ressource.

- Sauvegarde : indiquer les changements non enregistrés et prévenir la perte de données.

- État d’exécution : mise à jour en direct ou rafraîchissement contrôlé avec heure de dernière mise à jour.

- Filtres : garder visibles les filtres actifs et permettre leur réinitialisation.

# 12. Architecture frontend

| **Zone** | **Responsabilité proposée** |
|----|----|
| **app/** | Routes, providers globaux et composition de l’application |
| **features/auth/** | Écrans et logique d’authentification |
| **features/agents/** | Liste, formulaire, détail et actions des agents |
| **features/executions/** | Historique, détail et chronologie d’exécution |
| **features/providers/** | Configuration des fournisseurs |
| **features/tools/** | Catalogue et configuration des outils |
| **features/workspaces/** | Sélecteur, membres, invitations et rôles |
| **components/ui/** | Composants génériques accessibles |
| **components/layout/** | Sidebar, header, breadcrumb et conteneurs |
| **lib/api/** | Client HTTP, types, gestion des erreurs et contrats |
| **lib/auth/** | État de session et helpers de permissions sans remplacer le contrôle serveur |
| **styles/tokens/** | Couleurs, typographie, espacement et thèmes |
| **tests/** | Tests unitaires, intégration et parcours de bout en bout |

Stack proposée : React + TypeScript, Vite, Tailwind CSS et une bibliothèque de composants accessible choisie après validation. La gestion des données serveur doit utiliser un mécanisme cohérent de cache et d’invalidation ; éviter de dupliquer la même donnée dans plusieurs états globaux.

# 13. Contenu et ton des textes UI

- Préférer des libellés concrets : « Créer un agent », « Lancer une exécution », « Réessayer ».

- Éviter les messages vagues comme « Une erreur est survenue » sans contexte ou action.

- Ne jamais exposer les traces brutes d’exception comme seul message utilisateur.

- Pour les erreurs de connexion, ne pas révéler si une adresse e-mail est enregistrée.

- Distinguer « coût estimé », « coût rapporté par le fournisseur » et « donnée indisponible ».

- Ne pas utiliser de faux chiffres ou de données d’exemple sans les identifier comme exemples.

# 14. Critères d’acceptation UI

- Chaque écran de l’inventaire a une route, une permission et des états documentés.

- Les composants partagés utilisent les tokens du design system.

- Les parcours principaux sont utilisables au clavier.

- Les écrans s’adaptent aux trois classes de largeur définies.

- Les listes gèrent chargement, vide, erreur, pagination et filtres lorsque nécessaires.

- Les erreurs de formulaire sont visibles, compréhensibles et associées aux champs.

- Les données sensibles sont masquées et les actions dangereuses confirmées.

- Les tests de bout en bout couvrent inscription, création de workspace, configuration de fournisseur, création d’agent et consultation d’exécution.

# 15. Ordre recommandé de conception et réalisation

1.  Valider le positionnement visuel, les tokens et le shell de navigation.

2.  Créer les composants de base : boutons, champs, badges, alertes, modales, tableaux et états vides.

3.  Concevoir les parcours d’authentification et d’onboarding.

4.  Concevoir le flux principal : agents → configuration → lancement → détail d’exécution.

5.  Ajouter Providers, Tools, Usage et paramètres de workspace.

6.  Ajouter les évaluations et workflows uniquement après validation du flux principal.

7.  Tester l’accessibilité, le responsive et la cohérence des états sur chaque écran.

# 16. Décisions à valider avant les maquettes détaillées

- Nom et identité de marque définitifs : Gouvra est le nom de travail.

- Thème par défaut : clair, avec mode sombre disponible.

- Langue initiale de l’interface : anglais ou français ; prévoir l’internationalisation si plusieurs langues sont nécessaires.

- Bibliothèque de composants accessible à retenir.

- Choix entre affichage très dense orienté développeur et densité modérée plus accessible aux équipes produit.

- Périmètre exact du MVP : ne pas inclure les workflows visuels avancés par défaut.

# 17. Conclusion

L’identité d’Gouvra doit servir la confiance et la compréhension opérationnelle. L’interface met en avant les agents, leurs exécutions et leurs diagnostics ; elle évite les décorations qui détournent l’attention. Ce document fixe une base de travail pour les maquettes et le frontend, mais les décisions ouvertes doivent être validées avant une réalisation pixel-perfect.

*Fin du document — cadrage frontend v1.0*
