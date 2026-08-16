/**
 * Speed Pad Wheel Controller (3 States: Classic, Precise 0.05, Centième 0.01)
 * Supports dual synchronized pads (Dashboard + Floating Video Window)
 */

window.MusicPlayer = window.MusicPlayer || {};

window.MusicPlayer.currentSpeed = "1.00";
let preciseState = 0;
let lastSpeedInteractionTime = 0;
let speedPadSwitchTimeout = null;
let isSpeedPadDragging = false;

const classicSpeeds = ["0.25", "0.50", "0.75", "1.00", "1.25", "1.50", "1.75", "2.00", "2.50", "3.00"];
const preciseSpeeds = [];
for (let s = 0.25; s <= 3.001; s += 0.05) {
    preciseSpeeds.push((Math.round(s * 100) / 100).toFixed(2));
}
const centiemeSpeeds = [];
for (let s = 0.25; s <= 3.001; s += 0.01) {
    centiemeSpeeds.push((Math.round(s * 100) / 100).toFixed(2));
}

function getSpeeds() {
    if (preciseState === 2) return centiemeSpeeds;
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
    console.log(`[Vitesse Diagnostic] ${logMsg}`);
    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({
            type: 'clientLog',
            data: { source: 'Vitesse Vidéo/IHM', message: logMsg }
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
                container.classList.add('state-centieme');
                container.classList.remove('state-classic', 'state-precise');
            } else if (preciseState === 1) {
                container.classList.add('state-precise');
                container.classList.remove('state-classic', 'state-centieme');
            } else {
                container.classList.add('state-classic');
                container.classList.remove('state-precise', 'state-centieme');
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
        } else if (centiemeSpeeds.includes(formattedSpeed)) {
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

    const modeNames = ['CLASSIQUE', 'PRÉCIS (0.05)', 'CENTIÈME (0.01)'];
    const modeLabel = modeNames[preciseState];
    const logMsg = `Bascule du mode de précision de la vitesse : ${modeLabel} (Source: ${indicatorSource || 'Indicateur'})`;
    console.log(`[Vitesse Diagnostic] ${logMsg}`);
    if (typeof window.MusicPlayer.sendWS === 'function') {
        window.MusicPlayer.sendWS({
            type: 'clientLog',
            data: { source: 'Vitesse Précision', message: logMsg }
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

        let isDragging = false;
        let startX = 0;
        let startTranslateX = 0;
        let activeDragSpeed = window.MusicPlayer.currentSpeed;

        let clickStartTime = 0;
        let clickStartX = 0;
        let clickStartY = 0;

        container.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDragging = true;
            isSpeedPadDragging = true;
            startX = e.clientX;
            startTranslateX = parseFloat(track.dataset.translateX || 0);
            activeDragSpeed = window.MusicPlayer.currentSpeed;

            if (!track.classList.contains('switching')) {
                track.style.transition = 'none';
            }

            clickStartTime = Date.now();
            clickStartX = e.clientX;
            clickStartY = e.clientY;
        });

        const onMouseMove = (e) => {
            if (!isDragging) return;
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
        };

        const onMouseUp = (e) => {
            if (!isDragging) return;
            isDragging = false;
            isSpeedPadDragging = false;

            const clickDuration = Date.now() - clickStartTime;
            const clickDistX = Math.abs(e.clientX - clickStartX);
            const clickDistY = Math.abs(e.clientY - clickStartY);

            if (clickDuration < 350 && clickDistX < 8 && clickDistY < 8) {
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

            if (activeDragSpeed !== window.MusicPlayer.currentSpeed) {
                window.MusicPlayer.sendSpeedUpdate(activeDragSpeed);
                window.MusicPlayer.updateSpeedPad(activeDragSpeed);
            } else {
                window.MusicPlayer.updateSpeedPad(window.MusicPlayer.currentSpeed);
            }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

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
