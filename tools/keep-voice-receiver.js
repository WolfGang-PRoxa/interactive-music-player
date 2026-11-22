/**
 * Rend au bot son oreille, après chaque installation de dépendances.
 *
 * ## Le problème
 *
 * Le ducking suppose que la connexion vocale sache *recevoir* : c'est son
 * `receiver` qui annonce qui parle. Or discord-player 7 ne s'appuie plus sur
 * `@discordjs/voice` mais sur `discord-voip`, un embranchement réduit à la
 * diffusion dont les connexions n'ont pas de `receiver` du tout — le symbole
 * `VoiceReceiver` n'y existe même pas.
 *
 * Le paquet du projet demande la redirection de ce nom vers `@discordjs/voice`,
 * qui l'a. C'est à cela que servent ses `overrides`, et c'est pour cela qu'il
 * dépend de `discord-voip` sous forme d'alias. Mais npm range tout de même une
 * copie propre à discord-player sous son dossier :
 *
 *     node_modules/
 *     ├── discord-voip/          ← l'alias vers @discordjs/voice, avec receiver
 *     └── discord-player/
 *         └── node_modules/
 *             └── discord-voip/  ← la vraie discord-voip, sans receiver
 *
 * Node cherchant d'abord dans le dossier du demandeur, c'est la seconde qui
 * gagne, et les `overrides` n'y peuvent rien : discord-player déclare
 * `discord-voip: ^7.2.0`, une plage que `@discordjs/voice@0.19.2` ne satisfait
 * pas, et npm renonce en silence. Vérifié en régénérant le verrou : il ressort
 * identique, la copie imbriquée revient.
 *
 * ## L'approche
 *
 * Retirer la copie imbriquée. Node remonte alors d'un cran et trouve celle qui
 * entend. C'est une suppression, pas une réécriture : rien n'est rapiécé, le
 * paquet du dessus est pris tel qu'il est publié.
 *
 * Le geste est rejoué à chaque `npm install` — y compris ceux que le bot
 * déclenche lui-même en installant une nouvelle version (voir
 * `versioning/installer.js`) —, faute de quoi le ducking remourrait en silence
 * à la première mise à jour.
 *
 * ## Les garde-fous
 *
 * Trois conditions avant de supprimer quoi que ce soit, et la moindre qui
 * manque fait renoncer :
 *
 *   1. la copie imbriquée existe ;
 *   2. elle n'a effectivement pas de `receiver` — le jour où discord-voip en
 *      aura un, il n'y aura plus rien à faire, et l'écarter serait une perte ;
 *   3. celle qui prendra sa place existe et en a un — sans quoi la suppression
 *      priverait discord-player de sa dépendance au lieu de la remplacer.
 *
 * Ce script ne fait jamais échouer une installation. Une dépendance qu'on n'a
 * pas su ranger ne vaut pas d'interrompre l'installation entière : le ducking
 * s'en plaindra tout seul au démarrage (voir `audio/DuckingManager.js`), avec
 * de quoi remonter jusqu'ici.
 */

const fs = require('fs');
const path = require('path');

/** Le paquet dont la copie imbriquée fait de l'ombre à celle du dessus. */
const PACKAGE = 'discord-voip';

/** Le paquet qui l'embarque. */
const HOST = 'discord-player';

/**
 * Ce paquet-là sait-il écouter ?
 *
 * La question est posée au module lui-même plutôt qu'à son numéro de version :
 * c'est la capacité qui compte, et elle peut apparaître dans une version dont
 * on ne saura rien d'avance. Le repli lit le fichier, pour les cas où le
 * chargement échoue sur autre chose — un binaire natif absent, par exemple.
 *
 * @param {string} dir - Dossier du paquet
 * @returns {boolean}
 */
function hasReceiver(dir) {
  try {
    const loaded = require(dir);
    if (loaded && typeof loaded.VoiceReceiver === 'function') return true;
    // Chargé, et sans `VoiceReceiver` : la réponse est non, sans appel.
    if (loaded) return false;
  } catch (e) {
    // Chargement impossible : on se rabat sur la lecture du fichier.
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const entry = path.join(dir, manifest.main || 'index.js');
    return fs.readFileSync(entry, 'utf8').includes('VoiceReceiver');
  } catch (e) {
    return false;
  }
}

/**
 * Écarte la copie imbriquée, si les trois conditions sont réunies.
 *
 * @param {string} root - Racine du projet
 * @param {(message: string) => void} [say] - Où écrire ce qui se passe
 * @returns {'removed'|'absent'|'still-useful'|'no-replacement'} Ce qui a été fait
 */
function keepVoiceReceiver(root, say = () => {}) {
  const nested = path.join(root, 'node_modules', HOST, 'node_modules', PACKAGE);
  const outer = path.join(root, 'node_modules', PACKAGE);

  if (!fs.existsSync(nested)) {
    // Rien à faire : c'est l'état recherché, et c'est le cas le plus courant
    // une fois le script passé une première fois.
    return 'absent';
  }

  if (hasReceiver(nested)) {
    say(`[voice] ${HOST} embarque un ${PACKAGE} qui sait écouter : rien à changer.`);
    return 'still-useful';
  }

  if (!fs.existsSync(outer) || !hasReceiver(outer)) {
    say(
      `[voice] Aucun ${PACKAGE} pourvu d'un receiver au niveau racine : ` +
        'la copie imbriquée est laissée en place, sans quoi discord-player ' +
        'se retrouverait sans sa dépendance. Le ducking restera inerte.',
    );
    return 'no-replacement';
  }

  fs.rmSync(nested, { recursive: true, force: true });
  say(
    `[voice] Copie imbriquée de ${PACKAGE} écartée : ${HOST} utilisera celle ` +
      'du dessus, qui sait entendre parler. Le ducking peut fonctionner.',
  );
  return 'removed';
}

module.exports = { keepVoiceReceiver, hasReceiver, PACKAGE, HOST };

if (require.main === module) {
  try {
    keepVoiceReceiver(process.cwd(), (message) => console.log(message));
  } catch (err) {
    // Jamais au prix de l'installation : voir l'en-tête.
    console.log(`[voice] Rangement impossible (${err.message}), on continue.`);
  }
}
