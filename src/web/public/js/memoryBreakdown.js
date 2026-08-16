/* ═══════════════════════════════════════════════════════════════
   Widget « Répartition Mémoire » — d'où vient la mémoire du tableau de bord
   ───────────────────────────────────────────────────────────────
   Le graphique voisin suit la mémoire du bot ; celui-ci regarde la page
   elle-même, et répond à une autre question : qu'est-ce qui, ici, occupe
   de la place ?

   Aucun navigateur n'expose la mémoire réellement consommée par un élément
   du DOM (`measureUserAgentSpecificMemory` s'en approche, mais exige une
   page isolée entre origines, ce que le tableau de bord n'est pas). On
   distingue donc ce qui est mesuré de ce qui est estimé :

     • mesuré  — nombre de nœuds, d'attributs, de caractères ; taille des
                 images décodées (largeur × hauteur × 4 octets, la place
                 qu'occupe vraiment une bitmap) ; tas JavaScript et poids
                 du code chargé, quand le navigateur les publie.
     • estimé  — la traduction des comptages en octets, via un coût moyen
                 par nœud annoncé sous le widget.

   Les deux familles ne sont jamais additionnées en silence : les valeurs
   estimées sont regroupées sous « Éléments », les valeurs mesurées sous
   « Hors éléments ».
   ═══════════════════════════════════════════════════════════════ */

