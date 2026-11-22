/**
 * Changelog — Lecture du journal des modifications, en frise.
 *
 * Le bot est livré avec son `CHANGELOG.md` ; cette fenêtre le donne à lire
 * sans quitter le tableau de bord, sous la forme qui convient à un journal : une
 * suite de livraisons datées, la plus récente en tête, chacune découpée en
 * catégories — ajouts, changements, correctifs, sécurité.
 *
 * **Ce qui est emprunté au lecteur de documentation** (js/docs.js) : la
 * charpente de la fenêtre, le sommaire qui passe en tiroir sous 860 px, le pied
 * qui dit où l'on en est, et le rendu du Markdown de niveau ligne — code
 * littéral, gras, italique. Les deux fenêtres sont sœurs, et doivent se
 * ressembler autant qu'elles se manœuvrent pareil.
 *
 * **Ce qui diffère.** La documentation est un texte à lire d'un bout à l'autre,
 * d'où sa pagination en double page. Un journal ne se lit pas ainsi : on y
 * cherche une date, une catégorie, un mot. D'où trois commandes qui n'ont pas
 * d'équivalent en face — un sommaire par mois, des filtres par catégorie, une
 * recherche — et aucune pagination : la frise défile.
 *
 * **Le découpage vient du serveur.** `/api/changelog` ne rend pas du Markdown
 * brut mais la charpente déjà extraite : livraisons, dates, catégories,
 * entrées. Le pourquoi est dans src/web/changelog.js. Le Markdown *à
 * l'intérieur* d'une entrée, lui, est rendu ici.
 *
 * **La langue.** L'habillage — titres, dates, libellés de catégorie — suit la
 * langue du tableau de bord, comme tout le reste. Le contenu, lui, n'est écrit
 * qu'en français et en anglais : réglé sur une autre langue, le tableau de bord
 * reçoit l'anglais et le dit dans son pied, pour qu'on n'y voie pas une
 * traduction oubliée.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  'use strict';

  /**
   * Catégories connues, dans l'ordre où elles paraissent — celui de
   * src/web/changelog.js, qui trie les groupes avant de les servir. Cette
   * liste-ci ne sert qu'aux pastilles de filtre, qui doivent suivre le même
   * ordre que les sections de la frise.
   */
  const KINDS = ['added', 'changed', 'fixed', 'removed', 'deprecated', 'security'];

  /**
   * Distance au haut de la frise en deçà de laquelle une livraison est celle
   * qu'on est en train de lire. Sans cette marge, le sommaire ne désignerait
   * la livraison qu'une fois son titre sorti du cadre par le haut.
   */
  const SPY_MARGIN = 90;

  /** Journal en mémoire, tel que le serveur l'a découpé. */
  let journal = null;
  /** Langue du tableau de bord au moment où ce journal a été demandé. */
  let askedLang = null;
  /** Catégories retenues par les filtres. Vide : toutes. */
  const kept = new Set();
  /** Recherche en cours, déjà repliée par `fold()`. */
  let needle = '';
  let initDone = false;
  let spyPending = false;

  function el(id) {
    return document.getElementById(id);
  }

  function t(key, fallback) {
    const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
    // `t()` renvoie la clé elle-même quand la traduction manque.
    return translated && translated !== key ? translated : fallback !== undefined ? fallback : key;
  }

  /** Un libellé au singulier ou au pluriel, avec son nombre. */
  function counted(number, oneKey, manyKey, oneFallback, manyFallback) {
    const template = number === 1 ? t(oneKey, oneFallback) : t(manyKey, manyFallback);
    return template.replace('{n}', String(number));
  }

  function isOpen() {
    const modal = el('changelog-modal');
    return !!modal && !modal.classList.contains('hidden');
  }

  function stream() {
    return el('changelog-stream');
  }

  /* ═══════════════════════ Langue et dates ═══════════════════════ */

  function dashboardLang() {
    const settings = window.MusicPlayer.dashboardSettings;
    return (settings && settings.language) || 'fr';
  }

  /**
   * Une date de livraison, écrite dans la langue du tableau de bord.
   *
   * `Intl` connaît les usages de chaque langue — « 14 septembre 2026 »,
   * « September 14, 2026 » — là où un assemblage à la main aurait imposé l'ordre
   * français à tout le monde. En cas d'échec, la date ISO du fichier est
   * servie telle quelle : illisible n'est pas la même chose qu'absente.
   */
  function formatDate(iso) {
    try {
      const [year, month, day] = iso.split('-').map(Number);
      return new Intl.DateTimeFormat(dashboardLang(), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(year, month - 1, day));
    } catch (e) {
      return iso;
    }
  }

  /** La même date, abrégée pour la colonne du sommaire. */
  function formatShortDate(iso) {
    try {
      const [year, month, day] = iso.split('-').map(Number);
      return new Intl.DateTimeFormat(dashboardLang(), {
        day: 'numeric',
        month: 'short',
      }).format(new Date(year, month - 1, day));
    } catch (e) {
      return iso;
    }
  }

  /** Le mois d'une date, pour les intertitres du sommaire. */
  function formatMonth(iso) {
    try {
      const [year, month] = iso.split('-').map(Number);
      const label = new Intl.DateTimeFormat(dashboardLang(), {
        month: 'long',
        year: 'numeric',
      }).format(new Date(year, month - 1, 1));
      // Plusieurs langues écrivent leurs mois en minuscule ; en tête de
      // groupe, la capitale est de mise.
      return label.charAt(0).toUpperCase() + label.slice(1);
    } catch (e) {
      return iso.slice(0, 7);
    }
  }

  /** Libellé d'une catégorie, traduit ; un mot-clé inconnu se montre tel quel. */
  function kindLabel(kind) {
    if (!kind) return '';
    const fallbacks = {
      added: 'Ajouté',
      changed: 'Modifié',
      fixed: 'Corrigé',
      removed: 'Retiré',
      deprecated: 'Déprécié',
      security: 'Sécurité',
    };
    if (!fallbacks[kind]) return kind;
    return t(`changelog_kind_${kind}`, fallbacks[kind]);
  }

  /* ═══════════════════════ Recherche ═══════════════════════ */

  /**
   * Replie un texte pour la comparaison : minuscules, accents ôtés.
   *
   * Chercher « securite » doit trouver « sécurité » — personne ne compose les
   * accents dans un champ de recherche. C'est l'inverse du calcul d'ancre de
   * js/docs.js, qui les conserve précisément parce qu'une ancre doit rester
   * fidèle au titre ; ici on cherche à rapprocher, pas à identifier.
   *
   * La longueur est préservée pour les lettres latines précomposées : une
   * lettre accentuée se décompose en une base et une marque, et la marque
   * disparaît. `highlight()` s'en sert pour retrouver ses positions, et vérifie
   * tout de même l'égalité des longueurs avant de s'y fier.
   */
  function fold(text) {
    return String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  }

  function hit(text) {
    return !needle || fold(text).includes(needle);
  }

  /* ═══════════════════════ Rendu des entrées ═══════════════════════ */

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Le Markdown de niveau ligne d'une entrée.
   *
   * Emprunté au lecteur de documentation, qui le fait déjà : code littéral,
   * gras, italique, liens. En écrire une seconde version ici aurait donné deux
   * rendus à tenir d'accord pour un seul style de texte.
   *
   * Le repli n'est pas décoratif : si docs.js venait à ne pas être chargé, une
   * entrée doit s'afficher en texte échappé plutôt que de faire tomber la
   * fenêtre entière. Les liens vers un document, eux, ne sont pas résolus
   * ici — le journal n'en contient pas, et un tel lien resterait inerte.
   */
  function inlineHtml(text) {
    const renderer = window.MusicPlayer.docsRendu;
    if (renderer && typeof renderer.inline === 'function') return renderer.inline(text);
    return escapeHtml(text);
  }

  /**
   * Surligne ce que la recherche a trouvé.
   *
   * Opère sur les nœuds de texte seulement : le HTML de l'entrée est déjà
   * construit, et une substitution sur la chaîne entière irait couper à
   * l'intérieur d'une balise — un `<code>` dont le nom contient le mot cherché
   * suffirait à casser le balisage.
   */
  function highlight(root) {
    if (!needle) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);

    for (const node of texts) {
      const raw = node.nodeValue;
      const folded = fold(raw);
      // Les positions ne se transportent que si le repli n'a rien décalé.
      if (folded.length !== raw.length || !folded.includes(needle)) continue;

      const pieces = document.createDocumentFragment();
      let from = 0;
      let at = folded.indexOf(needle);
      while (at !== -1) {
        if (at > from) pieces.appendChild(document.createTextNode(raw.slice(from, at)));
        const mark = document.createElement('mark');
        mark.className = 'changelog-mark';
        mark.textContent = raw.slice(at, at + needle.length);
        pieces.appendChild(mark);
        from = at + needle.length;
        at = folded.indexOf(needle, from);
      }
      if (from < raw.length) pieces.appendChild(document.createTextNode(raw.slice(from)));
      node.parentNode.replaceChild(pieces, node);
    }
  }

  /* ═══════════════════════ Ce qui reste visible ═══════════════════════ */

  /**
   * Les groupes d'une livraison, réduits à ce que les commandes laissent voir.
   *
   * Deux commandes se composent. Les filtres écartent des catégories entières.
   * La recherche, elle, écarte des entrées — sauf lorsqu'elle porte sur le
   * titre ou le résumé de la livraison : chercher « audit » doit trouver « L'audit
   * de sécurité », dont aucune entrée ne contient le mot, et montrer alors tout
   * ce qu'elle annonce.
   *
   * @returns {{groups: Array, count: number}} groupes retenus et total d'entrées
   */
  function keptOf(release) {
    const wholeRelease = hit(`${release.title} ${release.summary}`);
    const groups = [];
    let count = 0;

    for (const group of release.groups) {
      if (kept.size && !kept.has(group.kind)) continue;
      const entries = wholeRelease ? group.entries : group.entries.filter(hit);
      if (!entries.length) continue;
      groups.push({ kind: group.kind, entries });
      count += entries.length;
    }

    return { groups, count };
  }

  /** Les livraisons à afficher, chacune avec ce qu'il lui reste. */
  function visibleReleases() {
    if (!journal) return [];
    return journal.releases.map((release) => ({ release, ...keptOf(release) })).filter((entry) => entry.count > 0);
  }

  /* ═══════════════════════ Peinture ═══════════════════════ */

  function paintHeader() {
    const subtitle = el('changelog-subtitle');
    if (subtitle) {
      subtitle.textContent = journal
        ? `${counted(journal.count, 'changelog_changes_one', 'changelog_changes_many', '{n} changement', '{n} changements')} · ${counted(journal.releases.length, 'changelog_releases_one', 'changelog_releases_many', '{n} livraison', '{n} livraisons')}`
        : '';
    }

    // La langue du contenu, quand elle n'est pas celle du tableau de bord.
    const note = el('changelog-note');
    if (note) {
      const served = journal && journal.lang;
      const differs = served && served !== dashboardLang();
      note.classList.toggle('hidden', !differs);
      if (differs) {
        const names = { fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand' };
        const language = t(`changelog_lang_${served}`, names[served] || served);
        note.textContent = t(
          'changelog_lang_note',
          'Journal disponible en français et en anglais ; affiché en {lang}.',
        ).replace('{lang}', language);
      }
    }
  }

  /**
   * Les pastilles de filtre : « tout », puis une par catégorie présente.
   *
   * Les comptes sont ceux du journal entier, jamais ceux du filtre courant :
   * une pastille dit combien elle amènerait, et un nombre qui tombe à zéro
   * dès qu'on clique ailleurs n'aiderait personne à revenir.
   */
  function paintFilters() {
    const bar = el('changelog-filters');
    if (!bar) return;

    bar.innerHTML = '';
    if (!journal) return;

    const totals = new Map();
    for (const release of journal.releases) {
      for (const group of release.groups) {
        totals.set(group.kind, (totals.get(group.kind) || 0) + group.entries.length);
      }
    }

    const chip = (kind, label, total, active) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `changelog-chip${active ? ' active' : ''}`;
      if (kind) button.dataset.kind = kind;
      button.innerHTML = '<span class="changelog-chip-label"></span><span class="changelog-chip-count"></span>';
      button.querySelector('.changelog-chip-label').textContent = label;
      button.querySelector('.changelog-chip-count').textContent = String(total);
      button.addEventListener('click', () => {
        if (!kind) kept.clear();
        else if (kept.has(kind)) kept.delete(kind);
        else kept.add(kind);
        paintFilters();
        paintStream();
        paintSummary();
      });
      return button;
    };

    bar.appendChild(chip('', t('changelog_filter_all', 'Tout'), journal.count, kept.size === 0));

    // Les catégories connues d'abord, dans leur ordre ; puis tout mot-clé
    // que le fichier porterait sans qu'on le connaisse ici.
    const present = [...totals.keys()].filter(Boolean);
    const ordered = [
      ...KINDS.filter((kind) => present.includes(kind)),
      ...present.filter((kind) => !KINDS.includes(kind)).sort(),
    ];
    for (const kind of ordered) {
      bar.appendChild(chip(kind, kindLabel(kind), totals.get(kind), kept.has(kind)));
    }
  }

  /** Le sommaire : les livraisons visibles, groupées par mois. */
  function paintSummary() {
    const summary = el('changelog-toc');
    if (!summary) return;

    summary.innerHTML = '';
    const visible = visibleReleases();

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'changelog-toc-empty';
      empty.textContent = journal
        ? t('changelog_no_match', 'Aucun changement ne correspond.')
        : t('changelog_empty', 'Aucun journal trouvé (CHANGELOG.md).');
      summary.appendChild(empty);
      return;
    }

    let month = null;
    for (const { release, count } of visible) {
      const itsMonth = release.date.slice(0, 7);
      if (itsMonth !== month) {
        month = itsMonth;
        const title = document.createElement('div');
        title.className = 'changelog-toc-group';
        title.textContent = formatMonth(release.date);
        summary.appendChild(title);
      }

      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'changelog-toc-entry';
      entry.dataset.date = release.date;
      entry.innerHTML = '<span class="changelog-toc-date"></span><span class="changelog-toc-count"></span>';
      entry.querySelector('.changelog-toc-date').textContent = formatShortDate(release.date);
      entry.querySelector('.changelog-toc-count').textContent = String(count);
      entry.addEventListener('click', () => goToRelease(release.date));
      summary.appendChild(entry);
    }

    spy();
  }

  /** La frise elle-même. */
  function paintStream() {
    const host = stream();
    if (!host) return;

    host.innerHTML = '';
    const visible = visibleReleases();

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'changelog-empty';
      empty.textContent = journal
        ? t('changelog_no_match', 'Aucun changement ne correspond.')
        : t('changelog_empty', 'Aucun journal trouvé (CHANGELOG.md).');
      host.appendChild(empty);
      updateFooter();
      return;
    }

    const timeline = document.createElement('div');
    timeline.className = 'changelog-timeline';

    // L'ouverture du journal, en vue entière seulement : au-dessus d'une
    // sélection, elle annoncerait autre chose que ce qui suit.
    if (journal.intro && !needle && !kept.size) {
      const lead = document.createElement('p');
      lead.className = 'changelog-lead';
      lead.innerHTML = inlineHtml(journal.intro);
      timeline.appendChild(lead);
    }

    // La plus récente est la première du fichier, et le reste même si un
    // filtre la masque : c'est une propriété du journal, pas de la vue.
    const newest = journal.releases.length ? journal.releases[0].date : null;

    for (const { release, groups, count } of visible) {
      const section = document.createElement('section');
      section.className = `changelog-release${release.date === newest ? ' latest' : ''}`;
      section.dataset.date = release.date;

      const dot = document.createElement('span');
      dot.className = 'changelog-release-dot';
      section.appendChild(dot);

      const meta = document.createElement('div');
      meta.className = 'changelog-release-meta';

      const date = document.createElement('time');
      date.className = 'changelog-release-date';
      date.dateTime = release.date;
      date.textContent = formatDate(release.date);
      meta.appendChild(date);

      if (release.date === newest) {
        const badge = document.createElement('span');
        badge.className = 'changelog-release-badge';
        badge.textContent = t('changelog_latest', 'Dernière livraison');
        meta.appendChild(badge);
      }

      const tally = document.createElement('span');
      tally.className = 'changelog-release-count';
      tally.textContent = counted(
        count,
        'changelog_changes_one',
        'changelog_changes_many',
        '{n} changement',
        '{n} changements',
      );
      meta.appendChild(tally);
      section.appendChild(meta);

      if (release.title) {
        const title = document.createElement('h3');
        title.className = 'changelog-release-title';
        title.textContent = release.title;
        section.appendChild(title);
      }

      if (release.summary) {
        const summary = document.createElement('p');
        summary.className = 'changelog-release-summary';
        summary.innerHTML = inlineHtml(release.summary);
        section.appendChild(summary);
      }

      for (const group of groups) {
        const block = document.createElement('div');
        block.className = 'changelog-group';
        if (group.kind) block.dataset.kind = group.kind;

        if (group.kind) {
          const badge = document.createElement('span');
          badge.className = 'changelog-kind';
          badge.textContent = kindLabel(group.kind);
          block.appendChild(badge);
        }

        const list = document.createElement('ul');
        list.className = 'changelog-entries';
        for (const text of group.entries) {
          const item = document.createElement('li');
          item.className = 'changelog-entry';
          item.innerHTML = inlineHtml(text);
          list.appendChild(item);
        }
        block.appendChild(list);
        section.appendChild(block);
      }

      highlight(section);
      timeline.appendChild(section);
    }

    host.appendChild(timeline);
    host.scrollTop = 0;
    updateFooter();
  }

  /* ═══════════════════════ Défilement ═══════════════════════ */

  /**
   * Le pied dit la part du journal déjà parcourue.
   *
   * Même rôle que le numéro de page du lecteur de documentation, et même
   * calcul que son mode flux : il n'y a pas de page à numéroter, mais il y a
   * une progression à montrer.
   */
  function updateFooter() {
    const progress = el('changelog-progress');
    const host = stream();
    if (!progress || !host) return;

    const travel = host.scrollHeight - host.clientHeight;
    // Un journal qui tient dans la fenêtre est lu de bout en bout.
    const part = travel > 4 ? (host.scrollTop / travel) * 100 : 100;
    progress.textContent = `${Math.max(0, Math.min(100, Math.round(part)))} %`;
  }

  /**
   * Désigne dans le sommaire la livraison qu'on est en train de lire.
   *
   * Mesuré au rectangle et non aux `offsetTop` : sous 860 px le corps de la
   * fenêtre devient positionné pour recevoir le tiroir, et l'ancêtre de
   * référence des livraisons change alors sous nos pieds. Deux rectangles se
   * comparent toujours, quel que soit l'arbre.
   */
  function spy() {
    const host = stream();
    if (!host) return;

    const ceiling = host.getBoundingClientRect().top + SPY_MARGIN;
    let current = null;
    for (const section of host.querySelectorAll('.changelog-release')) {
      if (section.getBoundingClientRect().top <= ceiling) current = section.dataset.date;
      else break;
    }
    // Avant la première livraison — la frise ouvre sur elle —, c'est elle
    // qu'on lit.
    if (!current) {
      const first = host.querySelector('.changelog-release');
      current = first ? first.dataset.date : null;
    }

    const summary = el('changelog-toc');
    if (!summary) return;
    for (const entry of summary.querySelectorAll('.changelog-toc-entry')) {
      entry.classList.toggle('current', entry.dataset.date === current);
    }
  }

  /** Amène une livraison sous les yeux, depuis le sommaire. */
  function goToRelease(date) {
    const host = stream();
    const section = host && host.querySelector(`.changelog-release[data-date="${date}"]`);
    if (!host || !section) return;

    const top = section.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    host.scrollTo({ top: Math.max(0, top - 10), behavior: 'smooth' });
    // Le tiroir a fait son office.
    setupToc(false);
  }

  /* ═══════════════════════ Sommaire en tiroir ═══════════════════════ */

  /*
   * Sous 860 px, le sommaire quitte la colonne de gauche pour un tiroir posé
   * au-dessus de la frise — voir changelog.css, où la bascule est décidée.
   * Rien de cette forme ne vit ici : ce module se borne à ouvrir et à fermer.
   */

  function tocOpen() {
    const body = el('changelog-body');
    return Boolean(body && body.classList.contains('changelog-toc-open'));
  }

  function setupToc(shouldOpen) {
    const body = el('changelog-body');
    if (body) body.classList.toggle('changelog-toc-open', shouldOpen);

    // Le bouton est la poignée du tiroir : son état doit s'entendre autant
    // qu'il se voit.
    const button = el('btn-changelog-toc');
    if (button) button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  /* ═══════════════════════ Chargement ═══════════════════════ */

  async function load() {
    const lang = dashboardLang();
    try {
      const response = await fetch(`/api/changelog?lang=${encodeURIComponent(lang)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      journal = Array.isArray(payload.releases) ? payload : null;
      askedLang = journal ? lang : null;
    } catch (e) {
      journal = null;
      askedLang = null;
      if (typeof window.MusicPlayer.showToast === 'function') {
        window.MusicPlayer.showToast(t('changelog_load_failed', 'Journal illisible.'));
      }
    }

    paintHeader();
    paintFilters();
    paintStream();
    paintSummary();
  }

  /**
   * Rouvre le journal dans la langue du tableau de bord.
   *
   * Appelée par `applyLanguage()` (js/state.js) à chaque changement de langue,
   * comme son équivalent de la documentation. Deux choses en dépendent : le
   * contenu, qui n'existe qu'en deux langues et peut donc ne pas changer ; et
   * tout l'habillage — dates, libellés de catégorie, comptes —, qui change
   * toujours. D'où un rechargement complet plutôt qu'une simple repeinture :
   * c'est le serveur qui tranche quelle langue il sert.
   *
   * La fenêtre fermée, il n'y a rien à faire : le journal sera redemandé à
   * l'ouverture.
   */
  window.MusicPlayer.refreshChangelogLanguage = async function () {
    if (!journal && askedLang === null) return;
    if (!isOpen()) {
      journal = null;
      askedLang = null;
      return;
    }
    await load();
  };

  window.MusicPlayer.openChangelogModal = async function () {
    const modal = el('changelog-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    // Un tiroir laissé ouvert à la fermeture précédente masquerait la frise
    // dès la réouverture.
    setupToc(false);

    if (!journal || askedLang !== dashboardLang()) await load();
    else {
      // Les mesures ne valent que sur une fenêtre affichée.
      updateFooter();
      spy();
    }
  };

  window.MusicPlayer.closeChangelogModal = function () {
    const modal = el('changelog-modal');
    if (!modal || modal.classList.contains('hidden')) return false;
    modal.classList.add('hidden');
    return true;
  };

  /* ═══════════════════════ Initialisation ═══════════════════════ */

  /**
   * Les touches de lecture, appliquées au défilement de la frise.
   *
   * Reprend celles du mode flux du lecteur de documentation : la frise ne
   * reçoit pas le focus — lire ne demande pas de cliquer d'abord dedans —, le
   * navigateur ne la ferait donc pas défiler tout seul.
   *
   * La barre oblique amène au champ de recherche. C'est l'usage des interfaces
   * où l'on cherche, et elle ne coûte rien : elle n'est prise que quand aucune
   * saisie n'a le focus.
   */
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      // Échap reste au gestionnaire global, qui sait dans quel ordre les
      // fenêtres se referment.
      if (e.key === 'Escape') return;

      const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (!typing && e.key === '/') {
        e.preventDefault();
        const field = el('changelog-search-input');
        if (field) field.focus();
        return;
      }
      if (typing) return;

      const host = stream();
      if (!host) return;

      const screen = Math.max(120, Math.round(host.clientHeight * 0.9));

      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        host.scrollTo({ top: e.key === 'Home' ? 0 : host.scrollHeight, behavior: 'smooth' });
        return;
      }

      const step = {
        ArrowDown: 96,
        ArrowUp: -96,
        PageDown: screen,
        PageUp: -screen,
        ' ': screen,
        Spacebar: screen,
      }[e.key];

      if (step === undefined) return;
      e.preventDefault();
      // Les flèches se répètent sous un appui maintenu : un défilement
      // adouci s'y empilerait et donnerait une lecture élastique.
      host.scrollBy({ top: step, behavior: Math.abs(step) > 200 ? 'smooth' : 'auto' });
    });
  }

  function bindSearch() {
    const field = el('changelog-search-input');
    const clear = el('btn-changelog-search-clear');
    if (!field) return;

    const apply = () => {
      needle = fold(field.value.trim());
      if (clear) clear.classList.toggle('hidden', !field.value);
      paintStream();
      paintSummary();
    };

    field.addEventListener('input', apply);

    /*
     * Échap vide le champ plutôt que de fermer la fenêtre — mais seulement
     * s'il y a quelque chose à vider. Sur un champ déjà vide, la touche
     * repart au gestionnaire global et referme, comme partout ailleurs.
     */
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !field.value) return;
      e.stopPropagation();
      field.value = '';
      apply();
    });

    if (clear) {
      clear.addEventListener('click', () => {
        field.value = '';
        apply();
        field.focus();
      });
    }
  }

  function initChangelog() {
    if (initDone) return;
    const modal = el('changelog-modal');
    if (!modal) return;
    initDone = true;

    const open = el('btn-open-changelog');
    if (open) open.addEventListener('click', () => window.MusicPlayer.openChangelogModal());

    const close = el('btn-changelog-close');
    if (close) close.addEventListener('click', () => window.MusicPlayer.closeChangelogModal());

    const toc = el('btn-changelog-toc');
    if (toc) toc.addEventListener('click', () => setupToc(!tocOpen()));

    const scrim = el('changelog-toc-scrim');
    if (scrim) scrim.addEventListener('click', () => setupToc(false));

    const host = stream();
    if (host) {
      host.addEventListener(
        'scroll',
        () => {
          // Une image par rafale de molette : le sommaire se relit à
          // chaque événement, et il y en a des dizaines par geste.
          if (spyPending) return;
          spyPending = true;
          requestAnimationFrame(() => {
            spyPending = false;
            updateFooter();
            spy();
          });
        },
        { passive: true },
      );
    }

    // Clic sur le voile, en dehors de la fenêtre : même effet que la croix.
    modal.addEventListener('click', (e) => {
      if (e.target === modal) window.MusicPlayer.closeChangelogModal();
    });

    bindSearch();
    bindKeyboard();

    // La hauteur utile change sans que la fenêtre bouge — tiroir déployé,
    // barres du navigateur repliées, clavier tactile ouvert : l'avancement
    // et le repère du sommaire sont faux jusqu'au prochain défilement.
    window.addEventListener('resize', () => {
      if (!isOpen()) return;
      updateFooter();
      spy();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChangelog);
  } else {
    initChangelog();
  }
})();
