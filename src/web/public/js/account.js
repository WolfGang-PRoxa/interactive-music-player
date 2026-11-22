/**
 * account — Le compte Discord du tableau de bord, et comment en changer.
 *
 * ## Le problème
 *
 * La porte d'entrée ne se franchit qu'une fois : la session vit trente jours,
 * se prolonge à chaque requête et survit aux redémarrages du bot. Elle n'avait
 * en revanche aucune sortie. On entrait pour de bon, et changer de compte
 * demandait de supprimer un cookie à la main.
 *
 * ## L'approche
 *
 * Un bouton qui se maintient, dans les paramètres, à côté du nom du compte en
 * cours. Le maintien plutôt que le clic est l'idiome de la maison pour un geste
 * qu'un doigt malheureux ne doit pas déclencher — le même que la
 * réinitialisation générale, au bas de la même fenêtre.
 *
 * ## Ce qui se passe alors, et pourquoi en deux temps
 *
 * La session est fermée côté serveur, puis le trajet OAuth est rouvert avec un
 * drapeau. Les deux sont nécessaires et pour des raisons différentes.
 *
 * Fermer d'abord, parce qu'une session laissée ouverte resterait valable : le
 * cookie voyagerait encore, et l'on n'aurait fait qu'en ajouter une seconde.
 *
 * Le drapeau ensuite, parce que Discord reconnecte en silence le compte déjà
 * ouvert chez lui — c'est ce que demande `prompt=none`, et c'est ce qu'il faut
 * partout ailleurs. Sans ce drapeau, « changer de compte » rouvrirait le même,
 * sans rien dire. Il autorise du même geste la propriété à suivre, quand celui
 * qui le demande tient le jeton.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  'use strict';

  const section = document.getElementById('account-section');
  const nameEl = document.getElementById('account-name');
  const avatarEl = document.getElementById('account-avatar');
  const ownerNote = document.getElementById('account-owner-note');
  const guestNote = document.getElementById('account-guest-note');
  const button = document.getElementById('btn-switch-account');
  if (!section || !nameEl || !button) return;

  /** Durée du maintien, en millisecondes. La même que la réinitialisation. */
  const HOLD_MS = 1500;

  /** Ce qui est déjà affiché, pour ne pas réécrire à chaque état reçu. */
  let shown = '';

  /**
   * Montre qui est connecté.
   *
   * La section reste absente tant qu'aucune identité n'est connue : sur une
   * installation dont l'application Discord n'est pas configurée, on entre par
   * le jeton seul et il n'y a pas de compte à nommer — une ligne vide
   * poserait une question sans réponse.
   */
  function render(state) {
    const identity = state && state.identity;
    const name = (identity && identity.displayName) || '';
    const isMaster = Boolean(state && state.role === 'master');
    const holdsToken = Boolean(state && state.holdsToken);

    const signature = `${name}|${(identity && identity.avatar) || ''}|${isMaster}|${holdsToken}`;
    if (signature === shown) return;
    shown = signature;

    if (!name) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    nameEl.textContent = name;

    if (avatarEl) {
      const avatar = (identity && identity.avatar) || '';
      avatarEl.classList.toggle('hidden', !avatar);
      if (avatar && avatarEl.getAttribute('src') !== avatar) avatarEl.src = avatar;
    }

    /*
     * Ce que le changement emporte dépend du jeton, pas du titre.
     *
     * Être maître se lit sur le compte Discord et vaut donc depuis
     * n'importe quel poste ; tenir le jeton dit qu'on est devant la machine
     * qui lance le bot. Seul le second fait suivre la propriété.
     *
     * La distinction n'a l'air de rien tant qu'on n'ouvre le tableau de bord
     * que sur cette machine-là. Ouvert à distance, le maître ne tient plus
     * le jeton : lui promettre un transfert serait lui annoncer ce qui
     * n'arrivera pas, et le laisser invité chez lui sans l'avoir dit.
     */
    if (ownerNote) ownerNote.classList.toggle('hidden', !(isMaster && holdsToken));
    if (guestNote) guestNote.classList.toggle('hidden', !(isMaster && !holdsToken));
  }

  /**
   * Ferme la session, puis repart vers Discord en demandant à choisir.
   *
   * L'échec de la fermeture n'arrête rien : la porte suivante tranchera de
   * toute façon, et rester bloqué ici laisserait l'utilisateur devant un
   * bouton qui ne fait rien.
   */
  function switchAccount() {
    const done = () => {
      const back = encodeURIComponent(window.location.pathname || '/');
      window.location.href = `/auth/discord?switch=1&returnTo=${back}`;
    };

    fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(done).catch(done);
  }

  /* ── Le maintien ── */

  const progress = button.querySelector('.btn-reset-progress');
  let holdTimer = null;
  let holdStart = 0;

  function startHold(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    holdStart = Date.now();
    if (progress) progress.style.width = '0%';
    button.classList.add('holding');

    holdTimer = setInterval(() => {
      const elapsed = Date.now() - holdStart;
      if (progress) progress.style.width = `${Math.min(100, (elapsed / HOLD_MS) * 100)}%`;
      if (elapsed >= HOLD_MS) {
        cancelHold();
        switchAccount();
      }
    }, 30);
  }

  function cancelHold() {
    if (holdTimer) {
      clearInterval(holdTimer);
      holdTimer = null;
    }
    button.classList.remove('holding');
    if (progress) progress.style.width = '0%';
  }

  button.addEventListener('mousedown', startHold);
  button.addEventListener('touchstart', startHold, { passive: false });
  button.addEventListener('mouseup', cancelHold);
  button.addEventListener('mouseleave', cancelHold);
  button.addEventListener('touchend', cancelHold);
  button.addEventListener('touchcancel', cancelHold);
  // Un clic bref ne doit rien déclencher : c'est tout le propos du maintien.
  button.addEventListener('click', (e) => e.preventDefault());

  /** Appelé à chaque état reçu, comme le reste de l'interface. */
  window.MusicPlayer.refreshAccount = render;
})();
