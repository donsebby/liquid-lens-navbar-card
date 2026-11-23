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
 * `value_entity` state text is rendered through `hass.formatEntityState`,
 * so it shows in the dashboard's configured language (e.g. "Ein"/"Aus")
 * instead of the raw English state string, with a safe fallback for
 * older cores that don't expose that helper.
 *
 * v1.5.3: hash-based `navigate` actions (e.g. `#my-popup`) now use
 * `history.pushState` plus a manually dispatched `hashchange` event
 * instead of a native `location.hash` assignment. The native assignment
 * was found to trigger a brief reload/flash of the whole dashboard on
 * the iOS Companion App's WKWebView on every hash-based popup
 * navigation - not reproducible on Android or desktop browsers. Bubble
 * Card and this card's own active-route highlighting are unaffected,
 * since both only listen for the `hashchange` event either way.
 *
 * v1.6.0: optional `modes` - several route sets in one bar (e.g. a
 * "Home" set for everyone and a "Tech" set for admins). Swipe the bar
 * up or down to switch; the new icons morph in, small dots above the
 * bar show which mode is active, and a short toast shows the mode's
 * name. A hidden mode's dot lights up in the first status color of its
 * routes' `dots`, so an alert in the other mode is never invisible.
 * The active mode follows the URL: opening a popup or view that
 * belongs to another mode switches to it. A plain `routes` config
 * keeps working exactly as before (it is simply one mode).
 *
 * https://github.com/donsebby/liquid-lens-navbar-card
 * License: MIT
 */

const CARD_VERSION = '1.6.0';

// eslint-disable-next-line no-console
console.info(
  `%c LIQUID-LENS-NAVBAR-CARD %c v${CARD_VERSION} `,
  'color: white; background: #7c3aed; font-weight: 700;',
  'color: #7c3aed; background: white; font-weight: 700;'
);

class LiquidLensNavbarCard extends HTMLElement {
  // Accepts either a single `routes` array (the classic config) or a
  // `modes` array of `{ name, path?, routes }` objects. Internally both
  // are normalized to a list of modes, so everything below only ever
  // deals with "the routes of the current mode" via this._routes().
  setConfig(config) {
    if (!config) throw new Error('liquid-lens-navbar-card: missing config');
    let modes;
    if (Array.isArray(config.modes) && config.modes.length > 0) {
      modes = config.modes;
    } else if (Array.isArray(config.routes) && config.routes.length > 0) {
      modes = [{ routes: config.routes }];
    } else {
      throw new Error('liquid-lens-navbar-card: "routes" (or "modes") must be a non-empty array');
    }
    modes.forEach((mode, mi) => {
      if (!mode || !Array.isArray(mode.routes) || mode.routes.length === 0) {
        throw new Error(`liquid-lens-navbar-card: modes[${mi}].routes must be a non-empty array`);
      }
      mode.routes.forEach((route, ri) => {
        if (!route.icon) {
          const where = config.modes ? `modes[${mi}].routes[${ri}]` : `routes[${ri}]`;
          throw new Error(`liquid-lens-navbar-card: ${where} is missing "icon"`);
        }
      });
    });
    this.config = config;
    this._modes = modes;
    if (this._modeIndex == null || this._modeIndex >= modes.length) {
      this._modeIndex = this._modeForLocation() ?? 0;
    }
    this._rendered = false;
    this._render();
  }

