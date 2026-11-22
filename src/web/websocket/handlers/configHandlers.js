/**
 * configHandlers — La section « Configuration » des paramètres.
 *
 * Deux messages, réservés au propriétaire (voir permissions.js) : lire ce que
 * le `.env` contient, et y écrire. Les règles — ce qui peut se lire, ce qui ne
 * se change que devant la machine — sont dans botConfig.js ; ici, on ne fait
 * que transmettre, avec ce que seule la connexion sait : d'où elle vient.
 */

const botConfig = require('../../botConfig');
const log = require('../../../utils/logger');

function send(ws, data) {
  try {
    ws.send(JSON.stringify({ type: 'configState', data }));
  } catch (e) {
    // Socket fermée entre-temps : rien à sauver.
  }
}

function context(ws) {
  return { fromThisMachine: Boolean(ws.fromThisMachine) };
}

function handleConfigState(ctx) {
  send(ctx.ws, botConfig.snapshot(context(ctx.ws)));
}

function handleConfigUpdate(ctx) {
  const { ws, data } = ctx;
  const result = botConfig.apply(data && data.values, context(ws));
  if (result.detail) log.error('[Config] Could not write the .env file:', result.detail);
  if (result.saved.length) {
    // Les noms seulement : une valeur peut être un secret.
    log.info(`[Config] .env updated from the dashboard: ${result.saved.join(', ')}.`);
  }
  send(ws, {
    ...botConfig.snapshot(context(ws)),
    result: { ok: result.ok, errors: result.errors, saved: result.saved },
  });
}

module.exports = { handleConfigState, handleConfigUpdate };
