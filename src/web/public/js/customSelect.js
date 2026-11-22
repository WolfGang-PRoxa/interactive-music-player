/**
 * Custom Dropdown Select Component
 */

window.MusicPlayer = window.MusicPlayer || {};

/**
 * Drapeaux dessinés, pour les options qui portent `data-flag`.
 *
 * ## Pourquoi pas les émojis
 *
 * Un drapeau Unicode est une paire d'indicateurs régionaux — « FR » écrit dans
 * un alphabet à part —, que chaque système est libre de dessiner ou non.
 * Windows ne le fait pas : sa police d'émojis n'embarque aucun drapeau, et le
 * navigateur retombe alors sur les deux lettres. Le menu de langue y affichait
 * donc « FR Français », « GB English », là où le même code montrait de vrais
 * drapeaux sur téléphone.
 *
 * Un dessin ne dépend d'aucune police, et se voit partout de la même façon.
 *
 * ## Ce qui est dessiné, et ce qui ne l'est pas
 *
 * Le nécessaire pour reconnaître, pas pour blasonner : des bandes, une croix.
 * Tous dans la même boîte de 20 × 14, faute de quoi les proportions réelles —
 * du 2:3 français au 1:2 britannique — donneraient une colonne en dents de scie.
 */
const SELECT_FLAGS = {
  fr:
    '<rect width="20" height="14" fill="#fff"/>' +
    '<rect width="6.67" height="14" fill="#002654"/>' +
    '<rect x="13.33" width="6.67" height="14" fill="#ED2939"/>',

  de:
    '<rect width="20" height="14" fill="#DD0000"/>' +
    '<rect width="20" height="4.67" fill="#000"/>' +
    '<rect y="9.33" width="20" height="4.67" fill="#FFCE00"/>',

  // La bande centrale vaut la moitié de la hauteur, les deux autres un quart.
  es: '<rect width="20" height="14" fill="#AA151B"/>' + '<rect y="3.5" width="20" height="7" fill="#F1BF00"/>',

  // Les deux croix superposées : les diagonales d'abord, la droite par-dessus.
  gb:
    '<rect width="20" height="14" fill="#012169"/>' +
    '<path d="M0 0 20 14M20 0 0 14" stroke="#fff" stroke-width="2.8"/>' +
    '<path d="M0 0 20 14M20 0 0 14" stroke="#C8102E" stroke-width="1.6"/>' +
    '<path d="M10 0V14M0 7H20" stroke="#fff" stroke-width="4.6"/>' +
    '<path d="M10 0V14M0 7H20" stroke="#C8102E" stroke-width="2.8"/>',
};

/**
 * Le drapeau d'une option, s'il en déclare un.
 *
 * @param {HTMLOptionElement} option
 * @returns {HTMLElement|null}
 */
