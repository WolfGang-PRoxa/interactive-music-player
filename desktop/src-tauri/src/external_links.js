/*
 * Les liens « ailleurs » du tableau de bord, dans la fenêtre de l'application.
 *
 * Injecté par l'application dans la fenêtre principale, sur chaque page (voir
 * `main_window` dans supervisor.rs). Le tableau de bord, lui, n'en sait rien :
 * ouvert dans un navigateur, il n'est pas touché.
 *
 * Un lien `target="_blank"` ou un `window.open` demandent un nouvel onglet. La
 * webview le signale à l'application, qui devait le confier au navigateur — et
 * sous Windows, cette voie-là n'ouvrait rien : GitHub, le don, l'issue, le
 * portail Discord restaient lettre morte. Le lien passe donc par une
 * navigation, que l'application intercepte à coup sûr avant qu'elle ne
 * commence : vers une adresse relais qui ne mène nulle part, l'adresse voulue
 * en paramètre. La page reste où elle est.
 */
(() => {
  'use strict';

  if (window.__impExternalLinks) return;
  window.__impExternalLinks = true;

  /** Doit rester l'hôte d'`OPEN_EXTERNAL_HOST`, dans supervisor.rs. */
  const RELAY = 'https://imp-open.invalid/?u=';

  /** L'adresse absolue d'un lien, s'il mène au web ou au courriel. */
  function outward(href) {
    if (href == null) return null;
    try {
      const url = new URL(String(href), location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function hand(url) {
    location.assign(RELAY + encodeURIComponent(url));
  }

  /** Un lien qui viserait un onglet : `target` autre que la page elle-même. */
  function opensElsewhere(link) {
    const target = (link.getAttribute('target') || '').toLowerCase();
    return target !== '' && target !== '_self' && target !== '_top' && target !== '_parent';
  }

  /*
   * En fin de propagation, et seulement si personne n'a annulé le clic : le
   * menu du bouton GitHub avale celui qui suit un appui long, et doit pouvoir
   * continuer à le faire.
   */
  function onClick(event) {
    if (event.defaultPrevented) return;
    const middle = event.type === 'auxclick' && event.button === 1;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && !middle) return;

    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    // Ctrl, Maj ou le bouton du milieu demandent eux aussi un nouvel onglet.
    if (!opensElsewhere(link) && !middle && !event.ctrlKey && !event.shiftKey && !event.metaKey) return;

    const url = outward(link.getAttribute('href'));
    if (!url) return;
    event.preventDefault();
    hand(url);
  }

  window.addEventListener('click', onClick);
  window.addEventListener('auxclick', onClick);

  const nativeOpen = window.open;
  window.open = function (url, name) {
    const target = name == null || name === '' ? '_blank' : String(name);
    const resolved = target === '_blank' ? outward(url) : null;
    if (resolved) {
      hand(resolved);
      return null;
    }
    return nativeOpen.apply(this, arguments);
  };
})();
