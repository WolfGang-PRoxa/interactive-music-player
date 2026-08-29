window.MusicPlayer = window.MusicPlayer || {};

(function () {
    // Animation avec décélération fluide au survol de la roue des paramètres
    const btnOpenSettings = document.getElementById('btn-open-settings');
    if (btnOpenSettings) {
        const svg = btnOpenSettings.querySelector('svg');
        let currentRotation = 0;
        let cogAnimId = null;
        let isCogHovered = false;

        function stepCogSpin() {
            if (!isCogHovered) return;
            currentRotation = (currentRotation + 0.75) % 360;
            if (svg) svg.style.transform = `rotate(${currentRotation}deg)`;
            cogAnimId = requestAnimationFrame(stepCogSpin);
        }

        btnOpenSettings.addEventListener('mouseenter', () => {
            isCogHovered = true;
            if (svg) svg.style.transition = 'none';
            cancelAnimationFrame(cogAnimId);
            stepCogSpin();
        });

        btnOpenSettings.addEventListener('mouseleave', () => {
            isCogHovered = false;
            cancelAnimationFrame(cogAnimId);
            if (svg) {
                // Freinage et décélération douce vers la prochaine position
                const extraCoast = 40;
                const finalTarget = currentRotation + extraCoast;
                svg.style.transition = 'transform 0.8s cubic-bezier(0.1, 0.5, 0.2, 0.75)';
                svg.style.transform = `rotate(${finalTarget}deg)`;
                currentRotation = finalTarget % 360;
            }
        });
    }

    /* ────────────────────────── Vapeur du café ──────────────────────────
     *
     * Les trois arabesques SVG qui tenaient lieu de vapeur ondulaient sur
     * place, ensemble et toujours de la même façon : trois serpentins, pas un
     * panache. Ce que fait la vraie vapeur tient en quatre choses, et il les
     * faut toutes les quatre pour que l'œil y croie.
     *
     *  1. **Elle s'enroule.** L'air chaud qui monte forme des volutes ; il ne
     *     serpente pas. Le champ de turbulence est ici le rotationnel d'un
     *     bruit de gradient, ce qui le rend à divergence nulle : rien
     *     n'apparaît ni ne se perd en chemin, les filets s'enroulent les uns
     *     dans les autres au lieu de s'écarter d'une source invisible. C'est ce
     *     seul détail qui sépare un panache d'un drapeau qui claque.
     *
     *  2. **Elle refroidit.** La poussée qui la lance s'épuise à mesure qu'elle
     *     se mêle à l'air de la pièce : le panache accélère au sortir de la
     *     tasse, puis se laisse porter. D'où le carré sur le terme de poussée,
     *     qui la fait tomber vite plutôt que de décroître droit.
     *
     *  3. **Elle s'étale en se diluant.** Le rayon croît avec l'âge et
     *     l'opacité tombe comme la surface augmente : la même matière occupe
     *     plus de place, donc se voit moins. C'est ce qui donne un panache
     *     dense au bord de la tasse et fondu vingt pixels plus haut.
     *
     *  4. **Elle sort par à-coups.** Un débit constant se lit immédiatement
     *     comme une machine. L'émission a donc sa propre respiration.
     *
     * Le champ de bruit monte lui aussi, un peu moins vite que la vapeur :
     * sinon les particules le traversent comme un papier peint fixe, et les
     * tourbillons restent accrochés à l'écran au lieu de voyager avec elles.
     *
     * La turbulence ne prend son ampleur qu'en montant. Au ras de la tasse le
     * filet est encore laminaire — c'est vrai d'un panache réel, et c'est aussi
     * ce qui rattache visuellement la vapeur au bol plutôt que de la faire
     * flotter au-dessus.
     */
    const btnBuyCoffee = document.getElementById('btn-buy-coffee');
    const steamReducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;

    if (btnBuyCoffee && !steamReducedMotion) {
        const coffeeIcon = btnBuyCoffee.querySelector('.icon-coffee');

        /**
         * Boîte du panache, en pixels CSS.
         *
         * Un canevas local plutôt que la pleine page des étoiles filantes : la
         * vapeur ne dépasse jamais la centaine de pixels au-dessus d'un bouton
         * de 38, et effacer cent pixels carrés par image coûte moins que
         * d'effacer l'écran. Il est repositionné à chaque image sur la tasse,
         * ce qui le fait suivre le défilement et l'agrandissement du survol
         * sans rien avoir à écouter.
         */
        const BOX_W = 128;
        const BOX_H = 118;

        /** Hauteur gardée sous la lèvre : la vapeur naît au-dessus du bord. */
        const BOX_FOOT = 12;

        /*
         * L'allure du panache tient à un jeu de constantes liées, et non à une
         * vitesse unique que l'on pourrait tourner seule.
         *
         * Ralentir la vapeur d'un facteur s, sans rien changer d'autre, demande
         * de les bouger ensemble : la poussée et la vitesse initiale divisées
         * par s puisque ce sont des vitesses, la durée de vie multipliée par s
         * pour que la bouffée atteigne la même hauteur avec moins d'élan, la
         * turbulence divisée par s pour que le même écart latéral s'étale sur
         * plus de temps, la dérive du champ de bruit et la respiration du débit
         * de même. Et le débit divisé par s : le nombre de particules à l'écran
         * vaut débit × durée de vie, si bien qu'allonger l'une sans réduire
         * l'autre épaissirait le panache au lieu de le ralentir.
         *
         * Ne toucher qu'à la poussée donne autre chose : une vapeur plus lente
         * qui monte moins haut, ce qui n'est pas la même demande.
         */

        /** Particules par seconde, à pleine ébullition. */
        const EMIT_RATE = 41;

        /** Plafond de sécurité, si une image tarde et que le rattrapage émet. */
        const MAX_PARTICLES = 260;

        const steamCanvas = document.createElement('canvas');
        steamCanvas.id = 'coffee-steam-canvas';
        steamCanvas.style.cssText =
            'position: fixed; pointer-events: none; z-index: 99998; display: none;';
        document.body.appendChild(steamCanvas);
        const steamCtx = steamCanvas.getContext('2d');

        /*
         * Bruit de gradient 2D, façon Perlin, sur une table de permutation
         * figée. Le générateur est déterministe : le panache doit garder le
         * même caractère d'une visite à l'autre, seul le hasard des particules
         * change d'une bouffée à la suivante.
         */
        const PERM = new Uint8Array(512);
        (function seedPermutation() {
            const p = new Uint8Array(256);
            for (let i = 0; i < 256; i++) p[i] = i;
            let s = 1337;
            for (let i = 255; i > 0; i--) {
                s = (s * 1664525 + 1013904223) >>> 0;
                const j = s % (i + 1);
                const swap = p[i]; p[i] = p[j]; p[j] = swap;
            }
            for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
        })();

        const smoothstep5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

        /** Produit scalaire avec l'un des huit gradients de la maille. */
        function gradDot(hash, x, y) {
            switch (hash & 7) {
                case 0: return x + y;
                case 1: return x - y;
                case 2: return -x + y;
                case 3: return -x - y;
                case 4: return x;
                case 5: return -x;
                case 6: return y;
                default: return -y;
            }
        }

        function noise2(x, y) {
            const fx = Math.floor(x);
            const fy = Math.floor(y);
            const xi = fx & 255;
            const yi = fy & 255;
            const xf = x - fx;
            const yf = y - fy;
            const u = smoothstep5(xf);
            const v = smoothstep5(yf);

            const aa = PERM[PERM[xi] + yi];
            const ab = PERM[PERM[xi] + yi + 1];
            const ba = PERM[PERM[xi + 1] + yi];
            const bb = PERM[PERM[xi + 1] + yi + 1];

            const c00 = gradDot(aa, xf, yf);
            const c10 = gradDot(ba, xf - 1, yf);
            const c01 = gradDot(ab, xf, yf - 1);
            const c11 = gradDot(bb, xf - 1, yf - 1);

            const x1 = c00 + u * (c10 - c00);
            const x2 = c01 + u * (c11 - c01);
            return x1 + v * (x2 - x1);
        }

        /**
         * Rotationnel du bruit, par différences finies.
         *
         * `(∂N/∂y, −∂N/∂x)` est à divergence nulle par construction : le champ
         * ne peut ni créer ni engloutir de matière, il ne sait que la faire
         * tourner. C'est ce qui donne des volutes plutôt qu'un éparpillement.
         */
        const curlSample = { x: 0, y: 0 };
        function curlInto(x, y, out) {
            const e = 0.12;
            out.x = (noise2(x, y + e) - noise2(x, y - e)) / (2 * e);
            out.y = -(noise2(x + e, y) - noise2(x - e, y)) / (2 * e);
        }

        /**
         * Turbulence à deux échelles, en pixels par seconde.
         *
         * La grande donne sa forme au panache, la petite l'empêche d'avoir des
         * filets lisses. Les deux montent avec le temps, la seconde plus vite,
         * comme les petites structures d'un écoulement réel.
         */
        const turbulence = { x: 0, y: 0 };
        function sampleTurbulence(px, py, t, out) {
            curlInto(px * 0.030, py * 0.030 + t * 0.37, curlSample);
            out.x = curlSample.x * 20;
            out.y = curlSample.y * 20;

            curlInto(px * 0.085 + 31.7, py * 0.085 + t * 0.73 + 12.3, curlSample);
            out.x += curlSample.x * 7.3;
            out.y += curlSample.y * 7.3;
        }

        let steamParticles = [];
        let steamAnimId = null;
        let isCoffeeHovered = false;
        let steamLastFrame = 0;
        let steamEmitCarry = 0;
        let steamFieldTime = 0;

        /**
         * Une bouffée, née sur la lèvre de la tasse.
         *
         * La position tire une loi triangulaire : le milieu du bol crache plus
         * que ses bords, où l'air est déjà refroidi par la porcelaine.
         */
        function spawnSteam(rimHalfWidth) {
            const bias = Math.random() + Math.random() - 1;
            return {
                x: BOX_W / 2 + bias * rimHalfWidth,
                y: BOX_H - BOX_FOOT,
                vx: (Math.random() - 0.5) * 6,
                vy: -(6.7 + Math.random() * 6),
                r0: 2.1 + Math.random() * 1.6,
                grow: 4.2 + Math.random() * 2.6,
                lift: 45 + Math.random() * 23,
                age: 0,
                life: 2.25 + Math.random() * 1.35,
                weight: 0.8 + Math.random() * 0.4,
            };
        }

        function resizeSteamCanvas() {
            // Plafonné à 2 : au-delà, on quadruple le coût de remplissage pour
            // des dégradés qui n'ont aucun détail à y gagner.
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            steamCanvas.style.width = `${BOX_W}px`;
            steamCanvas.style.height = `${BOX_H}px`;
            steamCanvas.width = Math.round(BOX_W * dpr);
            steamCanvas.height = Math.round(BOX_H * dpr);
            steamCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        window.addEventListener('resize', () => {
            if (steamCanvas.style.display !== 'none') resizeSteamCanvas();
        });

        function stepSteam(now) {
            // Plafonné : un onglet qui revient au premier plan livre un écart
            // d'une seconde, dont un rattrapage ferait une explosion.
            const dt = Math.min(0.05, (now - steamLastFrame) / 1000) || 0.016;
            steamLastFrame = now;
            steamFieldTime += dt;

            /*
             * Le repère vient du dessin, pas du bouton : l'icône fait 24 unités
             * de viewBox pour sa largeur affichée, la lèvre de la tasse est à
             * y = 8 et le bol s'étend de x = 2 à x = 18. Lire le rectangle de
             * l'icône à chaque image fait suivre à la vapeur le `scale(1.08)`
             * du survol et le défilement de la page, sans un écouteur de plus.
             */
            const rect = (coffeeIcon || btnBuyCoffee).getBoundingClientRect();
            const unit = rect.width / 24;
            const rimY = rect.top + 8 * unit;
            const rimCx = rect.left + 10 * unit;
            const rimHalf = 6.4 * unit;

            steamCanvas.style.left = `${Math.round(rimCx - BOX_W / 2)}px`;
            steamCanvas.style.top = `${Math.round(rimY - (BOX_H - BOX_FOOT))}px`;

            if (isCoffeeHovered) {
                // Deux respirations superposées, de périodes incommensurables :
                // le débit ne retrouve jamais deux fois la même valeur, et rien
                // ne s'y entend comme un cycle.
                const gust = 0.72
                    + 0.28 * Math.sin(steamFieldTime * 1.53)
                    + 0.16 * Math.sin(steamFieldTime * 3.8 + 1.9);
                steamEmitCarry += EMIT_RATE * gust * dt;
                while (steamEmitCarry >= 1) {
                    steamEmitCarry -= 1;
                    if (steamParticles.length < MAX_PARTICLES) {
                        steamParticles.push(spawnSteam(rimHalf));
                    }
                }
            } else {
                steamEmitCarry = 0;
            }

            for (let i = steamParticles.length - 1; i >= 0; i--) {
                const p = steamParticles[i];
                p.age += dt;
                if (p.age >= p.life) {
                    steamParticles.splice(i, 1);
                    continue;
                }

                const t = p.age / p.life;

                // La poussée d'Archimède, qui s'épuise au mélange.
                p.vy -= p.lift * (1 - t) * (1 - t) * dt;

                sampleTurbulence(p.x, p.y, steamFieldTime, turbulence);
                const mix = 0.25 + 1.35 * t;
                p.vx += turbulence.x * mix * dt;
                p.vy += turbulence.y * mix * dt;

                // Frottement de l'air. Sans lui la turbulence s'accumule d'image
                // en image et le panache finit par partir en tous sens ; avec
                // lui, chaque particule tend vers sa vitesse limite.
                const drag = Math.exp(-1.05 * dt);
                p.vx *= drag;
                p.vy *= drag;

                p.x += p.vx * dt;
                p.y += p.vy * dt;
            }

            /*
             * Sur fond sombre la vapeur s'ajoute à ce qu'il y a dessous, comme
             * une lumière diffusée ; sur fond clair il n'y a rien à ajouter à du
             * blanc, et c'est une ombre chaude qui la rend visible.
             */
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const tint = isLight ? '150, 138, 120' : '255, 246, 232';
            const peak = isLight ? 0.30 : 0.26;

            steamCtx.clearRect(0, 0, BOX_W, BOX_H);
            steamCtx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';

            for (const p of steamParticles) {
                const t = p.age / p.life;
                const r = p.r0 * (1 + p.grow * t);

                // Dilution : la même matière répartie sur une surface plus
                // grande. L'exposant est en deçà du carré géométrique, sans
                // quoi la bouffée s'éteindrait avant d'avoir fini de monter.
                const dilution = Math.pow(p.r0 / r, 1.15);

                // Naissance franche, extinction longue — une bouffée met bien
                // plus de temps à se perdre qu'à sortir.
                const envelope = Math.min(1, t / 0.10) * Math.pow(1 - t, 1.4);

                const alpha = peak * p.weight * dilution * envelope;
                if (alpha <= 0.004) continue;

                const grad = steamCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
                grad.addColorStop(0, `rgba(${tint}, ${alpha})`);
                grad.addColorStop(0.35, `rgba(${tint}, ${alpha * 0.62})`);
                grad.addColorStop(0.65, `rgba(${tint}, ${alpha * 0.24})`);
                grad.addColorStop(1, `rgba(${tint}, 0)`);

                steamCtx.fillStyle = grad;
                steamCtx.beginPath();
                steamCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
                steamCtx.fill();
            }

            if (steamParticles.length > 0 || isCoffeeHovered) {
                steamAnimId = requestAnimationFrame(stepSteam);
            } else {
                steamAnimId = null;
                steamCanvas.style.display = 'none';
            }
        }

        btnBuyCoffee.addEventListener('mouseenter', () => {
            isCoffeeHovered = true;
            if (!steamAnimId) {
                steamCanvas.style.display = 'block';
                resizeSteamCanvas();
                steamLastFrame = performance.now();
                steamAnimId = requestAnimationFrame(stepSteam);
            }
        });

        btnBuyCoffee.addEventListener('mouseleave', () => {
            // L'émission cesse ; ce qui est déjà sorti finit de monter et de se
            // perdre. Une vapeur qui s'efface d'un coup au départ du curseur se
            // remarque autant qu'un serpentin.
            isCoffeeHovered = false;
        });
    }

    /* ───────────────────── La queue du chat GitHub ─────────────────────
     *
     * Une onde qui **voyage**, et c'est tout le sujet. Un serpent n'agite pas
     * sa queue de part et d'autre d'un axe : il propage une ondulation de la
     * base vers la pointe, et chaque portion de son corps passe par où la
     * précédente est passée. Une oscillation sur place — le même sinus appliqué
     * partout — se lit immédiatement comme un essuie-glace, c'était le travers
     * de l'ancienne vapeur et il n'y a aucune raison de le refaire ici.
     *
     * D'où trois choses.
     *
     * **La phase avance avec l'abscisse curviligne**, pas avec le paramètre de
     * la courbe. Une courbe de Bézier ne parcourt pas la même distance pour un
     * même pas de paramètre : prise telle quelle, l'onde se tasserait là où la
     * courbe est serrée et s'étirerait ailleurs. La queue est donc rééchan-
     * tillonnée à intervalles de longueur égale, une fois pour toutes.
     *
     * **L'amplitude enfle vers le bout.** La base de la queue est prise dans le
     * corps du chat : elle ne peut pas bouger, sous peine de décoller le tracé
     * du reste du logo. La pointe, elle, est libre. L'enveloppe en `s^1.7` tient
     * la racine immobile et laisse le bout balayer.
     *
     * **Le déplacement est perpendiculaire à la courbe**, et non vertical : une
     * queue qui remonte vers la gauche ondulerait de travers si on la poussait
     * selon l'axe des y. Les normales sont calculées une fois — la courbe de
     * repos ne change jamais, seul le déplacement le long d'elle varie.
     *
     * Au repos, l'attribut d'origine est remis mot pour mot. La courbe rendue à
     * amplitude nulle n'est qu'une approximation de la Bézier initiale, très
     * bonne mais pas identique, et le logo au repos n'a aucune raison de porter
     * l'empreinte de son animation.
     */
    const btnGithub = document.getElementById('btn-github');
    const tailReducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
    const tailEl = btnGithub ? btnGithub.querySelector('.gh-tail') : null;
    const headEl = btnGithub ? btnGithub.querySelector('.gh-head') : null;

    if (tailEl && !tailReducedMotion) {
        /** Le tracé d'origine, remis tel quel dès que l'onde s'est éteinte. */
        const TAIL_REST_D = 'M9 19c-5 1.5-5-2.5-7-3';

        /* Ses points de contrôle, développés depuis la forme relative :
         * « M9 19 c -5 1.5, -5 -2.5, -7 -3 ». */
        const T0 = { x: 9, y: 19 };
        const T1 = { x: 4, y: 20.5 };
        const T2 = { x: 4, y: 16.5 };
        const T3 = { x: 2, y: 16 };

        /** Amplitude au bout, en unités du viewBox — 1 unité vaut 0,75 px. */
        const TAIL_AMPLITUDE = 1.6;
        /** Longueurs d'onde tenant sur la queue. Moins d'une : une seule ondulation. */
        const TAIL_WAVES = 0.85;
        /** Secondes pour que l'onde parcoure la queue une fois. Lentement. */
        const TAIL_PERIOD = 3.0;
        /** Points de rééchantillonnage. Au-delà, la courbe ne gagne plus rien. */
        const TAIL_SAMPLES = 14;

        function tailBezierAt(u) {
            const v = 1 - u;
            const a = v * v * v;
            const b = 3 * v * v * u;
            const c = 3 * v * u * u;
            const d = u * u * u;
            return {
                x: a * T0.x + b * T1.x + c * T2.x + d * T3.x,
                y: a * T0.y + b * T1.y + c * T2.y + d * T3.y,
            };
        }

        /**
         * La queue au repos, en points équidistants le long de la courbe, avec
         * la normale unitaire de chacun.
         */
        const tailRest = (function resampleTail() {
            const DENSE = 240;
            const dense = [];
            const cumulative = [0];
            for (let i = 0; i <= DENSE; i++) {
                dense.push(tailBezierAt(i / DENSE));
                if (i > 0) {
                    cumulative.push(cumulative[i - 1]
                        + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
                }
            }
            const total = cumulative[DENSE] || 1;

            const out = [];
            let j = 0;
            for (let k = 0; k < TAIL_SAMPLES; k++) {
                const s = k / (TAIL_SAMPLES - 1);
                const target = s * total;
                while (j < DENSE - 1 && cumulative[j + 1] < target) j++;
                const span = cumulative[j + 1] - cumulative[j] || 1;
                const f = Math.min(1, (target - cumulative[j]) / span);
                out.push({
                    x: dense[j].x + (dense[j + 1].x - dense[j].x) * f,
                    y: dense[j].y + (dense[j + 1].y - dense[j].y) * f,
                    s,
                    nx: 0,
                    ny: 0,
                });
            }

            for (let k = 0; k < out.length; k++) {
                const before = out[Math.max(0, k - 1)];
                const after = out[Math.min(out.length - 1, k + 1)];
                const tx = after.x - before.x;
                const ty = after.y - before.y;
                const len = Math.hypot(tx, ty) || 1;
                // Normale directe : la tangente tournée d'un quart de tour.
                out[k].nx = -ty / len;
                out[k].ny = tx / len;
            }
            return out;
        })();

        const round2 = (v) => Math.round(v * 100) / 100;

        /**
         * Polyligne rendue en cubiques par Catmull-Rom.
         *
         * Une suite de segments droits se verrait : quatorze points sur cinq
         * pixels de queue, ce sont des angles à chaque nœud, et le trait de deux
         * pixels les épaissit au lieu de les fondre. Les tangentes de
         * Catmull-Rom passent par tous les points en gardant la courbe continue.
         */
        function tailToPath(points) {
            const n = points.length;
            let d = `M${round2(points[0].x)} ${round2(points[0].y)}`;
            for (let i = 0; i < n - 1; i++) {
                const p0 = points[Math.max(0, i - 1)];
                const p1 = points[i];
                const p2 = points[i + 1];
                const p3 = points[Math.min(n - 1, i + 2)];
                d += `C${round2(p1.x + (p2.x - p0.x) / 6)} ${round2(p1.y + (p2.y - p0.y) / 6)}`
                    + `,${round2(p2.x - (p3.x - p1.x) / 6)} ${round2(p2.y - (p3.y - p1.y) / 6)}`
                    + `,${round2(p2.x)} ${round2(p2.y)}`;
            }
            return d;
        }

        /**
         * La queue à un instant donné de l'onde.
         *
         * `TAIL_WAVES * s - phase` : la phase croissant avec le temps, une crête
         * donnée se retrouve à chaque image un peu plus loin vers la pointe.
         * C'est le sens de propagation d'un serpent, et l'inverser ferait
         * remonter l'onde vers le corps — ce qui se voit, et ne ressemble à rien.
         */
        function tailWaveAt(phase, amplitude) {
            const moved = tailRest.map((p) => {
                const envelope = Math.pow(p.s, 1.7);
                const offset = amplitude * envelope
                    * Math.sin(2 * Math.PI * (TAIL_WAVES * p.s - phase));
                return { x: p.x + p.nx * offset, y: p.y + p.ny * offset };
            });
            return tailToPath(moved);
        }

        let tailPhase = 0;
        let tailAmount = 0;
        let tailAnimId = null;
        let isGithubHovered = false;
        let tailLastFrame = 0;

        /* ─────────────────── Le penchement de tête ───────────────────
         *
         * Le chat incline la tête vers la droite de temps à autre, puis se
         * redresse. C'est un geste d'attention — ce que fait un animal qui
         * essaie de comprendre ce qu'il regarde — et ce qui le rend crédible
         * n'est pas le mouvement lui-même mais son irrégularité : un
         * penchement à intervalle fixe et toujours du même angle devient un
         * métronome au bout de deux répétitions.
         *
         * Quatre étapes s'enchaînent donc, dont trois tirent leur durée ou leur
         * amplitude au hasard : l'attente, l'inclinaison, le maintien, le
         * redressement. Rien n'est mémorisé d'un cycle à l'autre, si bien que
         * deux penchements ne tombent jamais au même endroit.
         *
         * Les deux vitesses ne sont pas les mêmes, et c'est délibéré : la tête
         * se penche vite et se redresse lentement. L'inverse donnerait un
         * mouvement de machine. Le léger dépassement de l'inclinaison — le
         * `easeOutBack` — fait qu'elle se cale au lieu de glisser jusqu'à
         * l'arrêt.
         *
         * La rotation a pour centre la nuque, à mi-chemin des deux épaules où
         * le tracé a été coupé. Ce choix n'est pas cosmétique : à cet endroit,
         * les deux extrémités de la tête sont à 2,6 unités du pivot, si bien
         * qu'une inclinaison de 9° ne les déplace que de 0,4 unité — invisible
         * sous un trait qui en fait 2 de large. Pivoter ailleurs ouvrirait la
         * jointure des épaules.
         */

        /** Nuque : le milieu des deux points de coupe, 15.06,15.52 et 9.94,15.55. */
        const HEAD_PIVOT_X = 12.5;
        const HEAD_PIVOT_Y = 15.54;

        /** Inclinaison, en degrés. Positif : vers la droite du lecteur. */
        const HEAD_MIN_ANGLE = 5;
        const HEAD_MAX_ANGLE = 9;

        /** Secondes. La tête se penche vite, se maintient, se redresse mollement. */
        const HEAD_TILT_IN = 0.34;
        const HEAD_HOLD_MIN = 0.55;
        const HEAD_HOLD_MAX = 1.5;
        const HEAD_TILT_OUT = 0.6;

        /** Secondes entre deux penchements. */
        const HEAD_WAIT_MIN = 2.4;
        const HEAD_WAIT_MAX = 6.5;

        const randomBetween = (min, max) => min + Math.random() * (max - min);

        /** Sortie avec un léger dépassement : la tête se cale, elle ne glisse pas. */
        const easeOutBack = (t) => {
            const c = 1.35;
            const u = t - 1;
            return 1 + (c + 1) * u * u * u + c * u * u;
        };

        /** Départ et arrivée également amortis, pour le redressement. */
        const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

        let headStage = 'wait';
        let headElapsed = 0;
        let headDuration = randomBetween(HEAD_WAIT_MIN, HEAD_WAIT_MAX);
        let headFrom = 0;
        let headTo = 0;
        let headAngle = 0;

        function stepHead(dt) {
            if (!headEl) return;

            // Le curseur est parti pendant un penchement : la tête se redresse
            // sans attendre la fin du maintien, mais à sa vitesse ordinaire.
            if (!isGithubHovered && headStage !== 'out' && headAngle !== 0) {
                headFrom = headAngle;
                headTo = 0;
                headStage = 'out';
                headElapsed = 0;
                headDuration = HEAD_TILT_OUT;
            }

            headElapsed += dt;
            const t = headDuration > 0 ? Math.min(1, headElapsed / headDuration) : 1;

            if (headStage === 'in') {
                headAngle = headFrom + (headTo - headFrom) * easeOutBack(t);
            } else if (headStage === 'out') {
                headAngle = headFrom + (headTo - headFrom) * easeInOutSine(t);
            }

            headEl.setAttribute('transform',
                `rotate(${Math.round(headAngle * 1000) / 1000} ${HEAD_PIVOT_X} ${HEAD_PIVOT_Y})`);

            if (t < 1) return;

            headElapsed = 0;
            if (headStage === 'wait') {
                // Rien ne s'amorce si le curseur est reparti : la tête attend
                // simplement, et la boucle s'arrêtera d'elle-même.
                if (!isGithubHovered) return;
                headFrom = headAngle;
                headTo = randomBetween(HEAD_MIN_ANGLE, HEAD_MAX_ANGLE);
                headStage = 'in';
                headDuration = HEAD_TILT_IN;
            } else if (headStage === 'in') {
                headStage = 'hold';
                headDuration = randomBetween(HEAD_HOLD_MIN, HEAD_HOLD_MAX);
            } else if (headStage === 'hold') {
                headFrom = headAngle;
                headTo = 0;
                headStage = 'out';
                headDuration = HEAD_TILT_OUT;
            } else {
                headAngle = 0;
                headStage = 'wait';
                headDuration = randomBetween(HEAD_WAIT_MIN, HEAD_WAIT_MAX);
            }
        }

        function stepTail(now) {
            const dt = Math.min(0.05, (now - tailLastFrame) / 1000) || 0.016;
            tailLastFrame = now;

            tailPhase = (tailPhase + dt / TAIL_PERIOD) % 1;

            /*
             * L'amplitude enfle et retombe au lieu de s'allumer.
             *
             * Elle rejoint sa cible d'une fraction constante par seconde, ce qui
             * donne une approche exponentielle : franche au départ, de plus en
             * plus douce, et jamais tout à fait arrivée — d'où le seuil
             * d'extinction plus bas. Le retour est le plus lent des deux : une
             * queue qui s'immobilise net au départ du curseur trahit l'animation
             * autant qu'un serpentin.
             */
            const target = isGithubHovered ? 1 : 0;
            const rate = isGithubHovered ? 2.2 : 1.1;
            tailAmount += (target - tailAmount) * Math.min(1, rate * dt);

            stepHead(dt);

            if (!isGithubHovered && tailAmount < 0.012 && Math.abs(headAngle) < 0.05) {
                // Le tracé d'origine, au caractère près, et une tête qui ne
                // porte plus aucune transformation.
                tailEl.setAttribute('d', TAIL_REST_D);
                if (headEl) headEl.removeAttribute('transform');
                tailAmount = 0;
                headAngle = 0;
                headStage = 'wait';
                headElapsed = 0;
                headDuration = randomBetween(HEAD_WAIT_MIN, HEAD_WAIT_MAX);
                tailAnimId = null;
                return;
            }

            tailEl.setAttribute('d', tailWaveAt(tailPhase, TAIL_AMPLITUDE * tailAmount));
            tailAnimId = requestAnimationFrame(stepTail);
        }

        btnGithub.addEventListener('mouseenter', () => {
            isGithubHovered = true;
            if (!tailAnimId) {
                tailLastFrame = performance.now();
                tailAnimId = requestAnimationFrame(stepTail);
            }
        });

        btnGithub.addEventListener('mouseleave', () => {
            isGithubHovered = false;
        });
    }

    /* ─────────────────── L'amorçage du bouton d'alimentation ───────────────────
     *
     * Ce bouton éteint le bot. C'est la commande la plus destructrice de
     * l'en-tête, et c'est ce qui a décidé de l'animation : la vapeur, le chat et
     * les étoiles filantes récompensent le survol, alors qu'ici une récompense
     * serait une faute de conception. Elle donnerait envie de cliquer sur le
     * seul bouton qu'on ne veut pas voir cliqué distraitement.
     *
     * L'animation doit donc accuser le survol sans le récompenser, et le
     * vocabulaire juste n'est pas celui du jeu mais celui de l'électricité :
     * *ceci est sous tension*. Le glyphe s'y prête, puisqu'il est littéralement
     * un circuit avec une coupure — une barre qui entre dans un anneau ouvert.
     *
     * Le courant remonte donc la barre, entre dans l'anneau et en fait le tour
     * jusqu'à refermer la boucle, après quoi le glyphe reste allumé et respire
     * très lentement. Rien ne se déplace, rien ne rebondit : le dessin est
     * exactement le même, il est seulement parcouru.
     *
     * L'anneau s'allume **par ses deux bouts à la fois**, et ce détail fait tout.
     * Une seule lueur qui court dans un sens se lit comme une roue qui tourne —
     * un chargement, une attente. Deux lueurs qui partent de la coupure et se
     * rejoignent en bas se lisent comme un circuit qui se ferme, ce qui est le
     * propos.
     */
    const btnPower = document.getElementById('btn-restart-bot');
    const powerReducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
    const chargeRing = btnPower ? btnPower.querySelector('.power-charge-ring') : null;
    const chargeBar = btnPower ? btnPower.querySelector('.power-charge-bar') : null;

    if (chargeRing && chargeBar && !powerReducedMotion) {
        /**
         * Longueur d'un tracé, mesurée par le navigateur.
         *
         * Le repli couvre les cas où la mesure n'est pas disponible, et vaut la
         * valeur exacte : la barre va de 12,2 à 12,12, soit 10 unités ; l'anneau
         * est un arc de rayon 9 couvrant 270°, soit 2π × 9 × 0,75. Les garder
         * écrites permet aussi de vérifier ce que le navigateur rapporte.
         */
        const measureLength = (el, fallback) => {
            try {
                const l = typeof el.getTotalLength === 'function' ? el.getTotalLength() : 0;
                return l > 0 ? l : fallback;
            } catch (e) {
                return fallback;
            }
        };

        const RING_LENGTH = measureLength(chargeRing, 42.412);
        const BAR_LENGTH = measureLength(chargeBar, 10);

        /** Secondes : la barre se remplit, puis l'anneau, avec un recouvrement. */
        const BAR_FILL = 0.28;
        const RING_START = 0.22;
        const RING_FILL = 0.5;
        const CHARGED_AT = RING_START + RING_FILL;

        /** Une fois la boucle fermée, le glyphe respire au lieu de rester figé. */
        const BREATH_PERIOD = 3.0;
        const BREATH_DEPTH = 0.22;

        /** Secondes d'allumage à l'arrivée, et d'extinction au départ. */
        const POWER_RISE = 0.12;
        const POWER_RELEASE = 0.5;

        const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));
        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
        const round3 = (v) => Math.round(v * 1000) / 1000;

        function paintCharge(elapsed, fade) {
            // La barre, révélée depuis son extrémité libre : le tracé est écrit
            // de 12,2 vers 12,12, donc du haut vers le centre, et un motif de
            // tirets se remplit toujours dans le sens du tracé.
            const barT = easeOutCubic(clamp01(elapsed / BAR_FILL));
            chargeBar.style.strokeDasharray =
                `${round3(BAR_LENGTH * barT)} ${round3(BAR_LENGTH)}`;

            /*
             * L'anneau, révélé par ses deux extrémités à la fois.
             *
             * Le motif « p, L−2p, p » pose un tiret au tout début du tracé et un
             * autre à sa toute fin, en laissant le milieu vide. Or les deux
             * extrémités de l'arc sont les deux lèvres de la coupure du symbole,
             * là où la barre entre : les deux lueurs en partent donc ensemble et
             * se rejoignent en bas.
             *
             * Un simple « stroke-dashoffset » aurait fait courir une seule lueur
             * dans un sens — techniquement plus simple, et complètement à côté du
             * propos.
             */
            const ringT = easeOutCubic(clamp01((elapsed - RING_START) / RING_FILL));
            const half = (RING_LENGTH / 2) * ringT;
            chargeRing.style.strokeDasharray =
                `${round3(half)} ${round3(Math.max(0, RING_LENGTH - 2 * half))} ${round3(half)}`;

            let breath = 1;
            if (elapsed > CHARGED_AT) {
                const cycle = (elapsed - CHARGED_AT) / BREATH_PERIOD;
                breath = 1 - BREATH_DEPTH * (0.5 - 0.5 * Math.cos(2 * Math.PI * cycle));
            }

            const opacity = `${round3(fade * breath)}`;
            chargeBar.style.opacity = opacity;
            chargeRing.style.opacity = opacity;
        }

        let powerElapsed = 0;
        let powerFade = 0;
        let isPowerHovered = false;
        let powerAnimId = null;
        let powerLastFrame = 0;

        function stepPower(now) {
            const dt = Math.min(0.05, (now - powerLastFrame) / 1000) || 0.016;
            powerLastFrame = now;

            // Le temps avance dans les deux cas : la respiration ne doit pas se
            // figer pendant que la lueur s'éteint.
            powerElapsed += dt;

            if (isPowerHovered) {
                powerFade = Math.min(1, powerFade + dt / POWER_RISE);
            } else {
                powerFade -= dt / POWER_RELEASE;
                if (powerFade <= 0) {
                    /*
                     * Tout est rendu à la feuille de style, et non remis à zéro
                     * à la main : une chaîne vide retire la déclaration en
                     * ligne, si bien que le repos redevient celui que le CSS
                     * décrit. Poser « opacity: 0 » ici laisserait au contraire
                     * le glyphe porter l'empreinte de son animation.
                     */
                    chargeBar.style.opacity = '';
                    chargeRing.style.opacity = '';
                    chargeBar.style.strokeDasharray = '';
                    chargeRing.style.strokeDasharray = '';
                    powerFade = 0;
                    powerElapsed = 0;
                    powerAnimId = null;
                    return;
                }
            }

            paintCharge(powerElapsed, powerFade);
            powerAnimId = requestAnimationFrame(stepPower);
        }

        btnPower.addEventListener('mouseenter', () => {
            isPowerHovered = true;
            if (!powerAnimId) {
                // Le compteur ne repart de zéro que si l'extinction est allée à
                // son terme : revenir sur le bouton pendant qu'il s'éteint
                // reprend la charge où elle en était, sans à-coup.
                powerElapsed = 0;
                powerLastFrame = performance.now();
                powerAnimId = requestAnimationFrame(stepPower);
            }
        });

        btnPower.addEventListener('mouseleave', () => {
            isPowerHovered = false;
        });
    }

    // Shooting Stars Animation for Theme Toggle Button (Night Mode)
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    if (btnThemeToggle) {
        let starCanvas = document.getElementById('shooting-stars-canvas');
        if (!starCanvas) {
            starCanvas = document.createElement('canvas');
            starCanvas.id = 'shooting-stars-canvas';
            starCanvas.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 99999; display: none;';
            document.body.appendChild(starCanvas);
        }
        const starCtx = starCanvas.getContext('2d');
        let starAnimFrameId = null;
        let isStarHovering = false;
        let lastStarSpawnTime = 0;
        let starParticles = [];

        function resizeStarCanvas() {
            if (starCanvas) {
                starCanvas.width = window.innerWidth;
                starCanvas.height = window.innerHeight;
            }
        }
        window.addEventListener('resize', resizeStarCanvas);

        function createShootingStar() {
            const btnRect = btnThemeToggle.getBoundingClientRect();
            const headerEl = document.querySelector('.main-header');
            const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : (btnRect.bottom + 8);
            const targetX = btnRect.left + btnRect.width / 2;

            const offsetX = (Math.random() - 0.2) * 50 + 20;
            const startX = Math.min(window.innerWidth - 10, targetX + offsetX);
            const startY = Math.max(0, btnRect.top - 35 - Math.random() * 20);

            const angle = (Math.PI / 180) * (130 + (Math.random() - 0.5) * 12);
            const speed = 0.8 + Math.random() * 0.9;

            return {
                type: 'star',
                x: startX,
                y: startY,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                length: 5 + Math.random() * 6,
                size: 0.6 + Math.random() * 0.8,
                alpha: 0,
                maxAlpha: 0.8 + Math.random() * 0.2,
                life: 0,
                maxLife: 45 + Math.floor(Math.random() * 30),
                maxY: headerBottom + 4
            };
        }

        function createBird() {
            const btnRect = btnThemeToggle.getBoundingClientRect();
            const headerEl = document.querySelector('.main-header');
            const headerTop = headerEl ? headerEl.getBoundingClientRect().top : 0;
            const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : (btnRect.bottom + 8);
            const targetX = btnRect.left + btnRect.width / 2;

            const startX = targetX + 35 + Math.random() * 45;
            const startY = Math.max(0, headerTop - 12 - Math.random() * 8);
            const speed = 0.25 + Math.random() * 0.25;

            return {
                type: 'bird',
                x: startX,
                y: startY,
                vx: -speed,
                vy: (Math.random() - 0.05) * 0.02,
                size: 0.55 + Math.random() * 0.25,
                wingPhase: Math.random() * Math.PI * 2,
                wingSpeed: 0.04 + Math.random() * 0.02,
                wavePhase: Math.random() * Math.PI * 2,
                alpha: 0,
                maxAlpha: 0.75 + Math.random() * 0.2,
                life: 0,
                maxLife: 220 + Math.floor(Math.random() * 80),
                minX: targetX - 60,
                maxY: headerBottom,
                minY: headerTop - 50
            };
        }

        function animateStars(now) {
            starCtx.clearRect(0, 0, starCanvas.width, starCanvas.height);

            if (isStarHovering && now - lastStarSpawnTime > 130) {
                const isNight = document.documentElement.getAttribute('data-theme') !== 'light';
                if (isNight) {
                    starParticles.push(createShootingStar());
                } else {
                    starParticles.push(createBird());
                }
                lastStarSpawnTime = now;
            }

            for (let i = starParticles.length - 1; i >= 0; i--) {
                const p = starParticles[i];

                if (p.type === 'bird') {
                    p.life++;
                    p.x += p.vx;
                    p.wingPhase += p.wingSpeed;
                    p.wavePhase += 0.05;
                    p.y += Math.sin(p.wavePhase) * 0.2;

                    if (p.x <= p.minX || p.y >= p.maxY || p.y <= p.minY) {
                        starParticles.splice(i, 1);
                        continue;
                    }

                    if (p.life < 10) {
                        p.alpha = (p.life / 10) * p.maxAlpha;
                    } else if (p.x < p.minX + 20) {
                        const distToLeft = p.x - p.minX;
                        p.alpha = Math.max(0, (distToLeft / 20) * p.maxAlpha);
                    } else if (p.life > p.maxLife - 15) {
                        p.alpha = Math.max(0, ((p.maxLife - p.life) / 15) * p.maxAlpha);
                    } else {
                        p.alpha = p.maxAlpha;
                    }

                    if (p.life >= p.maxLife || p.alpha <= 0) {
                        starParticles.splice(i, 1);
                        continue;
                    }

                    starCtx.save();
                    starCtx.translate(p.x, p.y);
                    starCtx.scale(p.size, p.size);

                    const flap = Math.sin(p.wingPhase) * 3.5;

                    starCtx.beginPath();
                    starCtx.moveTo(0, 0);
                    starCtx.quadraticCurveTo(4, -3 + flap, 7, -1 + flap * 0.5);
                    starCtx.moveTo(0, 0);
                    starCtx.quadraticCurveTo(-4, -3 + flap, -7, -1 + flap * 0.5);

                    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
                    const color = isLight ? `rgba(30, 41, 59, ${p.alpha})` : `rgba(240, 240, 255, ${p.alpha})`;
                    starCtx.strokeStyle = color;
                    starCtx.lineWidth = 1.3;
                    starCtx.lineCap = 'round';
                    starCtx.lineJoin = 'round';
                    starCtx.stroke();
                    starCtx.restore();

                } else {
                    p.life++;
                    p.x += p.vx;
                    p.y += p.vy;

                    if (p.y >= p.maxY) {
                        starParticles.splice(i, 1);
                        continue;
                    }

                    if (p.life < 10) {
                        p.alpha = (p.life / 10) * p.maxAlpha;
                    } else if (p.y > p.maxY - 15) {
                        const distToBottom = p.maxY - p.y;
                        p.alpha = Math.max(0, (distToBottom / 15) * p.maxAlpha);
                    } else if (p.life > p.maxLife - 15) {
                        p.alpha = Math.max(0, ((p.maxLife - p.life) / 15) * p.maxAlpha);
                    } else {
                        p.alpha = p.maxAlpha;
                    }

                    if (p.life >= p.maxLife || p.alpha <= 0) {
                        starParticles.splice(i, 1);
                        continue;
                    }

                    const tailX = p.x - p.vx * (p.length / 3);
                    const tailY = p.y - p.vy * (p.length / 3);

                    const grad = starCtx.createLinearGradient(tailX, tailY, p.x, p.y);
                    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
                    grad.addColorStop(1, `rgba(255, 255, 255, ${p.alpha})`);

                    starCtx.beginPath();
                    starCtx.moveTo(tailX, tailY);
                    starCtx.lineTo(p.x, p.y);
                    starCtx.strokeStyle = grad;
                    starCtx.lineWidth = p.size;
                    starCtx.lineCap = 'round';
                    starCtx.stroke();

                    starCtx.beginPath();
                    starCtx.arc(p.x, p.y, p.size * 1.1, 0, Math.PI * 2);
                    starCtx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
                    starCtx.shadowColor = 'rgba(255, 255, 255, 0.8)';
                    starCtx.shadowBlur = 4;
                    starCtx.fill();
                    starCtx.shadowBlur = 0;
                }
            }

            if (starParticles.length > 0 || isStarHovering) {
                starAnimFrameId = requestAnimationFrame(animateStars);
            } else {
                starAnimFrameId = null;
                starCanvas.style.display = 'none';
            }
        }

        btnThemeToggle.addEventListener('mouseenter', () => {
            isStarHovering = true;
            starCanvas.style.display = 'block';
            resizeStarCanvas();
            if (!starAnimFrameId) {
                lastStarSpawnTime = performance.now();
                starAnimFrameId = requestAnimationFrame(animateStars);
            }
        });

        btnThemeToggle.addEventListener('mouseleave', () => {
            isStarHovering = false;
        });

        btnThemeToggle.addEventListener('click', () => {
            starParticles = [];
            lastStarSpawnTime = 0;
            if (!starAnimFrameId && isStarHovering) {
                starCanvas.style.display = 'block';
                resizeStarCanvas();
                starAnimFrameId = requestAnimationFrame(animateStars);
            }
        });
    }
})();