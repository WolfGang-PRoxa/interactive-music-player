/*
 * Fiche du morceau sur l'écran de verrouillage.
 *
 * Les systèmes exposent une « fiche média » à qui joue du son dans un onglet :
 * pochette, titre, auteur et boutons de transport, repris sur l'écran de
 * verrouillage d'un téléphone ou d'une tablette, dans le centre de contrôle
 * d'un ordinateur, et jusque sur les écouteurs. Rien de tout cela ne s'affiche
 * tant qu'on ne remplit pas `navigator.mediaSession` : le navigateur se
 * contenterait sinon du titre de la page et d'aucune image.
 *
 * Cette fiche n'apparaît que si le son sort **du navigateur**, donc en
 * diffusion personnelle. En mode « tout le monde », c'est le bot qui joue dans
 * le salon vocal : l'onglet reste muet, et le système n'a rien à annoncer.
 * On tient quand même les métadonnées à jour dans les deux modes — elles ne
 * coûtent rien, et la fiche est déjà juste si la diffusion bascule.
 */
(function () {
  if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;

  const session = navigator.mediaSession;

  /** Repli quand la piste n'a pas de pochette : l'icône du tableau de bord. */
  const FALLBACK_ARTWORK = 'favicons/favicon-glassmorphism.svg';

  /**
   * Une même image déclarée à plusieurs tailles.
   *
   * `sizes` n'est qu'une indication : le système s'en sert pour choisir la
   * source la mieux adaptée à l'endroit où il l'affiche. Nos vignettes n'ont
   * qu'une définition, mais sans ces entrées certaines plateformes écartent
   * l'image faute de savoir si elle conviendra.
   */
  function artworkFor(track) {
    const src = (track && track.thumbnail) || FALLBACK_ARTWORK;
    return ['96x96', '256x256', '512x512'].map((sizes) => ({ src, sizes }));
  }

  // Reconstruire la fiche à chaque état diffusé ferait clignoter la pochette
  // sur certains systèmes : on ne la refait que si elle change vraiment.
  let lastKey = null;

  /**
   * Aligne la fiche système sur le morceau affiché.
   * @param {object|null} track Piste montrée par la carte du lecteur.
   */
  window.MusicPlayer.updateMediaSession = function (track) {
    applyActions();
    announce();

    if (!track) {
      if (lastKey !== null) {
        session.metadata = null;
        lastKey = null;
      }
      session.playbackState = 'none';
      return;
    }

    const key = [track.url, track.title, track.author, track.thumbnail].join('|');
    if (key !== lastKey) {
      lastKey = key;
      session.metadata = new window.MediaMetadata({
        title: track.title || '',
        artist: track.author || '',
        album: 'Interactive Music Player',
        artwork: artworkFor(track),
      });
    }

    const state = window.MusicPlayer.state || {};
    session.playbackState = state.isPlaying && !state.isPaused ? 'playing' : 'paused';

    setPosition(state);
  };

  /**
   * Renseigne la barre de progression de la fiche.
   *
   * `setPositionState()` lève si la durée n'est pas un nombre fini, si la
   * position la dépasse, ou si la vitesse est nulle — d'où les gardes plutôt
   * qu'un appel direct.
   */
  function setPosition(state) {
    if (typeof session.setPositionState !== 'function') return;

    const totalMs = (state.progress && state.progress.totalMs) || 0;
    const currentMs = (state.progress && state.progress.currentMs) || 0;
    const rate = parseFloat(state.settings && state.settings.playbackSpeed) || 1;

    if (!isFinite(totalMs) || totalMs <= 0) {
      try {
        session.setPositionState();
      } catch (e) {}
      return;
    }

    try {
      session.setPositionState({
        duration: totalMs / 1000,
        position: Math.min(Math.max(currentMs, 0), totalMs) / 1000,
        playbackRate: rate > 0 ? rate : 1,
      });
    } catch (e) {
      // Position incohérente le temps d'une bascule : la fiche gardera
      // la précédente, ce qui vaut mieux que de la vider.
    }
  }

  const send = (payload) => {
    if (typeof window.MusicPlayer.sendWS === 'function') window.MusicPlayer.sendWS(payload);
  };

  function seekBy(seconds) {
    const state = window.MusicPlayer.state || {};
    const totalMs = (state.progress && state.progress.totalMs) || 0;
    const currentMs = (state.progress && state.progress.currentMs) || 0;
    if (totalMs <= 0) return;
    send({ type: 'seek', data: { time: Math.round(Math.min(Math.max(currentMs + seconds * 1000, 0), totalMs)) } });
  }

  /**
   * Y a-t-il un morceau précédent ?
   *
   * On lit l'état du bouton de la page plutôt que de recalculer la règle :
   * elle n'est pas évidente — l'index de la playlist quand c'en est une,
   * l'historique quand la lecture vient de la file — et deux copies auraient
   * fini par diverger. Le bouton est rafraîchi juste avant nous, à chaque
   * état reçu : il dit déjà la vérité.
   */
  function canGoBack() {
    const btn = document.getElementById('btn-previous');
    return !!btn && !btn.disabled;
  }

  function isTouchDevice() {
    const dm = window.MusicPlayer.deviceMode;
    return !!(dm && typeof dm.isTouch === 'function' && dm.isTouch());
  }

  let appliedSignature = null;
  let boundActions = [];

  /**
   * Choisit les boutons que le système affichera.
   *
   * La fiche n'a que deux emplacements de part et d'autre de la lecture, et
   * chaque plateforme décide seule de ce qu'elle y met parmi les actions
   * branchées.
   *
   * Sur téléphone et tablette, aucun navigateur essayé — Chrome comme
   * Firefox — n'accepte d'y montrer le passage de piste : on obtient le saut
   * de dix secondes quoi qu'on demande. Autant le brancher pour de bon, que
   * les boutons fassent au moins ce qu'ils annoncent.
   *
   * Sur ordinateur, le passage de piste s'affiche comme demandé : on écarte
   * alors les sauts, qui lui prendraient sa place.
   *
   * `previoustrack` est laissé vide quand il n'y a rien avant : c'est ainsi
   * qu'on grise un bouton de la fiche — une action sans gestionnaire est
   * affichée inerte par le système.
   */
  function applyActions() {
    const touch = isTouchDevice();
    const back = canGoBack();

    const signature = `${touch}|${back}`;
    if (signature === appliedSignature) return;
    appliedSignature = signature;

    const handlers = {
      play: () => window.MusicPlayer.togglePlayPause && window.MusicPlayer.togglePlayPause(),
      pause: () => window.MusicPlayer.togglePlayPause && window.MusicPlayer.togglePlayPause(),
      stop: () => window.MusicPlayer.togglePlayPause && window.MusicPlayer.togglePlayPause(),
      seekto: (details) => {
        if (!details || typeof details.seekTime !== 'number') return;
        send({ type: 'seek', data: { time: Math.round(details.seekTime * 1000) } });
      },
      nexttrack: () => send({ type: 'skip' }),
      previoustrack: back ? () => send({ type: 'previous' }) : null,
      seekbackward: touch ? (d) => seekBy(-((d && d.seekOffset) || 10)) : null,
      seekforward: touch ? (d) => seekBy((d && d.seekOffset) || 10) : null,
    };

    for (const [name, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(name, handler);
      } catch (e) {
        // Action inconnue de ce navigateur : tant pis pour celle-là,
        // les autres restent posées.
      }
    }

    boundActions = Object.entries(handlers)
      .filter(([, fn]) => fn)
      .map(([name]) => name);
  }

  let announced = false;

  /*
   * Ce que l'appareil a réellement chargé, dit au serveur.
   *
   * La fiche média ne se regarde que sur l'écran de verrouillage : depuis le
   * tableau de bord, rien ne permet de savoir quelle version du module tourne
   * sur le téléphone, ni quels boutons il a réclamés. Une ligne dans le
   * journal du bot, et la question ne se pose plus.
   *
   * Au chargement du module la socket n'est pas encore ouverte et `sendWS()`
   * jette le message sans bruit : on attend le premier état reçu, qui prouve
   * que la liaison tient.
   */
  function announce() {
    if (announced || typeof window.MusicPlayer.sendWS !== 'function') return;
    announced = true;
    send({
      type: 'clientLog',
      data: {
        source: 'MediaSession',
        message:
          `${isTouchDevice() ? 'tactile' : 'ordinateur'} | actions : ` +
          `${boundActions.join(', ')} | ${(navigator.userAgent || '').slice(0, 80)}`,
      },
    });
  }

  // Passer du mode ordinateur au mode téléphone change le jeu de boutons.
  if (window.MusicPlayer.deviceMode && typeof window.MusicPlayer.deviceMode.onChange === 'function') {
    window.MusicPlayer.deviceMode.onChange(() => {
      appliedSignature = null;
      applyActions();
    });
  }

  applyActions();
})();
