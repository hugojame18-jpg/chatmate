# Mettre chatmate en ligne (Railway)

L'app tourne telle quelle, sans rien réécrire. Compte ~5 $/mois et une vingtaine de minutes.

## Pourquoi pas Vercel

Vercel est du serverless : pas de disque persistant. La base SQLite serait effacée à chaque
démarrage à froid, donc plusieurs fois par jour. Il faudrait d'abord migrer toute la couche
données vers Postgres (Supabase), ce qui représente une réécriture complète en asynchrone.

À faire plus tard si l'outil fait ses preuves. Pas pour une première mise en ligne.

## Les 5 étapes

### 1. Générer la clé de session

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Garde le résultat sous la main. **Sans cette clé, elle est déconnectée à chaque redémarrage.**

### 2. Créer le projet

Sur railway.app : nouveau projet, puis connecte le dossier `chatmate` (via GitHub, ou
`railway up` en ligne de commande). Railway détecte le `Dockerfile` tout seul.

### 3. Les variables d'environnement

Dans **Variables** :

| Variable | Valeur |
|---|---|
| `NODE_ENV` | `production` |
| `CHATMATE_SECRET` | la chaîne générée à l'étape 1 |
| `CHATMATE_DATA_DIR` | `/data` |
| `CHATMATE_ALLOWED_EMAILS` | son email, et le tien si tu veux un accès |

`CHATMATE_ALLOWED_EMAILS` est important : sans elle, **n'importe qui trouvant l'URL peut créer
un compte**. Avec elle, seules les adresses listées peuvent s'inscrire. Sépare-les par des virgules.

### 4. Le volume

**Settings > Volumes**, monté sur `/data`.

Sans ça, la base repart de zéro à chaque redéploiement. C'est l'étape qu'on oublie et qui coûte
cher.

### 5. Déployer

Railway fournit une URL en `.up.railway.app`. Aucun nom de domaine nécessaire.

## Une fois en ligne

1. Ouvre l'URL : l'écran de connexion doit apparaître **avant** tout le reste
2. Elle crée son compte avec l'email autorisé
3. Elle va dans **Settings** et colle la clé OpenRouter
   (la clé est dans la base locale, pas dans le code : elle ne part pas avec le déploiement)
4. Elle ajoute l'URL à l'écran d'accueil de son téléphone

## Ce qui est en place

- Comptes séparés, inscription et connexion, mots de passe hachés en scrypt avec sel unique
- Cloisonnement total : chaque requête est filtrée par compte, testé contre l'accès croisé
- Cookie de session signé HMAC-SHA256, `HttpOnly`, `SameSite=Lax`, `Secure` en production
- Blocage après 8 tentatives ratées pendant 15 minutes
- Inscriptions restreintes par liste d'emails
- `noindex, nofollow` sur toutes les pages

## Ce qu'il reste à faire

- **Sauvegardes** : un volume n'est pas une sauvegarde. Prévois un export régulier de `/data`.
- **Changement de mot de passe** : pas encore d'écran pour ça.
- **Migration Supabase** : le jour où tu veux Vercel, ou plusieurs centaines d'utilisatrices.
  Toutes les fonctions de données passent déjà par `userId`, la logique de sécurité ne bougera pas.