  // Routes of the currently visible mode.
  _routes() {
    return this._modes[this._modeIndex].routes;
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
        { name: 'haptic_enabled', selector: { boolean: {} } },
        {
          name: 'haptic_intensity',
          selector: { number: { min: 0, max: 50, step: 1, mode: 'slider', unit_of_measurement: 'ms' } },
        },
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
          case 'haptic_enabled':
            return 'Haptic feedback';
          case 'haptic_intensity':
            return 'Haptic intensity';
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
          case 'haptic_enabled':
            return 'Vibrate/tap-feedback while dragging over icons and on tap (default: on). Turning this off also stops the Companion App\'s native haptic on iOS, not just the web Vibration API.';
          case 'haptic_intensity':
            return 'Vibration strength in ms (default: 8ms). Only affects navigator.vibrate, which Android/Chrome supports - iOS has no web Vibration API at all, so this slider has no effect there. Use the toggle above to control iOS haptics.';
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
    if (this._rendered) this._attachNavListeners();
    // HA may detach/re-attach the card when switching views; the URL can
    // have changed in between, so re-pick the mode that matches it.
    this._syncModeToLocation();
    this._updateActiveRoute();
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
    this._routes().forEach((route, i) => {
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
    this._updateModeDots();
  }

  // Mode dots: the active mode's dot is a wider pill; a *hidden* mode's
  // dot takes the first truthy `dots[].color` of that mode's routes, so
  // e.g. a red "server down" dot in the Tech mode stays visible while
  // the Home mode is showing.
  _updateModeDots() {
    if (!this._hass || !this._modes || this._modes.length < 2) return;
    this._modes.forEach((mode, mi) => {
      const el = this.querySelector(`.lln-mdot[data-mode="${mi}"]`);
      if (!el) return;
      let alert = null;
      if (mi !== this._modeIndex) {
        for (const route of mode.routes) {
          for (const dot of route.dots || []) {
            const color = dot && dot.color ? this._evalTemplate(dot.color) : null;
            if (color) {
              alert = color;
              break;
            }
          }
          if (alert) break;
        }
      }
      el.style.background = alert || '';
      el.style.boxShadow = alert ? `0 0 4px ${alert}` : '';
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
    this._routes().forEach((route, i) => {
      if (!route.value_entity) return;
      const el = this.querySelector(`.lln-value[data-index="${i}"]`);
      if (!el) return;
      const st = this._hass.states[route.value_entity];
      if (!st) {
        el.textContent = '';
        return;
      }
      el.textContent = this._formatValue(st);
      if (route.value_color) {
        const color = this._evalTemplate(route.value_color);
        el.style.color = color || '';
      } else {
        el.style.color = '';
      }
    });
  }

  // Displays the entity's state the way HA's own UI would (e.g. "Ein"/
  // "Aus" instead of "on"/"off" under a German locale), by delegating to
  // the frontend's own state-formatter, which already knows the user's
  // language, the entity's device class, and any custom translations.
  // Falls back to the raw state + unit on older cores that don't expose
  // this helper on `hass` yet (added HA 2024.9), so this never throws.
  _formatValue(stateObj) {
    if (typeof this._hass.formatEntityState === 'function') {
      try {
        return this._hass.formatEntityState(stateObj);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('liquid-lens-navbar-card: formatEntityState failed, falling back to raw state', err);
      }
    }
    const unit = stateObj.attributes && stateObj.attributes.unit_of_measurement ? stateObj.attributes.unit_of_measurement : '';
    return unit ? `${stateObj.state} ${unit}` : stateObj.state;
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
    // "/view#popup" style targets: don't let the view part alone mark
    // the route active, or every route on that view would light up.
    if (path.includes('#')) return false;
    return window.location.pathname === path || window.location.pathname.startsWith(`${path}/`);
  }

  // Moves the single "active" pill under the route that matches the
  // current location (sliding with a slight overshoot), and colors that
  // route's icon. If no route of the visible mode is active, the pill
  // fades out where it is.
  _updateActiveRoute() {
    if (!this._rendered || !this.config) return;
    let activeBtn = null;
    this._routes().forEach((route, i) => {
      const btn = this.querySelector(`.lln-btn[data-index="${i}"]`);
      if (!btn) return;
      const active = this._isRouteActive(route);
      btn.classList.toggle('lln-btn-active', active);
      if (active && !activeBtn) activeBtn = btn;
    });
    const pill = this.querySelector('.lln-pill');
    if (!pill) return;
    if (!activeBtn) {
      pill.classList.remove('lln-pill-on');
      return;
    }
    const x = activeBtn.offsetLeft;
    if (!pill.classList.contains('lln-pill-on')) {
      // Appearing: jump into place without sliding in from the last spot.
      pill.style.transition = 'none';
      pill.style.transform = `translateX(${x}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
      pill.classList.add('lln-pill-on');
    } else {
      pill.style.transform = `translateX(${x}px)`;
    }
  }

  // ---- modes ----------------------------------------------------------

  _reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Which mode the current URL belongs to: a mode's own `path` (view)
  // wins, otherwise the first mode containing a route that is active.
  // null = the URL doesn't say, keep whatever mode is showing.
  _modeForLocation() {
    if (!this._modes || this._modes.length < 2) return null;
    const pathname = window.location.pathname;
    const byPath = this._modes.findIndex(
      (m) => m.path && (pathname === m.path || pathname.startsWith(`${m.path}/`))
    );
    if (byPath >= 0) return byPath;
    const byRoute = this._modes.findIndex((m) => m.routes.some((r) => this._isRouteActive(r)));
    return byRoute >= 0 ? byRoute : null;
  }

  _syncModeToLocation() {
    if (!this._modes || !this._rendered) return;
    const idx = this._modeForLocation();
    if (idx != null && idx !== this._modeIndex) {
      this._switchMode(idx, idx > this._modeIndex ? 'up' : 'down', false);
    }
  }

  // Switches to mode `idx` (wrapping around). The outgoing icons leave
  // in the swipe direction, the incoming ones arrive staggered from the
  // opposite side, and the glass bar morphs its width between the two
  // route counts instead of jumping.
  _switchMode(idx, dir, navigate) {
    const count = this._modes.length;
    if (count < 2) return;
    idx = ((idx % count) + count) % count;
    if (idx === this._modeIndex) return;

    const scrollEl = this.querySelector('#lln-scroll');
    const bar = this.querySelector('#lln-bar');
    const animate = !!(scrollEl && bar) && !this._reducedMotion();
    const oldWidth = scrollEl ? scrollEl.offsetWidth : 0;

    // Outgoing icons: moved (not cloned) into a pointer-transparent ghost
    // row centered over the bar, animated out, then dropped.
    if (animate) {
      const oldButtons = Array.from(bar.querySelectorAll('.lln-btn'));
      if (oldButtons.length) {
        const ghost = document.createElement('div');
        ghost.className = 'lln-ghost';
        oldButtons.forEach((btn) => {
          btn.classList.remove('lln-in-up', 'lln-in-down', 'lln-btn-active');
          btn.classList.add(dir === 'up' ? 'lln-out-up' : 'lln-out-down');
          btn.removeAttribute('data-index');
          btn.querySelectorAll('[data-index]').forEach((el) => el.removeAttribute('data-index'));
          ghost.appendChild(btn);
        });
        bar.appendChild(ghost);
        setTimeout(() => ghost.remove(), 260);
      }
    }

    this._modeIndex = idx;
    this._renderButtons(animate ? dir : null);
    this._updateIconColors();
    this._updateValues();
    this._updateActiveRoute();
    this._flashModeLabel(this._modes[idx].name);

    // FLIP the bar width: pin the old width, then let it spring to the
    // new one. The icon row is offset by half the difference and eased
    // back to 0 on the same curve, so the icons (and the outgoing ghost
    // row) stay centered while the glass grows or shrinks around them.
    if (animate) {
      const newWidth = scrollEl.offsetWidth;
      if (Math.abs(newWidth - oldWidth) > 1) {
        clearTimeout(this._morphTimer);
        scrollEl.classList.remove('lln-morph');
        scrollEl.style.width = `${oldWidth}px`;
        bar.style.transform = `translateX(${(oldWidth - newWidth) / 2}px)`;
        void scrollEl.offsetWidth;
        scrollEl.classList.add('lln-morph');
        scrollEl.style.width = `${newWidth}px`;
        bar.style.transform = '';
        this._morphTimer = setTimeout(() => {
          scrollEl.classList.remove('lln-morph');
          scrollEl.style.width = '';
        }, 420);
      }
    }

    if (this.config.haptic_enabled !== false) {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'medium' }));
      const intensity = this.config.haptic_intensity ?? 8;
      if (window.navigator && window.navigator.vibrate && intensity > 0) window.navigator.vibrate(intensity * 2);
    }

    const mode = this._modes[idx];
    if (navigate && mode.path && window.location.pathname !== mode.path) {
      this._navigate(mode.path);
    }
  }

  // Shows the mode-name toast above the bar. `sticky` keeps it up (used
  // while a swipe is past the switch threshold, as a preview of where
  // releasing will go); otherwise it hides itself after ~1.1s.
  _flashModeLabel(text, sticky) {
    const label = this.querySelector('.lln-modelabel');
    if (!label) return;
    clearTimeout(this._labelTimer);
    if (!text) {
      label.classList.remove('lln-show');
      return;
    }
    label.textContent = text;
    label.classList.add('lln-show');
    if (!sticky) {
      this._labelTimer = setTimeout(() => label.classList.remove('lln-show'), 1100);
    }
  }

  _markActiveModeDot() {
    this.querySelectorAll('.lln-mdot').forEach((dot) => {
      dot.classList.toggle('lln-mdot-on', Number(dot.dataset.mode) === this._modeIndex);
    });
    this._updateModeDots();
  }

  _escape(value) {
    return String(value).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  }

  // (Re)builds the buttons of the visible mode. `dir` ('up'/'down')
  // plays the staggered morph-in animation; the class is removed again
  // once it finished, so no animation stays attached to the buttons.
  _renderButtons(dir) {
    const bar = this.querySelector('#lln-bar');
    if (!bar) return;
    bar.querySelectorAll(':scope > .lln-btn').forEach((btn) => btn.remove());
    const html = this._routes()
      .map(
        (r, i) => `
          <button class="lln-btn${dir ? ` lln-in-${dir}` : ''}" data-index="${i}"
            aria-label="${this._escape(r.label || r.icon)}"${dir ? ` style="animation-delay:${i * 24}ms"` : ''}>
            <ha-icon icon="${this._escape(this._initialIcon(r))}"></ha-icon>
            ${r.label && !this.config.hide_labels ? `<span class="lln-label">${this._escape(r.label)}</span>` : ''}
            ${r.value_entity ? `<span class="lln-value" data-index="${i}"></span>` : ''}
            ${
              Array.isArray(r.dots)
                ? `<div class="lln-dots">${r.dots.map((_, j) => `<span class="lln-dot" data-dot="${j}"></span>`).join('')}</div>`
                : ''
            }
          </button>`
      )
      .join('');
    bar.querySelector('#lln-lens').insertAdjacentHTML('beforebegin', html);
    if (dir) {
      bar.querySelectorAll(':scope > .lln-btn').forEach((btn) => {
        btn.addEventListener(
          'animationend',
          () => {
            btn.classList.remove('lln-in-up', 'lln-in-down');
            btn.style.animationDelay = '';
          },
          { once: true }
        );
      });
    }
    this._markActiveModeDot();
    const scrollEl = this.querySelector('#lln-scroll');
    if (scrollEl) scrollEl.scrollLeft = 0;
  }

  // ---- render ---------------------------------------------------------

  _render() {
    if (this._rendered) return;
    this._rendered = true;

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
    const multiMode = this._modes.length > 1;
    const spring = 'cubic-bezier(0.3, 1.3, 0.5, 1)';

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
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .lln-wrap.lln-editmode {
          position: relative;
          left: auto;
          bottom: auto;
          transform: none;
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
          transition: transform 0.35s ${spring};
        }
        .lln-scroll::-webkit-scrollbar {
          display: none;
        }
        /* Vertical swipe feedback: the bar follows the finger, rubber-band style. */
        .lln-scroll.lln-swiping {
          transform: translateY(var(--lln-pull, 0px));
          transition: none;
        }
        /* Mode switch: width morphs between the two route counts. */
        .lln-scroll.lln-morph {
          transition: transform 0.35s ${spring}, width 0.38s ${spring};
        }
        .lln-scroll.lln-morph .lln-bar {
          transition: transform 0.38s ${spring};
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
          transition: background 0.15s ease, color 0.25s ease;
        }
        .lln-btn:active {
          background: rgba(255, 255, 255, 0.08);
        }
        .lln-btn.lln-btn-active {
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
        /* One shared highlight that slides to the active route. */
        .lln-pill {
          position: absolute;
          top: 8px;
          left: 0;
          width: ${buttonSize}px;
          height: ${buttonSize}px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--primary-color, #7c3aed) 16%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-color, #7c3aed) 22%, transparent);
          opacity: 0;
          scale: 0.6;
          pointer-events: none;
          z-index: 1;
          transition: transform 0.42s ${spring}, opacity 0.2s ease, scale 0.3s ${spring};
        }
        .lln-pill.lln-pill-on {
          opacity: 1;
          scale: 1;
        }
        /* Mode switch: new icons morph in from the swipe direction ... */
        .lln-btn.lln-in-up {
          animation: lln-in-up 0.34s ${spring} both;
        }
        .lln-btn.lln-in-down {
          animation: lln-in-down 0.34s ${spring} both;
        }
        @keyframes lln-in-up {
          from { opacity: 0; transform: translateY(70%) scale(0.6); filter: blur(4px); }
          to { opacity: 1; transform: none; filter: none; }
        }
        @keyframes lln-in-down {
          from { opacity: 0; transform: translateY(-70%) scale(0.6); filter: blur(4px); }
          to { opacity: 1; transform: none; filter: none; }
        }
        /* ... while the old ones leave the other way (no blur: cheaper). */
        .lln-ghost {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: ${itemGap}px;
          padding: 8px 14px;
          width: max-content;
          pointer-events: none;
        }
        .lln-btn.lln-out-up {
          animation: lln-out-up 0.22s ease-in both;
        }
        .lln-btn.lln-out-down {
          animation: lln-out-down 0.22s ease-in both;
        }
        @keyframes lln-out-up {
          to { opacity: 0; transform: translateY(-60%) scale(0.7); }
        }
        @keyframes lln-out-down {
          to { opacity: 0; transform: translateY(60%) scale(0.7); }
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
        /* The lens is positioned with transform (no layout per frame);
           its pop-in uses the separate "scale" property so the two don't
           fight. Position/squash are driven from JS every frame. */
        .lln-lens {
          position: absolute;
          top: 0;
          left: 0;
          width: ${lensWidth}px;
          height: 100%;
          border-radius: 999px;
          pointer-events: none;
          opacity: 0;
          scale: 0.85;
          transition: opacity 0.18s ease, scale 0.22s ${spring};
          will-change: transform;
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
          scale: 1;
        }
        /* On release the lens glides onto the chosen icon, then fades. */
        .lln-lens.lln-settle {
          transition: transform 0.26s ${spring}, opacity 0.22s ease 0.12s, scale 0.26s ease;
        }
        .lln-modes {
          display: flex;
          gap: 5px;
          margin-bottom: 6px;
          padding: 3px 7px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .lln-mdot {
          width: 5px;
          height: 5px;
          border-radius: 999px;
          background: rgba(128, 128, 128, 0.45);
          transition: width 0.3s ${spring}, background 0.3s ease;
        }
        .lln-mdot.lln-mdot-on {
          width: 14px;
          background: var(--primary-text-color, rgba(255, 255, 255, 0.85)) !important;
          box-shadow: none !important;
        }
        .lln-modelabel {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 50%;
          transform: translate(-50%, 6px) scale(0.92);
          opacity: 0;
          pointer-events: none;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          padding: 4px 12px;
          border-radius: 999px;
          color: var(--primary-text-color, #fff);
          background: rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(14px) saturate(180%);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          white-space: nowrap;
          transition: opacity 0.2s ease, transform 0.3s ${spring};
        }
        .lln-modelabel.lln-show {
          opacity: 1;
          transform: translate(-50%, 0) scale(1);
        }
        @media (prefers-reduced-motion: reduce) {
          .lln-btn.lln-in-up,
          .lln-btn.lln-in-down {
            animation: lln-fade 0.12s ease both;
          }
          @keyframes lln-fade {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .lln-btn.lln-pulsing ha-icon {
            animation: none;
          }
          .lln-pill,
          .lln-lens,
          .lln-lens.lln-settle,
          .lln-modelabel,
          .lln-scroll {
            transition: opacity 0.12s ease;
          }
        }
      </style>
      <div class="lln-wrap">
        ${
          multiMode
            ? `<div class="lln-modelabel"></div>
               <div class="lln-modes" aria-hidden="true">${this._modes
                 .map((_, mi) => `<span class="lln-mdot" data-mode="${mi}"></span>`)
                 .join('')}</div>`
            : ''
        }
        <div class="lln-scroll" id="lln-scroll">
          <div class="lln-bar" id="lln-bar">
            <div class="lln-pill"></div>
            <div class="lln-lens" id="lln-lens"></div>
          </div>
        </div>
      </div>
    `;
    this._renderButtons(null);

    const scrollEl = this.querySelector('#lln-scroll');
    const bar = this.querySelector('#lln-bar');
    const lens = this.querySelector('#lln-lens');
    let dragging = false;
    let lastHoverIndex = null;
    let pointerX = 0;
    let pointerY = 0;
    let startX = 0;
    let startY = 0;
    let downAt = 0;
    let swiping = false;
    let swipeArmed = false;
    let rafId = null;
    // Lens physics: it eases toward the finger (instead of sticking to it
    // 1:1) and squashes a little with speed, like a drop of liquid.
    let lensX = null;
    let btnSpans = [];

    // How close (in px) to the visible edge of the scroll window before
    // auto-scroll kicks in, and the fastest it'll scroll (px/frame) once
    // the pointer is pinned right at the edge.
    const EDGE_ZONE = 36;
    const MAX_SCROLL_SPEED = 14;
    const SNAP_PADDING = 10;
    const VERTICAL_TOLERANCE_TOP = 90;
    const VERTICAL_TOLERANCE_BOTTOM = 40;
    // A plain tap shouldn't flash the lens: it only appears once the
    // finger moved a little or stayed down for a moment.
    const LENS_SHOW_DELAY_MS = 80;
    const LENS_SHOW_MOVE_PX = 4;
    // Mode swipe: how far (px) the finger must travel vertically before
    // the gesture counts as a mode swipe instead of a lens drag, and how
    // far it must travel for the release to actually switch modes.
    const SWIPE_DETECT = 14;
    const SWIPE_SWITCH = 28;
    const HOVER_DWELL_MS = this.config.hover_delay ?? 130;
    const RELEASE_ONLY = !!this.config.release_only;

    let pendingTimer = null;
    let pendingIndex = null;

    const clearPending = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingIndex = null;
    };

    // haptic_enabled / haptic_intensity: plain card config, editable in the
    // visual editor above. IMPORTANT: iOS Safari/WKWebView has no Vibration
    // API at all - what you actually feel on an iPhone comes from the
    // Companion App's native haptic bridge, which listens for the "haptic"
    // CustomEvent below, not from navigator.vibrate(). So the enabled check
    // has to gate that dispatchEvent call too, not just vibrate().
    const fireHaptic = () => {
      const hapticsEnabled = this.config.haptic_enabled !== false;
      if (!hapticsEnabled) return;
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'selection' }));
      const intensity = this.config.haptic_intensity ?? 8;
      if (window.navigator && window.navigator.vibrate && intensity > 0) window.navigator.vibrate(intensity);
    };

    // Button positions relative to the bar. These don't change while
    // the bar scrolls (only the bar's own rect does), so they're read
    // once per drag instead of calling getBoundingClientRect() on every
    // button every frame.
    const measureButtons = () => {
      btnSpans = Array.from(bar.querySelectorAll(':scope > .lln-btn')).map((b) => [
        b.offsetLeft,
        b.offsetLeft + b.offsetWidth,
      ]);
    };

    // Haptic feedback still fires immediately on every icon the lens
    // crosses (cheap, feels responsive) - but the actual navigation
    // (which mounts/unmounts a popup) is debounced: it only fires once
    // the lens has sat on the same icon for HOVER_DWELL_MS without
    // moving to a different one. This is what stops a fast swipe from
    // rapidly loading/unloading every popup in between.
    const updateHoverIndex = (localX) => {
      let idx = null;
      for (let i = 0; i < btnSpans.length; i++) {
        if (localX >= btnSpans[i][0] && localX <= btnSpans[i][1]) {
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
            const fire = () => {
              // A slow start of a mode swipe (mostly vertical, not yet
              // past SWIPE_DETECT) must not open the popup under the
              // finger - wait until the gesture has made up its mind.
              const dy = Math.abs(pointerY - startY);
              if (this._modes.length > 1 && dy > 4 && dy > Math.abs(pointerX - startX)) {
                pendingTimer = setTimeout(fire, 60);
                return;
              }
              pendingTimer = null;
              pendingIndex = null;
              const route = this._routes()[idx];
              if (route) this._handleAction(route);
            };
            pendingTimer = setTimeout(fire, HOVER_DWELL_MS);
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
      const btn = bar.querySelectorAll(':scope > .lln-btn')[index];
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
    // movement, and hover/tap-action detection. Running this every
    // frame (not just on pointermove) is what makes the icons keep
    // scrolling under a finger that's stopped moving but is still pinned
    // at the edge - the bar's geometry shifts under a fixed clientX.
    const frameTick = () => {
      if (!dragging) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const tooFarVertically =
        pointerY < scrollRect.top - VERTICAL_TOLERANCE_TOP || pointerY > scrollRect.bottom + VERTICAL_TOLERANCE_BOTTOM;

      if (swiping || tooFarVertically) {
        lens.classList.remove('active');
        lastHoverIndex = null;
        lensX = null;
      } else {
        applyAutoScroll(scrollRect);

        const barRect = bar.getBoundingClientRect();
        const lensSize = lens.offsetWidth;
        const minX = Math.max(scrollRect.left, barRect.left) + lensSize / 2;
        const maxX = Math.min(scrollRect.right, barRect.right) - lensSize / 2;
        const clampedX = Math.min(Math.max(pointerX, minX), maxX);
        const target = clampedX - barRect.left - lensSize / 2;

        const reduced = this._reducedMotion();
        const prev = lensX;
        lensX = lensX === null || reduced ? target : lensX + (target - lensX) * 0.35;
        const velocity = prev === null ? 0 : lensX - prev;
        const squash = reduced ? 0 : Math.min(Math.abs(velocity) * 0.012, 0.18);
        lens.style.transform = `translate3d(${lensX}px, 0, 0) scale(${1 + squash}, ${1 - squash * 0.6})`;

        const moved = Math.abs(pointerX - startX) > LENS_SHOW_MOVE_PX;
        if (moved || performance.now() - downAt > LENS_SHOW_DELAY_MS) lens.classList.add('active');

        updateHoverIndex(clampedX - barRect.left);
      }

      rafId = requestAnimationFrame(frameTick);
    };

    // On release over an icon the lens glides onto that icon's center
    // (instead of vanishing wherever the finger was) and fades out there.
    const settleLens = (index) => {
      const btn = index === null ? null : bar.querySelectorAll(':scope > .lln-btn')[index];
      if (btn && lens.classList.contains('active') && !this._reducedMotion()) {
        lens.classList.add('lln-settle');
        const x = btn.offsetLeft + btn.offsetWidth / 2 - lens.offsetWidth / 2;
        lens.style.transform = `translate3d(${x}px, 0, 0)`;
        clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(() => lens.classList.remove('lln-settle'), 380);
      }
      lens.classList.remove('active');
      lensX = null;
    };

    const stopDrag = (cancelled) => {
      dragging = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      const releasedIndex = lastHoverIndex;
      lastHoverIndex = null;
      document.removeEventListener('pointermove', onDocPointerMove);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
      scrollEl.classList.remove('lln-swiping');
      scrollEl.style.removeProperty('--lln-pull');

      // A vertical swipe never navigates to a route - it switches the mode
      // (swipe up = next mode, swipe down = previous), or does nothing if
      // the finger came back before reaching the switch threshold.
      const wasSwipe = swiping;
      swiping = false;
      swipeArmed = false;
      if (wasSwipe) {
        lens.classList.remove('active');
        lensX = null;
        clearPending();
        const dy = pointerY - startY;
        if (!cancelled && Math.abs(dy) > SWIPE_SWITCH) {
          this._switchMode(this._modeIndex + (dy < 0 ? 1 : -1), dy < 0 ? 'up' : 'down', true);
        } else {
          this._flashModeLabel(null);
        }
        return;
      }

      settleLens(cancelled ? null : releasedIndex);

      // Releasing always navigates right away - in dwell mode this
      // finalizes early instead of waiting out the delay; in
      // release_only mode this is the *only* place navigation ever fires.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      if (pendingIndex !== null && !cancelled) {
        const route = this._routes()[pendingIndex];
        if (route) this._handleAction(route);
      }
      pendingIndex = null;
      snapButtonIntoView(releasedIndex);
      this._updateActiveRoute();
    };

    const onDocPointerMove = (e) => {
      if (!dragging) return;
      pointerX = e.clientX;
      pointerY = e.clientY;
      if (this._modes.length < 2) return;
      const dx = pointerX - startX;
      const dy = pointerY - startY;
      // Mostly-vertical movement past the threshold turns the drag into
      // a mode swipe: the lens hides and pending navigation is dropped.
      if (!swiping && Math.abs(dy) > SWIPE_DETECT && Math.abs(dy) > Math.abs(dx) * 1.3) {
        swiping = true;
        clearPending();
        scrollEl.classList.add('lln-swiping');
      }
      if (!swiping) return;
      // Rubber band: the bar follows the finger with growing resistance.
      scrollEl.style.setProperty('--lln-pull', `${(18 * Math.tanh(dy / 60)).toFixed(2)}px`);
      // Crossing the switch threshold ticks once and previews the
      // target mode's name; backing off hides the preview again.
      const armed = Math.abs(dy) > SWIPE_SWITCH;
      if (armed !== swipeArmed) {
        swipeArmed = armed;
        if (armed) {
          fireHaptic();
          const count = this._modes.length;
          const target = (((this._modeIndex + (dy < 0 ? 1 : -1)) % count) + count) % count;
          this._flashModeLabel(this._modes[target].name, true);
        } else {
          this._flashModeLabel(null);
        }
      }
    };
    const onDocPointerUp = () => stopDrag(false);
    const onDocPointerCancel = () => stopDrag(true);

    scrollEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      swiping = false;
      swipeArmed = false;
      pointerX = startX = e.clientX;
      pointerY = startY = e.clientY;
      downAt = performance.now();
      lensX = null;
      lens.classList.remove('lln-settle');
      measureButtons();
      document.addEventListener('pointermove', onDocPointerMove);
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerCancel);
      rafId = requestAnimationFrame(frameTick);
    });

    this._attachNavListeners();
    this._updateIconColors();
    this._updateValues();
    this._updateEditMode();
    this._updateActiveRoute();
    // Editor dialogs sometimes finish mounting their own wrapper a beat
    // after this card's connectedCallback has already fired, so the very
    // first _updateEditMode() call can miss the ha-dialog ancestor. One
    // cheap delayed re-check covers that race without needing a
    // MutationObserver. The pill is re-placed too, since button offsets
    // are only reliable once the card is actually laid out.
    setTimeout(() => {
      this._updateEditMode();
      this._updateActiveRoute();
    }, 50);
  }

