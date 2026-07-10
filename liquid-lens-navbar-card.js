/**
 * Liquid Lens Navbar Card
 * ------------------------
 * A bottom navigation bar for Home Assistant dashboards with an
 * iOS-26-style "liquid glass" lens that follows your finger as you
 * drag across the bar, plus optional per-route status dots, a live
 * value readout per route, and JS-templated icon symbols/colors.
 *
 * The bar is capped to a max width per display (`max_width`, or
 * `calc(100vw - 32px)` by default). If the routes don't fit, the bar
 * becomes horizontally scrollable - drag the lens to the visible edge
 * and the icon row keeps auto-scrolling underneath it, revealing more
 * routes while the lens stays pinned to your finger at the edge.
 * Releasing the drag snaps a partially-clipped edge route fully into
 * view instead of leaving it half-cut-off.
 *
 * The route matching the current `location.hash` (or view path, for
 * plain navigation targets) is highlighted persistently, independent
 * of the drag-hover highlight. An optional `pulse` template per route
 * (same [[[ ... ]]] convention as icon_color) makes the icon pulse,
 * e.g. for a triggered alarm.
 *
 *
 * Popups only load once the lens settles on an icon - navigation is
 * debounced by a short hover delay (`hover_delay`, default 130ms)
 * rather than firing on every icon the lens passes over while
 * dragging. This avoids the jank of rapidly mounting/unmounting a
 * popup for every icon crossed on a fast swipe (noticeable on iOS).
 * Releasing the drag always finalizes navigation immediately,
 * regardless of the delay. Setting `release_only: true` disables
 * hover-triggered navigation entirely - popups then only ever open on
 * release, never mid-drag.
 *
 * Edit-mode detection crosses shadow-DOM boundaries and checks for any
 * enclosing dialog, so the fixed-position bar switches to normal
 * document flow inside the card editor/preview - otherwise the
 * editor dialog's own CSS transform turns it into the containing
 * block for `position: fixed`, and the bar ends up pinned over (and
 * blocking taps on) the dialog's Save button instead of the screen edge.
 *
 * Templates (icon/icon_color/value_color/pulse/dots[].color) are compiled
 * once per unique template string and cached on the instance, rather than
 * re-parsed via `new Function(...)` on every `set hass` call (which fires
 * on every state change anywhere in Home Assistant, not just for entities
 * this card cares about).
 *
 * https://github.com/donsebby/liquid-lens-navbar-card
 * License: MIT
 */