function buildFlag(option) {
  const code = option && option.dataset && option.dataset.flag;
  if (!code || !SELECT_FLAGS[code]) return null;

  const span = document.createElement('span');
  span.className = 'option-flag';
  /*
   * Le liseré évite qu'un drapeau clair — le jaune espagnol, l'or allemand —
   * ne se fonde dans le fond du menu.
   *
   * Son `rx` répond à l'arrondi que la feuille de style applique au dessin :
   * la découpe rogne aussi ce trait, et un liseré à angles droits sous une
   * découpe arrondie s'interromprait aux quatre coins. Les deux valeurs
   * doivent donc rester égales — la boîte fait 20 × 14 unités pour 20 × 14
   * pixels, elles se comptent dans la même monnaie.
   */
  span.innerHTML =
    `<svg viewBox="0 0 20 14" role="img" aria-hidden="true">` +
    SELECT_FLAGS[code] +
    '<rect width="20" height="14" rx="3" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>' +
    '</svg>';
  return span;
}

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
      document.querySelectorAll('.custom-select-container').forEach((el) => {
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
      const targetGuild = (state.guilds || []).find((g) => g.id === guildId);
      return targetGuild && targetGuild.defaultVoiceChannelId === channelId;
    };

    let signature = '';
    children.forEach((child) => {
      if (child.tagName === 'OPTGROUP') {
        signature += `G:${child.label}:${child.style.display}:${child.disabled}|`;
        Array.from(child.children).forEach((option) => {
          let defFlag = '';
          if (this.nativeSelect.id === 'guild-select' && option.value) {
            const parts = option.value.split(':');
            if (parts.length === 2 && parts[1]) {
              defFlag = `:def:${checkDefault(parts[0], parts[1])}`;
            }
          }
          signature += `O:${option.value}:${option.textContent}:${option.selected}:${option.disabled}${defFlag}:rm:${option.dataset.removable || ''}:ac:${option.dataset.action || ''}|`;
        });
      } else if (child.tagName === 'OPTION') {
        let defFlag = '';
        if (this.nativeSelect.id === 'guild-select' && child.value) {
          const parts = child.value.split(':');
          if (parts.length === 2 && parts[1]) {
            defFlag = `:def:${checkDefault(parts[0], parts[1])}`;
          }
        }
        signature += `O:${child.value}:${child.textContent}:${child.selected}:${child.disabled}${defFlag}:rm:${child.dataset.removable || ''}:ac:${child.dataset.action || ''}|`;
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
    let selectedFlag = null;

    children.forEach((child) => {
      if (child.tagName === 'OPTGROUP') {
        if (child.disabled || child.style.display === 'none') return;
        const groupDiv = document.createElement('div');
        groupDiv.className = 'custom-select-group';

        const labelDiv = document.createElement('div');
        labelDiv.className = 'custom-select-group-label';
        labelDiv.textContent = child.label;
        groupDiv.appendChild(labelDiv);

        let hasGroupOptions = false;
        Array.from(child.children).forEach((option) => {
          hasGroupOptions = true;
          const optDiv = this._createOptionElement(option);
          if (option.selected) {
            selectedText = option.textContent;
            selectedFlag = option;
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
          // Le choix retenu se montre comme il se montrait dans la
          // liste : sans son drapeau, le déclencheur dirait autre
          // chose que la ligne qu'on vient de cliquer.
          selectedFlag = child;
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

    const triggerFlag = buildFlag(selectedFlag);
    if (triggerFlag) this.trigger.appendChild(triggerFlag);

    const textSpan = document.createElement('span');
    textSpan.textContent = selectedText;
    this.trigger.appendChild(textSpan);

    if (selectedIsDefault) {
      const star = document.createElement('span');
      star.className = 'trigger-default-star';
      star.innerHTML = `
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; color: var(--c-accent); display: block;">
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

    const flag = buildFlag(option);
    if (flag) optDiv.appendChild(flag);

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
      const targetGuild = (state.guilds || []).find((g) => g.id === guildId);
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
            st.guilds.forEach((g) => {
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
                channelId: newDefaultId,
              },
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
          }),
        );
      });

      optDiv.appendChild(removeBtn);
    }

    /*
     * Bouton d'action d'une option, à droite de sa ligne.
     *
     * Même principe que le retrait juste au-dessus, et pour une raison
     * voisine : certaines options portent un réglage qui leur appartient en
     * propre — la destination « vers un dossier » a le sien, les trois
     * autres n'en ont pas. Le poser à côté du menu obligerait à le montrer
     * en permanence, y compris quand l'option qu'il sert n'est pas choisie,
     * et à expliquer par un libellé ce que sa place dirait toute seule.
     *
     * Le composant ignore ce que l'action veut dire : il émet
     * `option-action` sur le <select> natif avec la valeur de l'option, et
     * l'appelant fait le reste. C'est ce qui permet d'en poser une seconde
     * ailleurs sans revenir ici.
     */
    if (option.dataset.action) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'option-action-btn';
      actionBtn.type = 'button';
      if (option.dataset.actionTooltip) actionBtn.dataset.tooltip = option.dataset.actionTooltip;

      const ICONS = {
        folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
      };
      actionBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    ${ICONS[option.dataset.action] || ICONS.folder}
                </svg>
            `;

      actionBtn.addEventListener('click', (e) => {
        // Sans quoi le clic vaudrait aussi choix de l'option : on veut
        // régler la destination, pas forcément la sélectionner.
        e.stopPropagation();
        e.preventDefault();

        // Ce que l'action ouvre se pose par-dessus ; garder le menu
        // déployé derrière n'apporterait rien.
        this.container.classList.remove('open');

        this.nativeSelect.dispatchEvent(
          new CustomEvent('option-action', {
            detail: { value: option.value, action: option.dataset.action },
          }),
        );
      });

      optDiv.appendChild(actionBtn);
    }

    optDiv.addEventListener('click', (e) => {
      e.stopPropagation();
      if (option.disabled) return;

      this.optionsContainer.querySelectorAll('.custom-select-option').forEach((el) => el.classList.remove('selected'));
      optDiv.classList.add('selected');

      this.nativeSelect.value = option.value;
      this.trigger.innerHTML = '';

      // Le drapeau aussi, et pas seulement dans `sync()` : le déclencheur
      // est reconstruit ici au clic, et l'oublier le faisait disparaître
      // dès qu'on changeait de langue — jusqu'au prochain rendu complet.
      const clickedFlag = buildFlag(option);
      if (clickedFlag) this.trigger.appendChild(clickedFlag);

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