  // Keeps the persistent "active route" highlight - and the active mode -
  // in sync with hash-based popup navigation, plain view navigation, and
  // browser back/forward. Attached while the card is in the DOM only.
  _attachNavListeners() {
    if (this._onNav) return;
    this._onNav = () => {
      this._syncModeToLocation();
      this._updateActiveRoute();
    };
    window.addEventListener('hashchange', this._onNav);
    window.addEventListener('location-changed', this._onNav);
    window.addEventListener('popstate', this._onNav);
  }

  _detachNavListeners() {
    if (!this._onNav) return;
    window.removeEventListener('hashchange', this._onNav);
    window.removeEventListener('location-changed', this._onNav);
    window.removeEventListener('popstate', this._onNav);
    this._onNav = null;
  }

  disconnectedCallback() {
    this._detachNavListeners();
    clearTimeout(this._labelTimer);
    clearTimeout(this._morphTimer);
    clearTimeout(this._settleTimer);
  }

  // Navigates without a native `location.hash` assignment - on the iOS
  // Companion App's WKWebView that was observed to trigger a brief
  // reload/flash of the whole dashboard on every hash-based popup
  // navigation (not reproducible on Android or desktop browsers).
  // pushState changes the URL without that native-navigation signal;
  // hashchange is dispatched manually since pushState doesn't fire it on
  // its own, so Bubble Card and this card's own active-route detection
  // keep working unchanged. Fixed in v1.5.3.
  _navigate(path) {
    if (path.startsWith('#')) {
      const oldURL = window.location.href;
      window.history.pushState(null, '', path);
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
    } else {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
    }
  }

  _handleAction(route) {
    const action = route.tap_action;
    if (!action) return;

    if (action.action === 'navigate') {
      if (action.navigation_path) this._navigate(action.navigation_path);
    } else if (action.action === 'call-service' || action.action === 'perform-action') {
      const [domain, service] = (action.service || action.perform_action).split('.');
      this._hass.callService(domain, service, action.service_data || action.data || {}, action.target || {});
    }

    if (this.config.haptic_enabled !== false) {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'light' }));
    }
  }
}

customElements.define('liquid-lens-navbar-card', LiquidLensNavbarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'liquid-lens-navbar-card',
  name: 'Liquid Lens Navbar Card',
  description: 'A bottom navbar with an iOS-26-style liquid glass lens that follows your finger, plus per-route status dots, a live value readout, JS-templated icon symbols/colors/pulse, a persistent active-route highlight, a scrollable bar with snap-into-view, hover-delayed (or release-only) popup navigation to stay smooth on fast swipes, and multiple route sets (modes) you switch by swiping the bar up or down. Sizing options have a visual editor.',
});
