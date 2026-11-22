/**
 * Vérifie la remise du contrôle — le vrai headerButtonAnimations.js, exécuté
 * dans un DOM simulé.
 *
 * Ce bouton donne à quelqu'un d'autre la main sur le bot, et le glyphe dit déjà
 * la chose : une personne entière devant, et derrière elle une seconde réduite
 * à deux fragments. L'animation ne fait qu'achever la phrase — une étincelle
 * quitte la première et va dessiner la seconde.
 *
 * Trois choses portent le sens, et aucune ne se voit dans un diff.
 *
 *  - **Le sens du tracé.** L'arc de tête se dessine depuis son premier point,
 *    celui où l'étincelle atterrit ; l'épaule depuis sa *fin*, parce que son
 *    tracé part du bord extérieur et remonte vers le corps. Prises toutes deux
 *    dans le sens de leur écriture — ce que fait un décalage de tiret écrit sans
 *    y penser — les deux traits s'allument à contresens l'un de l'autre, la
 *    lueur repart du bord alors qu'elle vient d'arriver au centre, et le geste
 *    ne se lit plus.
 *
 *  - **Le recouvrement.** L'épaule part avant que l'arc n'ait fini. La lueur est
 *    un seul trait qui continue, pas deux gestes mis bout à bout.
 *
 *  - **Le repos est rendu à la feuille de style**, pas reposé à la main : le
 *    script retire ses déclarations en ligne au lieu d'écrire « opacity: 0 »,
 *    sans quoi le glyphe garderait l'empreinte de son animation.
 *
 * Le reste tient les garde-fous : rien ne sort du repère de l'icône — la
 * pastille du compteur est juste à côté —, les tracés lumineux sont des copies
 * au caractère près de ceux du glyphe, et un utilisateur qui refuse les
 * animations n'en reçoit aucune.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'js', 'headerButtonAnimations.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'css', 'modals.css'), 'utf8');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Élément factice, dont on relit le style en ligne et les attributs posés. */
