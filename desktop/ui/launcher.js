/*
 * Fenêtre de lancement.
 *
 * Elle ne décide de rien : l'application (src-tauri/src/supervisor.rs) lui
 * envoie un instantané complet à chaque changement, la page le dessine, et
 * renvoie l'identifiant du bouton cliqué.
 */
(() => {
    'use strict';

    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    const $ = (id) => document.getElementById(id);

    /** Glyphes des cartes, dans un repère de 24 × 24. */
    const GLYPHS = {
        dashboard: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 14h3M8 17h6"/>',
        browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
        restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
        shutdown: '<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>',
    };

    function act(id, value) {
        invoke('act', { id, value: value ?? null }).catch(() => {});
    }

    function button(action) {
        const el = document.createElement('button');
        el.className = `button ${action.kind}`;
        el.textContent = action.label;
        el.addEventListener('click', () => act(action.id));
        return el;
    }

    function renderSteps(snapshot) {
        const list = $('steps');
        list.replaceChildren(...snapshot.steps.map((step) => {
            const row = document.createElement('div');
            row.className = `step ${step.state}`;
            const icon = document.createElement('span');
            icon.className = 'step-icon';
            const caption = document.createElement('span');
            caption.textContent = step.caption;
            row.append(icon, caption);
            return row;
        }));
        list.hidden = snapshot.screen !== 'steps' || snapshot.steps.length === 0;

        const running = snapshot.steps.some((s) => s.state === 'running');
        const track = $('track');
        track.hidden = !running || snapshot.screen !== 'steps';
        track.classList.toggle('indeterminate', snapshot.progress == null);
        $('bar').style.width = snapshot.progress == null ? '30%' : `${Math.round(snapshot.progress * 100)}%`;
    }

    function renderCards(snapshot) {
        const cards = $('cards');
        cards.hidden = snapshot.screen !== 'cards' || snapshot.footer != null;
        cards.replaceChildren(...snapshot.cards.map((card) => {
            const el = document.createElement('button');
            el.className = `card${card.danger ? ' danger' : ''}`;
            el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[card.glyph] || ''}</svg>`;
            const text = document.createElement('div');
            const title = document.createElement('p');
            title.className = 'card-title';
            title.textContent = card.title;
            const detail = document.createElement('p');
            detail.className = 'card-detail';
            detail.textContent = card.detail;
            text.append(title, detail);
            el.append(text);
            el.addEventListener('click', () => act(card.id));
            return el;
        }));
    }

    function renderSetup(snapshot) {
        const setup = snapshot.setup;
        $('setup').hidden = snapshot.screen !== 'setup';
        $('setup-stage-1').hidden = setup.stage !== 1;
        $('setup-stage-2').hidden = setup.stage !== 2;
        const status = $('setup-status');
        status.textContent = setup.status;
        status.className = `status ${setup.tone}`;
        $('bot-name').textContent = setup.botName;
        for (const el of $('token-form').elements) el.disabled = setup.busy;
    }

    function renderFooter(snapshot) {
        const footer = snapshot.footer;
        const box = $('footer');
        box.hidden = !footer;
        if (!footer) return;
        box.className = `footer ${footer.tone}`;
        // Le titre porte déjà le message quand c'est lui qui l'annonce.
        $('footer-message').textContent = footer.message;
        $('footer-message').hidden = footer.message === snapshot.headline;
        const details = $('footer-details');
        details.hidden = !footer.details;
        details.textContent = footer.details || '';
        const logTail = $('footer-log');
        logTail.hidden = !footer.log;
        logTail.textContent = footer.log || '';
        logTail.scrollTop = logTail.scrollHeight;
        $('footer-actions').replaceChildren(...footer.actions.map(button));
        const first = box.querySelector('.button.primary, .button.danger');
        if (first) first.focus();
    }

    function render(snapshot) {
        $('headline').textContent = snapshot.headline;
        document.title = `${snapshot.headline} — Interactive Music Player`;
        renderSteps(snapshot);
        renderCards(snapshot);
        renderSetup(snapshot);
        renderFooter(snapshot);
        $('root').textContent = snapshot.root ? `Bot : ${snapshot.root}` : '';
        $('root').title = snapshot.root;
        $('change-root').hidden = !snapshot.idle || snapshot.screen === 'setup';
        $('default-root').hidden = !snapshot.idle || !snapshot.chosenRoot;
    }

    // Boutons fixes de la page : leur action est écrite dans le balisage.
    document.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (target) act(target.dataset.action);
    });

    // Le jeton est vérifié dès qu'il est collé : il n'y a rien à confirmer.
    const tokenInput = $('token');
    const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/;
    let lastSubmitted = '';
    function submitToken(force) {
        const token = tokenInput.value.trim();
        if (!token || (!force && (!TOKEN_SHAPE.test(token) || token === lastSubmitted))) return;
        lastSubmitted = token;
        act('submit-token', token);
    }
    tokenInput.addEventListener('input', () => submitToken(false));
    $('token-form').addEventListener('submit', (event) => {
        event.preventDefault();
        submitToken(true);
    });

    listen('launcher://state', (event) => render(event.payload));
    invoke('snapshot').then(render);
})();
