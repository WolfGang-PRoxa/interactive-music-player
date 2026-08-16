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

    // Animation avec morphing et apaisement doux pour la vapeur du café
    const btnBuyCoffee = document.getElementById('btn-buy-coffee');
    if (btnBuyCoffee) {
        const steamPaths = btnBuyCoffee.querySelectorAll('.steam-path');
        let steamPhase = 0;
        let steamAnimId = null;
        let isCoffeeHovered = false;

        const basePositions = [
            { x: 5.5, dx: 2.3 },
            { x: 10.5, dx: 2.3 },
            { x: 15.5, dx: 2.3 }
        ];

        function stepSteamWave() {
            if (!isCoffeeHovered) return;
            steamPhase += 0.05;
            steamPaths.forEach((path, idx) => {
                const shift1 = Math.sin(steamPhase + idx * 1.2) * 2.3;
                const shift2 = Math.cos(steamPhase + idx * 1.2) * 2.2;
                const baseX = basePositions[idx].x;
                path.setAttribute('d', `M${baseX} 7.2 C${baseX - 2.3 + shift1} 5.2, ${baseX + 2.3 - shift1} 3.2, ${baseX} 1.2 C${baseX - 2 + shift2} -0.8, ${baseX + 2 - shift2} -2.5, ${baseX} -4`);
            });
            steamAnimId = requestAnimationFrame(stepSteamWave);
        }

        btnBuyCoffee.addEventListener('mouseenter', () => {
            isCoffeeHovered = true;
            steamPaths.forEach(p => p.style.transition = 'none');
            cancelAnimationFrame(steamAnimId);
            stepSteamWave();
        });

        btnBuyCoffee.addEventListener('mouseleave', () => {
            isCoffeeHovered = false;
            cancelAnimationFrame(steamAnimId);
            steamPaths.forEach((path, idx) => {
                const baseX = basePositions[idx].x;
                path.style.transition = 'd 0.7s cubic-bezier(0.16, 1, 0.3, 1)';
                path.setAttribute('d', `M${baseX} 7.2 C${baseX - 2.3} 5.2, ${baseX + 2.3} 3.2, ${baseX} 1.2 C${baseX - 2} -0.8, ${baseX + 2} -2.5, ${baseX} -4`);
            });
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