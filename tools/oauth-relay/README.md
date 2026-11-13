# Relais de retour OAuth

Discord n'accepte de renvoyer un visiteur que sur une adresse déclarée d'avance
dans le portail de l'application. Le partage rapide du tableau de bord reçoit
une adresse neuve à chaque lancement (`https://….trycloudflare.com`) : ce relais
est l'adresse fixe qu'on déclare à sa place. Il renvoie chaque connexion vers
l'origine écrite dans le `state` — un tunnel rapide, ou `localhost` —, et
refuse toute autre destination.

Il ne garde rien, ne journalise rien, et n'a besoin d'aucun secret : le code
d'autorisation qui le traverse ne vaut rien sans le secret de l'application,
que seul le bot détient. Un seul relais sert toutes les installations.

Voir `docs/fr/technique/11-acces-distant.md` pour le trajet complet.

## Déployer depuis le tableau de bord Cloudflare (navigateur, même sur téléphone)

1. **Workers & Pages → Create → Create Worker.** Nommez-le `imp-oauth-relay`,
   puis **Deploy** (le code d'exemple sera remplacé juste après).
2. **Edit code** : remplacez tout le contenu par celui de `src/index.js`, puis
   **Deploy**.
3. **Settings → Domains & Routes → Add → Custom domain** :
   `imp-auth.romainpiau.dev`. Cloudflare crée l'entrée DNS et le certificat.
4. Vérifiez : `https://imp-auth.romainpiau.dev/` affiche « Relais de connexion ».

## Déployer en ligne de commande

```
cd tools/oauth-relay
npx wrangler login
npx wrangler deploy
```

`wrangler.toml` déclare déjà le domaine personnalisé.

## Changer d'adresse

Le bot emploie `https://imp-auth.romainpiau.dev/discord/callback` par défaut
(`DEFAULT_RELAY_URL`, dans `src/web/oauth.js`). Une installation peut désigner
un autre relais avec `OAUTH_RELAY_URL` dans son `.env`.

Les destinations acceptées sont écrites deux fois : ici et dans
`src/web/oauthRelay.js`. `tests/oauthRelay.js` vérifie qu'elles s'accordent ;
toute modification de l'une demande la même dans l'autre, puis un nouveau
déploiement.
