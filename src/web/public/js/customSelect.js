/**
 * Custom Dropdown Select Component
 */

window.MusicPlayer = window.MusicPlayer || {};

class CustomSelect {
    constructor(nativeSelect) {
        this.nativeSelect = nativeSelect;
        this.container = null;
        this.trigger = null;
        this.optionsContainer = null;
        this.nativeSelect._customSelect = this;
        this._init();
    }

    _init() {
        // Hide native select
        this.nativeSelect.style.display = 'none';

        // Create custom select structure
        this.container = document.createElement('div');
        this.container.className = 'custom-select-container';
        if (this.nativeSelect.classList.contains('header-select')) {
            this.container.classList.add('header-select-container');
        }
        if (this.nativeSelect.classList.contains('speed-select')) {
            this.container.classList.add('speed-select-container');
        }
        if (this.nativeSelect.classList.contains('download-format-select')) {
            this.container.classList.add('download-format-select-container');
        }

        this.trigger = document.createElement('div');
        this.trigger.className = 'custom-select-trigger';
        if (this.nativeSelect.classList.contains('header-select')) {
            this.trigger.classList.add('header-select-trigger');
        }
        if (this.nativeSelect.classList.contains('speed-select')) {
            this.trigger.classList.add('speed-select-trigger');
        }
        this.trigger.textContent = 'Sélectionner...';

        this.optionsContainer = document.createElement('div');
        this.optionsContainer.className = 'custom-select-options';

        this.container.appendChild(this.trigger);
        this.container.appendChild(this.optionsContainer);

        // Insert custom select after the native select
        this.nativeSelect.parentNode.insertBefore(this.container, this.nativeSelect.nextSibling);

        // Toggle dropdown on click
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other custom selects
            document.querySelectorAll('.custom-select-container').forEach(el => {
                if (el !== this.container) {
                    el.classList.remove('open');
                }
            });
            this.container.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            this.container.classList.remove('open');
        });

        // Sync from native select
        this.sync();
    }

    sync(force = false) {
        const children = Array.from(this.nativeSelect.children);
        
        const checkDefault = (guildId, channelId) => {
            if (typeof window.MusicPlayer.checkIsDefaultChannel === 'function') {
                return window.MusicPlayer.checkIsDefaultChannel(guildId, channelId);
            }
            const state = window.MusicPlayer.state || {};
            const targetGuild = (state.guilds || []).find(g => g.id === guildId);
            return targetGuild && targetGuild.defaultVoiceChannelId === channelId;
        };
        
        let signature = '';
        children.forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                signature += `G:${child.label}:${child.style.display}:${child.disabled}|`;
                Array.from(child.children).forEach(option => {
                    let defFlag = '';
                    if (this.nativeSelect.id === 'guild-select' && option.value) {
                        const parts = option.value.split(':');
                        if (parts.length === 2 && parts[1]) {
                            defFlag = `:def:${checkDefault(parts[0], parts[1])}`;
                        }
                    }
                    signature += `O:${option.value}:${option.textContent}:${option.selected}:${option.disabled}${defFlag}:rm:${option.dataset.removable || ''}|`;
                });
            } else if (child.tagName === 'OPTION') {
                let defFlag = '';
                if (this.nativeSelect.id === 'guild-select' && child.value) {
                    const parts = child.value.split(':');
                    if (parts.length === 2 && parts[1]) {
                        defFlag = `:def:${checkDefault(parts[0], parts[1])}`;
                    }
                }
                signature += `O:${child.value}:${child.textContent}:${child.selected}:${child.disabled}${defFlag}:rm:${child.dataset.removable || ''}|`;
            }
        });

        if (!force && this._lastSignature === signature) {
            return;
        }

        // Si le menu déroulant est ouvert et possède déjà une signature, ne pas réinitialiser le DOM pour éviter les clignotements (sauf si force est vrai)
        if (!force && this.container && this.container.classList.contains('open') && this._lastSignature) {
            return;
        }

        this._lastSignature = signature;

        this.optionsContainer.innerHTML = '';
        let selectedText = 'Sélectionner...';
        let selectedIsDefault = false;

        children.forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                if (child.disabled || child.style.display === 'none') return;
                const groupDiv = document.createElement('div');
                groupDiv.className = 'custom-select-group';

                const labelDiv = document.createElement('div');
                labelDiv.className = 'custom-select-group-label';
                labelDiv.textContent = child.label;
                groupDiv.appendChild(labelDiv);

                let hasGroupOptions = false;
                Array.from(child.children).forEach(option => {
                    hasGroupOptions = true;
                    const optDiv = this._createOptionElement(option);
                    if (option.selected) {
                        selectedText = option.textContent;
                        if (this.nativeSelect.id === 'guild-select' && option.value) {
                            const parts = option.value.split(':');
                            if (parts.length === 2 && parts[1]) {
                                const optChannelId = parts[1];
                                if (checkDefault(parts[0], optChannelId)) {
                                    selectedIsDefault = true;
                                }
                            }
                        }
                    }
                    groupDiv.appendChild(optDiv);
                });

                if (hasGroupOptions) {
                    this.optionsContainer.appendChild(groupDiv);
                }
            } else if (child.tagName === 'OPTION') {
                const optDiv = this._createOptionElement(child);
                if (child.selected) {
                    selectedText = child.textContent;
                    if (this.nativeSelect.id === 'guild-select' && child.value) {
                        const parts = child.value.split(':');
                        if (parts.length === 2 && parts[1]) {
                            const optChannelId = parts[1];
                            if (checkDefault(parts[0], optChannelId)) {
                                selectedIsDefault = true;
                            }
                        }
                    }
                }
                this.optionsContainer.appendChild(optDiv);
            }
        });

        this.trigger.innerHTML = '';
        const textSpan = document.createElement('span');
        textSpan.textContent = selectedText;
        this.trigger.appendChild(textSpan);

        if (selectedIsDefault) {
            const star = document.createElement('span');
            star.className = 'trigger-default-star';
            star.innerHTML = `
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; color: var(--c-accent); margin-left: 6px; display: inline-block; vertical-align: middle;">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
            `;
            this.trigger.appendChild(star);
        }
    }

    _createOptionElement(option) {
        const optDiv = document.createElement('div');
        optDiv.className = 'custom-select-option';
        if (option.selected) optDiv.classList.add('selected');
        if (option.disabled) optDiv.classList.add('disabled');
        
        const textSpan = document.createElement('span');
        textSpan.className = 'option-text';
        textSpan.textContent = option.textContent;
        optDiv.appendChild(textSpan);

        const translate = (key) => {
            if (typeof window.MusicPlayer.t === 'function') return window.MusicPlayer.t(key);
            if (typeof t === 'function') return t(key);
            return key;
        };

        const checkDefault = (guildId, channelId) => {
            if (typeof window.MusicPlayer.checkIsDefaultChannel === 'function') {
                return window.MusicPlayer.checkIsDefaultChannel(guildId, channelId);
            }
            const state = window.MusicPlayer.state || {};
            const targetGuild = (state.guilds || []).find(g => g.id === guildId);
            return targetGuild && targetGuild.defaultVoiceChannelId === channelId;
        };

        const notifyToast = (msg) => {
            if (typeof window.MusicPlayer.showToast === 'function') return window.MusicPlayer.showToast(msg);
            if (typeof showToast === 'function') return showToast(msg);
        };

        if (this.nativeSelect.id === 'guild-select' && option.value) {
            const parts = option.value.split(':');
            if (parts.length === 2 && parts[1]) {
                const optChannelId = parts[1];
                const isDefault = checkDefault(parts[0], optChannelId);

                const pinBtn = document.createElement('button');
                pinBtn.className = 'option-pin-btn';
                if (isDefault) pinBtn.classList.add('active');
                pinBtn.dataset.tooltip = isDefault ? translate('tooltip_unpin_channel') : translate('tooltip_pin_channel');
                
                pinBtn.innerHTML = `
                    <svg class="icon-star" viewBox="0 0 24 24" fill="${isDefault ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                `;

                pinBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();

                    const newDefaultId = isDefault ? null : optChannelId;

                    // Mise à jour optimiste locale pour rendu instantané (Un seul salon favori tout serveur confondu)
                    const st = window.MusicPlayer.state || {};
                    if (st.guilds && Array.isArray(st.guilds)) {
                        st.guilds.forEach(g => {
                            if (g.id === parts[0]) {
                                g.defaultVoiceChannelId = newDefaultId;
                            } else if (newDefaultId) {
                                g.defaultVoiceChannelId = null;
                            }
                        });
                    }

                    if (typeof window.MusicPlayer.sendWS === 'function') {
                        window.MusicPlayer.sendWS({
                            type: 'setDefaultChannel',
                            guildId: parts[0],
                            data: {
                                channelId: newDefaultId
                            }
                        });

                        if (newDefaultId) {
                            notifyToast(translate('toast_channel_default_updated'));
                        } else {
                            notifyToast(translate('toast_channel_default_removed'));
                        }
                    }

                    // Réactualiser dynamiquement l'affichage des étoiles (en forçant la mise à jour malgré l'ouverture du menu)
                    this.sync(true);
                });

                optDiv.appendChild(pinBtn);
            }
        }

        // Bouton de retrait, posé par le code qui remplit le <select> — voir
        // `data-removable` dans js/versions.js. Le composant ignore ce que
        // « retirer » veut dire ici : il émet `option-remove` sur le <select>
        // natif et laisse l'appelant décider de la suite (confirmation,
        // requête, message d'erreur).
        if (option.dataset.removable === 'true') {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'option-remove-btn';
            if (option.dataset.removeTooltip) removeBtn.dataset.tooltip = option.dataset.removeTooltip;

            removeBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            `;

            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();

                // La confirmation s'ouvre par-dessus : garder le menu déroulant
                // déployé derrière elle n'apporterait rien.
                this.container.classList.remove('open');

                this.nativeSelect.dispatchEvent(
                    new CustomEvent('option-remove', {
                        detail: { value: option.value, label: option.textContent },
                    })
                );
            });

            optDiv.appendChild(removeBtn);
        }

        optDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            if (option.disabled) return;

            this.optionsContainer.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
            optDiv.classList.add('selected');

            this.nativeSelect.value = option.value;
            this.trigger.innerHTML = '';
            
            const triggerText = document.createElement('span');
            triggerText.textContent = option.textContent;
            this.trigger.appendChild(triggerText);
            
            this.container.classList.remove('open');

            this.nativeSelect.dispatchEvent(new Event('change'));
        });

        return optDiv;
    }
}

window.CustomSelect = CustomSelect;
window.MusicPlayer.CustomSelect = CustomSelect;
