/**
 * Speed Pad Wheel Controller (3 States: Classic, Precise 0.05, Centième 0.01)
 * Supports dual synchronized pads (Dashboard + Floating Video Window)
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.currentSpeed = "1.00";
let preciseState = 0;
let lastSpeedInteractionTime = 0;
let speedPadSwitchTimeout = null;
/*
 * Le glissement en cours, publié sur `window.MusicPlayer`.
 *
 * js/video.js le consulte pour ne pas effacer les incrustations sous le doigt
 * qui les manipule. Il ne lisait qu'`undefined` : ce fichier tenait le drapeau
 * en portée de module, où rien d'autre ne pouvait l'atteindre, et la garde
 * d'en face n'a jamais rien gardé. Le pad s'évanouissait donc au milieu d'un
 * glissement de plus de deux secondes et demie.
 *
 * La variable locale reste la source : `setDragging()` tient les deux en phase,
 * de sorte qu'aucun des trois points de bascule ne puisse en oublier une.
 */
let isSpeedPadDragging = false;

function setDragging(active) {
    isSpeedPadDragging = active;
    window.MusicPlayer.isSpeedPadDragging = active;
}

const classicSpeeds = ["0.25", "0.50", "0.75", "1.00", "1.25", "1.50", "1.75", "2.00", "2.50", "3.00"];
const preciseSpeeds = [];
for (let s = 0.25; s <= 3.001; s += 0.05) {
    preciseSpeeds.push((Math.round(s * 100) / 100).toFixed(2));
}
const hundredthSpeeds = [];
for (let s = 0.25; s <= 3.001; s += 0.01) {
    hundredthSpeeds.push((Math.round(s * 100) / 100).toFixed(2));
}

function getSpeeds() {
    if (preciseState === 2) return hundredthSpeeds;
    if (preciseState === 1) return preciseSpeeds;
    return classicSpeeds;
}

function getPadPairs() {
    return [
        {
            indicator: document.getElementById('speed-pad-indicator'),
            container: document.getElementById('speed-pad-container'),
            track: document.getElementById('speed-pad-track')
        },
        {
            indicator: document.getElementById('video-speed-pad-indicator'),
            container: document.getElementById('video-speed-pad-container'),
            track: document.getElementById('video-speed-pad-track')
        }
    ].filter(pair => pair.container && pair.track);
}

window.MusicPlayer.sendSpeedUpdate = function(speedVal) {
    lastSpeedInteractionTime = Date.now();
    window.MusicPlayer.currentSpeed = speedVal;

    // Retour instantané sur le lecteur vidéo, sans attendre le prochain "state" du serveur (jusqu'à 1s)
    if (typeof window.MusicPlayer.syncVideoSpeed === 'function') {
        window.MusicPlayer.syncVideoSpeed(speedVal);
    }

    const logMsg = `Changement de vitesse de lecture : ${speedVal}x`;
    console.log(`[Speed Diagnostic] ${logMsg}`);
    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({
            type: 'clientLog',
            data: { source: 'Video/UI Speed', message: logMsg }
        });
        window.MusicPlayer.sendWS({
            type: 'updateSettings',
            data: { playbackSpeed: speedVal }
        });
    }
};

window.MusicPlayer.rebuildSpeedPadTrack = function(triggerBounce = false) {
    const pairs = getPadPairs();
    if (pairs.length === 0) return;

    if (speedPadSwitchTimeout) {
        clearTimeout(speedPadSwitchTimeout);
        speedPadSwitchTimeout = null;
    }

    const currentSpeeds = getSpeeds();

    pairs.forEach(({ indicator, container, track }) => {
        track.classList.remove('switching');
        track.innerHTML = '';

        if (indicator) {
            if (preciseState === 2) {
                indicator.textContent = 'CENTIÈME (0.01)';
                indicator.classList.add('precise-active');
            } else if (preciseState === 1) {
                indicator.textContent = 'PRÉCIS (0.05)';
                indicator.classList.add('precise-active');
            } else {
                indicator.textContent = 'CLASSIQUE';
                indicator.classList.remove('precise-active');
            }
        }

        if (container) {
            if (preciseState === 2) {
                container.classList.add('state-hundredth');
                container.classList.remove('state-classic', 'state-precise');
            } else if (preciseState === 1) {
                container.classList.add('state-precise');
                container.classList.remove('state-classic', 'state-hundredth');
            } else {
                container.classList.add('state-classic');
                container.classList.remove('state-precise', 'state-hundredth');
            }
        }

        if (preciseState > 0) {
            track.classList.add('precise-mode');
        } else {
            track.classList.remove('precise-mode');
        }

        let activeIdx = currentSpeeds.indexOf(window.MusicPlayer.currentSpeed);
        if (activeIdx === -1) {
            let minDiff = Infinity;
            let closestIdx = 0;
            const targetVal = parseFloat(window.MusicPlayer.currentSpeed);
            currentSpeeds.forEach((s, idx) => {
                const diff = Math.abs(parseFloat(s) - targetVal);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIdx = idx;
                }
            });
            activeIdx = closestIdx;
        }

        currentSpeeds.forEach((speed, idx) => {
            const el = document.createElement('div');
            el.className = 'speed-value';
            if (preciseState > 0 && !classicSpeeds.includes(speed)) {
                el.classList.add('precise-only');
            }
            el.dataset.speed = speed;
            el.textContent = `${speed}x`;
            if (triggerBounce) {
                const distance = Math.abs(idx - activeIdx);
                const delayStep = preciseState === 2 ? 4 : 15;
                el.style.animationDelay = `${distance * delayStep}ms`;
            }
            track.appendChild(el);
        });

        track.offsetHeight;
        if (triggerBounce) {
            track.classList.add('switching');
        }
    });

    window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed, true);

    if (triggerBounce) {
        speedPadSwitchTimeout = setTimeout(() => {
            pairs.forEach(({ track }) => track.classList.remove('switching'));
            speedPadSwitchTimeout = null;
        }, 700);
    }
};