const CARD_VERSION = '1.5.1';

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

  // Built-in HA form editor for the card-level sizing options. `routes`
  // stays YAML-only - each route can carry a tap_action object, JS
  // templates for icon/icon_color/value_color/pulse, a value_entity, and
  // a dots array, which doesn't map cleanly onto ha-form's selector
  // types. This form covers the options that fix "icons too close
  // together" (the most reported pain point) plus the bar's max width,
  // so most users never need to leave the visual editor to get those fixed.
  static getConfigForm() {
    return {
      schema: [
        { name: 'hide_labels', selector: { boolean: {} } },
        { name: 'release_only', selector: { boolean: {} } },
        {
          type: 'grid',
          name: '',
          schema: [
            {
              name: 'icon_size',
              selector: { number: { min: 16, max: 40, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'item_gap',
              selector: { number: { min: 0, max: 24, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'button_size',
              selector: { number: { min: 36, max: 72, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'lens_width',
              selector: { number: { min: 40, max: 120, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'max_width',
              selector: { number: { min: 200, max: 900, step: 10, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'hover_delay',
              selector: { number: { min: 0, max: 400, step: 10, mode: 'slider', unit_of_measurement: 'ms' } },
            },
          ],
        },
      ],
      computeLabel: (schema) => {
        switch (schema.name) {
          case 'hide_labels':
            return 'Hide labels';
          case 'release_only':
            return 'Only navigate on release';
          case 'icon_size':
            return 'Icon size';
          case 'item_gap':
            return 'Gap between icons';
          case 'button_size':
            return 'Tap target size';
          case 'lens_width':
            return 'Lens width';
          case 'max_width':
            return 'Max bar width';
          case 'hover_delay':
            return 'Popup delay';
        }
        return undefined;
      },
      computeHelper: (schema) => {
        switch (schema.name) {
          case 'item_gap':
            return 'Raise this if icons are hard to hit accurately (default: 4px)';
          case 'button_size':
            return 'Width/height of each tap target (default: 54px)';
          case 'lens_width':
            return 'Leave empty to auto-size from tap target + gap. Set explicitly for a more pill-shaped lens.';
          case 'icon_size':
            return 'Default: 24px';
          case 'max_width':
            return 'Leave empty to fill the screen width. If routes overflow this, the bar scrolls horizontally - drag the lens to the edge to keep scrolling.';
          case 'hover_delay':
            return 'How long the lens must sit on an icon before its popup loads (default: 130ms). Higher = smoother fast swipes, lower = snappier. Ignored if "Only navigate on release" is on.';
          case 'release_only':
            return 'Popups never open mid-drag, only when you lift your finger off an icon. Overrides the popup delay above.';
        }
        return undefined;
      },
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._updateIconColors();
    this._updateValues();
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

  // Element.closest() does not cross shadow-DOM boundaries, but Home
  // Assistant's card editor (and its live preview) nests this card several
  // shadow roots deep. Walk up via parentElement and, once we run out,
  // hop to the enclosing shadow root's host - this is the standard trick
  // for a "closest that crosses shadow boundaries".
  _closestAcrossShadow(selector) {
    let node = this;
    while (node) {
      if (node instanceof Element && node.matches && node.matches(selector)) return node;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  }

  _updateEditMode() {
    if (!this._rendered) return;
    const huiCard = this._closestAcrossShadow('hui-card');
    // Any of these ancestors means we're inside the card picker/editor
    // (including its live preview), not the real live dashboard - most
    // importantly `ha-dialog`, since the editor dialog applies a CSS
    // transform for its open/close animation, which turns it into the
    // containing block for `position: fixed` descendants. Without this
    // check the bar renders pinned to the *dialog's* edge instead of the
    // screen's, landing on top of (and swallowing taps on) the dialog's
    // own Save/Cancel buttons.
    const editMode =
      !!(huiCard && huiCard.editMode) ||
      !!this._closestAcrossShadow('hui-card-edit-mode') ||
      !!this._closestAcrossShadow('hui-dialog-edit-card') ||
      !!this._closestAcrossShadow('hui-card-preview') ||
      !!this._closestAcrossShadow('ha-dialog') ||
      !!this._closestAcrossShadow('[preview]');
    const wrap = this.querySelector('.lln-wrap');
    if (wrap) wrap.classList.toggle('lln-editmode', editMode);
  }

  // Re-evaluates each route's icon template/icon_color template, each
  // dot's color template, and the optional pulse template, against the
  // latest hass state, and applies the results. The icon itself (not
  // just its color) can be a JS template too - e.g. picking a weather
  // icon based on a weather entity's condition.
  _updateIconColors() {
    if (!this._hass || !this._rendered || !this.config) return;
    this.config.routes.forEach((route, i) => {
      const btn = this.querySelector(`.lln-btn[data-index="${i}"]`);
      if (route.icon) {
        const iconEl = btn && btn.querySelector('ha-icon');
        if (iconEl) {
          const resolvedIcon = this._evalTemplate(route.icon);
          if (resolvedIcon) iconEl.setAttribute('icon', resolvedIcon);
        }
      }
      if (route.icon_color) {
        const icon = btn && btn.querySelector('ha-icon');
        if (icon) {
          const color = this._evalTemplate(route.icon_color);
          icon.style.color = color || '';
        }
      }
      if (route.pulse && btn) {
        const shouldPulse = this._evalTemplate(route.pulse);
        btn.classList.toggle('lln-pulsing', !!shouldPulse);
      } else if (btn) {
        btn.classList.remove('lln-pulsing');
      }
      if (Array.isArray(route.dots)) {
        route.dots.forEach((dot, j) => {
          const dotEl = this.querySelector(`.lln-btn[data-index="${i}"] .lln-dot[data-dot="${j}"]`);
          if (!dotEl || !dot || !dot.color) return;
          const color = this._evalTemplate(dot.color);
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

  // Renders a small live text readout under an icon, driven by an
  // entity's current state - e.g. showing current solar production
  // wattage next to a Solar icon, the same way a dashboard badge would.
  // Optional `value_color` on the route follows the same plain-string-or-
  // [[[ template ]]] convention as icon_color/dots[].color, so the text
  // itself can be recolored based on the value (e.g. black at 0, a color
  // once it's above a threshold).
  _updateValues() {
    if (!this._hass || !this._rendered || !this.config) return;
    this.config.routes.forEach((route, i) => {
      if (!route.value_entity) return;
      const el = this.querySelector(`.lln-value[data-index="${i}"]`);
      if (!el) return;
      const st = this._hass.states[route.value_entity];
      if (!st) {
        el.textContent = '';
        return;
      }
      const unit = st.attributes && st.attributes.unit_of_measurement ? st.attributes.unit_of_measurement : '';
      el.textContent = unit ? `${st.state} ${unit}` : st.state;
      if (route.value_color) {
        const color = this._evalTemplate(route.value_color);
        el.style.color = color || '';
      } else {
        el.style.color = '';
      }
    });
  }

  // Supports two forms for icon / icon_color / value_color / pulse / dot
  // color:
  //   - a plain string, e.g. "mdi:lightbulb" or "#FFD700"
  //   - a JS template wrapped in [[[ ... ]]], evaluated with `states`
  //     (an object keyed by entity_id, mirroring hass.states) and
  //     `hass` in scope. Must `return` a string (an mdi icon name or a
  //     CSS color, depending on the field), a boolean (for `pulse`), or
  //     null/undefined.
  //     Example: "[[[ return states['light.x'].state === 'on' ? '#FFD700' : null; ]]]"
  //     Example (pulse): "[[[ return states['alarm_control_panel.home'].state === 'triggered'; ]]]"
  //
  // Compiled functions are cached per template source string on the card
  // instance, so a template is only ever passed through `new Function(...)`
  // once no matter how many routes/dots reuse the same expression or how
  // many hass updates come through afterward - `set hass` (and therefore
  // this) fires on every state change anywhere in Home Assistant, so
  // avoiding a recompile on each of those calls is what keeps this cheap
  // as the number of templated routes grows.
  _evalTemplate(template) {
    const match = /^\s*\[\[\[([\s\S]*)\]\]\]\s*$/.exec(template);
    if (!match) return template;
    if (!this._templateFnCache) this._templateFnCache = new Map();
    let fn = this._templateFnCache.get(template);
    if (fn === undefined) {
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function('states', 'hass', match[1]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('liquid-lens-navbar-card: template compile error', err);
        fn = null;
      }
      this._templateFnCache.set(template, fn);
    }
    if (!fn) return null;
    try {
      return fn(this._hass.states, this._hass);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('liquid-lens-navbar-card: template error', err);
      return null;
    }
  }


  // Templated icons can't be resolved until `hass` is available, which
  // may be a beat after the first render. Show a neutral placeholder
  // instead of literally printing the "[[[ ... ]]]" template string as
  // the icon name; _updateIconColors() swaps in the real icon as soon
  // as hass arrives (it's already called at the end of every _render()
  // and on every `set hass`).
  _initialIcon(route) {
    return /^\s*\[\[\[/.test(route.icon || '') ? 'mdi:help-circle-outline' : route.icon;
  }

  // Whether a route's navigate target matches the current location -
  // hash-based popups compare against location.hash, plain view
  // navigation compares against the pathname (also matching sub-paths,
  // so a view path stays "active" while a hash popup is open on top of it).
  _isRouteActive(route) {
    const action = route.tap_action;
    if (!action || action.action !== 'navigate' || !action.navigation_path) return false;
    const path = action.navigation_path;
    if (path.startsWith('#')) return window.location.hash === path;
    return window.location.pathname === path || window.location.pathname.startsWith(`${path}/`);
  }

  _updateActiveRoute() {
    if (!this._rendered || !this.config) return;
    this.config.routes.forEach((route, i) => {
      const btn = this.querySelector(`.lln-btn[data-index="${i}"]`);
      if (btn) btn.classList.toggle('lln-btn-active', this._isRouteActive(route));
    });
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
    //   max_width   - max width of the visible bar "window". If the
    //                 routes overflow this, the window becomes
    //                 horizontally scrollable (default: fills the
    //                 screen minus a small margin, via calc(100vw - 32px))
    // Raising item_gap and/or button_size is the fix for icons sitting
    // too close together / being hard to hit accurately on narrow
    // screens or with many routes.
    const iconSize = this.config.icon_size ?? 24;
    const itemGap = this.config.item_gap ?? 4;
    const buttonSize = this.config.button_size ?? 54;
    const lensWidth = this.config.lens_width ?? buttonSize + itemGap * 2;
    const maxWidthCss = this.config.max_width ? `${this.config.max_width}px` : 'calc(100vw - 32px)';

    this.innerHTML = `
      <style>
        :host {
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
        .lln-scroll {
          position: relative;
          max-width: ${maxWidthCss};
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
          scroll-behavior: auto;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.02);
          backdrop-filter: blur(12px) saturate(180%);
          -webkit-backdrop-filter: blur(12px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.07);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
          scrollbar-width: none;
        }
        .lln-scroll::-webkit-scrollbar {
          display: none;
        }
        .lln-bar {
          position: relative;
          display: flex;
          gap: ${itemGap}px;
          padding: 8px 14px;
          width: max-content;
        }
        .lln-btn {
          all: unset;
          display: flex;
          flex: none;
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
          transition: background 0.15s ease, color 0.15s ease;
        }
        .lln-btn:active {
          background: rgba(255, 255, 255, 0.08);
        }
        .lln-btn.lln-btn-active {
          background: color-mix(in srgb, var(--primary-color, #7c3aed) 16%, transparent);
          color: var(--primary-color, #7c3aed);
        }
        .lln-btn ha-icon {
          --mdc-icon-size: ${iconSize}px;
        }
        .lln-btn.lln-pulsing ha-icon {
          animation: lln-pulse 1s ease-in-out infinite;
        }
        @keyframes lln-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.7; }
        }
        .lln-label {
          font-size: 9px;
          margin-top: 2px;
          opacity: 0.8;
          white-space: nowrap;
        }
        .lln-value {
          margin-top: 1px;
          height: 5px;
          line-height: 5px;
          font-size: 8px;
          opacity: 0.85;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
          pointer-events: none;
          overflow: visible;
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
        <div class="lln-scroll" id="lln-scroll">
          <div class="lln-bar" id="lln-bar">
            ${routes
              .map(
                (r, i) => `
              <button class="lln-btn" data-index="${i}" aria-label="${r.label || r.icon}">
                <ha-icon icon="${this._initialIcon(r)}"></ha-icon>
                ${r.label && !this.config.hide_labels ? `<span class="lln-label">${r.label}</span>` : ''}
                ${r.value_entity ? `<span class="lln-value" data-index="${i}"></span>` : ''}
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
      </div>
    `;

    const scrollEl = this.querySelector('#lln-scroll');
    const bar = this.querySelector('#lln-bar');
    const lens = this.querySelector('#lln-lens');
    let dragging = false;
    let lastHoverIndex = null;
    let pointerX = 0;
    let pointerY = 0;
    let rafId = null;

    // How close (in px) to the visible edge of the scroll window before
    // auto-scroll kicks in, and the fastest it'll scroll (px/frame) once
    // the pointer is pinned right at the edge.
    const EDGE_ZONE = 36;
    const MAX_SCROLL_SPEED = 14;
    const SNAP_PADDING = 10;
    const VERTICAL_TOLERANCE_TOP = 90;
    const VERTICAL_TOLERANCE_BOTTOM = 40;
    const HOVER_DWELL_MS = this.config.hover_delay ?? 130;
    const RELEASE_ONLY = !!this.config.release_only;

    let pendingTimer = null;
    let pendingIndex = null;

    const clearPending = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingIndex = null;
    };

    const fireHaptic = () => {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'selection' }));
      if (window.navigator && window.navigator.vibrate) window.navigator.vibrate(8);
    };

    // Haptic feedback still fires immediately on every icon the lens
    // crosses (cheap, feels responsive) - but the actual navigation
    // (which mounts/unmounts a popup) is debounced: it only fires once
    // the lens has sat on the same icon for HOVER_DWELL_MS without
    // moving to a different one. This is what stops a fast swipe from
    // rapidly loading/unloading every popup in between.
    const updateHoverIndex = (clientX, btnRects) => {
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
        clearPending();
        if (idx !== null) {
          fireHaptic();
          pendingIndex = idx;
          if (!RELEASE_ONLY) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              pendingIndex = null;
              this._handleAction(routes[idx]);
            }, HOVER_DWELL_MS);
          }
        }
      }
    };

    // Nudges scrollEl.scrollLeft toward revealing more routes whenever the
    // pointer sits inside the edge zone, scaled by how deep into that zone
    // it is. No-ops once there's nothing left to reveal in that direction.
    const applyAutoScroll = (scrollRect) => {
      const maxScrollLeft = scrollEl.scrollWidth - scrollEl.clientWidth;
      if (maxScrollLeft <= 0) return;
      if (pointerX < scrollRect.left + EDGE_ZONE && scrollEl.scrollLeft > 0) {
        const depth = Math.min(1, (scrollRect.left + EDGE_ZONE - pointerX) / EDGE_ZONE);
        scrollEl.scrollLeft = Math.max(0, scrollEl.scrollLeft - depth * MAX_SCROLL_SPEED);
      } else if (pointerX > scrollRect.right - EDGE_ZONE && scrollEl.scrollLeft < maxScrollLeft) {
        const depth = Math.min(1, (pointerX - (scrollRect.right - EDGE_ZONE)) / EDGE_ZONE);
        scrollEl.scrollLeft = Math.min(maxScrollLeft, scrollEl.scrollLeft + depth * MAX_SCROLL_SPEED);
      }
    };

    // If the button the lens was last over is partially clipped by the
    // scroll window's edges when the drag ends, smooth-scroll just enough
    // to bring it fully into view instead of leaving it half-cut-off.
    const snapButtonIntoView = (index) => {
      if (index === null) return;
      const btn = bar.querySelectorAll('.lln-btn')[index];
      if (!btn) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      let delta = 0;
      if (btnRect.left < scrollRect.left + SNAP_PADDING) {
        delta = btnRect.left - (scrollRect.left + SNAP_PADDING);
      } else if (btnRect.right > scrollRect.right - SNAP_PADDING) {
        delta = btnRect.right - (scrollRect.right - SNAP_PADDING);
      }
      if (delta !== 0) {
        scrollEl.scrollTo({ left: scrollEl.scrollLeft + delta, behavior: 'smooth' });
      }
    };

    // One rAF loop drives everything while dragging: auto-scroll, lens
    // repositioning, and hover/tap-action detection. Running this every
    // frame (not just on pointermove) is what makes the icons keep
    // scrolling under a finger that's stopped moving but is still pinned
    // at the edge - the bar's geometry shifts under a fixed clientX.
    const frameTick = () => {
      if (!dragging) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const tooFarVertically =
        pointerY < scrollRect.top - VERTICAL_TOLERANCE_TOP || pointerY > scrollRect.bottom + VERTICAL_TOLERANCE_BOTTOM;

      if (tooFarVertically) {
        lens.classList.remove('active');
        lastHoverIndex = null;
      } else {
        applyAutoScroll(scrollRect);

        const barRect = bar.getBoundingClientRect();
        const lensSize = lens.offsetWidth;
        const minX = Math.max(scrollRect.left, barRect.left) + lensSize / 2;
        const maxX = Math.min(scrollRect.right, barRect.right) - lensSize / 2;
        const clampedX = Math.min(Math.max(pointerX, minX), maxX);
        const localX = clampedX - barRect.left - lensSize / 2;
        lens.style.left = `${localX}px`;
        lens.classList.add('active');

        const btnRects = Array.from(bar.querySelectorAll('.lln-btn')).map((b) => b.getBoundingClientRect());
        updateHoverIndex(clampedX, btnRects);
      }

      rafId = requestAnimationFrame(frameTick);
    };

    const stopDrag = () => {
      dragging = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      const releasedIndex = lastHoverIndex;
      lens.classList.remove('active');
      lastHoverIndex = null;
      document.removeEventListener('pointermove', onDocPointerMove);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
      // Releasing always navigates right away - in dwell mode this
      // finalizes early instead of waiting out the delay; in
      // release_only mode this is the *only* place navigation ever fires.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      if (pendingIndex !== null) {
        this._handleAction(routes[pendingIndex]);
        pendingIndex = null;
      }
      snapButtonIntoView(releasedIndex);
      this._updateActiveRoute();
    };

    const onDocPointerMove = (e) => {
      if (!dragging) return;
      pointerX = e.clientX;
      pointerY = e.clientY;
    };
    const onDocPointerUp = () => stopDrag();
    const onDocPointerCancel = () => stopDrag();

    scrollEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      pointerX = e.clientX;
      pointerY = e.clientY;
      document.addEventListener('pointermove', onDocPointerMove);
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerCancel);
      rafId = requestAnimationFrame(frameTick);
    });

    // Keeps the persistent "active route" highlight in sync with
    // hash-based popup navigation, plain view navigation, and
    // browser back/forward.
    window.addEventListener('hashchange', () => this._updateActiveRoute());
    window.addEventListener('location-changed', () => this._updateActiveRoute());
    window.addEventListener('popstate', () => this._updateActiveRoute());

    this._updateIconColors();
    this._updateValues();
    this._updateEditMode();
    this._updateActiveRoute();
    // Editor dialogs sometimes finish mounting their own wrapper a beat
    // after this card's connectedCallback has already fired, so the very
    // first _updateEditMode() call can miss the ha-dialog ancestor. One
    // cheap delayed re-check covers that race without needing a
    // MutationObserver.
    setTimeout(() => this._updateEditMode(), 50);
  }

  _handleAction(route) {
    const action = route.tap_action;
    if (!action) return;

    if (action.action === 'navigate') {
      const path = action.navigation_path;
      if (path.startsWith('#')) {
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
  description: 'A bottom navbar with an iOS-26-style liquid glass lens that follows your finger, plus per-route status dots, a live value readout, JS-templated icon symbols/colors/pulse, a persistent active-route highlight, a scrollable bar with snap-into-view, and hover-delayed (or release-only) popup navigation to stay smooth on fast swipes. Sizing options have a visual editor.',
});
