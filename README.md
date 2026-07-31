# chatmate

Assistant de réponses privé pour créatrice de contenu.

**Ce que l'app ne fait pas :** elle n'a strictement aucune connexion avec Fansly. Pas d'API, pas
d'extension, pas de bot, pas de session, pas de mot de passe. Elle ne peut ni lire ni envoyer quoi
que ce soit sur la plateforme. Le fonctionnement est un copier-coller manuel dans les deux sens.
C'est volontaire : c'est ce qui rend un bannissement impossible pour cause d'automatisation.

## Lancer

Node 22.5 ou plus est requis (SQLite intégré). Aucune dépendance à installer.

```bash
node server.js
```

Puis ouvrir `http://localhost:5190`.

Le terminal affiche aussi une adresse `http://192.168.x.x:5190` : c'est celle à ouvrir **depuis le
téléphone**, à condition d'être sur le même wifi. Ajoute-la aux favoris ou sur l'écran d'accueil.

## Le flux au quotidien

1. Un fan écrit sur Fansly.
2. Elle copie son message et le colle dans l'app.
3. L'app propose 3 réponses : **complice**, **coquin**, **vente**.
4. Elle appuie sur *Copier* (ou modifie d'abord avec ✏️).
5. Elle colle dans Fansly et envoie elle-même.

La réponse copiée est archivée automatiquement, donc l'historique reste complet et l'IA garde le fil
de la conversation d'un message à l'autre.

## Premier démarrage

Dans **Réglages** :

1. **Exemples de ses vrais messages** — le réglage qui compte le plus. Colle 20 à 50 de ses vrais
   messages. Sans ça le résultat sonne générique.
2. **Mots interdits** — vrai prénom, ville, école, employeur. Toute réponse générée qui en contient
   un est signalée en rouge avant la copie. Ces mots ne sont jamais envoyés au modèle.
3. **Moteur IA** — voir plus bas.

Dans **Contenus** : ajouter les PPV avec titre, tags et prix. L'IA ne propose que ce qui est listé,
et jamais deux fois le même contenu au même fan.

Pour un fan déjà en cours : ouvrir sa fiche > *Importer une conversation existante*, et coller
l'historique avec `lui:` et `moi:` en début de ligne.

## Moteur IA

Trois options, réglables sans toucher au code :

| Fournisseur | URL de base | Remarque |
|---|---|---|
| Mode démo | — | Aucune clé. Textes factices, sert à tester l'interface. |
| OpenRouter | `https://openrouter.ai/api/v1` | Une clé, des dizaines de modèles. Payant à l'usage. |
| Autre / local | `http://localhost:1234/v1` | Toute API compatible OpenAI : LM Studio, Ollama, autre fournisseur. |

Sur OpenRouter, tous les modèles n'autorisent pas le contenu adulte. Une erreur **403** signifie que
le modèle a refusé : il faut en choisir un autre, typiquement un modèle open-weight.

## Ce que fait la stratégie

Le code décide **quoi** faire, l'IA ne fait que la formulation. C'est ce qui évite qu'un modèle
brade les prix ou reparte en freestyle.

Chaque fan est classé automatiquement :

- **Nouveau** — créer le lien, zéro vente
- **Chauffé** — 10+ messages, aucun achat : première proposition, prix d'entrée
- **Acheteur** — 1 à 4 achats : monter en gamme, ouvrir sur le custom
- **Whale** — au-delà du seuil configuré : priorité absolue, exclusif, réponse personnelle

## Garde-fous

Chaque message collé est analysé avant génération.

**Blocage total, aucune réponse générée :**

- Indices de minorité — le fan est automatiquement marqué bloqué
- Demande de rencontre en vrai — une réponse de cadrage est proposée à la place

**Avertissement, la génération continue :**

- Recherche d'informations personnelles
- Paiement ou passage hors plateforme
- Demande de gratuit
- Vocabulaire de litige / remboursement

Ces règles sont dans `src/safety.js` et se modifient sans risque.

## Données

Tout est dans `data/chatmate.db`, sur la machine. Rien n'est hébergé nulle part. Le seul appel
réseau sortant est celui vers le moteur IA choisi, et il ne contient que la conversation et la fiche
du fan — jamais les mots interdits.

Sauvegarde = copier le dossier `data/`.

## Structure

```
server.js          serveur HTTP + fichiers statiques (zéro dépendance)
src/db.js          schéma SQLite et accès données
src/safety.js      garde-fous entrée/sortie
src/strategy.js    stades, playbook, choix du contenu à proposer
src/prompt.js      construction du prompt
src/llm.js         adaptateur moteur (démo / OpenRouter / compatible OpenAI)
src/api.js         routes
public/            interface (HTML/CSS/JS, sans build)
```
