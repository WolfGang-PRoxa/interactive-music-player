/**
 * Dynamic Animated Favicon Renderer for Tab Bar
 * Renders high-performance animated double sixteenth note (♬) favicons on offscreen canvas.
 */

window.MusicPlayer = window.MusicPlayer || {};

(function () {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  // Polyfill roundRect if needed
  if (!ctx.roundRect) {
    ctx.roundRect = function (x, y, w, h, r) {
      const radius = typeof r === 'number' ? r : 8;
      this.beginPath();
      this.moveTo(x + radius, y);
      this.lineTo(x + w - radius, y);
      this.quadraticCurveTo(x + w, y, x + w, y + radius);
      this.lineTo(x + w, y + h - radius);
      this.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      this.lineTo(x + radius, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - radius);
      this.lineTo(x, y + radius);
      this.quadraticCurveTo(x, y, x + radius, y);
      this.closePath();
    };
  }

  let currentStyle = 'glassmorphism';
  let animationTimer = null;
  let isRunning = false;

  function drawDoubleNote(ctx, color1, color2, glowColor) {
    ctx.save();
    ctx.translate(32, 28);
    ctx.scale(1.16, 1.16);
    ctx.translate(-32, -28);

    if (glowColor) {
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 6;
    }

    const grad = ctx.createLinearGradient(16, 8, 52, 48);
    grad.addColorStop(0, color1);
    if (color2) grad.addColorStop(1, color2);

    ctx.fillStyle = grad;

    // Note head 1 (Left)
    ctx.beginPath();
    ctx.ellipse(20, 46, 6.5, 5, (-25 * Math.PI) / 180, 0, Math.PI * 2);
    ctx.fill();

    // Note head 2 (Right)
    ctx.beginPath();
    ctx.ellipse(44, 40, 6.5, 5, (-25 * Math.PI) / 180, 0, Math.PI * 2);
    ctx.fill();

    // Left Stem
    ctx.beginPath();
    ctx.roundRect(23, 14, 3.5, 32, 1.5);
    ctx.fill();

    // Right Stem
    ctx.beginPath();
    ctx.roundRect(47, 8, 3.5, 32, 1.5);
    ctx.fill();

    // Beam 1 (Top)
    ctx.beginPath();
    ctx.moveTo(23, 14);
    ctx.lineTo(50.5, 8);
    ctx.lineTo(50.5, 13.5);
    ctx.lineTo(23, 19.5);
    ctx.closePath();
    ctx.fill();

    // Beam 2 (Second)
    ctx.beginPath();
    ctx.moveTo(23, 21.5);
    ctx.lineTo(50.5, 15.5);
    ctx.lineTo(50.5, 21);
    ctx.lineTo(23, 27);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function renderFrame() {
    if (document.hidden) return;

    ctx.clearRect(0, 0, 64, 64);
    const now = Date.now() / 1000;

    if (currentStyle === 'neon-cyberpunk') {
      const beatScale = 1 + Math.sin(now * 8) * 0.05;
      const rot = Math.cos(now * 4) * 0.04;
      const borderCol = Math.floor(now * 3) % 2 === 0 ? '#ff007f' : '#00f3ff';
      const cornerCol = Math.floor(now * 4) % 2 === 0 ? '#00f3ff' : '#ffe600';

      ctx.save();
      ctx.fillStyle = '#0d021a';
      ctx.beginPath();
      ctx.roundRect(2, 2, 60, 60, 14);
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = borderCol;
      ctx.shadowColor = borderCol;
      ctx.shadowBlur = 6;
      ctx.stroke();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cornerCol;
      ctx.beginPath();
      ctx.moveTo(2, 14);
      ctx.lineTo(14, 2);
      ctx.moveTo(50, 2);
      ctx.lineTo(62, 14);
      ctx.moveTo(62, 50);
      ctx.lineTo(50, 62);
      ctx.moveTo(14, 62);
      ctx.lineTo(2, 50);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(32, 32);
      ctx.scale(beatScale, beatScale);
      ctx.rotate(rot);
      ctx.translate(-32, -32);
      drawDoubleNote(ctx, '#00f3ff', '#ff007f', '#ff007f');
      ctx.restore();
    } else if (currentStyle === 'minimalist') {
      const offsetY = Math.sin(now * 2.5) * 1.5;
      const borderAlpha = 0.5 + Math.sin(now * 2) * 0.3;

      ctx.save();
      ctx.fillStyle = '#18181b';
      ctx.beginPath();
      ctx.roundRect(2, 2, 60, 60, 16);
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(113, 113, 122, ${borderAlpha})`;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(0, offsetY);
      drawDoubleNote(ctx, '#ffffff', '#e4e4e7', null);
      ctx.restore();
    } else if (currentStyle === 'retro-synthwave') {
      const rot = Math.sin(now * 3) * 0.06;
      const offsetY = Math.cos(now * 3) * 1.2;
      const sunRadius = 17 + Math.sin(now * 4) * 1.2;

      ctx.save();
      const bgGrad = ctx.createLinearGradient(0, 2, 0, 62);
      bgGrad.addColorStop(0, '#1a0933');
      bgGrad.addColorStop(1, '#3b0764');
      ctx.fillStyle = bgGrad;
      ctx.beginPath();
      ctx.roundRect(2, 2, 60, 60, 15);
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ff007f';
      ctx.shadowColor = '#ff007f';
      ctx.shadowBlur = 4;
      ctx.stroke();

      const sunGrad = ctx.createLinearGradient(0, 18, 0, 54);
      sunGrad.addColorStop(0, '#ffbe0b');
      sunGrad.addColorStop(1, '#ff007f');
      ctx.fillStyle = sunGrad;
      ctx.shadowColor = '#ffbe0b';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(32, 35, Math.max(10, sunRadius), 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#1a0933';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(14, 33);
      ctx.lineTo(50, 33);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(14, 37);
      ctx.lineTo(50, 37);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(14, 42);
      ctx.lineTo(50, 42);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(32, 32);
      ctx.rotate(rot);
      ctx.translate(-32, -32 + offsetY);
      drawDoubleNote(ctx, '#ffffff', '#ffffff', 'rgba(255, 0, 127, 0.6)');
      ctx.restore();
    } else {
      // Glassmorphism (Default)
      const offsetY = Math.sin(now * 2.2) * 2;
      const rot = Math.sin(now * 1.5) * 0.04;

      ctx.save();
      const bgGrad = ctx.createLinearGradient(2, 2, 62, 62);
      bgGrad.addColorStop(0, '#1e293b');
      bgGrad.addColorStop(1, '#0f172a');
      ctx.fillStyle = bgGrad;
      ctx.beginPath();
      ctx.roundRect(2, 2, 60, 60, 16);
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.moveTo(2, 18);
      ctx.bezierCurveTo(2, 8, 8, 2, 18, 2);
      ctx.lineTo(46, 2);
      ctx.bezierCurveTo(56, 2, 62, 8, 62, 18);
      ctx.lineTo(62, 27);
      ctx.bezierCurveTo(42, 35, 24, 29, 2, 18);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(32, 32);
      ctx.rotate(rot);
      ctx.translate(-32, -32 + offsetY);
      drawDoubleNote(ctx, '#38bdf8', '#c084fc', '#818cf8');
      ctx.restore();
    }

    const faviconLink = document.getElementById('app-favicon');
    if (faviconLink) {
      faviconLink.href = canvas.toDataURL('image/png');
    }
  }

  window.MusicPlayer.setAnimatedFaviconStyle = function (style) {
    currentStyle = style || 'glassmorphism';
    renderFrame();
  };

  window.MusicPlayer.startFaviconAnimation = function () {
    if (isRunning) return;
    isRunning = true;
    // Animation ultra-fluide à 25 FPS (1000ms / 25 = 40ms)
    animationTimer = setInterval(renderFrame, 40);
  };

  window.MusicPlayer.stopFaviconAnimation = function () {
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = null;
    }
    isRunning = false;
  };
})();
