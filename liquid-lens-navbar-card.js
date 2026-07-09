/**
 * Liquid Lens Navbar Card
 * ------------------------
 * A bottom navigation bar for Home Assistant dashboards with an
 * iOS-26-style "liquid glass" lens that follows your finger as you
 * drag across the bar, plus optional per-route status dots and
 * JS-templated icon colors.
 *
 * https://github.com/<your-username>/liquid-lens-navbar-card
 * License: MIT
 */

const CARD_VERSION = '1.3.0';

// eslint-disable-next-line no-console
console.info(
  `%c LIQUID-LENS-NAVBAR-CARD %c v${CARD_VERSION} `,
  'color: white; background: #7c3aed; font-weight: 700;',
  'color: #7c3aed; background: white; font-weight: 700;'
);

class LiquidLensNavbarCard extends HTMLElement {
  setConfig(config) {
    if (!config || !Array.isArray(config.routes) || config.routes.length === 0) {
      throw new Error('liquid-lens-navbar-card: "routes" must be a non-empty array');
    }
    config.routes.forEach((route, i) => {
      if (!route.icon) {
        throw new Error(`liquid-lens-navbar-card: routes[${i}] is missing "icon"`);
      }
    });
    this.config = config;
    this._rendered = false;
    this._render();
  }

