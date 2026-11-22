/**
 * transitions — Un élément de liste qui, une fois atteint, change de source.
 *
 * ## Ce que c'est
 *
 * Une transition n'est pas un morceau : c'est un aiguillage posé entre deux
 * titres d'une playlist. Quand la lecture l'atteint, elle bascule vers la
 * source désignée — une autre playlist, ou la file d'attente — et disparaît.
 * Elle se pose avant ou après un titre, se déplace comme lui à l'intérieur de
 * sa liste, et se supprime de la même façon.
 *
 * « Transition » ne veut pas dire « fondu ». L'enchaînement mix reste ce qu'il
 * est ; ceci ne décide que de *ce qui vient après*.
 *
 * ## Pourquoi le lecteur n'en voit jamais une
 *
 * C'est le fond de l'affaire, et cela évite toute course.
 *
 * On pourrait laisser la transition descendre dans la liste du lecteur et
 * l'intercepter au moment où elle allait jouer. Mais le lecteur enchaîne tout
 * seul : entre l'instant où il annonce la fin d'un titre et celui où il attaque
 * le suivant, il n'y a pas de place pour changer de source sans risquer que
 * l'un des deux gagne. Sans compter qu'il tenterait d'extraire un flux pour un
 * élément qui n'en a pas.
 *
 * On lui donne donc la liste **jusqu'à** la transition, et rien au-delà. Il
 * tombe alors en panne sèche exactement là où il faut, et le chemin qui traite
 * déjà les fins de playlist — bouclage, reprise de la file — décide de la
 * suite. La transition est consultée là, avant ces deux-là : une playlist qui
 * s'aiguille n'est pas une playlist terminée.
 *
 * ## L'identité
 *
 * Chaque transition porte une `url` qui lui est propre, `transition:<id>`.
 * Beaucoup de code compare des pistes par leur adresse — la file mise de côté,
 * l'index de lecture, le cache. Une transition sans adresse s'y confondrait
 * avec une autre ; deux transitions vers la même playlist aussi.
 */

/** Préfixe d'adresse, qui distingue une transition de toute vraie piste. */
const PREFIX = 'transition:';

/** Destination valide : la file d'attente, ou l'identifiant d'une playlist. */
const QUEUE = 'queue';

/**
 * Fabrique une transition vers la source indiquée.
 *
 * @param {string} target - `queue`, ou l'identifiant d'une playlist.
 * @returns {object}
 */
function create(target) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  return {
    isTransition: true,
    id,
    target,
    url: `${PREFIX}${id}`,
    // Titre et durée : uniquement pour le code qui lit une liste de pistes
    // sans savoir qu'elle peut contenir autre chose. Ce n'est pas ce que
    // l'interface affiche — elle rend sa propre ligne.
    title: '',
    author: '',
    duration: '0:00',
    thumbnail: null,
  };
}

/**
 * Cet élément est-il une transition ?
 *
 * Le drapeau et l'adresse sont tous deux consultés : les pistes traversent
 * plusieurs recopies champ par champ — `toData`, `_syncPlaylistToPlayer`, la
 * file mise de côté — et le drapeau n'y survit pas toujours, alors que
 * l'adresse, elle, est recopiée partout.
 *
 * @param {object} item
 * @returns {boolean}
 */
function isTransition(item) {
  if (!item) return false;
  if (item.isTransition === true) return true;
  return typeof item.url === 'string' && item.url.startsWith(PREFIX);
}

/** Une liste débarrassée de ses aiguillages. */
function withoutTransitions(list) {
  return (Array.isArray(list) ? list : []).filter((t) => !isTransition(t));
}

/**
 * Ce que le lecteur doit recevoir, à partir d'un point de départ.
 *
 * S'arrête à la première transition rencontrée, qui est rendue à part. Le
 * lecteur ne connaît donc jamais que des morceaux, et s'épuise exactement là où
 * l'aiguillage attend.
 *
 * @param {object[]} tracks - La liste rangée, transitions comprises.
 * @param {number} startIndex
 * @returns {{ tracks: object[], transition: object|null, at: number }}
 *   `at` est l'indice de la transition dans la liste d'origine, ou -1.
 */
function upTo(tracks, startIndex) {
  const list = Array.isArray(tracks) ? tracks : [];
  const debut = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  const sortie = [];

  for (let i = debut; i < list.length; i += 1) {
    if (isTransition(list[i])) return { tracks: sortie, transition: list[i], at: i };
    sortie.push(list[i]);
  }
  return { tracks: sortie, transition: null, at: -1 };
}

/**
 * La transition qui attend juste après la position atteinte, s'il y en a une.
 *
 * Immédiatement après, et pas plus loin. Quand le lecteur s'épuise, c'est
 * qu'il a joué tout ce qu'on lui avait donné — c'est-à-dire jusqu'à la
 * transition, qui est donc à l'indice suivant. En trouver une plus loin
 * signifierait que la position a dérivé, et l'on ne devinera pas laquelle
 * l'utilisateur voulait : mieux vaut laisser la playlist finir comme avant.
 *
 * @param {object[]} tracks
 * @param {number} currentIndex - Indice du dernier titre joué.
 * @returns {{ transition: object, at: number }|null}
 */
function nextAfter(tracks, currentIndex) {
  const list = Array.isArray(tracks) ? tracks : [];
  const at = (Number.isInteger(currentIndex) ? currentIndex : 0) + 1;

  if (at < 0 || at >= list.length) return null;
  if (!isTransition(list[at])) return null;
  return { transition: list[at], at };
}

/**
 * Les destinations qu'on peut proposer depuis une liste donnée.
 *
 * Sa propre liste en est exclue : une transition vers l'endroit où l'on se
 * trouve déjà ne mènerait nulle part. L'historique et la lecture en cours n'y
 * figurent pas non plus — on ne bascule pas la lecture vers ce qui est déjà
 * joué.
 *
 * @param {object[]} playlists - Les playlists existantes.
 * @param {string} containerId - `queue`, ou l'identifiant de la playlist
 *   dans laquelle la transition est créée.
 * @returns {{ id: string, name: string }[]}
 */
function destinations(playlists, containerId) {
  const sorties = [];

  if (containerId !== QUEUE) sorties.push({ id: QUEUE, name: null });

  for (const p of Array.isArray(playlists) ? playlists : []) {
    if (!p || !p.id || p.id === containerId) continue;
    sorties.push({ id: p.id, name: p.name || '' });
  }
  return sorties;
}

/**
 * Le nom de la destination d'une transition, tel qu'on l'affiche.
 *
 * `null` pour la file d'attente : son nom est traduit, et le choisir ici
 * imposerait une langue au stockage comme aux journaux.
 *
 * @param {object} transition
 * @param {object[]} playlists
 * @returns {string|null}
 */
function targetName(transition, playlists) {
  if (!transition || transition.target === QUEUE) return null;
  const found = (Array.isArray(playlists) ? playlists : []).find((p) => p && p.id === transition.target);
  return found ? found.name || '' : null;
}

module.exports = {
  PREFIX,
  QUEUE,
  create,
  isTransition,
  withoutTransitions,
  upTo,
  nextAfter,
  destinations,
  targetName,
};