window.MusicPlayer.updateSpeedPad = function(speed, skipTransition = false) {
    const pairs = getPadPairs();
    if (pairs.length === 0) return;

    if (!skipTransition && isSpeedPadDragging) {
        return;
    }

    const speedFloat = parseFloat(speed) || 1.0;
    const formattedSpeed = speedFloat.toFixed(2);
    window.MusicPlayer.currentSpeed = formattedSpeed;

    const currentSpeeds = getSpeeds();
    if (!currentSpeeds.includes(formattedSpeed)) {
        if (Date.now() - lastSpeedInteractionTime < 1200) {
            return;
        }
        if (preciseSpeeds.includes(formattedSpeed)) {
            preciseState = 1;
            window.MusicPlayer.rebuildSpeedPadTrack(false);
            return;
        } else if (hundredthSpeeds.includes(formattedSpeed)) {
            preciseState = 2;
            window.MusicPlayer.rebuildSpeedPadTrack(false);
            return;
        }
    }

    pairs.forEach(({ container, track }) => {
        const targetEl = track.querySelector(`[data-speed="${formattedSpeed}"]`);
        if (!targetEl) return;

        track.querySelectorAll('.speed-value').forEach(el => el.classList.remove('active'));
        targetEl.classList.add('active');

        if (targetEl.classList.contains('precise-only')) {
            container.classList.add('precise-active');
        } else {
            container.classList.remove('precise-active');
        }

        const containerWidth = container.clientWidth || container.offsetWidth || 140;
        const elLeft = targetEl.offsetLeft;
        const elWidth = targetEl.offsetWidth;

        if (containerWidth > 0 && elWidth > 0) {
            delete container.dataset.needsRelayout;
            const translateX = containerWidth / 2 - elLeft - elWidth / 2;

            if (track.classList.contains('switching')) {
                track.style.transition = '';
            } else {
                track.style.transition = skipTransition ? 'none' : 'transform 0.25s cubic-bezier(0.25, 0.8, 0.25, 1)';
            }

            track.style.transform = `translateX(${translateX}px)`;
            track.dataset.translateX = translateX;
        } else {
            container.dataset.needsRelayout = 'true';
        }
    });
};

function togglePrecisionMode(indicatorSource) {
    const now = Date.now();
    if (now - lastSpeedInteractionTime < 300) return;
    lastSpeedInteractionTime = now;

    preciseState = (preciseState + 1) % 3;

    const modeNames = ['CLASSIC', 'FINE (0.05)', 'HUNDREDTH (0.01)'];
    const modeLabel = modeNames[preciseState];
    const logMsg = `Speed precision mode toggled: ${modeLabel} (Source: ${indicatorSource || 'Indicator'})`;
    console.log(`[Speed Diagnostic] ${logMsg}`);
    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({
            type: 'clientLog',
            data: { source: 'Speed Precision', message: logMsg }
        });
    }

    let targetSpeed = window.MusicPlayer.currentSpeed || "1.00";
    const currentSpeeds = getSpeeds();
    const targetSpeedFormatted = parseFloat(targetSpeed).toFixed(2);

    if (!currentSpeeds.includes(targetSpeedFormatted)) {
        let minDiff = Infinity;
        let closestSpeed = currentSpeeds[0];
        const targetVal = parseFloat(targetSpeed);
        for (const s of currentSpeeds) {
            const diff = Math.abs(parseFloat(s) - targetVal);
            if (diff < minDiff) {
                minDiff = diff;
                closestSpeed = s;
            }
        }
        targetSpeed = closestSpeed;
    } else {
        targetSpeed = targetSpeedFormatted;
    }

    const previousSpeed = window.MusicPlayer.currentSpeed;
    window.MusicPlayer.currentSpeed = targetSpeed;
    window.MusicPlayer.rebuildSpeedPadTrack(true);

    if (targetSpeed !== previousSpeed) {
        window.MusicPlayer.sendSpeedUpdate(targetSpeed);
    }
}