  // Populates a sensible default when the card is added via the
  // Lovelace UI card picker, instead of an empty/invalid config.
  static getStubConfig() {
    return {
      type: 'custom:liquid-lens-navbar-card',
      hide_labels: false,
      routes: [
        { icon: 'mdi:home', label: 'Home', tap_action: { action: 'navigate', navigation_path: '/lovelace/0' } },
        { icon: 'mdi:lightbulb-group', label: 'Lights', tap_action: { action: 'navigate', navigation_path: '#lights-popup' } },
        { icon: 'mdi:thermometer', label: 'Climate', tap_action: { action: 'navigate', navigation_path: '#climate-popup' } },
        { icon: 'mdi:cog', label: 'Settings', tap_action: { action: 'navigate', navigation_path: '/config/dashboard' } },
      ],
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._updateIconColors();
    this._updateEditMode();
  }

  getCardSize() {
    return 1;
  }

  // Home Assistant's edit-mode wrapper (hui-card) exposes an `editMode`
  // property. This card is `position: fixed` for the live dashboard, which
  // leaves nothing visible inside the card's own box in the dashboard editor
  // (the real content floats elsewhere on screen) - so in edit mode it's
  // rendered in normal document flow instead, giving the editor real,
  // visible content to display and select.
  connectedCallback() {
    this._updateEditMode();
  }

  _updateEditMode() {
    if (!this._rendered) return;
    const huiCard = this.closest('hui-card');
    const editMode = !!(huiCard && huiCard.editMode) || !!this.closest('hui-card-edit-mode');
    const wrap = this.querySelector('.lln-wrap');
    if (wrap) wrap.classList.toggle('lln-editmode', editMode);
  }

  // Re-evaluates each route's icon_color template and each dot's color
  // template against the latest hass state, and applies the results.
  _updateIconColors() {
    if (!this._hass || !this._rendered || !this.config) return;
    this.config.routes.forEach((route, i) => {
      if (route.icon_color) {
        const icon = this.querySelector(`.lln-btn[data-index="${i}"] ha-icon`);
        if (icon) {
          const color = this._evalIconColor(route.icon_color);
          icon.style.color = color || '';
        }
      }
      if (Array.isArray(route.dots)) {
        route.dots.forEach((dot, j) => {
          const dotEl = this.querySelector(`.lln-btn[data-index="${i}"] .lln-dot[data-dot="${j}"]`);
          if (!dotEl || !dot || !dot.color) return;
          const color = this._evalIconColor(dot.color);
          if (color) {
            dotEl.style.background = color;
            dotEl.style.boxShadow = `0 0 4px ${color}`;
          } else {
            dotEl.style.background = 'rgba(128, 128, 128, 0.35)';
            dotEl.style.boxShadow = 'none';
          }
        });
      }
    });
  }

  // Supports two forms for icon_color / dot color:
  //   - a plain CSS color string, e.g. "#FFD700"
  //   - a JS template wrapped in [[[ ... ]]], evaluated with `states`
  //     (an object keyed by entity_id, mirroring hass.states) and
  //     `hass` in scope. Must `return` a color string or null/undefined.
  //     Example: "[[[ return states['light.x'].state === 'on' ? '#FFD700' : null; ]]]"
  _evalIconColor(template) {
    const match = /^\s*\[\[\[([\s\S]*)\]\]\]\s*$/.exec(template);
    if (!match) return template;
    try {
      const states = this._hass.states;
      // eslint-disable-next-line no-new-func
      const fn = new Function('states', 'hass', match[1]);
      return fn(states, this._hass);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('liquid-lens-navbar-card: icon_color template error', err);
      return null;
    }
  }

  _render() {
    if (this._rendered) return;
    this._rendered = true;

    const routes = this.config.routes;

    // Sizing knobs - all optional, all in px, and all default to the
    // card's original fixed values so existing configs render exactly
    // as before unless these are set explicitly.
    //   icon_size   - size of the ha-icon inside each button (default 24)
    //   item_gap    - gap between buttons in the bar (default 4)
    //   button_size - width/height of each tap target (default 54)
    //   lens_width  - width of the tracking lens; defaults to
    //                 button_size + item_gap * 2 so it keeps covering
    //                 one button's worth of space as those two change
    // Raising item_gap and/or button_size is the fix for icons sitting
    // too close together / being hard to hit accurately on narrow
    // screens or with many routes.
    const iconSize = this.config.icon_size ?? 24;
    const itemGap = this.config.item_gap ?? 4;
    const buttonSize = this.config.button_size ?? 54;
    const lensWidth = this.config.lens_width ?? buttonSize + itemGap * 2;

    this.innerHTML = `
      <style>
        liquid-lens-navbar-card {
          display: block;
          min-height: 66px;
        }
        .lln-wrap {
          position: fixed;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 8;
        }
        .lln-wrap.lln-editmode {
          position: static;
          left: auto;
          bottom: auto;
          transform: none;
          display: flex;
          justify-content: center;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 16px;
        }
        .lln-bar {
          position: relative;
          display: flex;
          gap: ${itemGap}px;
          padding: 8px 14px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.02);
          backdrop-filter: blur(12px) saturate(180%);
          -webkit-backdrop-filter: blur(12px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.07);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .lln-btn {
          all: unset;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: ${buttonSize}px;
          height: ${buttonSize}px;
          border-radius: 999px;
          color: var(--primary-text-color, rgba(255, 255, 255, 0.85));
          cursor: pointer;
          position: relative;
          z-index: 2;
          transition: background 0.15s ease;
        }
        .lln-btn:active {
          background: rgba(255, 255, 255, 0.08);
        }
        .lln-btn ha-icon {
          --mdc-icon-size: ${iconSize}px;
        }
        .lln-label {
          font-size: 9px;
          margin-top: 2px;
          opacity: 0.8;
          white-space: nowrap;
        }
        .lln-dots {
          display: flex;
          gap: 3px;
          margin-top: 3px;
        }
        .lln-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: rgba(128, 128, 128, 0.35);
          transition: background 0.3s ease, box-shadow 0.3s ease;
        }
        .lln-lens {
          position: absolute;
          top: 0;
          width: ${lensWidth}px;
          height: 100%;
          border-radius: 999px;
          pointer-events: none;
          opacity: 0;
          transform: scale(0.85);
          transition: opacity 0.18s ease, transform 0.18s ease;
          backdrop-filter: blur(2px) saturate(220%) brightness(1.35);
          -webkit-backdrop-filter: blur(2px) saturate(220%) brightness(1.35);
          background: radial-gradient(
            circle at 32% 26%,
            rgba(255, 255, 255, 0.28),
            rgba(255, 255, 255, 0.04) 45%,
            transparent 72%
          );
          box-shadow:
            inset 0 0 14px rgba(255, 255, 255, 0.22),
            inset 0 -8px 12px rgba(0, 0, 0, 0.12),
            inset 3px 0 8px rgba(80, 200, 255, 0.32),
            inset -3px 0 8px rgba(255, 90, 190, 0.3),
            inset 0 3px 6px rgba(255, 255, 255, 0.22),
            0 6px 18px rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.4);
          z-index: 3;
        }
        .lln-lens.active {
          opacity: 1;
          transform: scale(1);
        }
      </style>
      <div class="lln-wrap">
        <div class="lln-bar" id="lln-bar">
          ${routes
            .map(
              (r, i) => `
            <button class="lln-btn" data-index="${i}" aria-label="${r.label || r.icon}">
              <ha-icon icon="${r.icon}"></ha-icon>
              ${r.label && !this.config.hide_labels ? `<span class="lln-label">${r.label}</span>` : ''}
              ${
                Array.isArray(r.dots)
                  ? `<div class="lln-dots">${r.dots.map((_, j) => `<span class="lln-dot" data-dot="${j}"></span>`).join('')}</div>`
                  : ''
              }
            </button>
          `
            )
            .join('')}
          <div class="lln-lens" id="lln-lens"></div>
        </div>
      </div>
    `;

    const bar = this.querySelector('#lln-bar');
    const lens = this.querySelector('#lln-lens');
    let dragging = false;
    let lastHoverIndex = null;
    let btnRects = [];

    // How far above/below the bar the finger may wander and still count
    // as "on" it — lets you drag slightly above the bar and still have
    // the lens track along it, rather than requiring pixel-perfect contact.
    const VERTICAL_TOLERANCE_TOP = 90;
    const VERTICAL_TOLERANCE_BOTTOM = 40;

    const fireHaptic = () => {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'selection' }));
      if (window.navigator && window.navigator.vibrate) window.navigator.vibrate(8);
    };

    const updateHoverIndex = (clientX) => {
      let idx = null;
      for (let i = 0; i < btnRects.length; i++) {
        const r = btnRects[i];
        if (clientX >= r.left && clientX <= r.right) {
          idx = i;
          break;
        }
      }
      if (idx !== lastHoverIndex) {
        lastHoverIndex = idx;
        if (idx !== null) {
          fireHaptic();
          this._handleAction(routes[idx]);
        }
      }
    };

    const moveLens = (clientX, clientY) => {
      const rect = bar.getBoundingClientRect();
      const tooFarVertically =
        clientY < rect.top - VERTICAL_TOLERANCE_TOP || clientY > rect.bottom + VERTICAL_TOLERANCE_BOTTOM;

      if (tooFarVertically) {
        lens.classList.remove('active');
        lastHoverIndex = null;
        return;
      }

      const lensSize = lens.offsetWidth;
      const minX = rect.left + lensSize / 2;
      const maxX = rect.right - lensSize / 2;
      const clampedX = Math.min(Math.max(clientX, minX), maxX);

      const x = clampedX - rect.left - lensSize / 2;
      lens.style.left = `${x}px`;
      lens.classList.add('active');

      updateHoverIndex(clampedX);
    };

    const hideLens = () => {
      lens.classList.remove('active');
      lastHoverIndex = null;
    };

    const onDocPointerMove = (e) => {
      if (!dragging) return;
      moveLens(e.clientX, e.clientY);
    };

    // A real pointerup: whatever icon the lens is currently over wins
    // (it was already "activated" live in updateHoverIndex as it passed
    // over each icon, so this just ends the gesture).
    const onDocPointerUp = () => {
      dragging = false;
      hideLens();
      document.removeEventListener('pointermove', onDocPointerMove);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
    };

    // A cancelled gesture (e.g. the OS interrupts the touch) intentionally
    // does NOT trigger whatever icon was last under the lens.
    const onDocPointerCancel = () => {
      dragging = false;
      hideLens();
      document.removeEventListener('pointermove', onDocPointerMove);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
    };

    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      btnRects = Array.from(bar.querySelectorAll('.lln-btn')).map((b) => b.getBoundingClientRect());
      moveLens(e.clientX, e.clientY);
      // Listen on `document` rather than `bar` so the lens keeps tracking
      // even if the pointer briefly leaves the bar's own bounding box.
      document.addEventListener('pointermove', onDocPointerMove);
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerCancel);
    });

    this._updateIconColors();
    this._updateEditMode();
  }

  _handleAction(route) {
    const action = route.tap_action;
    if (!action) return;

    if (action.action === 'navigate') {
      const path = action.navigation_path;
      if (path.startsWith('#')) {
        // Hash-based navigation (e.g. bubble-card pop-ups) — a plain
        // hash change so any hashchange listeners elsewhere pick it up.
        window.location.hash = path;
      } else {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
      }
    } else if (action.action === 'call-service' || action.action === 'perform-action') {
      const [domain, service] = (action.service || action.perform_action).split('.');
      this._hass.callService(domain, service, action.service_data || action.data || {}, action.target || {});
    }

    this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'light' }));
  }
}

customElements.define('liquid-lens-navbar-card', LiquidLensNavbarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'liquid-lens-navbar-card',
  name: 'Liquid Lens Navbar Card',
  description: 'A bottom navbar with an iOS-26-style liquid glass lens that follows your finger, plus per-route status dots and templated icon colors.',
});
