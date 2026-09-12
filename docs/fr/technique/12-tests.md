# 12 — Tests

[← Sommaire](README.md)

Cinquante suites vivent dans [`tests/`](../../../tests/), toutes lancées par
`npm test`. Elles ne suivent aucun cadre de test : ce sont des scripts Node
ordinaires, qui s'exécutent et rendent un code de sortie.

---

## Le parti pris

**Aucune dépendance de test.** Ni Jest, ni Mocha, ni `node:test`. Chaque suite
est un fichier qui compte ses succès et ses échecs, les imprime, puis sort en
`0` ou en `1` :

```js
let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// …

console.log(`=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
```

C'est cohérent avec le reste du projet — rien n'est transpilé, rien n'est
assemblé — et cela tient à une contrainte réelle : l'essentiel de ce qu'il y a à
éprouver ici est du JavaScript de navigateur servi sans module, communiquant par
`window.MusicPlayer`. Un cadre qui suppose des imports ES n'aurait rien à en
faire. Les suites frontend chargent donc le fichier, l'évaluent dans un contexte
préparé à la main, et regardent ce qu'il pose.

**Une suite raconte pourquoi elle existe.** L'en-tête de chaque fichier décrit
le défaut qu'elle attrape, et ce que ce défaut a coûté. C'est la partie qui
mérite d'être lue en premier quand une suite tombe : elle dit souvent
directement ce qui vient d'être cassé.

---

## Les trois familles

| Famille | Ce qui est éprouvé | Exemples |
|---|---|---|
| **Unitaires** | Une fonction, sans rien autour | `loudness`, `downloadFormats`, `historyOrder`, `rangeStream` |
| **Comportementales** | Un module côté serveur, avec des doublures | `channelQueue`, `transitions`, `pilotElection`, `shareGrant` |
| **Frontend** | Un script de `public/js/`, évalué dans un contexte factice | `speedPadPointer`, `toastSwipe`, `scrollFade`, `themeBlend` |

À quoi s'ajoutent deux suites qui ne portent pas sur le code applicatif :
`docsIntegrity` et `docsLanguages`, décrites plus bas.

---

## Le test de fumée

[`tests/smoke.js`](../../../tests/smoke.js) est le seul à démarrer le bot pour
de vrai. Il procède en deux étages, du moins cher au plus cher :

1. **Chargement** — chaque module de `src/` est requis. Attrape les `require()`
   cassés, les exports disparus et les erreurs de syntaxe. Les deux points
   d'entrée (`src/index.js`, `src/deploy-commands.js`) sont exclus : les charger
   démarrerait le bot.
2. **Intégration** — le bot est démarré, puis interrogé en HTTP et en WebSocket.
   Attrape ce que le chargement ne voit pas : un champ du protocole renommé d'un
   seul côté, une route qui ne répond plus.

Il porte une liste `STATE_FIELDS` des champs de premier niveau du message
`state`. **Elle est à mettre à jour sciemment** lorsqu'un champ du protocole est
renommé — c'est précisément le genre d'oubli que ce test existe pour attraper,
un renommage fait d'un seul côté ne produisant aucune erreur, juste un affichage
vide.

> Le test de fumée a besoin du port du tableau de bord. Si le bot tourne déjà
> sur la machine, son étage d'intégration échoue sur un port occupé : ce n'est
> pas une régression, c'est l'environnement. Éteindre l'instance en cours avant
> de le lancer.

---

## Les deux suites de documentation

Elles gardent ce corpus-ci, et méritent d'être connues avant d'y toucher.

[`docsIntegrity.js`](../../../tests/docsIntegrity.js) vérifie trois choses qu'on
casse en silence et qu'aucune relecture de traduction ne montre :

- **Les ancres.** Un lien vers `05-tableau-de-bord.md#robustesse` désigne un
  titre. Traduire le titre sans traduire l'ancre, ou l'inverse, donne un lien
  qui ne mène nulle part — dans cette langue-là seulement. Le calcul de l'ancre
  reprend celui de `js/docs.js`, qui suit la convention de GitHub.
- **La charpente.** Une traduction doit avoir **autant de titres, de blocs de
  code et de lignes de tableau** que son original français. Un écart signale une
  section oubliée ou un tableau tronqué, ce qu'un fichier de 15 Ko ne montre
  pas.
- **Les liens vers le code.** Ils traversent `docs/<langue>/technique/` pour
  remonter à `src/`. Déplacer la documentation d'un niveau les casse tous à la
  fois, sans que rien ne le signale : ce sont des liens de dépôt, que le lecteur
  du tableau de bord n'ouvre même pas.

[`docsLanguages.js`](../../../tests/docsLanguages.js) monte le vrai routeur
d'API sur un port éphémère et vérifie le service : l'inventaire part de
`docs/<langue>/` et jamais de `docs/`, les identifiants ne portent pas la
langue, et rien de ce qui vient du client n'est assemblé en chemin.

**Conséquence pratique.** Toute modification de la documentation française doit
être répercutée dans les trois traductions avec la **même charpente** : même
nombre de titres, de blocs de code et de lignes de tableau. Ajouter une ligne à
un tableau français sans l'ajouter aux trois autres fait tomber `docsIntegrity`.

---

## Lancer les tests

| Commande | Effet |
|---|---|
| `npm test` | Les cinquante suites, à la file. S'arrête à la première qui échoue. |
| `npm run smoke` | Le seul test de fumée |
| `npm run test:<nom>` | Une suite précise — un script par suite dans `package.json` |

L'enchaînement de `npm test` se fait par `&&` : la première suite qui sort en
`1` interrompt le reste. C'est voulu — une régression transversale ferait tomber
trente suites, et lire la première est plus utile que de faire défiler les
autres.

---

## Écrire une suite

1. Créer `tests/<nom>.js`.
2. En tête, décrire **le défaut que la suite attrape** et ce qu'il a coûté. Pas
   ce que fait le code : ce qui se cassait sans elle.
3. Reprendre le compteur `check()` ci-dessus, et sortir en `process.exit(failed === 0 ? 0 : 1)`.
4. Ajouter `"test:<nom>": "node tests/<nom>.js"` dans `package.json`, **et**
   l'insérer dans la chaîne du script `test`. Les deux : le script individuel
   sert au développement, la chaîne à la vérification d'ensemble.

Une suite qui a besoin du serveur monte le vrai routeur sur un port éphémère
(`server.listen(0, '127.0.0.1')`) avec un `webServer` factice, comme le fait
`docsLanguages`. Démarrer le bot entier n'est nécessaire qu'au test de fumée.
