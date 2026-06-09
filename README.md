# Jarvi → Google Calendar

Synchronise automatiquement tes **rappels Jarvi** (todos) dans **Google Calendar**.

Un Cloudflare Worker s'exécute toutes les heures (cron), lit tes rappels via l'API
Jarvi et crée/met à jour les événements correspondants dans ton agenda. Le déploiement
est piloté par GitHub : un `push` sur `main` met le Worker à jour automatiquement.

```
Jarvi (GraphQL)  ──►  Cloudflare Worker (cron horaire)  ──►  Google Calendar
                              ▲
                       déployé via GitHub Actions
```

## Pourquoi du polling et pas un webhook ?

Jarvi n'expose pas de webhook sortant sur les todos (son moteur `triggers` est interne
et ne sait pas appeler une URL externe). On interroge donc Jarvi à intervalle régulier.
L'endpoint `/sync` du Worker est néanmoins prêt à servir d'URL de webhook si Jarvi
ajoute un jour cette possibilité.

## Comment fonctionne la déduplication

Chaque événement créé porte une propriété privée `jarviTodoId`. À chaque passage, le
Worker cherche d'abord l'événement par cet identifiant : il ne crée donc jamais de
doublon, et met simplement à jour le titre/la date si le rappel a changé.

---

## 1. Pré-requis

- Un compte **Cloudflare** (offre gratuite suffisante).
- Un compte **GitHub** (ce dépôt).
- Node.js 18+ en local pour la configuration initiale des secrets.
- `wrangler` : `npm install` à la racine du projet l'installe.

## 2. Obtenir les identifiants Google Calendar (OAuth)

1. Va sur [Google Cloud Console](https://console.cloud.google.com/) → crée/choisis un projet.
2. **APIs & Services → Library** → active **Google Calendar API**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Type : **Web application**.
   - Ajoute l'URI de redirection : `https://developers.google.com/oauthplayground`.
   - Note le **Client ID** et le **Client secret**.
4. Récupère un **refresh token** via [OAuth Playground](https://developers.google.com/oauthplayground/) :
   - Roue crantée (⚙) en haut à droite → coche **Use your own OAuth credentials** → colle Client ID + secret.
   - Étape 1 : sélectionne le scope `https://www.googleapis.com/auth/calendar`.
   - **Authorize APIs**, connecte-toi avec **pierre@anara.fr**, autorise.
   - Étape 2 : **Exchange authorization code for tokens** → copie le **Refresh token**.

> Le refresh token n'expire pas tant que tu ne révoques pas l'accès. Garde-le secret.

## 3. Obtenir l'accès à l'API Jarvi

Le Worker a besoin de trois valeurs :

| Variable | Valeur |
|---|---|
| `JARVI_GRAPHQL_URL` | l'endpoint GraphQL Hasura de Jarvi |
| `JARVI_AUTH_TOKEN`  | un token Bearer valide pour l'API |
| `JARVI_USER_ID`     | `39da89eb-71a4-46ec-9906-7d7b3708d79f` (ton UUID Jarvi) |

Jarvi ne propose pas (encore) de portail développeur public. Demande à
**support@jarvi.tech** un **token d'API** et l'**URL GraphQL** associés à ton compte.
À défaut, le token de session de l'application web fonctionne pour tester, mais il
expire vite et n'est pas adapté à une exécution automatisée — privilégie un vrai token
d'API.

## 4. Configurer les secrets sur Cloudflare

Depuis la racine du projet, une fois `wrangler` installé et connecté
(`npx wrangler login`) :

```bash
npx wrangler secret put JARVI_GRAPHQL_URL
npx wrangler secret put JARVI_AUTH_TOKEN
npx wrangler secret put JARVI_USER_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put SYNC_SECRET        # un long texte aléatoire de ton choix
```

> Les secrets vivent **sur Cloudflare**, pas dans GitHub ni dans le code. Les variables
> non sensibles (fréquence, fuseau, durée, calendrier…) se règlent dans `wrangler.toml`.

## 5. Brancher le déploiement GitHub → Cloudflare

1. Crée un dépôt GitHub et pousse ce dossier :
   ```bash
   git init && git add . && git commit -m "Init Jarvi → GCal sync"
   git branch -M main
   git remote add origin git@github.com:<toi>/jarvi-gcal-sync.git
   git push -u origin main
   ```
2. Dans Cloudflare → **My Profile → API Tokens → Create Token** → modèle
   **Edit Cloudflare Workers**. Copie le token. Note aussi ton **Account ID**
   (visible dans le tableau de bord Workers).
3. Dans GitHub → **Settings → Secrets and variables → Actions → New repository secret** :
   - `CLOUDFLARE_API_TOKEN` = le token créé à l'étape 2
   - `CLOUDFLARE_ACCOUNT_ID` = ton Account ID
4. À chaque `push` sur `main`, le workflow `.github/workflows/deploy.yml` déploie le
   Worker. Tu peux aussi le lancer à la main depuis l'onglet **Actions → Deploy Worker → Run workflow**.

> Alternative sans GitHub Actions : dans Cloudflare, **Workers & Pages → Create →
> Connect to Git**, choisis le dépôt. Cloudflare construit et déploie à chaque push.
> Les secrets restent à définir une fois via `wrangler secret put` (étape 4).

## 6. Tester

- Déclenchement manuel (remplace par ton `SYNC_SECRET`) :
  ```
  https://jarvi-gcal-sync.<ton-sous-domaine>.workers.dev/sync?secret=TON_SYNC_SECRET
  ```
  Réponse attendue : un JSON `{ ok: true, totalTodos, created, updated, skipped }`.
- Logs en direct : `npx wrangler tail`.
- Le cron tourne ensuite tout seul (toutes les heures par défaut).

## 7. Réglages (dans `wrangler.toml`)

| Variable | Rôle | Défaut |
|---|---|---|
| `crons` | fréquence de synchro | `0 * * * *` (chaque heure) |
| `TIMEZONE` | fuseau d'affichage | `Europe/Paris` |
| `EVENT_DURATION_MINUTES` | durée d'un événement | `30` |
| `CALENDAR_ID` | agenda cible | `primary` |
| `EVENT_TITLE_PREFIX` | préfixe de titre | `Jarvi · ` |
| `ONLY_UPCOMING` | ignorer les rappels passés | `true` |
| `MIN_PRIORITY` | priorité minimale (P1→P4) | `P4` (tout) |

## Limites connues

- Sens unique Jarvi → Google. Une suppression de rappel dans Jarvi ne supprime pas
  l'événement déjà créé (on peut l'ajouter si besoin).
- Les rappels sans date (`scheduledAt` nul) sont ignorés — ils n'ont rien à placer
  dans l'agenda.
