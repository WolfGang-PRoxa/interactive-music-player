/**
 * Docs — Lecture de la documentation embarquée, façon livre.
 *
 * Le bot est livré avec son dossier `docs/` ; cette fenêtre le donne à lire
 * sans quitter le tableau de bord, dans une mise en page paginée en double
 * page, avec tourne de feuille en trois dimensions.
 *
 * Deux modes de lecture, choisis par la bascule en tête de fenêtre :
 *   - **livre** : la double page paginée décrite plus bas, avec tourne de
 *     feuille ;
 *   - **flux** : le document d'un seul tenant, dans une page qui défile. Même
 *     DOM, même rendu du Markdown : la feuille de style neutralise les colonnes
 *     (`.docs-mode-flow`, dans css/docs.css) et ce module met en sommeil tout
 *     ce qui relève de la pagination.
 *
 * Deux visualisations, permutées par le bouton voisin :
 *   - **HTML** : le Markdown rendu, habillé des variables de thème du tableau
 *     de bord — la documentation suit donc le style choisi par l'utilisateur ;
 *   - **MD** : la source telle qu'elle est écrite, en chasse fixe, avec ses
 *     signes de ponctuation Markdown mis en couleur.
 *
 * **Comment la pagination fonctionne.** Le contenu est versé dans un conteneur
 * multi-colonnes d'une seule colonne, à hauteur fixe : tout ce qui déborde
 * engendre des colonnes supplémentaires qui s'accumulent vers la droite, hors
 * du cadre. Chaque page n'est alors qu'une fenêtre sur ce ruban, décalée d'un
 * multiple de (largeur + gouttière). Découper le texte à la main serait
 * autrement plus fragile : c'est le moteur de rendu qui décide où couper, et il
 * ne coupe jamais un mot en deux.
 *
 * Quatre fenêtres regardent le même ruban : les deux pages posées, et les deux
 * faces de la feuille qui tourne. Tourner une page ne fait que changer quatre
 * décalages — rien n'est reconstruit, ce qui est la condition pour que
 * l'animation reste fluide sur un document de vingt pages.
 *
 * Le serveur ne sert que ce qu'il a lui-même inventorié dans `docs/` : voir
 * `/api/docs` dans src/web/routes/api.js.
 *
 * **La langue suit celle du tableau de bord.** `docs/` est rangé par langue —
 * `docs/fr/`, `docs/en/`… — et les identifiants de document sont les mêmes dans
 * toutes : changer de langue rouvre le même document, traduit. Ce qui ne l'est
 * pas encore est servi dans la langue de référence plutôt que de manquer au
 * sommaire. Voir `refreshDocsLanguage()` plus bas.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
    'use strict';

    /** Vue retenue d'une session à l'autre : `html` ou `md`. */
    const VIEW_KEY = 'music_player_docs_view';
    /** Dernier document ouvert, pour reprendre la lecture où elle s'est arrêtée. */
    const LAST_KEY = 'music_player_docs_last';
    /** Mode de lecture retenu d'une session à l'autre : `livre` ou `flux`. */
    const MODE_KEY = 'music_player_docs_mode';

    /**
     * Durée de la tourne de feuille. Doit rester en phase avec la transition
     * déclarée sur `.docs-leaf` : le JS reprend la main à la fin de
     * l'animation, et un écart laisserait la feuille figée en l'air.
     */
    const TURN_DURATION_MS = 760;

    /** Un cran de molette par tourne : sans quoi un geste envoie dix pages. */
    const WHEEL_REST = 420;

    /** Sommaire renvoyé par le serveur. */
    let catalog = [];
    /**
     * Langue du sommaire en mémoire, pour repérer celui qui a vieilli.
     *
     * `refreshDocsLanguage()` se charge normalement de le renouveler, mais la
     * vérification à l'ouverture ne coûte rien et rattrape le cas où le
     * changement de langue serait passé sans lui.
     */
    let catalogLang = null;
    /** Sources déjà téléchargées : id → Markdown brut. */
    const sources = new Map();
    /** Document affiché. */
    let currentDoc = null;
    /** Visualisation courante : `html` ou `md`. */
    let view = 'html';
    /**
     * Mode de lecture courant.
     *
     * `livre` pagine en double page, avec tourne de feuille ; `flux` rend le
     * document d'un seul tenant dans une page qui défile, comme n'importe
     * quelle page web. Les deux partagent le même DOM et le même rendu du
     * Markdown : c'est la feuille de style qui neutralise les colonnes, et ce
     * module qui met en sommeil tout ce qui relève de la pagination.
     */
    let mode = 'book';

    /** Index de la première colonne de la double page affichée. */
    let column = 0;
    /** Nombre total de colonnes du document, à la mise en page courante. */
    let columnCount = 1;
    /** Largeur d'une colonne + gouttière, en pixels. */
    let columnStep = 0;
    /** Colonnes visibles d'un seul coup : 2 en double page, 1 en fenêtre étroite. */
    let perView = 2;

    /** Une tourne est en cours : les commandes de navigation sont suspendues. */
    let turning = false;
    let lastWheelPlate = 0;
    let initDone = false;
    let resizeTimer = null;

    function el(id) {
        return document.getElementById(id);
    }

    function t(key, fallback) {
        const translated = typeof window.MusicPlayer.t === 'function' ? window.MusicPlayer.t(key) : key;
        // `t()` renvoie la clé elle-même quand la traduction manque.
        return translated && translated !== key ? translated : fallback !== undefined ? fallback : key;
    }

    function isOpen() {
        const modal = el('docs-modal');
        return !!modal && !modal.classList.contains('hidden');
    }

    function isFlowMode() {
        return mode === 'flow';
    }

    /** La fenêtre qui défile en mode flux : la page de gauche, seule affichée. */
    function flowWindow() {
        return document.querySelector('.docs-sheet-left .docs-viewport');
    }

    /* ═══════════════════════ Rendu du Markdown ═══════════════════════ */

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Identifiant d'ancre d'un titre, dans la convention de GitHub : c'est
     * celle qu'emploient les liens internes de la documentation.
     *
     * Les lettres accentuées sont conservées. Les replier sur leur forme nue —
     * ce que faisait une normalisation NFD posée ici — paraît anodin mais
     * désaccorde le calcul de sa référence : GitHub ne dépouille pas les
     * accents, et la documentation est écrite avec ses règles. Neuf liens
     * internes du français ne menaient donc nulle part dans cette fenêtre alors
     * qu'ils fonctionnaient sur le dépôt — « Accès au tableau de bord »,
     * « Le coût du double modèle »… La question se reposait en espagnol et en
     * allemand, dont les titres portent les mêmes signes.
     *
     * `\p{L}` retient les lettres de toutes les écritures, et non le seul `a-z`
     * qui ne pouvait que perdre ce que la normalisation venait d'aplatir.
     */
    function anchor(text) {
        return String(text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .trim()
            .replace(/\s+/g, '-');
    }

    /**
     * Balise d'un lien.
     *
     * Trois destinations, trois traitements : un autre document du dossier
     * `docs/` s'ouvre dans cette même fenêtre, une ancre déplace la lecture
     * dans la page, et le reste part dans un onglet neuf. Un chemin qui ne
     * désigne rien de tout cela — `src/index.js`, par exemple — n'est pas un
     * lien : le rendre cliquable ne mènerait qu'à une erreur.
     */
    function link(url, content) {
        const raw = String(url);

        if (/^https?:\/\//i.test(raw)) {
            return `<a class="docs-link docs-link-external" href="${raw}" target="_blank" rel="noopener noreferrer">${content}</a>`;
        }
        if (raw.startsWith('#')) {
            return `<a class="docs-link docs-link-anchor" href="#" data-ancre="${escapeHtml(raw.slice(1))}">${content}</a>`;
        }
        if (/\.md(#.*)?$/i.test(raw)) {
            return `<a class="docs-link docs-link-doc" href="#" data-doc="${escapeHtml(raw)}">${content}</a>`;
        }
        return `<span class="docs-link-inert">${content}</span>`;
    }

    /**
     * Rendu des marques de niveau ligne : code littéral, gras, italique, liens.
     *
     * Le texte est échappé d'entrée de jeu, puis les codes littéraux sont mis
     * de côté sous un jeton : à l'intérieur d'un `code`, ni les astérisques ni
     * les crochets ne veulent dire quoi que ce soit, et les laisser passer
     * transformerait un exemple de Markdown en Markdown appliqué.
     */
    function renderInline(text) {
        let html = escapeHtml(text);

        const codes = [];
        html = html.replace(/`([^`]+)`/g, (_, content) => {
            codes.push(`<code class="docs-code-inline">${content}</code>`);
            return ` ${codes.length - 1} `;
        });

        html = html
            .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (_, linkText, url) => link(url, linkText))
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_]+)__/g, '<strong>$1</strong>')
            .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
            .replace(/ {2}$/, '<br>');

        return html.replace(/ (\d+) /g, (_, index) => codes[Number(index)]);
    }

    /** Une ligne de liste : marqueur, indentation, contenu. */
    function parseItem(line) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (!m) return null;
        return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] };
    }

    /**
     * Construit une liste — et ses sous-listes — à partir d'items déjà
     * analysés. L'imbrication se lit dans l'indentation, seule information dont
     * dispose le Markdown pour la dire.
     *
     * @returns {{ html: string, index: number }} html produit, et premier item non consommé
     */
    function buildList(items, start, indentRef) {
        const ordered = items[start].ordered;
        const parts = [];
        let i = start;

        while (i < items.length && items[i].indent >= indentRef) {
            if (items[i].indent > indentRef) {
                const nested = buildList(items, i, items[i].indent);
                // La sous-liste appartient au dernier point ouvert.
                if (parts.length) parts[parts.length - 1] += nested.html;
                else parts.push(nested.html);
                i = nested.index;
                continue;
            }
            // Un changement de nature (puces ↔ numéros) ouvre une autre liste.
            if (items[i].ordered !== ordered) break;
            parts.push(renderInline(items[i].text));
            i++;
        }

        const tag = ordered ? 'ol' : 'ul';
        const body = parts.map((m) => `<li>${m}</li>`).join('');
        return { html: `<${tag} class="docs-list">${body}</${tag}>`, index: i };
    }

    /** Découpe une ligne de tableau en cellules. */
    function cells(line) {
        return line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
    }

    function isTableSeparator(line) {
        return !!line && /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|');
    }

    /**
     * Rendu d'un document Markdown.
     *
     * Analyseur par blocs, une passe, sans dépendance : les documents du projet
     * s'en tiennent aux constructions courantes (titres, listes, tableaux,
     * blocs de code, citations, filets), et embarquer une bibliothèque pour
     * cela coûterait plus cher que de les traiter ici.
     *
     * Le HTML brut n'est jamais recopié tel quel : tout passe par
     * `echapper()`. La documentation n'en contient pas, et un fichier déposé
     * dans `docs/` ne doit pas pouvoir injecter de balise dans la page.
     */
    function renderMarkdown(source) {
        const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
        const html = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (!line.trim()) {
                i++;
                continue;
            }

            // ── Bloc de code clôturé ──
            const opening = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
            if (opening) {
                const fenceChar = opening[1][0];
                const closing = new RegExp(`^\\s*\\${fenceChar}{${opening[1].length},}\\s*$`);
                const codeLang = opening[2] || '';
                const body = [];
                i++;
                while (i < lines.length && !closing.test(lines[i])) {
                    body.push(lines[i]);
                    i++;
                }
                i++; // la ligne de fermeture
                html.push(
                    `<pre class="docs-code-block"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}>` +
                        `<code>${escapeHtml(body.join('\n'))}</code></pre>`
                );
                continue;
            }

            // ── Titre ──
            const title = /^(#{1,6})\s+(.*)$/.exec(line);
            if (title) {
                const level = title[1].length;
                const text = title[2].replace(/\s+#+\s*$/, '').trim();
                html.push(
                    `<h${level} id="${anchor(text)}" class="docs-title docs-title-${level}">` +
                        `${renderInline(text)}</h${level}>`
                );
                i++;
                continue;
            }

            // ── Filet ──
            if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
                html.push('<hr class="docs-rule">');
                i++;
                continue;
            }

            // ── Tableau ──
            if (line.includes('|') && isTableSeparator(lines[i + 1])) {
                const headers = cells(line);
                const alignments = cells(lines[i + 1]).map((c) => {
                    if (/^:.*:$/.test(c)) return 'center';
                    if (/:$/.test(c)) return 'right';
                    return 'left';
                });
                i += 2;

                const body = [];
                while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
                    body.push(cells(lines[i]));
                    i++;
                }

                const style = (index) => ` style="text-align:${alignments[index] || 'left'}"`;
                const th = headers.map((c, n) => `<th${style(n)}>${renderInline(c)}</th>`).join('');
                const tr = body
                    .map((row) => `<tr>${row.map((c, n) => `<td${style(n)}>${renderInline(c)}</td>`).join('')}</tr>`)
                    .join('');
                html.push(
                    `<div class="docs-table-frame"><table class="docs-table">` +
                        `<thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
                );
                continue;
            }

            // ── Citation ──
            if (/^\s*>/.test(line)) {
                const inside = [];
                while (i < lines.length && (/^\s*>/.test(lines[i]) || (inside.length && lines[i].trim()))) {
                    inside.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                html.push(`<blockquote class="docs-quote">${renderMarkdown(inside.join('\n'))}</blockquote>`);
                continue;
            }

            // ── Liste ──
            if (parseItem(line)) {
                const items = [];
                while (i < lines.length) {
                    const item = parseItem(lines[i]);
                    if (item) {
                        items.push(item);
                        i++;
                        continue;
                    }
                    // Ligne de continuation : elle prolonge le point ouvert.
                    if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
                        items[items.length - 1].text += ` ${lines[i].trim()}`;
                        i++;
                        continue;
                    }
                    // Ligne vide : la liste se poursuit si un point la suit.
                    if (!lines[i].trim() && parseItem(lines[i + 1])) {
                        i++;
                        continue;
                    }
                    break;
                }
                html.push(buildList(items, 0, items[0].indent).html);
                continue;
            }

            // ── Paragraphe ──
            const paragraph = [];
            while (
                i < lines.length &&
                lines[i].trim() &&
                !/^(#{1,6})\s/.test(lines[i]) &&
                !/^\s*(`{3,}|~{3,})/.test(lines[i]) &&
                !/^\s*>/.test(lines[i]) &&
                !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i]) &&
                !parseItem(lines[i])
            ) {
                paragraph.push(lines[i]);
                i++;
            }
            if (paragraph.length) {
                html.push(`<p class="docs-paragraph">${renderInline(paragraph.join('\n'))}</p>`);
            } else {
                // Aucune règle n'a mordu et le paragraphe est vide : la ligne
                // ouvrirait une boucle sans fin si on ne la consommait pas.
                i++;
            }
        }

        return html.join('');
    }

    /* ═══════════════════ Rendu de la source Markdown ═══════════════════ */

    /**
     * Vue « MD » : la source, à la ligne près.
     *
     * Chaque ligne devient son propre bloc plutôt qu'un `<pre>` d'un seul
     * tenant : c'est ce qui permet à la pagination en colonnes de couper entre
     * deux lignes, et jamais au milieu de l'une d'elles.
     *
     * La coloration ne prétend pas analyser le Markdown — elle met en évidence
     * ses signes pour que la structure saute aux yeux. À l'intérieur d'un bloc
     * de code, elle s'abstient : ce qui s'y trouve n'est pas du Markdown.
     */
    function renderSource(source) {
        const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
        let inCode = false;

        return lines
            .map((line) => {
                let content = escapeHtml(line);
                const classes = ['docs-md-line'];

                const closingFence = /^\s*(`{3,}|~{3,})/.test(line);
                if (closingFence) {
                    inCode = !inCode;
                    classes.push('docs-md-fence-close');
                    return `<div class="${classes.join(' ')}">${content}</div>`;
                }

                if (inCode) {
                    classes.push('docs-md-code');
                    return `<div class="${classes.join(' ')}">${content}</div>`;
                }

                const title = /^(#{1,6})(\s+.*)$/.exec(content);
                if (title) {
                    classes.push('docs-md-title');
                    content = `<span class="docs-md-abbr">${title[1]}</span>${title[2]}`;
                    return `<div class="${classes.join(' ')}">${content}</div>`;
                }

                if (/^\s*&gt;/.test(content)) classes.push('docs-md-quote');
                if (/^\s*\|/.test(content)) classes.push('docs-md-table');
                if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) classes.push('docs-md-rule');

                content = content
                    .replace(/^(\s*)([-*+]|\d+[.)])(\s)/, '$1<span class="docs-md-abbr">$2</span>$3')
                    .replace(/`([^`]+)`/g, '<span class="docs-md-literal">`$1`</span>')
                    .replace(/(\*\*[^*]+\*\*)/g, '<span class="docs-md-strong">$1</span>')
                    .replace(/(\[[^\]]+\])(\([^)]+\))/g, '<span class="docs-md-link">$1</span><span class="docs-md-target">$2</span>');

                return `<div class="${classes.join(' ')}">${content}</div>`;
            })
            .join('');
    }

    /* ═════════════════════════ Mise en pages ═════════════════════════ */

    /** Les quatre fenêtres ouvertes sur le ruban de colonnes. */
    function ribbons() {
        return {
            left: document.querySelector('.docs-sheet-left .docs-flow'),
            right: document.querySelector('.docs-sheet-right .docs-flow'),
            before: document.querySelector('.docs-leaf-front .docs-flow'),
            back: document.querySelector('.docs-leaf-back .docs-flow'),
        };
    }

    /** Verse le même contenu dans les quatre rubans. */
    function setContent(html) {
        const all = ribbons();
        Object.values(all).forEach((ribbon) => {
            if (ribbon) ribbon.innerHTML = html;
        });
    }

    /** En deçà, un bloc de code ne se lit plus : mieux vaut le laisser dépasser. */
    const MIN_CODE_PX = 8;

    /**
     * Règle la taille du texte de chaque bloc de code sur sa plus longue ligne.
     *
     * Les schémas de la documentation ne se replient pas — les couper à la
     * ligne détruirait le dessin. La solution habituelle, une barre de
     * défilement horizontale, est ici pire que le mal : elle ferait du bloc un
     * conteneur de défilement, c'est-à-dire un bloc insécable, et un schéma
     * plus haut qu'une page serait tronqué sans recours (voir docs.css).
     *
     * On ajuste donc la largeur par la taille du texte. La police étant à
     * chasse fixe, une seule mesure suffit à connaître la largeur d'un
     * caractère : le reste est une règle de trois.
     *
     * La même taille est reportée sur les quatre rubans — ils doivent rester
     * rigoureusement identiques, faute de quoi leurs colonnes ne tomberaient
     * plus aux mêmes endroits.
     */
    function fitCodeBlocks() {
        const all = Object.values(ribbons()).filter(Boolean);
        const template = all[0];
        if (!template) return;

        const blocks = Array.from(template.querySelectorAll('.docs-code-block'));
        if (!blocks.length) return;

        const firstCode = blocks[0].querySelector('code');
        if (!firstCode) return;

        const style = getComputedStyle(firstCode);
        const defaultSize = parseFloat(style.fontSize) || 12;

        // Sonde : largeur d'un caractère pour une taille de 100 px.
        const probe = document.createElement('span');
        probe.style.cssText =
            'position:absolute;visibility:hidden;white-space:pre;font-size:100px;' +
            `font-family:${style.fontFamily};`;
        probe.textContent = 'M'.repeat(50);
        template.appendChild(probe);
        const charWidthPerPixel = probe.getBoundingClientRect().width / 50 / 100;
        probe.remove();
        if (!charWidthPerPixel) return;

        const others = all.slice(1).map((ribbon) => Array.from(ribbon.querySelectorAll('.docs-code-block')));

        blocks.forEach((block, index) => {
            const code = block.querySelector('code');
            if (!code) return;

            const lines = code.textContent.split('\n');
            const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
            if (!longest) return;

            const box = getComputedStyle(block);
            const available =
                block.clientWidth - parseFloat(box.paddingLeft || 0) - parseFloat(box.paddingRight || 0);
            if (available <= 0) return;

            const fitting = available / (longest * charWidthPerPixel);
            const size = Math.min(defaultSize, Math.max(MIN_CODE_PX, fitting));
            if (size >= defaultSize) return;

            const value = `${size.toFixed(2)}px`;
            code.style.fontSize = value;
            others.forEach((list) => {
                const twin = list[index] && list[index].querySelector('code');
                if (twin) twin.style.fontSize = value;
            });
        });
    }

    /**
     * Donne aux quatre rubans la géométrie qui les fera se découper en colonnes.
     *
     * **Pourquoi ce détour.** Il existe deux façons d'obtenir des colonnes qui
     * se suivent vers la droite. La première tient en trois lignes de feuille de
     * style : un conteneur étroit, une hauteur fixe, et le moteur repousse ce
     * qui déborde dans des colonnes supplémentaires hors du cadre. C'est ce que
     * faisait `.docs-flow`, et c'est élégant — mais ces « colonnes de
     * débordement » ne sont pas produites par tous les moteurs. Relevé sur
     * téléphone : hauteur imposée à 475 px, contenu de 4003 px, et une seule
     * colonne. Le texte s'allongeait vers le bas, `overflow: hidden` en cachait
     * les sept huitièmes, et il n'y avait jamais de page suivante.
     *
     * La seconde façon est banale et universellement gérée : un conteneur
     * **large**, dont les colonnes tiennent dans le flux au lieu d'en déborder.
     * Le cadre n'en montre qu'une à la fois, et la translation fait le reste —
     * exactement comme avant. C'est celle-ci qu'on prend, au prix d'une largeur
     * qui ne peut plus se déclarer dans la feuille de style, puisqu'elle dépend
     * du contenu.
     *
     * **Comment la largeur se calcule.** En deux temps, car la hauteur naturelle
     * du document ne se lit qu'une fois les colonnes défaites. On remet donc le
     * ruban à plat, on mesure, puis on taille. La largeur de page ne changeant
     * pas entre les deux passes, le découpage des lignes reste le même et la
     * mesure garde sa valeur.
     *
     * Deux colonnes de mou sont ajoutées : un bloc insécable peut refuser de se
     * couper là où le calcul l'attendait. Une colonne allouée en trop ne coûte
     * rien — `compterColonnes()` dira où le texte s'arrête réellement, et
     * `place()` masque tout ce qui suit.
     *
     * Les quatre rubans reçoivent la même géométrie : ils doivent se fragmenter
     * aux mêmes endroits, sans quoi la feuille qui tourne ne montrerait pas la
     * même chose que celle qu'elle recouvre.
     *
     * @param {number} pageWidth Largeur d'une page, lue sur la fenêtre.
     * @param {number} gutter Espace entre deux colonnes.
     */
    function prepareRibbons(pageWidth, gutter) {
        const sheet = document.querySelector('.docs-sheet-left');
        const template = document.querySelector('.docs-sheet-left .docs-flow');
        if (!sheet || !template) return;

        const box = getComputedStyle(sheet);
        const height = sheet.clientHeight
            - parseFloat(box.paddingTop || 0)
            - parseFloat(box.paddingBottom || 0);

        // Fenêtre encore repliée, ou pas encore mise en page : mieux vaut ne
        // rien imposer que d'imposer zéro.
        if (!(height > 0) || !(pageWidth > 0)) return;

        const all = Object.values(ribbons()).filter(Boolean);

        // Première passe : colonne unique, pour lire la hauteur du document.
        all.forEach((ribbon) => {
            ribbon.style.width = '';
            ribbon.style.columnWidth = '';
            ribbon.style.columnCount = '';
            ribbon.style.height = `${height}px`;
        });

        const natural = template.scrollHeight;
        const count = Math.max(1, Math.ceil(natural / height) + 2);

        // Seconde passe : la largeur qui loge ce nombre de colonnes. `columnCount`
        // doit céder — déclaré à 1 dans la feuille de style, il plafonnerait le
        // découpage quelle que soit la largeur offerte.
        const ribbonWidth = count * (pageWidth + gutter) - gutter;
        all.forEach((ribbon) => {
            ribbon.style.columnCount = 'auto';
            ribbon.style.columnWidth = `${pageWidth}px`;
            ribbon.style.width = `${ribbonWidth}px`;
        });
    }

    /**
     * Relit la géométrie : largeur d'une page, gouttière, nombre de colonnes.
     *
     * À faire après chaque changement de contenu ou de taille de fenêtre — le
     * découpage en colonnes est entièrement l'affaire du moteur de rendu, et
     * seule une mesure dit combien il en a produites.
     */
    function measure() {
        const left = document.querySelector('.docs-sheet-left .docs-viewport');
        const ribbon = document.querySelector('.docs-sheet-left .docs-flow');
        const right = document.querySelector('.docs-sheet-right');
        if (!left || !ribbon) return;

        // La largeur de page se lit sur la fenêtre, jamais sur le ruban : celui-ci
        // est taillé bien plus large que le cadre, et se mesurer lui-même
        // reviendrait à multiplier la page par le nombre de pages.
        const width = left.clientWidth;
        const gutter = parseFloat(getComputedStyle(ribbon).columnGap) || 0;
        columnStep = width + gutter;

        // La double page n'existe que si la seconde feuille est affichée : le
        // basculement en page simple est décidé par une requête de média, pas
        // ici — la mise en page reste ainsi dans la feuille de style.
        perView = right && getComputedStyle(right).display !== 'none' ? 2 : 1;

        // Puis on taille : sans colonnes, il n'y a rien à compter.
        prepareRibbons(width, gutter);

        columnCount = columnStep > 0 ? countColumns(ribbon) : 1;
    }

    /**
     * Combien de colonnes le moteur a-t-il réellement produites ?
     *
     * `ribbon.scrollWidth` semblait tout indiqué, et il tenait sur ordinateur.
     * Il ne tient pas ailleurs : la zone de défilement d'un conteneur
     * multi-colonnes ne se définit pas de la même façon d'un moteur à l'autre,
     * et surtout tout débordement s'y ajoute sans pour autant créer de colonne.
     * Or les schémas de la documentation technique débordent : `ajusterBlocsCode()`
     * les réduit jusqu'à huit pixels, plancher en deçà duquel ils cesseraient
     * d'être lisibles, et sur un écran étroit cela ne suffit pas à les faire
     * tenir dans la colonne. Le compte tombait alors à deux sur téléphone : la
     * lecture s'arrêtait à une deuxième page vide, quelle que soit la longueur
     * du document.
     *
     * Une sentinelle posée en fin de contenu répond sans ambiguïté — la colonne
     * où elle atterrit est la dernière. Elle ne mesure aucune largeur, elle
     * occupe une position, et c'est précisément ce qu'on cherche ; `allerAncre()`
     * navigue déjà sur ce principe. N'ayant aucune hauteur, elle ne peut pas
     * déborder de la colonne qui l'accueille, et n'en crée donc jamais une de
     * plus.
     *
     * @param {HTMLElement} ribbon Le ruban de gauche, celui qui fait référence.
     * @returns {number} Au moins 1.
     */
    function countColumns(ribbon) {
        const sentinel = document.createElement('span');
        sentinel.setAttribute('aria-hidden', 'true');
        sentinel.style.cssText = 'display:inline-block;width:0;height:0;';
        ribbon.appendChild(sentinel);
        const end = sentinel.offsetLeft;
        sentinel.remove();

        // Arrondi et non troncature : la sentinelle se pose sur le bord de sa
        // colonne, à quelques centièmes de pixel près selon le zoom.
        return Math.max(1, Math.round(end / columnStep) + 1);
    }

    /** Pose une fenêtre sur la colonne demandée, ou la vide si elle n'existe pas. */
    function place(ribbon, index) {
        if (!ribbon) return;
        if (index < 0 || index >= columnCount) {
            ribbon.style.visibility = 'hidden';
            return;
        }
        ribbon.style.visibility = '';
        ribbon.style.transform = `translateX(${-index * columnStep}px)`;
    }

    function updateFolios() {
        const left = document.querySelector('.docs-sheet-left .docs-folio');
        const right = document.querySelector('.docs-sheet-right .docs-folio');
        if (left) left.textContent = column < columnCount ? String(column + 1) : '';
        if (right) right.textContent = column + 1 < columnCount ? String(column + 2) : '';

        const paginate = el('docs-pager');
        if (paginate) {
            const last = Math.min(column + perView, columnCount);
            const folioRange = perView === 2 && last > column + 1 ? `${column + 1}–${last}` : `${column + 1}`;
            paginate.textContent = `${folioRange} / ${columnCount}`;
        }

        const previous = el('btn-docs-prev');
        const next = el('btn-docs-next');
        if (previous) previous.disabled = column <= 0;
        if (next) next.disabled = column + perView >= columnCount;
    }

    /** Affiche une double page sans animation. */
    function show(index) {
        const all = ribbons();
        column = Math.max(0, Math.min(index, Math.max(0, columnCount - 1)));
        // La double page commence toujours sur une colonne paire : sans cela,
        // avancer puis reculer décalerait le texte d'une page à chaque
        // aller-retour.
        if (perView === 2) column -= column % 2;

        place(all.left, column);
        place(all.right, perView === 2 ? column + 1 : -1);
        updateFolios();
    }

    /* ═══════════════════════ Tourne de feuille ═══════════════════════ */

    /** Pose la feuille mobile sur l'une des deux pages, à la même place. */
    function setSheet(side) {
        const sheetEl = el('docs-leaf');
        const page = document.querySelector(side === 'left' ? '.docs-sheet-left' : '.docs-sheet-right');
        const book = el('docs-book');
        if (!sheetEl || !page || !book) return null;

        const frame = book.getBoundingClientRect();
        const target = page.getBoundingClientRect();

        sheetEl.style.left = `${target.left - frame.left}px`;
        sheetEl.style.top = `${target.top - frame.top}px`;
        sheetEl.style.width = `${target.width}px`;
        sheetEl.style.height = `${target.height}px`;
        sheetEl.style.transformOrigin = side === 'left' ? 'right center' : 'left center';
        return sheetEl;
    }

    /**
     * Tourne une feuille.
     *
     * Les deux sens décrivent le même geste, en miroir : la feuille part **à
     * plat sur la page qu'on soulève**, pivote autour de la reliure, et vient
     * se poser sur l'autre moitié du livre.
     *
     *   - en avant, on soulève la page de droite : charnière à gauche,
     *     rotation de 0° à −180°, la feuille se pose à gauche ;
     *   - en arrière, on soulève la page de gauche : charnière à droite,
     *     rotation de 0° à +180°, la feuille se pose à droite.
     *
     * D'où la règle qui gouverne les trois placements : le **recto** porte la
     * page qu'on soulève — il est donc, au premier instant, la copie conforme
     * de ce qui est déjà affiché ; le **verso** porte la page sur laquelle la
     * feuille va retomber ; et la page posée *sous* la feuille reçoit
     * immédiatement son nouveau contenu, que le mouvement dévoile.
     *
     * C'est ce recto en trompe-l'œil qui rend le changement invisible : sans
     * lui, la page qui se trouve sous la feuille changerait à vue au premier
     * instant de l'animation.
     */
    function turn(direction) {
        if (isFlowMode()) return;
        if (turning) return;

        const forward = direction > 0;
        const target = forward ? column + perView : column - perView;
        if (target < 0 || target >= columnCount) return;

        // En page simple, la feuille n'aurait nulle part où se poser : le
        // glissement latéral dit la même chose sans mentir sur la géométrie.
        if (perView === 1) return drag(direction, target);

        const all = ribbons();
        const sheetEl = setSheet(forward ? 'right' : 'left');
        if (!sheetEl) return show(target);

        turning = true;

        if (forward) {
            place(all.before, column + 1); // recto : la page de droite qu'on soulève
            place(all.back, target); // verso : la future page de gauche
            place(all.right, target + 1); // dévoilée sous la feuille
        } else {
            place(all.before, column); // recto : la page de gauche qu'on soulève
            place(all.back, target + 1); // verso : la future page de droite
            place(all.left, target); // dévoilée sous la feuille
        }

        sheetEl.classList.remove('hidden');
        sheetEl.classList.toggle('docs-leaf-back', !forward);
        // Les deux sens partent à plat sur la page soulevée ; seule la charnière
        // et le signe de la rotation les distinguent. Départ posé, puis rotation
        // au cadre suivant : appliquer les deux dans la même image ferait sauter
        // la transition.
        sheetEl.style.transform = 'rotateY(0deg)';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sheetEl.classList.add('docs-leaf-animated');
                sheetEl.style.transform = forward ? 'rotateY(-180deg)' : 'rotateY(180deg)';
            });
        });

        const finish = () => {
            sheetEl.classList.remove('docs-leaf-animated');
            sheetEl.classList.add('hidden');
            sheetEl.style.transform = '';
            turning = false;
            show(target);
        };

        let done = false;
        const once = () => {
            if (done) return;
            done = true;
            sheetEl.removeEventListener('transitionend', once);
            finish();
        };
        sheetEl.addEventListener('transitionend', once);
        // Filet : une transition avortée (onglet masqué, animation coupée par
        // les préférences système) ne doit pas laisser le livre bloqué.
        setTimeout(once, TURN_DURATION_MS + 120);
    }

    /** Transition de repli, en page simple : la page glisse et s'efface. */
    function drag(direction, target) {
        const page = document.querySelector('.docs-sheet-left');
        if (!page) return show(target);

        turning = true;
        page.classList.add(direction > 0 ? 'docs-exit-left' : 'docs-exit-right');

        setTimeout(() => {
            show(target);
            page.classList.remove('docs-exit-left', 'docs-exit-right');
            page.classList.add(direction > 0 ? 'docs-enter-right' : 'docs-enter-left');
            setTimeout(() => {
                page.classList.remove('docs-enter-right', 'docs-enter-left');
                turning = false;
            }, 220);
        }, 200);
    }

    /* ═════════════════════════ Chargement ═════════════════════════ */

    /**
     * Langue de lecture : celle choisie sur le tableau de bord.
     *
     * La documentation n'a pas de réglage propre. Rien ne justifierait qu'on
     * lise l'interface dans une langue et sa documentation dans une autre, et
     * un réglage de plus se désaccorderait du premier au premier oubli.
     *
     * Le serveur retombe seul sur la langue de référence pour ce qui n'est pas
     * traduit : il n'y a donc rien à vérifier ici.
     */
    function docsLang() {
        const settings = window.MusicPlayer.dashboardSettings;
        return (settings && settings.language) || 'fr';
    }

    async function loadCatalog() {
        const lang = docsLang();
        try {
            const response = await fetch(`/api/docs?lang=${encodeURIComponent(lang)}`, {
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(String(response.status));
            const payload = await response.json();
            catalog = Array.isArray(payload.documents) ? payload.documents : [];
            catalogLang = lang;
        } catch (e) {
            catalog = [];
            catalogLang = null;
        }
        paintSummary();
        return catalog;
    }

    async function readSource(id) {
        if (sources.has(id)) return sources.get(id);

        const response = await fetch(
            `/api/docs/content?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(docsLang())}`,
            { credentials: 'same-origin' },
        );
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        sources.set(id, payload.source || '');
        return sources.get(id);
    }

    /**
     * Rouvre la documentation dans la langue du tableau de bord.
     *
     * Appelée par `applyLanguage()` (js/state.js) à chaque changement de langue.
     * Le cache des sources est vidé : il est indexé par identifiant, et ces
     * identifiants sont volontairement les mêmes d'une langue à l'autre — sans
     * cette purge, un document déjà lu resterait affiché dans son ancienne
     * langue.
     *
     * La fenêtre fermée, il n'y a rien à repeindre : le sommaire et le document
     * seront redemandés à la réouverture. Ouverte, on rouvre le même document —
     * même identifiant, autre langue — depuis sa première page, la progression
     * d'un texte n'ayant pas d'équivalent dans sa traduction.
     */
    window.MusicPlayer.refreshDocsLanguage = async function () {
        if (catalogLang === null && !currentDoc) return;

        const wanted = currentDoc ? currentDoc.id : null;
        sources.clear();
        catalog = [];
        catalogLang = null;
        currentDoc = null;

        if (!isOpen()) return;

        await loadCatalog();
        const target = catalog.find((d) => d.id === wanted) || catalog[0];
        if (target) await openDocument(target.id);
    };

    /** Libellé de groupe : le dossier, ou la racine de la langue. */
    function groupLabel(group) {
        if (!group) return t('docs_group_root', 'Guide');
        if (group === 'technique') return t('docs_group_technique', 'Documentation technique');
        return group;
    }

    function paintSummary() {
        const summary = el('docs-toc');
        if (!summary) return;

        summary.innerHTML = '';

        if (!catalog.length) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'docs-toc-empty';
            emptyEl.textContent = t('docs_empty', 'Aucun document trouvé dans le dossier docs/.');
            summary.appendChild(emptyEl);
            return;
        }

        let currentGroup = null;
        catalog.forEach((document_) => {
            if (document_.group !== currentGroup) {
                currentGroup = document_.group;
                const title = document.createElement('div');
                title.className = 'docs-toc-group';
                title.textContent = groupLabel(currentGroup);
                summary.appendChild(title);
            }

            const entry = document.createElement('button');
            entry.className = 'docs-toc-entry';
            entry.dataset.doc = document_.id;
            if (currentDoc && currentDoc.id === document_.id) entry.classList.add('active');
            entry.innerHTML =
                `<span class="docs-toc-title"></span>` +
                `<span class="docs-toc-file"></span>`;
            entry.querySelector('.docs-toc-title').textContent = document_.title;
            entry.querySelector('.docs-toc-file').textContent = document_.id.split('/').pop();
            entry.addEventListener('click', () => openDocument(document_.id));
            summary.appendChild(entry);
        });
    }

    /** Repeint le document courant dans la vue choisie, à la page demandée. */
    function render(wantedColumn = 0, wantedAnchor = null) {
        if (!currentDoc) return;

        setContent(view === 'md' ? renderSource(currentDoc.source) : renderMarkdown(currentDoc.source));
        // L'ajustement change la hauteur des blocs de code, donc le découpage
        // en colonnes : il doit précéder la mesure.
        if (view !== 'md') fitCodeBlocks();

        if (isFlowMode()) {
            renderFlow(wantedAnchor);
            return;
        }

        measure();
        if (wantedAnchor) goToAnchor(wantedAnchor);
        else show(wantedColumn);
    }

    /**
     * Pose le document dans la fenêtre qui défile.
     *
     * Les translations laissées par `place()` survivraient à la bascule : elles
     * sont en style en ligne sur les rubans, et la feuille de style ne pourrait
     * les défaire qu'à coups de `!important`. On les efface donc ici, à la
     * source.
     */
    function renderFlow(wantedAnchor) {
        Object.values(ribbons()).forEach((ribbon) => {
            if (!ribbon) return;
            ribbon.style.transform = '';
            ribbon.style.visibility = '';
            // La géométrie taillée pour la pagination n'a pas cours ici : le flux
            // reprend la largeur de sa fenêtre et s'étend vers le bas autant que
            // le document le demande.
            ribbon.style.height = '';
            ribbon.style.width = '';
            ribbon.style.columnWidth = '';
            ribbon.style.columnCount = '';
        });

        const windowEl = flowWindow();
        if (windowEl) windowEl.scrollTop = 0;

        if (wantedAnchor) goToAnchor(wantedAnchor);
        updateFooter();
    }

    /** Amène une ancre sous les yeux, dans l'un ou l'autre mode. */
    function goToAnchor(anchorName) {
        const target = document.querySelector(`.docs-sheet-left .docs-flow [id="${CSS.escape(anchorName)}"]`);
        if (!target) return;

        if (isFlowMode()) {
            const windowEl = flowWindow();
            if (windowEl) windowEl.scrollTop = target.offsetTop;
            updateFooter();
            return;
        }

        if (columnStep > 0) show(Math.round(target.offsetLeft / columnStep));
    }

    /**
     * Le pied de fenêtre en mode flux.
     *
     * Il n'y a plus de page à numéroter : la part déjà parcourue tient le même
     * rôle — dire où l'on en est du document.
     */
    function updateFooter() {
        const paginate = el('docs-pager');
        const windowEl = flowWindow();
        if (!paginate || !windowEl) return;

        const travel = windowEl.scrollHeight - windowEl.clientHeight;
        // Un document qui tient dans la fenêtre est lu de bout en bout.
        const part = travel > 4 ? (windowEl.scrollTop / travel) * 100 : 100;
        paginate.textContent = `${Math.max(0, Math.min(100, Math.round(part)))} %`;
    }

    async function openDocument(id, wantedAnchor = null) {
        const sheet = catalog.find((d) => d.id === id);
        if (!sheet) return;

        // Le tiroir a fait son office : il se retire tout de suite, sans
        // attendre la lecture de la source, pour que le choix se voie.
        setupToc(false);

        const book = el('docs-book');
        if (book) book.classList.add('docs-book-loaded');

        let source;
        try {
            source = await readSource(id);
        } catch (e) {
            if (book) book.classList.remove('docs-book-loaded');
            if (typeof window.MusicPlayer.showToast === 'function') {
                window.MusicPlayer.showToast(t('docs_load_failed', 'Document illisible.'));
            }
            return;
        }

        currentDoc = { id, title: sheet.title, source };
        try {
            localStorage.setItem(LAST_KEY, id);
        } catch (e) {}

        const titleEl = el('docs-current-title');
        if (titleEl) titleEl.textContent = sheet.title;

        paintSummary();
        render(0, wantedAnchor);

        if (book) book.classList.remove('docs-book-loaded');
    }

    /* ═══════════════════════ Sommaire en tiroir ═══════════════════════ */

    /*
     * Sous 860 px, le sommaire quitte la colonne de gauche pour un tiroir posé
     * au-dessus du livre — voir docs.css, où la bascule est décidée. Rien de
     * cette forme ne vit ici : ce module se borne à ouvrir et à fermer.
     *
     * Au large, la classe est sans effet. Le sommaire y reste une colonne, et
     * poser ou retirer un attribut sur le corps ne lui fait rien : il n'y a donc
     * aucune largeur à interroger, ni ici ni ailleurs.
     */

    function docsBody() {
        return el('docs-body');
    }

    function tocOpen() {
        const bodyEl = docsBody();
        return Boolean(bodyEl && bodyEl.classList.contains('docs-toc-open'));
    }

    /**
     * Ouvre ou ferme le tiroir du sommaire.
     * @param {boolean} shouldOpen
     */
    function setupToc(shouldOpen) {
        const bodyEl = docsBody();
        if (bodyEl) bodyEl.classList.toggle('docs-toc-open', shouldOpen);

        // Le bouton est la poignée du tiroir : son état doit s'entendre autant
        // qu'il se voit.
        const buttonEl = el('btn-docs-toc');
        if (buttonEl) buttonEl.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    }

    /* ═══════════════════════ Vue MD / HTML ═══════════════════════ */

    function updateViewButton() {
        const badge = el('docs-view-badge');
        // Le bouton annonce la vue vers laquelle il mène, pas celle qu'on
        // regarde : c'est ce qu'on attend d'un bouton.
        if (badge) badge.textContent = view === 'html' ? 'MD' : 'HTML';

        const button = el('btn-docs-view');
        if (button) {
            // La clé est portée par l'élément, et pas seulement résolue ici :
            // elle dépend de la vue courante, donc le balisage ne peut pas la
            // fixer une fois pour toutes. Sans elle, `applyLanguage()` — qui
            // parcourt les `data-i18n-tooltip` — n'avait aucun moyen de
            // retrouver ce bouton, et son infobulle restait dans la langue
            // précédente jusqu'au prochain basculement de vue ou rechargement.
            const i18nKey = view === 'html' ? 'docs_tooltip_view_md' : 'docs_tooltip_view_html';
            button.setAttribute('data-i18n-tooltip', i18nKey);
            button.dataset.tooltip =
                view === 'html'
                    ? t(i18nKey, 'Afficher la source Markdown')
                    : t(i18nKey, 'Afficher la version mise en forme');
        }

        const modalEl = el('docs-modal');
        if (modalEl) modalEl.classList.toggle('docs-view-md', view === 'md');
    }

    function toggleView() {
        if (turning) return;

        // La pagination n'a rien de commun d'une vue à l'autre : on retient la
        // progression dans le document plutôt qu'un numéro de page.
        const progress = readProgress();

        view = view === 'html' ? 'md' : 'html';
        try {
            localStorage.setItem(VIEW_KEY, view);
        } catch (e) {}

        updateViewButton();
        render(0);
        goToProgress(progress);
    }

    /* ═══════════════════ Mode livre / mode flux ═══════════════════ */

    /**
     * Part du document déjà parcourue, entre 0 et 1.
     *
     * Une page et une hauteur de défilement ne se convertissent pas l'une en
     * l'autre. Ce qui se transporte d'une mise en page à la suivante — autre
     * vue, autre mode, autre taille de fenêtre —, c'est cette fraction-là.
     */
    function readProgress() {
        if (isFlowMode()) {
            const windowEl = flowWindow();
            const travel = windowEl ? windowEl.scrollHeight - windowEl.clientHeight : 0;
            return travel > 0 ? windowEl.scrollTop / travel : 0;
        }
        return columnCount > 1 ? column / columnCount : 0;
    }

    /** Reprend la lecture à la fraction donnée du document. */
    function goToProgress(part) {
        if (!isFlowMode()) {
            show(Math.round(part * columnCount));
            return;
        }

        const windowEl = flowWindow();
        if (!windowEl) return;
        windowEl.scrollTop = Math.max(0, (windowEl.scrollHeight - windowEl.clientHeight) * part);
        updateFooter();
    }

    function updateModeButton() {
        const switchEl = el('docs-mode-switch');
        if (switchEl) {
            switchEl.querySelectorAll('.docs-mode-btn').forEach((buttonEl) => {
                buttonEl.classList.toggle('active', buttonEl.dataset.mode === mode);
            });
        }

        // C'est cette classe qui neutralise les colonnes, côté feuille de
        // style : elle doit être posée avant tout rendu.
        const modalEl = el('docs-modal');
        if (modalEl) modalEl.classList.toggle('docs-mode-flow', isFlowMode());

        const hint = el('docs-hint');
        if (hint) {
            // On change la clé portée par l'élément, pas seulement son texte :
            // un changement de langue repasse sur `data-i18n` et effacerait
            // sinon l'indication propre au mode.
            const i18nKey = isFlowMode() ? 'docs_hint_flow' : 'docs_hint';
            hint.setAttribute('data-i18n', i18nKey);
            hint.textContent = isFlowMode()
                ? t(i18nKey, 'Molette ou barre de défilement pour parcourir le document')
                : t(i18nKey, 'Flèches, molette ou clic pour tourner les pages');
        }
    }

    function setMode(next) {
        if (turning || next === mode || (next !== 'book' && next !== 'flow')) return;

        const progress = readProgress();

        mode = next;
        try {
            localStorage.setItem(MODE_KEY, mode);
        } catch (e) {}

        updateModeButton();
        render(0);
        goToProgress(progress);
    }

    /* ═════════════════════════ Ouverture ═════════════════════════ */

    /** Résout un lien `01-architecture.md#ancre` depuis le document courant. */
    function resolveDocLink(href) {
        const [path, targetAnchor] = String(href).split('#');
        const base = currentDoc && currentDoc.id.includes('/') ? currentDoc.id.replace(/\/[^/]*$/, '') : '';

        const segments = (base ? `${base}/${path}` : path).split('/');
        const stack = [];
        segments.forEach((segment) => {
            if (!segment || segment === '.') return;
            if (segment === '..') stack.pop();
            else stack.push(segment);
        });

        return { id: stack.join('/'), anchor: targetAnchor || null };
    }

    function bindLinks() {
        const book = el('docs-book');
        if (!book) return;

        book.addEventListener('click', (e) => {
            const linkAnchor = e.target.closest('.docs-link-anchor');
            if (linkAnchor) {
                e.preventDefault();
                // En flux, le document est déjà entier sous les yeux : il n'y a
                // qu'à s'y déplacer. En livre, la colonne de destination ne se
                // connaît qu'après une mise en pages.
                if (isFlowMode()) goToAnchor(linkAnchor.dataset.anchor);
                else render(column, linkAnchor.dataset.anchor);
                return;
            }

            const docLink = e.target.closest('.docs-link-doc');
            if (docLink) {
                e.preventDefault();
                const { id, anchor: target } = resolveDocLink(docLink.dataset.doc);
                if (catalog.some((d) => d.id === id)) openDocument(id, target);
                return;
            }
        });
    }

    window.MusicPlayer.openDocsModal = async function () {
        const modal = el('docs-modal');
        if (!modal) return;

        modal.classList.remove('hidden');
        // Un tiroir laissé ouvert à la fermeture précédente masquerait la
        // page dès la réouverture.
        setupToc(false);
        // La géométrie ne se mesure que sur une fenêtre affichée : tout ce qui
        // suit attend donc que la fenêtre soit à l'écran.
        if (!catalog.length || catalogLang !== docsLang()) await loadCatalog();

        if (!currentDoc) {
            let wanted = null;
            try {
                wanted = localStorage.getItem(LAST_KEY);
            } catch (e) {}
            const first = catalog.find((d) => d.id === wanted) || catalog[0];
            if (first) await openDocument(first.id);
        } else {
            render(column);
        }
    };

    window.MusicPlayer.closeDocsModal = function () {
        const modal = el('docs-modal');
        if (!modal || modal.classList.contains('hidden')) return false;
        modal.classList.add('hidden');
        return true;
    };

    /**
     * Rendu exposé à part : c'est la seule partie du module qui se teste sans
     * navigateur, et la seule dont on peut avoir besoin ailleurs.
     *
     * `inline` sert au journal des modifications (js/changelog.js), dont les
     * entrées portent le même Markdown de niveau ligne — code littéral, gras,
     * italique. Deux rendus pour un seul style de texte auraient fini par
     * diverger ; celui-ci fait autorité.
     */
    window.MusicPlayer.docsRendu = { markdown: renderMarkdown, source: renderSource, inline: renderInline };

    /* ═══════════════════════ Initialisation ═══════════════════════ */

    function bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!isOpen()) return;
            // La touche Échap reste au gestionnaire global, qui sait dans quel
            // ordre les fenêtres se referment.
            if (e.key === 'Escape') return;
            if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

            if (isFlowMode()) {
                flowKeyboard(e);
                return;
            }

            const forward = ['ArrowRight', 'PageDown', ' ', 'Spacebar'].includes(e.key);
            const stepBack = ['ArrowLeft', 'PageUp'].includes(e.key);

            if (forward || stepBack) {
                e.preventDefault();
                turn(forward ? 1 : -1);
            } else if (e.key === 'Home') {
                e.preventDefault();
                show(0);
            } else if (e.key === 'End') {
                e.preventDefault();
                show(columnCount - 1);
            }
        });
    }

    /**
     * Les mêmes touches, appliquées au défilement.
     *
     * La fenêtre qui défile ne reçoit pas le focus — la lecture ne demande pas
     * de cliquer d'abord dans la page —, le navigateur ne la ferait donc pas
     * défiler tout seul. Un cran de flèche vaut quelques lignes, un cran de
     * page vaut presque un écran : le recouvrement garde le fil de la lecture.
     */
    function flowKeyboard(e) {
        const windowEl = flowWindow();
        if (!windowEl) return;

        const screen = Math.max(120, Math.round(windowEl.clientHeight * 0.9));

        if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            windowEl.scrollTo({ top: e.key === 'Home' ? 0 : windowEl.scrollHeight, behavior: 'smooth' });
            return;
        }

        const step = {
            ArrowDown: 96,
            ArrowUp: -96,
            ArrowRight: screen,
            ArrowLeft: -screen,
            PageDown: screen,
            PageUp: -screen,
            ' ': screen,
            Spacebar: screen,
        }[e.key];

        if (step === undefined) return;
        e.preventDefault();
        // Les flèches se répètent sous un appui maintenu : un défilement
        // adouci s'y empilerait et donnerait une lecture élastique.
        const smoothness = Math.abs(step) > 200 ? 'smooth' : 'auto';
        windowEl.scrollBy({ top: step, behavior: smoothness });
    }

    function bindWheel() {
        const readerEl = document.querySelector('.docs-reader');
        if (!readerEl) return;

        readerEl.addEventListener(
            'wheel',
            (e) => {
                // En flux, la molette fait ce qu'elle fait partout ailleurs :
                // rien à intercepter.
                if (isFlowMode()) return;

                // Un bloc de code qui déborde garde sa barre de défilement : la
                // molette lui appartient tant que le geste est horizontal.
                if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

                const now = Date.now();
                if (now - lastWheelPlate < WHEEL_REST) return;
                if (Math.abs(e.deltaY) < 8) return;

                lastWheelPlate = now;
                e.preventDefault();
                turn(e.deltaY > 0 ? 1 : -1);
            },
            { passive: false }
        );
    }

    /** Distance, en pixels, en deçà de laquelle un glissement n'en est pas un. */
    const SWIPE_MIN = 45;

    /** Écart à partir duquel on tranche qu'un geste est horizontal. */
    const SWIPE_WAKE = 10;

    /**
     * Le doigt tourne les pages.
     *
     * Au doigt, la flèche est un petit rectangle qu'il faut viser, et la molette
     * n'existe pas : le glissement est le geste attendu d'un livre. Il appelle
     * la même `turn()` que les deux autres entrées, et hérite donc de tout ce
     * qu'elle sait déjà — le mode flux qui ne pagine pas, la tourne en cours
     * qu'on ne double pas, et les bornes du document.
     *
     * **La direction.** Le doigt pousse la page : en allant vers la gauche, il
     * la chasse de ce côté et découvre la suivante. C'est le sens de tous les
     * livres à l'écran, et l'inverse serait ressenti comme une erreur.
     *
     * **Pourquoi mémoriser l'horizontalité.** Un geste reconnu horizontal le
     * reste jusqu'à son terme. Sans cette mémoire, un doigt qui dévie en fin de
     * course rendrait la main au navigateur au milieu du mouvement, et la page
     * à demi tournée resterait en plan.
     *
     * Le geste n'est revendiqué qu'une fois reconnu : jusque-là, le navigateur
     * garde le sien — défilement vertical du mode flux, pincement, sélection.
     */
    function bindSwipe() {
        const book = el('docs-book');
        if (!book) return;

        let swipe = null;

        book.addEventListener('touchstart', (e) => {
            // À deux doigts c'est un pincement, et le zoom ne nous regarde pas.
            if (isFlowMode() || e.touches.length !== 1) { swipe = null; return; }
            const finger = e.touches[0];
            swipe = { x: finger.clientX, y: finger.clientY, horizontal: false };
        }, { passive: true });

        book.addEventListener('touchmove', (e) => {
            if (!swipe || e.touches.length !== 1) return;

            const finger = e.touches[0];
            const dx = finger.clientX - swipe.x;
            const dy = finger.clientY - swipe.y;

            if (!swipe.horizontal
                && Math.abs(dx) > SWIPE_WAKE
                && Math.abs(dx) > Math.abs(dy)) {
                swipe.horizontal = true;
            }

            // Revendiquer le geste écarte la sélection de texte et le balayage
            // de retour du navigateur.
            if (swipe.horizontal) e.preventDefault();
        }, { passive: false });

        book.addEventListener('touchend', (e) => {
            const swipePath = swipe;
            swipe = null;
            if (!swipePath || !swipePath.horizontal) return;

            const finger = e.changedTouches && e.changedTouches[0];
            if (!finger) return;

            const dx = finger.clientX - swipePath.x;
            if (Math.abs(dx) < SWIPE_MIN) return;

            turn(dx < 0 ? 1 : -1);
        }, { passive: true });

        // Appel entrant, notification, geste repris par le système : le trajet
        // n'ira pas à son terme et ne doit pas survivre au suivant.
        book.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
    }

    function initDocs() {
        if (initDone) return;
        const modal = el('docs-modal');
        if (!modal) return;
        initDone = true;

        try {
            const stored = localStorage.getItem(VIEW_KEY);
            if (stored === 'md' || stored === 'html') view = stored;
        } catch (e) {}
        updateViewButton();

        try {
            const range = localStorage.getItem(MODE_KEY);
            if (range === 'book' || range === 'flow') mode = range;
        } catch (e) {}
        updateModeButton();

        const open = el('btn-open-docs');
        if (open) open.addEventListener('click', () => window.MusicPlayer.openDocsModal());

        const close = el('btn-docs-close');
        if (close) close.addEventListener('click', () => window.MusicPlayer.closeDocsModal());

        const toc = el('btn-docs-toc');
        if (toc) toc.addEventListener('click', () => setupToc(!tocOpen()));

        const scrim = el('docs-toc-scrim');
        if (scrim) scrim.addEventListener('click', () => setupToc(false));

        const toggleEl = el('btn-docs-view');
        if (toggleEl) toggleEl.addEventListener('click', toggleView);

        const modeSwitch = el('docs-mode-switch');
        if (modeSwitch) {
            modeSwitch.querySelectorAll('.docs-mode-btn').forEach((buttonEl) => {
                buttonEl.addEventListener('click', () => setMode(buttonEl.dataset.mode));
            });
        }

        const windowEl = flowWindow();
        if (windowEl) {
            windowEl.addEventListener(
                'scroll',
                () => {
                    if (isFlowMode()) updateFooter();
                },
                { passive: true }
            );
        }

        const previous = el('btn-docs-prev');
        if (previous) previous.addEventListener('click', () => turn(-1));

        const next = el('btn-docs-next');
        if (next) next.addEventListener('click', () => turn(1));

        // Clic sur le voile, en dehors de la fenêtre : même effet que la croix.
        modal.addEventListener('click', (e) => {
            if (e.target === modal) window.MusicPlayer.closeDocsModal();
        });

        bindLinks();
        bindKeyboard();
        bindWheel();
        bindSwipe();

        window.addEventListener('resize', relayout);
        watchPage();
    }

    /**
     * Refait la mise en page après un changement de géométrie.
     *
     * La largeur de page a changé : le découpage en colonnes est caduc, et la
     * taille des blocs de code avec lui. On repart du rendu complet, en gardant
     * la progression dans le document — seule chose qui ait encore un sens
     * d'une mise en page à l'autre. En flux, il n'y a pas de colonnes à refaire,
     * mais la taille des blocs de code, elle, suit toujours la largeur.
     *
     * L'attente amortit les rafales : un redimensionnement en émet des dizaines,
     * une animation de tiroir une par image. On ne veut recomposer qu'une fois,
     * à l'arrivée.
     */
    function relayout() {
        if (!isOpen() || !currentDoc) return;

        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const progress = readProgress();
            render(0);
            goToProgress(progress);
        }, 180);
    }

    /**
     * Surveille la page elle-même, et non la seule fenêtre.
     *
     * Écouter `resize` ne couvre qu'une cause parmi d'autres. La largeur utile
     * change aussi quand le sommaire se déploie en colonne à côté du livre,
     * quand les barres du navigateur se replient, ou quand une police finit de
     * charger — autant de cas où la fenêtre, elle, n'a pas bougé d'un pixel. La
     * pagination gardait alors la largeur d'avant, et le texte débordait du
     * cadre, qui le coupait net.
     *
     * On observe donc la feuille, dont la taille est imposée du dehors. Le ruban
     * qu'on y taille ne peut pas la faire réagir en retour : `.docs-viewport`
     * masque son débordement, et `.docs-sheet` tient sa largeur du livre, jamais
     * de ce qu'il contient. Pas de boucle, donc.
     */
    function watchPage() {
        if (typeof ResizeObserver !== 'function') return;

        const sheet = document.querySelector('.docs-sheet-left');
        if (!sheet) return;

        new ResizeObserver(relayout).observe(sheet);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDocs);
    } else {
        initDocs();
    }
})();
