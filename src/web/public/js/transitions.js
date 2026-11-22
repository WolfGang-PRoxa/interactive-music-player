/**
 * transitions — La ligne d'aiguillage, et ce qu'on a le droit d'en faire.
 *
 * ## Ce qu'elle est
 *
 * Un aiguillage n'est pas un morceau : c'est une consigne posée entre deux
 * titres d'une playlist. Quand la lecture l'atteint, elle bascule vers la
 * source désignée — une autre playlist, ou la file d'attente — et l'aiguillage
 * disparaît, consommé.
 *
 * « Transition » ne veut pas dire « fondu ». L'enchaînement mix reste ce qu'il
 * est ; ceci ne décide que de *ce qui vient après*.
 *
 * ## Pourquoi elle ne ressemble pas à un titre
 *
 * Elle occupe une ligne dans la même liste, et se déplace comme les autres.
 * Rien ne la distinguerait donc, sinon son dessin : pas de pochette, pas de
 * durée, pas de numéro d'ordre — elle ne se joue pas —, mais une flèche et le
 * nom de l'endroit où elle mène. Un utilisateur doit voir en un coup d'œil que
 * la lecture s'arrêtera là.
 *
 * ## Pourquoi elle ne sort pas de sa liste
 *
 * On peut la déplacer dans la playlist qui la porte, et nulle part ailleurs.
 * Elle y désigne une position entre deux titres : la faire glisser vers la file
 * d'attente ou vers l'historique la sortirait de tout ce qui lui donne un sens.
 * Le refus se fait au dépôt, pas au départ : un `dragstart` bloqué priverait
 * aussi du déplacement légitime à l'intérieur de la liste.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  'use strict';

  /** Même préfixe que côté serveur — voir `src/audio/transitions.js`. */
  const PREFIX = 'transition:';

  const t = (key, fallback) => (window.MusicPlayer.t ? window.MusicPlayer.t(key) || fallback : fallback);

  /**
   * Cet élément de liste est-il un aiguillage ?
   *
   * Le drapeau et l'adresse tous les deux : l'état traverse plusieurs
   * recopies champ par champ avant d'arriver ici, et le drapeau n'y survit
   * pas toujours, alors que l'adresse est recopiée partout.
   */
  window.MusicPlayer.isTransition = function (item) {
    if (!item) return false;
    if (item.isTransition === true) return true;
    return typeof item.url === 'string' && item.url.indexOf(PREFIX) === 0;
  };

  /**
   * Le nom de l'endroit où mène un aiguillage.
   *
   * @param {object} transition
   * @returns {string}
   */
  window.MusicPlayer.transitionTargetName = function (transition) {
    if (!transition) return '';
    if (transition.target === 'queue') {
      return t('transition_target_queue', "File d'attente");
    }
    const playlists = (window.MusicPlayer.state && window.MusicPlayer.state.playlists) || [];
    const found = playlists.find((p) => p && p.id === transition.target);

    // La playlist visée a pu être supprimée depuis. Le dire vaut mieux que
    // d'afficher une flèche vers rien : l'aiguillage sera consommé sans
    // effet le jour où la lecture l'atteindra, et autant le savoir avant.
    return found ? found.name || '' : t('transition_target_gone', 'Destination supprimée');
  };

  /**
   * Ce qui, dans une liste, peut changer l'affichage d'un aiguillage.
   *
   * Les deux listes ne se reconstruisent que lorsque leur signature bouge —
   * titre, adresse, durée, pochette —, sans quoi elles seraient réécrites à
   * chaque état reçu et perdraient le survol sous le curseur. Or un
   * aiguillage n'a rien de tout cela : changer sa destination ne bougeait
   * aucun de ces quatre champs, et la ligne gardait l'ancien nom jusqu'au
   * prochain rechargement de la page.
   *
   * Deux choses sont donc ajoutées à la signature, et seulement lorsqu'un
   * aiguillage est présent : les destinations visées, et le nom des playlists
   * — qu'un renommage change sous une ligne qui, elle, n'a pas bougé.
   *
   * La restriction compte : le champ de renommage envoie à chaque frappe, et
   * mêler ces noms à la signature de toutes les listes les ferait reconstruire
   * lettre après lettre.
   *
   * @param {object[]} liste
   * @returns {string} '' quand aucun aiguillage ne s'y trouve.
   */
  window.MusicPlayer.transitionSignature = function (liste) {
    const aiguillages = (liste || []).filter(window.MusicPlayer.isTransition);
    if (aiguillages.length === 0) return '';

    const noms = ((window.MusicPlayer.state && window.MusicPlayer.state.playlists) || [])
      .map((p) => `${p.id}:${p.name}`)
      .join(',');
    return `|${aiguillages.map((t) => `${t.id}>${t.target}`).join(',')}|${noms}`;
  };

  const ICON_ARROW =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 20 L4 12 Q4 8 8 8 L20 8"></path>' +
    '<polyline points="16 4 20 8 16 12"></polyline></svg>';

  const ICON_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-trash">' +
    '<polyline points="3 6 5 6 21 6"></polyline>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2">' +
    '</path></svg>';

  /**
   * Dessine la ligne d'un aiguillage dans une playlist.
   *
   * @param {object} transition
   * @param {object} playlist - Celle qui le porte.
   * @param {number} index - Sa position, pour la suppression et le glissement.
   * @returns {HTMLElement}
   */
  window.MusicPlayer.buildTransitionRow = function (transition, playlist, index) {
    // Playlist ou file d'attente : la ligne est la même, seuls diffèrent le
    // message de suppression et l'étiquette que le glissement emporte.
    const dansLaFile = playlist.id === 'queue';

    const item = document.createElement('div');
    item.className = 'playlist-transition-item';
    item.setAttribute('draggable', 'true');
    item.setAttribute('data-index', index);
    item.setAttribute('data-url', transition.url || '');

    const left = document.createElement('div');
    left.className = 'track-left';

    const icon = document.createElement('span');
    icon.className = 'transition-row-icon';
    icon.innerHTML = ICON_ARROW;
    left.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'transition-row-label';
    label.textContent = t('transition_row_label', 'Transition vers');
    left.appendChild(label);

    const cible = document.createElement('span');
    cible.className = 'transition-row-target';
    cible.textContent = window.MusicPlayer.transitionTargetName(transition);
    cible.dataset.tooltip = t(
      'transition_row_tooltip',
      'La lecture bascule ici vers cette source, puis cette ligne disparaît.',
    );
    left.appendChild(cible);

    const right = document.createElement('div');
    right.className = 'track-right';

    // Pas de bouton « lire » : il n'y a rien à jouer. Le bouton de
    // suppression, lui, passe par le même chemin qu'un titre — un
    // aiguillage n'est jamais qu'un élément de la liste.
    const remove = document.createElement('button');
    remove.dataset.perm = dansLaFile ? 'queue.remove' : 'playlists.removeTrack';
    remove.className = 'track-remove-btn';
    remove.dataset.tooltip = t('transition_remove', 'Retirer cette transition');
    remove.dataset.i18nTooltip = 'transition_remove';
    remove.innerHTML = ICON_TRASH;
    remove.addEventListener('click', () => {
      window.MusicPlayer.sendWS(
        dansLaFile
          ? { type: 'removeTrack', data: { index } }
          : { type: 'removeTrackFromPlaylist', data: { playlistId: playlist.id, index } },
      );
    });
    right.appendChild(remove);

    /*
     * Le clic droit ouvre le seul réglage qu'un aiguillage possède.
     *
     * Le contexte est relu ici et non retenu à la construction : la ligne
     * garde son gestionnaire pendant que la liste bouge sous elle, et un
     * indice figé finirait par désigner sa voisine.
     */
    item.addEventListener('contextmenu', (e) => {
      window.MusicPlayer.showTransitionMenu(e, transition, {
        container: playlist.id,
        index: Number(item.getAttribute('data-index')),
      });
    });

    item.addEventListener('dragstart', (e) => {
      item.classList.add('is-dragging');
      document.body.classList.add('is-dragging-active');
      window.MusicPlayer.activeDragData = {
        sourceContainerId: dansLaFile ? 'queue-list' : 'playlist-tracks-list',
        source: dansLaFile ? 'queue' : 'playlist_track',
        isTransition: true,
        // La liste d'origine, sous le nom que les zones de dépôt
        // comparent : `queue` pour la file, l'identifiant sinon.
        playlistId: playlist.id,
        fromIndex: index,
        url: transition.url,
        title: '',
      };
      e.dataTransfer.setData('application/json', JSON.stringify(window.MusicPlayer.activeDragData));
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      document.body.classList.remove('is-dragging-active');
      window.MusicPlayer.activeDragData = null;
      if (typeof window.MusicPlayer.clearAllDragIndicators === 'function') {
        window.MusicPlayer.clearAllDragIndicators();
      }
    });

    item.appendChild(left);
    item.appendChild(right);
    return item;
  };

  /**
   * Ce glissement sort-il un aiguillage de la liste qui le porte ?
   *
   * Consultée par chaque zone de dépôt. Rendre `true` doit faire abandonner
   * le dépôt sans rien changer : la ligne retourne d'elle-même à sa place.
   *
   * @param {object} dragData - Ce que `dragstart` a écrit.
   * @param {string} destination - `queue`, `history`, `player`, ou
   *   l'identifiant de la playlist visée.
   * @returns {boolean}
   */
  window.MusicPlayer.transitionLeavingHome = function (dragData, destination) {
    if (!dragData || !dragData.isTransition) return false;
    return dragData.playlistId !== destination;
  };
})();
