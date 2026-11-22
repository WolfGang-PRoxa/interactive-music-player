/**
 * rateLimit — Un plafond sur les chemins que personne n'a besoin d'authentifier.
 *
 * ## Le problème
 *
 * Deux adresses sont ouvertes sans jeton ni session, et il le faut : celui qui
 * clique le lien posté dans le salon vocal n'a encore rien pour s'authentifier
 * (voir `PUBLIC_PATHS` dans web/auth.js). Elles ne donnent accès à rien, mais
 * elles font travailler le bot.
 *
 * `/auth/discord` fait grossir la table des trajets en attente, cinq minutes
 * durant. `/auth/discord/callback` déclenche un échange de jeton chez Discord
 * puis un `members.fetch` par serveur — donc des appels à l'API de Discord,
 * dont le quota est celui du bot et non celui du visiteur. Quelques milliers de
 * requêtes suffisaient à épuisser l'un et à faire taire l'autre.
 *
 * ## L'approche
 *
 * Une fenêtre glissante par adresse d'origine, tenue en mémoire. Rien de
 * persistant : un redémarrage remet les compteurs à zéro, et c'est sans
 * conséquence — ce qu'on borne ici est une rafale, pas un quota mensuel.
 *
 * Le plafond est large à dessein. Il ne s'agit pas de rationner l'usage
 * normal — se connecter, c'est deux requêtes — mais d'empêcher qu'une boucle
 * laissée tourner n'épuise le quota Discord du bot.
 *
 * ## Pourquoi pas une bibliothèque
 *
 * Le projet n'embarque rien qu'il puisse écrire en trente lignes, et un
 * limiteur en mémoire pour un bot personnel en fait partie. Une dépendance de
 * plus, c'est une surface de plus à tenir à jour — ce que l'audit vient
 * précisément de rappeler.
 */

const log = require('../utils/logger');

/** clé → { count, resetAt } */
const buckets = new Map();

/**
 * Purge les seaux échus.
 *
 * Appelée à chaque passage plutôt que sur minuterie : sans trafic il n'y a rien
 * à purger, et une minuterie retiendrait le process au moment de sortir.
 */
function purge(now) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Les adresses de la machine elle-même, telles que Node les rapporte. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Adresse d'où vient la requête.
 *
 * `req.ip` d'ordinaire : le serveur écoute en direct, et `X-Forwarded-For`
 * n'est pas consulté — s'y fier laisserait n'importe qui choisir son propre
 * seau en le forgeant.
 *
 * Derrière le tunnel Cloudflare, en revanche, toutes les requêtes arrivent de
 * `cloudflared`, donc de la machine elle-même : le plafond deviendrait global,
 * et un seul visiteur trop pressé fermerait la porte à tous les autres.
 * Cloudflare pose alors l'adresse réelle dans `CF-Connecting-IP`.
 *
 * L'en-tête n'est cru que sur une connexion venue de la machine elle-même.
 * Depuis le réseau local (`HOST=0.0.0.0`), n'importe qui pourrait le forger ;
 * depuis la machine, celui qui le forge est déjà chez lui.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function originOf(req) {
  const direct = req.socket?.remoteAddress || req.ip || 'inconnu';
  const relayed = req.headers?.['cf-connecting-ip'];
  if (LOOPBACK.has(direct) && typeof relayed === 'string' && relayed.trim()) {
    return relayed.trim().slice(0, 64);
  }
  return req.ip || direct;
}

/**
 * Construit un limiteur.
 *
 * @param {{ name: string, limit: number, windowMs: number }} options
 * @returns {import('express').RequestHandler}
 */
function createLimiter({ name, limit, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    purge(now);

    const key = `${name}:${originOf(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count++;
    if (bucket.count <= limit) return next();

    // Une ligne par seau, au moment où il déborde, et non à chaque requête
    // refusée : sans cela le journal se remplirait de la rafale qu'on
    // cherche justement à contenir.
    if (bucket.count === limit + 1) {
      log.warn(
        `[RateLimit] ${name}: ${originOf(req)} exceeded ` + `${limit} requests in ${Math.round(windowMs / 1000)}s.`,
      );
    }

    res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).type('html').send(TOO_MANY_PAGE);
  };
}

const TOO_MANY_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Trop de requêtes</title>
<style>
  body { font-family: system-ui, sans-serif; background: #16161d; color: #e6e6ec;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
</style></head>
<body><main>
  <h1>Trop de requêtes</h1>
  <p>Trop de tentatives de connexion en peu de temps. Patientez une minute,
     puis réessayez.</p>
</main></body></html>`;

/** Remet les compteurs à zéro. Réservé aux tests. */
function reset() {
  buckets.clear();
}

module.exports = { createLimiter, reset, originOf };