window.MusicPlayer.initSpeedPad = function() {
    window.MusicPlayer.rebuildSpeedPadTrack(false);

    // Bind mouse & wheel events for each container
    const containers = [
        document.getElementById('speed-pad-container'),
        document.getElementById('video-speed-pad-container')
    ].filter(Boolean);

    // IntersectionObserver to auto-recenter hidden speed pads when they become visible
    if (window.IntersectionObserver) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed, true);
                }
            });
        }, { threshold: 0.1 });
        containers.forEach(c => observer.observe(c));
    }

    containers.forEach(container => {
        if (container.dataset.speedContainerBound) return;
        container.dataset.speedContainerBound = 'true';

        const track = container.querySelector('.speed-pad-track');
        if (!track) return;

        /*
         * Le pad se manœuvre au pointeur, et non à la souris.
         *
         * `mousedown`/`mousemove`/`mouseup` ne sont jamais émis par un écran
         * tactile autrement qu'en compatibilité, après la fin du geste : la
         * roulette ne suivait donc pas le doigt, et le seul moyen de changer de
         * vitesse au téléphone était de taper une valeur déjà visible dans les
         * 140 px du cadre.
         *
         * Les événements pointeur couvrent souris, doigt et stylet par un seul
         * chemin de code. Tout ce que les gestionnaires lisent — `clientX`,
         * `clientY`, `target` — existe à l'identique sur un `PointerEvent`, si
         * bien que la mécanique de glissement n'a pas eu à changer.
         *
         * Le déplacement et le relâchement restent écoutés sur `window` : le
         * doigt sort couramment du cadre pendant le geste, et une capture de
         * pointeur redirigerait `target` vers le conteneur, ce dont dépend la
         * reconnaissance du tap sur une valeur précise.
         */
        let isDragging = false;
        let activePointer = null;
        let startX = 0;
        let startTranslateX = 0;
        let activeDragSpeed = window.MusicPlayer.currentSpeed;
        /*
         * Vitesse d'avant le geste, relevée une fois pour toutes au poser du
         * doigt.
         *
         * `currentSpeed` ne peut pas servir de référence : l'aperçu du
         * glissement passe par `updateSpeedPad()`, qui l'écrit à chaque
         * déplacement. Au relâchement, elle vaut donc déjà la valeur choisie,
         * la comparaison ne voit aucun changement et rien ne part vers le
         * serveur — le pad revenait alors à la vitesse du serveur au message
         * d'état suivant.
         */
        let speedAtDragStart = window.MusicPlayer.currentSpeed;

        let clickStartTime = 0;
        let clickStartX = 0;
        let clickStartY = 0;
        let clickPointerType = 'mouse';

        /*
         * Tolérance de tap, plus large au doigt.
         *
         * La pulpe roule sur l'écran : un appui que l'utilisateur croit
         * immobile dérive couramment d'une dizaine de pixels. Au seuil de la
         * souris, ces taps-là étaient lus comme des glissements minuscules et
         * ne sélectionnaient rien.
         */
        const toleranceTap = () => (clickPointerType === 'mouse' ? 8 : 14);

        container.addEventListener('pointerdown', (e) => {
            // Un second doigt posé pendant le geste ne doit pas en prendre la
            // main : le premier garde le pad jusqu'à ce qu'il le relâche.
            if (isDragging) return;
            if (e.isPrimary === false) return;

            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            setDragging(true);
            activePointer = e.pointerId;
            startX = e.clientX;
            startTranslateX = parseFloat(track.dataset.translateX || 0);
            activeDragSpeed = window.MusicPlayer.currentSpeed;
            speedAtDragStart = window.MusicPlayer.currentSpeed;

            if (!track.classList.contains('switching')) {
                track.style.transition = 'none';
            }

            clickStartTime = Date.now();
            clickStartX = e.clientX;
            clickStartY = e.clientY;
            clickPointerType = e.pointerType || 'mouse';
        });

        const onPointerMove = (e) => {
            if (!isDragging || e.pointerId !== activePointer) return;
            if (track.classList.contains('switching')) return;

            const dx = e.clientX - startX;
            const currentTranslate = startTranslateX + dx;

            const containerWidth = container.clientWidth || 140;
            const center = containerWidth / 2;
            let closestEl = null;
            let minDistance = Infinity;

            track.querySelectorAll('.speed-value').forEach(el => {
                const elCenter = el.offsetLeft + el.offsetWidth / 2 + currentTranslate;
                const distance = Math.abs(center - elCenter);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestEl = el;
                }
            });

            if (closestEl && closestEl.dataset.speed) {
                activeDragSpeed = closestEl.dataset.speed;
                window.MusicPlayer.updateSpeedPad(activeDragSpeed, true);
            }

            /*
             * Le ruban suit le doigt.
             *
             * `updateSpeedPad()` vient de le recentrer sur la valeur retenue :
             * le ruban sautait donc d'un cran à l'autre au lieu d'accompagner
             * le geste. À la souris, les événements sont assez serrés pour que
             * ça passe pour du continu ; au doigt, il n'y en a qu'une douzaine
             * sur toute la course, et chaque saut se voit.
             *
             * On rétablit ici la position réelle du glissement. Le recentrage
             * sur la valeur choisie a lieu au relâchement, avec sa transition.
             */
            track.style.transform = `translateX(${currentTranslate}px)`;
        };

        const onPointerUp = (e) => {
            if (!isDragging || e.pointerId !== activePointer) return;
            isDragging = false;
            setDragging(false);
            activePointer = null;

            const clickDuration = Date.now() - clickStartTime;
            const clickDistX = Math.abs(e.clientX - clickStartX);
            const clickDistY = Math.abs(e.clientY - clickStartY);
            const tolerance = toleranceTap();

            if (clickDuration < 350 && clickDistX < tolerance && clickDistY < tolerance) {
                let speedValueEl = e.target.closest ? e.target.closest('.speed-value') : null;
                if (!speedValueEl) {
                    let minDiff = Infinity;
                    track.querySelectorAll('.speed-value').forEach(el => {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0) {
                            const elCenter = r.left + r.width / 2;
                            const diff = Math.abs(e.clientX - elCenter);
                            if (diff < minDiff) {
                                minDiff = diff;
                                speedValueEl = el;
                            }
                        }
                    });
                }

                if (speedValueEl) {
                    lastSpeedInteractionTime = Date.now();
                    const clickedSpeed = speedValueEl.dataset.speed;
                    window.MusicPlayer.currentSpeed = clickedSpeed;
                    window.MusicPlayer.sendSpeedUpdate(clickedSpeed);
                    window.MusicPlayer.updateSpeedPad(clickedSpeed);
                }
                return;
            }

            if (track.classList.contains('switching')) return;

            if (activeDragSpeed !== speedAtDragStart) {
                window.MusicPlayer.sendSpeedUpdate(activeDragSpeed);
                window.MusicPlayer.updateSpeedPad(activeDragSpeed);
            } else {
                window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed);
            }
        };

        /*
         * Le navigateur peut reprendre le geste à son compte — défilement de la
         * page décidé en cours de route, appel entrant, fenêtre qui perd le
         * focus. Il émet alors `pointercancel` et plus jamais `pointerup` :
         * sans ce gestionnaire, le pad restait en glissement pour de bon, la
         * transition neutralisée et le prochain appui ignoré.
         *
         * L'abandon rend la vitesse d'avant le geste, comme un relâchement qui
         * n'aurait rien déplacé.
         */
        const onPointerCancel = (e) => {
            if (!isDragging || e.pointerId !== activePointer) return;
            isDragging = false;
            setDragging(false);
            activePointer = null;
            window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed);
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerCancel);

        // Wheel scroll for speed adjustment
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            lastSpeedInteractionTime = Date.now();
            const currentSpeeds = getSpeeds();
            let idx = currentSpeeds.indexOf(window.MusicPlayer.currentSpeed);
            if (idx === -1) idx = 0;

            if (e.deltaY > 0) {
                idx = Math.min(currentSpeeds.length - 1, idx + 1);
            } else if (e.deltaY < 0) {
                idx = Math.max(0, idx - 1);
            }

            const newSpeed = currentSpeeds[idx];
            if (newSpeed && newSpeed !== window.MusicPlayer.currentSpeed) {
                window.MusicPlayer.currentSpeed = newSpeed;
                window.MusicPlayer.sendSpeedUpdate(newSpeed);
                window.MusicPlayer.updateSpeedPad(newSpeed);
            }
        }, { passive: false });
    });
};

// Global click delegation for speed-pad-indicator (Guarantees precision toggle works for all pads)
document.addEventListener('click', (e) => {
    const indicatorEl = e.target.closest ? e.target.closest('.speed-pad-indicator') : null;
    if (indicatorEl) {
        e.stopPropagation();
        togglePrecisionMode(indicatorEl.id || 'Indicateur');
    }
});