function makeElement(id, totalLength) {
  const listeners = {};
  const attributes = {};
  const style = {
    removeProperty(name) {
      delete style[name.replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
    },
  };
  const el = {
    id,
    style,
    attributes,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    getAttribute: (name) => attributes[name],
    removeAttribute: (name) => {
      delete attributes[name];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    _listeners: listeners,
  };
  if (totalLength) {
    el.getTotalLength = () => totalLength;
    // Rail droit et régulier : la position exacte n'est pas le sujet, seul
    // compte que le script promène bien le point le long du tracé.
    el.getPointAtLength = (l) => ({ x: 11.9 + (l / totalLength) * 4.1, y: 4.2 - (l / totalLength) * 1.07 });
  }
  return el;
}

/** Les deux nombres d'un « stroke-dasharray », ou null. */
function dashes(value) {
  if (!value) return null;
  return value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

function mountShare({ reduced = false } = {}) {
  // Longueurs réelles du glyphe, celles-là mêmes que les replis du script.
  const ARC_LENGTH = 4 * 2 * Math.asin(7.75 / 8);
  const BODY_LENGTH = 2 + 4 * 2 * Math.asin(Math.hypot(3, 3.87) / 8);
  const TRACK_LENGTH = 4.631;

  const arc = makeElement('arc', ARC_LENGTH);
  const body = makeElement('body', BODY_LENGTH);
  const spark = makeElement('spark');
  const track = makeElement('track', TRACK_LENGTH);
  const button = makeElement('btn-open-share');
  button.querySelector = (sel) => {
    if (sel === '.share-grant-arc') return arc;
    if (sel === '.share-grant-body') return body;
    if (sel === '.share-grant-spark') return spark;
    if (sel === '.share-grant-track') return track;
    return null;
  };

  const rafQueue = [];
  const canvasStub = {
    style: {},
    width: 0,
    height: 0,
    getContext: () => ({
      setTransform() {},
      clearRect() {},
      beginPath() {},
      fill() {},
      arc() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
  };

  let clock = 0;
  const sandbox = {
    window: {
      MusicPlayer: {},
      addEventListener() {},
      matchMedia: () => ({ matches: reduced }),
      devicePixelRatio: 1,
    },
    document: {
      getElementById: (id) => (id === 'btn-open-share' ? button : null),
      createElement: () => canvasStub,
      documentElement: { getAttribute: () => 'dark' },
      body: { appendChild() {} },
      querySelector: () => null,
    },
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    performance: { now: () => clock },
    Math,
    Uint8Array,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  /** Avance l'horloge de `ms` et exécute la trame en attente. */
  const advance = (ms) => {
    clock += ms;
    const fn = rafQueue.shift();
    if (fn) fn(clock);
  };

  return {
    arc,
    body,
    spark,
    track,
    button,
    advance,
    ARC_LENGTH,
    BODY_LENGTH,
    TRACK_LENGTH,
    at: () => clock,
    pending: () => rafQueue.length,
    enter: () => button._listeners.mouseenter(),
    leave: () => button._listeners.mouseleave(),
  };
}

console.log('\n=== Le bouton de partage — la remise du contrôle ===\n');

// ───────────────────── Le balisage et le repos ─────────────────────

console.log('Les calques lumineux et leur repos\n');

{
  const glyphArc = 'd="M16 3.13a4 4 0 0 1 0 7.75"';
  const glyphBody = 'd="M22 21v-2a4 4 0 0 0-3-3.87"';

  // La lueur suit le glyphe, elle ne dessine pas une seconde forme : le
  // moindre écart la ferait passer à côté du trait qu'elle allume.
  check(
    "l'arc lumineux recopie celui du glyphe",
    MARKUP.includes(`<path class="share-grant share-grant-arc" ${glyphArc}>`),
    'copie au caractère près',
  );
  check(
    "l'épaule lumineuse recopie celle du glyphe",
    MARKUP.includes(`<path class="share-grant share-grant-body" ${glyphBody}>`),
  );

  check("le rail de l'étincelle est dans le balisage", /class="share-grant-track" d="M11\.9 4\.2C/.test(MARKUP));

  // Le rail doit finir exactement là où l'arc commence, sinon la lueur prend
  // le relais à côté du point où l'étincelle est arrivée.
  check(
    "le rail atterrit sur le premier point de l'arc",
    /class="share-grant-track"[^>]*16 3\.13"/.test(MARKUP),
    '16 3.13',
  );

  check(
    'le repos est écrit dans la feuille de style',
    /\.btn-share-control \.share-grant,\s*\n\s*\.btn-share-control \.share-grant-spark \{[^}]*opacity: 0;/.test(CSS),
  );
  check(
    'et nulle part dans le balisage',
    !/share-grant[^>]*opacity=/.test(MARKUP),
    'un attribut de présentation passerait sous la feuille de style',
  );

  check(
    'le rail ne se voit jamais',
    /\.btn-share-control \.share-grant-track \{[^}]*stroke: none;[^}]*fill: none;/.test(CSS),
  );

  // La pastille du compteur est posée hors du bouton, en haut à droite.
  const coords =
    (MARKUP.match(/class="share-grant[^"]*"[^>]*(?:d|cx)="[^"]*"/g) || []).join(' ').match(/-?\d+\.?\d*/g) || [];
  check(
    "tout reste dans le repère de l'icône",
    coords.every((n) => Math.abs(Number(n)) <= 24),
    'la lueur ne passe jamais sur la pastille du compteur',
  );
}

// ───────────────────── La traversée ─────────────────────

console.log("\nL'étincelle traverse\n");

{
  const s = mountShare();
  s.enter();
  s.advance(16);

  const first = { x: Number(s.spark.getAttribute('cx')), y: Number(s.spark.getAttribute('cy')) };
  check("l'étincelle s'allume en partant", Number(s.spark.style.opacity) > 0, `opacité ${s.spark.style.opacity}`);

  s.advance(160);
  const mid = { x: Number(s.spark.getAttribute('cx')), y: Number(s.spark.getAttribute('cy')) };
  check(
    'elle avance le long de son rail',
    mid.x > first.x && mid.y < first.y,
    `${first.x.toFixed(2)},${first.y.toFixed(2)} → ${mid.x.toFixed(2)},${mid.y.toFixed(2)}`,
  );

  check(
    "rien n'est encore allumé chez le second personnage",
    Number(s.arc.style.opacity) === 0 && Number(s.body.style.opacity) === 0,
  );

  // Elle s'éteint en touchant l'arc : ce qu'elle portait est passé dans le
  // trait, elle n'a plus de raison d'être là.
  s.advance(200);
  const arriving = Number(s.spark.style.opacity);
  check(
    "elle faiblit en touchant l'arc",
    arriving > 0 && arriving < 1,
    `opacité ${arriving.toFixed(3)} à ${s.at()} ms`,
  );

  s.advance(120);
  check("puis s'éteint tout à fait", Number(s.spark.style.opacity) === 0, `à ${s.at()} ms`);
  check("et le second personnage s'allume", Number(s.arc.style.opacity) === 1);
}

// ───────────────────── Le sens du tracé ─────────────────────

console.log('\nLe personnage se dessine, et dans le bon sens\n');

{
  const s = mountShare();
  s.enter();
  // Milieu du tracé de l'arc : l'étincelle est arrivée, l'épaule n'a pas commencé.
  s.advance(16);
  s.advance(470);

  const arcDash = dashes(s.arc.style.strokeDasharray);
  const arcOffset = Number(s.arc.style.strokeDashoffset);
  check(
    "l'arc est en cours de tracé",
    arcDash && Math.abs(arcDash[0] - s.ARC_LENGTH) < 0.01 && arcOffset > 0 && arcOffset < s.ARC_LENGTH,
    `décalage ${arcOffset.toFixed(2)} sur ${s.ARC_LENGTH.toFixed(2)}`,
  );
  check(
    "depuis son premier point, où l'étincelle a atterri",
    arcOffset > 0,
    'décalage positif : le tracé se remplit depuis le début',
  );

  // L'épaule part avant la fin de l'arc.
  s.advance(120);
  const bodyOffset = Number(s.body.style.strokeDashoffset);
  check(
    "l'épaule commence avant que l'arc ne finisse",
    Number(s.arc.style.strokeDashoffset) > 0 && Number(s.body.style.opacity) === 1,
    'la lueur est un seul trait qui continue',
  );

  check(
    "l'épaule se dessine depuis sa fin",
    bodyOffset < 0,
    `décalage ${bodyOffset.toFixed(2)} : négatif, donc à rebours du tracé`,
  );

  // Une fois posée, elle est entière.
  s.advance(400);
  check(
    'les deux tracés finissent entiers',
    Math.abs(Number(s.arc.style.strokeDashoffset)) < 0.001 && Math.abs(Number(s.body.style.strokeDashoffset)) < 0.001,
  );
}

// ───────────────────── La respiration ─────────────────────

console.log('\nUne fois la remise faite\n');

{
  const s = mountShare();
  s.enter();
  s.advance(16);
  for (let i = 0; i < 60; i++) s.advance(16); // au-delà de la remise

  const readings = [];
  for (let i = 0; i < 40; i++) {
    s.advance(40);
    readings.push(Number(s.arc.style.opacity));
  }
  const min = Math.min(...readings);
  const max = Math.max(...readings);
  check(
    'le personnage respire au lieu de rester figé',
    max - min > 0.05,
    `opacité de ${min.toFixed(3)} à ${max.toFixed(3)}`,
  );
  check("sans jamais s'éteindre", min > 0.5, `minimum ${min.toFixed(3)}`);
  check(
    "l'arc et l'épaule respirent ensemble",
    Math.abs(Number(s.arc.style.opacity) - Number(s.body.style.opacity)) < 0.001,
  );
  check("l'animation continue de tourner", s.pending() > 0);
}

// ───────────────────── Le départ ─────────────────────

console.log("\nQuand le pointeur s'en va\n");

{
  const s = mountShare();
  s.enter();
  s.advance(16);
  for (let i = 0; i < 60; i++) s.advance(16);

  s.leave();
  s.advance(100);
  const fading = Number(s.arc.style.opacity);
  check("la lueur s'efface progressivement", fading > 0 && fading < 1, `opacité ${fading.toFixed(3)}`);

  for (let i = 0; i < 12; i++) s.advance(20);
  check(
    'le repos est rendu à la feuille de style',
    s.arc.style.opacity === undefined &&
      s.arc.style.strokeDasharray === undefined &&
      s.arc.style.strokeDashoffset === undefined,
    'aucune déclaration en ligne ne subsiste',
  );
  check(
    "l'étincelle revient à son point de départ",
    s.spark.getAttribute('cx') === '11.9' && s.spark.getAttribute('cy') === '4.2',
  );
  check('et plus rien ne tourne', s.pending() === 0);

  // Revenir doit relancer proprement, sans reprendre l'extinction en cours.
  s.enter();
  s.advance(16);
  check('un nouveau survol repart du début', Number(s.spark.style.opacity) > 0 && Number(s.arc.style.opacity) === 0);
}

/*
 * Quitter le bouton pendant que l'étincelle traverse trouve le second
 * personnage encore éteint. Une extinction qui descendrait depuis un le ferait
 * apparaître pour disparaître aussitôt : un éclair, au moment précis où l'on
 * s'en va sans rien avoir demandé.
 */
{
  const s = mountShare();
  s.enter();
  s.advance(16);
  s.advance(120); // l'étincelle est en route, l'arc est éteint

  check('le second personnage est bien encore éteint', Number(s.arc.style.opacity) === 0, `à ${s.at()} ms`);

  s.leave();
  const seen = [];
  for (let i = 0; i < 10; i++) {
    s.advance(20);
    seen.push(Number(s.arc.style.opacity) || 0);
  }
  check(
    "partir en pleine traversée n'allume rien",
    Math.max(...seen) === 0,
    `opacité maximale pendant l'extinction : ${Math.max(...seen)}`,
  );
}

// ───────────────────── Les animations refusées ─────────────────────

console.log('\nQuand les animations sont refusées\n');

{
  const s = mountShare({ reduced: true });
  check("aucun écouteur n'est posé", s.button._listeners.mouseenter === undefined, 'prefers-reduced-motion: reduce');
  check(
    'et les calques restent au repos',
    s.arc.style.opacity === undefined && s.spark.getAttribute('cx') === undefined,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
