/**
 * Vérifie les photos des invités connectés sur le bouton de partage — le vrai
 * js/sharedControl.js, dans jsdom, et les règles de modals.css qui le font
 * s'étirer.
 *
 * Le bouton portait un badge chiffré. Il se prolonge désormais des photos des
 * invités dont un tableau de bord est ouvert, et ce test tient ce qu'aucune
 * capture ne montre :
 *
 *  - **qui compte** : les invités en ligne seulement, jamais le maître lui-même,
 *    qui entre au carnet dès qu'il se nomme avec Discord ;
 *  - **trois photos au plus**, superposées, le premier par-dessus ; au-delà un
 *    quatrième cercle, glissé dessous, dit « +N » ;
 *  - **les cercles sont gardés d'un rendu à l'autre** : un état reçu à chaque
 *    piste qui change ne doit pas rejouer l'entrée de chaque photo, et une photo
 *    qui s'en va doit avoir le temps de s'effacer ;
 *  - **le bouton s'étire et se resserre** : la largeur de la rangée découle de
 *    son nombre de cercles et transitionne, avec une courbe par sens ;
 *  - **l'appel survit au badge** : une demande cercle la photo de son auteur,
 *    ou le décompte qui le range, ou — sans tableau de bord ouvert — un point
 *    dans le coin du bouton.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src', 'web', 'public');
const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('\n=== Les invités connectés sur le bouton de partage ===\n');

  /* ════════════════ Le balisage et la feuille ════════════════ */

  console.log('Le balisage et la feuille\n');
  {
    const MARKUP = read('index.html');
    const button = MARKUP.slice(
      MARKUP.indexOf('id="btn-open-share"'),
      MARKUP.indexOf('</button>', MARKUP.indexOf('id="btn-open-share"')),
    );
    check(
      'la rangée et le point sont dans le bouton lui-même',
      button.includes('id="share-presence"') && button.includes('id="share-knock-dot"'),
    );
    check(
      'le badge chiffré a disparu',
      !MARKUP.includes('share-badge') && !read('js', 'sharedControl.js').includes('share-badge'),
    );

    const CSS = read('css', 'modals.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = CSS.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
      return m ? m[1] : '';
    };

    check(
      'le bouton suit son contenu, 38 px au moins',
      /width:\s*auto/.test(rule('.btn-share-control')) && /min-width:\s*38px/.test(rule('.btn-share-control')),
    );
    check(
      'sans invité, la rangée ne prend aucune place',
      /width:\s*0;/.test(rule('.share-presence')) && /margin-left:\s*0;/.test(rule('.share-presence')),
    );
    check(
      'avec des invités, sa largeur découle du nombre de cercles',
      /width:\s*calc\(var\(--presence-size\) \+ \(var\(--slots, 1\) - 1\) \* var\(--presence-step\)\)/.test(
        rule('.share-presence.has-guests'),
      ),
    );

    const grow = rule('.share-presence');
    const shrink = rule('.share-presence.is-shrinking');
    check(
      "elle s'étire en transition, avec un léger dépassement",
      /transition:[^;]*width[^;]*cubic-bezier\(0\.34, 1\.45/.test(grow),
    );
    check(
      '  … et se resserre en transition, sans rebond',
      /transition:[^;]*width[^;]*cubic-bezier\(0\.4, 0, 0\.2, 1\)/.test(shrink),
    );
    check(
      'une photo qui entre ne garde pas son animation une fois jouée',
      /animation:[^;]*share-presence-in[^;]*backwards/.test(rule('.share-presence-item')),
    );
    check(
      'les mouvements se taisent quand le système le demande',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.share-presence-item\s*\{[^}]*animation:\s*none/.test(CSS),
    );
  }

  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (e) {
    console.log('\n  passé — jsdom absent de cette installation');
    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<button id="btn-open-share"><span id="share-presence"></span>' +
      '<span id="share-knock-dot" class="hidden"></span></button>' +
      '</body></html>',
    { runScripts: 'outside-only', url: 'http://localhost:3000/' },
  );
  const win = dom.window;
  const doc = win.document;
  win.MusicPlayer = { sendWS: () => {}, showToast: () => {}, state: { role: 'master', members: [] } };
  win.eval(read('js', 'sharedControl.js'));

  const row = doc.getElementById('share-presence');
  const dot = doc.getElementById('share-knock-dot');
  // L'ordre de l'écran est celui de `--i`, que le document suit sans y être tenu.
  const items = () =>
    Array.from(row.children)
      .filter((item) => !item.classList.contains('is-leaving'))
      .sort((a, b) => Number(a.style.getPropertyValue('--i')) - Number(b.style.getPropertyValue('--i')));
  const keys = () => items().map((item) => item.dataset.key);

  const guest = (id, extra = {}) => ({
    userId: id,
    displayName: `Invité ${id}`,
    avatar: `https://cdn.example/${id}.png`,
    online: true,
    ...extra,
  });
  const apply = (knownUsers, { pending = [], requests = {} } = {}) => {
    win.MusicPlayer.applyShareState({
      role: 'master',
      identity: { userId: 'OWNER' },
      sharing: { oauthReady: true, grants: {}, admitted: [], pending, knownUsers, requests, mutedRequests: [] },
    });
  };

  /* ════════════════ Qui compte ════════════════ */

  console.log('\nQui compte\n');
  {
    apply([]);
    check(
      'personne : la rangée est vide et le bouton garde sa forme',
      items().length === 0 && !row.classList.contains('has-guests') && row.style.getPropertyValue('--slots') === '0',
    );

    apply([guest('OWNER'), guest('A', { online: false })]);
    check('ni le maître, ni un invité sans tableau de bord ouvert', items().length === 0);

    apply([guest('A')]);
    const img = items()[0] && items()[0].querySelector('img');
    check(
      'un invité connecté : sa photo prolonge le bouton',
      keys().join() === 'user:A' &&
        row.classList.contains('has-guests') &&
        img &&
        img.getAttribute('src') === 'https://cdn.example/A.png',
      keys().join(),
    );
  }

  /* ════════════════ Trois au plus ════════════════ */

  console.log('\nTrois au plus\n');
  {
    apply([guest('A'), guest('B'), guest('C')]);
    const zs = items().map((item) => Number(item.style.zIndex));
    check('trois invités : trois photos, sans décompte', keys().join() === 'user:A,user:B,user:C', keys().join());
    check(
      '  … décalées une à une',
      items()
        .map((item) => item.style.getPropertyValue('--i'))
        .join() === '0,1,2',
    );
    check('  … la première par-dessus les suivantes', zs[0] > zs[1] && zs[1] > zs[2], zs.join());

    apply(['A', 'B', 'C', 'D', 'E'].map((id) => guest(id)));
    const more = items().find((item) => item.dataset.key === 'more');
    check(
      'cinq invités : trois photos et un quatrième cercle',
      keys().join() === 'user:A,user:B,user:C,more',
      keys().join(),
    );
    check("  … qui dit combien d'autres", more && more.textContent === '+2', more && more.textContent);
    check(
      '  … glissé sous les trois photos',
      more &&
        items()
          .slice(0, 3)
          .every((item) => Number(item.style.zIndex) > Number(more.style.zIndex)),
    );
    check('  … et la rangée compte quatre cercles', row.style.getPropertyValue('--slots') === '4');

    apply(['A', 'B', 'C', 'D'].map((id) => guest(id)));
    check('quatre invités : « +1 »', items()[3] && items()[3].textContent === '+1');
  }

  /* ════════════════ Des cercles gardés ════════════════ */

  console.log("\nDes cercles gardés d'un rendu à l'autre\n");
  {
    apply([guest('A'), guest('B')]);
    const [a, b] = items();
    apply([guest('A'), guest('B')]);
    check('un même état ne recrée aucun cercle', items()[0] === a && items()[1] === b);

    apply([guest('N'), guest('A'), guest('B')]);
    check(
      'une arrivée en tête garde les autres cercles',
      items()[1] === a && items()[2] === b && keys()[0] === 'user:N',
    );
    check(
      '  … et prend sa place dans le document sans les déplacer',
      Array.from(row.children)
        .filter((item) => !item.classList.contains('is-leaving'))
        .map((item) => item.dataset.key)
        .join() === 'user:N,user:A,user:B',
    );
    check(
      "  … qui glissent d'un cran",
      a.style.getPropertyValue('--i') === '1' && b.style.getPropertyValue('--i') === '2',
    );

    apply([guest('N'), guest('B')]);
    check(
      "un départ ne retire pas le cercle d'emblée : il s'efface",
      a.parentNode === row && a.classList.contains('is-leaving') && keys().join() === 'user:N,user:B',
      keys().join(),
    );
    check(
      '  … et la rangée se resserre aussitôt, en le disant',
      row.style.getPropertyValue('--slots') === '2' && row.classList.contains('is-shrinking'),
    );
    await sleep(350);
    check('  … puis il quitte le document', a.parentNode === null);

    apply([guest('N'), guest('B'), guest('C')]);
    check('une nouvelle arrivée repasse en étirement', !row.classList.contains('is-shrinking'));

    apply([]);
    check('le dernier départ rend au bouton sa forme', !row.classList.contains('has-guests') && items().length === 0);
  }

  /* ════════════════ Visages ════════════════ */

  console.log('\nVisages\n');
  {
    apply([guest('A', { avatar: null, displayName: 'yoohyeonz' })]);
    check("sans photo, l'initiale", items()[0].textContent === 'Y' && !items()[0].querySelector('img'));

    apply([guest('B')]);
    const img = items()[0].querySelector('img');
    img.dispatchEvent(new win.Event('error'));
    check(
      "une photo qui ne charge pas cède la place à l'initiale",
      items()[0].textContent === 'I' && !items()[0].querySelector('img'),
      items()[0].textContent,
    );
    apply([]);
    await sleep(350);
  }

  /* ════════════════ L'appel ════════════════ */

  console.log("\nQuelqu'un frappe à la porte\n");
  {
    apply([guest('A'), guest('B'), guest('W')], { pending: [{ userId: 'W', displayName: 'W' }] });
    check(
      'un invité qui attend son admission passe en tête, cerclé',
      keys()[0] === 'user:W' &&
        items()[0].classList.contains('is-knocking') &&
        !items()[1].classList.contains('is-knocking'),
      keys().join(),
    );
    check('  … et le point reste éteint : sa photo le dit', dot.classList.contains('hidden'));

    // Q et R attendent sans tableau de bord ouvert ; E attend, connecté, en fin de carnet.
    apply(
      ['A', 'B', 'C', 'D', 'E'].map((id) => guest(id)),
      { pending: [{ userId: 'Q' }, { userId: 'R' }, { userId: 'E' }] },
    );
    check(
      "le demandeur connecté passe devant ceux qui n'attendent rien",
      keys().join() === 'user:E,user:A,user:B,more' &&
        items()[0].classList.contains('is-knocking') &&
        !items()[3].classList.contains('is-knocking'),
      keys().join(),
    );
    check('  … et les demandeurs absents allument le point', !dot.classList.contains('hidden'));

    apply(
      ['A', 'B', 'C', 'D', 'E'].map((id) => guest(id)),
      {
        requests: {
          A: { 'playback.source': 1 },
          B: { 'volume.level': 1 },
          C: { 'queue.add': 1 },
          E: { 'queue.clear': 1 },
        },
      },
    );
    const more = items().find((item) => item.dataset.key === 'more');
    check(
      'quatre demandeurs connectés : les trois premiers et le décompte se cerclent',
      items()
        .slice(0, 3)
        .every((item) => item.classList.contains('is-knocking')) &&
        more &&
        more.classList.contains('is-knocking'),
      keys().join(),
    );

    apply([guest('A')], { requests: { GONE: { 'playback.source': 1 } } });
    check(
      "une demande dont l'auteur est parti allume le point du bouton",
      !dot.classList.contains('hidden') && !items()[0].classList.contains('is-knocking'),
    );

    apply([guest('A')]);
    check(
      'plus de demande, plus de point ni de cercle',
      dot.classList.contains('hidden') && !items()[0].classList.contains('is-knocking'),
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
