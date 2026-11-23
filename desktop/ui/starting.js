/*
 * Page d'attente de la fenêtre principale.
 *
 * Elle n'a pas accès à l'IPC : la même fenêtre charge ensuite le tableau de
 * bord, servi par le bot. L'application lui transmet l'étape en cours en
 * appelant `impStarting` (voir `paint_starting` dans src-tauri/src/supervisor.rs).
 */
(() => {
  'use strict';

  const caption = document.getElementById('caption');
  const track = document.getElementById('track');
  const bar = document.getElementById('bar');

  window.impStarting = ({ caption: text, progress } = {}) => {
    if (text) caption.textContent = text;
    const measured = typeof progress === 'number';
    track.classList.toggle('indeterminate', !measured);
    bar.style.width = measured ? `${Math.round(progress * 100)}%` : '';
  };

  window.impStarting({});
})();