(function() {
    'use strict';

    window.MusicPlayer = window.MusicPlayer || {};

    /**
     * Coût moyen d'un nœud dans un moteur de rendu : l'objet Element, son
     * style calculé et son objet de mise en page. L'ordre de grandeur vaut
     * mieux qu'un silence, et il est affiché à l'utilisateur.
     */
    const COUT_ELEMENT = 256;
    const COUT_ATTRIBUT = 48;
    const COUT_CARACTERE = 2;      // chaînes UTF-16
    const OCTETS_PAR_PIXEL = 4;    // RGBA
    const PERIODE_MS = 2000;
    /** Au-delà, les zones les plus légères sont fondues dans « Autres ». */
    const LIGNES_MAX = 8;

    const PALETTE = [
        '#5865f2', '#00f3ff', '#eb459e', '#26de81', '#f7b731',
        '#a55eea', '#fd9644', '#45aaf2', '#2bcbba', '#fc5c65'
    ];
    const COULEUR_ELEMENTS = '#5865f2';
    const COULEUR_TAS = '#00f3ff';
    const COULEUR_CODE = '#f7b731';

    let minuteur = null;

    function tr(cle, defaut) {
        const t = window.MusicPlayer && window.MusicPlayer.t;
        const valeur = typeof t === 'function' ? t(cle) : null;
        return (valeur && valeur !== cle) ? valeur : defaut;
    }

    function formatOctets(octets) {
        const v = Math.max(0, octets || 0);
        const ko = tr('unit_kb', 'Ko');
        const mo = tr('unit_mb', 'Mo');
        const go = tr('unit_gb', 'Go');
        if (v >= 1024 * 1024 * 1024) return `${(v / (1024 ** 3)).toFixed(2)} ${go}`;
        if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} ${mo}`;
        if (v >= 1024) return `${Math.round(v / 1024)} ${ko}`;
        return `${Math.round(v)} o`;
    }

    function nombreCourt(n) {
        return (n || 0).toLocaleString();
    }

    // ── Mesure du DOM ───────────────────────────────────────────────

    /**
     * Place occupée par la bitmap d'un élément — la seule mémoire d'affichage
     * réellement calculable depuis la page.
     */
    function octetsBitmap(el) {
        switch (el.tagName) {
            case 'IMG':
                return (el.complete && el.naturalWidth)
                    ? el.naturalWidth * el.naturalHeight * OCTETS_PAR_PIXEL : 0;
            case 'CANVAS':
                return (el.width || 0) * (el.height || 0) * OCTETS_PAR_PIXEL;
            case 'VIDEO':
                // Une image décodée. Le nombre de trames gardées en tampon
                // dépend du décodeur et n'est pas exposé.
                return (el.videoWidth || 0) * (el.videoHeight || 0) * OCTETS_PAR_PIXEL;
            default:
                return 0;
        }
    }

    /** Parcourt une zone une seule fois et en compte le contenu. */
    function peserZone(racine) {
        if (!racine) return null;

        let elements = 0;
        let attributs = 0;
        let caracteres = 0;
        let bitmaps = 0;
        let images = 0;

        const marcheur = document.createTreeWalker(
            racine,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        );

        let noeud = racine;   // la racine elle-même fait partie de la zone
        while (noeud) {
            if (noeud.nodeType === 1) {
                elements++;
                attributs += noeud.attributes ? noeud.attributes.length : 0;
                const bitmap = octetsBitmap(noeud);
                if (bitmap > 0) {
                    bitmaps += bitmap;
                    images++;
                }
            } else if (noeud.nodeType === 3 && noeud.nodeValue) {
                caracteres += noeud.nodeValue.length;
            }
            noeud = marcheur.nextNode();
        }

        return {
            elements, attributs, caracteres, bitmaps, images,
            octets: elements * COUT_ELEMENT
                  + attributs * COUT_ATTRIBUT
                  + caracteres * COUT_CARACTERE
                  + bitmaps
        };
    }

    function additionner(a, b) {
        return {
            elements: a.elements + b.elements,
            attributs: a.attributs + b.attributs,
            caracteres: a.caracteres + b.caracteres,
            bitmaps: a.bitmaps + b.bitmaps,
            images: a.images + b.images,
            octets: a.octets + b.octets
        };
    }

    function soustraire(a, b) {
        return {
            elements: Math.max(0, a.elements - b.elements),
            attributs: Math.max(0, a.attributs - b.attributs),
            caracteres: Math.max(0, a.caracteres - b.caracteres),
            bitmaps: Math.max(0, a.bitmaps - b.bitmaps),
            images: Math.max(0, a.images - b.images),
            octets: Math.max(0, a.octets - b.octets)
        };
    }

    const ZERO = { elements: 0, attributs: 0, caracteres: 0, bitmaps: 0, images: 0, octets: 0 };

    /** Titre visible d'une carte, débarrassé de sa poignée et de son cadenas. */
    function titreCarte(carte) {
        const titre = carte.querySelector('.card-title');
        if (!titre) return carte.id || '?';
        const copie = titre.cloneNode(true);
        copie.querySelectorAll('svg, button').forEach(el => el.remove());
        return copie.textContent.trim() || carte.id;
    }

    /**
     * Zones disjointes du document. Le reste de `<body>` — en-tête, fenêtres
     * modales, menus contextuels, décor — est déduit par soustraction.
     */
    function zonesMesurables() {
        const liste = [];

        const grille = document.getElementById('dashboard-grid');
        if (grille) {
            grille.querySelectorAll(':scope > .card').forEach(carte => {
                liste.push({ cle: carte.id, libelle: titreCarte(carte), element: carte });
            });
        }

        [
            ['particle-path-canvas', 'mem_zone_particles', 'Animation de particules'],
            ['video-floating-window', 'mem_zone_video', 'Fenêtre vidéo'],
            ['logs-floating-window', 'mem_zone_logs', 'Fenêtre des journaux'],
            ['drawer-panel', 'mem_zone_drawer', 'Tiroir']
        ].forEach(([id, cle, defaut]) => {
            const el = document.getElementById(id);
            if (el) liste.push({ cle: id, libelle: tr(cle, defaut), element: el });
        });

        return liste;
    }

    function mesurerElements() {
        const total = peserZone(document.body) || ZERO;
        const zones = zonesMesurables();

        let cumul = ZERO;
        const lignes = zones.map((zone, i) => {
            const poids = peserZone(zone.element) || ZERO;
            cumul = additionner(cumul, poids);
            return { cle: zone.cle, libelle: zone.libelle, poids, couleur: PALETTE[i % PALETTE.length] };
        });

        // Tout ce que le document contient hors des zones nommées.
        lignes.push({
            cle: '__reste__',
            libelle: tr('mem_zone_other', 'Autres éléments'),
            poids: soustraire(total, cumul),
            couleur: 'rgba(160, 160, 176, 0.75)'
        });

        lignes.sort((a, b) => b.poids.octets - a.poids.octets);

        // Les zones les plus légères rejoignent le fourre-tout, qui ferme la
        // liste. On repart d'un cumul unique : le fourre-tout figure déjà
        // parmi les lignes triées, et en créer un second le dédoublerait.
        if (lignes.length > LIGNES_MAX) {
            const gardees = [];
            let reste = ZERO;
            for (const l of lignes) {
                if (gardees.length < LIGNES_MAX - 1 && l.cle !== '__reste__') {
                    gardees.push(l);
                } else {
                    reste = additionner(reste, l.poids);
                }
            }
            gardees.push({
                cle: '__reste__',
                libelle: tr('mem_zone_other', 'Autres éléments'),
                poids: reste,
                couleur: 'rgba(160, 160, 176, 0.75)'
            });
            return { total, lignes: gardees };
        }

        return { total, lignes };
    }

    // ── Mesure hors DOM ─────────────────────────────────────────────

    /** Tas JavaScript, quand le navigateur le publie (Chromium). */
    function tasJavaScript() {
        const m = window.performance && window.performance.memory;
        if (!m || typeof m.usedJSHeapSize !== 'number') return null;
        return { utilise: m.usedJSHeapSize, total: m.totalJSHeapSize, limite: m.jsHeapSizeLimit };
    }

    /**
     * Poids décodé du code et des styles chargés. Les ressources d'une autre
     * origine ne publient pas leur taille sans `Timing-Allow-Origin` : elles
     * comptent pour zéro plutôt que d'être devinées.
     */
    function codeCharge() {
        if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return null;
        const types = ['script', 'link', 'css'];
        let octets = 0;
        let nombre = 0;
        for (const e of window.performance.getEntriesByType('resource')) {
            if (!types.includes(e.initiatorType)) continue;
            const taille = e.decodedBodySize || 0;
            if (taille > 0) {
                octets += taille;
                nombre++;
            }
        }
        return { octets, nombre };
    }

    /**
     * Données que le tableau de bord conserve en mémoire vive. La taille
     * annoncée est celle de leur forme sérialisée : un ordre de grandeur
     * comparable d'une ligne à l'autre, pas l'empreinte exacte dans le tas.
     */
    function donneesConservees() {
        const etat = window.MusicPlayer.state || {};
        const lignes = [];

        const ajouter = (libelle, valeur, nombre) => {
            if (!valeur) return;
            let taille = 0;
            try {
                taille = JSON.stringify(valeur).length;
            } catch (e) {
                return;
            }
            if (taille <= 2) return;
            lignes.push({ libelle, octets: taille, nombre });
        };

        ajouter(tr('card_queue', "File d'attente"), etat.queue, (etat.queue || []).length);
        ajouter(tr('card_history', 'Historique de lecture'), etat.history, (etat.history || []).length);
        ajouter(tr('card_playlists', 'Playlists'), etat.playlists, (etat.playlists || []).length);

        const journaux = window.MusicPlayer.logsHistory;
        if (Array.isArray(journaux)) {
            ajouter(tr('mem_data_logs', 'Journaux'), journaux, journaux.length);
        }

        if (typeof window.MusicPlayer.empreinteGraphique === 'function') {
            const g = window.MusicPlayer.empreinteGraphique();
            if (g && g.octets > 0) {
                lignes.push({
                    libelle: tr('mem_data_graph', 'Mesures du graphique'),
                    octets: g.octets,
                    nombre: g.mesures
                });
            }
        }

        lignes.sort((a, b) => b.octets - a.octets);
        return lignes;
    }

    // ── Rendu ───────────────────────────────────────────────────────

    function creerLigne(couleur, libelle, detail, valeur, fraction) {
        const ligne = document.createElement('div');
        ligne.className = 'breakdown-row';

        const jauge = document.createElement('div');
        jauge.className = 'breakdown-rowbar';
        jauge.style.width = `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%`;
        jauge.style.background = couleur;
        ligne.appendChild(jauge);

        const pastille = document.createElement('span');
        pastille.className = 'breakdown-dot';
        pastille.style.background = couleur;
        ligne.appendChild(pastille);

        const nom = document.createElement('span');
        nom.className = 'breakdown-label';
        nom.textContent = libelle;
        ligne.appendChild(nom);

        if (detail) {
            const det = document.createElement('span');
            det.className = 'breakdown-detail';
            det.textContent = detail;
            ligne.appendChild(det);
        }

        const val = document.createElement('span');
        val.className = 'breakdown-value';
        val.textContent = valeur;
        ligne.appendChild(val);

        return ligne;
    }

    function creerTitreGroupe(libelle, valeur) {
        const titre = document.createElement('div');
        titre.className = 'breakdown-group-title';

        const nom = document.createElement('span');
        nom.textContent = libelle;
        titre.appendChild(nom);

        const val = document.createElement('span');
        val.textContent = valeur;
        titre.appendChild(val);

        return titre;
    }

    function rendre() {
        const liste = document.getElementById('breakdown-list');
        const barre = document.getElementById('breakdown-bar');
        const badge = document.getElementById('breakdown-total');
        if (!liste || !barre) return;

        const elements = mesurerElements();
        const tas = tasJavaScript();
        const code = codeCharge();

        const octetsElements = elements.total.octets;
        const octetsTas = tas ? tas.utilise : 0;
        const octetsCode = code ? code.octets : 0;
        const totalGeneral = octetsElements + octetsTas + octetsCode;

        if (badge) badge.textContent = formatOctets(totalGeneral);

        // Barre empilée : uniquement les trois familles, qui ne se recouvrent pas.
        barre.innerHTML = '';
        [
            [octetsElements, COULEUR_ELEMENTS],
            [octetsTas, COULEUR_TAS],
            [octetsCode, COULEUR_CODE]
        ].forEach(([octets, couleur]) => {
            if (octets <= 0 || totalGeneral <= 0) return;
            const seg = document.createElement('div');
            seg.className = 'breakdown-seg';
            seg.style.width = `${(octets / totalGeneral * 100).toFixed(2)}%`;
            seg.style.background = couleur;
            barre.appendChild(seg);
        });

        liste.innerHTML = '';

        // ── Groupe 1 : les éléments de la page ──
        liste.appendChild(creerTitreGroupe(
            tr('mem_group_elements', 'Éléments du tableau de bord'),
            formatOctets(octetsElements)
        ));

        const plusLourd = elements.lignes.length > 0 ? elements.lignes[0].poids.octets : 1;
        const motNoeuds = tr('mem_unit_nodes', 'nœuds');
        const motImages = tr('mem_unit_images', 'img.');

        elements.lignes.forEach(l => {
            let detail = `${nombreCourt(l.poids.elements)} ${motNoeuds}`;
            if (l.poids.images > 0) {
                detail += ` · ${l.poids.images} ${motImages} ${formatOctets(l.poids.bitmaps)}`;
            }
            liste.appendChild(creerLigne(
                l.couleur, l.libelle, detail, formatOctets(l.poids.octets),
                plusLourd > 0 ? l.poids.octets / plusLourd : 0
            ));
        });

        // ── Groupe 2 : tout le reste ──
        liste.appendChild(creerTitreGroupe(
            tr('mem_group_other', 'Hors éléments'),
            formatOctets(octetsTas + octetsCode)
        ));

        const reference = Math.max(octetsTas, octetsCode, 1);

        if (tas) {
            liste.appendChild(creerLigne(
                COULEUR_TAS,
                tr('mem_row_heap', 'Tas JavaScript'),
                `${formatOctets(tas.total)} ${tr('mem_reserved', 'réservés')}`,
                formatOctets(tas.utilise),
                octetsTas / reference
            ));
        } else {
            // Firefox et Safari ne publient pas la taille du tas. Mieux vaut
            // le dire que d'avancer un chiffre inventé.
            liste.appendChild(creerLigne(
                'rgba(160, 160, 176, 0.75)',
                tr('mem_row_heap', 'Tas JavaScript'),
                '',
                tr('mem_unavailable', 'non exposé'),
                0
            ));
        }

        // Ce que le tableau de bord garde en mémoire vive : un sous-ensemble
        // du tas ci-dessus, présenté comme tel et jamais additionné à lui.
        // Ce détail ne dépend pas de la publication du tas par le navigateur :
        // il reste affiché là où celle-ci manque, et c'est même là qu'il
        // renseigne le plus.
        const donnees = donneesConservees();
        if (donnees.length > 0) {
            const intro = document.createElement('div');
            intro.className = 'breakdown-sub-intro';
            intro.textContent = tr('mem_of_which', 'dont données conservées (taille sérialisée)');
            liste.appendChild(intro);

            donnees.forEach(d => {
                const sous = document.createElement('div');
                sous.className = 'breakdown-sub';

                const nom = document.createElement('span');
                nom.className = 'breakdown-label';
                nom.textContent = d.libelle + (d.nombre ? ` (${nombreCourt(d.nombre)})` : '');
                sous.appendChild(nom);

                const val = document.createElement('span');
                val.className = 'breakdown-value';
                val.textContent = formatOctets(d.octets);
                sous.appendChild(val);

                liste.appendChild(sous);
            });
        }

        if (code && code.octets > 0) {
            liste.appendChild(creerLigne(
                COULEUR_CODE,
                tr('mem_row_code', 'Code & styles chargés'),
                `${code.nombre} ${tr('mem_unit_files', 'fichiers')}`,
                formatOctets(code.octets),
                octetsCode / reference
            ));
        }
    }

    /** Rendu public, réutilisé au changement de langue. */
    window.MusicPlayer.refreshMemoryBreakdown = function() {
        try {
            rendre();
        } catch (err) {
            console.error('[Répartition mémoire] Rendu impossible :', err);
        }
    };

    /**
     * Le parcours du DOM n'a de sens que si le widget est visible : hors de
     * là, rien ne tourne.
     */
    window.MusicPlayer.setRepartitionActive = function(actif) {
        if (minuteur) {
            clearInterval(minuteur);
            minuteur = null;
        }
        if (!actif) return;
        window.MusicPlayer.refreshMemoryBreakdown();
        minuteur = setInterval(window.MusicPlayer.refreshMemoryBreakdown, PERIODE_MS);
    };
})();
